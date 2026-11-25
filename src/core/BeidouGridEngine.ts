import type {
  BeidouVoxelCell,
  FlightPathAnalysisResult,
  GridCellCategory,
  GridLayerStyle,
  GridLevel,
  PathGridGenerationRequest,
  PathGridGenerationResponse,
  Wgs84Point,
} from '../types/beidou';
import {
  decode2D,
  decode3D,
  encode2D,
  encode3D,
  getHeightResolution,
  getLevelSpec,
} from './BeidouGridCode';

const DEG_TO_RAD = Math.PI / 180;
const EARTH_RADIUS_M = 6371000;

export function haversineMeters(
  lon1: number,
  lat1: number,
  lon2: number,
  lat2: number,
): number {
  const dLat = (lat2 - lat1) * DEG_TO_RAD;
  const dLon = (lon2 - lon1) * DEG_TO_RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG_TO_RAD) *
      Math.cos(lat2 * DEG_TO_RAD) *
      Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function distance3DMeters(a: Required<Wgs84Point>, b: Required<Wgs84Point>): number {
  const horiz = haversineMeters(a.lon, a.lat, b.lon, b.lat);
  const dz = b.height - a.height;
  return Math.sqrt(horiz * horiz + dz * dz);
}

/**
 * 依据标准高度步长或自定义层高构造规范化体元编码与几何
 */
export function buildVoxelCell(
  lon: number,
  lat: number,
  height: number,
  level: GridLevel,
  category: GridCellCategory,
  customVerticalStepMeters?: number,
  extra?: Partial<BeidouVoxelCell>,
): BeidouVoxelCell {
  const code2D = encode2D(lat, lon, level);
  const bounds2D = decode2D(code2D);
  const code3D = encode3D(bounds2D.centerLat, bounds2D.centerLon, height, level);

  let minHeight: number;
  let maxHeight: number;
  if (customVerticalStepMeters && customVerticalStepMeters > 0) {
    const idx = Math.floor(Math.max(0, height) / customVerticalStepMeters);
    minHeight = idx * customVerticalStepMeters;
    maxHeight = (idx + 1) * customVerticalStepMeters;
  } else {
    const bounds3D = decode3D(code3D);
    minHeight = bounds3D.minHeight;
    maxHeight = bounds3D.maxHeight;
  }

  const centerHeight = (minHeight + maxHeight) / 2;
  const layerTag = customVerticalStepMeters
    ? `Z${Math.floor(minHeight / customVerticalStepMeters)}`
    : code3D;
  const id = `${code3D}#${layerTag}#${category}`;

  return {
    id,
    code2D,
    code3D,
    level,
    minLon: bounds2D.minLon,
    maxLon: bounds2D.maxLon,
    minLat: bounds2D.minLat,
    maxLat: bounds2D.maxLat,
    minHeight,
    maxHeight,
    centerLon: bounds2D.centerLon,
    centerLat: bounds2D.centerLat,
    centerHeight,
    category,
    label: category === 'global-shell' ? code2D : code3D,
    ...extra,
  };
}

/**
 * 在指定经纬度包络内枚举不重复的北斗二维网格单元
 */
export function enumerate2DGridsInBounds(
  bounds: { minLon: number; maxLon: number; minLat: number; maxLat: number },
  level: GridLevel,
  options?: {
    maxCells?: number;
    minHeight?: number;
    maxHeight?: number;
    category?: GridCellCategory;
  },
): BeidouVoxelCell[] {
  const spec = getLevelSpec(level);
  const maxCells = options?.maxCells ?? 1500;
  const minHeight = options?.minHeight ?? 0;
  const maxHeight = options?.maxHeight ?? getHeightResolution(level);
  const category = options?.category ?? 'local-airspace';

  const safeMinLat = Math.max(-87.5, Math.min(87.5, bounds.minLat));
  const safeMaxLat = Math.max(-87.5, Math.min(87.5, bounds.maxLat));
  const safeMinLon = Math.max(-179.99, Math.min(179.99, bounds.minLon));
  const safeMaxLon = Math.max(-179.99, Math.min(179.99, bounds.maxLon));

  const first = decode2D(encode2D(safeMinLat, safeMinLon, level));
  const last = decode2D(encode2D(safeMaxLat, safeMaxLon, level));

  let stepLon = spec.lonDeg;
  let stepLat = spec.latDeg;

  const estLonCount = Math.max(1, Math.ceil((last.centerLon - first.centerLon) / stepLon) + 1);
  const estLatCount = Math.max(1, Math.ceil((last.centerLat - first.centerLat) / stepLat) + 1);
  const totalEst = estLonCount * estLatCount;

  // 若范围过大超过渲染上限，按采样步长抽稀但仍严格对齐北斗网格边界
  let stride = 1;
  if (totalEst > maxCells) {
    stride = Math.ceil(Math.sqrt(totalEst / maxCells));
  }

  const seen = new Set<string>();
  const cells: BeidouVoxelCell[] = [];

  for (let lat = first.centerLat; lat <= last.centerLat + stepLat * 0.25; lat += stepLat * stride) {
    if (Math.abs(lat) > 87.9) continue;
    for (let lon = first.centerLon; lon <= last.centerLon + stepLon * 0.25; lon += stepLon * stride) {
      if (lon < -180 || lon >= 180) continue;
      const code2D = encode2D(lat, lon, level);
      if (seen.has(code2D)) continue;
      seen.add(code2D);

      const b = decode2D(code2D);
      const centerH = (minHeight + maxHeight) / 2;
      const code3D = encode3D(b.centerLat, b.centerLon, centerH, level);
      cells.push({
        id: `${code2D}@${Math.round(minHeight)}-${Math.round(maxHeight)}`,
        code2D,
        code3D,
        level,
        minLon: b.minLon,
        maxLon: b.maxLon,
        minLat: b.minLat,
        maxLat: b.maxLat,
        minHeight,
        maxHeight,
        centerLon: b.centerLon,
        centerLat: b.centerLat,
        centerHeight: centerH,
        category,
        label: level <= 4 ? code2D : code2D,
      });

      if (cells.length >= maxCells) {
        return cells;
      }
    }
  }

  return cells;
}

/**
 * 沿任意 WGS84 轨迹实时生成对应级别的北斗 2D/3D 路径网格序列 (GB/T 39409-2020 & GB/T 20254)
 */
export function tracePathToBeidouGrids(
  waypoints: Wgs84Point[],
  level: GridLevel,
  options?: {
    defaultHeightMeters?: number;
    corridorRadiusMeters?: number;
    verticalStepMeters?: number;
    category?: GridCellCategory;
  },
): BeidouVoxelCell[] {
  if (waypoints.length === 0) return [];

  const defaultH = options?.defaultHeightMeters ?? 120;
  const radius = options?.corridorRadiusMeters ?? 0;
  const vStep = options?.verticalStepMeters;
  const category = options?.category ?? 'flight-corridor';
  const spec = getLevelSpec(level);
  const effectiveVStep = vStep ?? getHeightResolution(level);

  const normalized: Required<Wgs84Point>[] = waypoints.map((pt, idx) => ({
    lon: pt.lon,
    lat: pt.lat,
    height: pt.height ?? defaultH,
    timestamp: pt.timestamp ?? idx,
  }));

  const cellMap = new Map<string, BeidouVoxelCell>();

  const addPointWithCorridor = (lon: number, lat: number, height: number) => {
    const centerCell = buildVoxelCell(lon, lat, height, level, category, vStep);
    if (!cellMap.has(centerCell.id)) {
      cellMap.set(centerCell.id, centerCell);
    }

    if (radius > 0) {
      const metersPerLatDeg = 111320;
      const metersPerLonDeg = 111320 * Math.max(0.2, Math.cos(lat * DEG_TO_RAD));
      const dLat = (centerCell.maxLat - centerCell.minLat);
      const dLon = (centerCell.maxLon - centerCell.minLon);
      const cellHorizM = Math.max(1, dLon * metersPerLonDeg);
      const cellLatM = Math.max(1, dLat * metersPerLatDeg);
      const ringLon = Math.min(4, Math.ceil(radius / cellHorizM));
      const ringLat = Math.min(4, Math.ceil(radius / cellLatM));
      const ringZ = Math.min(3, Math.ceil(radius / Math.max(1, effectiveVStep)));

      for (let iz = -ringZ; iz <= ringZ; iz++) {
        for (let iy = -ringLat; iy <= ringLat; iy++) {
          for (let ix = -ringLon; ix <= ringLon; ix++) {
            const offsetDist = Math.sqrt(
              (ix * cellHorizM) ** 2 + (iy * cellLatM) ** 2 + (iz * effectiveVStep) ** 2,
            );
            if (offsetDist > radius * 1.15) continue;
            const nLat = lat + iy * dLat;
            const nLon = lon + ix * dLon;
            const nH = Math.max(0, height + iz * effectiveVStep);
            const nCell = buildVoxelCell(nLon, nLat, nH, level, category, vStep);
            if (!cellMap.has(nCell.id)) {
              cellMap.set(nCell.id, nCell);
            }
          }
        }
      }
    }
  };

  if (normalized.length === 1) {
    addPointWithCorridor(normalized[0].lon, normalized[0].lat, normalized[0].height);
    return Array.from(cellMap.values());
  }

  const horizSampleM = Math.max(1.5, Math.min(spec.approxGroundMeters * 0.35, 30));
  const vertSampleM = Math.max(1.5, Math.min(effectiveVStep * 0.35, 25));

  for (let i = 0; i < normalized.length - 1; i++) {
    const p0 = normalized[i];
    const p1 = normalized[i + 1];
    const horizDist = haversineMeters(p0.lon, p0.lat, p1.lon, p1.lat);
    const vertDist = Math.abs(p1.height - p0.height);
    const steps = Math.max(
      1,
      Math.ceil(horizDist / horizSampleM),
      Math.ceil(vertDist / vertSampleM),
    );
    const safeSteps = Math.min(steps, 1500);

    for (let s = 0; s <= safeSteps; s++) {
      const t = s / safeSteps;
      const lon = p0.lon + (p1.lon - p0.lon) * t;
      const lat = p0.lat + (p1.lat - p0.lat) * t;
      const height = p0.height + (p1.height - p0.height) * t;
      addPointWithCorridor(lon, lat, height);
    }
  }

  return Array.from(cellMap.values());
}

/**
 * 飞行计划避障冲突检测 + 基于北斗三维网格的 A* 避障重规划
 */
export function analyzeFlightPlanAndDetour(
  waypointsInput: Wgs84Point[],
  obstacleCells: BeidouVoxelCell[],
  bufferCells: BeidouVoxelCell[],
  options: {
    level: GridLevel;
    verticalStepMeters: number;
    corridorRadiusMeters: number;
    maxAirspaceHeight: number;
  },
): FlightPathAnalysisResult {
  const waypoints: Required<Wgs84Point>[] = waypointsInput.map((w, idx) => ({
    lon: w.lon,
    lat: w.lat,
    height: w.height ?? 120,
    timestamp: w.timestamp ?? idx,
  }));

  const { level, verticalStepMeters, corridorRadiusMeters, maxAirspaceHeight } = options;

  // 用 (code2D + zIndex) 作为高速网格键
  const toVoxelKey = (code2D: string, zIdx: number) => `${code2D}#${zIdx}`;
  const zIndexOf = (h: number) => Math.floor(Math.max(0, h) / verticalStepMeters);

  const obstacleByKey = new Map<string, BeidouVoxelCell>();
  for (const c of obstacleCells) {
    obstacleByKey.set(toVoxelKey(c.code2D, zIndexOf(c.centerHeight)), c);
  }

  const bufferByKey = new Map<string, BeidouVoxelCell>();
  for (const c of bufferCells) {
    const key = toVoxelKey(c.code2D, zIndexOf(c.centerHeight));
    if (!obstacleByKey.has(key)) {
      bufferByKey.set(key, c);
    }
  }

  const rawPathCells = tracePathToBeidouGrids(waypoints, level, {
    corridorRadiusMeters,
    verticalStepMeters,
    category: 'flight-corridor',
  });

  const pathCells: BeidouVoxelCell[] = [];
  const conflictCells: BeidouVoxelCell[] = [];
  const bufferWarningCells: BeidouVoxelCell[] = [];

  for (const cell of rawPathCells) {
    const key = toVoxelKey(cell.code2D, zIndexOf(cell.centerHeight));
    if (obstacleByKey.has(key)) {
      conflictCells.push({
        ...cell,
        category: 'flight-conflict',
        buildingName: obstacleByKey.get(key)?.buildingName,
      });
    } else if (bufferByKey.has(key)) {
      bufferWarningCells.push({
        ...cell,
        category: 'flight-conflict',
        label: cell.code3D,
      });
    } else {
      pathCells.push(cell);
    }
  }

  let totalDistanceMeters = 0;
  for (let i = 0; i < waypoints.length - 1; i++) {
    totalDistanceMeters += distance3DMeters(waypoints[i], waypoints[i + 1]);
  }

  // 计算航点采样点到最近障碍体元的近似最小净距
  let minClearanceMeters = Infinity;
  if (obstacleCells.length > 0 && waypoints.length >= 2) {
    const sampleStep = Math.max(10, verticalStepMeters);
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i];
      const b = waypoints[i + 1];
      const segLen = distance3DMeters(a, b);
      const count = Math.min(80, Math.max(2, Math.ceil(segLen / sampleStep)));
      for (let s = 0; s <= count; s++) {
        const t = s / count;
        const p = {
          lon: a.lon + (b.lon - a.lon) * t,
          lat: a.lat + (b.lat - a.lat) * t,
          height: a.height + (b.height - a.height) * t,
          timestamp: 0,
        };
        for (let k = 0; k < obstacleCells.length; k++) {
          const oc = obstacleCells[k];
          if (
            Math.abs(oc.centerLon - p.lon) > 0.01 ||
            Math.abs(oc.centerLat - p.lat) > 0.01
          ) {
            continue;
          }
          const d = distance3DMeters(p, {
            lon: oc.centerLon,
            lat: oc.centerLat,
            height: oc.centerHeight,
            timestamp: 0,
          });
          if (d < minClearanceMeters) minClearanceMeters = d;
        }
      }
    }
  }
  if (!Number.isFinite(minClearanceMeters)) minClearanceMeters = 999;

  const isSafe = conflictCells.length === 0 && bufferWarningCells.length === 0;

  // 若存在冲突或避障区侵入，在三维北斗体元空间运行 A* 自动生成避障绕飞航线
  let detourWaypoints: Required<Wgs84Point>[] = [];
  let detourCells: BeidouVoxelCell[] = [];

  if (!isSafe && waypoints.length >= 2) {
    detourWaypoints = computeBeidouGridDetour(
      waypoints,
      obstacleByKey,
      bufferByKey,
      level,
      verticalStepMeters,
      maxAirspaceHeight,
    );
    if (detourWaypoints.length >= 2) {
      detourCells = tracePathToBeidouGrids(detourWaypoints, level, {
        corridorRadiusMeters: 0,
        verticalStepMeters,
        category: 'flight-detour',
      });
    }
  }

  return {
    waypoints,
    level,
    corridorRadiusMeters,
    pathCells,
    conflictCells,
    bufferWarningCells,
    detourWaypoints,
    detourCells,
    isSafe,
    minClearanceMeters: Math.max(0, Math.round(minClearanceMeters * 10) / 10),
    summary: {
      totalDistanceMeters: Math.round(totalDistanceMeters),
      totalPathVoxels: rawPathCells.length,
      conflictCount: conflictCells.length,
      bufferWarningCount: bufferWarningCells.length,
      hasDetour: detourWaypoints.length >= 2,
    },
  };
}

/**
 * 在北斗三维网格坐标系内执行轻量 3D A* 避障航线规划
 */
function computeBeidouGridDetour(
  waypoints: Required<Wgs84Point>[],
  obstacleByKey: Map<string, BeidouVoxelCell>,
  bufferByKey: Map<string, BeidouVoxelCell>,
  level: GridLevel,
  verticalStepMeters: number,
  maxAirspaceHeight: number,
): Required<Wgs84Point>[] {
  const start = waypoints[0];
  const end = waypoints[waypoints.length - 1];
  const spec = getLevelSpec(level);
  const dLon = spec.lonDeg;
  const dLat = spec.latDeg;

  const originB = decode2D(encode2D(start.lat, start.lon, level));
  const originLon = originB.centerLon;
  const originLat = originB.centerLat;

  const toIx = (lon: number) => Math.round((lon - originLon) / dLon);
  const toIy = (lat: number) => Math.round((lat - originLat) / dLat);
  const toIz = (h: number) => Math.max(0, Math.floor(h / verticalStepMeters));

  const startIdx = { ix: toIx(start.lon), iy: toIy(start.lat), iz: toIz(start.height) };
  const goalIdx = { ix: toIx(end.lon), iy: toIy(end.lat), iz: toIz(end.height) };

  const pad = 12;
  const minIx = Math.min(startIdx.ix, goalIdx.ix) - pad;
  const maxIx = Math.max(startIdx.ix, goalIdx.ix) + pad;
  const minIy = Math.min(startIdx.iy, goalIdx.iy) - pad;
  const maxIy = Math.max(startIdx.iy, goalIdx.iy) + pad;
  const maxIz = Math.max(startIdx.iz + 6, goalIdx.iz + 6, Math.ceil(maxAirspaceHeight / verticalStepMeters));

  const idOf = (ix: number, iy: number, iz: number) => `${ix},${iy},${iz}`;

  const getCellState = (ix: number, iy: number, iz: number): 'free' | 'buffer' | 'blocked' => {
    const lat = originLat + iy * dLat;
    const lon = originLon + ix * dLon;
    if (Math.abs(lat) > 87) return 'blocked';
    const code2D = encode2D(lat, lon, level);
    const key = `${code2D}#${iz}`;
    if (obstacleByKey.has(key)) return 'blocked';
    if (bufferByKey.has(key)) return 'buffer';
    return 'free';
  };

  interface Node {
    ix: number;
    iy: number;
    iz: number;
    g: number;
    f: number;
    parent: string | null;
  }

  const open = new Map<string, Node>();
  const closed = new Set<string>();
  const cameFrom = new Map<string, Node>();

  const heuristic = (ix: number, iy: number, iz: number) =>
    Math.sqrt((goalIdx.ix - ix) ** 2 + (goalIdx.iy - iy) ** 2 + (goalIdx.iz - iz) ** 2);

  const startId = idOf(startIdx.ix, startIdx.iy, startIdx.iz);
  const goalId = idOf(goalIdx.ix, goalIdx.iy, goalIdx.iz);

  const startNode: Node = {
    ...startIdx,
    g: 0,
    f: heuristic(startIdx.ix, startIdx.iy, startIdx.iz),
    parent: null,
  };
  open.set(startId, startNode);
  cameFrom.set(startId, startNode);

  // 6-邻域 + 同层4对角线（避免穿角碰撞）
  const dirs: Array<[number, number, number, number]> = [
    [1, 0, 0, 1],
    [-1, 0, 0, 1],
    [0, 1, 0, 1],
    [0, -1, 0, 1],
    [0, 0, 1, 1.35],
    [0, 0, -1, 1.35],
    [1, 1, 0, 1.414],
    [1, -1, 0, 1.414],
    [-1, 1, 0, 1.414],
    [-1, -1, 0, 1.414],
  ];

  let iterations = 0;
  const maxIterations = 8000;
  let reachedGoalId: string | null = null;

  while (open.size > 0 && iterations < maxIterations) {
    iterations++;
    let bestId = '';
    let bestNode: Node | null = null;
    for (const [k, n] of open) {
      if (!bestNode || n.f < bestNode.f) {
        bestNode = n;
        bestId = k;
      }
    }
    if (!bestNode) break;

    if (bestId === goalId) {
      reachedGoalId = bestId;
      break;
    }

    open.delete(bestId);
    closed.add(bestId);

    for (const [dx, dy, dz, cost] of dirs) {
      const nx = bestNode.ix + dx;
      const ny = bestNode.iy + dy;
      const nz = bestNode.iz + dz;
      if (nx < minIx || nx > maxIx || ny < minIy || ny > maxIy || nz < 1 || nz > maxIz) {
        continue;
      }
      const nId = idOf(nx, ny, nz);
      if (closed.has(nId)) continue;

      const state = getCellState(nx, ny, nz);
      if (state === 'blocked' && nId !== goalId && nId !== startId) {
        continue;
      }

      const penalty = state === 'buffer' ? 8.0 : 0;
      const tentativeG = bestNode.g + cost + penalty;
      const existing = open.get(nId);
      if (!existing || tentativeG < existing.g) {
        const nextNode: Node = {
          ix: nx,
          iy: ny,
          iz: nz,
          g: tentativeG,
          f: tentativeG + heuristic(nx, ny, nz),
          parent: bestId,
        };
        open.set(nId, nextNode);
        cameFrom.set(nId, nextNode);
      }
    }
  }

  if (!reachedGoalId) {
    // 若局部搜索达到上限，生成安全高空越障航线
    const safeAlt = Math.min(maxAirspaceHeight, Math.max(start.height, end.height) + 180);
    return [
      start,
      { lon: start.lon, lat: start.lat, height: safeAlt, timestamp: 1 },
      { lon: end.lon, lat: end.lat, height: safeAlt, timestamp: 2 },
      end,
    ];
  }

  const chain: Node[] = [];
  let cur: string | null = reachedGoalId;
  while (cur) {
    const node = cameFrom.get(cur);
    if (!node) break;
    chain.push(node);
    cur = node.parent;
  }
  chain.reverse();

  // 共线简化航路点
  const simplified: Required<Wgs84Point>[] = [];
  for (let i = 0; i < chain.length; i++) {
    const n = chain[i];
    if (i === 0) {
      simplified.push(start);
      continue;
    }
    if (i === chain.length - 1) {
      simplified.push(end);
      continue;
    }
    const prev = chain[i - 1];
    const next = chain[i + 1];
    const sameDir =
      n.ix - prev.ix === next.ix - n.ix &&
      n.iy - prev.iy === next.iy - n.iy &&
      n.iz - prev.iz === next.iz - n.iz;
    if (!sameDir) {
      simplified.push({
        lon: originLon + n.ix * dLon,
        lat: originLat + n.iy * dLat,
        height: (n.iz + 0.5) * verticalStepMeters,
        timestamp: i,
      });
    }
  }

  return simplified;
}

/**
 * 构建纯算法路径网格生成结果（无 DOM/Cesium 依赖，可在浏览器、Node 中间件及单元测试复用）
 */
export function generatePathGridsPure(
  request: PathGridGenerationRequest,
): PathGridGenerationResponse {
  const coordinates = request.coordinates ?? [];
  const levels = (request.levels && request.levels.length > 0
    ? request.levels
    : [6]) as GridLevel[];
  const layerStyle: GridLayerStyle = request.layerStyle ?? 'translucent-volume';
  const defaultHeightMeters = request.defaultHeightMeters ?? 120;
  const corridorRadiusMeters = request.corridorRadiusMeters ?? 0;

  const levelResults = levels.map((lv) => {
    const cells = tracePathToBeidouGrids(coordinates, lv, {
      defaultHeightMeters,
      corridorRadiusMeters,
      category: 'flight-corridor',
    });

    const codes2DSet = new Set<string>();
    const codes3DSet = new Set<string>();
    for (const c of cells) {
      codes2DSet.add(c.code2D);
      codes3DSet.add(c.code3D);
    }

    return {
      level: lv,
      cellCount: cells.length,
      codes2D: Array.from(codes2DSet),
      codes3D: Array.from(codes3DSet),
      cells,
    };
  });

  return {
    standard: 'GB/T 39409-2020 & GB/T 20254',
    generatedAt: new Date().toISOString(),
    pointCount: coordinates.length,
    layerStyle,
    levels: levelResults,
  };
}

