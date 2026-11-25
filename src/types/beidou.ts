export type GridLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type GridLayerStyle =
  | '2d-plane'
  | '3d-wireframe'
  | 'translucent-volume'
  | 'hybrid';

export type GridCellCategory =
  | 'global-shell'
  | 'local-airspace'
  | 'airspace-free'
  | 'building-obstacle'
  | 'obstacle-buffer'
  | 'flight-corridor'
  | 'flight-conflict'
  | 'flight-detour'
  | 'query-highlight';

export interface GridLevelSpec {
  level: GridLevel;
  name: string;
  angularLabel: string;
  lonDeg: number;
  latDeg: number;
  approxGroundMeters: number;
  heightResolutionMeters: number;
  codeLength2D: number;
  codeLength3D: number;
  recommendedScale: string;
}

export interface GridBounds2D {
  code: string;
  level: GridLevel;
  minLat: number;
  maxLat: number;
  minLon: number;
  maxLon: number;
  centerLat: number;
  centerLon: number;
}

export interface GridBounds3D extends GridBounds2D {
  minHeight: number;
  maxHeight: number;
  centerHeight: number;
  is3D: true;
}

export type GridBounds = GridBounds2D | (GridBounds3D & { is3D?: boolean });

export interface Wgs84Point {
  lon: number;
  lat: number;
  height?: number;
  timestamp?: string | number;
}

export interface BeidouVoxelCell {
  id: string;
  code2D: string;
  code3D: string;
  level: GridLevel;
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  minHeight: number;
  maxHeight: number;
  centerLon: number;
  centerLat: number;
  centerHeight: number;
  category: GridCellCategory;
  label?: string;
  buildingId?: string;
  buildingName?: string;
  distanceToObstacleMeters?: number;
}

export interface BuildingFootprint {
  id: string;
  name: string;
  source: '3dtiles-glb' | '3dtiles-tile' | 'sample-cbd';
  minLon: number;
  maxLon: number;
  minLat: number;
  maxLat: number;
  baseHeight: number;
  roofHeight: number;
  /** Ordered 2D polygon ring [lon, lat][] in degrees */
  polygon: Array<[number, number]>;
}

export interface VoxelizationConfig {
  level: GridLevel;
  /** Vertical step in meters (defaults to Beidou HEIGHT_STEPS[level - 1] or custom slice) */
  verticalStepMeters: number;
  /** Horizontal obstacle buffer distance in meters */
  horizontalBufferMeters: number;
  /** Vertical obstacle clearance buffer above building roofs in meters */
  verticalBufferMeters: number;
  /** Minimum airspace altitude floor in meters */
  minAirspaceHeight: number;
  /** Maximum airspace altitude ceiling in meters */
  maxAirspaceHeight: number;
  /** Whether to also generate free-airspace background strata grid */
  includeAirspaceStrata: boolean;
  /** Maximum buildings / voxels guard */
  maxVoxels?: number;
}

export interface FlightPathAnalysisResult {
  waypoints: Required<Wgs84Point>[];
  level: GridLevel;
  corridorRadiusMeters: number;
  pathCells: BeidouVoxelCell[];
  conflictCells: BeidouVoxelCell[];
  bufferWarningCells: BeidouVoxelCell[];
  detourWaypoints: Required<Wgs84Point>[];
  detourCells: BeidouVoxelCell[];
  isSafe: boolean;
  minClearanceMeters: number;
  summary: {
    totalDistanceMeters: number;
    totalPathVoxels: number;
    conflictCount: number;
    bufferWarningCount: number;
    hasDetour: boolean;
  };
}

export interface PathGridGenerationRequest {
  coordinates: Wgs84Point[];
  levels: GridLevel[];
  layerStyle?: GridLayerStyle;
  corridorRadiusMeters?: number;
  defaultHeightMeters?: number;
  includeNeighbors?: boolean;
}

export interface PathGridGenerationResponse {
  standard: 'GB/T 39409-2020 & GB/T 20254';
  generatedAt: string;
  pointCount: number;
  layerStyle: GridLayerStyle;
  levels: Array<{
    level: GridLevel;
    cellCount: number;
    codes2D: string[];
    codes3D: string[];
    cells: BeidouVoxelCell[];
  }>;
}

export interface CityPreset {
  id: string;
  name: string;
  subtitle: string;
  lon: number;
  lat: number;
  height: number;
  heading: number;
  pitch: number;
  tilesetKey?: 'shenzhen' | 'luohu' | 'guangzhou' | 'hongkong' | 'sample-cbd';
  roiRadiusDeg: number;
}

export interface LocalAssetsAvailability {
  tiles: boolean;
  terrain: boolean;
  tilesets: {
    shenzhen: boolean;
    luohu: boolean;
    guangzhou: boolean;
    hongkong: boolean;
    macau: boolean;
  };
}

export interface TelemetrySnapshot {
  fps: number;
  cameraHeightMeters: number;
  adaptiveLevel: GridLevel;
  mouseLon: number | null;
  mouseLat: number | null;
  mouseHeight: number | null;
  mouseCode2D: string;
  mouseCode3D: string;
  renderedVoxelCount: number;
  renderedBuildingCount: number;
}
