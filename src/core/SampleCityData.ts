import type { BuildingFootprint, CityPreset, Wgs84Point } from '../types/beidou';

export const CITY_PRESETS: CityPreset[] = [
  {
    id: 'global',
    name: '全球宏观视野',
    subtitle: 'L1-L2 全球北斗立体球壳网格',
    lon: 108.0,
    lat: 30.0,
    height: 12_500_000,
    heading: 0,
    pitch: -88,
    roiRadiusDeg: 40,
  },
  {
    id: 'shenzhen-futian',
    name: '深圳福田中心区',
    subtitle: '3D Tiles 白模 + 建筑网格化避障',
    lon: 114.057868,
    lat: 22.543099,
    height: 1150,
    heading: 18,
    pitch: -32,
    tilesetKey: 'shenzhen',
    roiRadiusDeg: 0.0055,
  },
  {
    id: 'shenzhen-luohu',
    name: '深圳罗湖金融街',
    subtitle: '高精度城市建筑群 + 低空走廊',
    lon: 114.1112,
    lat: 22.5418,
    height: 950,
    heading: 30,
    pitch: -30,
    tilesetKey: 'luohu',
    roiRadiusDeg: 0.0048,
  },
  {
    id: 'guangzhou-cbd',
    name: '广州珠江新城 CBD',
    subtitle: '超高层建筑轮廓自动提取',
    lon: 113.32452,
    lat: 23.119,
    height: 1350,
    heading: 345,
    pitch: -32,
    tilesetKey: 'guangzhou',
    roiRadiusDeg: 0.0058,
  },
  {
    id: 'sample-cbd',
    name: '内置示范低空街区',
    subtitle: '离线即开即用建筑实景演示',
    lon: 114.057868,
    lat: 22.543099,
    height: 980,
    heading: 25,
    pitch: -28,
    tilesetKey: 'sample-cbd',
    roiRadiusDeg: 0.0045,
  },
];

export interface FlightPreset {
  id: string;
  name: string;
  description: string;
  waypoints: Required<Wgs84Point>[];
}

export const FLIGHT_PRESETS: FlightPreset[] = [
  {
    id: 'futian-cross',
    name: '福田低空穿楼测试航线 (触发避障重规划)',
    description: '故意穿越高密高层建筑区，验证红区冲突识别与三维北斗 A* 自动绕飞',
    waypoints: [
      { lon: 114.0532, lat: 22.5402, height: 85, timestamp: 0 },
      { lon: 114.0562, lat: 22.5422, height: 95, timestamp: 15 },
      { lon: 114.0595, lat: 22.5441, height: 105, timestamp: 30 },
      { lon: 114.0626, lat: 22.5462, height: 115, timestamp: 45 },
    ],
  },
  {
    id: 'futian-corridor',
    name: '福田安全巡检走廊 (220m 高层净空)',
    description: '沿主干低空走廊巡航，验证多级动态路径编码生成',
    waypoints: [
      { lon: 114.0528, lat: 22.5405, height: 225, timestamp: 0 },
      { lon: 114.0564, lat: 22.5416, height: 240, timestamp: 20 },
      { lon: 114.0598, lat: 22.5435, height: 245, timestamp: 40 },
      { lon: 114.0625, lat: 22.5458, height: 230, timestamp: 60 },
    ],
  },
  {
    id: 'luohu-patrol',
    name: '罗湖商业枢纽低空物流航线',
    description: '适配罗湖 3D Tiles 建筑白模的起降巡航轨迹',
    waypoints: [
      { lon: 114.1072, lat: 22.5396, height: 110, timestamp: 0 },
      { lon: 114.1105, lat: 22.5414, height: 120, timestamp: 18 },
      { lon: 114.1138, lat: 22.5432, height: 135, timestamp: 36 },
      { lon: 114.1162, lat: 22.5446, height: 125, timestamp: 52 },
    ],
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
 * 构建内置高保真 CBD 建筑示范数据（围绕深圳福田核心区坐标，支持无本地 3D Tiles 环境下立即运行）
 */
export function createSampleCbdBuildings(
  centerLon = 114.057868,
  centerLat = 22.543099,
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
    { name: '平安示范中心 B', dx: 0.0006, dy: 0.0005, w: 0.00026, d: 0.00022, h: 275, rot: 0.05 },
    { name: '市民广场西塔', dx: -0.0018, dy: -0.0007, w: 0.00022, d: 0.00018, h: 145, rot: -0.08 },
    { name: '会展综合体 C', dx: -0.0011, dy: -0.0013, w: 0.00038, d: 0.00021, h: 98, rot: 0.0 },
    { name: '金融创新大厦', dx: 0.0016, dy: -0.0006, w: 0.00021, d: 0.00021, h: 188, rot: 0.2 },
    { name: '智算数据塔楼', dx: 0.0009, dy: -0.0016, w: 0.00025, d: 0.00016, h: 132, rot: -0.12 },
    { name: '北斗调度大厦', dx: -0.0023, dy: 0.0012, w: 0.00023, d: 0.00019, h: 165, rot: 0.05 },
    { name: '无人机起降港裙楼', dx: -0.0009, dy: 0.0015, w: 0.00032, d: 0.00020, h: 74, rot: 0.0 },
    { name: '深南国际中心', dx: 0.0022, dy: 0.0013, w: 0.00022, d: 0.00024, h: 242, rot: 0.15 },
    { name: '湾区科创大厦', dx: 0.0001, dy: 0.0019, w: 0.00019, d: 0.00017, h: 120, rot: -0.05 },
    { name: '福华商住楼群 1', dx: -0.0028, dy: -0.0019, w: 0.00028, d: 0.00015, h: 86, rot: 0.0 },
    { name: '福华商住楼群 2', dx: -0.0001, dy: -0.0022, w: 0.00024, d: 0.00018, h: 110, rot: 0.08 },
    { name: '星河双子座东', dx: 0.0027, dy: -0.0018, w: 0.00020, d: 0.00018, h: 172, rot: 0.0 },
    { name: '岗厦北枢纽群楼', dx: 0.0014, dy: 0.0024, w: 0.00030, d: 0.00019, h: 92, rot: -0.1 },
    { name: '中心城商业综合体', dx: -0.0014, dy: 0.0023, w: 0.00029, d: 0.00021, h: 68, rot: 0.0 },
    { name: '城市绿洲高层', dx: 0.0031, dy: 0.0002, w: 0.00019, d: 0.00017, h: 156, rot: 0.1 },
  ];

  return specs.map((s, idx) => {
    const cLon = centerLon + s.dx;
    const cLat = centerLat + s.dy;
    const polygon = makeRectPolygon(cLon, cLat, s.w, s.d, s.rot ?? 0);
    const lons = polygon.map((p) => p[0]);
    const lats = polygon.map((p) => p[1]);

    return {
      id: `sample-bld-${idx + 1}`,
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
