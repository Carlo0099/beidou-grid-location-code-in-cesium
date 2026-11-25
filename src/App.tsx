import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  BeidouVoxelCell,
  BuildingFootprint,
  CityPreset,
  FlightPathAnalysisResult,
  GridLayerStyle,
  GridLevel,
  LocalAssetsAvailability,
  PathGridGenerationResponse,
  TelemetrySnapshot,
  Wgs84Point,
} from './types/beidou';
import {
  BeidouGridCode,
  getGridBounds,
} from './core/BeidouGridCode';
import {
  analyzeFlightPlanAndDetour,
  buildVoxelCell,
  distance3DMeters,
  enumerate2DGridsInBounds,
} from './core/BeidouGridEngine';
import { voxelizeBuildingsToBeidouAirspace } from './core/AirspaceVoxelizer';
import { extractBuildingsFrom3DTileset } from './core/TilesetBuildingExtractor';
import {
  CITY_PRESETS,
  createSampleCbdBuildings,
  FLIGHT_PRESETS,
} from './core/SampleCityData';
import { LOCAL_TILESET_SPECS } from './api/gisDataConfig';
import {
  createRuntimeBeidouGridApi,
  generatePathGridsPure,
} from './api/BeidouGridApi';
import {
  CesiumViewport,
  type CesiumSceneHandle,
} from './components/CesiumViewport';
import {
  ControlPanel,
  type WorkbenchTab,
} from './components/ControlPanel';
import { TopHudBar } from './components/TopHudBar';
import { GridInspectorCard } from './components/GridInspectorCard';
import { ApiPlaygroundDrawer } from './components/ApiPlaygroundDrawer';
import { LayersIcon } from './components/Icons';

const DEFAULT_TELEMETRY: TelemetrySnapshot = {
  fps: 60,
  cameraHeightMeters: 1150,
  adaptiveLevel: 6,
  mouseLon: null,
  mouseLat: null,
  mouseHeight: null,
  mouseCode2D: '',
  mouseCode3D: '',
  renderedVoxelCount: 0,
  renderedBuildingCount: 0,
};

export function App() {
  const sceneRef = useRef<CesiumSceneHandle | null>(null);

  const [sceneReady, setSceneReady] = useState(false);
  const [localAssets, setLocalAssets] = useState<LocalAssetsAvailability | null>(null);
  const [workbenchOpen, setWorkbenchOpen] = useState(true);
  const [activeTab, setActiveTab] = useState<WorkbenchTab>('airspace-obstacle');
  const [apiModalOpen, setApiModalOpen] = useState(false);
  const [telemetry, setTelemetry] = useState<TelemetrySnapshot>(DEFAULT_TELEMETRY);

  // 1.1 Global & Local visualization state
  const [activePresetId, setActivePresetId] = useState<string>('shenzhen-futian');
  const [gridLevel, setGridLevel] = useState<GridLevel>(5);
  const [adaptiveLevelEnabled, setAdaptiveLevelEnabled] = useState<boolean>(false);
  const [layerStyle, setLayerStyle] = useState<GridLayerStyle>('3d-wireframe');
  const [showGlobalShell, setShowGlobalShell] = useState<boolean>(false);
  const [showLocalGrid, setShowLocalGrid] = useState<boolean>(true);
  const [showGridLabels, setShowGridLabels] = useState<boolean>(true);

  // 1.2 Airspace modeling & building obstacle avoidance
  const [buildings, setBuildings] = useState<BuildingFootprint[]>([]);
  const [isExtractingBuildings, setIsExtractingBuildings] = useState<boolean>(false);
  const [buildingGridEnabled, setBuildingGridEnabled] = useState<boolean>(true);
  const [bufferGridEnabled, setBufferGridEnabled] = useState<boolean>(true);
  const [strataGridEnabled, setStrataGridEnabled] = useState<boolean>(true);
  const [buildingLevel, setBuildingLevel] = useState<GridLevel>(7);
  const [verticalStepMeters, setVerticalStepMeters] = useState<number>(15);
  const [horizontalBufferMeters, setHorizontalBufferMeters] = useState<number>(15);
  const [verticalBufferMeters, setVerticalBufferMeters] = useState<number>(15);
  const [maxAirspaceHeight, setMaxAirspaceHeight] = useState<number>(360);

  // Flight plan & obstacle avoidance
  const [selectedFlightPresetId, setSelectedFlightPresetId] = useState<string>('futian-cross');
  const [waypoints, setWaypoints] = useState<Required<Wgs84Point>[]>(
    FLIGHT_PRESETS[0].waypoints,
  );
  const [corridorRadiusMeters, setCorridorRadiusMeters] = useState<number>(10);
  const [showDetourRoute, setShowDetourRoute] = useState<boolean>(true);
  const [isPickingWaypoint, setIsPickingWaypoint] = useState<boolean>(false);
  const [pickWaypointHeight, setPickWaypointHeight] = useState<number>(105);
  const [isSimulatingFlight, setIsSimulatingFlight] = useState<boolean>(false);
  const [liveFlightCell, setLiveFlightCell] = useState<BeidouVoxelCell | null>(null);

  // 1.3 Dynamic path & API state
  const [apiLevels, setApiLevels] = useState<GridLevel[]>([5, 6, 7]);
  const [apiLayerStyle, setApiLayerStyle] = useState<GridLayerStyle>('translucent-volume');
  const [apiPathResult, setApiPathResult] = useState<PathGridGenerationResponse | null>(null);

  // Inspector selection
  const [inspectedCell, setInspectedCell] = useState<BeidouVoxelCell | null>(null);

  const activePreset = useMemo(
    () => CITY_PRESETS.find((p) => p.id === activePresetId) ?? CITY_PRESETS[1],
    [activePresetId],
  );

  // 探测本地 3D Tiles 与离线 GIS 数据资产
  useEffect(() => {
    fetch('/api/local-assets/status')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: LocalAssetsAvailability | null) => {
        if (data) setLocalAssets(data);
      })
      .catch(() => {
        setLocalAssets(null);
      });
  }, []);

  // 根据所选场景自动提取建筑轮廓（优先 3D Tiles glTF 实时几何提取，若无本地切片则降级内置 CBD 建筑模型）
  const extractBuildingsForPreset = useCallback(
    async (
      preset: CityPreset,
      overrideRoi?: { minLon: number; maxLon: number; minLat: number; maxLat: number },
    ) => {
      if (preset.id === 'global') {
        setBuildings([]);
        sceneRef.current?.layerManager.clearLayer('sample-buildings');
        await sceneRef.current?.loadCityTileset(undefined);
        return;
      }

      const roi = overrideRoi ?? {
        minLon: preset.lon - preset.roiRadiusDeg,
        maxLon: preset.lon + preset.roiRadiusDeg,
        minLat: preset.lat - preset.roiRadiusDeg,
        maxLat: preset.lat + preset.roiRadiusDeg,
      };

      const tilesetKey = preset.tilesetKey;
      const localTilesetKey =
        tilesetKey &&
        tilesetKey !== 'sample-cbd' &&
        (localAssets === null || localAssets.tilesets[tilesetKey])
          ? tilesetKey
          : null;

      setIsExtractingBuildings(true);
      try {
        if (localTilesetKey) {
          const spec = LOCAL_TILESET_SPECS[localTilesetKey];
          await sceneRef.current?.loadCityTileset(tilesetKey);
          const extracted = await extractBuildingsFrom3DTileset(spec.url, roi, {
            altitudeOffset: spec.altitudeOffset,
            maxTiles: 6,
            maxBuildings: 420,
          });
          if (extracted.length > 0) {
            sceneRef.current?.layerManager.clearLayer('sample-buildings');
            setBuildings(extracted);
            return;
          }
        }

        // 兜底：无本地 3D Tiles 时生成并渲染高保真城市示范街区
        await sceneRef.current?.loadCityTileset('sample-cbd');
        const sample = createSampleCbdBuildings(preset.lon, preset.lat);
        sceneRef.current?.layerManager.renderSampleBuildings('sample-buildings', sample);
        setBuildings(sample);
      } catch {
        const sample = createSampleCbdBuildings(preset.lon, preset.lat);
        sceneRef.current?.layerManager.renderSampleBuildings('sample-buildings', sample);
        setBuildings(sample);
      } finally {
        setIsExtractingBuildings(false);
      }
    },
    [localAssets],
  );

  // 场景初始化完毕后自动飞入初始城区并加载建筑与网格
  useEffect(() => {
    if (!sceneReady || !sceneRef.current) return;
    sceneRef.current.flyToPreset(activePreset);
    extractBuildingsForPreset(activePreset);
  }, [sceneReady]);

  // 建筑体素化计算
  const voxelResult = useMemo(() => {
    if (buildings.length === 0 || activePreset.id === 'global') {
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
    buildings,
    activePreset.id,
    buildingLevel,
    verticalStepMeters,
    horizontalBufferMeters,
    verticalBufferMeters,
    maxAirspaceHeight,
    bufferGridEnabled,
    strataGridEnabled,
  ]);

  // 飞行计划避障分析
  const flightAnalysis = useMemo<FlightPathAnalysisResult | null>(() => {
    if (waypoints.length < 2 || activePreset.id === 'global') return null;
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
    waypoints,
    activePreset.id,
    voxelResult.obstacleCells,
    voxelResult.bufferCells,
    buildingLevel,
    verticalStepMeters,
    corridorRadiusMeters,
    maxAirspaceHeight,
  ]);

  // 1.1 全球球壳网格与局部空域网格渲染
  useEffect(() => {
    const mgr = sceneRef.current?.layerManager;
    if (!mgr) return;

    if (showGlobalShell) {
      const shellLv: GridLevel = gridLevel <= 2 ? gridLevel : 1;
      mgr.renderGlobalShellGrid('global-shell-grid', shellLv, {
        showLabels: showGridLabels,
        layerStyle,
      });
    } else {
      mgr.clearLayer('global-shell-grid');
    }

    if (showLocalGrid && activePreset.id !== 'global') {
      const localLv: GridLevel = gridLevel < 4 ? 5 : gridLevel > 7 ? 7 : gridLevel;
      const r = activePreset.roiRadiusDeg * 1.4;
      const cells = enumerate2DGridsInBounds(
        {
          minLon: activePreset.lon - r,
          maxLon: activePreset.lon + r,
          minLat: activePreset.lat - r,
          maxLat: activePreset.lat + r,
        },
        localLv,
        {
          maxCells: 450,
          minHeight: 160,
          maxHeight: 280,
          category: 'local-airspace',
        },
      );
      mgr.renderVoxelCells('local-airspace-grid', cells, {
        layerStyle,
        showLabels: showGridLabels,
        maxLabels: 90,
        flatBaseAltitude: 160,
      });
    } else {
      mgr.clearLayer('local-airspace-grid');
    }
  }, [
    sceneReady,
    showGlobalShell,
    showLocalGrid,
    gridLevel,
    layerStyle,
    showGridLabels,
    activePreset,
  ]);

  // 1.2 建筑实体体素 + 避障缓冲区 + 低空背景层 + 飞行冲突渲染
  useEffect(() => {
    const mgr = sceneRef.current?.layerManager;
    if (!mgr) return;

    if (strataGridEnabled && voxelResult.airspaceStrataCells.length > 0) {
      mgr.renderVoxelCells('airspace-strata', voxelResult.airspaceStrataCells, {
        layerStyle: '3d-wireframe',
        showLabels: false,
      });
    } else {
      mgr.clearLayer('airspace-strata');
    }

    if (buildingGridEnabled && voxelResult.obstacleCells.length > 0) {
      mgr.renderVoxelCells('building-voxels', voxelResult.obstacleCells, {
        layerStyle: 'translucent-volume',
        showLabels: showGridLabels,
        maxLabels: 70,
      });
    } else {
      mgr.clearLayer('building-voxels');
    }

    if (bufferGridEnabled && voxelResult.bufferCells.length > 0) {
      mgr.renderVoxelCells('buffer-voxels', voxelResult.bufferCells, {
        layerStyle: 'translucent-volume',
        showLabels: false,
      });
    } else {
      mgr.clearLayer('buffer-voxels');
    }

    if (flightAnalysis && activePreset.id !== 'global') {
      const detourPts = showDetourRoute ? flightAnalysis.detourWaypoints : [];
      mgr.renderFlightPath(
        'flight-plan-route',
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
      mgr.renderVoxelCells('flight-plan-voxels', activeFlightVoxels, {
        layerStyle: 'translucent-volume',
        showLabels: false,
      });
    } else {
      mgr.clearLayer('flight-plan-route');
      mgr.clearLayer('flight-plan-voxels');
    }
  }, [
    sceneReady,
    voxelResult,
    buildingGridEnabled,
    bufferGridEnabled,
    strataGridEnabled,
    showGridLabels,
    flightAnalysis,
    showDetourRoute,
    activePreset.id,
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
    if (!isSimulatingFlight) {
      sceneRef.current?.updateDroneMarker(null);
      sceneRef.current?.layerManager.clearLayer('live-flight-cell');
      setLiveFlightCell(null);
      return;
    }

    const activeRoute =
      showDetourRoute && flightAnalysis && flightAnalysis.detourWaypoints.length >= 2
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
    let lastCode = '';

    const tick = (now: number) => {
      const elapsed = (now - startTs) % durationMs;
      let targetDist = (elapsed / durationMs) * totalLen;

      let pos = activeRoute[0];
      for (let i = 0; i < segLengths.length; i++) {
        if (targetDist <= segLengths[i] || i === segLengths.length - 1) {
          const t = segLengths[i] > 0 ? Math.min(1, targetDist / segLengths[i]) : 0;
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
        'flight-detour',
        verticalStepMeters,
      );
      if (cell.code3D !== lastCode) {
        lastCode = cell.code3D;
        setLiveFlightCell(cell);
        sceneRef.current?.layerManager.renderVoxelCells('live-flight-cell', [cell], {
          layerStyle: 'translucent-volume',
          showLabels: true,
        });
      }

      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [
    isSimulatingFlight,
    waypoints,
    flightAnalysis,
    showDetourRoute,
    buildingLevel,
    verticalStepMeters,
  ]);

  const handleSelectPreset = useCallback(
    (preset: CityPreset) => {
      setActivePresetId(preset.id);
      setIsSimulatingFlight(false);
      if (preset.id === 'global') {
        setShowGlobalShell(true);
        setShowLocalGrid(false);
        setGridLevel(1);
      } else {
        setShowGlobalShell(false);
        setShowLocalGrid(true);
        if (preset.id === 'shenzhen-luohu') {
          setSelectedFlightPresetId('luohu-patrol');
          const fp = FLIGHT_PRESETS.find((f) => f.id === 'luohu-patrol');
          if (fp) setWaypoints(fp.waypoints);
        } else if (preset.id === 'shenzhen-futian' || preset.id === 'sample-cbd') {
          setSelectedFlightPresetId('futian-cross');
          setWaypoints(FLIGHT_PRESETS[0].waypoints);
        }
      }
      sceneRef.current?.flyToPreset(preset);
      extractBuildingsForPreset(preset);
    },
    [extractBuildingsForPreset],
  );

  const handleQueryPointOrCode = useCallback(
    (point?: Wgs84Point, code?: string) => {
      const mgr = sceneRef.current?.layerManager;
      if (!mgr) return;

      try {
        let cell: BeidouVoxelCell;
        if (code) {
          const b = getGridBounds(code);
          const minH = 'minHeight' in b ? b.minHeight : 0;
          const maxH = 'maxHeight' in b ? b.maxHeight : 120;
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
            category: 'query-highlight',
            label: code.toUpperCase(),
          };
        } else if (point) {
          cell = buildVoxelCell(
            point.lon,
            point.lat,
            point.height ?? 0,
            gridLevel,
            'query-highlight',
          );
        } else {
          return;
        }

        mgr.renderVoxelCells('query-highlight-layer', [cell], {
          layerStyle: 'translucent-volume',
          showLabels: true,
        });
        setInspectedCell(cell);
        sceneRef.current?.flyToBounds(cell);
      } catch (e) {
        alert(e instanceof Error ? e.message : '无效坐标或北斗编码');
      }
    },
    [gridLevel],
  );

  const handleSelectFlightPreset = useCallback((id: string) => {
    setSelectedFlightPresetId(id);
    const preset = FLIGHT_PRESETS.find((f) => f.id === id);
    if (preset) {
      setWaypoints(preset.waypoints);
    }
  }, []);

  const handleAddWaypoint = useCallback(
    (pt: Required<Wgs84Point>) => {
      setSelectedFlightPresetId('custom');
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
      const res = runtimeApi.renderLayer('dynamic-path-api-layer', {
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
          voxelResult.stats.obstacleVoxelCount +
          voxelResult.stats.bufferVoxelCount +
          voxelResult.stats.strataVoxelCount,
        renderedBuildingCount: voxelResult.stats.buildingCount,
      });
    },
    [voxelResult.stats],
  );

  const handleCameraLevelSuggest = useCallback(
    (lv: GridLevel) => {
      if (adaptiveLevelEnabled) {
        setGridLevel(lv);
      }
    },
    [adaptiveLevelEnabled],
  );

  return (
    <div className="app-root">
      <CesiumViewport
        localAssets={localAssets}
        activeGridLevel={gridLevel}
        isPickingWaypoint={isPickingWaypoint}
        onSceneReady={(handle) => {
          sceneRef.current = handle;
          setSceneReady(true);
        }}
        onTelemetry={handleTelemetry}
        onCameraLevelSuggest={handleCameraLevelSuggest}
        onPickVoxelCell={(cell) => setInspectedCell(cell)}
        onPickCoordinate={(pt) => handleQueryPointOrCode(pt)}
        onAddWaypoint={handleAddWaypoint}
      />

      <TopHudBar
        telemetry={telemetry}
        workbenchOpen={workbenchOpen}
        onToggleWorkbench={() => setWorkbenchOpen((o) => !o)}
        onOpenApiModal={() => setApiModalOpen(true)}
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
        onChangeTab={setActiveTab}
        collapsed={!workbenchOpen}
        activePresetId={activePresetId}
        onSelectPreset={handleSelectPreset}
        localAssets={localAssets}
        gridLevel={gridLevel}
        onChangeGridLevel={setGridLevel}
        adaptiveLevelEnabled={adaptiveLevelEnabled}
        onToggleAdaptiveLevel={setAdaptiveLevelEnabled}
        layerStyle={layerStyle}
        onChangeLayerStyle={setLayerStyle}
        showGlobalShell={showGlobalShell}
        onToggleGlobalShell={setShowGlobalShell}
        showLocalGrid={showLocalGrid}
        onToggleLocalGrid={setShowLocalGrid}
        showGridLabels={showGridLabels}
        onToggleGridLabels={setShowGridLabels}
        onQueryPointOrCode={handleQueryPointOrCode}
        buildingGridEnabled={buildingGridEnabled}
        onToggleBuildingGrid={setBuildingGridEnabled}
        bufferGridEnabled={bufferGridEnabled}
        onToggleBufferGrid={setBufferGridEnabled}
        strataGridEnabled={strataGridEnabled}
        onToggleStrataGrid={setStrataGridEnabled}
        buildingLevel={buildingLevel}
        onChangeBuildingLevel={setBuildingLevel}
        verticalStepMeters={verticalStepMeters}
        onChangeVerticalStepMeters={setVerticalStepMeters}
        horizontalBufferMeters={horizontalBufferMeters}
        onChangeHorizontalBufferMeters={setHorizontalBufferMeters}
        verticalBufferMeters={verticalBufferMeters}
        onChangeVerticalBufferMeters={setVerticalBufferMeters}
        maxAirspaceHeight={maxAirspaceHeight}
        onChangeMaxAirspaceHeight={setMaxAirspaceHeight}
        onReextractBuildings={() => {
          const roi = sceneRef.current?.getCameraRoi(activePreset.roiRadiusDeg);
          extractBuildingsForPreset(activePreset, roi);
        }}
        isExtractingBuildings={isExtractingBuildings}
        voxelStats={voxelResult.stats}
        selectedFlightPresetId={selectedFlightPresetId}
        onSelectFlightPreset={handleSelectFlightPreset}
        waypoints={waypoints}
        onUpdateWaypoints={setWaypoints}
        corridorRadiusMeters={corridorRadiusMeters}
        onChangeCorridorRadiusMeters={setCorridorRadiusMeters}
        showDetourRoute={showDetourRoute}
        onToggleShowDetourRoute={setShowDetourRoute}
        flightAnalysis={flightAnalysis}
        isPickingWaypoint={isPickingWaypoint}
        onTogglePickWaypoint={setIsPickingWaypoint}
        pickWaypointHeight={pickWaypointHeight}
        onChangePickWaypointHeight={setPickWaypointHeight}
        isSimulatingFlight={isSimulatingFlight}
        onToggleSimulateFlight={() => setIsSimulatingFlight((s) => !s)}
        liveFlightCell={liveFlightCell}
        apiLevels={apiLevels}
        onChangeApiLevels={setApiLevels}
        apiLayerStyle={apiLayerStyle}
        onChangeApiLayerStyle={setApiLayerStyle}
        apiPathResult={apiPathResult}
        onRunDynamicPathGeneration={handleRunDynamicPath}
        onClearDynamicPathLayer={() => {
          runtimeApi.clearLayer('dynamic-path-api-layer');
          setApiPathResult(null);
        }}
        onOpenApiModal={() => setApiModalOpen(true)}
      />

      <GridInspectorCard
        cell={inspectedCell}
        onClose={() => {
          setInspectedCell(null);
          sceneRef.current?.layerManager.clearLayer('query-highlight-layer');
        }}
        onSelectNeighborCode={(code) => handleQueryPointOrCode(undefined, code)}
      />

      <div className="legend-bar glass-panel">
        <div className="legend-item">
          <span
            className="legend-swatch"
            style={{ background: 'rgba(220, 38, 38, 0.72)' }}
          />
          <span>建筑网格化禁飞体元</span>
        </div>
        <div className="legend-item">
          <span
            className="legend-swatch"
            style={{ background: 'rgba(245, 158, 11, 0.55)' }}
          />
          <span>避障安全缓冲区</span>
        </div>
        <div className="legend-item">
          <span
            className="legend-swatch"
            style={{ background: 'rgba(6, 182, 212, 0.65)' }}
          />
          <span>路径/空域走廊</span>
        </div>
        <div className="legend-item">
          <span
            className="legend-swatch"
            style={{ background: 'rgba(16, 185, 129, 0.72)' }}
          />
          <span>A* 避障推荐绕飞</span>
        </div>
      </div>

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

const DefaultApiResultSeeder: React.FC<{ onSeed: () => void }> = ({ onSeed }) => {
  useEffect(() => {
    onSeed();
  }, [onSeed]);
  return null;
};

export default App;
