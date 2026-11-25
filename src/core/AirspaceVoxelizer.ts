import type {
  BeidouVoxelCell,
  BuildingFootprint,
  VoxelizationConfig,
} from '../types/beidou';
import { decode2D, encode2D, encode3D, getLevelSpec } from './BeidouGridCode';

const DEG_TO_RAD = Math.PI / 180;

export interface VoxelizationResult {
  obstacleCells: BeidouVoxelCell[];
  bufferCells: BeidouVoxelCell[];
  airspaceStrataCells: BeidouVoxelCell[];
  stats: {
    buildingCount: number;
    obstacleVoxelCount: number;
    bufferVoxelCount: number;
    strataVoxelCount: number;
  };
}

/**
 * 射线法判断点是否在二维多边形内
 */
export function pointInPolygon(
  lon: number,
  lat: number,
  polygon: Array<[number, number]>,
): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i][0];
    const yi = polygon[i][1];
    const xj = polygon[j][0];
    const yj = polygon[j][1];

    const intersect =
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/**
 * 判断二维北斗网格单元是否与建筑物底面多边形相交
 */
function cellIntersectsBuilding(
  minLon: number,
  maxLon: number,
  minLat: number,
  maxLat: number,
  building: BuildingFootprint,
): boolean {
  if (
    maxLon < building.minLon ||
    minLon > building.maxLon ||
    maxLat < building.minLat ||
    minLat > building.maxLat
  ) {
    return false;
  }

  if (building.polygon.length < 3) {
    return true;
  }

  // 1. 建筑多边形任意顶点落在网格内
  for (let i = 0; i < building.polygon.length; i++) {
    const [vx, vy] = building.polygon[i];
    if (vx >= minLon && vx <= maxLon && vy >= minLat && vy <= maxLat) {
      return true;
    }
  }

  // 2. 网格中心或四角落在建筑多边形内
  const cLon = (minLon + maxLon) * 0.5;
  const cLat = (minLat + maxLat) * 0.5;
  if (
    pointInPolygon(cLon, cLat, building.polygon) ||
    pointInPolygon(minLon, minLat, building.polygon) ||
    pointInPolygon(maxLon, minLat, building.polygon) ||
    pointInPolygon(maxLon, maxLat, building.polygon) ||
    pointInPolygon(minLon, maxLat, building.polygon)
  ) {
    return true;
  }

  return false;
}

/**
 * 将提取的建筑物轮廓体素化为北斗三维空间网格，并自动生成周边避障安全缓冲区
 */
export function voxelizeBuildingsToBeidouAirspace(
  buildings: BuildingFootprint[],
  roiBounds: { minLon: number; maxLon: number; minLat: number; maxLat: number },
  config: VoxelizationConfig,
): VoxelizationResult {
  const {
    level,
    verticalStepMeters,
    horizontalBufferMeters,
    verticalBufferMeters,
    minAirspaceHeight,
    maxAirspaceHeight,
    includeAirspaceStrata,
    maxVoxels = 6000,
  } = config;

  const spec = getLevelSpec(level);
  const stepLon = spec.lonDeg;
  const stepLat = spec.latDeg;
  const vStep = Math.max(2, verticalStepMeters);

  // 记录每个 2D 网格单元被占用的最大高度区间
  interface OccupiedColumn {
    code2D: string;
    minLon: number;
    maxLon: number;
    minLat: number;
    maxLat: number;
    centerLon: number;
    centerLat: number;
    minZ: number;
    maxZ: number;
    buildingId: string;
    buildingName: string;
  }

  const columnMap = new Map<string, OccupiedColumn>();

  for (const bld of buildings) {
    if (
      bld.maxLon < roiBounds.minLon ||
      bld.minLon > roiBounds.maxLon ||
      bld.maxLat < roiBounds.minLat ||
      bld.minLat > roiBounds.maxLat
    ) {
      continue;
    }

    const startCell = decode2D(encode2D(bld.minLat, bld.minLon, level));
    const endCell = decode2D(encode2D(bld.maxLat, bld.maxLon, level));

    const minZ = Math.max(0, Math.floor(Math.max(minAirspaceHeight, bld.baseHeight) / vStep));
    const maxZ = Math.min(
      Math.ceil(maxAirspaceHeight / vStep),
      Math.max(minZ, Math.floor(bld.roofHeight / vStep)),
    );

    for (let lat = startCell.centerLat; lat <= endCell.centerLat + stepLat * 0.25; lat += stepLat) {
      for (let lon = startCell.centerLon; lon <= endCell.centerLon + stepLon * 0.25; lon += stepLon) {
        const code2D = encode2D(lat, lon, level);
        const cb = decode2D(code2D);
        if (!cellIntersectsBuilding(cb.minLon, cb.maxLon, cb.minLat, cb.maxLat, bld)) {
          continue;
        }

        const existing = columnMap.get(code2D);
        if (existing) {
          existing.minZ = Math.min(existing.minZ, minZ);
          existing.maxZ = Math.max(existing.maxZ, maxZ);
        } else {
          columnMap.set(code2D, {
            code2D,
            minLon: cb.minLon,
            maxLon: cb.maxLon,
            minLat: cb.minLat,
            maxLat: cb.maxLat,
            centerLon: cb.centerLon,
            centerLat: cb.centerLat,
            minZ,
            maxZ,
            buildingId: bld.id,
            buildingName: bld.name,
          });
        }
      }
    }
  }

  const obstacleCells: BeidouVoxelCell[] = [];
  const obstacleKeys = new Set<string>();

  for (const col of columnMap.values()) {
    for (let z = col.minZ; z <= col.maxZ; z++) {
      if (obstacleCells.length >= maxVoxels) break;
      const minH = z * vStep;
      const maxH = (z + 1) * vStep;
      const centerH = (minH + maxH) * 0.5;
      const code3D = encode3D(col.centerLat, col.centerLon, centerH, level);
      const key = `${col.code2D}#${z}`;
      obstacleKeys.add(key);

      obstacleCells.push({
        id: `${key}#building`,
        code2D: col.code2D,
        code3D,
        level,
        minLon: col.minLon,
        maxLon: col.maxLon,
        minLat: col.minLat,
        maxLat: col.maxLat,
        minHeight: minH,
        maxHeight: maxH,
        centerLon: col.centerLon,
        centerLat: col.centerLat,
        centerHeight: centerH,
        category: 'building-obstacle',
        label: z === col.maxZ ? code3D : undefined,
        buildingId: col.buildingId,
        buildingName: col.buildingName,
      });
    }
    if (obstacleCells.length >= maxVoxels) break;
  }

  // 计算周边避障区域网格 (Horizontal Buffer Rings + Vertical Clearance)
  const bufferCells: BeidouVoxelCell[] = [];
  const bufferKeys = new Set<string>();

  const midLat = (roiBounds.minLat + roiBounds.maxLat) * 0.5;
  const cellWidthM = Math.max(1, stepLon * 111320 * Math.cos(midLat * DEG_TO_RAD));
  const cellHeightM = Math.max(1, stepLat * 111320);

  const ringX = horizontalBufferMeters > 0 ? Math.min(3, Math.ceil(horizontalBufferMeters / cellWidthM)) : 0;
  const ringY = horizontalBufferMeters > 0 ? Math.min(3, Math.ceil(horizontalBufferMeters / cellHeightM)) : 0;
  const ringZ = verticalBufferMeters > 0 ? Math.min(3, Math.ceil(verticalBufferMeters / vStep)) : 0;

  if (ringX > 0 || ringY > 0 || ringZ > 0) {
    const bufferBudget = Math.max(800, Math.floor(maxVoxels * 0.65));

    for (const col of columnMap.values()) {
      if (bufferCells.length >= bufferBudget) break;

      // 仅对建筑外壳和屋顶向上扩充避障体元，避免对地底做无效扩展
      for (let iy = -ringY; iy <= ringY; iy++) {
        for (let ix = -ringX; ix <= ringX; ix++) {
          const distHoriz = Math.sqrt((ix * cellWidthM) ** 2 + (iy * cellHeightM) ** 2);
          if (distHoriz > horizontalBufferMeters + Math.max(cellWidthM, cellHeightM) * 0.5) {
            continue;
          }

          const nLat = col.centerLat + iy * stepLat;
          const nLon = col.centerLon + ix * stepLon;
          const nCode2D = encode2D(nLat, nLon, level);
          const nBounds = decode2D(nCode2D);

          const zTop = Math.min(Math.ceil(maxAirspaceHeight / vStep), col.maxZ + ringZ);
          // 对紧邻侧面保留从底部到屋顶+缓冲的高度；纯屋顶正上方仅保留屋顶以上缓冲层
          const zStart = ix === 0 && iy === 0 ? col.maxZ + 1 : col.minZ;

          for (let z = zStart; z <= zTop; z++) {
            const key = `${nCode2D}#${z}`;
            if (obstacleKeys.has(key) || bufferKeys.has(key)) continue;
            bufferKeys.add(key);

            const minH = z * vStep;
            const maxH = (z + 1) * vStep;
            const centerH = (minH + maxH) * 0.5;
            const code3D = encode3D(nBounds.centerLat, nBounds.centerLon, centerH, level);

            bufferCells.push({
              id: `${key}#buffer`,
              code2D: nCode2D,
              code3D,
              level,
              minLon: nBounds.minLon,
              maxLon: nBounds.maxLon,
              minLat: nBounds.minLat,
              maxLat: nBounds.maxLat,
              minHeight: minH,
              maxHeight: maxH,
              centerLon: nBounds.centerLon,
              centerLat: nBounds.centerLat,
              centerHeight: centerH,
              category: 'obstacle-buffer',
              distanceToObstacleMeters: Math.round(distHoriz),
              buildingName: col.buildingName,
            });

            if (bufferCells.length >= bufferBudget) break;
          }
          if (bufferCells.length >= bufferBudget) break;
        }
        if (bufferCells.length >= bufferBudget) break;
      }
    }
  }

  // 低空空域基底与空域分层面网格（参考图 4 / 图 7 的城市级铺底与空中分层结构）
  const airspaceStrataCells: BeidouVoxelCell[] = [];
  if (includeAirspaceStrata) {
    const startCell = decode2D(encode2D(roiBounds.minLat, roiBounds.minLon, level));
    const endCell = decode2D(encode2D(roiBounds.maxLat, roiBounds.maxLon, level));

    // 当 L7 太密时自动采用父级/隔行抽稀以保持基底网络流畅美观
    const rawCols = Math.max(1, Math.round((endCell.centerLon - startCell.centerLon) / stepLon) + 1);
    const rawRows = Math.max(1, Math.round((endCell.centerLat - startCell.centerLat) / stepLat) + 1);
    const total2D = rawCols * rawRows;
    const stride = total2D > 900 ? Math.ceil(Math.sqrt(total2D / 900)) : 1;

    const strataLevels = [
      Math.max(minAirspaceHeight, 0),
      Math.min(maxAirspaceHeight - vStep, Math.round(maxAirspaceHeight * 0.35 / vStep) * vStep),
    ];

    for (const hBase of strataLevels) {
      const z = Math.floor(hBase / vStep);
      for (let lat = startCell.centerLat; lat <= endCell.centerLat + stepLat * 0.25; lat += stepLat * stride) {
        for (let lon = startCell.centerLon; lon <= endCell.centerLon + stepLon * 0.25; lon += stepLon * stride) {
          const code2D = encode2D(lat, lon, level);
          const key = `${code2D}#${z}`;
          if (obstacleKeys.has(key)) continue;
          const b = decode2D(code2D);
          const minH = z * vStep;
          const maxH = minH + vStep;
          const centerH = (minH + maxH) * 0.5;
          airspaceStrataCells.push({
            id: `${key}#strata`,
            code2D,
            code3D: encode3D(b.centerLat, b.centerLon, centerH, level),
            level,
            minLon: b.minLon,
            maxLon: b.maxLon,
            minLat: b.minLat,
            maxLat: b.maxLat,
            minHeight: minH,
            maxHeight: maxH,
            centerLon: b.centerLon,
            centerLat: b.centerLat,
            centerHeight: centerH,
            category: 'airspace-free',
          });
        }
      }
    }
  }

  return {
    obstacleCells,
    bufferCells,
    airspaceStrataCells,
    stats: {
      buildingCount: buildings.length,
      obstacleVoxelCount: obstacleCells.length,
      bufferVoxelCount: bufferCells.length,
      strataVoxelCount: airspaceStrataCells.length,
    },
  };
}
