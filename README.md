# 北斗网格化低空空域管理与 3D Tiles 建筑避障系统

基于 **React 19 + TypeScript + Vite + CesiumJS** 构建的低空经济北斗空间网格化管理与三维可视化平台，遵循国家标准 **GB/T 39409-2020《北斗网格位置码》** 与 **GB/T 20254** 地理网格空间剖分规范，实现了全球宏观尺度至城市建筑米级体元尺度的一体化低空空域网格建模、建筑轮廓自动体素化避障、三维 A* 绕飞规划与动态轨迹网格编码 API。

---

## 核心特性

### 1.1 全球与局部北斗网格可视化
- **Cesium 原生底图与图层选择器**：直接采用 Cesium 自带的 `BaseLayerPicker`（默认免 Token 加载内置 ArcGIS World Imagery / OpenStreetMap；配置 Ion Token 后可启用 Bing Maps Aerial 等 Cesium 内置底图）。
- **全球尺度立体球壳网格与全格编码标注**：在 L1 全球宏观视野下以多层同心球壳线框与径向立柱展示全球北斗网格（基于 `Cesium.PolylineCollection` 跨子午线稳定合批渲染），且每一个全球网格单元均附带对应北斗位置编码标注。
- **相机高度自适应分辨率（Adaptive LOD，L1–L10 全覆盖）**：随相机缩放高度变化自动实时切换并重绘 1–10 级北斗网格分辨率与位置编码（支持 L1 球壳网格与 L2–L10 相机视区三维细分网格无缝衔接），并支持 **2D 平面（`2d-plane`）、3D 立体线框（`3d-wireframe`）、半透明体积（`translucent-volume`）、混合融合（`hybrid`）** 四种渲染形态。
- **实时光标探针与拓扑跳转**：鼠标实时换算 WGS84 经纬高及北斗 2D/3D 位置码；点击任意体元可查看空间包络边界、关联建筑及 8 邻域 + 上下邻接网格跳转。

### 1.2 空域网格化建模与建筑避障（与 1.1 独立模块）
- **低空高度域分层建模**：支持按国标高度步长（L6 `61.84m` / L7 `7.73m`）或低空精细航层步长（`15m` / `30m`）构建三维立体网格。
- **多源建筑加载与轮廓提取**：支持在当前相机视区一键生成三维测试建筑群、加载 Cesium 内置 OSM Buildings（需 Ion Token），或输入自定义 3D Tileset URL 通过纯 TypeScript 解析器 [TilesetBuildingExtractor.ts](src/core/TilesetBuildingExtractor.ts) 实时提取建筑 `.glb`/`.b3dm` 轮廓与高程。
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

浏览器打开 `http://localhost:5173` 即可使用（底图与三维视图完全使用 Cesium 自带图层控件）。

### 2. 可选：配置 Cesium Ion Token（用于 Bing 底图与 Cesium OSM Buildings）

如需要使用 Cesium Ion 底图或加载 Cesium OSM Buildings 三维建筑白模，请复制配置模板：

```bash
cp .env.example .env.local
```

在 `.env.local`（已被 `.gitignore` 忽略，不会进入版本库）中按需填写：

```env
VITE_CESIUM_ION_TOKEN=你的CesiumIonToken
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
