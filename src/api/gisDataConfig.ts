import * as Cesium from 'cesium';

// 从环境变量读取可选 Token，不在开源源码中硬编码私有密钥
export const TIANDITU_TOKEN = (import.meta.env.VITE_TIANDITU_TOKEN ?? '').trim();
export const CESIUM_ION_TOKEN = (import.meta.env.VITE_CESIUM_ION_TOKEN ?? '').trim();

export interface TilesetAssetSpec {
  key: 'shenzhen' | 'luohu' | 'guangzhou' | 'hongkong';
  name: string;
  url: string;
  altitudeOffset: number;
  center: { lon: number; lat: number };
}

export const LOCAL_TILESET_SPECS: Record<TilesetAssetSpec['key'], TilesetAssetSpec> = {
  shenzhen: {
    key: 'shenzhen',
    name: '深圳全市建筑白模 (3D Tiles 1.1)',
    url: '/3dtiles_data/shenzhen/tileset.json',
    altitudeOffset: 0,
    center: { lon: 114.057868, lat: 22.543099 },
  },
  luohu: {
    key: 'luohu',
    name: '深圳罗湖区建筑群 (3D Tiles 1.1)',
    url: '/3dtiles_data/luohu/tileset.json',
    altitudeOffset: 0,
    center: { lon: 114.1112, lat: 22.5418 },
  },
  guangzhou: {
    key: 'guangzhou',
    name: '广州核心城区建筑白模 (3D Tiles 1.1)',
    url: '/3dtiles_data/guangzhou/tileset.json',
    altitudeOffset: 0,
    center: { lon: 113.32452, lat: 23.119 },
  },
  hongkong: {
    key: 'hongkong',
    name: '香港建筑白模 (3D Tiles 1.1)',
    url: '/3dtiles_data/hongkong/tileset.json',
    altitudeOffset: 0,
    center: { lon: 114.1694, lat: 22.3193 },
  },
};

export function createLocalOfflineImageryProviders(): Cesium.UrlTemplateImageryProvider[] {
  const world = new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/world/{z}/{x}/{y}.jpg',
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    minimumLevel: 1,
    maximumLevel: 5,
  });

  const china = new Cesium.UrlTemplateImageryProvider({
    url: '/tiles/tianditu_img/{z}/{x}/{y}.jpg',
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    minimumLevel: 6,
    maximumLevel: 13,
    rectangle: Cesium.Rectangle.fromDegrees(73.0, 18.0, 135.0, 53.0),
  });

  return [world, china];
}

export function createOnlineTiandituProviders(
  token = TIANDITU_TOKEN,
): Cesium.WebMapTileServiceImageryProvider[] {
  if (!token) return [];

  const img = new Cesium.WebMapTileServiceImageryProvider({
    url: `https://t{s}.tianditu.gov.cn/img_w/wmts?service=wmts&request=GetTile&version=1.0.0&LAYER=img&style=default&tileMatrixSet=w&TileMatrix={TileMatrix}&TileRow={TileRow}&TileCol={TileCol}&format=tiles&tk=${token}`,
    layer: 'img_w',
    style: 'default',
    format: 'tiles',
    tileMatrixSetID: 'w',
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
    maximumLevel: 18,
  });

  const cia = new Cesium.WebMapTileServiceImageryProvider({
    url: `https://t{s}.tianditu.gov.cn/cia_w/wmts?service=wmts&request=GetTile&version=1.0.0&LAYER=cia&style=default&tileMatrixSet=w&TileMatrix={TileMatrix}&TileRow={TileRow}&TileCol={TileCol}&format=tiles&tk=${token}`,
    layer: 'cia_w',
    style: 'default',
    format: 'tiles',
    tileMatrixSetID: 'w',
    subdomains: ['0', '1', '2', '3', '4', '5', '6', '7'],
    maximumLevel: 18,
  });

  img.errorEvent.addEventListener(() => {});
  cia.errorEvent.addEventListener(() => {});
  return [img, cia];
}

export function createPublicSatelliteImageryProvider(): Cesium.UrlTemplateImageryProvider {
  const provider = new Cesium.UrlTemplateImageryProvider({
    url: 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    tilingScheme: new Cesium.WebMercatorTilingScheme(),
    maximumLevel: 18,
  });
  provider.errorEvent.addEventListener(() => {});
  return provider;
}

export function createGridFallbackImageryProvider(): Cesium.GridImageryProvider {
  return new Cesium.GridImageryProvider({
    cells: 8,
    color: Cesium.Color.fromCssColorString('#1e3a5f').withAlpha(0.5),
    glowColor: Cesium.Color.fromCssColorString('#0ea5e9').withAlpha(0.2),
    backgroundColor: Cesium.Color.fromCssColorString('#061121'),
  });
}
