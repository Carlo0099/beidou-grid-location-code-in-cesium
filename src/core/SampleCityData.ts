import type { BuildingFootprint, CityPreset, Wgs84Point } from '../types/beidou';

/**
 * 1.1 全球宏观北斗视野初始参数
 */
export const GLOBAL_CAMERA_VIEW: CityPreset = {
  id: 'global',
  name: '全球宏观视野',
  subtitle: 'L1-L10 相机自适应北斗网格',
  lon: 108.0,
  lat: 30.0,
  height: 12_500_000,
  heading: 0,
  pitch: -88,
  roiRadiusDeg: 40,
};

/**
 * 1.2 空域/避障默认低空测试中心坐标（通用城市测试点，可在任意视区生成测试建筑群）
 */
export const DEFAULT_AIRSPACE_CENTER = {
  lon: 116.312603,
  lat: 39.993161,
  height: 1050,
  heading: 18,
  pitch: -32,
  roiRadiusDeg: 0.0052,
};

export interface FlightPreset {
  id: string;
  name: string;
  description: string;
  waypoints: Required<Wgs84Point>[];
}

export function createConflictFlightRouteAt(
  centerLon: number,
  centerLat: number,
): Required<Wgs84Point>[] {
  return [
    { lon: centerLon - 0.0046, lat: centerLat - 0.0029, height: 85, timestamp: 0 },
    { lon: centerLon - 0.0016, lat: centerLat - 0.0009, height: 95, timestamp: 15 },
    { lon: centerLon + 0.0016, lat: centerLat + 0.001, height: 105, timestamp: 30 },
    { lon: centerLon + 0.0047, lat: centerLat + 0.0031, height: 115, timestamp: 45 },
  ];
}

export function createCorridorFlightRouteAt(
  centerLon: number,
  centerLat: number,
): Required<Wgs84Point>[] {
  return [
    { lon: centerLon - 0.005, lat: centerLat - 0.0026, height: 225, timestamp: 0 },
    { lon: centerLon - 0.0014, lat: centerLat - 0.0015, height: 240, timestamp: 20 },
    { lon: centerLon + 0.0019, lat: centerLat + 0.0004, height: 245, timestamp: 40 },
    { lon: centerLon + 0.0046, lat: centerLat + 0.0027, height: 230, timestamp: 60 },
  ];
}

export const FLIGHT_PRESETS: FlightPreset[] = [
  {
    id: 'obstacle-cross',
    name: '低空穿楼测试航线 (触发避障重规划)',
    description: '穿越高密建筑核心区，验证红区冲突识别与三维北斗 A* 自动绕飞',
    waypoints: createConflictFlightRouteAt(
      DEFAULT_AIRSPACE_CENTER.lon,
      DEFAULT_AIRSPACE_CENTER.lat,
    ),
  },
  {
    id: 'safe-corridor',
    name: '高层净空巡检走廊 (225m+)',
    description: '沿高层净空走廊巡航，验证多级动态路径编码生成',
    waypoints: createCorridorFlightRouteAt(
      DEFAULT_AIRSPACE_CENTER.lon,
      DEFAULT_AIRSPACE_CENTER.lat,
    ),
  },
];

function makeRectPolygon(
  cLon: number,
  cLat: number,
  halfLon: number,
  halfLat: number,
  angleRad = 0,
): Array<[number, number]> {
  const corners: Array<[number, number]> = [
    [-halfLon, -halfLat],
    [halfLon, -halfLat],
    [halfLon, halfLat],
    [-halfLon, halfLat],
  ];
  const cos = Math.cos(angleRad);
  const sin = Math.sin(angleRad);
  return corners.map(([dx, dy]) => [
    cLon + dx * cos - dy * sin,
    cLat + dx * sin + dy * cos,
  ]);
}

/**
 * 在任意经纬度中心点构建三维测试建筑群（用于 1.2 空域体素化与避障仿真，无需外部离线数据）
 */
export function createSampleCbdBuildings(
  centerLon = DEFAULT_AIRSPACE_CENTER.lon,
  centerLat = DEFAULT_AIRSPACE_CENTER.lat,
): BuildingFootprint[] {
  const specs: Array<{
    name: string;
    dx: number;
    dy: number;
    w: number;
    d: number;
    h: number;
    rot?: number;
  }> = [
    { name: '低空枢纽主塔 A', dx: -0.0004, dy: 0.0002, w: 0.00024, d: 0.00018, h: 215, rot: 0.1 },
    { name: '调度中心塔楼 B', dx: 0.0006, dy: 0.0005, w: 0.00026, d: 0.00022, h: 275, rot: 0.05 },
    { name: '广场西侧高层', dx: -0.0018, dy: -0.0007, w: 0.00022, d: 0.00018, h: 145, rot: -0.08 },
    { name: '综合服务裙楼 C', dx: -0.0011, dy: -0.0013, w: 0.00038, d: 0.00021, h: 98, rot: 0.0 },
    { name: '科创商业大厦 D', dx: 0.0016, dy: -0.0006, w: 0.00021, d: 0.00021, h: 188, rot: 0.2 },
    { name: '智算数据塔楼 E', dx: 0.0009, dy: -0.0016, w: 0.00025, d: 0.00016, h: 132, rot: -0.12 },
    { name: '北斗控制大厦 F', dx: -0.0023, dy: 0.0012, w: 0.00023, d: 0.00019, h: 165, rot: 0.05 },
    { name: '起降坪配套楼 G', dx: -0.0009, dy: 0.0015, w: 0.00032, d: 0.00020, h: 74, rot: 0.0 },
    { name: '国际商务中心 H', dx: 0.0022, dy: 0.0013, w: 0.00022, d: 0.00024, h: 242, rot: 0.15 },
    { name: '研发实验楼 I', dx: 0.0001, dy: 0.0019, w: 0.00019, d: 0.00017, h: 120, rot: -0.05 },
    { name: '商住高层楼群 J', dx: -0.0028, dy: -0.0019, w: 0.00028, d: 0.00015, h: 86, rot: 0.0 },
    { name: '商住高层楼群 K', dx: -0.0001, dy: -0.0022, w: 0.00024, d: 0.00018, h: 110, rot: 0.08 },
    { name: '双子塔东座 L', dx: 0.0027, dy: -0.0018, w: 0.00020, d: 0.00018, h: 172, rot: 0.0 },
    { name: '北翼商业群楼 M', dx: 0.0014, dy: 0.0024, w: 0.00030, d: 0.00019, h: 92, rot: -0.1 },
    { name: '南翼商业综合体 N', dx: -0.0014, dy: 0.0023, w: 0.00029, d: 0.00021, h: 68, rot: 0.0 },
    { name: '生态高塔 O', dx: 0.0031, dy: 0.0002, w: 0.00019, d: 0.00017, h: 156, rot: 0.1 },
  ];

  return specs.map((s, idx) => {
    const cLon = centerLon + s.dx;
    const cLat = centerLat + s.dy;
    const polygon = makeRectPolygon(cLon, cLat, s.w, s.d, s.rot ?? 0);
    const lons = polygon.map((p) => p[0]);
    const lats = polygon.map((p) => p[1]);

    return {
      id: `urban-bld-${idx + 1}`,
      name: s.name,
      source: 'sample-cbd',
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      baseHeight: 0,
      roofHeight: s.h,
      polygon,
    };
  });
}

export const createProceduralUrbanBuildings = createSampleCbdBuildings;
