import * as Cesium from "cesium";
import type {
  BeidouVoxelCell,
  BuildingFootprint,
  GridCellCategory,
  GridLayerStyle,
  GridLevel,
  Wgs84Point,
} from "../types/beidou";
import {
  decode2D,
  encode2D,
  encode3D,
  getHeightResolution,
  getLevelSpec,
} from "./BeidouGridCode";
import type {
  ConformalFacadeColumn,
  MassiveGroundGridSpec,
  MassiveVoxelRenderPlan,
} from "./MassiveVoxelEngine";
import {
  buildChunkGeometryPayload,
  buildGlobalShellLineBuffers,
  buildGroundLineBuffer,
  buildViewportGridLineBuffers,
  computeEnuBoxModelMatrix,
  createRuntimeTriangleLookup,
  type ChunkGeometryPayload,
  type CompactGroundGridInput,
  type CompactTrianglePool,
  type LineGeometryBuffers,
  type RuntimeTriangleLookup,
} from "./VoxelBufferBuilder";
import type {
  WorkerBuildChunkRequest,
  WorkerBuildChunkResponse,
  WorkerInitTrianglesRequest,
} from "./MassiveVoxelWorker";

const CATEGORY_STYLE: Record<
  GridCellCategory,
  { fill: Cesium.Color; outline: Cesium.Color }
> = {
  "global-shell": {
    fill: Cesium.Color.fromCssColorString("#38bdf8").withAlpha(0.08),
    outline: Cesium.Color.WHITE.withAlpha(0.75),
  },
  "local-airspace": {
    fill: Cesium.Color.fromCssColorString("#38bdf8").withAlpha(0.12),
    outline: Cesium.Color.WHITE.withAlpha(0.78),
  },
  "airspace-free": {
    fill: Cesium.Color.fromCssColorString("#94a3b8").withAlpha(0.05),
    outline: Cesium.Color.WHITE.withAlpha(0.32),
  },
  "building-obstacle": {
    fill: Cesium.Color.fromCssColorString("#dc2626").withAlpha(0.38),
    outline: Cesium.Color.WHITE.withAlpha(0.88),
  },
  "obstacle-buffer": {
    fill: Cesium.Color.fromCssColorString("#f59e0b").withAlpha(0.18),
    outline: Cesium.Color.fromCssColorString("#fde68a").withAlpha(0.65),
  },
  "flight-corridor": {
    fill: Cesium.Color.fromCssColorString("#06b6d4").withAlpha(0.28),
    outline: Cesium.Color.fromCssColorString("#67e8f9").withAlpha(0.92),
  },
  "flight-conflict": {
    fill: Cesium.Color.fromCssColorString("#ff1e42").withAlpha(0.68),
    outline: Cesium.Color.YELLOW.withAlpha(0.98),
  },
  "flight-detour": {
    fill: Cesium.Color.fromCssColorString("#10b981").withAlpha(0.32),
    outline: Cesium.Color.fromCssColorString("#6ee7b7").withAlpha(0.95),
  },
  "query-highlight": {
    fill: Cesium.Color.fromCssColorString("#3b82f6").withAlpha(0.35),
    outline: Cesium.Color.fromCssColorString("#93c5fd").withAlpha(0.98),
  },
  "conformal-ground": {
    fill: Cesium.Color.fromCssColorString("#14b8a6").withAlpha(0.08),
    outline: Cesium.Color.fromCssColorString("#e0f2fe").withAlpha(0.55),
  },
  "conformal-low": {
    fill: Cesium.Color.fromCssColorString("#38bdf8").withAlpha(0.18),
    outline: Cesium.Color.fromCssColorString("#f8fafc").withAlpha(0.68),
  },
  "conformal-mid": {
    fill: Cesium.Color.fromCssColorString("#10b981").withAlpha(0.22),
    outline: Cesium.Color.fromCssColorString("#d1fae5").withAlpha(0.75),
  },
  "conformal-high": {
    fill: Cesium.Color.fromCssColorString("#f59e0b").withAlpha(0.26),
    outline: Cesium.Color.fromCssColorString("#fef08a").withAlpha(0.82),
  },
  "conformal-super": {
    fill: Cesium.Color.fromCssColorString("#f43f5e").withAlpha(0.32),
    outline: Cesium.Color.fromCssColorString("#fecdd3").withAlpha(0.88),
  },
};

// 全局复用单元立方体几何，单次 Draw Call 渲染数千体元
let sharedUnitBoxGeometry: Cesium.BoxGeometry | null = null;
let sharedFlatUnitBoxGeometry: Cesium.BoxGeometry | null = null;
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

function getFlatUnitBoxGeometry(): Cesium.BoxGeometry {
  if (!sharedFlatUnitBoxGeometry) {
    sharedFlatUnitBoxGeometry = Cesium.BoxGeometry.fromDimensions({
      dimensions: new Cesium.Cartesian3(1, 1, 1),
      vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
    });
  }
  return sharedFlatUnitBoxGeometry;
}

const cachedCategoryFillAttrs = new Map<
  GridCellCategory,
  Cesium.ColorGeometryInstanceAttribute
>();

function getCategoryFillAttr(
  category: GridCellCategory,
): Cesium.ColorGeometryInstanceAttribute {
  let attr = cachedCategoryFillAttrs.get(category);
  if (!attr) {
    const style = CATEGORY_STYLE[category] ?? CATEGORY_STYLE["conformal-low"];
    attr = Cesium.ColorGeometryInstanceAttribute.fromColor(style.fill);
    cachedCategoryFillAttrs.set(category, attr);
  }
  return attr;
}

function buildLineGeometryFromBuffers(
  buffers: LineGeometryBuffers,
): Cesium.Geometry {
  const attrs = new Cesium.GeometryAttributes();
  attrs.position = new Cesium.GeometryAttribute({
    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
    componentsPerAttribute: 3,
    values: buffers.positions,
  });
  return new Cesium.Geometry({
    attributes: attrs,
    indices: buffers.indices,
    primitiveType: Cesium.PrimitiveType.LINES,
    boundingSphere: new Cesium.BoundingSphere(
      new Cesium.Cartesian3(
        buffers.boundingCenter[0],
        buffers.boundingCenter[1],
        buffers.boundingCenter[2],
      ),
      buffers.boundingRadius,
    ),
  });
}

function getUnitBoxOutlineGeometry(): Cesium.BoxOutlineGeometry {
  if (!sharedUnitBoxOutlineGeometry) {
    sharedUnitBoxOutlineGeometry = Cesium.BoxOutlineGeometry.fromDimensions({
      dimensions: new Cesium.Cartesian3(1, 1, 1),
    });
  }
  return sharedUnitBoxOutlineGeometry;
}

const DEG_TO_RAD = Math.PI / 180;
const scratchCenter = new Cesium.Cartesian3();
const scratchScale = new Cesium.Cartesian3();
const scratchEnu = new Cesium.Matrix4();

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

  Cesium.Cartesian3.fromDegrees(
    cell.centerLon,
    cell.centerLat,
    centerH,
    Cesium.Ellipsoid.WGS84,
    scratchCenter,
  );
  Cesium.Transforms.eastNorthUpToFixedFrame(
    scratchCenter,
    Cesium.Ellipsoid.WGS84,
    scratchEnu,
  );

  // 使用 WGS84 子午圈曲率半径 M 与卯酉圈曲率半径 N 解析估算网格宽高，消除每体元 4 次 geodesics 三角计算
  const latRad = cell.centerLat * DEG_TO_RAD;
  const sinLat = Math.sin(latRad);
  const denom = Math.sqrt(1 - 0.00669437999014 * sinLat * sinLat);
  const N = 6378137.0 / denom;
  const M = 6335439.327292469 / (denom * denom * denom);

  scratchScale.x = Math.max(
    0.004,
    (cell.maxLon - cell.minLon) *
      DEG_TO_RAD *
      N *
      Math.max(0.05, Math.cos(latRad)),
  );
  scratchScale.y = Math.max(
    0.004,
    (cell.maxLat - cell.minLat) * DEG_TO_RAD * M,
  );
  scratchScale.z = height;

  return Cesium.Matrix4.multiplyByScale(
    scratchEnu,
    scratchScale,
    new Cesium.Matrix4(),
  );
}

export interface ManagedLayerHandles {
  primitives: Cesium.Primitive[];
  polylines: Cesium.PolylineCollection | null;
  labels: Cesium.LabelCollection | null;
  entities: Cesium.Entity[];
}

const GLOBAL_SHELL_LAYER_ID = "global-shell-grid";
const L1_SCALE_BY_DISTANCE = new Cesium.NearFarScalar(2_000_000, 1.0, 24_000_000, 0.55);
const L1_TRANSLUCENCY_BY_DISTANCE = new Cesium.NearFarScalar(
  8_000_000,
  1.0,
  17_800_000,
  0.08,
);
const VIEWPORT_LABEL_PADDING = new Cesium.Cartesian2(5, 3);
const scratchWorldEast = new Cesium.Cartesian3();
const scratchWorldNorth = new Cesium.Cartesian3();
const scratchToCam = new Cesium.Cartesian3();
const scratchFillMatrixArr = new Float64Array(16);

const cachedLocalFillAttrs = new Map<string, Cesium.ColorGeometryInstanceAttribute>();
function getLocalFillColorAttr(
  key: string,
  color: Cesium.Color,
): Cesium.ColorGeometryInstanceAttribute {
  let attr = cachedLocalFillAttrs.get(key);
  if (!attr) {
    attr = Cesium.ColorGeometryInstanceAttribute.fromColor(color);
    cachedLocalFillAttrs.set(key, attr);
  }
  return attr;
}

/**
 * Cesium 多模式北斗网格批量图元渲染管理器
 * 支持 2D平面 / 3D立体线框 / 半透明体积 / 混合融合 四种图层模式及全球球壳立体网格
 */
export class GridLayerManager {
  private viewer: Cesium.Viewer;
  private layerGroups = new Map<string, ManagedLayerHandles>();

  // 1.1 全球球壳持久化缓存（转动/缩放地球 0 几何重建 + 正面半球限流标注）
  private globalShellCache = new Map<
    string,
    { primitive: Cesium.Primitive; cellCount: number }
  >();
  private globalShellCandidates = new Map<
    string,
    Array<{ code: string; ecef: Cesium.Cartesian3; normal: Cesium.Cartesian3 }>
  >();
  private globalShellLabelCollection: Cesium.LabelCollection | null = null;
  private globalShellLastLabelSig = "";
  private globalShellActiveCacheKey = "";

  // 244Hz 宏块持久化 Primitive 对象池 + Web Worker 异步管线
  private voxelWorker: Worker | null = null;
  private voxelWorkerInitAttempted = false;
  private workerNextJobId = 1;
  private workerPendingJobs = new Map<
    number,
    { kind: "chunk" | "fine"; chunkKey: string; seq: number }
  >();
  private chunkCache = new Map<
    string,
    { key: string; primitives: Cesium.Primitive[]; lastUsedSeq: number }
  >();
  private activeChunkKeys = new Set<string>();
  private pendingChunkKeys = new Set<string>();
  private latestWantedChunkKeys = new Set<string>();
  private readyChunkQueue: ChunkGeometryPayload[] = [];
  private pumpRafId: number | null = null;
  private massiveLayerId = "futian-massive-voxels";
  private massiveLayerActive = false;
  private massivePlanSeq = 0;
  private latestFineDispatchedSeq = 0;
  private finePrimitives: Cesium.Primitive[] = [];
  private groundPrimitive: Cesium.Primitive | null = null;
  private lastGroundKey = "";
  private syncedTriPool: CompactTrianglePool | null = null;
  private cachedTriLookup: RuntimeTriangleLookup | null = null;
  private fineMetricsCallback: ((occupiedCols: number) => void) | null = null;

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
  }

  private hideGlobalShell(): void {
    for (const entry of this.globalShellCache.values()) {
      entry.primitive.show = false;
    }
    if (this.globalShellLabelCollection) {
      this.globalShellLabelCollection.show = false;
    }
  }

  private createIndexedLinesPrimitive(
    parts: Array<{ buffers: LineGeometryBuffers | null; color: Cesium.Color }>,
    show = true,
  ): Cesium.Primitive | null {
    if (this.viewer.isDestroyed()) return null;
    const instances: Cesium.GeometryInstance[] = [];
    for (const part of parts) {
      if (!part.buffers) continue;
      instances.push(
        new Cesium.GeometryInstance({
          geometry: buildLineGeometryFromBuffers(part.buffers),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(part.color),
          },
        }),
      );
    }
    if (instances.length === 0) return null;
    const prim = new Cesium.Primitive({
      geometryInstances: instances,
      appearance: new Cesium.PerInstanceColorAppearance({
        flat: true,
        translucent: true,
        renderState: {
          depthTest: { enabled: true },
          depthMask: false,
        },
      }),
      show,
      asynchronous: false,
      allowPicking: false,
      interleave: true,
      releaseGeometryInstances: true,
    });
    this.viewer.scene.primitives.add(prim);
    return prim;
  }

  clearLayer(layerId: string): void {
    if (layerId === this.massiveLayerId) {
      this.hideMassiveVoxelPool();
    }
    if (layerId === GLOBAL_SHELL_LAYER_ID) {
      this.hideGlobalShell();
    }
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
    this.destroyMassiveVoxelPool();
    for (const entry of this.globalShellCache.values()) {
      try {
        if (!this.viewer.isDestroyed()) {
          this.viewer.scene.primitives.remove(entry.primitive);
        }
      } catch {
        // ignore
      }
    }
    this.globalShellCache.clear();
    this.globalShellCandidates.clear();
    if (this.globalShellLabelCollection) {
      try {
        if (!this.viewer.isDestroyed()) {
          this.viewer.scene.primitives.remove(this.globalShellLabelCollection);
        }
      } catch {
        // ignore
      }
      this.globalShellLabelCollection = null;
    }
    this.globalShellLastLabelSig = "";
    this.globalShellActiveCacheKey = "";
    for (const id of Array.from(this.layerGroups.keys())) {
      this.clearLayer(id);
    }
  }

  /**
   * 渲染全球/大范围立体多层北斗球壳网格（静态 Indexed LINES 缓存 + 正面半球防重叠限流标注）
   * 转动/缩放地球时不重建底层 3D 球壳，仅对朝向相机的可见区抽样最多 96 个不重叠编码标注
   */
  renderGlobalShellGrid(
    layerId: string,
    level: GridLevel,
    options?: {
      shellAltitudes?: number[];
      showLabels?: boolean;
      roi?: { minLon: number; maxLon: number; minLat: number; maxLat: number };
      layerStyle?: GridLayerStyle;
      deferLabels?: boolean;
    },
  ): number {
    if (this.viewer.isDestroyed()) return 0;

    const spec = getLevelSpec(level);
    const altitudes = options?.shellAltitudes ?? [
      15_000, 320_000, 640_000, 960_000,
    ];
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
      options?.layerStyle === "2d-plane" ? [baseAlt] : altitudes;
    const activeTopAlt = layerAlts[layerAlts.length - 1];
    const cellCount =
      Math.round((maxLon - minLon) / stepLon) *
      Math.round((maxLat - minLat) / stepLat);

    const cacheKey = `${layerId}|${level}|${options?.layerStyle ?? "3d"}|${layerAlts.join(",")}|${minLon.toFixed(2)},${maxLon.toFixed(2)},${minLat.toFixed(2)},${maxLat.toFixed(2)}|${stepLon.toFixed(3)},${stepLat.toFixed(3)}`;

    if (layerId !== GLOBAL_SHELL_LAYER_ID) {
      this.clearLayer(layerId);
      const buffers = buildGlobalShellLineBuffers({
        minLon,
        maxLon,
        minLat,
        maxLat,
        stepLon,
        stepLat,
        layerAlts,
        arcStepDeg: 3,
      });
      const prim = this.createIndexedLinesPrimitive(
        [
          { buffers: buffers.innerLines, color: Cesium.Color.WHITE.withAlpha(0.34) },
          { buffers: buffers.outerLines, color: Cesium.Color.WHITE.withAlpha(0.72) },
          { buffers: buffers.pillarLines, color: Cesium.Color.WHITE.withAlpha(0.24) },
        ],
        true,
      );
      this.layerGroups.set(layerId, {
        primitives: prim ? [prim] : [],
        polylines: null,
        labels: null,
        entities: [],
      });
      return cellCount;
    }

    let cached = this.globalShellCache.get(cacheKey);
    if (!cached) {
      const buffers = buildGlobalShellLineBuffers({
        minLon,
        maxLon,
        minLat,
        maxLat,
        stepLon,
        stepLat,
        layerAlts,
        arcStepDeg: 3,
      });
      const prim = this.createIndexedLinesPrimitive(
        [
          { buffers: buffers.innerLines, color: Cesium.Color.WHITE.withAlpha(0.34) },
          { buffers: buffers.outerLines, color: Cesium.Color.WHITE.withAlpha(0.72) },
          { buffers: buffers.pillarLines, color: Cesium.Color.WHITE.withAlpha(0.24) },
        ],
        true,
      );
      if (prim) {
        cached = { primitive: prim, cellCount };
        this.globalShellCache.set(cacheKey, cached);
      }
    }

    for (const [k, entry] of this.globalShellCache.entries()) {
      entry.primitive.show = k === cacheKey;
    }

    if (options?.showLabels === false) {
      if (this.globalShellLabelCollection) {
        this.globalShellLabelCollection.show = false;
      }
      return cached?.cellCount ?? cellCount;
    }

    if (!this.globalShellLabelCollection) {
      this.globalShellLabelCollection = new Cesium.LabelCollection({
        scene: this.viewer.scene,
      });
      this.viewer.scene.primitives.add(this.globalShellLabelCollection);
    }
    this.globalShellLabelCollection.show = true;

    if (
      options?.deferLabels &&
      this.globalShellActiveCacheKey === cacheKey &&
      this.globalShellLabelCollection.length > 0
    ) {
      return cached?.cellCount ?? cellCount;
    }

    const camCarto = this.viewer.camera.positionCartographic;
    const camSig = `${cacheKey}|${Math.round(Cesium.Math.toDegrees(camCarto.longitude) * 0.5)}|${Math.round(Cesium.Math.toDegrees(camCarto.latitude) * 0.5)}|${Math.round(Math.log10(Math.max(1000, camCarto.height)) * 12)}|${Math.round(Cesium.Math.toDegrees(this.viewer.camera.heading) / 10)}|${Math.round(Cesium.Math.toDegrees(this.viewer.camera.pitch) / 10)}`;

    if (
      this.globalShellLastLabelSig === camSig &&
      this.globalShellActiveCacheKey === cacheKey &&
      this.globalShellLabelCollection.length > 0
    ) {
      return cached?.cellCount ?? cellCount;
    }

    this.globalShellLastLabelSig = camSig;
    this.globalShellActiveCacheKey = cacheKey;

    let candidates = this.globalShellCandidates.get(cacheKey);
    if (!candidates) {
      candidates = [];
      const latStart = Math.max(-88, minLat);
      const latEnd = Math.min(88, maxLat);
      const labelElev = (options?.layerStyle === "2d-plane" ? activeTopAlt : topAlt) + 15_000;
      for (let lat = latStart + stepLat * 0.5; lat < latEnd; lat += stepLat) {
        for (let lon = minLon + stepLon * 0.5; lon < maxLon; lon += stepLon) {
          if (lon >= 179.99 || lon <= -179.99 || Math.abs(lat) > 87.9) continue;
          const ecef = Cesium.Cartesian3.fromDegrees(lon, lat, labelElev);
          const normal = Cesium.Cartesian3.normalize(ecef, new Cesium.Cartesian3());
          candidates.push({
            code: encode2D(lat, lon, level),
            ecef,
            normal,
          });
        }
      }
      this.globalShellCandidates.set(cacheKey, candidates);
    }

    const camPos = this.viewer.camera.positionWC;
    const canvas = this.viewer.scene.canvas;
    const viewW = canvas.clientWidth || 1280;
    const viewH = canvas.clientHeight || 720;

    interface VisibleL1Candidate {
      code: string;
      ecef: Cesium.Cartesian3;
      sx: number;
      sy: number;
      distCenter: number;
    }

    const visible: VisibleL1Candidate[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      Cesium.Cartesian3.subtract(camPos, c.ecef, scratchToCam);
      const dist = Cesium.Cartesian3.magnitude(scratchToCam);
      if (dist <= 1) continue;
      const dot = Cesium.Cartesian3.dot(scratchToCam, c.normal);
      // 剔除背对相机与地平线擦边单元（~60% 背半球在投影前 0 开销丢弃）
      if (dot <= dist * 0.14) continue;

      const screenPos = Cesium.SceneTransforms.worldToWindowCoordinates(
        this.viewer.scene,
        c.ecef,
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

      visible.push({
        code: c.code,
        ecef: c.ecef,
        sx: screenPos.x,
        sy: screenPos.y,
        distCenter: Math.hypot(screenPos.x - viewW * 0.5, screenPos.y - viewH * 0.5),
      });
    }

    visible.sort((a, b) => a.distCenter - b.distCenter);

    this.globalShellLabelCollection.removeAll();
    const placed: Array<{ minX: number; maxX: number; minY: number; maxY: number }> = [];
    const MAX_L1_LABELS = 96;

    for (let i = 0; i < visible.length && placed.length < MAX_L1_LABELS; i++) {
      const item = visible[i];
      const halfW = (item.code.length * 6.5 + 10) * 0.5 + 4;
      const halfH = 11;
      const minX = item.sx - halfW;
      const maxX = item.sx + halfW;
      const minY = item.sy - halfH;
      const maxY = item.sy + halfH;

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
      this.globalShellLabelCollection.add({
        position: item.ecef,
        text: item.code,
        font: '600 11px Consolas, "Microsoft YaHei", monospace',
        fillColor: Cesium.Color.WHITE.withAlpha(0.96),
        outlineColor: Cesium.Color.BLACK.withAlpha(0.92),
        outlineWidth: 2,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        scaleByDistance: L1_SCALE_BY_DISTANCE,
        translucencyByDistance: L1_TRANSLUCENCY_BY_DISTANCE,
      });
    }

    return cached?.cellCount ?? cellCount;
  }

  /**
   * L2-L10 视口自适应北斗网格渲染：
   * 1. 按当前相机视口地理范围满屏铺开且严格对齐北斗网格边界
   * 2. 使用单批原生 Indexed LINES Primitive（1 次 Draw Call）消除 PolylineCollection 动态打包卡顿
   * 3. 滚轮/拖动期间延迟标签投影与多层填充合批，静止后补齐 <= 48 个清晰无重叠标注
   */
  renderViewportGrid(
    layerId: string,
    bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number },
    level: GridLevel,
    options?: {
      layerStyle?: GridLayerStyle;
      showLabels?: boolean;
      cameraHeightMeters?: number;
      deferLabels?: boolean;
      isInteracting?: boolean;
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
    const rawStride = Math.max(
      1,
      Math.ceil(Math.max(nativeCols / 76, nativeRows / 60)),
    );
    let stride = 1;
    while (stride < rawStride) stride *= 2;

    const stepLon = spec.lonDeg * stride;
    const stepLat = spec.latDeg * stride;

    // 对齐全球固定 stepLon / stepLat 网格索引，避免斜视/平移时网格线抖动
    const snapMinLon = Math.max(
      -180,
      Math.floor(first.minLon / stepLon) * stepLon,
    );
    const snapMaxLon = Math.min(
      180,
      Math.ceil(last.maxLon / stepLon) * stepLon,
    );
    const snapMinLat = Math.max(
      -85,
      Math.floor(first.minLat / stepLat) * stepLat,
    );
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

    const style = options?.layerStyle ?? "3d-wireframe";
    const camH = Math.max(0.08, options?.cameraHeightMeters ?? 1000);
    const baseAlt =
      camH > 20_000 ? 80 : camH > 500 ? 1.5 : Math.max(0.004, camH * 0.008);
    const heightRes = getHeightResolution(level);
    const layerCount = 3;
    const layerStep = Math.min(heightRes, Math.max(0.006, camH * 0.13));
    const layerAlts =
      style === "2d-plane"
        ? [baseAlt]
        : Array.from({ length: layerCount + 1 }, (_, k) => baseAlt + k * layerStep);

    const is2DOnly = style === "2d-plane";
    const arcSubdiv = stepLon > 0.35 ? 6 : 1;
    const pillarStep = lats.length * lons.length > 1800 ? 2 : 1;

    const lineBuffers = buildViewportGridLineBuffers({
      lons,
      lats,
      layerAlts,
      arcSubdiv,
      includePillars: !is2DOnly,
      pillarStep,
    });

    const lineParts: Array<{ buffers: LineGeometryBuffers | null; color: Cesium.Color }> = [
      {
        buffers: lineBuffers.baseLines,
        color: Cesium.Color.fromCssColorString("#e0f2fe").withAlpha(
          is2DOnly ? 0.85 : 0.78,
        ),
      },
    ];
    if (!is2DOnly) {
      lineParts.push(
        {
          buffers: lineBuffers.midLines,
          color: Cesium.Color.fromCssColorString("#7dd3fc").withAlpha(0.36),
        },
        {
          buffers: lineBuffers.topLines,
          color: Cesium.Color.fromCssColorString("#bae6fd").withAlpha(0.62),
        },
        {
          buffers: lineBuffers.pillarLines,
          color: Cesium.Color.WHITE.withAlpha(0.24),
        },
      );
    }

    const primitives: Cesium.Primitive[] = [];
    const linesPrim = this.createIndexedLinesPrimitive(lineParts, true);
    if (linesPrim) primitives.push(linesPrim);

    const colsCount = lons.length - 1;
    const rowsCount = lats.length - 1;

    if (
      (style === "translucent-volume" ||
        style === "hybrid" ||
        style === "2d-plane") &&
      colsCount * rowsCount <= 1200
    ) {
      const flatBoxGeo = getFlatUnitBoxGeometry();
      const fillInstances: Cesium.GeometryInstance[] = [];
      const volLayerLimit =
        is2DOnly || options?.isInteracting
          ? 1
          : colsCount * rowsCount <= 350
            ? layerCount
            : 1;
      const fillAlpha = is2DOnly ? 0.05 : style === "hybrid" ? 0.08 : 0.065;
      const fillAttr = getLocalFillColorAttr(
        `local_${style}`,
        Cesium.Color.fromCssColorString("#38bdf8").withAlpha(fillAlpha),
      );

      for (let lk = 0; lk < volLayerLimit; lk++) {
        const minH = layerAlts[lk];
        const maxH = is2DOnly ? baseAlt + 0.01 : layerAlts[lk + 1];
        const midH = (minH + maxH) * 0.5;
        const boxMinH = is2DOnly ? baseAlt : minH;
        const boxMaxH = is2DOnly ? baseAlt + 0.25 : maxH;

        for (let r = 0; r < rowsCount; r++) {
          const cMinLat = lats[r];
          const cMaxLat = lats[r + 1];
          const cLat = (cMinLat + cMaxLat) * 0.5;
          for (let c = 0; c < colsCount; c++) {
            const cMinLon = lons[c];
            const cMaxLon = lons[c + 1];
            const cLon = (cMinLon + cMaxLon) * 0.5;
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
              category: "local-airspace",
            };

            computeEnuBoxModelMatrix(
              cMinLon,
              cMaxLon,
              cMinLat,
              cMaxLat,
              boxMinH,
              boxMaxH,
              scratchFillMatrixArr,
              0,
            );
            fillInstances.push(
              new Cesium.GeometryInstance({
                geometry: flatBoxGeo,
                modelMatrix: Cesium.Matrix4.unpack(
                  scratchFillMatrixArr as unknown as number[],
                  0,
                  new Cesium.Matrix4(),
                ),
                id: cellObj,
                attributes: { color: fillAttr },
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
              cull: { enabled: true },
            },
          }),
          asynchronous: false,
          releaseGeometryInstances: true,
        });
        this.viewer.scene.primitives.add(fillPrimitive);
        primitives.push(fillPrimitive);
      }
    }

    let labels: Cesium.LabelCollection | null = null;
    if (options?.showLabels !== false && !options?.deferLabels) {
      labels = new Cesium.LabelCollection({ scene: this.viewer.scene });
      const canvas = this.viewer.scene.canvas;
      const viewW = canvas.clientWidth || 1280;
      const viewH = canvas.clientHeight || 720;
      const labelAlt = baseAlt + Math.max(0.002, camH * 0.003);
      const labelBg =
        Cesium.Color.fromCssColorString("#040a18").withAlpha(0.68);

      // 一次预先采样该级别编码长度，避免对被剔除候选格子重复构造北斗编码字符串
      const sampleLen = encode2D(
        (lats[0] + lats[1]) * 0.5,
        (lons[0] + lons[1]) * 0.5,
        level,
      ).length;
      const estWrappedLines = level >= 7 && sampleLen > 11 ? 2 : 1;
      const estMaxLineLen =
        estWrappedLines === 2 ? Math.ceil(sampleLen / 2) : sampleLen;
      const estHalfW = (estMaxLineLen * 6.4 + 12) * 0.5 + 4;
      const estHalfH = (estWrappedLines * 13 + 6) * 0.5 + 3;

      interface LabelCandidate {
        pos: Cesium.Cartesian3;
        cLat: number;
        cLon: number;
        sx: number;
        sy: number;
        distCenter: number;
      }

      const candidates: LabelCandidate[] = [];
      // 抽样预裁剪：最多投影 ~180 个候选格，配合 48 个屏幕标注上限降低 CPU 投影开销
      const labelStride = Math.max(
        1,
        Math.floor(Math.sqrt((rowsCount * colsCount) / 180)),
      );

      for (let r = 0; r < rowsCount; r += labelStride) {
        const cMinLat = lats[r];
        const cMaxLat = lats[r + 1];
        const cLat = (cMinLat + cMaxLat) * 0.5;
        for (let c = 0; c < colsCount; c += labelStride) {
          const cMinLon = lons[c];
          const cMaxLon = lons[c + 1];
          const cLon = (cMinLon + cMaxLon) * 0.5;

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

          Cesium.Cartesian3.fromDegrees(
            cMaxLon,
            cLat,
            labelAlt,
            Cesium.Ellipsoid.WGS84,
            scratchWorldEast,
          );
          Cesium.Cartesian3.fromDegrees(
            cLon,
            cMaxLat,
            labelAlt,
            Cesium.Ellipsoid.WGS84,
            scratchWorldNorth,
          );
          const eastScreen = Cesium.SceneTransforms.worldToWindowCoordinates(
            this.viewer.scene,
            scratchWorldEast,
          );
          const northScreen = Cesium.SceneTransforms.worldToWindowCoordinates(
            this.viewer.scene,
            scratchWorldNorth,
          );
          const eastHalfPx = eastScreen
            ? Math.hypot(eastScreen.x - screenPos.x, eastScreen.y - screenPos.y)
            : 20;
          const northHalfPx = northScreen
            ? Math.hypot(
                northScreen.x - screenPos.x,
                northScreen.y - screenPos.y,
              )
            : 20;
          const maxSpanHalfPx = Math.max(eastHalfPx, northHalfPx);
          const minSpanHalfPx = Math.min(eastHalfPx, northHalfPx);
          if (maxSpanHalfPx < 11 || minSpanHalfPx < 3.5) continue;

          candidates.push({
            pos: worldPos,
            cLat,
            cLon,
            sx: screenPos.x,
            sy: screenPos.y,
            distCenter: Math.hypot(
              screenPos.x - viewW * 0.5,
              screenPos.y - viewH * 0.66,
            ),
          });
        }
      }

      candidates.sort((a, b) => a.distCenter - b.distCenter);
      const placed: Array<{
        minX: number;
        maxX: number;
        minY: number;
        maxY: number;
      }> = [];
      const MAX_VIEWPORT_LABELS = 48;

      for (
        let i = 0;
        i < candidates.length && placed.length < MAX_VIEWPORT_LABELS;
        i++
      ) {
        const item = candidates[i];
        const minX = item.sx - estHalfW;
        const maxX = item.sx + estHalfW;
        const minY = item.sy - estHalfH;
        const maxY = item.sy + estHalfH;

        let overlaps = false;
        for (let k = 0; k < placed.length; k++) {
          const p = placed[k];
          if (
            !(maxX < p.minX || minX > p.maxX || maxY < p.minY || minY > p.maxY)
          ) {
            overlaps = true;
            break;
          }
        }
        if (overlaps) continue;

        placed.push({ minX, maxX, minY, maxY });
        const rawCode = encode2D(item.cLat, item.cLon, level);
        let displayText = rawCode;
        if (level >= 7 && rawCode.length > 11) {
          const mid = Math.ceil(rawCode.length / 2);
          displayText = `${rawCode.slice(0, mid)}\n${rawCode.slice(mid)}`;
        }

        labels.add({
          position: item.pos,
          text: displayText,
          font: "600 10.5px Consolas, monospace",
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          showBackground: true,
          backgroundColor: labelBg,
          backgroundPadding: VIEWPORT_LABEL_PADDING,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          disableDepthTestDistance:
            camH < 200_000 ? Number.POSITIVE_INFINITY : 0,
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

    return colsCount * rowsCount;
  }

  /**
   * 亿级体素高性能批处理渲染器：
   * - 共形白膜壳体模式 (`monochromeConformal`): 绘制去重后建筑共形外立面线框 + 全视口地面连续网格 (`PolylineCollection`)，叠加近乎透明的拾取包络保持白膜光影清晰可读且支持精确楼层点击查询
   * - 立体梯度/半透明模式: 合批渲染 `2,400(Fill) / 5,200(Outline)` 彩色三维体元及背面剔除
   */
  renderMassiveVoxelBatch(
    layerId: string,
    cells: BeidouVoxelCell[],
    options?: {
      monochromeConformal?: boolean;
      showFill?: boolean;
      showOutline?: boolean;
      groundGrid?: MassiveGroundGridSpec | null;
      facadeColumns?: ConformalFacadeColumn[];
    },
  ): number {
    this.clearLayer(layerId);
    if (this.viewer.isDestroyed()) return 0;
    const facadeCols = options?.facadeColumns ?? [];
    if (cells.length === 0 && facadeCols.length === 0 && !options?.groundGrid)
      return 0;

    const monochrome = options?.monochromeConformal ?? true;
    const showFill = options?.showFill ?? true;
    const showOutline = options?.showOutline ?? true;
    // 在所有样式（白膜线框、高程梯度、半透明全实体）下均用去重 Polyline 绘制从地面 0m 到屋顶的整栋水平层环+竖向立柱，杜绝“仅屋顶盖无整楼网格”
    const renderFacadeGridLines = facadeCols.length > 0 && showOutline;

    const boxGeo = getUnitBoxGeometry();
    const outlineGeo = getUnitBoxOutlineGeometry();

    const FILL_CHUNK = 2400;
    const OUTLINE_CHUNK = 5200;
    const primitives: Cesium.Primitive[] = [];

    const whiteOutlineAttr = Cesium.ColorGeometryInstanceAttribute.fromColor(
      Cesium.Color.WHITE.withAlpha(0.68),
    );
    const groundOutlineAttr = Cesium.ColorGeometryInstanceAttribute.fromColor(
      Cesium.Color.fromCssColorString("#e2e8f0").withAlpha(0.5),
    );
    // 共形线框模式下拾取体元保持极微弱透明度，完全不遮挡白膜建筑光影，仅作精准交互拾取与微弱泛光
    const monoPickFillAttr = Cesium.ColorGeometryInstanceAttribute.fromColor(
      Cesium.Color.fromCssColorString("#38bdf8").withAlpha(0.018),
    );
    const monoBuildingFillAttr =
      Cesium.ColorGeometryInstanceAttribute.fromColor(
        Cesium.Color.fromCssColorString("#38bdf8").withAlpha(0.09),
      );
    const monoGroundFillAttr = Cesium.ColorGeometryInstanceAttribute.fromColor(
      Cesium.Color.fromCssColorString("#14b8a6").withAlpha(0.07),
    );

    const cellMatrices: Cesium.Matrix4[] = new Array(cells.length);
    for (let i = 0; i < cells.length; i++) {
      cellMatrices[i] = computeCellEnuModelMatrix(cells[i], false);
    }

    if (showFill && cells.length > 0) {
      for (let start = 0; start < cells.length; start += FILL_CHUNK) {
        const end = Math.min(cells.length, start + FILL_CHUNK);
        const fillInstances: Cesium.GeometryInstance[] = new Array(end - start);

        for (let i = start; i < end; i++) {
          const cell = cells[i];
          const isGround = cell.category === "conformal-ground";
          const fillAttr =
            monochrome && renderFacadeGridLines
              ? monoPickFillAttr
              : monochrome
                ? isGround
                  ? monoGroundFillAttr
                  : monoBuildingFillAttr
                : Cesium.ColorGeometryInstanceAttribute.fromColor(
                    (
                      CATEGORY_STYLE[cell.category] ??
                      CATEGORY_STYLE["conformal-low"]
                    ).fill,
                  );

          fillInstances[i - start] = new Cesium.GeometryInstance({
            geometry: boxGeo,
            modelMatrix: cellMatrices[i],
            id: cell,
            attributes: { color: fillAttr },
          });
        }

        const fillPrim = new Cesium.Primitive({
          geometryInstances: fillInstances,
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
            renderState: {
              depthTest: { enabled: true },
              depthMask: false,
              cull: { enabled: true },
            },
          }),
          asynchronous: false,
        });
        this.viewer.scene.primitives.add(fillPrim);
        primitives.push(fillPrim);
      }
    }

    if (showOutline && cells.length > 0 && !renderFacadeGridLines) {
      for (let start = 0; start < cells.length; start += OUTLINE_CHUNK) {
        const end = Math.min(cells.length, start + OUTLINE_CHUNK);
        const outlineInstances: Cesium.GeometryInstance[] = new Array(
          end - start,
        );

        for (let i = start; i < end; i++) {
          const cell = cells[i];
          const isGround = cell.category === "conformal-ground";
          const outAttr = monochrome
            ? isGround
              ? groundOutlineAttr
              : whiteOutlineAttr
            : Cesium.ColorGeometryInstanceAttribute.fromColor(
                (
                  CATEGORY_STYLE[cell.category] ??
                  CATEGORY_STYLE["conformal-low"]
                ).outline,
              );

          outlineInstances[i - start] = new Cesium.GeometryInstance({
            geometry: outlineGeo,
            modelMatrix: cellMatrices[i],
            id: cell,
            attributes: { color: outAttr },
          });
        }

        const outlinePrim = new Cesium.Primitive({
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
        this.viewer.scene.primitives.add(outlinePrim);
        primitives.push(outlinePrim);
      }
    }

    let polylines: Cesium.PolylineCollection | null = null;
    if (
      (renderFacadeGridLines || options?.groundGrid) &&
      (showFill || showOutline)
    ) {
      polylines = new Cesium.PolylineCollection();

      if (options?.groundGrid) {
        const gg = options.groundGrid;
        const groundMat = Cesium.Material.fromType("Color", {
          color: Cesium.Color.fromCssColorString("#cce8ff").withAlpha(0.36),
        });
        const alt = gg.elevationMeters;

        for (
          let lat = gg.minLat;
          lat <= gg.maxLat + gg.stepLat * 0.1;
          lat += gg.stepLat
        ) {
          polylines.add({
            positions: [
              Cesium.Cartesian3.fromDegrees(gg.minLon, lat, alt),
              Cesium.Cartesian3.fromDegrees(gg.maxLon, lat, alt),
            ],
            width: 1.0,
            material: groundMat,
          });
        }
        for (
          let lon = gg.minLon;
          lon <= gg.maxLon + gg.stepLon * 0.1;
          lon += gg.stepLon
        ) {
          polylines.add({
            positions: [
              Cesium.Cartesian3.fromDegrees(lon, gg.minLat, alt),
              Cesium.Cartesian3.fromDegrees(lon, gg.maxLat, alt),
            ],
            width: 1.0,
            material: groundMat,
          });
        }
      }

      if (renderFacadeGridLines) {
        const facadeMat = Cesium.Material.fromType("Color", {
          color: Cesium.Color.fromCssColorString("#dff3ff").withAlpha(
            monochrome ? 0.62 : 0.68,
          ),
        });
        const roofMat = Cesium.Material.fromType("Color", {
          color: Cesium.Color.WHITE.withAlpha(monochrome ? 0.78 : 0.86),
        });

        // 竖向棱柱按格网角点去重，相邻建筑共用立柱仅绘制最高暴露区间 1 次
        const pillarMaxH = new Map<string, number>();
        const addCornerPillar = (
          lon: number,
          lat: number,
          lowH: number,
          highH: number,
        ) => {
          const key = `${Math.round(lon * 1e7)}_${Math.round(lat * 1e7)}`;
          const prevH = pillarMaxH.get(key) ?? 0;
          if (highH <= prevH + 0.02) return;
          const startH = Math.max(prevH, lowH);
          pillarMaxH.set(key, highH);
          polylines!.add({
            positions: [
              Cesium.Cartesian3.fromDegrees(lon, lat, startH),
              Cesium.Cartesian3.fromDegrees(lon, lat, highH),
            ],
            width: 1.0,
            material: facadeMat,
          });
        };

        const addRingsOnFace = (
          lon0: number,
          lat0: number,
          lon1: number,
          lat1: number,
          neighborH: number,
          roofH: number,
          stepM: number,
        ) => {
          const startFloor = Math.max(0, Math.floor(neighborH / stepM) * stepM);
          const span = Math.max(stepM, roofH - startFloor);
          const ringStride =
            Math.max(1, Math.ceil(span / (stepM * 14))) * stepM;
          for (
            let z = startFloor + ringStride;
            z < roofH - 0.01;
            z += ringStride
          ) {
            polylines!.add({
              positions: [
                Cesium.Cartesian3.fromDegrees(lon0, lat0, z),
                Cesium.Cartesian3.fromDegrees(lon1, lat1, z),
              ],
              width: 1.0,
              material: facadeMat,
            });
          }
        };

        for (let i = 0; i < facadeCols.length; i++) {
          const col = facadeCols[i];
          const top = col.roofHeight;
          const stepM = col.layerStepMeters;

          // 屋顶轮廓线：暴露边界画亮白顶线，相邻同高屋顶网格共用边仅绘制东/北避免重影
          if (col.exposedE) {
            polylines.add({
              positions: [
                Cesium.Cartesian3.fromDegrees(col.maxLon, col.minLat, top),
                Cesium.Cartesian3.fromDegrees(col.maxLon, col.maxLat, top),
              ],
              width: 1.0,
              material: roofMat,
            });
            addRingsOnFace(
              col.maxLon,
              col.minLat,
              col.maxLon,
              col.maxLat,
              col.neighborHE,
              top,
              stepM,
            );
          } else {
            polylines.add({
              positions: [
                Cesium.Cartesian3.fromDegrees(col.maxLon, col.minLat, top),
                Cesium.Cartesian3.fromDegrees(col.maxLon, col.maxLat, top),
              ],
              width: 1.0,
              material: facadeMat,
            });
          }

          if (col.exposedW) {
            polylines.add({
              positions: [
                Cesium.Cartesian3.fromDegrees(col.minLon, col.minLat, top),
                Cesium.Cartesian3.fromDegrees(col.minLon, col.maxLat, top),
              ],
              width: 1.0,
              material: roofMat,
            });
            addRingsOnFace(
              col.minLon,
              col.minLat,
              col.minLon,
              col.maxLat,
              col.neighborHW,
              top,
              stepM,
            );
          }

          if (col.exposedN) {
            polylines.add({
              positions: [
                Cesium.Cartesian3.fromDegrees(col.minLon, col.maxLat, top),
                Cesium.Cartesian3.fromDegrees(col.maxLon, col.maxLat, top),
              ],
              width: 1.0,
              material: roofMat,
            });
            addRingsOnFace(
              col.minLon,
              col.maxLat,
              col.maxLon,
              col.maxLat,
              col.neighborHN,
              top,
              stepM,
            );
          } else {
            polylines.add({
              positions: [
                Cesium.Cartesian3.fromDegrees(col.minLon, col.maxLat, top),
                Cesium.Cartesian3.fromDegrees(col.maxLon, col.maxLat, top),
              ],
              width: 1.0,
              material: facadeMat,
            });
          }

          if (col.exposedS) {
            polylines.add({
              positions: [
                Cesium.Cartesian3.fromDegrees(col.minLon, col.minLat, top),
                Cesium.Cartesian3.fromDegrees(col.maxLon, col.minLat, top),
              ],
              width: 1.0,
              material: roofMat,
            });
            addRingsOnFace(
              col.minLon,
              col.minLat,
              col.maxLon,
              col.minLat,
              col.neighborHS,
              top,
              stepM,
            );
          }

          if (col.exposedE || col.exposedS)
            addCornerPillar(col.maxLon, col.minLat, col.baseHeight, top);
          if (col.exposedE || col.exposedN)
            addCornerPillar(col.maxLon, col.maxLat, col.baseHeight, top);
          if (col.exposedW || col.exposedN)
            addCornerPillar(col.minLon, col.maxLat, col.baseHeight, top);
          if (col.exposedW || col.exposedS)
            addCornerPillar(col.minLon, col.minLat, col.baseHeight, top);
        }
      }

      this.viewer.scene.primitives.add(polylines);
    }

    this.layerGroups.set(layerId, {
      primitives,
      polylines,
      labels: null,
      entities: [],
    });

    return cells.length;
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

    const style = options?.layerStyle ?? "translucent-volume";
    const showLabels = options?.showLabels ?? false;
    const maxLabels = options?.maxLabels ?? 120;

    const boxGeo = getUnitBoxGeometry();
    const outlineGeo = getUnitBoxOutlineGeometry();

    const fillInstances: Cesium.GeometryInstance[] = [];
    const outlineInstances: Cesium.GeometryInstance[] = [];
    const groundFootprintInstances: Cesium.GeometryInstance[] = [];
    const seenFootprints = new Set<string>();

    const is2DOnly = style === "2d-plane";
    const showFill =
      style === "2d-plane" ||
      style === "translucent-volume" ||
      style === "hybrid";
    const showOutline = true;

    for (let i = 0; i < cells.length; i++) {
      const cell = cells[i];
      const palette =
        CATEGORY_STYLE[cell.category] ?? CATEGORY_STYLE["local-airspace"];
      const modelMatrix = computeCellEnuModelMatrix(
        cell,
        is2DOnly,
        options?.flatBaseAltitude,
      );

      if (showFill) {
        const fillColor =
          cell.category === "airspace-free" && style === "translucent-volume"
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
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                palette.outline,
              ),
            },
          }),
        );
      }

      if (style === "hybrid" && !seenFootprints.has(cell.code2D)) {
        seenFootprints.add(cell.code2D);
        groundFootprintInstances.push(
          new Cesium.GeometryInstance({
            geometry: boxGeo,
            modelMatrix: computeCellEnuModelMatrix(
              cell,
              true,
              options?.flatBaseAltitude ?? 1,
            ),
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
            cull: { enabled: true },
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
          ? (options?.flatBaseAltitude ?? c.minHeight) +
            Math.max(0.05, (c.maxHeight - c.minHeight) * 0.05)
          : c.centerHeight;
        labels.add({
          position: Cesium.Cartesian3.fromDegrees(
            c.centerLon,
            c.centerLat,
            labelZ,
          ),
          text: c.label ?? (style === "2d-plane" ? c.code2D : c.code3D),
          font: "600 11px Consolas, monospace",
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
          material: Cesium.Color.fromCssColorString("#1e293b").withAlpha(0.92),
          outline: true,
          outlineColor:
            Cesium.Color.fromCssColorString("#64748b").withAlpha(0.85),
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
          name: "Planned Flight Trajectory",
          polyline: {
            positions: pos,
            width: 4,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.25,
              color: isSafe
                ? Cesium.Color.fromCssColorString("#22d3ee")
                : Cesium.Color.fromCssColorString("#f43f5e"),
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
              ? Cesium.Color.fromCssColorString("#22d3ee")
              : Cesium.Color.fromCssColorString("#fb7185"),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 2,
          },
          label: {
            text: `W${idx + 1} (${Math.round(pt.height)}m)`,
            font: "600 11px sans-serif",
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
          name: "Obstacle-Free Detour Route",
          polyline: {
            positions: detourPos,
            width: 4,
            material: new Cesium.PolylineDashMaterialProperty({
              color: Cesium.Color.fromCssColorString("#34d399"),
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

  /**
   * 销毁海量体素分块缓存（在强制重建 3D Tiles 索引时调用）
   */
  invalidateMassiveChunkCache(): void {
    this.readyChunkQueue.length = 0;
    this.pendingChunkKeys.clear();
    this.activeChunkKeys.clear();
    this.latestWantedChunkKeys.clear();
    if (!this.viewer.isDestroyed()) {
      for (const entry of this.chunkCache.values()) {
        for (const prim of entry.primitives) {
          try {
            this.viewer.scene.primitives.remove(prim);
          } catch {
            // ignore
          }
        }
      }
    }
    this.chunkCache.clear();
    this.clearFinePrimitives();
    if (this.groundPrimitive && !this.viewer.isDestroyed()) {
      try {
        this.viewer.scene.primitives.remove(this.groundPrimitive);
      } catch {
        // ignore
      }
    }
    this.groundPrimitive = null;
    this.lastGroundKey = "";
    this.syncedTriPool = null;
    this.cachedTriLookup = null;
  }

  private hideMassiveVoxelPool(): void {
    this.massiveLayerActive = false;
    this.latestWantedChunkKeys.clear();
    this.readyChunkQueue.length = 0;
    if (this.pumpRafId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.pumpRafId);
      this.pumpRafId = null;
    }
    for (const key of this.activeChunkKeys) {
      const entry = this.chunkCache.get(key);
      if (!entry) continue;
      for (const prim of entry.primitives) {
        if (!prim.isDestroyed()) prim.show = false;
      }
    }
    this.activeChunkKeys.clear();
    this.clearFinePrimitives();
    if (this.groundPrimitive && !this.groundPrimitive.isDestroyed()) {
      this.groundPrimitive.show = false;
    }
  }

  private destroyMassiveVoxelPool(): void {
    this.massiveLayerActive = false;
    if (this.pumpRafId !== null && typeof window !== "undefined") {
      window.cancelAnimationFrame(this.pumpRafId);
      this.pumpRafId = null;
    }
    this.invalidateMassiveChunkCache();
    this.fineMetricsCallback = null;
    this.workerPendingJobs.clear();
    if (this.voxelWorker) {
      try {
        this.voxelWorker.terminate();
      } catch {
        // ignore
      }
      this.voxelWorker = null;
    }
    this.voxelWorkerInitAttempted = false;
  }

  private ensureVoxelWorker(): Worker | null {
    if (this.voxelWorker) return this.voxelWorker;
    if (this.voxelWorkerInitAttempted) return null;
    this.voxelWorkerInitAttempted = true;
    if (typeof Worker === "undefined") return null;

    try {
      const w = new Worker(
        new URL("./MassiveVoxelWorker.ts", import.meta.url),
        {
          type: "module",
        },
      );
      w.onmessage = (event: MessageEvent<WorkerBuildChunkResponse>) => {
        this.handleWorkerResponse(event.data);
      };
      w.onerror = () => {
        this.voxelWorker = null;
      };
      this.voxelWorker = w;
    } catch {
      this.voxelWorker = null;
    }
    return this.voxelWorker;
  }

  private handleWorkerResponse(msg: WorkerBuildChunkResponse): void {
    const job = this.workerPendingJobs.get(msg.jobId);
    if (!job) return;
    this.workerPendingJobs.delete(msg.jobId);

    if (this.viewer.isDestroyed() || !this.massiveLayerActive) {
      if (job.kind === "chunk") {
        this.pendingChunkKeys.delete(job.chunkKey);
      }
      return;
    }

    if (job.kind === "fine") {
      if (job.seq < this.latestFineDispatchedSeq) return;
      this.mountFinePayload(msg.payload);
      return;
    }

    this.pendingChunkKeys.delete(job.chunkKey);
    if (this.chunkCache.has(msg.payload.chunkKey)) return;
    if (
      !this.latestWantedChunkKeys.has(msg.payload.chunkKey) &&
      job.seq < this.massivePlanSeq - 4
    ) {
      return;
    }

    this.readyChunkQueue.push(msg.payload);
    this.scheduleChunkMountPump();
  }

  private scheduleChunkMountPump(): void {
    if (this.pumpRafId !== null) return;
    if (typeof window === "undefined") {
      this.mountReadyChunks();
      return;
    }
    this.pumpRafId = window.requestAnimationFrame(() => {
      this.pumpRafId = null;
      this.mountReadyChunks();
    });
  }

  private mountReadyChunks(): void {
    if (this.viewer.isDestroyed()) {
      this.readyChunkQueue.length = 0;
      return;
    }

    const MAX_MOUNTS_PER_FRAME = 6;
    let mounted = 0;
    while (this.readyChunkQueue.length > 0 && mounted < MAX_MOUNTS_PER_FRAME) {
      const payload = this.readyChunkQueue.shift()!;
      if (this.chunkCache.has(payload.chunkKey)) continue;

      const shouldShow =
        this.massiveLayerActive &&
        this.latestWantedChunkKeys.has(payload.chunkKey);
      if (!shouldShow && this.readyChunkQueue.length > 8) {
        continue;
      }

      const primitives = this.createPrimitivesFromPayload(payload, shouldShow);
      this.chunkCache.set(payload.chunkKey, {
        key: payload.chunkKey,
        primitives,
        lastUsedSeq: this.massivePlanSeq,
      });
      if (shouldShow) {
        this.activeChunkKeys.add(payload.chunkKey);
      }
      mounted++;
    }

    this.evictLruChunks(450);
    if (this.readyChunkQueue.length > 0 && !this.viewer.isDestroyed()) {
      this.scheduleChunkMountPump();
    }
  }

  private evictLruChunks(maxCached: number): void {
    if (this.chunkCache.size <= maxCached) return;
    const candidates: Array<{ key: string; seq: number }> = [];
    for (const entry of this.chunkCache.values()) {
      if (!this.activeChunkKeys.has(entry.key)) {
        candidates.push({ key: entry.key, seq: entry.lastUsedSeq });
      }
    }
    candidates.sort((a, b) => a.seq - b.seq);
    const surplus = this.chunkCache.size - maxCached;
    const removeCount = Math.min(surplus, candidates.length);
    for (let i = 0; i < removeCount; i++) {
      const entry = this.chunkCache.get(candidates[i].key);
      if (!entry) continue;
      for (const prim of entry.primitives) {
        try {
          if (!this.viewer.isDestroyed()) {
            this.viewer.scene.primitives.remove(prim);
          }
        } catch {
          // ignore
        }
      }
      this.chunkCache.delete(candidates[i].key);
    }
  }

  private clearFinePrimitives(): void {
    if (this.finePrimitives.length === 0) return;
    for (const prim of this.finePrimitives) {
      try {
        if (!this.viewer.isDestroyed()) {
          this.viewer.scene.primitives.remove(prim);
        }
      } catch {
        // ignore
      }
    }
    this.finePrimitives = [];
  }

  private mountFinePayload(payload: ChunkGeometryPayload): void {
    const nextPrims = this.createPrimitivesFromPayload(
      payload,
      this.massiveLayerActive,
    );
    this.clearFinePrimitives();
    this.finePrimitives = nextPrims;
    if (
      this.massiveLayerActive &&
      payload.occupiedColCount !== undefined &&
      this.fineMetricsCallback
    ) {
      this.fineMetricsCallback(payload.occupiedColCount);
    }
  }

  private createPrimitivesFromPayload(
    payload: ChunkGeometryPayload,
    show: boolean,
  ): Cesium.Primitive[] {
    if (this.viewer.isDestroyed()) return [];
    const primitives: Cesium.Primitive[] = [];
    const hasVol = payload.boxCount > 0;

    const lineInstances: Cesium.GeometryInstance[] = [];
    if (payload.facadeLines) {
      lineInstances.push(
        new Cesium.GeometryInstance({
          geometry: buildLineGeometryFromBuffers(payload.facadeLines),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.fromCssColorString("#dff3ff").withAlpha(
                hasVol ? 0.68 : 0.62,
              ),
            ),
          },
        }),
      );
    }
    if (payload.roofLines) {
      lineInstances.push(
        new Cesium.GeometryInstance({
          geometry: buildLineGeometryFromBuffers(payload.roofLines),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              Cesium.Color.WHITE.withAlpha(hasVol ? 0.86 : 0.8),
            ),
          },
        }),
      );
    }

    if (lineInstances.length > 0) {
      const linesPrim = new Cesium.Primitive({
        geometryInstances: lineInstances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
          renderState: {
            depthTest: { enabled: true },
            depthMask: false,
          },
        }),
        show,
        asynchronous: false,
        allowPicking: false,
        interleave: true,
        releaseGeometryInstances: true,
      });
      this.viewer.scene.primitives.add(linesPrim);
      primitives.push(linesPrim);
    }

    if (payload.boxCount > 0 && payload.boxMatrices) {
      const flatBoxGeo = getFlatUnitBoxGeometry();
      const BOX_CHUNK = 6000;
      for (let start = 0; start < payload.boxCount; start += BOX_CHUNK) {
        const end = Math.min(payload.boxCount, start + BOX_CHUNK);
        const boxInstances: Cesium.GeometryInstance[] = new Array(end - start);
        for (let i = start; i < end; i++) {
          boxInstances[i - start] = new Cesium.GeometryInstance({
            geometry: flatBoxGeo,
            modelMatrix: Cesium.Matrix4.unpack(
              payload.boxMatrices as unknown as number[],
              i * 16,
              new Cesium.Matrix4(),
            ),
            attributes: {
              color: getCategoryFillAttr(
                payload.boxCategories[i] ?? "conformal-low",
              ),
            },
          });
        }
        const boxesPrim = new Cesium.Primitive({
          geometryInstances: boxInstances,
          appearance: new Cesium.PerInstanceColorAppearance({
            flat: true,
            translucent: true,
            renderState: {
              depthTest: { enabled: true },
              depthMask: false,
              cull: { enabled: true },
            },
          }),
          show,
          asynchronous: false,
          allowPicking: false,
          interleave: true,
          releaseGeometryInstances: true,
        });
        this.viewer.scene.primitives.add(boxesPrim);
        primitives.push(boxesPrim);
      }
    }

    return primitives;
  }

  private updateGroundPrimitive(
    gg: CompactGroundGridInput | null,
    show: boolean,
  ): void {
    if (!gg || !show) {
      if (this.groundPrimitive && !this.groundPrimitive.isDestroyed()) {
        this.groundPrimitive.show = false;
      }
      return;
    }

    const gKey = `${gg.level}|${gg.minLon.toFixed(6)}|${gg.maxLon.toFixed(6)}|${gg.minLat.toFixed(6)}|${gg.maxLat.toFixed(6)}|${gg.stepLon.toFixed(8)}|${gg.elevationMeters}`;
    if (
      gKey === this.lastGroundKey &&
      this.groundPrimitive &&
      !this.groundPrimitive.isDestroyed()
    ) {
      this.groundPrimitive.show = true;
      return;
    }

    this.lastGroundKey = gKey;
    if (this.groundPrimitive) {
      try {
        if (!this.viewer.isDestroyed()) {
          this.viewer.scene.primitives.remove(this.groundPrimitive);
        }
      } catch {
        // ignore
      }
      this.groundPrimitive = null;
    }

    const buf = buildGroundLineBuffer(gg);
    if (!buf) return;
    const prim = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry: buildLineGeometryFromBuffers(buf),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromCssColorString("#cce8ff").withAlpha(0.36),
          ),
        },
      }),
      appearance: new Cesium.PerInstanceColorAppearance({
        flat: true,
        translucent: true,
        renderState: {
          depthTest: { enabled: true },
          depthMask: false,
        },
      }),
      show: true,
      asynchronous: false,
      allowPicking: false,
      interleave: true,
      releaseGeometryInstances: true,
    });
    this.viewer.scene.primitives.add(prim);
    this.groundPrimitive = prim;
  }

  /**
   * 244Hz 高帧率分块池渲染执行器：
   * - 16x16 宏块命中缓存仅切换 `.show` 标志（0 GPU 重建）
   * - 新进视口宏块 & 精细 L8-L10 柱体异步下沉 Web Worker 生成裸 LINES + 贪心合并体素，Transferable 回传分帧渐进挂载
   */
  renderMassiveVoxelPlan(
    layerId: string,
    plan: MassiveVoxelRenderPlan,
    onFineMetrics?: (occupiedBuildingCols: number) => void,
  ): number {
    this.massiveLayerId = layerId;
    this.fineMetricsCallback = onFineMetrics ?? null;
    if (this.viewer.isDestroyed()) return 0;

    if (plan.voxelStyle === "tileset-only") {
      this.hideMassiveVoxelPool();
      return 0;
    }

    this.massiveLayerActive = true;
    const seq = ++this.massivePlanSeq;
    const includeVolumes =
      plan.voxelStyle === "height-heatmap" ||
      plan.voxelStyle === "translucent-volume";

    this.updateGroundPrimitive(plan.groundGrid, true);
    const worker = this.ensureVoxelWorker();

    if (plan.triPool && plan.triPool !== this.syncedTriPool) {
      this.syncedTriPool = plan.triPool;
      this.cachedTriLookup = createRuntimeTriangleLookup(plan.triPool);
      if (worker) {
        const initMsg: WorkerInitTrianglesRequest = {
          type: "init-triangles",
          pool: plan.triPool,
        };
        worker.postMessage(initMsg);
      }
    }

    if (plan.isChunkedMode) {
      this.clearFinePrimitives();
      const wantedSet = new Set(plan.visibleCacheKeys);
      this.latestWantedChunkKeys = wantedSet;

      if (this.readyChunkQueue.length > 0) {
        this.readyChunkQueue = this.readyChunkQueue.filter((p) =>
          wantedSet.has(p.chunkKey),
        );
      }

      for (const prevKey of Array.from(this.activeChunkKeys)) {
        if (!wantedSet.has(prevKey)) {
          const entry = this.chunkCache.get(prevKey);
          if (entry) {
            for (const prim of entry.primitives) {
              if (!prim.isDestroyed()) prim.show = false;
            }
          }
          this.activeChunkKeys.delete(prevKey);
        }
      }

      const missKeys: string[] = [];
      for (let i = 0; i < plan.visibleCacheKeys.length; i++) {
        const key = plan.visibleCacheKeys[i];
        const cached = this.chunkCache.get(key);
        if (cached) {
          cached.lastUsedSeq = seq;
          for (const prim of cached.primitives) {
            if (!prim.isDestroyed()) prim.show = true;
          }
          this.activeChunkKeys.add(key);
        } else if (!this.pendingChunkKeys.has(key)) {
          missKeys.push(key);
        }
      }

      for (let i = 0; i < missKeys.length; i++) {
        const key = missKeys[i];
        const cols = plan.resolveChunkColumns(key);
        if (cols.length === 0) {
          this.chunkCache.set(key, { key, primitives: [], lastUsedSeq: seq });
          continue;
        }

        if (worker) {
          const jobId = this.workerNextJobId++;
          this.pendingChunkKeys.add(key);
          this.workerPendingJobs.set(jobId, {
            kind: "chunk",
            chunkKey: key,
            seq,
          });
          const req: WorkerBuildChunkRequest = {
            jobId,
            chunkKey: key,
            columns: cols,
            includeVolumes,
            elevationThresholds: plan.elevationThresholds,
          };
          worker.postMessage(req);
        } else {
          const payload = buildChunkGeometryPayload(
            key,
            cols,
            includeVolumes,
            plan.elevationThresholds,
          );
          this.readyChunkQueue.push(payload);
        }
      }

      if (!worker && this.readyChunkQueue.length > 0) {
        this.scheduleChunkMountPump();
      }
      return plan.estimatedVisibleCols;
    }

    // L8 / L9 / L10 近景精细直出分支（双缓冲替换，保持旧精细帧直达新 Worker 结果返回，零闪烁）
    this.latestWantedChunkKeys.clear();
    for (const prevKey of this.activeChunkKeys) {
      const entry = this.chunkCache.get(prevKey);
      if (entry) {
        for (const prim of entry.primitives) {
          if (!prim.isDestroyed()) prim.show = false;
        }
      }
    }
    this.activeChunkKeys.clear();
    this.latestFineDispatchedSeq = seq;

    if (plan.directFineColumns.length === 0) {
      this.clearFinePrimitives();
      return 0;
    }

    const fineKey = `__fine__${seq}`;
    if (worker) {
      const jobId = this.workerNextJobId++;
      this.workerPendingJobs.set(jobId, {
        kind: "fine",
        chunkKey: fineKey,
        seq,
      });
      const req: WorkerBuildChunkRequest = {
        jobId,
        chunkKey: fineKey,
        columns: plan.directFineColumns,
        includeVolumes,
        elevationThresholds: plan.elevationThresholds,
      };
      worker.postMessage(req);
    } else {
      const payload = buildChunkGeometryPayload(
        fineKey,
        plan.directFineColumns,
        includeVolumes,
        plan.elevationThresholds,
        this.cachedTriLookup,
      );
      this.mountFinePayload(payload);
    }

    return plan.estimatedVisibleCols;
  }
}
