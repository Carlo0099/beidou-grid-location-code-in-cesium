import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  DEFAULT_ELEVATION_THRESHOLDS,
  type BeidouVoxelCell,
  type BuildingFootprint,
  type CameraViewInfo,
  type ElevationColorThresholds,
  type FlightPathAnalysisResult,
  GridLayerStyle,
  GridLevel,
  MassiveVoxelLodMode,
  MassiveVoxelStats,
  MassiveVoxelStyle,
  PathGridGenerationResponse,
  TelemetrySnapshot,
  Wgs84Point,
} from "./types/beidou";
import {
  BeidouGridCode,
  getGridBounds,
  recommendLevelFromAltitude,
} from "./core/BeidouGridCode";
import {
  analyzeFlightPlanAndDetour,
  buildVoxelCell,
  distance3DMeters,
} from "./core/BeidouGridEngine";
import { voxelizeBuildingsToBeidouAirspace } from "./core/AirspaceVoxelizer";
import { extractBuildingsFrom3DTileset } from "./core/TilesetBuildingExtractor";
import {
  createConflictFlightRouteAt,
  createCorridorFlightRouteAt,
  createProceduralUrbanBuildings,
  DEFAULT_AIRSPACE_CENTER,
  FLIGHT_PRESETS,
  GLOBAL_CAMERA_VIEW,
} from "./core/SampleCityData";
import {
  buildSparseVoxelIndexFromTileset,
  FUTIAN_DEMO_TILESET_URL,
  FUTIAN_LANDMARKS,
  type FutianLandmarkPreset,
  type SparseBeidouVoxelIndex,
  planMassiveVoxelRenderFrame,
} from "./core/MassiveVoxelEngine";
import { CESIUM_ION_TOKEN } from "./api/gisDataConfig";
import {
  createRuntimeBeidouGridApi,
  generatePathGridsPure,
} from "./api/BeidouGridApi";
import {
  CesiumViewport,
  type CesiumSceneHandle,
} from "./components/CesiumViewport";
import {
  ControlPanel,
  type DynamicApiPanelProps,
  type FutianVoxelPanelProps,
  type GlobalGridPanelProps,
  type ObstacleAvoidancePanelProps,
  type WorkbenchTab,
} from "./components/ControlPanel";
import { TopHudBar } from "./components/TopHudBar";
import { GridInspectorCard } from "./components/GridInspectorCard";
import { ApiPlaygroundDrawer } from "./components/ApiPlaygroundDrawer";
import { LayersIcon } from "./components/Icons";

const DEFAULT_TELEMETRY: TelemetrySnapshot = {
  fps: 60,
  cameraHeightMeters: GLOBAL_CAMERA_VIEW.height,
  adaptiveLevel: 1,
  mouseLon: null,
  mouseLat: null,
  mouseHeight: null,
  mouseCode2D: "",
  mouseCode3D: "",
  renderedVoxelCount: 0,
  renderedBuildingCount: 0,
};

export function App() {
  const sceneRef = useRef<CesiumSceneHandle | null>(null);

  const [sceneReady, setSceneReady] = useState(false);
  const [workbenchOpen, setWorkbenchOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>("global-local");
  const [apiModalOpen, setApiModalOpen] = useState(false);
  const [telemetry, setTelemetry] =
    useState<TelemetrySnapshot>(DEFAULT_TELEMETRY);

  // 1.1 Global & Adaptive L1-L10 Beidou Grid state (strictly decoupled from 1.2)
  const [cameraView, setCameraView] = useState<CameraViewInfo>({
    cameraHeightMeters: GLOBAL_CAMERA_VIEW.height,
    cameraLon: GLOBAL_CAMERA_VIEW.lon,
    cameraLat: GLOBAL_CAMERA_VIEW.lat,
    cameraHeadingDeg: 0,
    cameraPitchDeg: -90,
    viewTargetDistanceMeters: GLOBAL_CAMERA_VIEW.height,
    centerLon: GLOBAL_CAMERA_VIEW.lon,
    centerLat: GLOBAL_CAMERA_VIEW.lat,
    adaptiveLevel: 1,
    viewportBounds: {
      minLon: 68,
      maxLon: 148,
      minLat: -5,
      maxLat: 65,
    },
  });
  const [gridLevel, setGridLevel] = useState<GridLevel>(1);
  const [adaptiveLevelEnabled, setAdaptiveLevelEnabled] =
    useState<boolean>(true);
  const [layerStyle, setLayerStyle] = useState<GridLayerStyle>("3d-wireframe");
  const [showGlobalShell, setShowGlobalShell] = useState<boolean>(true);
  const [showLocalGrid, setShowLocalGrid] = useState<boolean>(true);
  const [showGridLabels, setShowGridLabels] = useState<boolean>(true);

  // 1.2 Airspace modeling & building obstacle avoidance
  const [airspaceCenter, setAirspaceCenter] = useState<{
    lon: number;
    lat: number;
  }>({
    lon: DEFAULT_AIRSPACE_CENTER.lon,
    lat: DEFAULT_AIRSPACE_CENTER.lat,
  });
  const [customTilesetUrl, setCustomTilesetUrl] = useState<string>("");
  const [buildings, setBuildings] = useState<BuildingFootprint[]>([]);
  const [isUsingProceduralBuildings, setIsUsingProceduralBuildings] =
    useState<boolean>(false);
  const [isExtractingBuildings, setIsExtractingBuildings] =
    useState<boolean>(false);
  const [buildingGridEnabled, setBuildingGridEnabled] = useState<boolean>(true);
  const [bufferGridEnabled, setBufferGridEnabled] = useState<boolean>(true);
  const [strataGridEnabled, setStrataGridEnabled] = useState<boolean>(true);
  const [buildingLevel, setBuildingLevel] = useState<GridLevel>(7);
  const [verticalStepMeters, setVerticalStepMeters] = useState<number>(15);
  const [horizontalBufferMeters, setHorizontalBufferMeters] =
    useState<number>(15);
  const [verticalBufferMeters, setVerticalBufferMeters] = useState<number>(15);
  const [maxAirspaceHeight, setMaxAirspaceHeight] = useState<number>(360);

  // Flight plan & obstacle avoidance (1.2)
  const [selectedFlightPresetId, setSelectedFlightPresetId] =
    useState<string>("obstacle-cross");
  const [waypoints, setWaypoints] = useState<Required<Wgs84Point>[]>(
    FLIGHT_PRESETS[0].waypoints,
  );
  const [corridorRadiusMeters, setCorridorRadiusMeters] = useState<number>(10);
  const [showDetourRoute, setShowDetourRoute] = useState<boolean>(true);
  const [isPickingWaypoint, setIsPickingWaypoint] = useState<boolean>(false);
  const [pickWaypointHeight, setPickWaypointHeight] = useState<number>(105);
  const [isSimulatingFlight, setIsSimulatingFlight] = useState<boolean>(false);
  const [liveFlightCell, setLiveFlightCell] = useState<BeidouVoxelCell | null>(
    null,
  );

  // 1.3 Dynamic path & API state
  const [apiLevels, setApiLevels] = useState<GridLevel[]>([5, 6, 7]);
  const [apiLayerStyle, setApiLayerStyle] =
    useState<GridLayerStyle>("translucent-volume");
  const [apiPathResult, setApiPathResult] =
    useState<PathGridGenerationResponse | null>(null);

  // 1.4 Futian 3D Tiles & Massive Billion-Scale Voxel Simulation state
  const [futianVoxelIndex, setFutianVoxelIndex] =
    useState<SparseBeidouVoxelIndex | null>(null);
  const [futianStats, setFutianStats] = useState<MassiveVoxelStats | null>(
    null,
  );
  const [isIndexingFutian, setIsIndexingFutian] = useState<boolean>(false);
  const [futianIndexProgress, setFutianIndexProgress] = useState<{
    parsed: number;
    total: number;
  }>({ parsed: 0, total: 15 });
  const [massiveVoxelStyle, setMassiveVoxelStyle] =
    useState<MassiveVoxelStyle>("conformal-white");
  const [massiveLodMode, setMassiveLodMode] = useState<MassiveVoxelLodMode>(
    "auto",
  );
  const [includeGroundCarpet, setIncludeGroundCarpet] =
    useState<boolean>(true);
  const [minElevationFilterMeters, setMinElevationFilterMeters] =
    useState<number>(0);
  const [elevationThresholds, setElevationThresholds] =
    useState<ElevationColorThresholds>(DEFAULT_ELEVATION_THRESHOLDS);
  const [whiteModelOpacity, setWhiteModelOpacity] = useState<number>(1.0);
  const [turbo244Mode, setTurbo244Mode] = useState<boolean>(false);
  const [activeLandmarkId, setActiveLandmarkId] = useState<string>(
    FUTIAN_LANDMARKS[0].id,
  );

  // Inspector selection
  const [inspectedCell, setInspectedCell] = useState<BeidouVoxelCell | null>(
    null,
  );

  // 初始化定位到全球宏观北斗视野 (1.1)
  useEffect(() => {
    if (!sceneReady || !sceneRef.current) return;
    sceneRef.current.flyToGlobal();
  }, [sceneReady]);

  // 1.2 在指定中心生成一个测试街区并更新航线
  const generateUrbanTestSceneAt = useCallback(
    async (lon: number, lat: number, flyToScene = true) => {
      const scene = sceneRef.current;
      if (!scene) return;
      setIsExtractingBuildings(true);
      try {
        await scene.loadTilesetUrl(undefined);
        const generated = createProceduralUrbanBuildings(lon, lat);
        scene.layerManager.renderSampleBuildings("sample-buildings", generated);
        setIsUsingProceduralBuildings(true);
        setBuildings(generated);
        setAirspaceCenter({ lon, lat });
        if (selectedFlightPresetId === "obstacle-cross") {
          setWaypoints(createConflictFlightRouteAt(lon, lat));
        } else if (selectedFlightPresetId === "safe-corridor") {
          setWaypoints(createCorridorFlightRouteAt(lon, lat));
        }
        if (flyToScene) {
          scene.flyToUrbanView(lon, lat, DEFAULT_AIRSPACE_CENTER.height);
        }
      } finally {
        setIsExtractingBuildings(false);
      }
    },
    [selectedFlightPresetId],
  );

  // 在当前视区提取/构建 1.2 建筑实体
  const handleGenerateBuildingsAtCamera = useCallback(() => {
    const roi = sceneRef.current?.getCameraRoi(
      DEFAULT_AIRSPACE_CENTER.roiRadiusDeg,
    );
    const useDefaultCenter = !roi || roi.cameraHeight > 25_000;
    const lon = useDefaultCenter ? DEFAULT_AIRSPACE_CENTER.lon : roi.centerLon;
    const lat = useDefaultCenter ? DEFAULT_AIRSPACE_CENTER.lat : roi.centerLat;
    void generateUrbanTestSceneAt(lon, lat, useDefaultCenter);
  }, [generateUrbanTestSceneAt]);

  // 加载 Cesium 内置 OSM Buildings（需 Ion Token）
  const handleLoadOsmBuildings = useCallback(async () => {
    const scene = sceneRef.current;
    if (!scene) return;
    setIsExtractingBuildings(true);
    try {
      const ok = await scene.loadCesiumOsmBuildings();
      if (!ok) {
        alert(
          "未检测到有效的 VITE_CESIUM_ION_TOKEN，无法加载 Cesium OSM Buildings，请配置 Token 或使用“在当前视区生成”测试建筑群。",
        );
      } else {
        scene.layerManager.clearLayer("sample-buildings");
        setIsUsingProceduralBuildings(false);
      }
    } finally {
      setIsExtractingBuildings(false);
    }
  }, []);

  // 从用户指定的自定义 3D Tileset URL 加载并提取建筑轮廓
  const handleLoadCustomTileset = useCallback(async () => {
    const scene = sceneRef.current;
    const url = customTilesetUrl.trim();
    if (!scene || !url) return;

    setIsExtractingBuildings(true);
    try {
      const ok = await scene.loadTilesetUrl(url);
      if (!ok) {
        alert("3D Tileset 加载失败，请检查 URL 是否可访问且支持跨域。");
        return;
      }
      const roi = scene.getCameraRoi(DEFAULT_AIRSPACE_CENTER.roiRadiusDeg);
      const extracted = await extractBuildingsFrom3DTileset(url, roi, {
        maxTiles: 6,
        maxBuildings: 420,
      });
      if (extracted.length > 0) {
        scene.layerManager.clearLayer("sample-buildings");
        setIsUsingProceduralBuildings(false);
        setBuildings(extracted);
      } else {
        alert("已加载 3D Tileset，但当前相机视区未提取到建筑单体轮廓。");
      }
    } finally {
      setIsExtractingBuildings(false);
    }
  }, [customTilesetUrl]);

  // 在 1.2 中加载项目内置的福田 3D Tiles 建筑白膜并提取轮廓做实时避障规划
  const handleLoadFutianDemoForAvoidance = useCallback(async () => {
    const scene = sceneRef.current;
    if (!scene) return;
    setIsExtractingBuildings(true);
    const fLon = 114.055;
    const fLat = 22.536;
    try {
      await scene.loadTilesetUrl(FUTIAN_DEMO_TILESET_URL, {
        styleMode: "white-model",
        opacity: 0.92,
      });
      scene.flyToUrbanView(fLon, fLat, 1100);
      const extracted = await extractBuildingsFrom3DTileset(
        FUTIAN_DEMO_TILESET_URL,
        {
          minLon: fLon - 0.008,
          maxLon: fLon + 0.008,
          minLat: fLat - 0.007,
          maxLat: fLat + 0.007,
        },
        {
          maxTiles: 8,
          maxBuildings: 850,
        },
      );
      scene.layerManager.clearLayer("sample-buildings");
      setIsUsingProceduralBuildings(false);
      setAirspaceCenter({ lon: fLon, lat: fLat });
      if (extracted.length > 0) {
        setBuildings(extracted);
      }
      if (selectedFlightPresetId === "obstacle-cross") {
        setWaypoints(createConflictFlightRouteAt(fLon, fLat));
      } else if (selectedFlightPresetId === "safe-corridor") {
        setWaypoints(createCorridorFlightRouteAt(fLon, fLat));
      }
    } finally {
      setIsExtractingBuildings(false);
    }
  }, [selectedFlightPresetId]);

  // 1.4 加载福田 3D Tiles 建筑白膜并流式体素化全区 GLB
  const startFutianVoxelSimulation = useCallback(
    async (forceRebuild = false) => {
      const scene = sceneRef.current;
      if (!scene) return;

      await scene.loadTilesetUrl(FUTIAN_DEMO_TILESET_URL, {
        styleMode: "white-model",
        opacity: whiteModelOpacity,
      });

      if (futianVoxelIndex && !forceRebuild) return;
      if (isIndexingFutian) return;

      setIsIndexingFutian(true);
      setFutianIndexProgress({ parsed: 0, total: 15 });
      try {
        const idx = await buildSparseVoxelIndexFromTileset(
          FUTIAN_DEMO_TILESET_URL,
          (parsed, total, partial) => {
            setFutianIndexProgress({ parsed, total });
            setFutianStats(partial);
          },
        );
        setFutianVoxelIndex(idx);
        setFutianStats((prev) => ({
          tilesTotal: idx.tilesTotal,
          tilesParsed: idx.tilesParsed,
          featureCount: idx.featureCount,
          occupiedColumnsL7: idx.occupiedColumnsL7,
          occupiedVoxelsL7: idx.occupiedVoxelsL7,
          virtualCapacityL7: idx.virtualCapacityL7,
          virtualCapacityL8: idx.virtualCapacityL8,
          virtualCapacityL10: idx.virtualCapacityL10,
          renderedVoxels: prev?.renderedVoxels ?? 0,
          activeLevel: prev?.activeLevel ?? 7,
          activeResolutionMeters: prev?.activeResolutionMeters ?? 7.73,
          activeLevelLabel: prev?.activeLevelLabel ?? "L7 · 7.73m",
          parseTimeMs: idx.parseTimeMs,
        }));
      } catch (err) {
        console.warn("Futian GLB voxel indexing error:", err);
      } finally {
        setIsIndexingFutian(false);
      }
    },
    [futianVoxelIndex, isIndexingFutian, whiteModelOpacity],
  );

  // 切换工作台标签时彻底隔离各模块图层与 3D Tiles 状态
  const handleChangeTab = useCallback(
    (nextTab: WorkbenchTab) => {
      setActiveTab(nextTab);
      setIsPickingWaypoint(false);

      if (nextTab !== "airspace-obstacle") {
        setIsSimulatingFlight(false);
      }

      if (nextTab === "futian-voxel-sim" && sceneReady) {
        const landmark =
          FUTIAN_LANDMARKS.find((l) => l.id === activeLandmarkId) ??
          FUTIAN_LANDMARKS[0];
        sceneRef.current?.flyToCamera(
          landmark.lon,
          landmark.lat,
          landmark.height,
          landmark.heading,
          landmark.pitch,
        );
        void startFutianVoxelSimulation(false);
        return;
      }

      if (nextTab === "airspace-obstacle" && sceneReady) {
        if (buildings.length === 0) {
          const roi = sceneRef.current?.getCameraRoi(
            DEFAULT_AIRSPACE_CENTER.roiRadiusDeg,
          );
          const useDefaultCenter = !roi || roi.cameraHeight > 25_000;
          const lon = useDefaultCenter
            ? DEFAULT_AIRSPACE_CENTER.lon
            : roi.centerLon;
          const lat = useDefaultCenter
            ? DEFAULT_AIRSPACE_CENTER.lat
            : roi.centerLat;
          void generateUrbanTestSceneAt(lon, lat, true);
        } else if (isUsingProceduralBuildings) {
          sceneRef.current?.layerManager.renderSampleBuildings(
            "sample-buildings",
            buildings,
          );
          sceneRef.current?.flyToUrbanView(
            airspaceCenter.lon,
            airspaceCenter.lat,
            DEFAULT_AIRSPACE_CENTER.height,
          );
        }
      }
    },
    [
      sceneReady,
      activeLandmarkId,
      startFutianVoxelSimulation,
      buildings,
      isUsingProceduralBuildings,
      airspaceCenter,
      generateUrbanTestSceneAt,
    ],
  );

  // 建筑体素化计算（仅在 1.2 激活时有效）
  const voxelResult = useMemo(() => {
    if (activeTab !== "airspace-obstacle" || buildings.length === 0) {
      return {
        obstacleCells: [] as BeidouVoxelCell[],
        bufferCells: [] as BeidouVoxelCell[],
        airspaceStrataCells: [] as BeidouVoxelCell[],
        stats: {
          buildingCount: 0,
          obstacleVoxelCount: 0,
          bufferVoxelCount: 0,
          strataVoxelCount: 0,
        },
      };
    }

    const lons = buildings.flatMap((b) => [b.minLon, b.maxLon]);
    const lats = buildings.flatMap((b) => [b.minLat, b.maxLat]);
    const roi = {
      minLon: Math.min(...lons) - 0.001,
      maxLon: Math.max(...lons) + 0.001,
      minLat: Math.min(...lats) - 0.001,
      maxLat: Math.max(...lats) + 0.001,
    };

    return voxelizeBuildingsToBeidouAirspace(buildings, roi, {
      level: buildingLevel,
      verticalStepMeters,
      horizontalBufferMeters: bufferGridEnabled ? horizontalBufferMeters : 0,
      verticalBufferMeters: bufferGridEnabled ? verticalBufferMeters : 0,
      minAirspaceHeight: 0,
      maxAirspaceHeight,
      includeAirspaceStrata: strataGridEnabled,
      maxVoxels: 9000,
    });
  }, [
    activeTab,
    buildings,
    buildingLevel,
    verticalStepMeters,
    horizontalBufferMeters,
    verticalBufferMeters,
    maxAirspaceHeight,
    bufferGridEnabled,
    strataGridEnabled,
  ]);

  // 飞行计划避障分析（仅 1.2）
  const flightAnalysis = useMemo<FlightPathAnalysisResult | null>(() => {
    if (activeTab !== "airspace-obstacle" || waypoints.length < 2) return null;
    return analyzeFlightPlanAndDetour(
      waypoints,
      voxelResult.obstacleCells,
      voxelResult.bufferCells,
      {
        level: buildingLevel,
        verticalStepMeters,
        corridorRadiusMeters,
        maxAirspaceHeight,
      },
    );
  }, [
    activeTab,
    waypoints,
    voxelResult.obstacleCells,
    voxelResult.bufferCells,
    buildingLevel,
    verticalStepMeters,
    corridorRadiusMeters,
    maxAirspaceHeight,
  ]);

  // 1.1 全球宏观与 1-10 级相机自适应网格渲染（彻底独立于 1.2，rAF 合批 + L1 静态缓存）
  useEffect(() => {
    const mgr = sceneRef.current?.layerManager;
    if (!mgr) return;

    if (activeTab !== "global-local") {
      mgr.clearLayer("global-shell-grid");
      mgr.clearLayer("local-airspace-grid");
      return;
    }

    const deferLabels = Boolean(cameraView.isInteracting);
    const rafId = window.requestAnimationFrame(() => {
      if (gridLevel === 1) {
        mgr.clearLayer("local-airspace-grid");
        if (showGlobalShell) {
          mgr.renderGlobalShellGrid("global-shell-grid", 1, {
            showLabels: showGridLabels,
            layerStyle,
            deferLabels,
          });
        } else {
          mgr.clearLayer("global-shell-grid");
        }
        return;
      }

      // L2 - L10：隐藏 L1 全球壳缓存，按当前相机真实视口范围铺满对应级别北斗网格
      mgr.clearLayer("global-shell-grid");

      if (!showLocalGrid) {
        mgr.clearLayer("local-airspace-grid");
        return;
      }

      mgr.renderViewportGrid("local-airspace-grid", cameraView.viewportBounds, gridLevel, {
        layerStyle,
        showLabels: showGridLabels,
        cameraHeightMeters: cameraView.cameraHeightMeters,
        deferLabels,
        isInteracting: deferLabels,
      });
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [
    sceneReady,
    activeTab,
    gridLevel,
    layerStyle,
    showGlobalShell,
    showLocalGrid,
    showGridLabels,
    cameraView.viewportBounds,
    cameraView.cameraHeightMeters,
    cameraView.isInteracting,
  ]);

  // 1.2 空域分层、建筑体素、避障缓冲与飞行航线渲染
  useEffect(() => {
    const mgr = sceneRef.current?.layerManager;
    if (!mgr) return;

    if (activeTab !== "airspace-obstacle") {
      mgr.clearLayer("sample-buildings");
      mgr.clearLayer("airspace-strata");
      mgr.clearLayer("building-voxels");
      mgr.clearLayer("buffer-voxels");
      mgr.clearLayer("flight-plan-route");
      mgr.clearLayer("flight-plan-voxels");
      mgr.clearLayer("live-flight-cell");
      if (activeTab !== "futian-voxel-sim") {
        void sceneRef.current?.loadTilesetUrl(undefined);
      }
      return;
    }

    if (strataGridEnabled && voxelResult.airspaceStrataCells.length > 0) {
      mgr.renderVoxelCells("airspace-strata", voxelResult.airspaceStrataCells, {
        layerStyle: "3d-wireframe",
        showLabels: false,
      });
    } else {
      mgr.clearLayer("airspace-strata");
    }

    if (buildingGridEnabled && voxelResult.obstacleCells.length > 0) {
      mgr.renderVoxelCells("building-voxels", voxelResult.obstacleCells, {
        layerStyle: "translucent-volume",
        showLabels: showGridLabels,
        maxLabels: 70,
      });
    } else {
      mgr.clearLayer("building-voxels");
    }

    if (bufferGridEnabled && voxelResult.bufferCells.length > 0) {
      mgr.renderVoxelCells("buffer-voxels", voxelResult.bufferCells, {
        layerStyle: "translucent-volume",
        showLabels: false,
      });
    } else {
      mgr.clearLayer("buffer-voxels");
    }

    if (flightAnalysis) {
      const detourPts = showDetourRoute ? flightAnalysis.detourWaypoints : [];
      mgr.renderFlightPath(
        "flight-plan-route",
        flightAnalysis.waypoints,
        detourPts,
        flightAnalysis.isSafe,
      );

      const activeFlightVoxels: BeidouVoxelCell[] = [
        ...flightAnalysis.pathCells,
        ...flightAnalysis.conflictCells,
        ...flightAnalysis.bufferWarningCells,
        ...(showDetourRoute ? flightAnalysis.detourCells : []),
      ];
      mgr.renderVoxelCells("flight-plan-voxels", activeFlightVoxels, {
        layerStyle: "translucent-volume",
        showLabels: false,
      });
    } else {
      mgr.clearLayer("flight-plan-route");
      mgr.clearLayer("flight-plan-voxels");
    }
  }, [
    sceneReady,
    activeTab,
    voxelResult,
    buildingGridEnabled,
    bufferGridEnabled,
    strataGridEnabled,
    showGridLabels,
    flightAnalysis,
    showDetourRoute,
  ]);

  // 1.4 亿级福田 3D Tiles 贴合体素视口分块池与 Worker 异步管线调度
  useEffect(() => {
    const mgr = sceneRef.current?.layerManager;
    if (!mgr) return;

    if (activeTab !== "futian-voxel-sim" || !futianVoxelIndex) {
      mgr.clearLayer("futian-massive-voxels");
      return;
    }

    const rafId = window.requestAnimationFrame(() => {
      const plan = planMassiveVoxelRenderFrame(
        futianVoxelIndex,
        cameraView.viewportBounds,
        cameraView.cameraHeightMeters,
        {
          voxelStyle: massiveVoxelStyle,
          lodMode: massiveLodMode,
          includeGroundCarpet,
          minElevationFilterMeters,
          elevationThresholds,
          cameraPos: {
            lon: cameraView.cameraLon,
            lat: cameraView.cameraLat,
          },
          cameraHeadingDeg: cameraView.cameraHeadingDeg,
          cameraPitchDeg: cameraView.cameraPitchDeg,
          viewTargetDistanceMeters: cameraView.viewTargetDistanceMeters,
        },
      );

      const renderedBuildingCount = mgr.renderMassiveVoxelPlan(
        "futian-massive-voxels",
        plan,
        (tightBuildingCols) => {
          setFutianStats((prev) =>
            prev
              ? {
                  ...prev,
                  renderedVoxels: tightBuildingCols + plan.groundCellCount,
                }
              : prev,
          );
        },
      );

      setFutianStats({
        tilesTotal: futianVoxelIndex.tilesTotal,
        tilesParsed: futianVoxelIndex.tilesParsed,
        featureCount: futianVoxelIndex.featureCount,
        occupiedColumnsL7: futianVoxelIndex.occupiedColumnsL7,
        occupiedVoxelsL7: futianVoxelIndex.occupiedVoxelsL7,
        virtualCapacityL7: futianVoxelIndex.virtualCapacityL7,
        virtualCapacityL8: futianVoxelIndex.virtualCapacityL8,
        virtualCapacityL10: futianVoxelIndex.virtualCapacityL10,
        renderedVoxels: renderedBuildingCount + plan.groundCellCount,
        activeLevel: plan.activeLevel,
        activeResolutionMeters: plan.activeStepMeters,
        activeLevelLabel: plan.activeLevelLabel,
        parseTimeMs: futianVoxelIndex.parseTimeMs,
      });
    });

    return () => window.cancelAnimationFrame(rafId);
  }, [
    sceneReady,
    activeTab,
    futianVoxelIndex,
    cameraView.viewportBounds,
    cameraView.cameraHeightMeters,
    cameraView.cameraLon,
    cameraView.cameraLat,
    cameraView.cameraHeadingDeg,
    cameraView.cameraPitchDeg,
    cameraView.viewTargetDistanceMeters,
    massiveVoxelStyle,
    massiveLodMode,
    includeGroundCarpet,
    minElevationFilterMeters,
    elevationThresholds,
  ]);

  // 注册运行时 window.BeidouGridAPI
  const runtimeApi = useMemo(
    () =>
      createRuntimeBeidouGridApi({
        getLayerManager: () => sceneRef.current?.layerManager ?? null,
        getObstacleCells: () => voxelResult.obstacleCells,
        getBufferCells: () => voxelResult.bufferCells,
        onApiLayerRendered: (_layerId, response) => {
          setApiPathResult(response);
        },
      }),
    [voxelResult.obstacleCells, voxelResult.bufferCells],
  );

  // 实时 UAV 飞行模拟循环
  useEffect(() => {
    if (!isSimulatingFlight || activeTab !== "airspace-obstacle") {
      sceneRef.current?.updateDroneMarker(null);
      sceneRef.current?.layerManager.clearLayer("live-flight-cell");
      setLiveFlightCell(null);
      return;
    }

    const activeRoute =
      showDetourRoute &&
      flightAnalysis &&
      flightAnalysis.detourWaypoints.length >= 2
        ? flightAnalysis.detourWaypoints
        : waypoints;

    if (activeRoute.length < 2) {
      setIsSimulatingFlight(false);
      return;
    }

    const segLengths: number[] = [];
    let totalLen = 0;
    for (let i = 0; i < activeRoute.length - 1; i++) {
      const d = distance3DMeters(activeRoute[i], activeRoute[i + 1]);
      segLengths.push(d);
      totalLen += d;
    }
    if (totalLen <= 0) return;

    let animId = 0;
    const startTs = performance.now();
    const speedMps = 45;
    const durationMs = Math.max(4000, (totalLen / speedMps) * 1000);
    let lastCode = "";

    const tick = (now: number) => {
      const elapsed = (now - startTs) % durationMs;
      let targetDist = (elapsed / durationMs) * totalLen;

      let pos = activeRoute[0];
      for (let i = 0; i < segLengths.length; i++) {
        if (targetDist <= segLengths[i] || i === segLengths.length - 1) {
          const t =
            segLengths[i] > 0 ? Math.min(1, targetDist / segLengths[i]) : 0;
          const a = activeRoute[i];
          const b = activeRoute[i + 1];
          pos = {
            lon: a.lon + (b.lon - a.lon) * t,
            lat: a.lat + (b.lat - a.lat) * t,
            height: a.height + (b.height - a.height) * t,
            timestamp: now,
          };
          break;
        }
        targetDist -= segLengths[i];
      }

      sceneRef.current?.updateDroneMarker(pos);
      const cell = buildVoxelCell(
        pos.lon,
        pos.lat,
        pos.height,
        buildingLevel,
        "flight-detour",
        verticalStepMeters,
      );
      if (cell.code3D !== lastCode) {
        lastCode = cell.code3D;
        setLiveFlightCell(cell);
        sceneRef.current?.layerManager.renderVoxelCells(
          "live-flight-cell",
          [cell],
          {
            layerStyle: "translucent-volume",
            showLabels: true,
          },
        );
      }

      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [
    activeTab,
    isSimulatingFlight,
    waypoints,
    flightAnalysis,
    showDetourRoute,
    buildingLevel,
    verticalStepMeters,
  ]);

  const handleQueryPointOrCode = useCallback(
    (point?: Wgs84Point, code?: string, flyTo = true) => {
      const mgr = sceneRef.current?.layerManager;
      if (!mgr) return;

      const effectiveQueryLevel: GridLevel =
        activeTab === "futian-voxel-sim"
          ? futianStats?.activeLevel ?? 7
          : gridLevel;

      try {
        let cell: BeidouVoxelCell;
        if (code) {
          const b = getGridBounds(code);
          const minH = "minHeight" in b ? b.minHeight : 0;
          const maxH = "maxHeight" in b ? b.maxHeight : 120;
          const code2D = BeidouGridCode.extract2DCode(code);
          const code3D = BeidouGridCode.is3DCode(code)
            ? code.toUpperCase()
            : BeidouGridCode.encode3D(b.centerLat, b.centerLon, minH, b.level);
          cell = {
            id: `query#${code3D}`,
            code2D,
            code3D,
            level: b.level,
            minLon: b.minLon,
            maxLon: b.maxLon,
            minLat: b.minLat,
            maxLat: b.maxLat,
            minHeight: minH,
            maxHeight: maxH,
            centerLon: b.centerLon,
            centerLat: b.centerLat,
            centerHeight: (minH + maxH) / 2,
            category: "query-highlight",
            label: code.toUpperCase(),
          };
        } else if (point) {
          cell = buildVoxelCell(
            point.lon,
            point.lat,
            point.height ?? 0,
            effectiveQueryLevel,
            "query-highlight",
          );
        } else {
          return;
        }

        mgr.renderVoxelCells("query-highlight-layer", [cell], {
          layerStyle: "translucent-volume",
          showLabels: true,
        });
        setInspectedCell(cell);
        if (flyTo) {
          sceneRef.current?.flyToBounds(cell);
        }
      } catch (e) {
        alert(e instanceof Error ? e.message : "无效坐标或北斗编码");
      }
    },
    [activeTab, futianStats?.activeLevel, gridLevel],
  );

  const handleSelectFlightPreset = useCallback(
    (id: string) => {
      setSelectedFlightPresetId(id);
      if (id === "obstacle-cross") {
        setWaypoints(
          createConflictFlightRouteAt(airspaceCenter.lon, airspaceCenter.lat),
        );
      } else if (id === "safe-corridor") {
        setWaypoints(
          createCorridorFlightRouteAt(airspaceCenter.lon, airspaceCenter.lat),
        );
      }
    },
    [airspaceCenter],
  );

  const handleAddWaypoint = useCallback(
    (pt: Required<Wgs84Point>) => {
      setSelectedFlightPresetId("custom");
      setWaypoints((prev) => [
        ...prev,
        {
          lon: pt.lon,
          lat: pt.lat,
          height: pickWaypointHeight,
          timestamp: prev.length,
        },
      ]);
    },
    [pickWaypointHeight],
  );

  const handleRunDynamicPath = useCallback(
    (coords: Wgs84Point[]) => {
      const res = runtimeApi.renderLayer("dynamic-path-api-layer", {
        coordinates: coords,
        levels: apiLevels,
        layerStyle: apiLayerStyle,
        corridorRadiusMeters: 12,
      });
      setApiPathResult(res);
      if (coords.length > 0) {
        const lons = coords.map((c) => c.lon);
        const lats = coords.map((c) => c.lat);
        sceneRef.current?.flyToBounds({
          minLon: Math.min(...lons),
          maxLon: Math.max(...lons),
          minLat: Math.min(...lats),
          maxLat: Math.max(...lats),
          maxHeight: Math.max(...coords.map((c) => c.height ?? 140)),
        });
      }
    },
    [runtimeApi, apiLevels, apiLayerStyle],
  );

  const handleTelemetry = useCallback(
    (snap: TelemetrySnapshot) => {
      setTelemetry({
        ...snap,
        renderedVoxelCount:
          activeTab === "airspace-obstacle"
            ? voxelResult.stats.obstacleVoxelCount +
              voxelResult.stats.bufferVoxelCount +
              voxelResult.stats.strataVoxelCount
            : activeTab === "futian-voxel-sim"
              ? futianStats?.renderedVoxels ?? 0
              : 0,
        renderedBuildingCount:
          activeTab === "airspace-obstacle"
            ? voxelResult.stats.buildingCount
            : activeTab === "futian-voxel-sim"
              ? futianStats?.featureCount ?? 0
              : 0,
      });
    },
    [activeTab, voxelResult.stats, futianStats],
  );

  const handleCameraViewChange = useCallback(
    (view: CameraViewInfo) => {
      setCameraView((prev) => {
        const heightDelta =
          Math.abs(view.cameraHeightMeters - prev.cameraHeightMeters) /
          Math.max(0.05, prev.cameraHeightMeters);

        const prevSpanLon = Math.max(1e-10, prev.viewportBounds.maxLon - prev.viewportBounds.minLon);
        const prevSpanLat = Math.max(1e-10, prev.viewportBounds.maxLat - prev.viewportBounds.minLat);
        const boundsShiftLon =
          Math.max(
            Math.abs(view.viewportBounds.minLon - prev.viewportBounds.minLon),
            Math.abs(view.viewportBounds.maxLon - prev.viewportBounds.maxLon),
          ) / prevSpanLon;
        const boundsShiftLat =
          Math.max(
            Math.abs(view.viewportBounds.minLat - prev.viewportBounds.minLat),
            Math.abs(view.viewportBounds.maxLat - prev.viewportBounds.maxLat),
          ) / prevSpanLat;

        if (
          Boolean(prev.isInteracting) === Boolean(view.isInteracting) &&
          prev.adaptiveLevel === view.adaptiveLevel &&
          heightDelta < 0.08 &&
          boundsShiftLon < 0.11 &&
          boundsShiftLat < 0.11 &&
          Math.abs(prev.cameraHeadingDeg - view.cameraHeadingDeg) < 4 &&
          Math.abs(prev.cameraPitchDeg - view.cameraPitchDeg) < 4
        ) {
          return prev;
        }
        return view;
      });

      if (adaptiveLevelEnabled) {
        setGridLevel((prevLv) =>
          prevLv === view.adaptiveLevel ? prevLv : view.adaptiveLevel,
        );
      }
    },
    [adaptiveLevelEnabled],
  );

  const handleSelectMassiveLodMode = useCallback(
    (mode: MassiveVoxelLodMode) => {
      setMassiveLodMode(mode);
    },
    [],
  );

  const handleToggleWorkbench = useCallback(() => setWorkbenchOpen((o) => !o), []);
  const handleOpenApiModal = useCallback(() => setApiModalOpen(true), []);
  const handleFlyToGlobalStable = useCallback(() => {
    setAdaptiveLevelEnabled(true);
    setGridLevel(1);
    sceneRef.current?.flyToGlobal();
  }, []);
  const handleToggleSimulateFlightStable = useCallback(
    () => setIsSimulatingFlight((s) => !s),
    [],
  );
  const handleClearDynamicPathLayerStable = useCallback(() => {
    runtimeApi.clearLayer("dynamic-path-api-layer");
    setApiPathResult(null);
  }, [runtimeApi]);
  const handleChangeWhiteModelOpacityStable = useCallback((val: number) => {
    setWhiteModelOpacity(val);
    sceneRef.current?.setTilesetOpacity(val, "white-model");
  }, []);
  const handleToggleTurbo244ModeStable = useCallback((enabled: boolean) => {
    setTurbo244Mode(enabled);
    sceneRef.current?.setTurbo244Mode(enabled);
  }, []);
  const handleSelectFutianLandmarkStable = useCallback(
    (lm: FutianLandmarkPreset) => {
      setActiveLandmarkId(lm.id);
      sceneRef.current?.flyToCamera(
        lm.lon,
        lm.lat,
        lm.height,
        lm.heading,
        lm.pitch,
      );
    },
    [],
  );
  const handleRebuildFutianIndexStable = useCallback(() => {
    sceneRef.current?.layerManager.invalidateMassiveChunkCache();
    void startFutianVoxelSimulation(true);
  }, [startFutianVoxelSimulation]);

  const handleToggleAdaptiveLevel = useCallback(
    (enabled: boolean) => {
      setAdaptiveLevelEnabled(enabled);
      if (enabled) {
        setGridLevel(recommendLevelFromAltitude(cameraView.cameraHeightMeters));
      }
    },
    [cameraView.cameraHeightMeters],
  );

  const globalPanelProps = useMemo<GlobalGridPanelProps>(
    () => ({
      cameraView,
      onFlyToGlobal: handleFlyToGlobalStable,
      gridLevel,
      onChangeGridLevel: setGridLevel,
      adaptiveLevelEnabled,
      onToggleAdaptiveLevel: handleToggleAdaptiveLevel,
      layerStyle,
      onChangeLayerStyle: setLayerStyle,
      showGlobalShell,
      onToggleGlobalShell: setShowGlobalShell,
      showLocalGrid,
      onToggleLocalGrid: setShowLocalGrid,
      showGridLabels,
      onToggleGridLabels: setShowGridLabels,
      turbo244Mode,
      onToggleTurbo244Mode: handleToggleTurbo244ModeStable,
      onQueryPointOrCode: handleQueryPointOrCode,
    }),
    [
      cameraView,
      handleFlyToGlobalStable,
      gridLevel,
      adaptiveLevelEnabled,
      handleToggleAdaptiveLevel,
      layerStyle,
      showGlobalShell,
      showLocalGrid,
      showGridLabels,
      turbo244Mode,
      handleToggleTurbo244ModeStable,
      handleQueryPointOrCode,
    ],
  );

  const futianPanelProps = useMemo<FutianVoxelPanelProps>(
    () => ({
      futianStats,
      isIndexingFutian,
      futianIndexProgress,
      massiveVoxelStyle,
      onChangeMassiveVoxelStyle: setMassiveVoxelStyle,
      massiveLodMode,
      onChangeMassiveLodMode: handleSelectMassiveLodMode,
      includeGroundCarpet,
      onToggleGroundCarpet: setIncludeGroundCarpet,
      minElevationFilterMeters,
      onChangeMinElevationFilter: setMinElevationFilterMeters,
      elevationThresholds,
      onChangeElevationThresholds: setElevationThresholds,
      whiteModelOpacity,
      onChangeWhiteModelOpacity: handleChangeWhiteModelOpacityStable,
      turbo244Mode,
      onToggleTurbo244Mode: handleToggleTurbo244ModeStable,
      activeLandmarkId,
      onSelectFutianLandmark: handleSelectFutianLandmarkStable,
      onRebuildFutianIndex: handleRebuildFutianIndexStable,
    }),
    [
      futianStats,
      isIndexingFutian,
      futianIndexProgress,
      massiveVoxelStyle,
      massiveLodMode,
      handleSelectMassiveLodMode,
      includeGroundCarpet,
      minElevationFilterMeters,
      elevationThresholds,
      whiteModelOpacity,
      handleChangeWhiteModelOpacityStable,
      turbo244Mode,
      handleToggleTurbo244ModeStable,
      activeLandmarkId,
      handleSelectFutianLandmarkStable,
      handleRebuildFutianIndexStable,
    ],
  );

  const obstaclePanelProps = useMemo<ObstacleAvoidancePanelProps>(
    () => ({
      hasIonToken: Boolean(CESIUM_ION_TOKEN),
      customTilesetUrl,
      onChangeCustomTilesetUrl: setCustomTilesetUrl,
      onLoadOsmBuildings: handleLoadOsmBuildings,
      onLoadFutianDemoForAvoidance: handleLoadFutianDemoForAvoidance,
      onLoadCustomTileset: handleLoadCustomTileset,
      buildingGridEnabled,
      onToggleBuildingGrid: setBuildingGridEnabled,
      bufferGridEnabled,
      onToggleBufferGrid: setBufferGridEnabled,
      strataGridEnabled,
      onToggleStrataGrid: setStrataGridEnabled,
      buildingLevel,
      onChangeBuildingLevel: setBuildingLevel,
      verticalStepMeters,
      onChangeVerticalStepMeters: setVerticalStepMeters,
      horizontalBufferMeters,
      onChangeHorizontalBufferMeters: setHorizontalBufferMeters,
      verticalBufferMeters,
      onChangeVerticalBufferMeters: setVerticalBufferMeters,
      maxAirspaceHeight,
      onChangeMaxAirspaceHeight: setMaxAirspaceHeight,
      onReextractBuildings: handleGenerateBuildingsAtCamera,
      isExtractingBuildings,
      voxelStats: voxelResult.stats,
      selectedFlightPresetId,
      onSelectFlightPreset: handleSelectFlightPreset,
      waypoints,
      onUpdateWaypoints: setWaypoints,
      corridorRadiusMeters,
      onChangeCorridorRadiusMeters: setCorridorRadiusMeters,
      showDetourRoute,
      onToggleShowDetourRoute: setShowDetourRoute,
      flightAnalysis,
      isPickingWaypoint,
      onTogglePickWaypoint: setIsPickingWaypoint,
      pickWaypointHeight,
      onChangePickWaypointHeight: setPickWaypointHeight,
      isSimulatingFlight,
      onToggleSimulateFlight: handleToggleSimulateFlightStable,
      liveFlightCell,
    }),
    [
      customTilesetUrl,
      handleLoadOsmBuildings,
      handleLoadFutianDemoForAvoidance,
      handleLoadCustomTileset,
      buildingGridEnabled,
      bufferGridEnabled,
      strataGridEnabled,
      buildingLevel,
      verticalStepMeters,
      horizontalBufferMeters,
      verticalBufferMeters,
      maxAirspaceHeight,
      handleGenerateBuildingsAtCamera,
      isExtractingBuildings,
      voxelResult.stats,
      selectedFlightPresetId,
      handleSelectFlightPreset,
      waypoints,
      corridorRadiusMeters,
      showDetourRoute,
      flightAnalysis,
      isPickingWaypoint,
      pickWaypointHeight,
      isSimulatingFlight,
      handleToggleSimulateFlightStable,
      liveFlightCell,
    ],
  );

  const apiPanelProps = useMemo<DynamicApiPanelProps>(
    () => ({
      apiLevels,
      onChangeApiLevels: setApiLevels,
      apiLayerStyle,
      onChangeApiLayerStyle: setApiLayerStyle,
      apiPathResult,
      onRunDynamicPathGeneration: handleRunDynamicPath,
      onClearDynamicPathLayer: handleClearDynamicPathLayerStable,
      onQueryPointOrCode: handleQueryPointOrCode,
      onOpenApiModal: handleOpenApiModal,
    }),
    [
      apiLevels,
      apiLayerStyle,
      apiPathResult,
      handleRunDynamicPath,
      handleClearDynamicPathLayerStable,
      handleQueryPointOrCode,
      handleOpenApiModal,
    ],
  );

  const handleSceneReadyStable = useCallback(
    (handle: CesiumSceneHandle) => {
      sceneRef.current = handle;
      handle.setTurbo244Mode(turbo244Mode);
      setSceneReady(true);
    },
    [turbo244Mode],
  );

  const handlePickVoxelCellStable = useCallback(
    (cell: BeidouVoxelCell, clickedH?: number) => {
      if (clickedH !== undefined && cell.id.startsWith("col#")) {
        const clampedH = Math.max(0, Math.min(cell.maxHeight - 0.01, clickedH));
        const refined = buildVoxelCell(
          cell.centerLon,
          cell.centerLat,
          clampedH,
          cell.level,
          cell.category,
          cell.verticalStepMeters,
        );
        setInspectedCell(refined);
        return;
      }
      setInspectedCell(cell);
    },
    [],
  );

  const handlePickCoordinateStable = useCallback(
    (pt: Required<Wgs84Point>) => {
      handleQueryPointOrCode(pt, undefined, false);
    },
    [handleQueryPointOrCode],
  );

  return (
    <div className="app-root">
      <CesiumViewport
        activeGridLevel={
          activeTab === "futian-voxel-sim"
            ? (futianStats?.activeLevel ?? 7)
            : gridLevel
        }
        isPickingWaypoint={isPickingWaypoint}
        onSceneReady={handleSceneReadyStable}
        onTelemetry={handleTelemetry}
        onCameraViewChange={handleCameraViewChange}
        onPickVoxelCell={handlePickVoxelCellStable}
        onPickCoordinate={handlePickCoordinateStable}
        onAddWaypoint={handleAddWaypoint}
      />

      <TopHudBar
        telemetry={telemetry}
        workbenchOpen={workbenchOpen}
        onToggleWorkbench={handleToggleWorkbench}
        onOpenApiModal={handleOpenApiModal}
      />

      {!workbenchOpen && (
        <button
          type="button"
          className="btn btn-primary workbench-reopen-btn"
          onClick={() => setWorkbenchOpen(true)}
        >
          <LayersIcon size={14} /> 展开北斗工作台
        </button>
      )}

      <ControlPanel
        activeTab={activeTab}
        onChangeTab={handleChangeTab}
        collapsed={!workbenchOpen}
        globalPanel={globalPanelProps}
        futianPanel={futianPanelProps}
        obstaclePanel={obstaclePanelProps}
        apiPanel={apiPanelProps}
      />

      <GridInspectorCard
        cell={inspectedCell}
        onClose={() => {
          setInspectedCell(null);
          sceneRef.current?.layerManager.clearLayer("query-highlight-layer");
        }}
        onSelectNeighborCode={(code) => handleQueryPointOrCode(undefined, code)}
      />

      {activeTab === "airspace-obstacle" && (
        <div className="legend-bar glass-panel">
          <div className="legend-item">
            <span
              className="legend-swatch"
              style={{ background: "rgba(220, 38, 38, 0.72)" }}
            />
            <span>建筑网格化禁飞体元</span>
          </div>
          <div className="legend-item">
            <span
              className="legend-swatch"
              style={{ background: "rgba(245, 158, 11, 0.55)" }}
            />
            <span>避障安全缓冲区</span>
          </div>
          <div className="legend-item">
            <span
              className="legend-swatch"
              style={{ background: "rgba(6, 182, 212, 0.65)" }}
            />
            <span>路径/空域走廊</span>
          </div>
          <div className="legend-item">
            <span
              className="legend-swatch"
              style={{ background: "rgba(16, 185, 129, 0.72)" }}
            />
            <span>A* 避障推荐绕飞</span>
          </div>
        </div>
      )}

      <ApiPlaygroundDrawer
        open={apiModalOpen}
        onClose={() => setApiModalOpen(false)}
        onExecuteLayerCall={(layerId, coords, levels, style) =>
          runtimeApi.renderLayer(layerId, {
            coordinates: coords,
            levels,
            layerStyle: style,
            corridorRadiusMeters: 20,
          })
        }
        onClearApiLayer={(layerId) => runtimeApi.clearLayer(layerId)}
      />

      {/* 初始化生成一次演示路径结果预览 */}
      {apiPathResult === null && sceneReady && (
        <DefaultApiResultSeeder
          onSeed={() =>
            setApiPathResult(
              generatePathGridsPure({
                coordinates: FLIGHT_PRESETS[0].waypoints,
                levels: apiLevels,
                layerStyle: apiLayerStyle,
              }),
            )
          }
        />
      )}
    </div>
  );
}

const DefaultApiResultSeeder: React.FC<{ onSeed: () => void }> = ({
  onSeed,
}) => {
  useEffect(() => {
    onSeed();
  }, [onSeed]);
  return null;
};

export default App;
