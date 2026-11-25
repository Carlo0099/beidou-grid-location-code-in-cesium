import React, { useEffect, useRef } from 'react';
import * as Cesium from 'cesium';
import type {
  BeidouVoxelCell,
  CityPreset,
  GridLevel,
  LocalAssetsAvailability,
  TelemetrySnapshot,
  Wgs84Point,
} from '../types/beidou';
import {
  encode2D,
  encode3D,
  recommendLevelFromAltitude,
} from '../core/BeidouGridCode';
import { GridLayerManager } from '../core/GridLayerManager';
import {
  CESIUM_ION_TOKEN,
  createGridFallbackImageryProvider,
  createLocalOfflineImageryProviders,
  createOnlineTiandituProviders,
  createPublicSatelliteImageryProvider,
  LOCAL_TILESET_SPECS,
  TIANDITU_TOKEN,
} from '../api/gisDataConfig';

export interface CesiumSceneHandle {
  viewer: Cesium.Viewer;
  layerManager: GridLayerManager;
  flyToPreset: (preset: CityPreset) => void;
  flyToBounds: (bounds: {
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
    minHeight?: number;
    maxHeight?: number;
  }) => void;
  loadCityTileset: (
    key: keyof typeof LOCAL_TILESET_SPECS | 'sample-cbd' | undefined,
  ) => Promise<void>;
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
  localAssets: LocalAssetsAvailability | null;
  activeGridLevel: GridLevel;
  isPickingWaypoint: boolean;
  onSceneReady: (handle: CesiumSceneHandle) => void;
  onTelemetry: (snapshot: TelemetrySnapshot) => void;
  onCameraLevelSuggest: (level: GridLevel) => void;
  onPickVoxelCell: (cell: BeidouVoxelCell) => void;
  onPickCoordinate: (point: Required<Wgs84Point>) => void;
  onAddWaypoint: (point: Required<Wgs84Point>) => void;
}

export const CesiumViewport: React.FC<CesiumViewportProps> = ({
  localAssets,
  activeGridLevel,
  isPickingWaypoint,
  onSceneReady,
  onTelemetry,
  onCameraLevelSuggest,
  onPickVoxelCell,
  onPickCoordinate,
  onAddWaypoint,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Cesium.Viewer | null>(null);
  const layerManagerRef = useRef<GridLayerManager | null>(null);
  const activeTilesetRef = useRef<Cesium.Cesium3DTileset | null>(null);
  const droneEntityRef = useRef<Cesium.Entity | null>(null);

  const propsRef = useRef({
    activeGridLevel,
    isPickingWaypoint,
    onTelemetry,
    onCameraLevelSuggest,
    onPickVoxelCell,
    onPickCoordinate,
    onAddWaypoint,
  });
  propsRef.current = {
    activeGridLevel,
    isPickingWaypoint,
    onTelemetry,
    onCameraLevelSuggest,
    onPickVoxelCell,
    onPickCoordinate,
    onAddWaypoint,
  };

  useEffect(() => {
    if (!containerRef.current || viewerRef.current) return;

    if (CESIUM_ION_TOKEN) {
      Cesium.Ion.defaultAccessToken = CESIUM_ION_TOKEN;
    }

    const viewer = new Cesium.Viewer(containerRef.current, {
      baseLayer: false,
      baseLayerPicker: false,
      geocoder: false,
      homeButton: false,
      sceneModePicker: false,
      navigationHelpButton: false,
      animation: false,
      timeline: false,
      fullscreenButton: false,
      infoBox: false,
      selectionIndicator: false,
      contextOptions: {
        webgl: {
          alpha: false,
          antialias: true,
          powerPreference: 'high-performance',
        },
      },
    });

    if (viewer.cesiumWidget.creditContainer instanceof HTMLElement) {
      viewer.cesiumWidget.creditContainer.style.display = 'none';
    }

    viewer.scene.globe.baseColor = Cesium.Color.fromCssColorString('#071426');
    viewer.scene.globe.enableLighting = false;
    if (viewer.scene.skyAtmosphere) {
      viewer.scene.skyAtmosphere.show = true;
    }
    viewer.scene.globe.depthTestAgainstTerrain = false;

    // 底层 Grid 兜底保障任何网络/离线环境下地球可见
    viewer.imageryLayers.addImageryProvider(createGridFallbackImageryProvider());

    // 若配置了个人天地图 Token 则使用天地图影像与注记，否则使用公开影像底图（免 Token）
    if (TIANDITU_TOKEN) {
      const onlineProviders = createOnlineTiandituProviders(TIANDITU_TOKEN);
      onlineProviders.forEach((p) => viewer.imageryLayers.addImageryProvider(p));
    } else {
      viewer.imageryLayers.addImageryProvider(createPublicSatelliteImageryProvider());
    }

    const layerManager = new GridLayerManager(viewer);
    viewerRef.current = viewer;
    layerManagerRef.current = layerManager;

    let lastFpsTick = performance.now();
    let frameCounter = 0;
    let latestMouse: {
      lon: number | null;
      lat: number | null;
      height: number | null;
      code2D: string;
      code3D: string;
    } = { lon: null, lat: null, height: null, code2D: '', code3D: '' };

    const removePostRender = viewer.scene.postRender.addEventListener(() => {
      frameCounter++;
      const now = performance.now();
      if (now - lastFpsTick >= 600) {
        const fps = Math.min(120, Math.round((frameCounter * 1000) / (now - lastFpsTick)));
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

    const removeCameraChanged = viewer.camera.changed.addEventListener(() => {
      const camHeight = viewer.camera.positionCartographic.height;
      propsRef.current.onCameraLevelSuggest(recommendLevelFromAltitude(camHeight));
    });

    const handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

    handler.setInputAction((movement: Cesium.ScreenSpaceEventHandler.MotionEvent) => {
      const ray = viewer.camera.getPickRay(movement.endPosition);
      if (!ray) return;
      const cartesian = viewer.scene.globe.pick(ray, viewer.scene);
      if (!cartesian) {
        latestMouse = { lon: null, lat: null, height: null, code2D: '', code3D: '' };
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
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    handler.setInputAction((click: Cesium.ScreenSpaceEventHandler.PositionedEvent) => {
      // 若处于选点规划状态，优先采样三维坐标
      if (propsRef.current.isPickingWaypoint) {
        const ray = viewer.camera.getPickRay(click.position);
        const cartesian = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
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
        typeof picked.id === 'object' &&
        'code3D' in picked.id
      ) {
        propsRef.current.onPickVoxelCell(picked.id as BeidouVoxelCell);
        return;
      }

      const cartesian =
        viewer.scene.pickPositionSupported && viewer.scene.pickPosition(click.position)
          ? viewer.scene.pickPosition(click.position)
          : (() => {
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
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    const handle: CesiumSceneHandle = {
      viewer,
      layerManager,

      flyToPreset(preset) {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(preset.lon, preset.lat, preset.height),
          orientation: {
            heading: Cesium.Math.toRadians(preset.heading),
            pitch: Cesium.Math.toRadians(preset.pitch),
            roll: 0,
          },
          duration: 1.2,
        });
      },

      flyToBounds(bounds) {
        const padLon = Math.max(0.0005, (bounds.maxLon - bounds.minLon) * 0.6);
        const padLat = Math.max(0.0005, (bounds.maxLat - bounds.minLat) * 0.6);
        const cLon = (bounds.minLon + bounds.maxLon) * 0.5;
        const cLat = (bounds.minLat + bounds.maxLat) * 0.5;
        const spanDeg = Math.max(padLon, padLat);

        if (spanDeg < 0.02) {
          const alt = Math.max(160, (bounds.maxHeight ?? 80) + spanDeg * 180000);
          viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromDegrees(cLon, cLat - spanDeg * 0.8, alt),
            orientation: {
              heading: Cesium.Math.toRadians(12),
              pitch: Cesium.Math.toRadians(-38),
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

      async loadCityTileset(key) {
        if (activeTilesetRef.current) {
          try {
            viewer.scene.primitives.remove(activeTilesetRef.current);
          } catch {
            // ignore
          }
          activeTilesetRef.current = null;
        }

        if (!key || key === 'sample-cbd') return;
        const spec = LOCAL_TILESET_SPECS[key];
        if (!spec) return;

        try {
          const tileset = await Cesium.Cesium3DTileset.fromUrl(spec.url, {
            maximumScreenSpaceError: 8,
            dynamicScreenSpaceError: true,
            skipLevelOfDetail: true,
            baseScreenSpaceError: 1024,
            skipScreenSpaceErrorFactor: 16,
            skipLevels: 1,
          });
          tileset.backFaceCulling = false;
          tileset.style = new Cesium.Cesium3DTileStyle({
            color: "color('#1e3a5f', 1.0)",
          });

          viewer.scene.primitives.add(tileset);
          activeTilesetRef.current = tileset;
        } catch (err) {
          console.warn('3D Tileset fallback to sample buildings:', err);
        }
      },

      getCameraRoi(defaultRadiusDeg = 0.005) {
        const canvas = viewer.scene.canvas;
        const centerPx = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
        const ray = viewer.camera.getPickRay(centerPx);
        const hit = ray ? viewer.scene.globe.pick(ray, viewer.scene) : undefined;
        const camCarto = viewer.camera.positionCartographic;

        const targetCarto = hit
          ? Cesium.Cartographic.fromCartesian(hit)
          : camCarto;
        const centerLon = Cesium.Math.toDegrees(targetCarto.longitude);
        const centerLat = Cesium.Math.toDegrees(targetCarto.latitude);
        const camHeight = Math.max(100, camCarto.height);

        const radiusDeg = Math.min(
          15,
          Math.max(defaultRadiusDeg, Math.min(0.08, camHeight / 180_000)),
        );

        return {
          minLon: centerLon - radiusDeg,
          maxLon: centerLon + radiusDeg,
          minLat: centerLat - radiusDeg,
          maxLat: centerLat + radiusDeg,
          centerLon,
          centerLat,
          cameraHeight: camHeight,
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

        const pos = Cesium.Cartesian3.fromDegrees(point.lon, point.lat, point.height);
        if (!droneEntityRef.current) {
          droneEntityRef.current = viewer.entities.add({
            position: pos,
            point: {
              pixelSize: 13,
              color: Cesium.Color.fromCssColorString('#34d399'),
              outlineColor: Cesium.Color.WHITE,
              outlineWidth: 3,
            },
            label: {
              text: 'UAV 实时巡航节点',
              font: 'bold 12px sans-serif',
              fillColor: Cesium.Color.fromCssColorString('#6ee7b7'),
              outlineColor: Cesium.Color.BLACK,
              outlineWidth: 2,
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              pixelOffset: new Cesium.Cartesian2(0, -18),
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
            },
          });
        } else {
          droneEntityRef.current.position = new Cesium.ConstantPositionProperty(pos);
        }
      },
    };

    onSceneReady(handle);

    return () => {
      removePostRender();
      removeCameraChanged();
      handler.destroy();
      layerManager.clearAll();
      if (!viewer.isDestroyed()) {
        viewer.destroy();
      }
      viewerRef.current = null;
      layerManagerRef.current = null;
    };
  }, []);

  // 如果检测到本地离线天地图瓦片可用，优先升级本地高速影像层
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer || viewer.isDestroyed() || !localAssets?.tiles) return;

    const offlineProviders = createLocalOfflineImageryProviders();
    offlineProviders.forEach((p) => viewer.imageryLayers.addImageryProvider(p));
  }, [localAssets]);

  return <div ref={containerRef} className="cesium-host" />;
};
