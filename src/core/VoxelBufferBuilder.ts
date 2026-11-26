import {
  DEFAULT_ELEVATION_THRESHOLDS,
  type ElevationColorThresholds,
  type GridCellCategory,
  type GridLevel,
} from '../types/beidou';

const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;
const DEG_TO_RAD = Math.PI / 180;

export interface CompactColumnInput {
  col: number;
  row: number;
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  maxH: number;
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
  /** 可选：该父柱体内部按 subDiv x subDiv 进行原位细分（由 Worker 直接展开为连续横纵线与外立面竖棱） */
  subDiv?: number;
  sxStart?: number;
  sxEnd?: number;
  syStart?: number;
  syEnd?: number;
}

export interface CompactGroundGridInput {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  stepLon: number;
  stepLat: number;
  elevationMeters: number;
  level: GridLevel;
}

export interface LineGeometryBuffers {
  positions: Float64Array;
  indices: Uint16Array | Uint32Array;
  boundingCenter: [number, number, number];
  boundingRadius: number;
}

export interface MergedBoxSpec {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  minHeight: number;
  maxHeight: number;
  category: GridCellCategory;
}

export interface ChunkGeometryPayload {
  chunkKey: string;
  facadeLines: LineGeometryBuffers | null;
  roofLines: LineGeometryBuffers | null;
  boxMatrices: Float64Array | null;
  boxCategories: GridCellCategory[];
  boxCount: number;
  occupiedColCount?: number;
}

export interface CompactTrianglePool {
  /** 每个三角面 9 个 Int32 (相对锚点 113.5, 22.0 的 1e-9 度经纬偏置 + 毫米高程) */
  triData: Int32Array;
  triCount: number;
  chunkKeys: string[];
  chunkOffsets: Uint32Array;
  chunkTriIndices: Uint32Array;
}

export interface RuntimeTriangleLookup {
  triData: Int32Array;
  triCount: number;
  chunkKeyToIdx: Map<string, number>;
  chunkOffsets: Uint32Array;
  chunkTriIndices: Uint32Array;
}

export function createRuntimeTriangleLookup(
  pool: CompactTrianglePool,
): RuntimeTriangleLookup {
  const chunkKeyToIdx = new Map<string, number>();
  for (let i = 0; i < pool.chunkKeys.length; i++) {
    chunkKeyToIdx.set(pool.chunkKeys[i], i);
  }
  return {
    triData: pool.triData,
    triCount: pool.triCount,
    chunkKeyToIdx,
    chunkOffsets: pool.chunkOffsets,
    chunkTriIndices: pool.chunkTriIndices,
  };
}

export function lonLatHeightToEcef(
  lonDeg: number,
  latDeg: number,
  heightMeters: number,
): [number, number, number] {
  const lat = latDeg * DEG_TO_RAD;
  const lon = lonDeg * DEG_TO_RAD;
  const sinLat = Math.sin(lat);
  const cosLat = Math.cos(lat);
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const cosLon = Math.cos(lon);
  const sinLon = Math.sin(lon);
  const r = (N + heightMeters) * cosLat;
  return [
    r * cosLon,
    r * sinLon,
    (N * (1 - WGS84_E2) + heightMeters) * sinLat,
  ];
}

/**
 * 计算柱体（或合并长方体）从 WGS84 到 ECEF 的 4x4 列主序模型矩阵，在 Worker 线程完成全部三角计算
 */
export function computeEnuBoxModelMatrix(
  minLon: number,
  maxLon: number,
  minLat: number,
  maxLat: number,
  minHeight: number,
  maxHeight: number,
  out: Float64Array,
  offset: number,
): void {
  const cLon = (minLon + maxLon) * 0.5;
  const cLat = (minLat + maxLat) * 0.5;
  const cH = (minHeight + maxHeight) * 0.5;
  const heightSpan = Math.max(0.015, maxHeight - minHeight);

  const latRad = cLat * DEG_TO_RAD;
  const lonRad = cLon * DEG_TO_RAD;
  const sinLat = Math.sin(latRad);
  const cosLat = Math.cos(latRad);
  const sinLon = Math.sin(lonRad);
  const cosLon = Math.cos(lonRad);

  const denom = Math.sqrt(1 - WGS84_E2 * sinLat * sinLat);
  const N = WGS84_A / denom;
  const M = (WGS84_A * (1 - WGS84_E2)) / (denom * denom * denom);

  const ox = (N + cH) * cosLat * cosLon;
  const oy = (N + cH) * cosLat * sinLon;
  const oz = (N * (1 - WGS84_E2) + cH) * sinLat;

  const widthX = Math.max(0.015, (maxLon - minLon) * DEG_TO_RAD * N * Math.max(0.05, cosLat));
  const depthY = Math.max(0.015, (maxLat - minLat) * DEG_TO_RAD * M);

  // Column 0: East * widthX
  out[offset] = -sinLon * widthX;
  out[offset + 1] = cosLon * widthX;
  out[offset + 2] = 0;
  out[offset + 3] = 0;

  // Column 1: North * depthY
  out[offset + 4] = -sinLat * cosLon * depthY;
  out[offset + 5] = -sinLat * sinLon * depthY;
  out[offset + 6] = cosLat * depthY;
  out[offset + 7] = 0;

  // Column 2: Up * heightSpan
  out[offset + 8] = cosLat * cosLon * heightSpan;
  out[offset + 9] = cosLat * sinLon * heightSpan;
  out[offset + 10] = sinLat * heightSpan;
  out[offset + 11] = 0;

  // Column 3: Translation
  out[offset + 12] = ox;
  out[offset + 13] = oy;
  out[offset + 14] = oz;
  out[offset + 15] = 1;
}

class IndexedLineAccumulator {
  private coords: number[] = [];
  private indices: number[] = [];
  private vertMap = new Map<number, Map<number, number>>();
  private minX = Infinity;
  private maxX = -Infinity;
  private minY = Infinity;
  private maxY = -Infinity;
  private minZ = Infinity;
  private maxZ = -Infinity;

  private getOrAddVertex(lon: number, lat: number, h: number): number {
    const lonKey = Math.round(lon * 1e8);
    const latKey = Math.round(lat * 1e8);
    const hKey = Math.max(0, Math.min(262143, Math.round(h * 100) + 10000));
    const innerKey = latKey * 262144 + hKey;

    let innerMap = this.vertMap.get(lonKey);
    if (!innerMap) {
      innerMap = new Map<number, number>();
      this.vertMap.set(lonKey, innerMap);
    } else {
      const existing = innerMap.get(innerKey);
      if (existing !== undefined) return existing;
    }

    const idx = this.coords.length / 3;
    const [x, y, z] = lonLatHeightToEcef(lon, lat, h);
    this.coords.push(x, y, z);
    innerMap.set(innerKey, idx);

    if (x < this.minX) this.minX = x;
    if (x > this.maxX) this.maxX = x;
    if (y < this.minY) this.minY = y;
    if (y > this.maxY) this.maxY = y;
    if (z < this.minZ) this.minZ = z;
    if (z > this.maxZ) this.maxZ = z;

    return idx;
  }

  addSegment(
    lon0: number,
    lat0: number,
    h0: number,
    lon1: number,
    lat1: number,
    h1: number,
  ): void {
    const i0 = this.getOrAddVertex(lon0, lat0, h0);
    const i1 = this.getOrAddVertex(lon1, lat1, h1);
    if (i0 !== i1) {
      this.indices.push(i0, i1);
    }
  }

  toBuffers(): LineGeometryBuffers | null {
    if (this.indices.length < 2) return null;
    const vertCount = this.coords.length / 3;
    const positions = Float64Array.from(this.coords);
    const indices =
      vertCount <= 65535
        ? Uint16Array.from(this.indices)
        : Uint32Array.from(this.indices);
    const cx = (this.minX + this.maxX) * 0.5;
    const cy = (this.minY + this.maxY) * 0.5;
    const cz = (this.minZ + this.maxZ) * 0.5;
    const radius = Math.max(
      1,
      Math.hypot(this.maxX - cx, this.maxY - cy, this.maxZ - cz),
    );
    return {
      positions,
      indices,
      boundingCenter: [cx, cy, cz],
      boundingRadius: radius,
    };
  }
}

/**
 * 为全视口地面连续铺底网格构建原生 Indexed LINES 顶点与索引缓冲（仅 ~144 条线，跳过 PolylineCollection 广告牌膨胀）
 */
export function buildGroundLineBuffer(
  gg: CompactGroundGridInput,
): LineGeometryBuffers | null {
  const acc = new IndexedLineAccumulator();
  const alt = gg.elevationMeters;
  for (let lat = gg.minLat; lat <= gg.maxLat + gg.stepLat * 0.1; lat += gg.stepLat) {
    acc.addSegment(gg.minLon, lat, alt, gg.maxLon, lat, alt);
  }
  for (let lon = gg.minLon; lon <= gg.maxLon + gg.stepLon * 0.1; lon += gg.stepLon) {
    acc.addSegment(lon, gg.minLat, alt, lon, gg.maxLat, alt);
  }
  return acc.toBuffers();
}

/**
 * 为一组建筑柱体生成高度去重、共用角点共享索引的裸 Indexed LINES 缓冲（Roof + Facade 分层染色）
 */
export function buildColumnLineBuffers(
  columns: CompactColumnInput[],
): {
  facadeLines: LineGeometryBuffers | null;
  roofLines: LineGeometryBuffers | null;
} {
  if (columns.length === 0) {
    return { facadeLines: null, roofLines: null };
  }

  const facadeAcc = new IndexedLineAccumulator();
  const roofAcc = new IndexedLineAccumulator();
  const pillarMaxH = new Map<string, number>();

  const addCornerPillar = (lon: number, lat: number, lowH: number, highH: number) => {
    const key = `${Math.round(lon * 1e7)}_${Math.round(lat * 1e7)}`;
    const prevH = pillarMaxH.get(key) ?? 0;
    if (highH <= prevH + 0.02) return;
    const startH = Math.max(prevH, lowH);
    pillarMaxH.set(key, highH);
    facadeAcc.addSegment(lon, lat, startH, lon, lat, highH);
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
    const maxRings = stepM <= 0.08 ? 36 : stepM <= 0.4 ? 28 : stepM <= 2.5 ? 22 : 14;
    const ringStride = Math.max(1, Math.ceil(span / (stepM * maxRings))) * stepM;
    for (let z = startFloor + ringStride; z < roofH - 0.01; z += ringStride) {
      facadeAcc.addSegment(lon0, lat0, z, lon1, lat1, z);
    }
  };

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const top = col.roofHeight;
    const stepM = col.layerStepMeters;

    if (col.subDiv && col.subDiv > 1) {
      const sd = col.subDiv;
      const sx0 = Math.max(0, col.sxStart ?? 0);
      const sx1 = Math.min(sd - 1, col.sxEnd ?? sd - 1);
      const sy0 = Math.max(0, col.syStart ?? 0);
      const sy1 = Math.min(sd - 1, col.syEnd ?? sd - 1);
      if (sx1 < sx0 || sy1 < sy0) continue;

      const dLon = (col.maxLon - col.minLon) / sd;
      const dLat = (col.maxLat - col.minLat) / sd;
      const x0 = col.minLon + sx0 * dLon;
      const x1 = col.minLon + (sx1 + 1) * dLon;
      const y0 = col.minLat + sy0 * dLat;
      const y1 = col.minLat + (sy1 + 1) * dLat;

      if (sx1 === sd - 1 && col.exposedE) {
        roofAcc.addSegment(x1, y0, top, x1, y1, top);
        addRingsOnFace(x1, y0, x1, y1, col.neighborHE, top, stepM);
      } else {
        facadeAcc.addSegment(x1, y0, top, x1, y1, top);
      }

      if (sx0 === 0 && col.exposedW) {
        roofAcc.addSegment(x0, y0, top, x0, y1, top);
        addRingsOnFace(x0, y0, x0, y1, col.neighborHW, top, stepM);
      }

      if (sy1 === sd - 1 && col.exposedN) {
        roofAcc.addSegment(x0, y1, top, x1, y1, top);
        addRingsOnFace(x0, y1, x1, y1, col.neighborHN, top, stepM);
      } else {
        facadeAcc.addSegment(x0, y1, top, x1, y1, top);
      }

      if (sy0 === 0 && col.exposedS) {
        roofAcc.addSegment(x0, y0, top, x1, y0, top);
        addRingsOnFace(x0, y0, x1, y0, col.neighborHS, top, stepM);
      }

      // 屋顶内部跨段拉通十字细分网格线（顶点数相比逐子格构造减少 20x-32x）
      for (let sx = sx0 + 1; sx <= sx1; sx++) {
        const x = col.minLon + sx * dLon;
        facadeAcc.addSegment(x, y0, top, x, y1, top);
      }
      for (let sy = sy0 + 1; sy <= sy1; sy++) {
        const y = col.minLat + sy * dLat;
        facadeAcc.addSegment(x0, y, top, x1, y, top);
      }

      if (col.exposedE || col.exposedS) addCornerPillar(x1, y0, col.baseHeight, top);
      if (col.exposedE || col.exposedN) addCornerPillar(x1, y1, col.baseHeight, top);
      if (col.exposedW || col.exposedN) addCornerPillar(x0, y1, col.baseHeight, top);
      if (col.exposedW || col.exposedS) addCornerPillar(x0, y0, col.baseHeight, top);

      // 仅在暴露外立面上绘制细密竖棱（起自邻接顶面，止于屋顶）
      if (sx1 === sd - 1 && col.exposedE) {
        const hLow = Math.max(0, Math.floor(col.neighborHE / stepM) * stepM);
        for (let sy = sy0 + 1; sy <= sy1; sy++) {
          addCornerPillar(x1, col.minLat + sy * dLat, hLow, top);
        }
      }
      if (sx0 === 0 && col.exposedW) {
        const hLow = Math.max(0, Math.floor(col.neighborHW / stepM) * stepM);
        for (let sy = sy0 + 1; sy <= sy1; sy++) {
          addCornerPillar(x0, col.minLat + sy * dLat, hLow, top);
        }
      }
      if (sy1 === sd - 1 && col.exposedN) {
        const hLow = Math.max(0, Math.floor(col.neighborHN / stepM) * stepM);
        for (let sx = sx0 + 1; sx <= sx1; sx++) {
          addCornerPillar(col.minLon + sx * dLon, y1, hLow, top);
        }
      }
      if (sy0 === 0 && col.exposedS) {
        const hLow = Math.max(0, Math.floor(col.neighborHS / stepM) * stepM);
        for (let sx = sx0 + 1; sx <= sx1; sx++) {
          addCornerPillar(col.minLon + sx * dLon, y0, hLow, top);
        }
      }
      continue;
    }

    if (col.exposedE) {
      roofAcc.addSegment(col.maxLon, col.minLat, top, col.maxLon, col.maxLat, top);
      addRingsOnFace(col.maxLon, col.minLat, col.maxLon, col.maxLat, col.neighborHE, top, stepM);
    } else {
      facadeAcc.addSegment(col.maxLon, col.minLat, top, col.maxLon, col.maxLat, top);
    }

    if (col.exposedW) {
      roofAcc.addSegment(col.minLon, col.minLat, top, col.minLon, col.maxLat, top);
      addRingsOnFace(col.minLon, col.minLat, col.minLon, col.maxLat, col.neighborHW, top, stepM);
    }

    if (col.exposedN) {
      roofAcc.addSegment(col.minLon, col.maxLat, top, col.maxLon, col.maxLat, top);
      addRingsOnFace(col.minLon, col.maxLat, col.maxLon, col.maxLat, col.neighborHN, top, stepM);
    } else {
      facadeAcc.addSegment(col.minLon, col.maxLat, top, col.maxLon, col.maxLat, top);
    }

    if (col.exposedS) {
      roofAcc.addSegment(col.minLon, col.minLat, top, col.maxLon, col.minLat, top);
      addRingsOnFace(col.minLon, col.minLat, col.maxLon, col.minLat, col.neighborHS, top, stepM);
    }

    if (col.exposedE || col.exposedS) addCornerPillar(col.maxLon, col.minLat, col.baseHeight, top);
    if (col.exposedE || col.exposedN) addCornerPillar(col.maxLon, col.maxLat, col.baseHeight, top);
    if (col.exposedW || col.exposedN) addCornerPillar(col.minLon, col.maxLat, col.baseHeight, top);
    if (col.exposedW || col.exposedS) addCornerPillar(col.minLon, col.minLat, col.baseHeight, top);
  }

  return {
    facadeLines: facadeAcc.toBuffers(),
    roofLines: roofAcc.toBuffers(),
  };
}

function heightToCategory(
  roofH: number,
  thresholds: ElevationColorThresholds = DEFAULT_ELEVATION_THRESHOLDS,
): GridCellCategory {
  if (roofH < thresholds[0]) return 'conformal-low';
  if (roofH < thresholds[1]) return 'conformal-mid';
  if (roofH < thresholds[2]) return 'conformal-high';
  return 'conformal-super';
}

interface RawBandEntry {
  col: number;
  row: number;
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  minHeight: number;
  maxHeight: number;
  category: GridCellCategory;
}

/**
 * 2D 贪心矩形体素合并（Greedy Meshing）：
 * 按高程分带与高度层，将相邻同高/同色带的连续柱体横向/纵向合并为最大包络长方体，
 * 在保持阶梯包络造型一致的前提下减少 70%-85% 的三角面数。
 */
export function greedyMergeBuildingBands(
  columns: CompactColumnInput[],
  elevationThresholds: ElevationColorThresholds = DEFAULT_ELEVATION_THRESHOLDS,
): MergedBoxSpec[] {
  if (columns.length === 0) return [];

  const BAND_THRESHOLDS = elevationThresholds;
  const buckets = new Map<string, RawBandEntry[]>();

  const merged: MergedBoxSpec[] = [];

  const pushBand = (
    c: CompactColumnInput,
    effMinLon: number,
    effMaxLon: number,
    effMinLat: number,
    effMaxLat: number,
    isClipped: boolean,
    z0: number,
    z1: number,
    cat: GridCellCategory,
  ) => {
    if (isClipped) {
      merged.push({
        minLon: effMinLon,
        maxLon: effMaxLon,
        minLat: effMinLat,
        maxLat: effMaxLat,
        minHeight: z0,
        maxHeight: z1,
        category: cat,
      });
      return;
    }
    const qStep = c.layerStepMeters < 0.2 ? 0.05 : c.layerStepMeters < 1 ? 0.2 : 1.0;
    const z0q = Math.round(z0 / qStep);
    const z1q = Math.round(z1 / qStep);
    const scaleKey = Math.max(1, Math.round((effMaxLon - effMinLon) * 1e6));
    const layerKey = `${cat}#s${scaleKey}#${z0q}_${z1q}`;
    let list = buckets.get(layerKey);
    if (!list) {
      list = [];
      buckets.set(layerKey, list);
    }
    list.push({
      col: c.col,
      row: c.row,
      minLon: effMinLon,
      maxLon: effMaxLon,
      minLat: effMinLat,
      maxLat: effMaxLat,
      minHeight: z0,
      maxHeight: z1,
      category: cat,
    });
  };

  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    const vStepM = c.layerStepMeters;
    const sd = c.subDiv ?? 1;
    let effMinLon = c.minLon;
    let effMaxLon = c.maxLon;
    let effMinLat = c.minLat;
    let effMaxLat = c.maxLat;
    let isClipped = false;

    if (sd > 1) {
      const sx0 = Math.max(0, c.sxStart ?? 0);
      const sx1 = Math.min(sd - 1, c.sxEnd ?? sd - 1);
      const sy0 = Math.max(0, c.syStart ?? 0);
      const sy1 = Math.min(sd - 1, c.syEnd ?? sd - 1);
      if (sx1 < sx0 || sy1 < sy0) continue;
      if (sx0 > 0 || sx1 < sd - 1 || sy0 > 0 || sy1 < sd - 1) {
        isClipped = true;
        const dLon = (c.maxLon - c.minLon) / sd;
        const dLat = (c.maxLat - c.minLat) / sd;
        effMinLon = c.minLon + sx0 * dLon;
        effMaxLon = c.minLon + (sx1 + 1) * dLon;
        effMinLat = c.minLat + sy0 * dLat;
        effMaxLat = c.minLat + (sy1 + 1) * dLat;
      }
    }

    if (c.baseHeight < c.roofHeight - Math.max(0.15, vStepM * 0.75)) {
      let curZ = c.baseHeight;
      const cuts = BAND_THRESHOLDS.filter((t) => t > curZ + 0.2 && t < c.roofHeight - 0.2);
      cuts.push(c.roofHeight);
      for (let b = 0; b < cuts.length; b++) {
        const nextZ = cuts[b];
        pushBand(
          c,
          effMinLon,
          effMaxLon,
          effMinLat,
          effMaxLat,
          isClipped,
          curZ,
          nextZ,
          heightToCategory(nextZ - 0.1, BAND_THRESHOLDS),
        );
        curZ = nextZ;
      }
    } else {
      const capBottom = Math.max(0, c.roofHeight - Math.max(0.03, Math.min(vStepM, 6)));
      pushBand(
        c,
        effMinLon,
        effMaxLon,
        effMinLat,
        effMaxLat,
        isClipped,
        capBottom,
        c.roofHeight,
        heightToCategory(c.roofHeight - 0.1, BAND_THRESHOLDS),
      );
    }
  }

  for (const entries of buckets.values()) {
    if (entries.length === 1) {
      const e = entries[0];
      merged.push({
        minLon: e.minLon,
        maxLon: e.maxLon,
        minLat: e.minLat,
        maxLat: e.maxLat,
        minHeight: e.minHeight,
        maxHeight: e.maxHeight,
        category: e.category,
      });
      continue;
    }

    const coordMap = new Map<string, RawBandEntry>();
    for (let i = 0; i < entries.length; i++) {
      coordMap.set(`${entries[i].col}_${entries[i].row}`, entries[i]);
    }
    entries.sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));
    const visited = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      const seed = entries[i];
      const seedKey = `${seed.col}_${seed.row}`;
      if (visited.has(seedKey)) continue;

      let endCol = seed.col;
      let maxLon = seed.maxLon;
      while (true) {
        const nextKey = `${endCol + 1}_${seed.row}`;
        const next = coordMap.get(nextKey);
        if (!next || visited.has(nextKey)) break;
        endCol++;
        maxLon = next.maxLon;
      }

      let endRow = seed.row;
      let maxLat = seed.maxLat;
      outer: while (true) {
        const candRow = endRow + 1;
        let rowMaxLat = maxLat;
        for (let cc = seed.col; cc <= endCol; cc++) {
          const ck = `${cc}_${candRow}`;
          const cell = coordMap.get(ck);
          if (!cell || visited.has(ck)) break outer;
          rowMaxLat = cell.maxLat;
        }
        endRow = candRow;
        maxLat = rowMaxLat;
      }

      for (let rr = seed.row; rr <= endRow; rr++) {
        for (let cc = seed.col; cc <= endCol; cc++) {
          visited.add(`${cc}_${rr}`);
        }
      }

      merged.push({
        minLon: seed.minLon,
        maxLon,
        minLat: seed.minLat,
        maxLat,
        minHeight: seed.minHeight,
        maxHeight: seed.maxHeight,
        category: seed.category,
      });
    }
  }

  return merged;
}

const TRI_BASE_LON = 113.5;
const TRI_BASE_LAT = 22.0;

/**
 * 扫描线精确紧致体素化：针对单个 subDiv>1 的前沿 L7 父块，利用原始 GLB 三角网格进行亚米/厘米级裁切，
 * 只在真正被建筑体覆盖的子格上生成紧贴轮廓的包络线框与合并盒体（带 1 格护裙消除跨 L7/跨块接缝）。
 */
function emitTightSubParentGeometry(
  parent: CompactColumnInput,
  triLookup: RuntimeTriangleLookup,
  elevationThresholds: ElevationColorThresholds,
  includeVolumes: boolean,
  facadeAcc: IndexedLineAccumulator,
  roofAcc: IndexedLineAccumulator,
  addCornerPillar: (lon: number, lat: number, lowH: number, highH: number) => void,
  addRingsOnFace: (
    lon0: number,
    lat0: number,
    lon1: number,
    lat1: number,
    neighborH: number,
    roofH: number,
    stepM: number,
  ) => void,
  outBoxes: MergedBoxSpec[],
): number {
  const sd = Math.max(2, parent.subDiv ?? 2);
  const sx0 = Math.max(0, parent.sxStart ?? 0);
  const sx1 = Math.min(sd - 1, parent.sxEnd ?? sd - 1);
  const sy0 = Math.max(0, parent.syStart ?? 0);
  const sy1 = Math.min(sd - 1, parent.syEnd ?? sd - 1);
  if (sx1 < sx0 || sy1 < sy0) return 0;

  const W = sx1 - sx0 + 1;
  const H = sy1 - sy0 + 1;
  const apronW = W + 2;
  const apronH = H + 2;

  const pStepLon = parent.maxLon - parent.minLon;
  const pStepLat = parent.maxLat - parent.minLat;
  const dLon = pStepLon / sd;
  const dLat = pStepLat / sd;

  const baseLon = parent.minLon + sx0 * dLon;
  const baseLat = parent.minLat + sy0 * dLat;
  const origLon1e9 = (baseLon - dLon - TRI_BASE_LON) * 1e9;
  const origLat1e9 = (baseLat - dLat - TRI_BASE_LAT) * 1e9;
  const cellLon1e9 = dLon * 1e9;
  const cellLat1e9 = dLat * 1e9;
  const spanLon1e9 = apronW * cellLon1e9;
  const spanLat1e9 = apronH * cellLat1e9;

  // 收集覆盖当前父块（含 1 格护裙）最多 4 个 16x16 宏块内的不重复三角形索引
  const ckBaseX = Math.floor(parent.col / 16);
  const ckBaseY = Math.floor(parent.row / 16);
  const localColInChunk = parent.col - ckBaseX * 16;
  const localRowInChunk = parent.row - ckBaseY * 16;
  const cxOffsets =
    localColInChunk === 0 ? [-1, 0] : localColInChunk === 15 ? [0, 1] : [0];
  const cyOffsets =
    localRowInChunk === 0 ? [-1, 0] : localRowInChunk === 15 ? [0, 1] : [0];

  const candidateTris: number[] = [];
  const multiChunk = cxOffsets.length > 1 || cyOffsets.length > 1;
  const seenTri = multiChunk ? new Set<number>() : null;

  for (const dy of cyOffsets) {
    for (const dx of cxOffsets) {
      const cIdx = triLookup.chunkKeyToIdx.get(`${ckBaseX + dx}_${ckBaseY + dy}`);
      if (cIdx === undefined) continue;
      const start = triLookup.chunkOffsets[cIdx];
      const end = triLookup.chunkOffsets[cIdx + 1];
      for (let p = start; p < end; p++) {
        const tId = triLookup.chunkTriIndices[p];
        if (seenTri) {
          if (seenTri.has(tId)) continue;
          seenTri.add(tId);
        }
        candidateTris.push(tId);
      }
    }
  }

  if (candidateTris.length === 0) return -1;

  const rawMaxH = new Float32Array(apronW * apronH);
  const triData = triLookup.triData;
  let touchedAny = false;

  for (let i = 0; i < candidateTris.length; i++) {
    const b = candidateTris[i] * 9;
    const x0 = triData[b] - origLon1e9;
    const y0 = triData[b + 1] - origLat1e9;
    const z0 = triData[b + 2] * 0.001;
    const x1 = triData[b + 3] - origLon1e9;
    const y1 = triData[b + 4] - origLat1e9;
    const z1 = triData[b + 5] * 0.001;
    const x2 = triData[b + 6] - origLon1e9;
    const y2 = triData[b + 7] - origLat1e9;
    const z2 = triData[b + 8] * 0.001;

    const minX = Math.min(x0, x1, x2);
    const maxX = Math.max(x0, x1, x2);
    if (maxX < 0 || minX > spanLon1e9) continue;
    const minY = Math.min(y0, y1, y2);
    const maxY = Math.max(y0, y1, y2);
    if (maxY < 0 || minY > spanLat1e9) continue;

    const maxTriZ = Math.max(z0, z1, z2);
    if (maxTriZ <= 0.25) continue;
    const minTriZ = Math.min(z0, z1, z2);

    const ayStart = Math.max(0, Math.floor(minY / cellLat1e9));
    const ayEnd = Math.min(apronH - 1, Math.floor(maxY / cellLat1e9));

    const isFlatOrWall = maxTriZ - minTriZ < 0.08;
    const area2 = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    const hasSlopePlane = !isFlatOrWall && Math.abs(area2) > 100;

    for (let ay = ayStart; ay <= ayEnd; ay++) {
      const slabY0 = ay * cellLat1e9;
      const slabY1 = slabY0 + cellLat1e9;
      let sMinX = Infinity;
      let sMaxX = -Infinity;

      if (y0 >= slabY0 && y0 <= slabY1) {
        if (x0 < sMinX) sMinX = x0;
        if (x0 > sMaxX) sMaxX = x0;
      }
      if (y1 >= slabY0 && y1 <= slabY1) {
        if (x1 < sMinX) sMinX = x1;
        if (x1 > sMaxX) sMaxX = x1;
      }
      if (y2 >= slabY0 && y2 <= slabY1) {
        if (x2 < sMinX) sMinX = x2;
        if (x2 > sMaxX) sMaxX = x2;
      }

      const clipEdge = (
        ex0: number,
        ey0: number,
        ex1: number,
        ey1: number,
      ) => {
        const eLoY = ey0 < ey1 ? ey0 : ey1;
        const eHiY = ey0 < ey1 ? ey1 : ey0;
        if (eHiY < slabY0 || eLoY > slabY1) return;
        const dy = ey1 - ey0;
        if (Math.abs(dy) < 1e-4) {
          if (ex0 < sMinX) sMinX = ex0;
          if (ex0 > sMaxX) sMaxX = ex0;
          if (ex1 < sMinX) sMinX = ex1;
          if (ex1 > sMaxX) sMaxX = ex1;
          return;
        }
        const t0 = (slabY0 - ey0) / dy;
        const t1 = (slabY1 - ey0) / dy;
        const cl0 = t0 < 0 ? 0 : t0 > 1 ? 1 : t0;
        const cl1 = t1 < 0 ? 0 : t1 > 1 ? 1 : t1;
        const xa = ex0 + cl0 * (ex1 - ex0);
        const xb = ex0 + cl1 * (ex1 - ex0);
        if (xa < sMinX) sMinX = xa;
        if (xa > sMaxX) sMaxX = xa;
        if (xb < sMinX) sMinX = xb;
        if (xb > sMaxX) sMaxX = xb;
      };

      clipEdge(x0, y0, x1, y1);
      clipEdge(x1, y1, x2, y2);
      clipEdge(x2, y2, x0, y0);

      if (sMinX > sMaxX) continue;

      const axStart = Math.max(0, Math.floor(sMinX / cellLon1e9));
      const axEnd = Math.min(apronW - 1, Math.floor(sMaxX / cellLon1e9));
      const rowOffset = ay * apronW;

      if (!hasSlopePlane) {
        for (let ax = axStart; ax <= axEnd; ax++) {
          if (maxTriZ > rawMaxH[rowOffset + ax]) {
            rawMaxH[rowOffset + ax] = maxTriZ;
            touchedAny = true;
          }
        }
      } else {
        const cy = slabY0 + cellLat1e9 * 0.5;
        const invArea2 = 1 / area2;
        for (let ax = axStart; ax <= axEnd; ax++) {
          const cx = (ax + 0.5) * cellLon1e9;
          let u = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) * invArea2;
          let v = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) * invArea2;
          let w = 1 - u - v;
          if (u < 0) u = 0;
          else if (u > 1) u = 1;
          if (v < 0) v = 0;
          else if (v > 1) v = 1;
          if (w < 0) w = 0;
          else if (w > 1) w = 1;
          const sum = u + v + w || 1;
          const hz = (u * z0 + v * z1 + w * z2) / sum;
          const clampedZ = hz < minTriZ ? minTriZ : hz > maxTriZ ? maxTriZ : hz;
          if (clampedZ > rawMaxH[rowOffset + ax]) {
            rawMaxH[rowOffset + ax] = clampedZ;
            touchedAny = true;
          }
        }
      }
    }
  }

  if (!touchedAny) {
    // 边缘仅部分微弱采样或父块外缘无屋顶面重叠，返回 0 表示无实际建筑实心体
    return 0;
  }

  const stepZ = parent.layerStepMeters;
  const roofClearance =
    stepZ >= 5 ? 0.55 : stepZ >= 1 ? 0.24 : stepZ >= 0.15 ? 0.08 : 0.03;

  const qH = new Float32Array(apronW * apronH);
  let occupiedCount = 0;
  for (let ay = 0; ay < apronH; ay++) {
    const rowOff = ay * apronW;
    for (let ax = 0; ax < apronW; ax++) {
      const h = rawMaxH[rowOff + ax];
      if (h > 0.25) {
        const snapped = Math.max(stepZ, Math.ceil(h / stepZ) * stepZ) + roofClearance;
        qH[rowOff + ax] = snapped;
        if (ax >= 1 && ax <= W && ay >= 1 && ay <= H) {
          occupiedCount++;
        }
      }
    }
  }

  if (occupiedCount === 0) return 0;

  // 1) 行向扫描合并绘制 N/S 屋顶网格线与暴露墙面横环
  for (let ty = 1; ty <= H; ty++) {
    const yBottom = baseLat + (ty - 1) * dLat;
    const yTop = yBottom + dLat;
    const rowOff = ty * apronW;
    const upOff = (ty + 1) * apronW;
    const downOff = (ty - 1) * apronW;

    let tx = 1;
    while (tx <= W) {
      const h = qH[rowOff + tx];
      if (h <= 0) {
        tx++;
        continue;
      }
      const nH = qH[upOff + tx];
      const nExposed = h > nH + 0.05;
      const nSame = Math.abs(h - nH) <= 0.05;
      const nTargetH = nExposed ? nH : nSame ? h : -1;

      let txEnd = tx;
      if (nTargetH >= 0) {
        while (txEnd + 1 <= W) {
          const nh = qH[rowOff + txEnd + 1];
          const nnH = qH[upOff + txEnd + 1];
          if (Math.abs(nh - h) > 0.05) break;
          if (nExposed ? !(nh > nnH + 0.05 && Math.abs(nnH - nH) <= 0.05) : Math.abs(nh - nnH) > 0.05) {
            break;
          }
          txEnd++;
        }
        const x0 = baseLon + (tx - 1) * dLon;
        const x1 = baseLon + txEnd * dLon;
        if (nExposed) {
          roofAcc.addSegment(x0, yTop, h, x1, yTop, h);
          addRingsOnFace(x0, yTop, x1, yTop, nH, h, stepZ);
        } else if (nSame) {
          facadeAcc.addSegment(x0, yTop, h, x1, yTop, h);
        }
      }
      tx = txEnd + 1;
    }

    // 南边外暴露外立面（内部平齐接缝由南侧邻格北向绘制）
    tx = 1;
    while (tx <= W) {
      const h = qH[rowOff + tx];
      const sH = qH[downOff + tx];
      if (!(h > 0 && h > sH + 0.05)) {
        tx++;
        continue;
      }
      let txEnd = tx;
      while (txEnd + 1 <= W) {
        const nh = qH[rowOff + txEnd + 1];
        const nsH = qH[downOff + txEnd + 1];
        if (Math.abs(nh - h) > 0.05 || !(nh > nsH + 0.05 && Math.abs(nsH - sH) <= 0.05)) {
          break;
        }
        txEnd++;
      }
      const x0 = baseLon + (tx - 1) * dLon;
      const x1 = baseLon + txEnd * dLon;
      roofAcc.addSegment(x0, yBottom, h, x1, yBottom, h);
      addRingsOnFace(x0, yBottom, x1, yBottom, sH, h, stepZ);
      tx = txEnd + 1;
    }
  }

  // 2) 列向扫描合并绘制 E/W 屋顶网格线与暴露墙面横环
  for (let tx = 1; tx <= W; tx++) {
    const xLeft = baseLon + (tx - 1) * dLon;
    const xRight = xLeft + dLon;

    let ty = 1;
    while (ty <= H) {
      const h = qH[ty * apronW + tx];
      if (h <= 0) {
        ty++;
        continue;
      }
      const eH = qH[ty * apronW + tx + 1];
      const eExposed = h > eH + 0.05;
      const eSame = Math.abs(h - eH) <= 0.05;
      if (!eExposed && !eSame) {
        ty++;
        continue;
      }
      let tyEnd = ty;
      while (tyEnd + 1 <= H) {
        const nh = qH[(tyEnd + 1) * apronW + tx];
        const neH = qH[(tyEnd + 1) * apronW + tx + 1];
        if (Math.abs(nh - h) > 0.05) break;
        if (eExposed ? !(nh > neH + 0.05 && Math.abs(neH - eH) <= 0.05) : Math.abs(nh - neH) > 0.05) {
          break;
        }
        tyEnd++;
      }
      const y0 = baseLat + (ty - 1) * dLat;
      const y1 = baseLat + tyEnd * dLat;
      if (eExposed) {
        roofAcc.addSegment(xRight, y0, h, xRight, y1, h);
        addRingsOnFace(xRight, y0, xRight, y1, eH, h, stepZ);
      } else {
        facadeAcc.addSegment(xRight, y0, h, xRight, y1, h);
      }
      ty = tyEnd + 1;
    }

    ty = 1;
    while (ty <= H) {
      const h = qH[ty * apronW + tx];
      const wH = qH[ty * apronW + tx - 1];
      if (!(h > 0 && h > wH + 0.05)) {
        ty++;
        continue;
      }
      let tyEnd = ty;
      while (tyEnd + 1 <= H) {
        const nh = qH[(tyEnd + 1) * apronW + tx];
        const nwH = qH[(tyEnd + 1) * apronW + tx - 1];
        if (Math.abs(nh - h) > 0.05 || !(nh > nwH + 0.05 && Math.abs(nwH - wH) <= 0.05)) {
          break;
        }
        tyEnd++;
      }
      const y0 = baseLat + (ty - 1) * dLat;
      const y1 = baseLat + tyEnd * dLat;
      roofAcc.addSegment(xLeft, y0, h, xLeft, y1, h);
      addRingsOnFace(xLeft, y0, xLeft, y1, wH, h, stepZ);
      ty = tyEnd + 1;
    }
  }

  // 3) 仅在暴露边界与高度台阶角点绘制竖向立柱（内部平屋顶零立柱）
  for (let cy = 0; cy <= H; cy++) {
    const lat = baseLat + cy * dLat;
    const r0 = cy * apronW;
    const r1 = (cy + 1) * apronW;
    for (let cx = 0; cx <= W; cx++) {
      const h00 = qH[r0 + cx];
      const h10 = qH[r0 + cx + 1];
      const h01 = qH[r1 + cx];
      const h11 = qH[r1 + cx + 1];
      const maxC = Math.max(h00, h10, h01, h11);
      if (maxC <= 0) continue;
      const minC = Math.min(h00, h10, h01, h11);
      if (maxC > minC + 0.05) {
        const lowFloor = Math.max(0, Math.floor(minC / stepZ) * stepZ);
        addCornerPillar(baseLon + cx * dLon, lat, lowFloor, maxC);
      }
    }
  }

  // 4) 高程梯度体素 / 半透明体 2D 扫描线贪心矩形合并（严格紧贴三角面轮廓）
  if (includeVolumes) {
    const visited = new Uint8Array(apronW * apronH);
    for (let ty = 1; ty <= H; ty++) {
      for (let tx = 1; tx <= W; tx++) {
        const idx = ty * apronW + tx;
        if (visited[idx]) continue;
        const h = qH[idx];
        if (h <= 0) continue;

        let rx1 = tx;
        while (
          rx1 + 1 <= W &&
          !visited[ty * apronW + rx1 + 1] &&
          Math.abs(qH[ty * apronW + rx1 + 1] - h) <= 0.05
        ) {
          rx1++;
        }

        let ry1 = ty;
        outerMerge: while (ry1 + 1 <= H) {
          const nextRowOff = (ry1 + 1) * apronW;
          for (let cc = tx; cc <= rx1; cc++) {
            if (visited[nextRowOff + cc] || Math.abs(qH[nextRowOff + cc] - h) > 0.05) {
              break outerMerge;
            }
          }
          ry1++;
        }

        let minNB = h;
        for (let cc = tx; cc <= rx1; cc++) {
          const s = qH[(ty - 1) * apronW + cc];
          const n = qH[(ry1 + 1) * apronW + cc];
          if (s < minNB) minNB = s;
          if (n < minNB) minNB = n;
        }
        for (let rr = ty; rr <= ry1; rr++) {
          const w = qH[rr * apronW + tx - 1];
          const e = qH[rr * apronW + rx1 + 1];
          if (w < minNB) minNB = w;
          if (e < minNB) minNB = e;
        }

        for (let rr = ty; rr <= ry1; rr++) {
          const rOff = rr * apronW;
          for (let cc = tx; cc <= rx1; cc++) {
            visited[rOff + cc] = 1;
          }
        }

        const boxMinLon = baseLon + (tx - 1) * dLon;
        const boxMaxLon = baseLon + rx1 * dLon;
        const boxMinLat = baseLat + (ty - 1) * dLat;
        const boxMaxLat = baseLat + ry1 * dLat;
        const baseH = Math.max(0, Math.floor(minNB / stepZ) * stepZ);

        if (baseH < h - Math.max(0.15, stepZ * 0.75)) {
          let curZ = baseH;
          const cuts = elevationThresholds.filter((t) => t > curZ + 0.2 && t < h - 0.2);
          cuts.push(h);
          for (let b = 0; b < cuts.length; b++) {
            const nextZ = cuts[b];
            outBoxes.push({
              minLon: boxMinLon,
              maxLon: boxMaxLon,
              minLat: boxMinLat,
              maxLat: boxMaxLat,
              minHeight: curZ,
              maxHeight: nextZ,
              category: heightToCategory(nextZ - 0.1, elevationThresholds),
            });
            curZ = nextZ;
          }
        } else {
          const capBottom = Math.max(0, h - Math.max(0.03, Math.min(stepZ, 6)));
          outBoxes.push({
            minLon: boxMinLon,
            maxLon: boxMaxLon,
            minLat: boxMinLat,
            maxLat: boxMaxLat,
            minHeight: capBottom,
            maxHeight: h,
            category: heightToCategory(h - 0.1, elevationThresholds),
          });
        }
      }
    }
  }

  return occupiedCount;
}

/**
 * 构建单个空间宏块或精细视口块的完整零拷贝 GPU 几何载荷（供 Web Worker 与同步兜底共用）
 */
export function buildChunkGeometryPayload(
  chunkKey: string,
  columns: CompactColumnInput[],
  includeVolumes: boolean,
  elevationThresholds: ElevationColorThresholds = DEFAULT_ELEVATION_THRESHOLDS,
  triLookup?: RuntimeTriangleLookup | null,
): ChunkGeometryPayload {
  if (columns.length === 0) {
    return {
      chunkKey,
      facadeLines: null,
      roofLines: null,
      boxMatrices: null,
      boxCategories: [],
      boxCount: 0,
      occupiedColCount: 0,
    };
  }

  const hasTightSubParents =
    Boolean(triLookup) &&
    columns.some((c) => (c.subDiv ?? 1) > 1);

  if (!hasTightSubParents || !triLookup) {
    const { facadeLines, roofLines } = buildColumnLineBuffers(columns);
    if (!includeVolumes) {
      return {
        chunkKey,
        facadeLines,
        roofLines,
        boxMatrices: null,
        boxCategories: [],
        boxCount: 0,
      };
    }

    const merged = greedyMergeBuildingBands(columns, elevationThresholds);
    const boxMatrices = new Float64Array(merged.length * 16);
    const boxCategories: GridCellCategory[] = new Array(merged.length);
    for (let i = 0; i < merged.length; i++) {
      const b = merged[i];
      computeEnuBoxModelMatrix(
        b.minLon,
        b.maxLon,
        b.minLat,
        b.maxLat,
        b.minHeight,
        b.maxHeight,
        boxMatrices,
        i * 16,
      );
      boxCategories[i] = b.category;
    }

    return {
      chunkKey,
      facadeLines,
      roofLines,
      boxMatrices,
      boxCategories,
      boxCount: merged.length,
    };
  }

  // 存在前景细分父块且持有三角网格库：精细块执行三角面紧致化裁剪，外围块继续粗粒度合并
  const facadeAcc = new IndexedLineAccumulator();
  const roofAcc = new IndexedLineAccumulator();
  const pillarMaxH = new Map<string, number>();

  const addCornerPillar = (lon: number, lat: number, lowH: number, highH: number) => {
    const key = `${Math.round(lon * 1e7)}_${Math.round(lat * 1e7)}`;
    const prevH = pillarMaxH.get(key) ?? 0;
    if (highH <= prevH + 0.02) return;
    const startH = Math.max(prevH, lowH);
    pillarMaxH.set(key, highH);
    facadeAcc.addSegment(lon, lat, startH, lon, lat, highH);
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
    const maxRings = stepM <= 0.08 ? 36 : stepM <= 0.4 ? 28 : stepM <= 2.5 ? 22 : 14;
    const ringStride = Math.max(1, Math.ceil(span / (stepM * maxRings))) * stepM;
    for (let z = startFloor + ringStride; z < roofH - 0.01; z += ringStride) {
      facadeAcc.addSegment(lon0, lat0, z, lon1, lat1, z);
    }
  };

  const coarseColumns: CompactColumnInput[] = [];
  const tightBoxes: MergedBoxSpec[] = [];
  let totalOccupiedCols = 0;

  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    if ((c.subDiv ?? 1) > 1) {
      const occ = emitTightSubParentGeometry(
        c,
        triLookup,
        elevationThresholds,
        includeVolumes,
        facadeAcc,
        roofAcc,
        addCornerPillar,
        addRingsOnFace,
        tightBoxes,
      );
      if (occ < 0) {
        coarseColumns.push(c);
        const sd = c.subDiv ?? 1;
        totalOccupiedCols +=
          ((c.sxEnd ?? sd - 1) - (c.sxStart ?? 0) + 1) *
          ((c.syEnd ?? sd - 1) - (c.syStart ?? 0) + 1);
      } else {
        totalOccupiedCols += occ;
      }
    } else {
      coarseColumns.push(c);
      totalOccupiedCols += 1;
    }
  }

  let coarseLines: {
    facadeLines: LineGeometryBuffers | null;
    roofLines: LineGeometryBuffers | null;
  } = { facadeLines: null, roofLines: null };
  if (coarseColumns.length > 0) {
    coarseLines = buildColumnLineBuffers(coarseColumns);
  }

  const facadeLines = mergeLineBuffers(facadeAcc.toBuffers(), coarseLines.facadeLines);
  const roofLines = mergeLineBuffers(roofAcc.toBuffers(), coarseLines.roofLines);

  if (!includeVolumes) {
    return {
      chunkKey,
      facadeLines,
      roofLines,
      boxMatrices: null,
      boxCategories: [],
      boxCount: 0,
      occupiedColCount: totalOccupiedCols,
    };
  }

  const coarseBoxes =
    coarseColumns.length > 0
      ? greedyMergeBuildingBands(coarseColumns, elevationThresholds)
      : [];
  const allBoxes = tightBoxes.concat(coarseBoxes);
  const boxMatrices = new Float64Array(allBoxes.length * 16);
  const boxCategories: GridCellCategory[] = new Array(allBoxes.length);
  for (let i = 0; i < allBoxes.length; i++) {
    const b = allBoxes[i];
    computeEnuBoxModelMatrix(
      b.minLon,
      b.maxLon,
      b.minLat,
      b.maxLat,
      b.minHeight,
      b.maxHeight,
      boxMatrices,
      i * 16,
    );
    boxCategories[i] = b.category;
  }

  return {
    chunkKey,
    facadeLines,
    roofLines,
    boxMatrices,
    boxCategories,
    boxCount: allBoxes.length,
    occupiedColCount: totalOccupiedCols,
  };
}

export function mergeLineBuffers(
  a: LineGeometryBuffers | null,
  b: LineGeometryBuffers | null,
): LineGeometryBuffers | null {
  if (!a) return b;
  if (!b) return a;
  const vCountA = a.positions.length / 3;
  const positions = new Float64Array(a.positions.length + b.positions.length);
  positions.set(a.positions, 0);
  positions.set(b.positions, a.positions.length);

  const totalVerts = positions.length / 3;
  const indices =
    totalVerts <= 65535
      ? new Uint16Array(a.indices.length + b.indices.length)
      : new Uint32Array(a.indices.length + b.indices.length);
  indices.set(a.indices, 0);
  for (let i = 0; i < b.indices.length; i++) {
    indices[a.indices.length + i] = b.indices[i] + vCountA;
  }

  const cx = (a.boundingCenter[0] + b.boundingCenter[0]) * 0.5;
  const cy = (a.boundingCenter[1] + b.boundingCenter[1]) * 0.5;
  const cz = (a.boundingCenter[2] + b.boundingCenter[2]) * 0.5;
  const rad = Math.max(
    a.boundingRadius +
      Math.hypot(
        a.boundingCenter[0] - cx,
        a.boundingCenter[1] - cy,
        a.boundingCenter[2] - cz,
      ),
    b.boundingRadius +
      Math.hypot(
        b.boundingCenter[0] - cx,
        b.boundingCenter[1] - cy,
        b.boundingCenter[2] - cz,
      ),
  );
  return {
    positions,
    indices,
    boundingCenter: [cx, cy, cz],
    boundingRadius: rad,
  };
}

export interface ViewportGridLineBuffers {
  baseLines: LineGeometryBuffers | null;
  midLines: LineGeometryBuffers | null;
  topLines: LineGeometryBuffers | null;
  pillarLines: LineGeometryBuffers | null;
}

export interface GlobalShellLineBuffers {
  innerLines: LineGeometryBuffers | null;
  outerLines: LineGeometryBuffers | null;
  pillarLines: LineGeometryBuffers | null;
}

function finalizeIndexedLines(
  positions: Float64Array,
  indices: Uint16Array | Uint32Array,
): LineGeometryBuffers | null {
  const vertCount = positions.length / 3;
  if (vertCount < 2 || indices.length < 2) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i];
    const y = positions[i + 1];
    const z = positions[i + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }

  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  const cz = (minZ + maxZ) * 0.5;
  let maxDistSq = 1;
  for (let i = 0; i < positions.length; i += 3) {
    const dx = positions[i] - cx;
    const dy = positions[i + 1] - cy;
    const dz = positions[i + 2] - cz;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq > maxDistSq) maxDistSq = dSq;
  }

  return {
    positions,
    indices,
    boundingCenter: [cx, cy, cz],
    boundingRadius: Math.sqrt(maxDistSq),
  };
}

function buildSubdividedAxisSamples(axis: number[], subdiv: number): number[] {
  if (subdiv <= 1 || axis.length < 2) return axis;
  const out: number[] = [];
  for (let i = 0; i < axis.length - 1; i++) {
    const a = axis[i];
    const b = axis[i + 1];
    const d = b - a;
    for (let s = 0; s < subdiv; s++) {
      out.push(a + (d * s) / subdiv);
    }
  }
  out.push(axis[axis.length - 1]);
  return out;
}

interface LonTrigTable {
  cos: Float64Array;
  sin: Float64Array;
}

interface LatTrigTable {
  cos: Float64Array;
  sin: Float64Array;
  nHoriz: Float64Array;
  nVert: Float64Array;
}

function computeLonTrig(lons: number[]): LonTrigTable {
  const n = lons.length;
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rad = lons[i] * DEG_TO_RAD;
    cos[i] = Math.cos(rad);
    sin[i] = Math.sin(rad);
  }
  return { cos, sin };
}

function computeLatTrig(lats: number[]): LatTrigTable {
  const n = lats.length;
  const cos = new Float64Array(n);
  const sin = new Float64Array(n);
  const nHoriz = new Float64Array(n);
  const nVert = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const rad = lats[i] * DEG_TO_RAD;
    const s = Math.sin(rad);
    const c = Math.cos(rad);
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * s * s);
    sin[i] = s;
    cos[i] = c;
    nHoriz[i] = N;
    nVert[i] = N * (1 - WGS84_E2);
  }
  return { cos, sin, nHoriz, nVert };
}

function buildLatLonLayerBuffers(
  lons: number[],
  lats: number[],
  alt: number,
  arcSubdiv: number,
  meridianLonCount: number,
): LineGeometryBuffers | null {
  const nLon = lons.length;
  const nLat = lats.length;
  if (nLon < 2 || nLat < 2 || meridianLonCount < 1) return null;

  if (arcSubdiv <= 1 && meridianLonCount === nLon) {
    const lonT = computeLonTrig(lons);
    const latT = computeLatTrig(lats);
    const vertCount = nLat * nLon;
    const positions = new Float64Array(vertCount * 3);

    let pOff = 0;
    for (let r = 0; r < nLat; r++) {
      const rHoriz = (latT.nHoriz[r] + alt) * latT.cos[r];
      const z = (latT.nVert[r] + alt) * latT.sin[r];
      for (let c = 0; c < nLon; c++) {
        positions[pOff++] = rHoriz * lonT.cos[c];
        positions[pOff++] = rHoriz * lonT.sin[c];
        positions[pOff++] = z;
      }
    }

    const totalSegs = nLat * (nLon - 1) + nLon * (nLat - 1);
    const indices =
      vertCount <= 65535
        ? new Uint16Array(totalSegs * 2)
        : new Uint32Array(totalSegs * 2);
    let iOff = 0;
    for (let r = 0; r < nLat; r++) {
      const rowStart = r * nLon;
      for (let c = 0; c < nLon - 1; c++) {
        indices[iOff++] = rowStart + c;
        indices[iOff++] = rowStart + c + 1;
      }
    }
    for (let c = 0; c < nLon; c++) {
      for (let r = 0; r < nLat - 1; r++) {
        indices[iOff++] = r * nLon + c;
        indices[iOff++] = (r + 1) * nLon + c;
      }
    }
    return finalizeIndexedLines(positions, indices);
  }

  const subLons = buildSubdividedAxisSamples(lons, arcSubdiv);
  const subLats = buildSubdividedAxisSamples(lats, arcSubdiv);
  const mLons = meridianLonCount === nLon ? lons : lons.slice(0, meridianLonCount);

  const subLonT = computeLonTrig(subLons);
  const latT = computeLatTrig(lats);
  const mLonT = computeLonTrig(mLons);
  const subLatT = computeLatTrig(subLats);

  const parVerts = nLat * subLons.length;
  const merVerts = mLons.length * subLats.length;
  const totalVerts = parVerts + merVerts;
  const positions = new Float64Array(totalVerts * 3);

  let pOff = 0;
  for (let r = 0; r < nLat; r++) {
    const rHoriz = (latT.nHoriz[r] + alt) * latT.cos[r];
    const z = (latT.nVert[r] + alt) * latT.sin[r];
    for (let c = 0; c < subLons.length; c++) {
      positions[pOff++] = rHoriz * subLonT.cos[c];
      positions[pOff++] = rHoriz * subLonT.sin[c];
      positions[pOff++] = z;
    }
  }
  for (let c = 0; c < mLons.length; c++) {
    const cl = mLonT.cos[c];
    const sl = mLonT.sin[c];
    for (let r = 0; r < subLats.length; r++) {
      const rHoriz = (subLatT.nHoriz[r] + alt) * subLatT.cos[r];
      positions[pOff++] = rHoriz * cl;
      positions[pOff++] = rHoriz * sl;
      positions[pOff++] = (subLatT.nVert[r] + alt) * subLatT.sin[r];
    }
  }

  const totalSegs =
    nLat * (subLons.length - 1) + mLons.length * (subLats.length - 1);
  const indices =
    totalVerts <= 65535
      ? new Uint16Array(totalSegs * 2)
      : new Uint32Array(totalSegs * 2);
  let iOff = 0;
  for (let r = 0; r < nLat; r++) {
    const base = r * subLons.length;
    for (let c = 0; c < subLons.length - 1; c++) {
      indices[iOff++] = base + c;
      indices[iOff++] = base + c + 1;
    }
  }
  for (let c = 0; c < mLons.length; c++) {
    const base = parVerts + c * subLats.length;
    for (let r = 0; r < subLats.length - 1; r++) {
      indices[iOff++] = base + r;
      indices[iOff++] = base + r + 1;
    }
  }
  return finalizeIndexedLines(positions, indices);
}

function buildGridPillarBuffers(
  lons: number[],
  lats: number[],
  baseAlt: number,
  topAlt: number,
  pillarStep: number,
  lonLimitCount: number,
): LineGeometryBuffers | null {
  if (lons.length < 1 || lats.length < 1 || topAlt <= baseAlt) return null;
  const step = Math.max(1, pillarStep);
  const rowIndices: number[] = [];
  for (let r = 0; r < lats.length; r += step) rowIndices.push(r);
  const colIndices: number[] = [];
  for (let c = 0; c < lonLimitCount; c += step) colIndices.push(c);

  const count = rowIndices.length * colIndices.length;
  if (count === 0) return null;

  const lonT = computeLonTrig(lons);
  const latT = computeLatTrig(lats);
  const positions = new Float64Array(count * 6);
  const indices =
    count * 2 <= 65535
      ? new Uint16Array(count * 2)
      : new Uint32Array(count * 2);

  let pOff = 0;
  let iOff = 0;
  let vIdx = 0;
  for (let ri = 0; ri < rowIndices.length; ri++) {
    const r = rowIndices[ri];
    const rHoriz0 = (latT.nHoriz[r] + baseAlt) * latT.cos[r];
    const z0 = (latT.nVert[r] + baseAlt) * latT.sin[r];
    const rHoriz1 = (latT.nHoriz[r] + topAlt) * latT.cos[r];
    const z1 = (latT.nVert[r] + topAlt) * latT.sin[r];

    for (let ci = 0; ci < colIndices.length; ci++) {
      const c = colIndices[ci];
      const cl = lonT.cos[c];
      const sl = lonT.sin[c];
      positions[pOff++] = rHoriz0 * cl;
      positions[pOff++] = rHoriz0 * sl;
      positions[pOff++] = z0;
      positions[pOff++] = rHoriz1 * cl;
      positions[pOff++] = rHoriz1 * sl;
      positions[pOff++] = z1;
      indices[iOff++] = vIdx;
      indices[iOff++] = vIdx + 1;
      vIdx += 2;
    }
  }
  return finalizeIndexedLines(positions, indices);
}

/**
 * 为 1.1 L2-L10 视口自适应网格构建原生 Indexed LINES 分层缓冲（底座/中层/顶层/立柱），替代高开销 PolylineCollection
 */
export function buildViewportGridLineBuffers(options: {
  lons: number[];
  lats: number[];
  layerAlts: number[];
  arcSubdiv: number;
  includePillars: boolean;
  pillarStep: number;
}): ViewportGridLineBuffers {
  const { lons, lats, layerAlts, arcSubdiv, includePillars, pillarStep } = options;
  if (lons.length < 2 || lats.length < 2 || layerAlts.length === 0) {
    return { baseLines: null, midLines: null, topLines: null, pillarLines: null };
  }

  const baseLines = buildLatLonLayerBuffers(lons, lats, layerAlts[0], arcSubdiv, lons.length);
  let midLines: LineGeometryBuffers | null = null;
  for (let li = 1; li < layerAlts.length - 1; li++) {
    const layer = buildLatLonLayerBuffers(lons, lats, layerAlts[li], arcSubdiv, lons.length);
    midLines = mergeLineBuffers(midLines, layer);
  }
  const topLines =
    layerAlts.length >= 2
      ? buildLatLonLayerBuffers(
          lons,
          lats,
          layerAlts[layerAlts.length - 1],
          arcSubdiv,
          lons.length,
        )
      : null;
  const pillarLines =
    includePillars && layerAlts.length >= 2
      ? buildGridPillarBuffers(
          lons,
          lats,
          layerAlts[0],
          layerAlts[layerAlts.length - 1],
          pillarStep,
          lons.length,
        )
      : null;

  return { baseLines, midLines, topLines, pillarLines };
}

/**
 * 为 1.1 L1 全球多层立体球壳构建一次成型的原生 Indexed LINES 缓冲（缓存复用，转动视角 0 重建）
 */
export function buildGlobalShellLineBuffers(options: {
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  stepLon: number;
  stepLat: number;
  layerAlts: number[];
  arcStepDeg?: number;
}): GlobalShellLineBuffers {
  const { minLon, maxLon, minLat, maxLat, stepLon, stepLat, layerAlts } = options;
  const arcStepDeg = Math.max(0.5, options.arcStepDeg ?? 3);

  const lons: number[] = [];
  for (let lon = minLon; lon < maxLon - 1e-6; lon += stepLon) {
    lons.push(lon);
  }
  const meridianLonCount = lons.length;
  lons.push(maxLon);

  const latStart = Math.max(-88, minLat);
  const latEnd = Math.min(88, maxLat);
  const lats: number[] = [];
  for (let lat = latStart; lat <= latEnd + 1e-6; lat += stepLat) {
    lats.push(Math.min(88, lat));
  }
  if (lats.length > 0 && lats[lats.length - 1] < latEnd - 1e-4) {
    lats.push(latEnd);
  }

  if (lons.length < 2 || lats.length < 2 || layerAlts.length === 0) {
    return { innerLines: null, outerLines: null, pillarLines: null };
  }

  const maxSegSpan = Math.max(stepLon, stepLat);
  const arcSubdiv = Math.max(1, Math.ceil(maxSegSpan / arcStepDeg));

  const outerAlt = layerAlts[layerAlts.length - 1];
  const outerLines = buildLatLonLayerBuffers(lons, lats, outerAlt, arcSubdiv, meridianLonCount);

  let innerLines: LineGeometryBuffers | null = null;
  for (let li = 0; li < layerAlts.length - 1; li++) {
    const layer = buildLatLonLayerBuffers(
      lons,
      lats,
      layerAlts[li],
      arcSubdiv,
      meridianLonCount,
    );
    innerLines = mergeLineBuffers(innerLines, layer);
  }

  const pillarLines =
    layerAlts.length >= 2
      ? buildGridPillarBuffers(lons, lats, layerAlts[0], outerAlt, 1, meridianLonCount)
      : null;

  return { innerLines, outerLines, pillarLines };
}
