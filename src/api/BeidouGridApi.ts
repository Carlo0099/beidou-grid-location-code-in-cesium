import type {
  BeidouVoxelCell,
  FlightPathAnalysisResult,
  GridBounds,
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
  getGridBounds,
  getNeighbors,
  validateCode,
} from '../core/BeidouGridCode';
import {
  analyzeFlightPlanAndDetour,
  generatePathGridsPure,
} from '../core/BeidouGridEngine';
import type { GridLayerManager } from '../core/GridLayerManager';

export { generatePathGridsPure };

export interface BeidouGridPublicApi {
  readonly version: string;
  readonly standard: string;
  encodePoint: (
    point: Wgs84Point,
    level: GridLevel,
  ) => {
    code2D: string;
    code3D: string;
    bounds2D: GridBounds;
    bounds3D: GridBounds;
  };
  decodeCode: (code: string) => GridBounds;
  validateCode: (code: string) => boolean;
  getNeighbors: (code: string) => ReturnType<typeof getNeighbors>;
  generatePathGrids: (request: PathGridGenerationRequest) => PathGridGenerationResponse;
  ingestGeoJson: (
    geoJson: unknown,
    levels?: GridLevel[],
    layerStyle?: GridLayerStyle,
  ) => PathGridGenerationResponse;
  renderLayer: (
    layerId: string,
    request: PathGridGenerationRequest,
  ) => PathGridGenerationResponse;
  clearLayer: (layerId: string) => void;
  listActiveLayers: () => string[];
  checkTrajectoryObstacles: (
    waypoints: Wgs84Point[],
    options?: {
      level?: GridLevel;
      corridorRadiusMeters?: number;
      verticalStepMeters?: number;
      maxAirspaceHeight?: number;
    },
  ) => FlightPathAnalysisResult;
}

/**
 * 解析 GeoJSON (Point / MultiPoint / LineString / MultiLineString / Feature / FeatureCollection) 为 WGS84 坐标点序列
 */
export function extractWgs84PointsFromGeoJson(geoJson: unknown): Wgs84Point[] {
  const pts: Wgs84Point[] = [];

  const pushCoord = (coord: unknown) => {
    if (!Array.isArray(coord) || coord.length < 2) return;
    const lon = Number(coord[0]);
    const lat = Number(coord[1]);
    const height = coord.length >= 3 ? Number(coord[2]) : undefined;
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      pts.push({ lon, lat, height: Number.isFinite(height) ? height : undefined });
    }
  };

  const walkGeometry = (geom: Record<string, unknown> | null | undefined) => {
    if (!geom) return;
    const type = geom.type;
    const coords = geom.coordinates;
    if (type === 'Point') {
      pushCoord(coords);
    } else if (type === 'MultiPoint' || type === 'LineString') {
      if (Array.isArray(coords)) coords.forEach(pushCoord);
    } else if (type === 'MultiLineString' || type === 'Polygon') {
      if (Array.isArray(coords)) {
        coords.forEach((ring) => {
          if (Array.isArray(ring)) ring.forEach(pushCoord);
        });
      }
    } else if (type === 'GeometryCollection' && Array.isArray(geom.geometries)) {
      geom.geometries.forEach((g) => walkGeometry(g as Record<string, unknown>));
    }
  };

  if (geoJson && typeof geoJson === 'object') {
    const obj = geoJson as Record<string, unknown>;
    if (obj.type === 'FeatureCollection' && Array.isArray(obj.features)) {
      obj.features.forEach((f) => {
        if (f && typeof f === 'object') {
          walkGeometry((f as Record<string, unknown>).geometry as Record<string, unknown>);
        }
      });
    } else if (obj.type === 'Feature') {
      walkGeometry(obj.geometry as Record<string, unknown>);
    } else {
      walkGeometry(obj);
    }
  }

  return pts;
}

/**
 * 创建挂载到 Cesium 图层引擎的运行时可调用 API 实例，并同步注册到 window.BeidouGridAPI
 */
export function createRuntimeBeidouGridApi(context: {
  getLayerManager: () => GridLayerManager | null;
  getObstacleCells: () => BeidouVoxelCell[];
  getBufferCells: () => BeidouVoxelCell[];
  onApiLayerRendered?: (layerId: string, response: PathGridGenerationResponse) => void;
}): BeidouGridPublicApi {
  const activeApiLayerIds = new Set<string>();

  const api: BeidouGridPublicApi = {
    version: '1.0.0',
    standard: 'GB/T 39409-2020 & GB/T 20254',

    encodePoint(point: Wgs84Point, level: GridLevel) {
      const h = point.height ?? 0;
      const code2D = encode2D(point.lat, point.lon, level);
      const code3D = encode3D(point.lat, point.lon, h, level);
      return {
        code2D,
        code3D,
        bounds2D: decode2D(code2D),
        bounds3D: decode3D(code3D),
      };
    },

    decodeCode(code: string) {
      return getGridBounds(code);
    },

    validateCode(code: string) {
      return validateCode(code);
    },

    getNeighbors(code: string) {
      return getNeighbors(code);
    },

    generatePathGrids(request: PathGridGenerationRequest) {
      return generatePathGridsPure(request);
    },

    ingestGeoJson(
      geoJson: unknown,
      levels: GridLevel[] = [5, 6, 7],
      layerStyle: GridLayerStyle = 'translucent-volume',
    ) {
      const coordinates = extractWgs84PointsFromGeoJson(geoJson);
      return generatePathGridsPure({
        coordinates,
        levels,
        layerStyle,
      });
    },

    renderLayer(layerId: string, request: PathGridGenerationRequest) {
      const response = generatePathGridsPure(request);
      const mgr = context.getLayerManager();
      if (mgr) {
        const allCells = response.levels.flatMap((lv) => lv.cells);
        mgr.renderVoxelCells(layerId, allCells, {
          layerStyle: response.layerStyle,
          showLabels: allCells.length <= 160,
        });
        activeApiLayerIds.add(layerId);
      }
      context.onApiLayerRendered?.(layerId, response);
      return response;
    },

    clearLayer(layerId: string) {
      const mgr = context.getLayerManager();
      mgr?.clearLayer(layerId);
      activeApiLayerIds.delete(layerId);
    },

    listActiveLayers() {
      return Array.from(activeApiLayerIds);
    },

    checkTrajectoryObstacles(waypoints, options) {
      return analyzeFlightPlanAndDetour(
        waypoints,
        context.getObstacleCells(),
        context.getBufferCells(),
        {
          level: options?.level ?? 7,
          verticalStepMeters: options?.verticalStepMeters ?? 15,
          corridorRadiusMeters: options?.corridorRadiusMeters ?? 12,
          maxAirspaceHeight: options?.maxAirspaceHeight ?? 400,
        },
      );
    },
  };

  if (typeof globalThis !== 'undefined') {
    (globalThis as { BeidouGridAPI?: BeidouGridPublicApi }).BeidouGridAPI = api;
  }

  return api;
}
