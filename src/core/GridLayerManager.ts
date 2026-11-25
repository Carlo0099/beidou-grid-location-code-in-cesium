import * as Cesium from 'cesium';
import type {
  BeidouVoxelCell,
  BuildingFootprint,
  GridCellCategory,
  GridLayerStyle,
  GridLevel,
  Wgs84Point,
} from '../types/beidou';
import { encode2D, getLevelSpec } from './BeidouGridCode';

const CATEGORY_STYLE: Record<
  GridCellCategory,
  { fill: Cesium.Color; outline: Cesium.Color }
> = {
  'global-shell': {
    fill: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.08),
    outline: Cesium.Color.WHITE.withAlpha(0.75),
  },
  'local-airspace': {
    fill: Cesium.Color.fromCssColorString('#38bdf8').withAlpha(0.12),
    outline: Cesium.Color.WHITE.withAlpha(0.78),
  },
  'airspace-free': {
    fill: Cesium.Color.fromCssColorString('#94a3b8').withAlpha(0.05),
    outline: Cesium.Color.WHITE.withAlpha(0.32),
  },
  'building-obstacle': {
    fill: Cesium.Color.fromCssColorString('#dc2626').withAlpha(0.38),
    outline: Cesium.Color.WHITE.withAlpha(0.88),
  },
  'obstacle-buffer': {
    fill: Cesium.Color.fromCssColorString('#f59e0b').withAlpha(0.18),
    outline: Cesium.Color.fromCssColorString('#fde68a').withAlpha(0.65),
  },
  'flight-corridor': {
    fill: Cesium.Color.fromCssColorString('#06b6d4').withAlpha(0.28),
    outline: Cesium.Color.fromCssColorString('#67e8f9').withAlpha(0.92),
  },
  'flight-conflict': {
    fill: Cesium.Color.fromCssColorString('#ff1e42').withAlpha(0.68),
    outline: Cesium.Color.YELLOW.withAlpha(0.98),
  },
  'flight-detour': {
    fill: Cesium.Color.fromCssColorString('#10b981').withAlpha(0.32),
    outline: Cesium.Color.fromCssColorString('#6ee7b7').withAlpha(0.95),
  },
  'query-highlight': {
    fill: Cesium.Color.fromCssColorString('#3b82f6').withAlpha(0.35),
    outline: Cesium.Color.fromCssColorString('#93c5fd').withAlpha(0.98),
  },
};

// 全局复用单元立方体几何，单次 Draw Call 渲染数千体元
let sharedUnitBoxGeometry: Cesium.BoxGeometry | null = null;
let sharedUnitBoxOutlineGeometry: Cesium.BoxOutlineGeometry | null = null;

function getUnitBoxGeometry(): Cesium.BoxGeometry {
  if (!sharedUnitBoxGeometry) {
    sharedUnitBoxGeometry = Cesium.BoxGeometry.fromDimensions({
      dimensions: new Cesium.Cartesian3(1, 1, 1),
      vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
    });
  }
  return sharedUnitBoxGeometry;
}

function getUnitBoxOutlineGeometry(): Cesium.BoxOutlineGeometry {
  if (!sharedUnitBoxOutlineGeometry) {
    sharedUnitBoxOutlineGeometry = Cesium.BoxOutlineGeometry.fromDimensions({
      dimensions: new Cesium.Cartesian3(1, 1, 1),
    });
  }
  return sharedUnitBoxOutlineGeometry;
}

function computeCellEnuModelMatrix(
  cell: BeidouVoxelCell,
  forceFlat2D: boolean,
  flatBaseAltitude?: number,
): Cesium.Matrix4 {
  const height = forceFlat2D
    ? 0.4
    : Math.max(0.5, cell.maxHeight - cell.minHeight);
  const centerH = forceFlat2D
    ? (flatBaseAltitude ?? cell.minHeight) + 0.2
    : cell.centerHeight;

  const center = Cesium.Cartesian3.fromDegrees(cell.centerLon, cell.centerLat, centerH);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);

  const pWest = Cesium.Cartesian3.fromDegrees(cell.minLon, cell.centerLat, centerH);
  const pEast = Cesium.Cartesian3.fromDegrees(cell.maxLon, cell.centerLat, centerH);
  const pSouth = Cesium.Cartesian3.fromDegrees(cell.centerLon, cell.minLat, centerH);
  const pNorth = Cesium.Cartesian3.fromDegrees(cell.centerLon, cell.maxLat, centerH);

  const widthX = Math.max(0.4, Cesium.Cartesian3.distance(pWest, pEast));
  const depthY = Math.max(0.4, Cesium.Cartesian3.distance(pSouth, pNorth));

  const scale = Cesium.Matrix4.fromScale(new Cesium.Cartesian3(widthX, depthY, height));
  return Cesium.Matrix4.multiply(enu, scale, new Cesium.Matrix4());
}

export interface ManagedLayerHandles {
  primitives: Cesium.Primitive[];
  polylines: Cesium.PolylineCollection | null;
  labels: Cesium.LabelCollection | null;
  entities: Cesium.Entity[];
}

/**
 * Cesium 多模式北斗网格批量图元渲染管理器
 * 支持 2D平面 / 3D立体线框 / 半透明体积 / 混合融合 四种图层模式及全球球壳立体网格
 */
export class GridLayerManager {
  private viewer: Cesium.Viewer;
  private layerGroups = new Map<string, ManagedLayerHandles>();

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
  }

  clearLayer(layerId: string): void {
    const handles = this.layerGroups.get(layerId);
    if (!handles || this.viewer.isDestroyed()) return;

    for (const prim of handles.primitives) {
      try {
        this.viewer.scene.primitives.remove(prim);
      } catch {
        // ignore
      }
    }
    if (handles.polylines) {
      try {
        this.viewer.scene.primitives.remove(handles.polylines);
      } catch {
        // ignore
      }
    }
    if (handles.labels) {
      try {
        this.viewer.scene.primitives.remove(handles.labels);
      } catch {
        // ignore
      }
    }
    for (const ent of handles.entities) {
      try {
        this.viewer.entities.remove(ent);
      } catch {
        // ignore
      }
    }
    this.layerGroups.delete(layerId);
  }

  clearAll(): void {
    for (const id of Array.from(this.layerGroups.keys())) {
      this.clearLayer(id);
    }
  }

  /**
   * 渲染全球/大范围立体多层北斗球壳网格 (对应参考图 1 全球北斗立体线框)
   * 使用 PolylineCollection 规避 GeometryPipeline.splitLongitude 对跨±180°子午线顶点属性插值的限制
   */
  renderGlobalShellGrid(
    layerId: string,
    level: GridLevel,
    options?: {
      shellAltitudes?: number[];
      showLabels?: boolean;
      roi?: { minLon: number; maxLon: number; minLat: number; maxLat: number };
      layerStyle?: GridLayerStyle;
    },
  ): number {
    this.clearLayer(layerId);
    if (this.viewer.isDestroyed()) return 0;

    const spec = getLevelSpec(level);
    const altitudes = options?.shellAltitudes ?? [15_000, 320_000, 640_000, 960_000];
    const roi = options?.roi ?? {
      minLon: -180,
      maxLon: 180,
      minLat: -84,
      maxLat: 84,
    };

    const lonStep = level === 1 ? 6 : level === 2 ? 0.5 : spec.lonDeg;
    const latStep = level === 1 ? 4 : level === 2 ? 0.5 : spec.latDeg;

    // 防护大范围高精级别线数爆炸
    const lonCount = Math.ceil((roi.maxLon - roi.minLon) / lonStep);
    const latCount = Math.ceil((roi.maxLat - roi.minLat) / latStep);
    const stride =
      lonCount * latCount > 2800
        ? Math.ceil(Math.sqrt((lonCount * latCount) / 2800))
        : 1;
    const stepLon = lonStep * stride;
    const stepLat = latStep * stride;

    const minLon = Math.floor(roi.minLon / stepLon) * stepLon;
    const maxLon = Math.min(180, Math.ceil(roi.maxLon / stepLon) * stepLon);
    const minLat = Math.max(-84, Math.floor(roi.minLat / stepLat) * stepLat);
    const maxLat = Math.min(84, Math.ceil(roi.maxLat / stepLat) * stepLat);

    const topAlt = altitudes[altitudes.length - 1];
    const baseAlt = altitudes[0];
    const layerAlts =
      options?.layerStyle === '2d-plane' ? [baseAlt] : altitudes;

    const polylineCollection = new Cesium.PolylineCollection();
    const arcStepDeg = 3;

    for (let li = 0; li < layerAlts.length; li++) {
      const alt = layerAlts[li];
      const isOuter = li === layerAlts.length - 1;
      const mat = Cesium.Material.fromType('Color', {
        color: Cesium.Color.WHITE.withAlpha(isOuter ? 0.72 : 0.34),
      });
      const width = isOuter ? 1.25 : 1.0;

      // 纬线环
      for (let lat = minLat; lat <= maxLat + 1e-6; lat += stepLat) {
        const pts: Cesium.Cartesian3[] = [];
        for (let lon = minLon; lon < maxLon - 1e-6; lon += arcStepDeg) {
          pts.push(Cesium.Cartesian3.fromDegrees(lon, lat, alt));
        }
        pts.push(Cesium.Cartesian3.fromDegrees(maxLon, lat, alt));
        polylineCollection.add({ positions: pts, width, material: mat });
      }

      // 经线弧（避免 180° 与 -180° 重复绘制）
      for (let lon = minLon; lon < maxLon - 1e-6; lon += stepLon) {
        const pts: Cesium.Cartesian3[] = [];
        for (let lat = minLat; lat < maxLat - 1e-6; lat += arcStepDeg) {
          pts.push(Cesium.Cartesian3.fromDegrees(lon, lat, alt));
        }
        pts.push(Cesium.Cartesian3.fromDegrees(lon, maxLat, alt));
        polylineCollection.add({ positions: pts, width, material: mat });
      }
    }

    // 径向垂直立柱（连接底层球面与顶层球壳）
    if (layerAlts.length >= 2) {
      const pillarMat = Cesium.Material.fromType('Color', {
        color: Cesium.Color.WHITE.withAlpha(0.24),
      });
      for (let lat = minLat; lat <= maxLat + 1e-6; lat += stepLat) {
        for (let lon = minLon; lon < maxLon - 1e-6; lon += stepLon) {
          polylineCollection.add({
            positions: [
              Cesium.Cartesian3.fromDegrees(lon, lat, baseAlt),
              Cesium.Cartesian3.fromDegrees(lon, lat, topAlt),
            ],
            width: 1.0,
            material: pillarMat,
          });
        }
      }
    }

    this.viewer.scene.primitives.add(polylineCollection);

    let labels: Cesium.LabelCollection | null = null;
    if (options?.showLabels !== false) {
      labels = new Cesium.LabelCollection({ scene: this.viewer.scene });
      const labelStepLon = stepLon * (level === 1 ? 2 : 1);
      const labelStepLat = stepLat * (level === 1 ? 2 : 1);
      let labelCount = 0;

      for (let lat = minLat + stepLat * 0.5; lat < maxLat; lat += labelStepLat) {
        for (let lon = minLon + stepLon * 0.5; lon < maxLon; lon += labelStepLon) {
          if (labelCount >= 180 || lon >= 179.9 || Math.abs(lat) > 85) continue;
          const code = encode2D(lat, lon, level);
          labels.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, topAlt + 12000),
            text: code,
            font: '600 12px Consolas, "Microsoft YaHei", monospace',
            fillColor: Cesium.Color.WHITE.withAlpha(0.92),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.85),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            scaleByDistance: new Cesium.NearFarScalar(2_000_000, 1.0, 22_000_000, 0.55),
          });
          labelCount++;
        }
      }
      this.viewer.scene.primitives.add(labels);
    }

    this.layerGroups.set(layerId, {
      primitives: [],
      polylines: polylineCollection,
      labels,
      entities: [],
    });

    return Math.round((maxLon - minLon) / stepLon) * Math.round((maxLat - minLat) / stepLat);
  }

  /**
   * 渲染任意北斗体元数组（支持 2d-plane / 3d-wireframe / translucent-volume / hybrid）
   */
  renderVoxelCells(
    layerId: string,
    cells: BeidouVoxelCell[],
    options?: {
      layerStyle?: GridLayerStyle;
      showLabels?: boolean;
      maxLabels?: number;
      flatBaseAltitude?: number;
    },
  ): number {
    this.clearLayer(layerId);
    if (this.viewer.isDestroyed() || cells.length === 0) return 0;

    const style = options?.layerStyle ?? 'translucent-volume';
    const showLabels = options?.showLabels ?? false;
    const maxLabels = options?.maxLabels ?? 120;

    const boxGeo = getUnitBoxGeometry();
    const outlineGeo = getUnitBoxOutlineGeometry();

    const fillInstances: Cesium.GeometryInstance[] = [];
    const outlineInstances: Cesium.GeometryInstance[] = [];
    const groundFootprintInstances: Cesium.GeometryInstance[] = [];
    const seenFootprints = new Set<string>();

    const is2DOnly = style === '2d-plane';
    const showFill = style === '2d-plane' || style === 'translucent-volume' || style === 'hybrid';
    const showOutline = true;

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const palette = CATEGORY_STYLE[cell.category] ?? CATEGORY_STYLE['local-airspace'];
      const modelMatrix = computeCellEnuModelMatrix(
        cell,
        is2DOnly,
        options?.flatBaseAltitude,
      );

      if (showFill) {
        const fillColor =
          cell.category === 'airspace-free' && style === 'translucent-volume'
            ? palette.fill.withAlpha(0.02)
            : palette.fill;

        fillInstances.push(
          new Cesium.GeometryInstance({
            geometry: boxGeo,
            modelMatrix,
            id: cell,
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(fillColor),
            },
          }),
        );
      }

      if (showOutline) {
        outlineInstances.push(
          new Cesium.GeometryInstance({
            geometry: outlineGeo,
            modelMatrix,
            id: cell,
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(palette.outline),
            },
          }),
        );
      }

      if (style === 'hybrid' && !seenFootprints.has(cell.code2D)) {
        seenFootprints.add(cell.code2D);
        groundFootprintInstances.push(
          new Cesium.GeometryInstance({
            geometry: boxGeo,
            modelMatrix: computeCellEnuModelMatrix(cell, true, options?.flatBaseAltitude ?? 1),
            id: cell,
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                palette.fill.withAlpha(0.24),
              ),
            },
          }),
        );
      }
    }

    const primitives: Cesium.Primitive[] = [];

    if (fillInstances.length > 0) {
      const fillPrimitive = new Cesium.Primitive({
        geometryInstances: fillInstances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
          renderState: {
            depthTest: { enabled: true },
            depthMask: false,
            cull: { enabled: false },
          },
        }),
        asynchronous: false,
      });
      this.viewer.scene.primitives.add(fillPrimitive);
      primitives.push(fillPrimitive);
    }

    if (groundFootprintInstances.length > 0) {
      const fpPrimitive = new Cesium.Primitive({
        geometryInstances: groundFootprintInstances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
          renderState: {
            depthTest: { enabled: true },
            depthMask: false,
          },
        }),
        asynchronous: false,
      });
      this.viewer.scene.primitives.add(fpPrimitive);
      primitives.push(fpPrimitive);
    }

    if (outlineInstances.length > 0) {
      const outlinePrimitive = new Cesium.Primitive({
        geometryInstances: outlineInstances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
          renderState: {
            depthTest: { enabled: true },
          },
        }),
        asynchronous: false,
      });
      this.viewer.scene.primitives.add(outlinePrimitive);
      primitives.push(outlinePrimitive);
    }

    let labels: Cesium.LabelCollection | null = null;
    if (showLabels) {
      labels = new Cesium.LabelCollection({ scene: this.viewer.scene });
      const labeledCandidates = cells.filter((c) => Boolean(c.label));
      const pool = labeledCandidates.length > 0 ? labeledCandidates : cells;
      const step = Math.max(1, Math.ceil(pool.length / maxLabels));

      for (let i = 0; i < pool.length; i += step) {
        const c = pool[i];
        labels.add({
          position: Cesium.Cartesian3.fromDegrees(
            c.centerLon,
            c.centerLat,
            is2DOnly ? (options?.flatBaseAltitude ?? c.minHeight) + 2 : c.maxHeight + 1.5,
          ),
          text: c.label ?? (c.level >= 6 ? c.code3D : c.code2D),
          font: '600 11px Consolas, monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 18000),
          scaleByDistance: new Cesium.NearFarScalar(80, 1.0, 5000, 0.45),
        });
      }
      this.viewer.scene.primitives.add(labels);
    }

    this.layerGroups.set(layerId, {
      primitives,
      polylines: null,
      labels,
      entities: [],
    });

    return cells.length;
  }

  /**
   * 在无本地 3D Tiles 环境下渲染内置示范街区建筑实体
   */
  renderSampleBuildings(layerId: string, buildings: BuildingFootprint[]): void {
    this.clearLayer(layerId);
    if (this.viewer.isDestroyed() || buildings.length === 0) return;

    const entities: Cesium.Entity[] = [];
    for (const bld of buildings) {
      const flatDegrees: number[] = [];
      for (const [lon, lat] of bld.polygon) {
        flatDegrees.push(lon, lat);
      }
      const entity = this.viewer.entities.add({
        name: bld.name,
        polygon: {
          hierarchy: Cesium.Cartesian3.fromDegreesArray(flatDegrees),
          height: bld.baseHeight,
          extrudedHeight: bld.roofHeight,
          material: Cesium.Color.fromCssColorString('#1e293b').withAlpha(0.92),
          outline: true,
          outlineColor: Cesium.Color.fromCssColorString('#64748b').withAlpha(0.85),
        },
        properties: {
          buildingId: bld.id,
          buildingName: bld.name,
          roofHeight: bld.roofHeight,
        },
      });
      entities.push(entity);
    }

    this.layerGroups.set(layerId, {
      primitives: [],
      polylines: null,
      labels: null,
      entities,
    });
  }

  /**
   * 渲染飞行计划航线与避障推荐绕飞航线
   */
  renderFlightPath(
    layerId: string,
    waypoints: Required<Wgs84Point>[],
    detourWaypoints: Required<Wgs84Point>[],
    isSafe: boolean,
  ): void {
    this.clearLayer(layerId);
    if (this.viewer.isDestroyed() || waypoints.length === 0) return;

    const entities: Cesium.Entity[] = [];

    if (waypoints.length >= 2) {
      const pos = waypoints.map((p) =>
        Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
      );
      entities.push(
        this.viewer.entities.add({
          name: 'Planned Flight Trajectory',
          polyline: {
            positions: pos,
            width: 4,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.25,
              color: isSafe
                ? Cesium.Color.fromCssColorString('#22d3ee')
                : Cesium.Color.fromCssColorString('#f43f5e'),
            }),
          },
        }),
      );
    }

    waypoints.forEach((pt, idx) => {
      entities.push(
        this.viewer.entities.add({
          position: Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, pt.height),
          point: {
            pixelSize: 9,
            color: isSafe
              ? Cesium.Color.fromCssColorString('#22d3ee')
              : Cesium.Color.fromCssColorString('#fb7185'),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
          },
          label: {
            text: `W${idx + 1} (${Math.round(pt.height)}m)`,
            font: '600 11px sans-serif',
            fillColor: Cesium.Color.WHITE,
            outlineColor: Cesium.Color.BLACK,
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            pixelOffset: new Cesium.Cartesian2(0, -16),
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        }),
      );
    });

    if (detourWaypoints.length >= 2) {
      const detourPos = detourWaypoints.map((p) =>
        Cesium.Cartesian3.fromDegrees(p.lon, p.lat, p.height),
      );
      entities.push(
        this.viewer.entities.add({
          name: 'Obstacle-Free Detour Route',
          polyline: {
            positions: detourPos,
            width: 4,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString('#34d399'),
              dashLength: 14,
            }),
          },
        }),
      );
    }

    this.layerGroups.set(layerId, {
      primitives: [],
      polylines: null,
      labels: null,
      entities,
    });
  }
}
