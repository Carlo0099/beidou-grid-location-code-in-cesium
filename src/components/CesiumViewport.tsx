import React, { useEffect, useRef } from "react";
import * as Cesium from "cesium";
import type {
  BeidouVoxelCell,
  CameraViewInfo,
  GridLevel,
  TelemetrySnapshot,
  ViewportBounds,
  Wgs84Point,
} from "../types/beidou";
import {
  encode2D,
  encode3D,
  recommendLevelFromAltitude,
} from "../core/BeidouGridCode";
import { GridLayerManager } from "../core/GridLayerManager";
import { GLOBAL_CAMERA_VIEW } from "../core/SampleCityData";
import { CESIUM_ION_TOKEN } from "../api/gisDataConfig";

export interface CesiumSceneHandle {
  viewer: Cesium.Viewer;
  layerManager: GridLayerManager;
  flyToGlobal: () => void;
  flyToUrbanView: (lon: number, lat: number, height?: number) => void;
  flyToCamera: (
    lon: number,
    lat: number,
    height: number,
    heading?: number,
    pitch?: number,
  ) => void;
  flyToBounds: (bounds: {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
    minHeight?: number;
    maxHeight?: number;
  }) => void;
  loadTilesetUrl: (
    url?: string,
    options?: { styleMode?: "white-model" | "blueprint"; opacity?: number },
  ) => Promise<boolean>;
  setTilesetOpacity: (
    opacity: number,
    styleMode?: "white-model" | "blueprint",
  ) => void;
  setTurbo244Mode: (enabled: boolean) => void;
  loadCesiumOsmBuildings: () => Promise<boolean>;
  getCameraRoi: (defaultRadiusDeg?: number) => {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
    centerLon: number;
    centerLat: number;
    cameraHeight: number;
  };
  updateDroneMarker: (point: Required<Wgs84Point> | null) => void;
}

interface CesiumViewportProps {
  activeGridLevel: GridLevel;
  isPickingWaypoint: boolean;
  onSceneReady: (handle: CesiumSceneHandle) => void;
  onTelemetry: (snapshot: TelemetrySnapshot) => void;
  onCameraViewChange: (view: CameraViewInfo) => void;
  onPickVoxelCell: (
    cell: BeidouVoxelCell,
    clickedHeightMeters?: number,
  ) => void;
  onPickCoordinate: (point: Required<Wgs84Point>) => void;
  onAddWaypoint: (point: Required<Wgs84Point>) => void;
}

export const CesiumViewport: React.FC<CesiumViewportProps> = React.memo(({
  activeGridLevel,
  isPickingWaypoint,
  onSceneReady,
  onTelemetry,
  onCameraViewChange,
  onPickVoxelCell,
  onPickCoordinate,
  onAddWaypoint,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const layerManagerRef = useRef<GridLayerManager | null>(null);
  const activeTilesetRef = useRef<Cesium.Cesium3DTileset | null>(null);
  const turbo244ModeRef = useRef<boolean>(false);
  const droneEntityRef = useRef<Cesium.Entity | null>(null);

  const propsRef = useRef({
    activeGridLevel,
    isPickingWaypoint,
    onTelemetry,
    onCameraViewChange,
    onPickVoxelCell,
    onPickCoordinate,
    onAddWaypoint,
  });
  propsRef.current = {
    activeGridLevel,
    isPickingWaypoint,
    onTelemetry,
    onCameraViewChange,
    onPickVoxelCell,
    onPickCoordinate,
    onAddWaypoint,
  };

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;

    if (CESIUM_ION_TOKEN) {
      Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;
    }

    // 严格使用 Cesium 内置底图清单；无 Ion Token 时自动选中免鉴权的内置 ArcGIS / OSM 图层
    const createDefaultModels = (
      Cesium as unknown as {
        createDefaultImageryProviderViewModels?: () => Cesium.ProviderViewModel[];
      }
    ).createDefaultImageryProviderViewModels;

    const imageryProviderViewModels = createDefaultModels
      ? createDefaultModels()
      : undefined;
    const defaultImageryModel =
      imageryProviderViewModels &&
      (CESIUM_ION_TOKEN
        ? imageryProviderViewModels[0]
        : (imageryProviderViewModels.find((m) =>
            m.name.includes("ArcGIS World Imagery"),
          ) ??
          imageryProviderViewModels.find((m) =>
            m.name.includes("OpenStreetMap"),
          ) ??
          imageryProviderViewModels[0]));

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayerPicker: true,
      ...(imageryProviderViewModels ? { imageryProviderViewModels } : {}),
      ...(defaultImageryModel
        ? { selectedImageryProviderViewModel: defaultImageryModel }
        : {}),
      terrainProviderViewModels: [],
      geocoder: false,
      homeButton: true,
      sceneModePicker: true,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      msaaSamples: 1,
      orderIndependentTranslucency: false,
      contextOptions: {
        webgl: {
          alpha: false,
          antialias: false,
          powerPreference: "high-performance",
        },
      },
    });

    if (viewer.cesiumWidget.creditContainer instanceof HTMLElement) {
      viewer.cesiumWidget.creditContainer.style.display = "none";
    }

    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString("#071426");
    viewer.scene.globe.enableLighting = false;
    // 固定上午 11:00 太阳方位角（UTC+8 03:00Z），使 3D Tiles 建筑白膜具有鲜明受光面与背光面对比
    viewer.clock.currentTime = Cesium.JulianDate.fromIso8601(
      "2026-06-21T03:00:00Z",
    );
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.show = true;
    }
    viewer.scene.globe.depthTestAgainstTerrain = false;

    // 解除近距离缩放到厘米级 (L9-L10) 的 Cesium 默认裁剪与最小缩放限制，并适度降低连续拖动相机触发频率以保障高帧率
    viewer.camera.percentageChanged = 0.035;
    if (viewer.camera.frustum instanceof Cesium.PerspectiveFrustum) {
      viewer.camera.frustum.near = 0.02;
    }
    const controller = viewer.scene.screenSpaceCameraController;
    controller.minimumZoomDistance = 0.05;
    (controller as unknown as { _minimumZoomRate?: number })._minimumZoomRate =
      0.25;
    viewer.scene.sunBloom = false;
    viewer.scene.postProcessStages.fxaa.enabled = false;
    viewer.scene.globe.showGroundAtmosphere = false;
    viewer.scene.globe.tileCacheSize = 400;
    viewer.scene.globe.maximumScreenSpaceError = turbo244ModeRef.current ? 4.5 : 3.0;
    if (viewer.scene.sun) viewer.scene.sun.show = false;
    if (viewer.scene.moon) viewer.scene.moon.show = false;

    viewerRef.current = viewer;
    const layerManager = new GridLayerManager(viewer);
    layerManagerRef.current = layerManager;

    let lastFpsTick = performance.now();
    let frameCounter = 0;
    let latestMouse: {
      lon: number | null;
      lat: number | null;
      height: number | null;
      code2D: string;
      code3D: string;
    } = { lon: null, lat: null, height: null, code2D: "", code3D: "" };

    const computeViewportBounds = (
      centerLon: number,
      centerLat: number,
      camHeight: number,
    ): ViewportBounds => {
      const canvas = viewer.scene.canvas;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      const camPos = viewer.camera.positionWC;
      const camCarto = viewer.camera.positionCartographic;
      const camLon = Cesium.Math.toDegrees(camCarto.longitude);
      const camLat = Cesium.Math.toDegrees(camCarto.latitude);
      const cosLat = Math.max(0.25, Math.cos((camLat * Math.PI) / 180));

      // 最大地平线视距在低空倾斜视角下覆盖清晰城市前景至中远天际线（避免斜望无限拉长到数十公里外）
      const maxGroundRangeM =
        camHeight < 2500
          ? Math.max(2.0, Math.min(18_000, camHeight * 18))
          : Math.max(2.0, Math.min(3_500_000, camHeight * 38));
      const maxHalfLatDeg = Math.min(55, maxGroundRangeM / 111_000);
      const maxHalfLonDeg = Math.min(75, maxHalfLatDeg / cosLat);

      const pickedLons: number[] = [];
      const pickedLats: number[] = [];
      let minHitDist = Number.POSITIVE_INFINITY;

      const pushHit = (hit: Cesium.Cartesian3) => {
        const c = Cesium.Cartographic.fromCartesian(hit);
        const hLon = Cesium.Math.toDegrees(c.longitude);
        const hLat = Cesium.Math.toDegrees(c.latitude);
        const dist3D = Cesium.Cartesian3.distance(camPos, hit);
        if (dist3D < minHitDist) minHitDist = dist3D;
        const effectiveRange =
          minHitDist < Number.POSITIVE_INFINITY
            ? Math.min(3_500_000, Math.max(maxGroundRangeM, minHitDist * 3.5))
            : maxGroundRangeM;
        if (dist3D <= effectiveRange) {
          pickedLons.push(hLon);
          pickedLats.push(hLat);
        } else {
          // 远超视距时，保留射线方向并将边界夹紧至 effectiveRange，覆盖至远方天际线且避免无穷溢出
          const scale = effectiveRange / Math.max(1e-3, dist3D);
          const clampedLon = camLon + (hLon - camLon) * scale;
          const clampedLat = camLat + (hLat - camLat) * scale;
          pickedLons.push(clampedLon);
          pickedLats.push(clampedLat);
        }
      };

      if (w > 0 && h > 0) {
        const uList = [0.0, 0.33, 0.67, 1.0];
        // 由视口底端向顶端天际线采样（4x3 高效网格），兼顾视野覆盖与更低射线开销
        const vList = [1.0, 0.52, 0.04];
        for (const u of uList) {
          let lastGroundV: number | null = null;
          for (const v of vList) {
            const ray = viewer.camera.getPickRay(
              new Cesium.Cartesian2(w * u, h * v),
            );
            const hit = ray
              ? viewer.scene.globe.pick(ray, viewer.scene)
              : undefined;
            if (hit) {
              pushHit(hit);
              lastGroundV = v;
              continue;
            }
            if (lastGroundV !== null) {
              let loV = v;
              let hiV = lastGroundV;
              let edgeHit: Cesium.Cartesian3 | undefined;
              for (let step = 0; step < 4; step++) {
                const midV = (loV + hiV) * 0.5;
                const midRay = viewer.camera.getPickRay(
                  new Cesium.Cartesian2(w * u, h * midV),
                );
                const midHit = midRay
                  ? viewer.scene.globe.pick(midRay, viewer.scene)
                  : undefined;
                if (midHit) {
                  edgeHit = midHit;
                  hiV = midV;
                } else {
                  loV = midV;
                }
              }
              if (edgeHit) pushHit(edgeHit);
              break;
            }
          }
        }
      }

      const viewRect = viewer.camera.computeViewRectangle(
        Cesium.Ellipsoid.WGS84,
      );
      if (viewRect) {
        const rw = Cesium.Math.toDegrees(viewRect.west);
        const re = Cesium.Math.toDegrees(viewRect.east);
        const rs = Cesium.Math.toDegrees(viewRect.south);
        const rn = Cesium.Math.toDegrees(viewRect.north);
        if (re - rw > 0 && re - rw < 150) {
          pickedLons.push(
            Math.max(camLon - maxHalfLonDeg, rw),
            Math.min(camLon + maxHalfLonDeg, re),
          );
          pickedLats.push(
            Math.max(camLat - maxHalfLatDeg, rs),
            Math.min(camLat + maxHalfLatDeg, rn),
          );
        }
      }

      if (pickedLons.length >= 2 && pickedLats.length >= 2) {
        const rawMinLon = Math.min(...pickedLons);
        const rawMaxLon = Math.max(...pickedLons);
        const rawMinLat = Math.min(...pickedLats);
        const rawMaxLat = Math.max(...pickedLats);
        if (rawMaxLon - rawMinLon < 160) {
          const padLon = Math.max(1e-7, (rawMaxLon - rawMinLon) * 0.1);
          const padLat = Math.max(1e-7, (rawMaxLat - rawMinLat) * 0.1);
          return {
            minLon: Math.max(-179.95, rawMinLon - padLon),
            maxLon: Math.min(179.95, rawMaxLon + padLon),
            minLat: Math.max(-85, rawMinLat - padLat),
            maxLat: Math.min(85, rawMaxLat + padLat),
          };
        }
      }

      const fallbackHalfLat = Math.max(1e-6, (camHeight * 0.9) / 111_000);
      const fallbackHalfLon = Math.min(60, (fallbackHalfLat * 1.6) / cosLat);
      return {
        minLon: Math.max(-179.95, centerLon - fallbackHalfLon),
        maxLon: Math.min(179.95, centerLon + fallbackHalfLon),
        minLat: Math.max(-85, centerLat - fallbackHalfLat),
        maxLat: Math.min(85, centerLat + fallbackHalfLat),
      };
    };

    const computeCameraViewInfo = (isInteracting = false): CameraViewInfo => {
      const canvas = viewer.scene.canvas;
      const centerPx = new Cesium.Cartesian2(
        Math.max(1, canvas.clientWidth) / 2,
        Math.max(1, canvas.clientHeight) / 2,
      );
      const camCarto = viewer.camera.positionCartographic;
      const cameraHeightMeters = Math.max(0.05, camCarto.height);
      const tileset = activeTilesetRef.current;
      const hasActiveTileset = Boolean(tileset && !tileset.isDestroyed());
      let hit: Cesium.Cartesian3 | undefined;
      if (
        hasActiveTileset &&
        canvas.clientWidth > 0 &&
        cameraHeightMeters <= 600 &&
        viewer.scene.pickPositionSupported
      ) {
        hit = viewer.scene.pickPosition(centerPx);
      }
      if (!hit && canvas.clientWidth > 0) {
        const ray = viewer.camera.getPickRay(centerPx);
        hit = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
      }
      const targetCarto = hit
        ? Cesium.Cartographic.fromCartesian(hit)
        : camCarto;
      if (tileset && !tileset.isDestroyed()) {
        const baseSse = turbo244ModeRef.current ? 20 : 14;
        tileset.maximumScreenSpaceError =
          cameraHeightMeters > 6000
            ? Math.max(baseSse, 64)
            : cameraHeightMeters > 2500
              ? Math.max(baseSse, 32)
              : baseSse;
      }
      const cameraLon = Cesium.Math.toDegrees(camCarto.longitude);
      const cameraLat = Cesium.Math.toDegrees(camCarto.latitude);
      const centerLon = Cesium.Math.toDegrees(targetCarto.longitude);
      const centerLat = Cesium.Math.toDegrees(targetCarto.latitude);
      const cameraHeadingDeg = Cesium.Math.toDegrees(viewer.camera.heading);
      const cameraPitchDeg = Cesium.Math.toDegrees(viewer.camera.pitch);
      const viewTargetDistanceMeters = hit
        ? Math.max(
            0.05,
            Cesium.Cartesian3.distance(viewer.camera.positionWC, hit),
          )
        : cameraHeightMeters;

      return {
        cameraHeightMeters,
        cameraLon,
        cameraLat,
        cameraHeadingDeg,
        cameraPitchDeg,
        viewTargetDistanceMeters,
        centerLon,
        centerLat,
        adaptiveLevel: recommendLevelFromAltitude(cameraHeightMeters),
        viewportBounds: computeViewportBounds(
          centerLon,
          centerLat,
          cameraHeightMeters,
        ),
        isInteracting,
      };
    };

    const removePostRender = viewer.scene.postRender.addEventListener(() => {
      frameCounter++;
      const now = performance.now();
      if (now - lastFpsTick >= 500) {
        const fps = Math.round((frameCounter * 1000) / (now - lastFpsTick));
        frameCounter = 0;
        lastFpsTick = now;

        const camHeight = viewer.camera.positionCartographic.height;
        const adaptive = recommendLevelFromAltitude(camHeight);

        propsRef.current.onTelemetry({
          fps,
          cameraHeightMeters: camHeight,
          adaptiveLevel: adaptive,
          mouseLon: latestMouse.lon,
          mouseLat: latestMouse.lat,
          mouseHeight: latestMouse.height,
          mouseCode2D: latestMouse.code2D,
          mouseCode3D: latestMouse.code3D,
          renderedVoxelCount: 0,
          renderedBuildingCount: 0,
        });
      }
    });

    let lastWheelMs = 0;
    let lastCameraEmitMs = 0;
    let pendingTimer: number | null = null;
    let settleTimer: number | null = null;
    const scheduleSettleEmit = () => {
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
      }
      settleTimer = window.setTimeout(() => {
        settleTimer = null;
        if (!viewer.isDestroyed()) {
          propsRef.current.onCameraViewChange(computeCameraViewInfo(false));
        }
      }, 170);
    };
    const notifyCameraView = (immediate = false) => {
      const now = performance.now();
      const isWheelBurst = now - lastWheelMs < 180;
      const throttleMs = isWheelBurst ? 200 : 110;
      if (immediate) {
        if (pendingTimer !== null) {
          window.clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        if (settleTimer !== null) {
          window.clearTimeout(settleTimer);
          settleTimer = null;
        }
        lastCameraEmitMs = now;
        propsRef.current.onCameraViewChange(computeCameraViewInfo(false));
        return;
      }
      scheduleSettleEmit();
      if (!isWheelBurst && now - lastCameraEmitMs >= throttleMs) {
        if (pendingTimer !== null) {
          window.clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        lastCameraEmitMs = now;
        propsRef.current.onCameraViewChange(computeCameraViewInfo(true));
        return;
      }
      if (pendingTimer === null) {
        pendingTimer = window.setTimeout(() => {
          pendingTimer = null;
          lastCameraEmitMs = performance.now();
          if (!viewer.isDestroyed()) {
            propsRef.current.onCameraViewChange(computeCameraViewInfo(true));
          }
        }, throttleMs);
      }
    };

    const removeCameraChanged = viewer.camera.changed.addEventListener(() => {
      notifyCameraView(false);
    });
    const removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
      notifyCameraView(true);
    });

    // 低空或近建筑屋顶 (< 45m 视距) 时启用连续对数滚轮缩放，绕过 Cesium 碰撞阻尼，平滑放大至厘米级 (L9-L10)
    const onWheelCapture = (e: WheelEvent) => {
      if (viewer.isDestroyed() || e.deltaY === 0) return;
      lastWheelMs = performance.now();
      const camCarto = viewer.camera.positionCartographic;
      const camHeight = camCarto.height;
      // 超过最高建筑+净空范围 (600m) 直接放行给 Cesium 原生缩放，彻底消除每次滚轮的 GPU pickPosition 同步阻塞
      if (camHeight > 600) return;

      const canvas = viewer.scene.canvas;
      const rect = canvas.getBoundingClientRect();
      const pointer = new Cesium.Cartesian2(
        e.clientX - rect.left,
        e.clientY - rect.top,
      );
      const centerPx = new Cesium.Cartesian2(
        Math.max(1, canvas.clientWidth) / 2,
        Math.max(1, canvas.clientHeight) / 2,
      );

      let hit: Cesium.Cartesian3 | undefined;
      const hasActiveTileset = Boolean(
        activeTilesetRef.current && !activeTilesetRef.current.isDestroyed(),
      );
      if (hasActiveTileset && viewer.scene.pickPositionSupported) {
        const pickedPos = viewer.scene.pickPosition(pointer);
        if (pickedPos) hit = pickedPos;
      }
      if (!hit) {
        const ray =
          viewer.camera.getPickRay(pointer) ??
          viewer.camera.getPickRay(centerPx);
        hit = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
      }

      const targetDist = hit
        ? Cesium.Cartesian3.distance(viewer.camera.position, hit)
        : camHeight;
      const effectiveClearance = Math.min(camHeight, targetDist);
      if (effectiveClearance > 45) return;
      if (effectiveClearance > 32 && e.deltaY > 0) return;

      e.preventDefault();
      e.stopImmediatePropagation();

      const zoomingIn = e.deltaY < 0;
      const minClearance = 0.08;

      if (hit) {
        const dir = Cesium.Cartesian3.normalize(
          Cesium.Cartesian3.subtract(
            hit,
            viewer.camera.position,
            new Cesium.Cartesian3(),
          ),
          new Cesium.Cartesian3(),
        );
        if (zoomingIn) {
          if (targetDist <= minClearance || camHeight <= minClearance) return;
          const rawStep = Math.max(0.015, targetDist * 0.26);
          const clampedStep = Math.min(
            rawStep,
            Math.max(0, targetDist - minClearance),
          );
          viewer.camera.move(dir, clampedStep);
        } else {
          const backStep = Math.max(0.025, targetDist * 0.34);
          viewer.camera.move(dir, -backStep);
        }
      } else {
        if (zoomingIn && camHeight > minClearance) {
          viewer.camera.zoomIn(
            Math.max(0.015, (camHeight - minClearance) * 0.26),
          );
        } else if (!zoomingIn) {
          viewer.camera.zoomOut(Math.max(0.025, camHeight * 0.34));
        }
      }

      notifyCameraView(false);
    };
    viewer.scene.canvas.addEventListener("wheel", onWheelCapture, {
      passive: false,
      capture: true,
    });

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    let lastMousePickMs = 0;

    handler.setInputAction(
      (movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
        const now = performance.now();
        if (now - lastMousePickMs < 24) return;
        lastMousePickMs = now;

        const ray = viewer.camera.getPickRay(movement.endPosition);
        if (!ray) return;
        const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
        if (!cartesian) {
          latestMouse = {
            lon: null,
            lat: null,
            height: null,
            code2D: "",
            code3D: "",
          };
          return;
        }
        const carto = Cesium.Cartographic.fromCartesian(cartesian);
        const lon = Cesium.Math.toDegrees(carto.longitude);
        const lat = Cesium.Math.toDegrees(carto.latitude);
        const h = Math.max(0, carto.height || 0);
        const lv = propsRef.current.activeGridLevel;
        try {
          latestMouse = {
            lon,
            lat,
            height: h,
            code2D: encode2D(lat, lon, lv),
            code3D: encode3D(lat, lon, h, lv),
          };
        } catch {
          // out of range
        }
      },
      Cesium.ScreenSpaceEventType.MOUSE_MOVE,
    );

    handler.setInputAction(
      (click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
        if (propsRef.current.isPickingWaypoint) {
          const ray = viewer.camera.getPickRay(click.position);
          const cartesian = ray
            ? viewer.scene.globe.pick(ray, viewer.scene)
            : undefined;
          if (cartesian) {
            const carto = Cesium.Cartographic.fromCartesian(cartesian);
            propsRef.current.onAddWaypoint({
              lon: Cesium.Math.toDegrees(carto.longitude),
              lat: Cesium.Math.toDegrees(carto.latitude),
              height: 0,
              timestamp: Date.now(),
            });
          }
          return;
        }

        const picked = viewer.scene.pick(click.position);
        if (
          picked &&
          picked.id &&
          typeof picked.id === "object" &&
          "code3D" in picked.id
        ) {
          let clickedH: number | undefined;
          if (viewer.scene.pickPositionSupported) {
            const pickedPos = viewer.scene.pickPosition(click.position);
            if (pickedPos) {
              const c = Cesium.Cartographic.fromCartesian(pickedPos);
              clickedH = Math.max(0, c.height || 0);
            }
          }
          propsRef.current.onPickVoxelCell(
            picked.id as BeidouVoxelCell,
            clickedH,
          );
          return;
        }

        const pickedPosition = viewer.scene.pickPositionSupported
          ? viewer.scene.pickPosition(click.position)
          : undefined;
        const cartesian =
          pickedPosition ??
          (() => {
            const ray = viewer.camera.getPickRay(click.position);
            return ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
          })();

        if (cartesian) {
          const carto = Cesium.Cartographic.fromCartesian(cartesian);
          propsRef.current.onPickCoordinate({
            lon: Cesium.Math.toDegrees(carto.longitude),
            lat: Cesium.Math.toDegrees(carto.latitude),
            height: Math.max(0, carto.height || 0),
            timestamp: Date.now(),
          });
        }
      },
      Cesium.ScreenSpaceEventType.LEFT_CLICK,
    );

    const clearActiveTileset = () => {
      if (activeTilesetRef.current) {
        try {
          viewer.scene.primitives.remove(activeTilesetRef.current);
        } catch {
          // ignore
        }
        activeTilesetRef.current = null;
      }
    };

    const handle: CesiumSceneHandle = {
      viewer,
      layerManager,

      flyToGlobal() {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(
            GLOBAL_CAMERA_VIEW.lon,
            GLOBAL_CAMERA_VIEW.lat,
            GLOBAL_CAMERA_VIEW.height,
          ),
          orientation: {
            heading: Cesium.Math.toRadians(GLOBAL_CAMERA_VIEW.heading),
            pitch: Cesium.Math.toRadians(GLOBAL_CAMERA_VIEW.pitch),
            roll: 0,
          },
          duration: 1.2,
        });
      },

      flyToUrbanView(lon, lat, height = 1050) {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat - 0.0085, height),
          orientation: {
            heading: Cesium.Math.toRadians(18),
            pitch: Cesium.Math.toRadians(-34),
            roll: 0,
          },
          duration: 1.1,
        });
      },

      flyToCamera(lon, lat, height, heading = 12, pitch = -30) {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(lon, lat, height),
          orientation: {
            heading: Cesium.Math.toRadians(heading),
            pitch: Cesium.Math.toRadians(pitch),
            roll: 0,
          },
          duration: 1.15,
        });
      },

      flyToBounds(bounds) {
        const span = Math.max(
          bounds.maxLon - bounds.minLon,
          bounds.maxLat - bounds.minLat,
        );
        const padLon = Math.max(
          0.000002,
          (bounds.maxLon - bounds.minLon) * 1.1,
        );
        const padLat = Math.max(
          0.000002,
          (bounds.maxLat - bounds.minLat) * 1.1,
        );
        const cLon = (bounds.minLon + bounds.maxLon) * 0.5;
        const cLat = (bounds.minLat + bounds.maxLat) * 0.5;

        if (span < 0.02) {
          const spanMeters = Math.max(0.15, span * 111_000);
          const alt = Math.max(
            0.45,
            Math.min(400, (bounds.maxHeight ?? 0) + spanMeters * 3.2),
          );
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(cLon, cLat, alt),
            orientation: {
              heading: 0,
              pitch: Cesium.Math.toRadians(-85),
              roll: 0,
            },
            duration: 1.0,
          });
        } else {
          viewer.camera.flyTo({
            destination: Cesium.Rectangle.fromDegrees(
              bounds.minLon - padLon,
              bounds.minLat - padLat,
              bounds.maxLon + padLon,
              bounds.maxLat + padLat,
            ),
            duration: 1.2,
          });
        }
      },

      async loadTilesetUrl(url, options) {
        clearActiveTileset();
        if (!url || !url.trim()) return false;

        const styleMode = options?.styleMode ?? "blueprint";
        const opacity = options?.opacity ?? 1.0;

        try {
          const tileset = await Cesium.Cesium3DTileset.fromUrl(url.trim(), {
            maximumScreenSpaceError: turbo244ModeRef.current ? 20 : 14,
            dynamicScreenSpaceError: true,
            skipLevelOfDetail: true,
            cullWithChildrenBounds: true,
            cullRequestsWhileMoving: true,
            cullRequestsWhileMovingMultiplier: 12,
            foveatedScreenSpaceError: true,
            cacheBytes: 512 * 1024 * 1024,
            maximumCacheOverflowBytes: 256 * 1024 * 1024,
          });
          tileset.backFaceCulling = opacity >= 0.85;
          if (styleMode === "white-model") {
            tileset.style = new Cesium.Cesium3DTileStyle({
              color: `color('#e8eef5', ${Math.max(0.1, Math.min(1, opacity)).toFixed(2)})`,
            });
          } else {
            tileset.style = new Cesium.Cesium3DTileStyle({
              color: `color('#1e3a5f', ${Math.max(0.1, Math.min(1, opacity)).toFixed(2)})`,
            });
          }
          viewer.scene.primitives.add(tileset);
          activeTilesetRef.current = tileset;
          return true;
        } catch (err) {
          console.warn("3D Tileset load failed:", err);
          return false;
        }
      },

      setTilesetOpacity(opacity, styleMode = "white-model") {
        const tileset = activeTilesetRef.current;
        if (!tileset || tileset.isDestroyed()) return;
        tileset.backFaceCulling = opacity >= 0.85;
        const hex = styleMode === "white-model" ? "#e8eef5" : "#1e3a5f";
        tileset.style = new Cesium.Cesium3DTileStyle({
          color: `color('${hex}', ${Math.max(0.05, Math.min(1, opacity)).toFixed(2)})`,
        });
      },

      setTurbo244Mode(enabled) {
        turbo244ModeRef.current = enabled;
        if (viewer.isDestroyed()) return;
        viewer.resolutionScale = enabled ? 0.85 : 1.0;
        viewer.scene.fog.enabled = !enabled;
        if (viewer.scene.skyAtmosphere) {
          viewer.scene.skyAtmosphere.show = !enabled;
        }
        viewer.scene.globe.maximumScreenSpaceError = enabled ? 4.5 : 3.0;
        const tileset = activeTilesetRef.current;
        if (tileset && !tileset.isDestroyed()) {
          const h = viewer.camera.positionCartographic.height;
          const baseSse = enabled ? 20 : 14;
          tileset.maximumScreenSpaceError =
            h > 6000 ? Math.max(baseSse, 64) : h > 2500 ? Math.max(baseSse, 32) : baseSse;
        }
      },

      async loadCesiumOsmBuildings() {
        clearActiveTileset();
        if (!CESIUM_ION_TOKEN) return false;
        try {
          const tileset = await Cesium.createOsmBuildingsAsync();
          viewer.scene.primitives.add(tileset);
          activeTilesetRef.current = tileset;
          return true;
        } catch (err) {
          console.warn("Cesium OSM Buildings load failed:", err);
          return false;
        }
      },

      getCameraRoi(defaultRadiusDeg = 0.005) {
        const info = computeCameraViewInfo();
        const radiusDeg = Math.min(
          15,
          Math.max(
            defaultRadiusDeg,
            Math.min(0.08, info.cameraHeightMeters / 180_000),
          ),
        );

        return {
          minLon: info.centerLon - radiusDeg,
          maxLon: info.centerLon + radiusDeg,
          minLat: info.centerLat - radiusDeg,
          maxLat: info.centerLat + radiusDeg,
          centerLon: info.centerLon,
          centerLat: info.centerLat,
          cameraHeight: info.cameraHeightMeters,
        };
      },

      updateDroneMarker(point) {
        if (!point) {
          if (droneEntityRef.current) {
            viewer.entities.remove(droneEntityRef.current);
            droneEntityRef.current = null;
          }
          return;
        }

        const pos = Cesium.Cartesian3.fromDegrees(
          point.lon,
          point.lat,
          point.height,
        );
        if (!droneEntityRef.current) {
          droneEntityRef.current = viewer.entities.add({
            position: pos,
            point: {
              pixelSize: 13,
              color: Cesium.Color.fromCssColorString("#34d399"),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 3,
            },
            label: {
              text: "UAV 实时巡航节点",
              font: "bold 12px sans-serif",
              fillColor: Cesium.Color.fromCssColorString("#6ee7b7"),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -18),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        } else {
          droneEntityRef.current.position = new Cesium.ConstantPositionProperty(
            pos,
          );
        }
      },
    };

    const removeHomeOverride =
      viewer.homeButton.viewModel.command.beforeExecute.addEventListener(
        (e: { cancel: boolean }) => {
          e.cancel = true;
          handle.flyToGlobal();
        },
      );

    onSceneReady(handle);

    return () => {
      if (pendingTimer !== null) {
        window.clearTimeout(pendingTimer);
      }
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
      }
      viewer.scene.canvas.removeEventListener("wheel", onWheelCapture, {
        capture: true,
      });
      removeHomeOverride();
      removePostRender();
      removeCameraChanged();
      removeMoveEnd();
      handler.destroy();
      clearActiveTileset();
      layerManager.clearAll();
      if (!viewer.isDestroyed()) {
        viewer.destroy();
      }
      viewerRef.current = null;
      layerManagerRef.current = null;
    };
  }, []);

  return <div ref={containerRef} className="cesium-host" />;
});
