import type {
  BeidouVoxelCell,
  CameraViewInfo,
  ElevationColorThresholds,
  FlightPathAnalysisResult,
  GridLayerStyle,
  GridLevel,
  MassiveVoxelLodMode,
  MassiveVoxelStats,
  MassiveVoxelStyle,
  PathGridGenerationResponse,
  Wgs84Point,
} from "../../types/beidou";
import type { FutianLandmarkPreset } from "../../core/MassiveVoxelEngine";

export type WorkbenchTab =
  | "global-local"
  | "futian-voxel-sim"
  | "airspace-obstacle"
  | "dynamic-api";

export const LAYER_STYLES: Array<{ value: GridLayerStyle; label: string }> = [
  { value: "2d-plane", label: "2D 平面" },
  { value: "3d-wireframe", label: "3D 立体" },
  { value: "translucent-volume", label: "半透明体" },
  { value: "hybrid", label: "融合叠加" },
];

export interface GlobalGridPanelProps {
  cameraView: CameraViewInfo;
  onFlyToGlobal: () => void;
  gridLevel: GridLevel;
  onChangeGridLevel: (lv: GridLevel) => void;
  adaptiveLevelEnabled: boolean;
  onToggleAdaptiveLevel: (v: boolean) => void;
  layerStyle: GridLayerStyle;
  onChangeLayerStyle: (s: GridLayerStyle) => void;
  showGlobalShell: boolean;
  onToggleGlobalShell: (v: boolean) => void;
  showLocalGrid: boolean;
  onToggleLocalGrid: (v: boolean) => void;
  showGridLabels: boolean;
  onToggleGridLabels: (v: boolean) => void;
  turbo244Mode: boolean;
  onToggleTurbo244Mode: (v: boolean) => void;
  onQueryPointOrCode: (point?: Wgs84Point, code?: string) => void;
}

export interface FutianVoxelPanelProps {
  futianStats: MassiveVoxelStats | null;
  isIndexingFutian: boolean;
  futianIndexProgress: { parsed: number; total: number };
  massiveVoxelStyle: MassiveVoxelStyle;
  onChangeMassiveVoxelStyle: (style: MassiveVoxelStyle) => void;
  massiveLodMode: MassiveVoxelLodMode;
  onChangeMassiveLodMode: (mode: MassiveVoxelLodMode) => void;
  includeGroundCarpet: boolean;
  onToggleGroundCarpet: (v: boolean) => void;
  minElevationFilterMeters: number;
  onChangeMinElevationFilter: (v: number) => void;
  elevationThresholds: ElevationColorThresholds;
  onChangeElevationThresholds: (thresholds: ElevationColorThresholds) => void;
  whiteModelOpacity: number;
  onChangeWhiteModelOpacity: (v: number) => void;
  turbo244Mode: boolean;
  onToggleTurbo244Mode: (v: boolean) => void;
  activeLandmarkId: string;
  onSelectFutianLandmark: (preset: FutianLandmarkPreset) => void;
  onRebuildFutianIndex: () => void;
}

export interface ObstacleAvoidancePanelProps {
  hasIonToken: boolean;
  customTilesetUrl: string;
  onChangeCustomTilesetUrl: (url: string) => void;
  onLoadOsmBuildings: () => void;
  onLoadFutianDemoForAvoidance: () => void;
  onLoadCustomTileset: () => void;
  buildingGridEnabled: boolean;
  onToggleBuildingGrid: (v: boolean) => void;
  bufferGridEnabled: boolean;
  onToggleBufferGrid: (v: boolean) => void;
  strataGridEnabled: boolean;
  onToggleStrataGrid: (v: boolean) => void;
  buildingLevel: GridLevel;
  onChangeBuildingLevel: (lv: GridLevel) => void;
  verticalStepMeters: number;
  onChangeVerticalStepMeters: (v: number) => void;
  horizontalBufferMeters: number;
  onChangeHorizontalBufferMeters: (v: number) => void;
  verticalBufferMeters: number;
  onChangeVerticalBufferMeters: (v: number) => void;
  maxAirspaceHeight: number;
  onChangeMaxAirspaceHeight: (v: number) => void;
  onReextractBuildings: () => void;
  isExtractingBuildings: boolean;
  voxelStats: {
    buildingCount: number;
    obstacleVoxelCount: number;
    bufferVoxelCount: number;
    strataVoxelCount: number;
  };
  selectedFlightPresetId: string;
  onSelectFlightPreset: (id: string) => void;
  waypoints: Required<Wgs84Point>[];
  onUpdateWaypoints: (pts: Required<Wgs84Point>[]) => void;
  corridorRadiusMeters: number;
  onChangeCorridorRadiusMeters: (v: number) => void;
  showDetourRoute: boolean;
  onToggleShowDetourRoute: (v: boolean) => void;
  flightAnalysis: FlightPathAnalysisResult | null;
  isPickingWaypoint: boolean;
  onTogglePickWaypoint: (v: boolean) => void;
  pickWaypointHeight: number;
  onChangePickWaypointHeight: (v: number) => void;
  isSimulatingFlight: boolean;
  onToggleSimulateFlight: () => void;
  liveFlightCell: BeidouVoxelCell | null;
}

export interface DynamicApiPanelProps {
  apiLevels: GridLevel[];
  onChangeApiLevels: (levels: GridLevel[]) => void;
  apiLayerStyle: GridLayerStyle;
  onChangeApiLayerStyle: (style: GridLayerStyle) => void;
  apiPathResult: PathGridGenerationResponse | null;
  onRunDynamicPathGeneration: (coords: Wgs84Point[]) => void;
  onClearDynamicPathLayer: () => void;
  onQueryPointOrCode: (point?: Wgs84Point, code?: string) => void;
  onOpenApiModal: () => void;
}
