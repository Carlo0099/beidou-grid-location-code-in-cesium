import * as Cesium from 'cesium';
import type {
  BeidouVoxelCell,
  BuildingFootprint,
  GridCellCategory,
  GridLayerStyle,
  GridLevel,
  Wgs84Point,
} from '../types/beidou';
import {
  decode2D,
  encode2D,
  encode3D,
  getHeightResolution,
  getLevelSpec,
} from './BeidouGridCode';

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
  const heightSpan = Math.max(0.004, cell.maxHeight - cell.minHeight);
  const flatThickness = Math.min(0.4, Math.max(0.004, heightSpan * 0.25));
  const height = forceFlat2D ? flatThickness : heightSpan;
  const centerH = forceFlat2D
    ? (flatBaseAltitude ?? cell.minHeight) + flatThickness * 0.5
    : cell.centerHeight;

  const center = Cesium.Cartesian3.fromDegrees(cell.centerLon, cell.centerLat, centerH);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(center);

  const pWest = Cesium.Cartesian3.fromDegrees(cell.minLon, cell.centerLat, centerH);
  const pEast = Cesium.Cartesian3.fromDegrees(cell.maxLon, cell.centerLat, centerH);
  const pSouth = Cesium.Cartesian3.fromDegrees(cell.centerLon, cell.minLat, centerH);
  const pNorth = Cesium.Cartesian3.fromDegrees(cell.centerLon, cell.maxLat, centerH);

  const widthX = Math.max(0.004, Cesium.Cartesian3.distance(pWest, pEast));
  const depthY = Math.max(0.004, Cesium.Cartesian3.distance(pSouth, pNorth));

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

      // 纬线环与子午面分割保护：经度范围 [-180, 180]，纬度 [-88, 88]
      const latLoopMin = Math.max(-88, minLat);
      const latLoopMax = Math.min(88, maxLat);

      // 纬线环
      for (let lat = latLoopMin; lat <= latLoopMax + 1e-6; lat += stepLat) {
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
        for (let lat = latLoopMin; lat < latLoopMax - 1e-6; lat += arcStepDeg) {
          pts.push(Cesium.Cartesian3.fromDegrees(lon, lat, alt));
        }
        pts.push(Cesium.Cartesian3.fromDegrees(lon, latLoopMax, alt));
        polylineCollection.add({ positions: pts, width, material: mat });
      }
    }

    // 径向垂直立柱（连接底层球面与顶层球壳）
    if (layerAlts.length >= 2) {
      const pillarMat = Cesium.Material.fromType('Color', {
        color: Cesium.Color.WHITE.withAlpha(0.24),
      });
      for (let lat = Math.max(-88, minLat); lat <= Math.min(88, maxLat) + 1e-6; lat += stepLat) {
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
      // 全球宏观视野每一个网格均附带编码标注
      const latStart = Math.max(-88, minLat);
      const latEnd = Math.min(88, maxLat);

      for (let lat = latStart + stepLat * 0.5; lat < latEnd; lat += stepLat) {
        for (let lon = minLon + stepLon * 0.5; lon < maxLon; lon += stepLon) {
          if (lon >= 179.99 || lon <= -179.99 || Math.abs(lat) > 87.9) continue;
          const code = encode2D(lat, lon, level);
          labels.add({
            position: Cesium.Cartesian3.fromDegrees(lon, lat, topAlt + 15000),
            text: code,
            font: '600 11px Consolas, "Microsoft YaHei", monospace',
            fillColor: Cesium.Color.WHITE.withAlpha(0.96),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.92),
            outlineWidth: 2,
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            scaleByDistance: new Cesium.NearFarScalar(2_000_000, 1.0, 24_000_000, 0.55),
            translucencyByDistance: new Cesium.NearFarScalar(8_000_000, 1.0, 17_800_000, 0.08),
          });
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
   * L2-L10 视口自适应北斗网格渲染：
   * 1. 按当前相机视口地理范围满屏铺开且严格对齐北斗网格边界
   * 2. 使用 PolylineCollection 消除相邻网格双线重影并稳定维持 120 FPS
   * 3. 对 L7-L10 长编码自动双行折行 + 屏幕空间包围盒防重叠剔除，确保标注清晰可读
   */
  renderViewportGrid(
    layerId: string,
    bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number },
    level: GridLevel,
    options?: {
      layerStyle?: GridLayerStyle;
      showLabels?: boolean;
      cameraHeightMeters?: number;
    },
  ): number {
    this.clearLayer(layerId);
    if (this.viewer.isDestroyed()) return 0;

    const minLonRaw = Math.max(-179.95, Math.min(179.95, bounds.minLon));
    const maxLonRaw = Math.max(-179.95, Math.min(179.95, bounds.maxLon));
    const minLatRaw = Math.max(-85, Math.min(85, bounds.minLat));
    const maxLatRaw = Math.max(-85, Math.min(85, bounds.maxLat));
    if (minLonRaw >= maxLonRaw || minLatRaw >= maxLatRaw) return 0;

    const spec = getLevelSpec(level);
    const first = decode2D(encode2D(minLatRaw, minLonRaw, level));
    const last = decode2D(encode2D(maxLatRaw, maxLonRaw, level));

    const roughSpanLon = Math.max(spec.lonDeg, last.maxLon - first.minLon);
    const roughSpanLat = Math.max(spec.latDeg, last.maxLat - first.minLat);
    const nativeCols = Math.max(1, Math.round(roughSpanLon / spec.lonDeg));
    const nativeRows = Math.max(1, Math.round(roughSpanLat / spec.latDeg));

    // 当视口内原生网格过于密集时，按 2 的幂对齐北斗边界抽稀以维持视口清晰度与满屏铺设
    const rawStride = Math.max(1, Math.ceil(Math.max(nativeCols / 76, nativeRows / 60)));
    let stride = 1;
    while (stride < rawStride) stride *= 2;

    const stepLon = spec.lonDeg * stride;
    const stepLat = spec.latDeg * stride;

    // 对齐全球固定 stepLon / stepLat 网格索引，避免斜视/平移时网格线抖动
    const snapMinLon = Math.max(-180, Math.floor(first.minLon / stepLon) * stepLon);
    const snapMaxLon = Math.min(180, Math.ceil(last.maxLon / stepLon) * stepLon);
    const snapMinLat = Math.max(-85, Math.floor(first.minLat / stepLat) * stepLat);
    const snapMaxLat = Math.min(85, Math.ceil(last.maxLat / stepLat) * stepLat);

    const lons: number[] = [snapMinLon];
    for (let i = 1; i <= 96; i++) {
      const v = snapMinLon + i * stepLon;
      lons.push(Math.min(180, v));
      if (v >= snapMaxLon - stepLon * 0.05) break;
    }
    const lats: number[] = [snapMinLat];
    for (let j = 1; j <= 84; j++) {
      const v = snapMinLat + j * stepLat;
      lats.push(Math.min(85, v));
      if (v >= snapMaxLat - stepLat * 0.05) break;
    }
    if (lons.length < 2 || lats.length < 2) return 0;

    const style = options?.layerStyle ?? '3d-wireframe';
    const camH = Math.max(0.08, options?.cameraHeightMeters ?? 1000);
    const baseAlt =
      camH > 20_000 ? 80 : camH > 500 ? 1.5 : Math.max(0.004, camH * 0.008);
    const heightRes = getHeightResolution(level);
    // 多层三维空域网格：在 3D 模式下绘制 3 个垂向叠加层（4 层水平网面 + 贯通垂向立柱）
    const layerCount = 3;
    const layerStep = Math.min(heightRes, Math.max(0.006, camH * 0.13));
    const layerAlts = Array.from({ length: layerCount + 1 }, (_, k) => baseAlt + k * layerStep);
    const topAlt = layerAlts[layerAlts.length - 1];

    const is2DOnly = style === '2d-plane';
    const polylineCollection = new Cesium.PolylineCollection();
    const arcSubdiv = stepLon > 0.35 ? 6 : 1;

    const addLatLonMesh = (alt: number, mat: Cesium.Material, width: number) => {
      for (let r = 0; r < lats.length; r++) {
        const lat = lats[r];
        const pts: Cesium.Cartesian3[] = [];
        for (let c = 0; c < lons.length - 1; c++) {
          const lonA = lons[c];
          const lonB = lons[c + 1];
          for (let s = 0; s < arcSubdiv; s++) {
            const t = s / arcSubdiv;
            pts.push(Cesium.Cartesian3.fromDegrees(lonA + (lonB - lonA) * t, lat, alt));
          }
        }
        pts.push(Cesium.Cartesian3.fromDegrees(lons[lons.length - 1], lat, alt));
        polylineCollection.add({ positions: pts, width, material: mat });
      }

      for (let c = 0; c < lons.length; c++) {
        const lon = lons[c];
        const pts: Cesium.Cartesian3[] = [];
        for (let r = 0; r < lats.length - 1; r++) {
          const latA = lats[r];
          const latB = lats[r + 1];
          for (let s = 0; s < arcSubdiv; s++) {
            const t = s / arcSubdiv;
            pts.push(Cesium.Cartesian3.fromDegrees(lon, latA + (latB - latA) * t, alt));
          }
        }
        pts.push(Cesium.Cartesian3.fromDegrees(lon, lats[lats.length - 1], alt));
        polylineCollection.add({ positions: pts, width, material: mat });
      }
    };

    const baseLineMat = Cesium.Material.fromType('Color', {
      color: Cesium.Color.fromCssColorString('#e0f2fe').withAlpha(is2DOnly ? 0.85 : 0.78),
    });
    addLatLonMesh(baseAlt, baseLineMat, is2DOnly ? 1.4 : 1.25);

    if (!is2DOnly) {
      const midLineMat = Cesium.Material.fromType('Color', {
        color: Cesium.Color.fromCssColorString('#7dd3fc').withAlpha(0.36),
      });
      const topLineMat = Cesium.Material.fromType('Color', {
        color: Cesium.Color.fromCssColorString('#bae6fd').withAlpha(0.62),
      });
      const pillarMat = Cesium.Material.fromType('Color', {
        color: Cesium.Color.WHITE.withAlpha(0.24),
      });

      for (let li = 1; li < layerAlts.length; li++) {
        const isTop = li === layerAlts.length - 1;
        addLatLonMesh(
          layerAlts[li],
          isTop ? topLineMat : midLineMat,
          isTop ? 1.15 : 0.95,
        );
      }

      const pillarStep = lats.length * lons.length > 1800 ? 2 : 1;
      for (let r = 0; r < lats.length; r += pillarStep) {
        for (let c = 0; c < lons.length; c += pillarStep) {
          polylineCollection.add({
            positions: [
              Cesium.Cartesian3.fromDegrees(lons[c], lats[r], baseAlt),
              Cesium.Cartesian3.fromDegrees(lons[c], lats[r], topAlt),
            ],
            width: 1.0,
            material: pillarMat,
          });
        }
      }
    }

    this.viewer.scene.primitives.add(polylineCollection);

    const primitives: Cesium.Primitive[] = [];
    const colsCount = lons.length - 1;
    const rowsCount = lats.length - 1;

    if (
      (style === 'translucent-volume' || style === 'hybrid' || style === '2d-plane') &&
      colsCount * rowsCount <= 2000
    ) {
      const boxGeo = getUnitBoxGeometry();
      const fillInstances: Cesium.GeometryInstance[] = [];
      const volLayerLimit = is2DOnly
        ? 1
        : colsCount * rowsCount <= 550
          ? layerCount
          : 1;
      const fillAlpha = is2DOnly ? 0.05 : style === 'hybrid' ? 0.08 : 0.065;
      const fillColor = Cesium.Color.fromCssColorString('#38bdf8').withAlpha(fillAlpha);

      for (let lk = 0; lk < volLayerLimit; lk++) {
        const minH = layerAlts[lk];
        const maxH = is2DOnly ? baseAlt + 0.01 : layerAlts[lk + 1];
        const midH = (minH + maxH) * 0.5;

        for (let r = 0; r < rowsCount; r++) {
          for (let c = 0; c < colsCount; c++) {
            const cMinLon = lons[c];
            const cMaxLon = lons[c + 1];
            const cMinLat = lats[r];
            const cMaxLat = lats[r + 1];
            const cLon = (cMinLon + cMaxLon) * 0.5;
            const cLat = (cMinLat + cMaxLat) * 0.5;
            const code2D = encode2D(cLat, cLon, level);
            const cellObj: BeidouVoxelCell = {
              id: `vp#${code2D}#Z${lk}`,
              code2D,
              code3D: encode3D(cLat, cLon, midH, level),
              level,
              minLon: cMinLon,
              maxLon: cMaxLon,
              minLat: cMinLat,
              maxLat: cMaxLat,
              minHeight: minH,
              maxHeight: maxH,
              centerLon: cLon,
              centerLat: cLat,
              centerHeight: midH,
              category: 'local-airspace',
            };

            fillInstances.push(
              new Cesium.GeometryInstance({
                geometry: boxGeo,
                modelMatrix: computeCellEnuModelMatrix(cellObj, is2DOnly, baseAlt),
                id: cellObj,
                attributes: {
                  color: Cesium.ColorGeometryInstanceAttribute.fromColor(fillColor),
                },
              }),
            );
          }
        }
      }

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
    }

    let labels: Cesium.LabelCollection | null = null;
    if (options?.showLabels !== false) {
      labels = new Cesium.LabelCollection({ scene: this.viewer.scene });
      const canvas = this.viewer.scene.canvas;
      const viewW = canvas.clientWidth || 1280;
      const viewH = canvas.clientHeight || 720;
      const labelAlt = baseAlt + Math.max(0.002, camH * 0.003);
      const labelBg = Cesium.Color.fromCssColorString('#040a18').withAlpha(0.68);

      interface LabelCandidate {
        pos: Cesium.Cartesian3;
        text: string;
        sx: number;
        sy: number;
        halfW: number;
        halfH: number;
        distCenter: number;
      }

      const candidates: LabelCandidate[] = [];

      for (let r = 0; r < rowsCount; r++) {
        for (let c = 0; c < colsCount; c++) {
          const cMinLon = lons[c];
          const cMaxLon = lons[c + 1];
          const cMinLat = lats[r];
          const cMaxLat = lats[r + 1];
          const cLon = (cMinLon + cMaxLon) * 0.5;
          const cLat = (cMinLat + cMaxLat) * 0.5;

          const worldPos = Cesium.Cartesian3.fromDegrees(cLon, cLat, labelAlt);
          const screenPos = Cesium.SceneTransforms.worldToWindowCoordinates(
            this.viewer.scene,
            worldPos,
          );
          if (
            !screenPos ||
            screenPos.x < 18 ||
            screenPos.x > viewW - 18 ||
            screenPos.y < 18 ||
            screenPos.y > viewH - 18
          ) {
            continue;
          }

          // 检查当前格子两个正交方向在屏幕上的像素跨度，适配任意航向角与斜视角
          const eastPos = Cesium.Cartesian3.fromDegrees(cMaxLon, cLat, labelAlt);
          const northPos = Cesium.Cartesian3.fromDegrees(cLon, cMaxLat, labelAlt);
          const eastScreen = Cesium.SceneTransforms.worldToWindowCoordinates(
            this.viewer.scene,
            eastPos,
          );
          const northScreen = Cesium.SceneTransforms.worldToWindowCoordinates(
            this.viewer.scene,
            northPos,
          );
          const eastHalfPx = eastScreen
            ? Math.hypot(eastScreen.x - screenPos.x, eastScreen.y - screenPos.y)
            : 20;
          const northHalfPx = northScreen
            ? Math.hypot(northScreen.x - screenPos.x, northScreen.y - screenPos.y)
            : 20;
          const maxSpanHalfPx = Math.max(eastHalfPx, northHalfPx);
          const minSpanHalfPx = Math.min(eastHalfPx, northHalfPx);
          if (maxSpanHalfPx < 11 || minSpanHalfPx < 3.5) continue;

          const rawCode = encode2D(cLat, cLon, level);
          let displayText = rawCode;
          let maxLineLen = rawCode.length;
          let lineCount = 1;

          // L7-L10 长编码双行居中折行，宽度减半，避免横向文本挤压重叠
          if (level >= 7 && rawCode.length > 11) {
            const mid = Math.ceil(rawCode.length / 2);
            const topPart = rawCode.slice(0, mid);
            const bottomPart = rawCode.slice(mid);
            displayText = `${topPart}\n${bottomPart}`;
            maxLineLen = Math.max(topPart.length, bottomPart.length);
            lineCount = 2;
          }

          const halfW = (maxLineLen * 6.4 + 12) * 0.5 + 4;
          const halfH = (lineCount * 13 + 6) * 0.5 + 3;
          // 优先标注近景与视口地面重心区域（不受仰视天空上半区偏向影响）
          const distCenter = Math.hypot(screenPos.x - viewW * 0.5, screenPos.y - viewH * 0.66);

          candidates.push({
            pos: worldPos,
            text: displayText,
            sx: screenPos.x,
            sy: screenPos.y,
            halfW,
            halfH,
            distCenter,
          });
        }
      }

      // 优先保留视口中心附近清晰标注，屏幕空间包围盒防碰撞剔除
      candidates.sort((a, b) => a.distCenter - b.distCenter);
      const placed: Array<{ minX: number; maxX: number; minY: number; maxY: number }> = [];

      for (const item of candidates) {
        const minX = item.sx - item.halfW;
        const maxX = item.sx + item.halfW;
        const minY = item.sy - item.halfH;
        const maxY = item.sy + item.halfH;

        let overlaps = false;
        for (let k = 0; k < placed.length; k++) {
          const p = placed[k];
          if (!(maxX < p.minX || minX > p.maxX || maxY < p.minY || minY > p.maxY)) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;

        placed.push({ minX, maxX, minY, maxY });
        labels.add({
          position: item.pos,
          text: item.text,
          font: '600 10.5px Consolas, monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          showBackground: true,
          backgroundColor: labelBg,
          backgroundPadding: new Cesium.Cartesian2(5, 3),
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          disableDepthTestDistance: camH < 200_000 ? Number.POSITIVE_INFINITY : 0,
        });
      }

      this.viewer.scene.primitives.add(labels);
    }

    this.layerGroups.set(layerId, {
      primitives,
      polylines: polylineCollection,
      labels,
      entities: [],
    });

    return colsCount * rowsCount;
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
        const labelZ = is2DOnly
          ? (options?.flatBaseAltitude ?? c.minHeight) + Math.max(0.05, (c.maxHeight - c.minHeight) * 0.05)
          : c.centerHeight;
        labels.add({
          position: Cesium.Cartesian3.fromDegrees(c.centerLon, c.centerLat, labelZ),
          text: c.label ?? (style === '2d-plane' ? c.code2D : c.code3D),
          font: '600 11px Consolas, monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          scaleByDistance: new Cesium.NearFarScalar(5, 1.0, 3_000_000, 0.68),
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
