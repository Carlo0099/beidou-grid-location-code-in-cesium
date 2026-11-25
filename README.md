# 北斗网格化低空空域管理与 3D Tiles 建筑避障系统

基于 **React 19 + TypeScript + Vite + CesiumJS** 构建的低空经济北斗空间网格化管理与三维可视化平台，遵循国家标准 **GB/T 39409-2020《北斗网格位置码》** 与 **GB/T 20254** 地理网格空间剖分规范，实现了全球宏观尺度至城市建筑米级体元尺度的一体化低空空域网格建模、建筑轮廓自动体素化避障、三维 A* 绕飞规划与动态轨迹网格编码 API。

---

## 核心特性

### 1.1 全球与局部北斗网格可视化
- **全球尺度立体球壳网格**：支持在全球视角下以多层同心球壳线框与径向立柱展示北斗 1–10 级空间网格与位置码标注（基于 `Cesium.PolylineCollection` 跨子午线稳定合批渲染）。
- **多分辨率自适应（Adaptive LOD）与手动切换**：支持相机高度自动推荐级别或手动指定 1–10 级网格，支持 **2D 平面（`2d-plane`）、3D 立体线框（`3d-wireframe`）、半透明体积（`translucent-volume`）、混合融合（`hybrid`）** 四种渲染形态。
- **实时光标探针与拓扑跳转**：鼠标实时换算 WGS84 经纬高及北斗 2D/3D 位置码；点击任意体元可查看空间包络边界、关联建筑及 8 邻域 + 上下邻接网格跳转。

### 1.2 空域网格化建模与 3D Tiles 建筑避障
- **低空高度域分层建模**：支持按国标高度步长（L6 `61.84m` / L7 `7.73m`）或低空精细航层步长（`15m` / `30m`）构建三维立体网格。
- **3D Tiles 建筑轮廓自动提取与网格化**：内置纯 TypeScript 解析器 [TilesetBuildingExtractor.ts](src/core/TilesetBuildingExtractor.ts)，支持直接解析 3D Tiles 1.1 `.glb` / `.b3dm` 内 `_FEATURE_ID_0` 顶点并构建二维凸包轮廓与起止高程；未挂载外部 3D Tiles 时自动降级到内置示范低空 CBD 建筑群，开箱即用。
- **周边避障缓冲区与飞行冲突分析**：自动将建筑物体素化为红色半透明白边禁飞体元，并按设定水平/垂直安全距离生成橙色避障缓冲区；支持预置航线及地图交互选点规划，实时检测冲突体元并基于三维北斗体元 A* 算法自动求解绿色无冲突绕飞航线与 UAV 实时轨迹追踪。

### 1.3 动态经纬度、路径网格生成与可调用 API
- **前端运行时 SDK（`window.BeidouGridAPI`）**：
  - `encodePoint(point, level)`：单点 WGS84 编码为北斗 2D/3D 网格码与空间边界
  - `decodeCode(code)`：自动识别并解码 2D/3D 北斗位置码
  - `generatePathGrids(request)`：传入任意 WGS84 坐标或轨迹序列，按多级别并行生成路径网格序列
  - `ingestGeoJson(geoJson, levels, layerStyle)`：直接解析 GeoJSON `Point` / `LineString` / `FeatureCollection`
  - `renderLayer(layerId, request)` / `clearLayer(layerId)`：以 2D 平面、3D 立体、半透明体积或融合形态实时渲染至 Cesium 场景
  - `checkTrajectoryObstacles(waypoints, options)`：对轨迹执行建筑避障冲突检测与绕飞重规划
- **HTTP REST 接口（Vite Dev/Preview 中间件）**：
  - `GET /api/beidou/health`
  - `POST /api/beidou/encode`
  - `GET /api/beidou/decode?code=...`
  - `POST /api/beidou/path-grids`

---

## 北斗编码规范对照（GB/T 39409-2020）

| 级别 | 平面网格尺寸 | 约合地面跨度 | 高度域步长 | 2D 码长 | 3D 码长 | 典型应用场景 |
| :---: | :--- | :--- | :--- | :---: | :---: | :--- |
| **L1** | `6° × 4°` | ~445.3 km | `445,280 m` | 4 位 | 7 位 | 全球/大洲宏观球壳网格 |
| **L2** | `30' × 30'` | ~55.66 km | `55,660 m` | 6 位 | 10 位 | 省域空域划分 |
| **L3** | `15' × 10'` | ~27.83 km | `27,830 m` | 7 位 | 12 位 | 都市圈低空管理 |
| **L4** | `1' × 1'` | ~1.85 km | `1,850 m` | 9 位 | 15 位 | 城区/街道低空网格 |
| **L5** | `4" × 4"` | ~123.69 m | `123.69 m` | 11 位 | 18 位 | 低空扇区单元 |
| **L6** | `2" × 2"` | ~61.84 m | `61.84 m` | 12 位 | 20 位 | 街区航道与建筑群网格 |
| **L7** | `1/4" × 1/4"` | ~7.73 m | `7.73 m` | 14 位 | 23 位 | 建筑体素化与无人机避障 |
| **L8** | `1/32" × 1/32"` | ~0.97 m | `0.97 m` | 16 位 | 26 位 | 亚米级起降点定位 |
| **L9** | `1/256" × 1/256"` | ~0.121 m | `0.121 m` | 18 位 | 29 位 | 分米级精测 |
| **L10** | `1/2048" × 1/2048"` | ~0.015 m | `0.015 m` | 20 位 | 32 位 | 厘米级极精空间基准 |

---

## 快速开始

### 1. 安装依赖并启动

```bash
npm install
npm run dev
```

浏览器打开 `http://localhost:5173` 即可使用（未配置任何外部 Token 或本地离线数据时，系统自动使用免 Token 公开底图与内置示范低空街区运行）。

### 2. 可选：配置个人底图 Token 与本地离线 3D Tiles

如需使用个人天地图底图或加载本地离线 3D Tiles / 地形 / 影像瓦片，请复制配置模板：

```bash
cp .env.example .env.local
```

在 `.env.local`（已被 `.gitignore` 忽略，不会进入版本库）中按需填写：

```env
VITE_TIANDITU_TOKEN=你的天地图Token
VITE_CESIUM_ION_TOKEN=你的CesiumIonToken
LOCAL_3DTILES_DIR=/path/to/your/3dtiles
LOCAL_3DTILES_GZIP_DIR=/path/to/your/3dtiles_gzip
LOCAL_TILES_DIR=/path/to/your/imagery_tiles
LOCAL_TERRAIN_DIR=/path/to/your/terrain
```

### 3. 生产构建与测试

```bash
# TypeScript 类型检查 + Vite 生产打包
npm run build

# 运行北斗编解码、建筑体素化、A*避障及 GLB 轮廓提取单元测试
npm test
```

---

## 项目目录结构

```text
├── .env.example                          # 环境变量配置模板
├── vite.config.ts                        # Vite 插件、可选本地 GIS 服务与北斗 REST API 中间件
├── src/
│   ├── api/
│   │   ├── BeidouGridApi.ts              # 可调用 SDK (window.BeidouGridAPI) 与 GeoJSON 接入
│   │   └── gisDataConfig.ts              # 环境变量驱动的影像/3D Tiles 资源配置
│   ├── core/
│   │   ├── BeidouGridCode.ts             # GB/T 39409-2020 2D/3D 编解码核心引擎
│   │   ├── BeidouGridEngine.ts           # 路径网格生成、范围枚举与 3D A* 避障规划
│   │   ├── AirspaceVoxelizer.ts          # 建筑体素化、缓冲区扩展与低空分层
│   │   ├── TilesetBuildingExtractor.ts   # 3D Tiles (.glb/.b3dm) 建筑轮廓与高程提取器
│   │   ├── GridLayerManager.ts           # Cesium 批量图元与全球球壳网格渲染器
│   │   └── SampleCityData.ts             # 城市预设视角、示范建筑与测试航线
│   ├── components/
│   │   ├── CesiumViewport.tsx            # Cesium 三维视图与拾取遥测
│   │   ├── ControlPanel.tsx              # 三模块交互控制工作台
│   │   ├── TopHudBar.tsx                 # 顶部实时性能与北斗码监控条
│   │   ├── GridInspectorCard.tsx         # 右侧体元属性与邻接拓扑探针
│   │   └── ApiPlaygroundDrawer.tsx       # 动态路径/API 交互调试台
│   ├── types/beidou.ts                   # TypeScript 核心类型定义
│   └── __tests__/beidouGrid.test.ts      # 核心算法与 GLB 解析单元测试
```

---

## API 调用示例

### 前端 SDK

```ts
const result = window.BeidouGridAPI?.renderLayer('uav-corridor-1', {
  coordinates: [
    { lon: 114.0535, lat: 22.5405, height: 140 },
    { lon: 114.0615, lat: 22.5452, height: 185 },
  ],
  levels: [5, 6, 7],
  layerStyle: 'translucent-volume', // '2d-plane' | '3d-wireframe' | 'translucent-volume' | 'hybrid'
  corridorRadiusMeters: 20,
});
```

### HTTP REST

```bash
curl -X POST http://localhost:5173/api/beidou/path-grids \
  -H "Content-Type: application/json" \
  -d '{
    "coordinates": [
      { "lon": 114.0535, "lat": 22.5405, "height": 140 },
      { "lon": 114.0615, "lat": 22.5452, "height": 185 }
    ],
    "levels": [5, 6, 7],
    "layerStyle": "translucent-volume"
  }'
```
