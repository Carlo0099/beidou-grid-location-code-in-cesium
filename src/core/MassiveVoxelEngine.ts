import {
  DEFAULT_ELEVATION_THRESHOLDS,
  type BeidouVoxelCell,
  type ElevationColorThresholds,
  type GridCellCategory,
  type GridLevel,
  type MassiveVoxelLodMode,
  type MassiveVoxelStats,
  type MassiveVoxelStyle,
  type ViewportBounds,
} from "../types/beidou";
import {
  compute2DGeoContext,
  encode3DWithGeoContext,
  getLevelSpec,
} from "./BeidouGridCode";
import type {
  CompactColumnInput,
  CompactGroundGridInput,
  CompactTrianglePool,
} from "./VoxelBufferBuilder";

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_A * WGS84_A);
const WGS84_EP2 = (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
const RAD_TO_DEG = 180 / Math.PI;

export interface FutianLandmarkPreset {
  id: string;
  name: string;
  subtitle: string;
  lon: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
}

export const FUTIAN_DEMO_TILESET_URL = "/futian-3dtiles/tileset.json";

export const FUTIAN_LANDMARKS: FutianLandmarkPreset[] = [
  {
    id: "futian-panorama",
    name: "福田 CBD 全景片区",
    subtitle: "市民中心 · 会展中心 · 连片超高层白膜",
    lon: 114.0545,
    lat: 22.521,
    height: 1480,
    heading: 10,
    pitch: -30,
  },
  {
    id: "futian-xiangmihu",
    name: "香蜜湖-车公庙集群",
    subtitle: "东西向高层天际线与开阔地面过渡带",
    lon: 114.028,
    lat: 22.522,
    height: 1150,
    heading: 22,
    pitch: -28,
  },
  {
    id: "futian-huaqiangbei",
    name: "华强北超高层峡谷",
    subtitle: "含 351m 标志性塔楼的高密度城区体素",
    lon: 114.084,
    lat: 22.528,
    height: 1180,
    heading: 348,
    pitch: -30,
  },
  {
    id: "futian-meilin",
    name: "莲花山-梅林坡地过渡",
    subtitle: "山体轮廓与高层社区连续体素耦合",
    lon: 114.051,
    lat: 22.542,
    height: 1280,
    heading: 15,
    pitch: -28,
  },
];

interface SparseColumnRecord {
  col: number;
  row: number;
  minH: number;
  maxH: number;
}

export interface SparseVoxelChunk {
  key: string;
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  maxRoofH: number;
  columns: SparseColumnRecord[];
}

export interface SparseBeidouVoxelIndex {
  level: 7;
  stepLon: number;
  stepLat: number;
  bounds: ViewportBounds;
  maxHeightMeters: number;
  tilesTotal: number;
  tilesParsed: number;
  featureCount: number;
  occupiedColumnsL7: number;
  occupiedVoxelsL7: number;
  virtualCapacityL7: number;
  virtualCapacityL8: number;
  virtualCapacityL10: number;
  parseTimeMs: number;
  /** Keyed by global integer (col, row) via packed number key; chunks hold spatial buckets */
  columnHeightMap: Map<number, number>;
  chunks: SparseVoxelChunk[];
  /** 可选：按 16x16 宏块分桶的紧凑三角网索引库，用于 L8/L9/L10 贴合真实建筑细化（消除空余 L7 悬挑包络） */
  triPool?: CompactTrianglePool;
}

export interface MassiveGroundGridSpec {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  stepLon: number;
  stepLat: number;
  elevationMeters: number;
  level: GridLevel;
}

export interface ConformalFacadeColumn {
  id: string;
  code2D: string;
  code3D: string;
  level: GridLevel;
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  centerLon: number;
  centerLat: number;
  baseHeight: number;
  roofHeight: number;
  layerStepMeters: number;
  exposedE: boolean;
  exposedW: boolean;
  exposedN: boolean;
  exposedS: boolean;
  neighborHE: number;
  neighborHW: number;
  neighborHN: number;
  neighborHS: number;
  category: GridCellCategory;
}

export interface MassiveVoxelRenderPlan {
  voxelStyle: MassiveVoxelStyle;
  activeLevel: GridLevel;
  activeStepMeters: number;
  activeLevelLabel: string;
  elevationThresholds: ElevationColorThresholds;
  groundGrid: CompactGroundGridInput | null;
  groundCellCount: number;
  isChunkedMode: boolean;
  visibleCacheKeys: string[];
  resolveChunkColumns: (cacheKey: string) => CompactColumnInput[];
  directFineColumns: CompactColumnInput[];
  estimatedVisibleCols: number;
  triPool?: CompactTrianglePool;
}

export interface StreamedConformalVoxelResult {
  cells: BeidouVoxelCell[];
  facadeColumns: ConformalFacadeColumn[];
  groundGrid: MassiveGroundGridSpec | null;
  groundCellCount: number;
  activeLevel: GridLevel;
  activeStepMeters: number;
  activeLevelLabel: string;
}

interface TilesetNode {
  boundingVolume?: { box?: number[] };
  content?: { uri?: string };
  contents?: Array<{ uri?: string }>;
  transform?: number[];
  children?: TilesetNode[];
}

type Mat4 = Float64Array;

function mat4Identity(): Mat4 {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
}

function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col++) {
    const b0 = b[col * 4];
    const b1 = b[col * 4 + 1];
    const b2 = b[col * 4 + 2];
    const b3 = b[col * 4 + 3];
    out[col * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
    out[col * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
    out[col * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
    out[col * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
  }
  return out;
}

function ecefToLonLatHeight(
  X: number,
  Y: number,
  Z: number,
): [number, number, number] {
  const p = Math.hypot(X, Y);
  if (p < 1e-9) {
    return [0, Z >= 0 ? 90 : -90, Math.abs(Z) - WGS84_B];
  }
  const lon = Math.atan2(Y, X);
  const theta = Math.atan2(Z * WGS84_A, p * WGS84_B);
  const sinT = Math.sin(theta);
  const cosT = Math.cos(theta);
  const lat = Math.atan2(
    Z + WGS84_EP2 * WGS84_B * sinT * sinT * sinT,
    p - WGS84_E2 * WGS84_A * cosT * cosT * cosT,
  );
  const sinLat = Math.sin(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const h = p / Math.cos(lat) - N;
  return [lon * RAD_TO_DEG, lat * RAD_TO_DEG, h];
}

function getNodeMatrix(node: {
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}): Mat4 {
  if (node.matrix && node.matrix.length === 16) {
    return new Float64Array(node.matrix);
  }
  const tx = node.translation?.[0] ?? 0;
  const ty = node.translation?.[1] ?? 0;
  const tz = node.translation?.[2] ?? 0;
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const x2 = qx + qx;
  const y2 = qy + qy;
  const z2 = qz + qz;
  const xx = qx * x2;
  const xy = qx * y2;
  const xz = qx * z2;
  const yy = qy * y2;
  const yz = qy * z2;
  const zz = qz * z2;
  const wx = qw * x2;
  const wy = qw * y2;
  const wz = qw * z2;
  return new Float64Array([
    (1 - (yy + zz)) * sx,
    (xy + wz) * sx,
    (xz - wy) * sx,
    0,
    (xy - wz) * sy,
    (1 - (xx + zz)) * sy,
    (yz + wx) * sy,
    0,
    (xz + wy) * sz,
    (yz - wx) * sz,
    (1 - (xx + yy)) * sz,
    0,
    tx,
    ty,
    tz,
    1,
  ]);
}

// 相对深圳锚点的整型栅格打包键 (colOffset, rowOffset 均远小于 ±131071)
const BASE_LON_ANCHOR = 113.5;
const BASE_LAT_ANCHOR = 22.0;

function packGridCoord(col: number, row: number): number {
  return (col + 32768) * 65536 + (row + 32768);
}

function unpackGridCoord(packed: number): [number, number] {
  const rowBias = packed % 65536;
  const colBias = (packed - rowBias) / 65536;
  return [colBias - 32768, rowBias - 32768];
}

interface L6MacroCell {
  col: number;
  row: number;
  maxH: number;
}

interface CachedL6Macro {
  cols: L6MacroCell[];
  heightMap: Map<number, number>;
}

const l6MacroCache = new WeakMap<SparseBeidouVoxelIndex, CachedL6Macro>();

/**
 * 懒构建并缓存全区 L6 (8x8 L7 -> ~61.8m) 宏观高度汇总金字塔，远景规划时避免遍历 26.8 万根 L7 原始柱体
 */
function getOrBuildL6MacroLayer(index: SparseBeidouVoxelIndex): CachedL6Macro {
  const cached = l6MacroCache.get(index);
  if (cached) return cached;

  const map = new Map<number, L6MacroCell>();
  for (let ci = 0; ci < index.chunks.length; ci++) {
    const ch = index.chunks[ci];
    for (let i = 0; i < ch.columns.length; i++) {
      const c = ch.columns[i];
      const gCol = Math.floor(c.col / 8);
      const gRow = Math.floor(c.row / 8);
      const pk = packGridCoord(gCol, gRow);
      const prev = map.get(pk);
      if (!prev) {
        map.set(pk, { col: gCol, row: gRow, maxH: c.maxH });
      } else if (c.maxH > prev.maxH) {
        prev.maxH = c.maxH;
      }
    }
  }

  const heightMap = new Map<number, number>();
  const cols: L6MacroCell[] = new Array(map.size);
  let k = 0;
  for (const [pk, cell] of map) {
    heightMap.set(pk, cell.maxH);
    cols[k++] = cell;
  }

  const built: CachedL6Macro = { cols, heightMap };
  l6MacroCache.set(index, built);
  return built;
}

interface MutableTileAccum {
  featureCount: number;
  columnMap: Map<number, { minH: number; maxH: number }>;
  triCoords?: number[];
}

/**
 * 解析单个 GLB 二进制缓冲区并将所有三角面快速光栅化至北斗 L7 稀疏网格高度列
 */
export function rasterizeGlbTrianglesToL7Columns(
  arrayBuffer: ArrayBuffer,
  tileWorldTransform: Mat4,
  accum: MutableTileAccum,
): void {
  if (arrayBuffer.byteLength < 28) return;
  const dv = new DataView(arrayBuffer);
  if (dv.getUint32(0, true) !== 0x46546c67) return;

  const totalLen = dv.getUint32(8, true);
  let cursor = 12;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gltf: any = null;
  let binOffset = 0;
  let binLen = 0;

  while (cursor + 8 <= totalLen && cursor + 8 <= arrayBuffer.byteLength) {
    const chunkLen = dv.getUint32(cursor, true);
    const chunkType = dv.getUint32(cursor + 4, true);
    const dataStart = cursor + 8;
    if (chunkType === 0x4e4f534a) {
      gltf = JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(arrayBuffer, dataStart, chunkLen),
        ),
      );
    } else if (chunkType === 0x004e4942) {
      binOffset = dataStart;
      binLen = chunkLen;
    }
    cursor += 8 + chunkLen;
  }

  if (!gltf || !binLen || !gltf.meshes || !gltf.accessors || !gltf.bufferViews)
    return;

  const propTables = gltf.extensions?.EXT_structural_metadata?.propertyTables;
  if (Array.isArray(propTables) && propTables[0]?.count) {
    accum.featureCount += propTables[0].count;
  }

  const yUpToZUp = new Float64Array([
    1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1,
  ]);
  const baseMatrix = mat4Multiply(tileWorldTransform, yUpToZUp);

  const meshMats = new Map<number, Mat4>();
  const nodes: Array<{
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }> = gltf.nodes ?? [];
  const visited = new Set<number>();

  const walk = (idx: number, parent: Mat4) => {
    if (visited.has(idx)) return;
    visited.add(idx);
    const node = nodes[idx];
    if (!node) return;
    const mat = mat4Multiply(parent, getNodeMatrix(node));
    if (node.mesh !== undefined && !meshMats.has(node.mesh)) {
      meshMats.set(node.mesh, mat);
    }
    if (node.children) {
      for (const c of node.children) walk(c, mat);
    }
  };

  const roots: number[] =
    gltf.scenes?.[gltf.scene ?? 0]?.nodes ??
    (nodes.length > 0 ? [nodes.length - 1] : []);
  for (const r of roots) walk(r, baseMatrix);
  for (let i = 0; i < nodes.length; i++)
    if (!visited.has(i)) walk(i, baseMatrix);

  const spec7 = getLevelSpec(7);
  const stepLon = spec7.lonDeg;
  const stepLat = spec7.latDeg;
  const invStepLon = 1 / stepLon;
  const invStepLat = 1 / stepLat;

  const stampPoint = (lon: number, lat: number, h: number) => {
    const col = Math.floor((lon - BASE_LON_ANCHOR) * invStepLon);
    const row = Math.floor((lat - BASE_LAT_ANCHOR) * invStepLat);
    if (Math.abs(col) > 30000 || Math.abs(row) > 30000) return;
    const key = packGridCoord(col, row);
    const clampedH = Math.max(0, h);
    const existing = accum.columnMap.get(key);
    if (!existing) {
      accum.columnMap.set(key, { minH: clampedH, maxH: clampedH });
    } else {
      if (clampedH < existing.minH) existing.minH = clampedH;
      if (clampedH > existing.maxH) existing.maxH = clampedH;
    }
  };

  for (let meshIdx = 0; meshIdx < gltf.meshes.length; meshIdx++) {
    const mesh = gltf.meshes[meshIdx];
    const mat = meshMats.get(meshIdx) ?? baseMatrix;
    const m0 = mat[0],
      m1 = mat[1],
      m2 = mat[2];
    const m4 = mat[4],
      m5 = mat[5],
      m6 = mat[6];
    const m8 = mat[8],
      m9 = mat[9],
      m10 = mat[10];
    const m12 = mat[12],
      m13 = mat[13],
      m14 = mat[14];

    for (const prim of mesh.primitives ?? []) {
      const posIdx = prim.attributes?.POSITION;
      if (posIdx === undefined) continue;
      const posAcc = gltf.accessors[posIdx];
      const posBv = gltf.bufferViews[posAcc.bufferView ?? 0];
      const stride = posBv.byteStride ?? 12;
      const startByte =
        binOffset + (posBv.byteOffset ?? 0) + (posAcc.byteOffset ?? 0);

      const vCount: number = posAcc.count;
      const lons = new Float64Array(vCount);
      const lats = new Float64Array(vCount);
      const hs = new Float32Array(vCount);

      for (let v = 0; v < vCount; v++) {
        const bp = startByte + v * stride;
        const x = dv.getFloat32(bp, true);
        const y = dv.getFloat32(bp + 4, true);
        const z = dv.getFloat32(bp + 8, true);
        const ex = m0 * x + m4 * y + m8 * z + m12;
        const ey = m1 * x + m5 * y + m9 * z + m13;
        const ez = m2 * x + m6 * y + m10 * z + m14;
        const [lon, lat, h] = ecefToLonLatHeight(ex, ey, ez);
        lons[v] = lon;
        lats[v] = lat;
        hs[v] = h;
      }

      if (prim.indices !== undefined) {
        const idxAcc = gltf.accessors[prim.indices];
        const idxBv = gltf.bufferViews[idxAcc.bufferView ?? 0];
        const idxStart =
          binOffset + (idxBv.byteOffset ?? 0) + (idxAcc.byteOffset ?? 0);
        const compType: number = idxAcc.componentType;
        const idxCount: number = idxAcc.count;

        const readIdx = (k: number): number => {
          if (compType === 5123) return dv.getUint16(idxStart + k * 2, true);
          if (compType === 5125) return dv.getUint32(idxStart + k * 4, true);
          return dv.getUint8(idxStart + k);
        };

        for (let t = 0; t + 2 < idxCount; t += 3) {
          const i0 = readIdx(t);
          const i1 = readIdx(t + 1);
          const i2 = readIdx(t + 2);
          if (i0 >= vCount || i1 >= vCount || i2 >= vCount) continue;

          const lon0 = lons[i0],
            lat0 = lats[i0],
            h0 = hs[i0];
          const lon1 = lons[i1],
            lat1 = lats[i1],
            h1 = hs[i1];
          const lon2 = lons[i2],
            lat2 = lats[i2],
            h2 = hs[i2];

          stampPoint(lon0, lat0, h0);
          stampPoint(lon1, lat1, h1);
          stampPoint(lon2, lat2, h2);

          if (accum.triCoords) {
            const maxTriH = Math.max(h0, h1, h2);
            if (
              maxTriH > 0.25 &&
              Math.abs(lon0 - BASE_LON_ANCHOR) < 2.0 &&
              Math.abs(lat0 - BASE_LAT_ANCHOR) < 2.0
            ) {
              const dx1 = lon1 - lon0;
              const dy1 = lat1 - lat0;
              const dx2 = lon2 - lon0;
              const dy2 = lat2 - lat0;
              const area2 = Math.abs(dx1 * dy2 - dy1 * dx2);
              if (
                area2 > 1e-18 ||
                Math.abs(dx1) + Math.abs(dy1) + Math.abs(dx2) + Math.abs(dy2) >
                  1e-9
              ) {
                accum.triCoords.push(
                  Math.round((lon0 - BASE_LON_ANCHOR) * 1e9),
                  Math.round((lat0 - BASE_LAT_ANCHOR) * 1e9),
                  Math.round(Math.max(0, h0) * 1000),
                  Math.round((lon1 - BASE_LON_ANCHOR) * 1e9),
                  Math.round((lat1 - BASE_LAT_ANCHOR) * 1e9),
                  Math.round(Math.max(0, h1) * 1000),
                  Math.round((lon2 - BASE_LON_ANCHOR) * 1e9),
                  Math.round((lat2 - BASE_LAT_ANCHOR) * 1e9),
                  Math.round(Math.max(0, h2) * 1000),
                );
              }
            }
          }

          // 对跨越多个 L7 网格的建筑大立面/屋顶三角面做重心采样补全
          const spanLon =
            Math.max(lon0, lon1, lon2) - Math.min(lon0, lon1, lon2);
          const spanLat =
            Math.max(lat0, lat1, lat2) - Math.min(lat0, lat1, lat2);
          const steps = Math.min(
            8,
            Math.ceil(Math.max(spanLon * invStepLon, spanLat * invStepLat)),
          );
          if (steps >= 2) {
            const triMaxH = Math.max(h0, h1, h2);
            for (let su = 0; su <= steps; su++) {
              const u = su / steps;
              for (let sv = 0; sv + su <= steps; sv++) {
                const v = sv / steps;
                const w = 1 - u - v;
                stampPoint(
                  lon0 * u + lon1 * v + lon2 * w,
                  lat0 * u + lat1 * v + lat2 * w,
                  triMaxH,
                );
              }
            }
          }
        }
      } else {
        for (let v = 0; v < vCount; v++) {
          stampPoint(lons[v], lats[v], hs[v]);
        }
      }
    }
  }
}

/**
 * 异步流式加载福田 3D Tiles 全部 GLB 瓦片并构建亿级地址空间稀疏索引
 */
export async function buildSparseVoxelIndexFromTileset(
  tilesetUrl: string,
  onProgress?: (
    parsed: number,
    total: number,
    partialStats: MassiveVoxelStats,
  ) => void,
): Promise<SparseBeidouVoxelIndex> {
  const tStart = performance.now();
  const res = await fetch(tilesetUrl);
  if (!res.ok) {
    throw new Error(`无法加载 3D Tileset (${res.status}): ${tilesetUrl}`);
  }
  const json = (await res.json()) as { root?: TilesetNode };
  if (!json.root) {
    throw new Error("tileset.json 缺少 root 节点");
  }

  const baseUrl = tilesetUrl.substring(0, tilesetUrl.lastIndexOf("/") + 1);
  const tileList: Array<{ uri: string; transform: Mat4 }> = [];

  const collect = (node: TilesetNode, parentMat: Mat4) => {
    const localMat =
      node.transform && node.transform.length === 16
        ? new Float64Array(node.transform)
        : mat4Identity();
    const worldMat = mat4Multiply(parentMat, localMat);
    const uri = node.content?.uri ?? node.contents?.[0]?.uri;
    if (uri && uri.endsWith(".glb")) {
      tileList.push({ uri, transform: worldMat });
    }
    if (node.children) {
      for (const ch of node.children) collect(ch, worldMat);
    }
  };
  collect(json.root, mat4Identity());

  const accum: MutableTileAccum = {
    featureCount: 0,
    columnMap: new Map(),
    triCoords: [],
  };

  const spec7 = getLevelSpec(7);

  const computeVirtualMetrics = (
    tilesParsed: number,
    buildTriPool = false,
  ): SparseBeidouVoxelIndex => {
    let minCol = Infinity,
      maxCol = -Infinity;
    let minRow = Infinity,
      maxRow = -Infinity;
    let maxH = 60;
    let occupiedVoxelsL7 = 0;

    for (const [packed, rec] of accum.columnMap) {
      const [col, row] = unpackGridCoord(packed);
      if (col < minCol) minCol = col;
      if (col > maxCol) maxCol = col;
      if (row < minRow) minRow = row;
      if (row > maxRow) maxRow = row;
      if (rec.maxH > maxH) maxH = rec.maxH;
      const stack = Math.max(
        1,
        Math.ceil(
          Math.max(1, rec.maxH - rec.minH) / spec7.heightResolutionMeters,
        ),
      );
      occupiedVoxelsL7 += stack;
    }

    if (!Number.isFinite(minCol)) {
      minCol = 0;
      maxCol = 100;
      minRow = 0;
      maxRow = 100;
    }

    const minLon = BASE_LON_ANCHOR + minCol * spec7.lonDeg;
    const maxLon = BASE_LON_ANCHOR + (maxCol + 1) * spec7.lonDeg;
    const minLat = BASE_LAT_ANCHOR + minRow * spec7.latDeg;
    const maxLat = BASE_LAT_ANCHOR + (maxRow + 1) * spec7.latDeg;

    const spanColsL7 = Math.max(1, maxCol - minCol + 1);
    const spanRowsL7 = Math.max(1, maxRow - minRow + 1);
    const airspaceCeiling = Math.max(400, Math.ceil(maxH / 50) * 50 + 100);
    const zLayersL7 = Math.ceil(airspaceCeiling / spec7.heightResolutionMeters);
    const virtualCapacityL7 = spanColsL7 * spanRowsL7 * zLayersL7;
    const virtualCapacityL8 = virtualCapacityL7 * 512; // 1个 L7 = 8^3 = 512个 L8 (0.97m)
    const virtualCapacityL10 = virtualCapacityL8 * 262144; // 1个 L8 = 512^2 = 262,144个 L10 (1.5cm)

    // 按 16x16 L7 列聚合为宏观空间分块，实现视口快速剔除与流式渲染
    const chunkMap = new Map<string, SparseVoxelChunk>();
    const compactHeightMap = new Map<number, number>();
    for (const [packed, rec] of accum.columnMap) {
      compactHeightMap.set(packed, rec.maxH);
      const [col, row] = unpackGridCoord(packed);
      const cChunk = Math.floor(col / 16);
      const rChunk = Math.floor(row / 16);
      const key = `${cChunk}_${rChunk}`;
      let chunk = chunkMap.get(key);
      if (!chunk) {
        chunk = {
          key,
          minLon: BASE_LON_ANCHOR + cChunk * 16 * spec7.lonDeg,
          maxLon: BASE_LON_ANCHOR + (cChunk + 1) * 16 * spec7.lonDeg,
          minLat: BASE_LAT_ANCHOR + rChunk * 16 * spec7.latDeg,
          maxLat: BASE_LAT_ANCHOR + (rChunk + 1) * 16 * spec7.latDeg,
          maxRoofH: rec.maxH,
          columns: [],
        };
        chunkMap.set(key, chunk);
      } else if (rec.maxH > chunk.maxRoofH) {
        chunk.maxRoofH = rec.maxH;
      }
      chunk.columns.push({
        col,
        row,
        minH: rec.minH,
        maxH: rec.maxH,
      });
    }

    let triPool: CompactTrianglePool | undefined;
    if (buildTriPool && accum.triCoords && accum.triCoords.length >= 9) {
      const triData = new Int32Array(accum.triCoords);
      const triCount = Math.floor(triData.length / 9);
      const perChunk = new Map<string, number[]>();
      const invChunkLon = 1 / (spec7.lonDeg * 16);
      const invChunkLat = 1 / (spec7.latDeg * 16);

      for (let t = 0; t < triCount; t++) {
        const b = t * 9;
        const minDLon =
          Math.min(triData[b], triData[b + 3], triData[b + 6]) * 1e-9;
        const maxDLon =
          Math.max(triData[b], triData[b + 3], triData[b + 6]) * 1e-9;
        const minDLat =
          Math.min(triData[b + 1], triData[b + 4], triData[b + 7]) * 1e-9;
        const maxDLat =
          Math.max(triData[b + 1], triData[b + 4], triData[b + 7]) * 1e-9;
        const c0 = Math.floor(minDLon * invChunkLon);
        const c1 = Math.floor(maxDLon * invChunkLon);
        const r0 = Math.floor(minDLat * invChunkLat);
        const r1 = Math.floor(maxDLat * invChunkLat);
        if (c1 - c0 > 16 || r1 - r0 > 16) continue;
        for (let r = r0; r <= r1; r++) {
          for (let c = c0; c <= c1; c++) {
            const k = `${c}_${r}`;
            let list = perChunk.get(k);
            if (!list) {
              list = [];
              perChunk.set(k, list);
            }
            list.push(t);
          }
        }
      }

      const chunkKeys: string[] = [];
      const chunkOffsets = new Uint32Array(perChunk.size + 1);
      let totalRefs = 0;
      for (const [k, list] of perChunk) {
        chunkKeys.push(k);
        totalRefs += list.length;
      }
      const chunkTriIndices = new Uint32Array(totalRefs);
      let cursorIdx = 0;
      for (let ci = 0; ci < chunkKeys.length; ci++) {
        chunkOffsets[ci] = cursorIdx;
        const list = perChunk.get(chunkKeys[ci])!;
        for (let li = 0; li < list.length; li++) {
          chunkTriIndices[cursorIdx++] = list[li];
        }
      }
      chunkOffsets[chunkKeys.length] = cursorIdx;

      triPool = {
        triData,
        triCount,
        chunkKeys,
        chunkOffsets,
        chunkTriIndices,
      };
      accum.triCoords = undefined;
    }

    return {
      level: 7,
      stepLon: spec7.lonDeg,
      stepLat: spec7.latDeg,
      bounds: { minLon, maxLon, minLat, maxLat },
      maxHeightMeters: maxH,
      tilesTotal: tileList.length,
      tilesParsed,
      featureCount: accum.featureCount,
      occupiedColumnsL7: accum.columnMap.size,
      occupiedVoxelsL7,
      virtualCapacityL7,
      virtualCapacityL8,
      virtualCapacityL10,
      parseTimeMs: Math.round(performance.now() - tStart),
      columnHeightMap: compactHeightMap,
      chunks: Array.from(chunkMap.values()),
      ...(triPool ? { triPool } : {}),
    };
  };

  // 按 4 并发批量异步流式拉取与光栅化 GLB，大幅缩短全区索引构建耗时
  const BATCH_SIZE = 4;
  let parsedCount = 0;
  for (let start = 0; start < tileList.length; start += BATCH_SIZE) {
    const batch = tileList.slice(start, start + BATCH_SIZE);
    await Promise.all(
      batch.map(async (tile) => {
        try {
          const tileRes = await fetch(baseUrl + tile.uri);
          if (tileRes.ok) {
            const buf = await tileRes.arrayBuffer();
            rasterizeGlbTrianglesToL7Columns(buf, tile.transform, accum);
          }
        } catch {
          // ignore single tile fetch error
        }
      }),
    );

    parsedCount = Math.min(tileList.length, start + batch.length);
    if (onProgress) {
      const partial = computeVirtualMetrics(parsedCount);
      onProgress(parsedCount, tileList.length, {
        tilesTotal: partial.tilesTotal,
        tilesParsed: partial.tilesParsed,
        featureCount: partial.featureCount,
        occupiedColumnsL7: partial.occupiedColumnsL7,
        occupiedVoxelsL7: partial.occupiedVoxelsL7,
        virtualCapacityL7: partial.virtualCapacityL7,
        virtualCapacityL8: partial.virtualCapacityL8,
        virtualCapacityL10: partial.virtualCapacityL10,
        renderedVoxels: 0,
        activeLevel: 7,
        activeResolutionMeters: spec7.approxGroundMeters,
        activeLevelLabel: `L7 (${spec7.approxGroundMeters}m) / L10 (${getLevelSpec(10).approxGroundMeters}m)`,
        parseTimeMs: partial.parseTimeMs,
      });
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return computeVirtualMetrics(tileList.length, true);
}

function heightToConformalCategory(
  roofH: number,
  isGround: boolean,
): GridCellCategory {
  if (isGround) return "conformal-ground";
  if (roofH < 45) return "conformal-low";
  if (roofH < 120) return "conformal-mid";
  if (roofH < 210) return "conformal-high";
  return "conformal-super";
}

function computeSnappedGroundGrid(
  roiMinLon: number,
  roiMaxLon: number,
  roiMinLat: number,
  roiMaxLat: number,
  baseStepLon: number,
  baseStepLat: number,
  level: GridLevel,
  maxLinesPerAxis = 56,
  elevationMetersOverride?: number,
): { spec: MassiveGroundGridSpec; cellCount: number } | null {
  const startCol = Math.floor((roiMinLon - BASE_LON_ANCHOR) / baseStepLon);
  const endCol = Math.ceil((roiMaxLon - BASE_LON_ANCHOR) / baseStepLon);
  const startRow = Math.floor((roiMinLat - BASE_LAT_ANCHOR) / baseStepLat);
  const endRow = Math.ceil((roiMaxLat - BASE_LAT_ANCHOR) / baseStepLat);

  const rawCols = Math.max(1, endCol - startCol);
  const rawRows = Math.max(1, endRow - startRow);
  let stride = 1;
  while (
    rawCols / stride > maxLinesPerAxis ||
    rawRows / stride > maxLinesPerAxis
  ) {
    stride *= 2;
  }

  const gStepLon = baseStepLon * stride;
  const gStepLat = baseStepLat * stride;
  const gStartCol = Math.floor(startCol / stride);
  const gEndCol = Math.ceil(endCol / stride);
  const gStartRow = Math.floor(startRow / stride);
  const gEndRow = Math.ceil(endRow / stride);

  const cols = Math.max(1, gEndCol - gStartCol);
  const rows = Math.max(1, gEndRow - gStartRow);

  return {
    spec: {
      minLon: BASE_LON_ANCHOR + gStartCol * gStepLon,
      maxLon: BASE_LON_ANCHOR + gEndCol * gStepLon,
      minLat: BASE_LAT_ANCHOR + gStartRow * gStepLat,
      maxLat: BASE_LAT_ANCHOR + gEndRow * gStepLat,
      stepLon: gStepLon,
      stepLat: gStepLat,
      elevationMeters: elevationMetersOverride ?? (level >= 9 ? 0.08 : 0.8),
      level,
    },
    cellCount: cols * rows,
  };
}

/**
 * 依据相机视口、真三维视距与相机航向视锥，对全视口全部可视建筑与地表做一致网格化：
 * - 自适应 L6-L10：阈值严格对齐实际视口可视空间尺度（不虚报超细等级），保证全视口所有建筑从底部到屋顶完整渲染当前自适应级别网格码
 * - 固定 L6..L10：视口内 100% 建筑整体（地面到屋顶全立面+顶面）与地表均按选定固定级别编码渲染，并通过视锥剔除消除后景/侧翼建筑漏绘
 */
export function streamConformalVoxelsForViewport(
  index: SparseBeidouVoxelIndex,
  viewport: ViewportBounds,
  cameraHeightMeters: number,
  options: {
    voxelStyle: MassiveVoxelStyle;
    lodMode: MassiveVoxelLodMode;
    includeGroundCarpet: boolean;
    minElevationFilterMeters: number;
    maxRenderedVoxels?: number;
    cameraPos?: { lon: number; lat: number };
    cameraHeadingDeg?: number;
    cameraPitchDeg?: number;
    viewTargetDistanceMeters?: number;
  },
): StreamedConformalVoxelResult {
  const spec7 = getLevelSpec(7);
  if (options.voxelStyle === "tileset-only") {
    return {
      cells: [],
      facadeColumns: [],
      groundGrid: null,
      groundCellCount: 0,
      activeLevel: 7,
      activeStepMeters: spec7.approxGroundMeters,
      activeLevelLabel: "仅白膜（无体素）",
    };
  }

  const isConformalWireStyle = options.voxelStyle === "conformal-white";
  const maxColBudget =
    options.maxRenderedVoxels ?? (isConformalWireStyle ? 8500 : 5200);
  const viewCenterLon = (viewport.minLon + viewport.maxLon) * 0.5;
  const viewCenterLat = (viewport.minLat + viewport.maxLat) * 0.5;
  const camLon = options.cameraPos?.lon ?? viewCenterLon;
  const camLat = options.cameraPos?.lat ?? viewCenterLat;

  const priorityLon = camLon * 0.45 + viewCenterLon * 0.55;
  const priorityLat = camLat * 0.45 + viewCenterLat * 0.55;

  const anchorRoofH = Math.max(
    lookupFutianVoxelHeight(index, viewCenterLon, viewCenterLat),
    lookupFutianVoxelHeight(index, priorityLon, priorityLat),
  );
  const effectiveClearance = Math.max(
    0.12,
    cameraHeightMeters - Math.min(cameraHeightMeters * 0.85, anchorRoofH * 0.9),
  );

  // 全视口地面连续网格范围（覆盖整个可见屏幕）
  const groundBoundsMinLon = viewport.minLon;
  const groundBoundsMaxLon = viewport.maxLon;
  const groundBoundsMinLat = viewport.minLat;
  const groundBoundsMaxLat = viewport.maxLat;

  const roiMinLon = Math.max(index.bounds.minLon, viewport.minLon);
  const roiMaxLon = Math.min(index.bounds.maxLon, viewport.maxLon);
  const roiMinLat = Math.max(index.bounds.minLat, viewport.minLat);
  const roiMaxLat = Math.min(index.bounds.maxLat, viewport.maxLat);

  // 相机水平扇形视锥裁剪：剔除相机身后与两侧视窗外楼栋，把 100% 渲染预算留给画面内近-远所有可见建筑
  const useFrustumCull =
    options.cameraHeadingDeg !== undefined &&
    options.cameraPitchDeg !== undefined &&
    options.cameraPitchDeg > -68;
  const headRad = ((options.cameraHeadingDeg ?? 0) * Math.PI) / 180;
  const fwdE = Math.sin(headRad);
  const fwdN = Math.cos(headRad);
  const cosCamLat = Math.max(0.25, Math.cos((camLat * Math.PI) / 180));
  const mPerDegLon = 111320 * cosCamLat;
  const mPerDegLat = 110740;

  const isInFrustum = (lon: number, lat: number, padMeters = 90): boolean => {
    if (!useFrustumCull) return true;
    const dx = (lon - camLon) * mPerDegLon;
    const dy = (lat - camLat) * mPerDegLat;
    const fwd = dx * fwdE + dy * fwdN;
    if (fwd < -padMeters) return false;
    const side = Math.abs(dx * fwdN - dy * fwdE);
    return side <= Math.max(240, fwd * 1.28 + padMeters * 2);
  };

  const distScore = (lon: number, lat: number): number => {
    const dCam = (lon - camLon) ** 2 + (lat - camLat) ** 2;
    const dPri = (lon - priorityLon) ** 2 + (lat - priorityLat) ** 2;
    return dCam * 0.35 + dPri * 0.65;
  };

  // 将柱体的完整 [base .. top] 切分为最多 4 段高程色彩带，既完整包裹整栋建筑高度又不爆炸多边形数
  const BAND_THRESHOLDS = [45, 120, 210];
  const pushColumnShellAndCells = (
    cMinLon: number,
    cMaxLon: number,
    cMinLat: number,
    cMaxLat: number,
    cLon: number,
    cLat: number,
    colMaxH: number,
    nE: number,
    nW: number,
    nN: number,
    nS: number,
    encodeLv: GridLevel,
    vStepM: number,
    facadeColumns: ConformalFacadeColumn[],
    volCells: BeidouVoxelCell[],
    idPrefix: string,
  ) => {
    const minNeighborH = Math.min(nE, nW, nN, nS);
    // 屋顶抬升微量共形净距，防止在 100% 不透明白膜屋顶内部发生 Z-Fighting 遮挡
    const roofClearance =
      vStepM >= 5 ? 0.55 : vStepM >= 1 ? 0.24 : vStepM >= 0.15 ? 0.08 : 0.03;
    const roofSnapH =
      Math.max(vStepM, Math.ceil(colMaxH / vStepM) * vStepM) + roofClearance;
    const exposedBaseH = Math.max(
      0,
      Math.floor(minNeighborH / vStepM) * vStepM,
    );

    const geoCtx = compute2DGeoContext(cLat, cLon, encodeLv);
    const topCode3D = encode3DWithGeoContext(
      geoCtx,
      Math.max(0, roofSnapH - vStepM * 0.5),
      encodeLv,
    );
    const cat = heightToConformalCategory(colMaxH, false);

    facadeColumns.push({
      id: `${idPrefix}#${topCode3D}`,
      code2D: geoCtx.code2D,
      code3D: topCode3D,
      level: encodeLv,
      minLon: cMinLon,
      maxLon: cMaxLon,
      minLat: cMinLat,
      maxLat: cMaxLat,
      centerLon: cLon,
      centerLat: cLat,
      baseHeight: exposedBaseH,
      roofHeight: roofSnapH,
      layerStepMeters: vStepM,
      exposedE: colMaxH > nE + 0.08,
      exposedW: colMaxH > nW + 0.08,
      exposedN: colMaxH > nN + 0.08,
      exposedS: colMaxH > nS + 0.08,
      neighborHE: nE,
      neighborHW: nW,
      neighborHN: nN,
      neighborHS: nS,
      category: cat,
    });

    if (isConformalWireStyle) {
      volCells.push({
        id: `col#${topCode3D}`,
        code2D: geoCtx.code2D,
        code3D: topCode3D,
        level: encodeLv,
        minLon: cMinLon,
        maxLon: cMaxLon,
        minLat: cMinLat,
        maxLat: cMaxLat,
        minHeight: exposedBaseH,
        maxHeight: roofSnapH,
        centerLon: cLon,
        centerLat: cLat,
        centerHeight: (exposedBaseH + roofSnapH) * 0.5,
        category: cat,
        verticalStepMeters: vStepM,
      });
      return;
    }

    // 立体色彩/半透明体素：当存在外立面暴露高度时，从暴露底部一直分带包裹到屋顶（整栋立体化）；内圈屋面柱体则盖覆清晰顶壳
    if (exposedBaseH < roofSnapH - Math.max(0.15, vStepM * 0.75)) {
      let curZ = exposedBaseH;
      const cuts = BAND_THRESHOLDS.filter(
        (t) => t > curZ + 0.2 && t < roofSnapH - 0.2,
      );
      cuts.push(roofSnapH);
      for (let b = 0; b < cuts.length; b++) {
        const nextZ = cuts[b];
        const midZ = (curZ + nextZ) * 0.5;
        const bandCode3D = encode3DWithGeoContext(geoCtx, midZ, encodeLv);
        volCells.push({
          id: `col#${bandCode3D}#B${b}`,
          code2D: geoCtx.code2D,
          code3D: bandCode3D,
          level: encodeLv,
          minLon: cMinLon,
          maxLon: cMaxLon,
          minLat: cMinLat,
          maxLat: cMaxLat,
          minHeight: curZ,
          maxHeight: nextZ,
          centerLon: cLon,
          centerLat: cLat,
          centerHeight: midZ,
          category: heightToConformalCategory(nextZ - 0.1, false),
          verticalStepMeters: vStepM,
        });
        curZ = nextZ;
      }
    } else {
      const capBottom = Math.max(
        0,
        roofSnapH - Math.max(0.03, Math.min(vStepM, 6)),
      );
      const midZ = (capBottom + roofSnapH) * 0.5;
      volCells.push({
        id: `col#${topCode3D}#TOP`,
        code2D: geoCtx.code2D,
        code3D: topCode3D,
        level: encodeLv,
        minLon: cMinLon,
        maxLon: cMaxLon,
        minLat: cMinLat,
        maxLat: cMaxLat,
        minHeight: capBottom,
        maxHeight: roofSnapH,
        centerLon: cLon,
        centerLat: cLat,
        centerHeight: midZ,
        category: cat,
        verticalStepMeters: vStepM,
      });
    }
  };

  // 基于当前视锥收集所有可视 L7 柱体，并在需要全视口完整铺满时自动计算满足全覆盖的网格聚合步长
  const renderLevelFullFrustum = (
    encodeLv: GridLevel,
    maxBudgetCols: number,
  ): {
    facadeColumns: ConformalFacadeColumn[];
    volCells: BeidouVoxelCell[];
    usedStepLon: number;
    usedStepLat: number;
  } => {
    const spec = getLevelSpec(encodeLv);
    const vStepM =
      encodeLv <= 6
        ? 30.92
        : encodeLv === 7
          ? spec7.heightResolutionMeters
          : spec.heightResolutionMeters * 2;

    if (roiMinLon >= roiMaxLon || roiMinLat >= roiMaxLat) {
      return {
        facadeColumns: [],
        volCells: [],
        usedStepLon: spec.lonDeg,
        usedStepLat: spec.latDeg,
      };
    }

    // 收集视锥内所有 L7 占空柱体
    const visibleL7Cols: Array<{ col: number; row: number; maxH: number }> = [];
    for (const chunk of index.chunks) {
      if (
        chunk.maxLon < roiMinLon ||
        chunk.minLon > roiMaxLon ||
        chunk.maxLat < roiMinLat ||
        chunk.minLat > roiMaxLat
      ) {
        continue;
      }
      const chCenterLon = (chunk.minLon + chunk.maxLon) * 0.5;
      const chCenterLat = (chunk.minLat + chunk.maxLat) * 0.5;
      if (!isInFrustum(chCenterLon, chCenterLat, 260)) continue;

      for (const c of chunk.columns) {
        if (c.maxH < options.minElevationFilterMeters) continue;
        const cMinLon = BASE_LON_ANCHOR + c.col * index.stepLon;
        const cMinLat = BASE_LAT_ANCHOR + c.row * index.stepLat;
        const cMaxLon = cMinLon + index.stepLon;
        const cMaxLat = cMinLat + index.stepLat;
        if (
          cMaxLon < roiMinLon ||
          cMinLon > roiMaxLon ||
          cMaxLat < roiMinLat ||
          cMinLat > roiMaxLat
        ) {
          continue;
        }
        const cLon = (cMinLon + cMaxLon) * 0.5;
        const cLat = (cMinLat + cMaxLat) * 0.5;
        if (!isInFrustum(cLon, cLat, 90)) continue;
        visibleL7Cols.push({ col: c.col, row: c.row, maxH: c.maxH });
      }
    }

    const facadeColumns: ConformalFacadeColumn[] = [];
    const volCells: BeidouVoxelCell[] = [];

    if (visibleL7Cols.length === 0) {
      return {
        facadeColumns,
        volCells,
        usedStepLon: spec.lonDeg,
        usedStepLat: spec.latDeg,
      };
    }

    // 分枝 A: L8 / L9 / L10 细分或全视口自适应加密（按子格真实视口交集估算密度，严格保持 encodeLv 编码）
    if (encodeLv >= 8) {
      const subFactor = 8 ** (encodeLv - 7); // L8=8, L9=64, L10=512
      const countIntersectSubCols = (cellsPerSide: number): number => {
        const sLon = index.stepLon / cellsPerSide;
        const sLat = index.stepLat / cellsPerSide;
        let total = 0;
        for (let idx = 0; idx < visibleL7Cols.length; idx++) {
          const p = visibleL7Cols[idx];
          const pMinLon = BASE_LON_ANCHOR + p.col * index.stepLon;
          const pMinLat = BASE_LAT_ANCHOR + p.row * index.stepLat;
          const sx0 = Math.max(0, Math.floor((roiMinLon - pMinLon) / sLon));
          const sx1 = Math.min(
            cellsPerSide - 1,
            Math.floor((roiMaxLon - pMinLon) / sLon),
          );
          const sy0 = Math.max(0, Math.floor((roiMinLat - pMinLat) / sLat));
          const sy1 = Math.min(
            cellsPerSide - 1,
            Math.floor((roiMaxLat - pMinLat) / sLat),
          );
          if (sx1 >= sx0 && sy1 >= sy0) {
            total += (sx1 - sx0 + 1) * (sy1 - sy0 + 1);
            if (total > maxBudgetCols) return total;
          }
        }
        return total;
      };

      let subStride = 1;
      while (
        subStride < subFactor &&
        countIntersectSubCols(Math.round(subFactor / subStride)) > maxBudgetCols
      ) {
        subStride *= 2;
      }

      if (subStride < subFactor) {
        // 真正的 L7 内部 1:1 或高密视口裁剪细分（L8/L9/L10 精细包络，邻接 L7 边界查表确保外墙直落 0m 地面！）
        const cellsPerL7 = Math.max(1, Math.round(subFactor / subStride));
        const fineStepLon = index.stepLon / cellsPerL7;
        const fineStepLat = index.stepLat / cellsPerL7;

        visibleL7Cols.sort((a, b) => {
          const da = distScore(
            BASE_LON_ANCHOR + (a.col + 0.5) * index.stepLon,
            BASE_LAT_ANCHOR + (a.row + 0.5) * index.stepLat,
          );
          const db = distScore(
            BASE_LON_ANCHOR + (b.col + 0.5) * index.stepLon,
            BASE_LAT_ANCHOR + (b.row + 0.5) * index.stepLat,
          );
          return da - db;
        });

        for (let idx = 0; idx < visibleL7Cols.length; idx++) {
          if (facadeColumns.length >= maxBudgetCols) break;
          const parent = visibleL7Cols[idx];
          const pMinLon = BASE_LON_ANCHOR + parent.col * index.stepLon;
          const pMinLat = BASE_LAT_ANCHOR + parent.row * index.stepLat;

          const sxStart = Math.max(
            0,
            Math.floor((roiMinLon - pMinLon) / fineStepLon),
          );
          const sxEnd = Math.min(
            cellsPerL7 - 1,
            Math.floor((roiMaxLon - pMinLon) / fineStepLon),
          );
          const syStart = Math.max(
            0,
            Math.floor((roiMinLat - pMinLat) / fineStepLat),
          );
          const syEnd = Math.min(
            cellsPerL7 - 1,
            Math.floor((roiMaxLat - pMinLat) / fineStepLat),
          );
          if (sxEnd < sxStart || syEnd < syStart) continue;

          const pE =
            index.columnHeightMap.get(
              packGridCoord(parent.col + 1, parent.row),
            ) ?? 0;
          const pW =
            index.columnHeightMap.get(
              packGridCoord(parent.col - 1, parent.row),
            ) ?? 0;
          const pN =
            index.columnHeightMap.get(
              packGridCoord(parent.col, parent.row + 1),
            ) ?? 0;
          const pS =
            index.columnHeightMap.get(
              packGridCoord(parent.col, parent.row - 1),
            ) ?? 0;

          for (let sy = syStart; sy <= syEnd; sy++) {
            if (facadeColumns.length >= maxBudgetCols) break;
            const cMinLat = pMinLat + sy * fineStepLat;
            const cMaxLat = cMinLat + fineStepLat;
            const cLat = (cMinLat + cMaxLat) * 0.5;
            const nN = sy === cellsPerL7 - 1 ? pN : parent.maxH;
            const nS = sy === 0 ? pS : parent.maxH;

            for (let sx = sxStart; sx <= sxEnd; sx++) {
              if (facadeColumns.length >= maxBudgetCols) break;
              const cMinLon = pMinLon + sx * fineStepLon;
              const cMaxLon = cMinLon + fineStepLon;
              const cLon = (cMinLon + cMaxLon) * 0.5;
              const nE = sx === cellsPerL7 - 1 ? pE : parent.maxH;
              const nW = sx === 0 ? pW : parent.maxH;

              pushColumnShellAndCells(
                cMinLon,
                cMaxLon,
                cMinLat,
                cMaxLat,
                cLon,
                cLat,
                parent.maxH,
                nE,
                nW,
                nN,
                nS,
                encodeLv,
                vStepM,
                facadeColumns,
                volCells,
                `sub${encodeLv}`,
              );
            }
          }
        }

        return {
          facadeColumns,
          volCells,
          usedStepLon: fineStepLon,
          usedStepLat: fineStepLat,
        };
      }
      // 若远景下选择固定 L8/L9/L10 且可视柱过多，继续进入对齐聚合路径保证 100% 视口建筑渲染不留空，同时全部严格以 encodeLv 编码
    }

    // 分枝 B: 以 L7 为基元做最小 2^k 聚合（L6 固定=8，其余尽量 1，若视口极广自动按 2/4/8 铺满全视口不丢楼）
    let aggCols = encodeLv === 6 ? 8 : 1;
    if (encodeLv !== 6 && visibleL7Cols.length > maxBudgetCols) {
      while (
        aggCols < 8 &&
        visibleL7Cols.length / (aggCols * aggCols * 0.65) > maxBudgetCols
      ) {
        aggCols *= 2;
      }
    }

    const stepLon = index.stepLon * aggCols;
    const stepLat = index.stepLat * aggCols;
    const aggregatedMap = new Map<
      number,
      { col: number; row: number; maxH: number }
    >();

    for (let i = 0; i < visibleL7Cols.length; i++) {
      const c = visibleL7Cols[i];
      const gCol = Math.floor(c.col / aggCols);
      const gRow = Math.floor(c.row / aggCols);
      const key = packGridCoord(gCol, gRow);
      const prev = aggregatedMap.get(key);
      if (!prev) {
        aggregatedMap.set(key, { col: gCol, row: gRow, maxH: c.maxH });
      } else if (c.maxH > prev.maxH) {
        prev.maxH = c.maxH;
      }
    }

    const sortedCols = Array.from(aggregatedMap.values()).sort((a, b) => {
      const da = distScore(
        BASE_LON_ANCHOR + (a.col + 0.5) * stepLon,
        BASE_LAT_ANCHOR + (a.row + 0.5) * stepLat,
      );
      const db = distScore(
        BASE_LON_ANCHOR + (b.col + 0.5) * stepLon,
        BASE_LAT_ANCHOR + (b.row + 0.5) * stepLat,
      );
      return da - db;
    });

    const limit = Math.min(sortedCols.length, maxBudgetCols);
    for (let i = 0; i < limit; i++) {
      const item = sortedCols[i];
      const cMinLon = BASE_LON_ANCHOR + item.col * stepLon;
      const cMaxLon = cMinLon + stepLon;
      const cMinLat = BASE_LAT_ANCHOR + item.row * stepLat;
      const cMaxLat = cMinLat + stepLat;
      const cLon = (cMinLon + cMaxLon) * 0.5;
      const cLat = (cMinLat + cMaxLat) * 0.5;

      const nE =
        aggregatedMap.get(packGridCoord(item.col + 1, item.row))?.maxH ?? 0;
      const nW =
        aggregatedMap.get(packGridCoord(item.col - 1, item.row))?.maxH ?? 0;
      const nN =
        aggregatedMap.get(packGridCoord(item.col, item.row + 1))?.maxH ?? 0;
      const nS =
        aggregatedMap.get(packGridCoord(item.col, item.row - 1))?.maxH ?? 0;

      pushColumnShellAndCells(
        cMinLon,
        cMaxLon,
        cMinLat,
        cMaxLat,
        cLon,
        cLat,
        item.maxH,
        nE,
        nW,
        nN,
        nS,
        encodeLv,
        vStepM,
        facadeColumns,
        volCells,
        `lv${encodeLv}`,
      );
    }

    return {
      facadeColumns,
      volCells,
      usedStepLon: stepLon,
      usedStepLat: stepLat,
    };
  };

  // =========================================================================
  // 判定当前目标北斗级别：固定模式严格遵从用户选中级别；自适应依据真实视口空间尺度决定
  // =========================================================================
  let targetLevel: GridLevel;
  let labelSuffix: string;

  if (options.lodMode !== "auto") {
    targetLevel = options.lodMode;
    labelSuffix =
      targetLevel === 6
        ? "L6 · 61.8m (固定)"
        : targetLevel === 7
          ? "L7 · 7.73m (固定)"
          : targetLevel === 8
            ? "L8 · 0.97m (固定)"
            : targetLevel === 9
              ? "L9 · 12.1cm (固定)"
              : "L10 · 1.5cm (固定)";
  } else {
    const spanLonM = Math.max(
      1,
      (viewport.maxLon - viewport.minLon) * mPerDegLon,
    );
    const spanLatM = Math.max(
      1,
      (viewport.maxLat - viewport.minLat) * mPerDegLat,
    );
    const targetDist = options.viewTargetDistanceMeters ?? cameraHeightMeters;
    // 取相机真实视距、净空与画面物理跨度三者协调值，彻底杜绝“远看多栋楼却虚报 L9”的问题
    const autoScaleMetric = Math.max(
      effectiveClearance,
      targetDist * 0.65,
      Math.min(spanLonM, spanLatM) * 0.45,
    );

    if (autoScaleMetric > 1600) {
      targetLevel = 6;
      labelSuffix = "L6 · 61.8m 自适应";
    } else if (autoScaleMetric > 140) {
      targetLevel = 7;
      labelSuffix = "L7 · 7.73m 自适应";
    } else if (autoScaleMetric > 22) {
      targetLevel = 8;
      labelSuffix = "L8 · 0.97m 自适应";
    } else if (autoScaleMetric > 3.5) {
      targetLevel = 9;
      labelSuffix = "L9 · 12.1cm 自适应";
    } else {
      targetLevel = 10;
      labelSuffix = "L10 · 1.5cm 自适应";
    }
  }

  const rendered = renderLevelFullFrustum(targetLevel, maxColBudget);
  const activeSpec = getLevelSpec(targetLevel);
  const groundResult = options.includeGroundCarpet
    ? computeSnappedGroundGrid(
        groundBoundsMinLon,
        groundBoundsMaxLon,
        groundBoundsMinLat,
        groundBoundsMaxLat,
        rendered.usedStepLon,
        rendered.usedStepLat,
        targetLevel,
        72,
      )
    : null;

  return {
    cells: rendered.volCells,
    facadeColumns: rendered.facadeColumns,
    groundGrid: groundResult?.spec ?? null,
    groundCellCount: groundResult?.cellCount ?? 0,
    activeLevel: targetLevel,
    activeStepMeters: activeSpec.approxGroundMeters,
    activeLevelLabel: labelSuffix,
  };
}

/**
 * 244Hz 高帧率分块池渲染规划器：
 * - L6/L7/全景模式下仅遍历几百个空间宏块包围盒 (< 0.05ms)，缓存命中块 0 柱体遍历、0 字符串编码
 * - L8/L9/L10 下直接提取纯数值 CompactColumnInput（无 encode2D/encode3D 字符串分配），交由 Worker 构建
 */
export function planMassiveVoxelRenderFrame(
  index: SparseBeidouVoxelIndex,
  viewport: ViewportBounds,
  cameraHeightMeters: number,
  options: {
    voxelStyle: MassiveVoxelStyle;
    lodMode: MassiveVoxelLodMode;
    includeGroundCarpet: boolean;
    minElevationFilterMeters: number;
    elevationThresholds?: ElevationColorThresholds;
    cameraPos?: { lon: number; lat: number };
    cameraHeadingDeg?: number;
    cameraPitchDeg?: number;
    viewTargetDistanceMeters?: number;
  },
): MassiveVoxelRenderPlan {
  const spec7 = getLevelSpec(7);
  const thresholds: ElevationColorThresholds =
    options.elevationThresholds ?? DEFAULT_ELEVATION_THRESHOLDS;
  if (options.voxelStyle === "tileset-only") {
    return {
      voxelStyle: options.voxelStyle,
      activeLevel: 7,
      activeStepMeters: spec7.approxGroundMeters,
      activeLevelLabel: "仅白膜（无体素）",
      elevationThresholds: thresholds,
      groundGrid: null,
      groundCellCount: 0,
      isChunkedMode: true,
      visibleCacheKeys: [],
      resolveChunkColumns: () => [],
      directFineColumns: [],
      estimatedVisibleCols: 0,
    };
  }

  const viewCenterLon = (viewport.minLon + viewport.maxLon) * 0.5;
  const viewCenterLat = (viewport.minLat + viewport.maxLat) * 0.5;
  const camLon = options.cameraPos?.lon ?? viewCenterLon;
  const camLat = options.cameraPos?.lat ?? viewCenterLat;

  const anchorRoofH = Math.max(
    lookupFutianVoxelHeight(index, viewCenterLon, viewCenterLat),
    lookupFutianVoxelHeight(index, camLon, camLat),
  );
  const effectiveClearance = Math.max(
    0.12,
    cameraHeightMeters - Math.min(cameraHeightMeters * 0.85, anchorRoofH * 0.9),
  );

  const useFrustumCull =
    options.cameraHeadingDeg !== undefined &&
    options.cameraPitchDeg !== undefined &&
    options.cameraPitchDeg > -68;
  const headRad = ((options.cameraHeadingDeg ?? 0) * Math.PI) / 180;
  const pitchRad = ((options.cameraPitchDeg ?? -90) * Math.PI) / 180;
  const fwdE = Math.sin(headRad);
  const fwdN = Math.cos(headRad);
  const horizLook = Math.cos(pitchRad);
  const lookE = fwdE * horizLook;
  const lookN = fwdN * horizLook;
  const lookU = Math.sin(pitchRad);
  const cosCamLat = Math.max(0.25, Math.cos((camLat * Math.PI) / 180));
  const mPerDegLon = 111320 * cosCamLat;
  const mPerDegLat = 110740;

  const isInFrustum = (lon: number, lat: number, padMeters = 90): boolean => {
    if (!useFrustumCull) return true;
    const dx = (lon - camLon) * mPerDegLon;
    const dy = (lat - camLat) * mPerDegLat;
    const fwd = dx * fwdE + dy * fwdN;
    if (fwd < -padMeters) return false;
    const side = Math.abs(dx * fwdN - dy * fwdE);
    return side <= Math.max(260, fwd * 1.28 + padMeters * 2);
  };

  /**
   * 计算柱体相对于三维相机光心的真实欧氏距离与优先级分数：
   * 细化中心严格锁定相机前景（近密远疏），杜绝低俯仰角时向远方地平线漂移，并抑制相机背后不可见柱抢占近景名额。
   */
  const computeColumnCameraMetrics = (
    lon: number,
    lat: number,
    roofH: number,
  ): { dist3DMeters: number; score: number } => {
    const dx = (lon - camLon) * mPerDegLon;
    const dy = (lat - camLat) * mPerDegLat;
    const targetZ = Math.min(roofH, cameraHeightMeters);
    const dz = Math.max(0, cameraHeightMeters - targetZ);
    const dist3DSq = dx * dx + dy * dy + dz * dz;
    const dist3DMeters = Math.sqrt(dist3DSq);

    if (!useFrustumCull) {
      return { dist3DMeters, score: dist3DSq };
    }

    const depthTop =
      dx * lookE + dy * lookN + (roofH - cameraHeightMeters) * lookU;
    const depthBase = dx * lookE + dy * lookN + (0 - cameraHeightMeters) * lookU;
    const maxDepth = Math.max(depthTop, depthBase);
    if (maxDepth <= 8) {
      return { dist3DMeters, score: dist3DSq + 1e12 };
    }

    const side = Math.abs(dx * fwdN - dy * fwdE);
    const angleRatio = side / Math.max(30, maxDepth);
    return {
      dist3DMeters,
      score: dist3DSq * (1 + 0.4 * angleRatio * angleRatio),
    };
  };

  let targetLevel: GridLevel;
  let labelSuffix: string;
  if (options.lodMode !== "auto") {
    targetLevel = options.lodMode;
    labelSuffix =
      targetLevel === 6
        ? "L6 · 61.8m (固定)"
        : targetLevel === 7
          ? "L7 · 7.73m (固定)"
          : targetLevel === 8
            ? "L8 · 0.97m (固定)"
            : targetLevel === 9
              ? "L9 · 12.1cm (固定)"
              : "L10 · 1.5cm (固定)";
  } else {
    const spanLonM = Math.max(
      1,
      (viewport.maxLon - viewport.minLon) * mPerDegLon,
    );
    const spanLatM = Math.max(
      1,
      (viewport.maxLat - viewport.minLat) * mPerDegLat,
    );
    const targetDist = options.viewTargetDistanceMeters ?? cameraHeightMeters;
    const autoScaleMetric = Math.max(
      effectiveClearance,
      targetDist * 0.65,
      Math.min(spanLonM, spanLatM) * 0.45,
    );
    if (autoScaleMetric > 1600) {
      targetLevel = 6;
      labelSuffix = "L6 · 61.8m 自适应";
    } else if (autoScaleMetric > 140) {
      targetLevel = 7;
      labelSuffix = "L7 · 7.73m 自适应";
    } else if (autoScaleMetric > 22) {
      targetLevel = 8;
      labelSuffix = "L8 · 0.97m 自适应";
    } else if (autoScaleMetric > 3.5) {
      targetLevel = 9;
      labelSuffix = "L9 · 12.1cm 自适应";
    } else {
      targetLevel = 10;
      labelSuffix = "L10 · 1.5cm 自适应";
    }
  }

  const roiMinLon = Math.max(index.bounds.minLon, viewport.minLon);
  const roiMaxLon = Math.min(index.bounds.maxLon, viewport.maxLon);
  const roiMinLat = Math.max(index.bounds.minLat, viewport.minLat);
  const roiMaxLat = Math.min(index.bounds.maxLat, viewport.maxLat);

  const catFromH = (h: number): GridCellCategory =>
    h < thresholds[0]
      ? "conformal-low"
      : h < thresholds[1]
        ? "conformal-mid"
        : h < thresholds[2]
          ? "conformal-high"
          : "conformal-super";

  const makeColumnInput = (
    col: number,
    row: number,
    cMinLon: number,
    cMaxLon: number,
    cMinLat: number,
    cMaxLat: number,
    maxH: number,
    nE: number,
    nW: number,
    nN: number,
    nS: number,
    vStepM: number,
  ): CompactColumnInput => {
    const minNB = Math.min(nE, nW, nN, nS);
    const roofClearance =
      vStepM >= 5 ? 0.55 : vStepM >= 1 ? 0.24 : vStepM >= 0.15 ? 0.08 : 0.03;
    const roofHeight =
      Math.max(vStepM, Math.ceil(maxH / vStepM) * vStepM) + roofClearance;
    const baseHeight = Math.max(0, Math.floor(minNB / vStepM) * vStepM);
    return {
      col,
      row,
      minLon: cMinLon,
      maxLon: cMaxLon,
      minLat: cMinLat,
      maxLat: cMaxLat,
      maxH,
      baseHeight,
      roofHeight,
      layerStepMeters: vStepM,
      exposedE: maxH > nE + 0.08,
      exposedW: maxH > nW + 0.08,
      exposedN: maxH > nN + 0.08,
      exposedS: maxH > nS + 0.08,
      neighborHE: nE,
      neighborHW: nW,
      neighborHN: nN,
      neighborHS: nS,
      category: catFromH(maxH),
    };
  };

  const activeSpec = getLevelSpec(targetLevel);

  // 分支 1：L6 / L7 —— 局部视口 (<= 220 宏块且原生 L7) 走持久化缓存池；全景/远景或 L6 直接走全城合批（仅 2 次 DrawCall 稳跑 240 FPS）
  if (targetLevel <= 7 && roiMinLon < roiMaxLon && roiMinLat < roiMaxLat) {
    const visibleChunks: Array<{ chunk: SparseVoxelChunk; score: number }> = [];
    let rawL7Sum = 0;

    for (let i = 0; i < index.chunks.length; i++) {
      const ch = index.chunks[i];
      if (
        ch.maxLon < roiMinLon ||
        ch.minLon > roiMaxLon ||
        ch.maxLat < roiMinLat ||
        ch.minLat > roiMaxLat
      ) {
        continue;
      }
      if (ch.maxRoofH < options.minElevationFilterMeters) continue;
      const cx = (ch.minLon + ch.maxLon) * 0.5;
      const cy = (ch.minLat + ch.maxLat) * 0.5;
      if (!isInFrustum(cx, cy, 260)) continue;
      visibleChunks.push({
        chunk: ch,
        score: computeColumnCameraMetrics(cx, cy, ch.maxRoofH).score,
      });
      rawL7Sum += ch.columns.length;
    }

    const maxBudget = options.voxelStyle === "conformal-white" ? 18000 : 12000;
    let aggCols = targetLevel === 6 ? 8 : 1;
    if (targetLevel === 7 && rawL7Sum > maxBudget) {
      while (aggCols < 8 && rawL7Sum / (aggCols * aggCols * 0.65) > maxBudget) {
        aggCols *= 2;
      }
    }

    const vStepM = targetLevel === 6 ? 30.92 : spec7.heightResolutionMeters;
    const stepLon = index.stepLon * aggCols;
    const stepLat = index.stepLat * aggCols;

    // 远景全景合批通道：当 L6 或宏块数量 > 220 或存在聚集降采样时，合并为单一 Worker 批次（仅 2 DrawCall 解决千块 DrawCall 卡顿）
    if (targetLevel === 6 || visibleChunks.length > 220 || aggCols > 1) {
      const batchColumns: CompactColumnInput[] = [];
      if (aggCols >= 8) {
        const macro = getOrBuildL6MacroLayer(index);
        for (let i = 0; i < macro.cols.length; i++) {
          const item = macro.cols[i];
          if (item.maxH < options.minElevationFilterMeters) continue;
          const cMinLon = BASE_LON_ANCHOR + item.col * stepLon;
          const cMinLat = BASE_LAT_ANCHOR + item.row * stepLat;
          if (
            cMinLon + stepLon < roiMinLon ||
            cMinLon > roiMaxLon ||
            cMinLat + stepLat < roiMinLat ||
            cMinLat > roiMaxLat
          ) {
            continue;
          }
          const cx = cMinLon + stepLon * 0.5;
          const cy = cMinLat + stepLat * 0.5;
          if (!isInFrustum(cx, cy, 240)) continue;
          batchColumns.push(
            makeColumnInput(
              item.col,
              item.row,
              cMinLon,
              cMinLon + stepLon,
              cMinLat,
              cMinLat + stepLat,
              item.maxH,
              macro.heightMap.get(packGridCoord(item.col + 1, item.row)) ?? 0,
              macro.heightMap.get(packGridCoord(item.col - 1, item.row)) ?? 0,
              macro.heightMap.get(packGridCoord(item.col, item.row + 1)) ?? 0,
              macro.heightMap.get(packGridCoord(item.col, item.row - 1)) ?? 0,
              vStepM,
            ),
          );
        }
      } else if (aggCols === 1) {
        visibleChunks.sort((a, b) => a.score - b.score);
        for (let ci = 0; ci < visibleChunks.length && batchColumns.length < maxBudget; ci++) {
          const cols = visibleChunks[ci].chunk.columns;
          for (let i = 0; i < cols.length && batchColumns.length < maxBudget; i++) {
            const c = cols[i];
            if (c.maxH < options.minElevationFilterMeters) continue;
            const cMinLon = BASE_LON_ANCHOR + c.col * stepLon;
            const cMinLat = BASE_LAT_ANCHOR + c.row * stepLat;
            if (
              cMinLon + stepLon < roiMinLon ||
              cMinLon > roiMaxLon ||
              cMinLat + stepLat < roiMinLat ||
              cMinLat > roiMaxLat
            ) {
              continue;
            }
            batchColumns.push(
              makeColumnInput(
                c.col,
                c.row,
                cMinLon,
                cMinLon + stepLon,
                cMinLat,
                cMinLat + stepLat,
                c.maxH,
                index.columnHeightMap.get(packGridCoord(c.col + 1, c.row)) ?? 0,
                index.columnHeightMap.get(packGridCoord(c.col - 1, c.row)) ?? 0,
                index.columnHeightMap.get(packGridCoord(c.col, c.row + 1)) ?? 0,
                index.columnHeightMap.get(packGridCoord(c.col, c.row - 1)) ?? 0,
                vStepM,
              ),
            );
          }
        }
      } else {
        const aggMap = new Map<
          number,
          { col: number; row: number; maxH: number }
        >();
        for (let ci = 0; ci < visibleChunks.length; ci++) {
          const cols = visibleChunks[ci].chunk.columns;
          for (let i = 0; i < cols.length; i++) {
            const c = cols[i];
            if (c.maxH < options.minElevationFilterMeters) continue;
            const gCol = Math.floor(c.col / aggCols);
            const gRow = Math.floor(c.row / aggCols);
            const pk = packGridCoord(gCol, gRow);
            const prev = aggMap.get(pk);
            if (!prev) aggMap.set(pk, { col: gCol, row: gRow, maxH: c.maxH });
            else if (c.maxH > prev.maxH) prev.maxH = c.maxH;
          }
        }
        for (const item of aggMap.values()) {
          if (batchColumns.length >= maxBudget) break;
          const cMinLon = BASE_LON_ANCHOR + item.col * stepLon;
          const cMinLat = BASE_LAT_ANCHOR + item.row * stepLat;
          batchColumns.push(
            makeColumnInput(
              item.col,
              item.row,
              cMinLon,
              cMinLon + stepLon,
              cMinLat,
              cMinLat + stepLat,
              item.maxH,
              aggMap.get(packGridCoord(item.col + 1, item.row))?.maxH ?? 0,
              aggMap.get(packGridCoord(item.col - 1, item.row))?.maxH ?? 0,
              aggMap.get(packGridCoord(item.col, item.row + 1))?.maxH ?? 0,
              aggMap.get(packGridCoord(item.col, item.row - 1))?.maxH ?? 0,
              vStepM,
            ),
          );
        }
      }

      const groundResult = options.includeGroundCarpet
        ? computeSnappedGroundGrid(
            viewport.minLon,
            viewport.maxLon,
            viewport.minLat,
            viewport.maxLat,
            stepLon,
            stepLat,
            targetLevel,
            72,
          )
        : null;

      return {
        voxelStyle: options.voxelStyle,
        activeLevel: targetLevel,
        activeStepMeters: activeSpec.approxGroundMeters,
        activeLevelLabel: labelSuffix,
        elevationThresholds: thresholds,
        groundGrid: groundResult?.spec ?? null,
        groundCellCount: groundResult?.cellCount ?? 0,
        isChunkedMode: false,
        visibleCacheKeys: [],
        resolveChunkColumns: () => [],
        directFineColumns: batchColumns,
        estimatedVisibleCols: batchColumns.length,
      };
    }

    visibleChunks.sort((a, b) => a.score - b.score);

    const minElev = Math.round(options.minElevationFilterMeters);
    const tKey = `${thresholds[0]}_${thresholds[1]}_${thresholds[2]}`;
    const cachePrefix = `${options.voxelStyle === "conformal-white" ? "W" : "V"}|L${targetLevel}|a${aggCols}|m${minElev}|t${tKey}|`;

    const chunkByCacheKey = new Map<string, SparseVoxelChunk>();
    const visibleCacheKeys: string[] = new Array(visibleChunks.length);
    for (let i = 0; i < visibleChunks.length; i++) {
      const key = cachePrefix + visibleChunks[i].chunk.key;
      visibleCacheKeys[i] = key;
      chunkByCacheKey.set(key, visibleChunks[i].chunk);
    }

    const resolveChunkColumns = (cacheKey: string): CompactColumnInput[] => {
      const ch = chunkByCacheKey.get(cacheKey);
      if (!ch) return [];

      if (aggCols === 1) {
        const out: CompactColumnInput[] = [];
        for (let i = 0; i < ch.columns.length; i++) {
          const c = ch.columns[i];
          if (c.maxH < options.minElevationFilterMeters) continue;
          const cMinLon = BASE_LON_ANCHOR + c.col * stepLon;
          const cMinLat = BASE_LAT_ANCHOR + c.row * stepLat;
          const nE =
            index.columnHeightMap.get(packGridCoord(c.col + 1, c.row)) ?? 0;
          const nW =
            index.columnHeightMap.get(packGridCoord(c.col - 1, c.row)) ?? 0;
          const nN =
            index.columnHeightMap.get(packGridCoord(c.col, c.row + 1)) ?? 0;
          const nS =
            index.columnHeightMap.get(packGridCoord(c.col, c.row - 1)) ?? 0;
          out.push(
            makeColumnInput(
              c.col,
              c.row,
              cMinLon,
              cMinLon + stepLon,
              cMinLat,
              cMinLat + stepLat,
              c.maxH,
              nE,
              nW,
              nN,
              nS,
              vStepM,
            ),
          );
        }
        return out;
      }

      // aggCols > 1 (如 L6 61.8m): 将该 Chunk 内列按 L6 网格聚合，并查询全局相邻聚合格最大高度防跨块接缝
      const aggMap = new Map<
        number,
        { col: number; row: number; maxH: number }
      >();
      for (let i = 0; i < ch.columns.length; i++) {
        const c = ch.columns[i];
        if (c.maxH < options.minElevationFilterMeters) continue;
        const gCol = Math.floor(c.col / aggCols);
        const gRow = Math.floor(c.row / aggCols);
        const pk = packGridCoord(gCol, gRow);
        const prev = aggMap.get(pk);
        if (!prev) aggMap.set(pk, { col: gCol, row: gRow, maxH: c.maxH });
        else if (c.maxH > prev.maxH) prev.maxH = c.maxH;
      }

      const probeAggMax = (gCol: number, gRow: number): number => {
        const local = aggMap.get(packGridCoord(gCol, gRow));
        if (local) return local.maxH;
        const baseC = gCol * aggCols;
        const baseR = gRow * aggCols;
        let maxNB = 0;
        const probeStep = Math.max(1, Math.floor(aggCols / 2));
        for (let r = 0; r < aggCols; r += probeStep) {
          for (let c = 0; c < aggCols; c += probeStep) {
            const h =
              index.columnHeightMap.get(packGridCoord(baseC + c, baseR + r)) ??
              0;
            if (h > maxNB) maxNB = h;
          }
        }
        return maxNB;
      };

      const out: CompactColumnInput[] = [];
      for (const item of aggMap.values()) {
        const cMinLon = BASE_LON_ANCHOR + item.col * stepLon;
        const cMinLat = BASE_LAT_ANCHOR + item.row * stepLat;
        out.push(
          makeColumnInput(
            item.col,
            item.row,
            cMinLon,
            cMinLon + stepLon,
            cMinLat,
            cMinLat + stepLat,
            item.maxH,
            probeAggMax(item.col + 1, item.row),
            probeAggMax(item.col - 1, item.row),
            probeAggMax(item.col, item.row + 1),
            probeAggMax(item.col, item.row - 1),
            vStepM,
          ),
        );
      }
      return out;
    };

    const groundResult = options.includeGroundCarpet
      ? computeSnappedGroundGrid(
          viewport.minLon,
          viewport.maxLon,
          viewport.minLat,
          viewport.maxLat,
          stepLon,
          stepLat,
          targetLevel,
          72,
        )
      : null;

    return {
      voxelStyle: options.voxelStyle,
      activeLevel: targetLevel,
      activeStepMeters: activeSpec.approxGroundMeters,
      activeLevelLabel: labelSuffix,
      elevationThresholds: thresholds,
      groundGrid: groundResult?.spec ?? null,
      groundCellCount: groundResult?.cellCount ?? 0,
      isChunkedMode: true,
      visibleCacheKeys,
      resolveChunkColumns,
      directFineColumns: [],
      estimatedVisibleCols:
        aggCols === 1
          ? rawL7Sum
          : Math.round(rawL7Sum / (aggCols * aggCols * 0.55)),
    };
  }

  // 分支 2：L8 / L9 / L10 近景全精度 + 天际线近密远稳分级细化（先筛排前景 180 宏块，避免高空全量遍历排序 26.8 万柱）
  const vStepFine = activeSpec.heightResolutionMeters * 2;
  const vStepCoarse = spec7.heightResolutionMeters;
  const visibleL7Cols: Array<{
    col: number;
    row: number;
    maxH: number;
    dist3DMeters: number;
    score: number;
  }> = [];
  const nearChunkKeySet = new Set<string>();
  let usedMacroFallbackHorizon = false;

  if (roiMinLon < roiMaxLon && roiMinLat < roiMaxLat) {
    const visibleChunkList: Array<{ chunk: SparseVoxelChunk; score: number }> =
      [];
    for (let i = 0; i < index.chunks.length; i++) {
      const chunk = index.chunks[i];
      if (
        chunk.maxLon < roiMinLon ||
        chunk.minLon > roiMaxLon ||
        chunk.maxLat < roiMinLat ||
        chunk.minLat > roiMaxLat
      ) {
        continue;
      }
      if (chunk.maxRoofH < options.minElevationFilterMeters) continue;
      const cx = (chunk.minLon + chunk.maxLon) * 0.5;
      const cy = (chunk.minLat + chunk.maxLat) * 0.5;
      const frustumPad = Math.max(
        360,
        Math.min(1800, Math.max(0, cameraHeightMeters) * 0.35 + 240),
      );
      if (!isInFrustum(cx, cy, frustumPad)) continue;
      visibleChunkList.push({
        chunk,
        score: computeColumnCameraMetrics(cx, cy, chunk.maxRoofH).score,
      });
    }

    const colFrustumPad = Math.max(
      360,
      Math.min(1800, Math.max(0, cameraHeightMeters) * 0.35 + 240),
    );
    let totalVisibleChunkCols = 0;
    for (let i = 0; i < visibleChunkList.length; i++) {
      totalVisibleChunkCols += visibleChunkList[i].chunk.columns.length;
    }

    const NEAR_CHUNK_LIMIT = 180;
    const NEAR_COL_LIMIT = 6500;
    const extractChunks =
      visibleChunkList.length > NEAR_CHUNK_LIMIT || totalVisibleChunkCols > NEAR_COL_LIMIT
        ? (() => {
            visibleChunkList.sort((a, b) => a.score - b.score);
            const picked: typeof visibleChunkList = [];
            let colAcc = 0;
            for (let i = 0; i < visibleChunkList.length && picked.length < NEAR_CHUNK_LIMIT; i++) {
              const item = visibleChunkList[i];
              const nextCols = item.chunk.columns.length;
              if (picked.length > 0 && colAcc + nextCols > NEAR_COL_LIMIT) {
                break;
              }
              picked.push(item);
              colAcc += nextCols;
            }
            if (picked.length < visibleChunkList.length) {
              usedMacroFallbackHorizon = true;
            }
            return picked;
          })()
        : visibleChunkList;

    for (let ci = 0; ci < extractChunks.length; ci++) {
      const ch = extractChunks[ci].chunk;
      if (usedMacroFallbackHorizon) {
        nearChunkKeySet.add(ch.key);
      }
      for (let i = 0; i < ch.columns.length; i++) {
        const c = ch.columns[i];
        if (c.maxH < options.minElevationFilterMeters) continue;
        const cMinLon = BASE_LON_ANCHOR + c.col * index.stepLon;
        const cMinLat = BASE_LAT_ANCHOR + c.row * index.stepLat;
        if (
          cMinLon + index.stepLon < roiMinLon ||
          cMinLon > roiMaxLon ||
          cMinLat + index.stepLat < roiMinLat ||
          cMinLat > roiMaxLat
        ) {
          continue;
        }
        const cx = cMinLon + index.stepLon * 0.5;
        const cy = cMinLat + index.stepLat * 0.5;
        if (!isInFrustum(cx, cy, colFrustumPad)) continue;
        const m = computeColumnCameraMetrics(cx, cy, c.maxH);
        visibleL7Cols.push({
          col: c.col,
          row: c.row,
          maxH: c.maxH,
          dist3DMeters: m.dist3DMeters,
          score: m.score,
        });
      }
    }
  }

  const directFineColumns: CompactColumnInput[] = [];
  let logicalVisibleCols = 0;

  if (visibleL7Cols.length > 0) {
    visibleL7Cols.sort((a, b) => a.score - b.score);

    const subFactor = 8 ** (targetLevel - 7); // L8=8, L9=64, L10=512
    const FULL_SPAN_SUB_BUDGET = 140_000;
    const countIntersectSubCols = (cellsPerSide: number, limit: number): number => {
      const sLon = index.stepLon / cellsPerSide;
      const sLat = index.stepLat / cellsPerSide;
      let total = 0;
      for (let i = 0; i < visibleL7Cols.length; i++) {
        const p = visibleL7Cols[i];
        const pMinLon = BASE_LON_ANCHOR + p.col * index.stepLon;
        const pMinLat = BASE_LAT_ANCHOR + p.row * index.stepLat;
        const sx0 = Math.max(0, Math.floor((roiMinLon - pMinLon) / sLon));
        const sx1 = Math.min(
          cellsPerSide - 1,
          Math.floor((roiMaxLon - pMinLon) / sLon),
        );
        const sy0 = Math.max(0, Math.floor((roiMinLat - pMinLat) / sLat));
        const sy1 = Math.min(
          cellsPerSide - 1,
          Math.floor((roiMaxLat - pMinLat) / sLat),
        );
        if (sx1 >= sx0 && sy1 >= sy0) {
          total += (sx1 - sx0 + 1) * (sy1 - sy0 + 1);
          if (total > limit) return total;
        }
      }
      return total;
    };

    const pushParentWithSubDiv = (
      parent: { col: number; row: number; maxH: number },
      subDiv: number,
    ) => {
      const pMinLon = BASE_LON_ANCHOR + parent.col * index.stepLon;
      const pMinLat = BASE_LAT_ANCHOR + parent.row * index.stepLat;
      const sLon = index.stepLon / subDiv;
      const sLat = index.stepLat / subDiv;
      const sx0 = Math.max(0, Math.floor((roiMinLon - pMinLon) / sLon));
      const sx1 = Math.min(subDiv - 1, Math.floor((roiMaxLon - pMinLon) / sLon));
      const sy0 = Math.max(0, Math.floor((roiMinLat - pMinLat) / sLat));
      const sy1 = Math.min(subDiv - 1, Math.floor((roiMaxLat - pMinLat) / sLat));
      if (sx1 < sx0 || sy1 < sy0) return;

      const pE =
        index.columnHeightMap.get(packGridCoord(parent.col + 1, parent.row)) ?? 0;
      const pW =
        index.columnHeightMap.get(packGridCoord(parent.col - 1, parent.row)) ?? 0;
      const pN =
        index.columnHeightMap.get(packGridCoord(parent.col, parent.row + 1)) ?? 0;
      const pS =
        index.columnHeightMap.get(packGridCoord(parent.col, parent.row - 1)) ?? 0;

      const stepZ =
        subDiv >= 8
          ? vStepFine
          : subDiv >= 4
            ? Math.max(vStepFine, spec7.heightResolutionMeters * 0.5)
            : vStepCoarse;
      const colInput = makeColumnInput(
        parent.col,
        parent.row,
        pMinLon,
        pMinLon + index.stepLon,
        pMinLat,
        pMinLat + index.stepLat,
        parent.maxH,
        pE,
        pW,
        pN,
        pS,
        stepZ,
      );
      if (subDiv > 1) {
        colInput.subDiv = subDiv;
        colInput.sxStart = sx0;
        colInput.sxEnd = sx1;
        colInput.syStart = sy0;
        colInput.syEnd = sy1;
      }
      directFineColumns.push(colInput);
      logicalVisibleCols += (sx1 - sx0 + 1) * (sy1 - sy0 + 1);
    };

    const fullExactCount =
      !usedMacroFallbackHorizon && visibleL7Cols.length <= 2200
        ? countIntersectSubCols(subFactor, FULL_SPAN_SUB_BUDGET)
        : FULL_SPAN_SUB_BUDGET + 1;

    if (fullExactCount <= FULL_SPAN_SUB_BUDGET) {
      // 贴近建筑或局部视窗：100% 全部视口建筑以完整 1:1 L8/L9/L10 细分展开
      for (let i = 0; i < visibleL7Cols.length; i++) {
        pushParentWithSubDiv(visibleL7Cols[i], subFactor);
      }
    } else {
      // 中高空城市场景：严格以三维相机物理距离由近及远逐级细化，已按完整宏块截断确保无漏柱，远景无缝衔接到 L6
      const nearLimit = visibleL7Cols.length;
      for (let i = 0; i < nearLimit; i++) {
        const colItem = visibleL7Cols[i];
        const d3d = colItem.dist3DMeters;
        const readableCap =
          d3d <= 40
            ? 512
            : d3d <= 125
              ? 64
              : d3d <= 240
                ? 32
                : d3d <= 460
                  ? 16
                  : d3d <= 900
                    ? 8
                    : d3d <= 1550
                      ? 4
                      : 2;

        let tierSub = 1;
        if (targetLevel === 8) {
          tierSub =
            i < 220 && d3d <= 680
              ? 8
              : i < 650 && d3d <= 1250
                ? 4
                : i < 1400
                  ? 2
                  : 1;
        } else if (targetLevel === 9) {
          tierSub =
            i < 16 && d3d <= 120
              ? 64
              : i < 56 && d3d <= 220
                ? 32
                : i < 180 && d3d <= 360
                  ? 16
                  : i < 480 && d3d <= 720
                    ? 8
                    : i < 1050 && d3d <= 1350
                      ? 4
                      : i < 1800
                        ? 2
                        : 1;
        } else {
          tierSub =
            i < 4 && d3d <= 45
              ? 512
              : i < 18 && d3d <= 145
                ? 64
                : i < 72 && d3d <= 260
                  ? 32
                  : i < 260 && d3d <= 480
                    ? 16
                    : i < 640 && d3d <= 920
                      ? 8
                      : i < 1300 && d3d <= 1600
                        ? 4
                        : 1;
        }
        const subDiv = Math.min(tierSub, readableCap);
        pushParentWithSubDiv(colItem, subDiv);
      }

      // 极大视角全景：已优先截取近景 180 宏块做细化，外围远景直接读取 L6 汇总金字塔，彻底告别 26.8 万柱全量排序
      if (usedMacroFallbackHorizon) {
        const macro = getOrBuildL6MacroLayer(index);
        const macroFrustumPad = Math.max(
          360,
          Math.min(1800, Math.max(0, cameraHeightMeters) * 0.35 + 240),
        );
        const l6StepLon = index.stepLon * 8;
        const l6StepLat = index.stepLat * 8;
        for (let i = 0; i < macro.cols.length; i++) {
          const item = macro.cols[i];
          if (item.maxH < options.minElevationFilterMeters) continue;
          const parentChunkKey = `${Math.floor(item.col / 2)}_${Math.floor(item.row / 2)}`;
          if (nearChunkKeySet.has(parentChunkKey)) continue;
          const cMinLon = BASE_LON_ANCHOR + item.col * l6StepLon;
          const cMinLat = BASE_LAT_ANCHOR + item.row * l6StepLat;
          if (
            cMinLon + l6StepLon < roiMinLon ||
            cMinLon > roiMaxLon ||
            cMinLat + l6StepLat < roiMinLat ||
            cMinLat > roiMaxLat
          ) {
            continue;
          }
          if (!isInFrustum(cMinLon + l6StepLon * 0.5, cMinLat + l6StepLat * 0.5, macroFrustumPad)) {
            continue;
          }
          directFineColumns.push(
            makeColumnInput(
              item.col,
              item.row,
              cMinLon,
              cMinLon + l6StepLon,
              cMinLat,
              cMinLat + l6StepLat,
              item.maxH,
              macro.heightMap.get(packGridCoord(item.col + 1, item.row)) ?? 0,
              macro.heightMap.get(packGridCoord(item.col - 1, item.row)) ?? 0,
              macro.heightMap.get(packGridCoord(item.col, item.row + 1)) ?? 0,
              macro.heightMap.get(packGridCoord(item.col, item.row - 1)) ?? 0,
              vStepCoarse,
            ),
          );
          logicalVisibleCols += 1;
        }
      } else if (visibleL7Cols.length > nearLimit) {
        const farCols = visibleL7Cols.slice(nearLimit);
        let aggCols = 2;
        while (aggCols < 8 && farCols.length / (aggCols * aggCols * 0.65) > 2500) {
          aggCols *= 2;
        }
        const farStepLon = index.stepLon * aggCols;
        const farStepLat = index.stepLat * aggCols;
        const aggMap = new Map<
          number,
          { col: number; row: number; maxH: number }
        >();
        for (let i = 0; i < farCols.length; i++) {
          const c = farCols[i];
          const gCol = Math.floor(c.col / aggCols);
          const gRow = Math.floor(c.row / aggCols);
          const pk = packGridCoord(gCol, gRow);
          const prev = aggMap.get(pk);
          if (!prev) aggMap.set(pk, { col: gCol, row: gRow, maxH: c.maxH });
          else if (c.maxH > prev.maxH) prev.maxH = c.maxH;
        }
        for (const item of aggMap.values()) {
          const cMinLon = BASE_LON_ANCHOR + item.col * farStepLon;
          const cMinLat = BASE_LAT_ANCHOR + item.row * farStepLat;
          directFineColumns.push(
            makeColumnInput(
              item.col,
              item.row,
              cMinLon,
              cMinLon + farStepLon,
              cMinLat,
              cMinLat + farStepLat,
              item.maxH,
              aggMap.get(packGridCoord(item.col + 1, item.row))?.maxH ?? 0,
              aggMap.get(packGridCoord(item.col - 1, item.row))?.maxH ?? 0,
              aggMap.get(packGridCoord(item.col, item.row + 1))?.maxH ?? 0,
              aggMap.get(packGridCoord(item.col, item.row - 1))?.maxH ?? 0,
              vStepCoarse,
            ),
          );
          logicalVisibleCols += 1;
        }
      }
    }
  }

  const groundDiv = 8 ** (targetLevel - 7);
  const groundMaxAxis = targetLevel === 8 ? 156 : targetLevel === 9 ? 300 : 460;
  const groundElevM =
    cameraHeightMeters > 35 ? 0.65 : targetLevel >= 10 ? 0.04 : 0.12;
  const groundResult = options.includeGroundCarpet
    ? computeSnappedGroundGrid(
        viewport.minLon,
        viewport.maxLon,
        viewport.minLat,
        viewport.maxLat,
        index.stepLon / groundDiv,
        index.stepLat / groundDiv,
        targetLevel,
        groundMaxAxis,
        groundElevM,
      )
    : null;

  return {
    voxelStyle: options.voxelStyle,
    activeLevel: targetLevel,
    activeStepMeters: activeSpec.approxGroundMeters,
    activeLevelLabel: labelSuffix,
    elevationThresholds: thresholds,
    groundGrid: groundResult?.spec ?? null,
    groundCellCount: groundResult?.cellCount ?? 0,
    isChunkedMode: false,
    visibleCacheKeys: [],
    resolveChunkColumns: () => [],
    directFineColumns,
    estimatedVisibleCols: logicalVisibleCols,
    triPool: index.triPool,
  };
}

/**
 * 若当前需要手动同步更新已选网格或查询单点编码是否命中福田建筑物柱体
 */
export function lookupFutianVoxelHeight(
  index: SparseBeidouVoxelIndex,
  lon: number,
  lat: number,
): number {
  const col = Math.floor((lon - BASE_LON_ANCHOR) / index.stepLon);
  const row = Math.floor((lat - BASE_LAT_ANCHOR) / index.stepLat);
  return index.columnHeightMap.get(packGridCoord(col, row)) ?? 0;
}
