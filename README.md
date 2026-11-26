# 北斗网格化低空空域管理与 3D Tiles 建筑避障系统

基于 **React 19 + TypeScript + Vite + CesiumJS** 构建的低空经济北斗空间网格化管理与三维可视化平台，遵循国家标准 **GB/T 39409-2020《北斗网格位置码》** 与 **GB/T 20254** 地理网格空间剖分规范，面向全球宏观网格剖分、城市级亿级/万亿级 3D Tiles 贴合体素仿真、低空避障规划（待建设）与动态轨迹网格编码 API 等场景。

---

## 功能模块总览

| 模块编号 | 工作台页签 | 核心定位 | 当前状态 |
| :---: | :--- | :--- | :---: |
| **1.1** | **1.1 全球** | L1 全球多层球壳与 L2–L10 相机自适应视口网格、244Hz 高帧管线 | 已完成并优化 |
| **1.2** | **1.2 亿级体素** | 福田 3D Tiles 白膜流式三角网共形体素、L6–L10 厘米级渲染与 Worker 对象池 | 核心功能已完成 |
| **1.3** | **1.3 避障** | 建筑体素化避障、安全缓冲区与三维 A* 绕飞规划系统 | **🚧 待建设（当前仅含原型演示骨架）** |
| **1.4** | **1.4 API** | `window.BeidouGridAPI` 运行时 SDK 与 GeoJSON / REST 路径网格接口 | 已完成 |

---

## 核心特性

### 1.1 全球与局部北斗网格可视化
- **Cesium 原生底图与高性能地球参数调优**：直接采用 Cesium 自带的 `BaseLayerPicker`（无 Ion Token 时默认启用免鉴权内置 ArcGIS World Imagery / OpenStreetMap；配置 Ion Token 后可启用 Bing Maps Aerial 等 Cesium 内置底图），增大 `globe.tileCacheSize` 并调优 `maximumScreenSpaceError`，在无 3D Tileset 时自动跳过低空 `scene.pickPosition` 避免 WebGL 深度回读停顿。
- **L1 全球立体球壳缓存与正面半球限流标注**：在 L1 全球宏观视野下将 4 层同心球壳（`15km / 320km / 640km / 960km`）与径向立柱一次编译为静态持久化 **Indexed `LINES` Primitive** 缓存复用，转动或缩放地球 **0 次几何重建**；编码标注采用背半球法线剔除与屏幕防碰撞筛选，仅保留正面可见区内清晰不重叠的编码标签（上限 96 个），交互拖动期间暂缓重算、静止后立即刷新。
- **相机高度自适应分辨率（Adaptive LOD，L1–L10 全覆盖）**：随相机缩放高度实时切换 L1–L10 网格与位置编码（基于 `requestAnimationFrame` 合批调度）；L2–L10 视口网格同样采用基于经纬三角查找表的原生 **Indexed `LINES`** 单批绘制，标注筛选延迟至停止后最多保留 48 个无重叠清晰标签，支持 **2D 平面（`2d-plane`）、3D 立体线框（`3d-wireframe`）、半透明体积（`translucent-volume`）、混合融合（`hybrid`）** 四种图层形态。
- **244Hz 极限高帧模式与实时光标探针**：支持在 `1.1 全球` 与 `1.2 亿级体素` 间联动开启 `244Hz 极限高帧模式`（动态缩放 `resolutionScale`、关闭雾效与大气散射着色、适度放宽地球瓦片/白膜 SSE）；鼠标实时换算 WGS84 经纬高及北斗 2D/3D 位置码，点击体元可查看空间边界与 8 邻域 + 上下邻接网格跳转。

### 1.2 亿级体素与 3D Tiles 城市仿真（福田白膜示范区 · 最高 L10 厘米级）
- **内置福田区 3D Tiles 建筑白膜示范资产**：内置 `public/futian-3dtiles/tileset.json` 与 15 块精细 `.glb` 模型，开箱即用无需外部瓦片服务。
- **流式三角面稀疏体素化与紧凑三角网索引（[MassiveVoxelEngine.ts](src/core/MassiveVoxelEngine.ts)）**：4 并发异步解析 GLB 建筑三角面并构建 L7（`7.73m`）占空柱索引、`16×16` 空间宏块、外围 `L6` 汇总金字塔以及按宏块分桶的紧凑三角网库（`CompactTrianglePool`），实时统计至 **L10（`1.5cm` · 20 位 2D / 32 位 3D 满精度码）** 的虚拟体元容量。
- **真实三角面扫描线贴合细分（Tight Conformal Rasterization）**：近景切换至 `L8 (0.97m)` / `L9 (12.1cm)` / `L10 (1.5cm)` 时，依据相机三维物理距离由近及远逐级细化，并在 Web Worker 内结合三角面精细裁剪（Eliminate overhang），使建筑包络体严格贴合真实外墙与退台轮廓；近远景交界严格按完整 `16×16` 宏块边界切分（180 宏块 / 6,500 精细柱双上限）无缝衔接外围 `L6` 宏块，确保视角缩放不出现中环或边缘“裸楼”断层。
- **Web Worker + 2D Greedy Meshing + 持久化对象池**：体素包络与 Indexed `LINES`（外立面、屋顶轮廓、连续地表底网）及贪心合并体块矩阵均在 [MassiveVoxelWorker.ts](src/core/MassiveVoxelWorker.ts) + [VoxelBufferBuilder.ts](src/core/VoxelBufferBuilder.ts) 后台计算，主线程通过宏块 LRU 持久化 Primitive 对象池与 `rAF` 分帧挂载，实现高刷流畅交互与近建厘米级对数滚轮穿行。
- **丰富可视化与调节控件**：支持 **白膜贴合壳体**、**高程梯度体素**（支持低/中/高/超高层颜色变化阈值滑块实时调节与一键恢复默认）、**半透明全实体**、**仅福田白膜** 切换，并配备 3D Tiles 白膜不透明度调节（默认 100%）、最小高程筛选、地表铺底网、244Hz 极限高帧模式与福田地标视角快速切换。

### 1.3 空域网格化建模与建筑避障（🚧 待建设）
> **状态说明：本模块完整工程化避障系统目前处于「待建设」阶段**，当前工作台 `1.3 避障` 仅保留基础演示原型入口（模块启用时右下角同步显示对应状态图例）：

- **待建设规划方向**：
  - 对接 `1.2` 全量稀疏体素空间索引与千万/亿级占用网格，替代小规模示例数组驱动的避障检测；
  - 大范围多机动态航路实时冲突消解、分层空域走廊动态容量评估与禁飞区/动态气象体素耦合；
  - 基于 Web Worker 的异步三维 A* / JPS 大规模航迹重规划与实时避障仿真回放管线。
- **当前原型已有基础能力**：低空分层步长设置、示例建筑群/自定义 Tileset 轮廓提取（[TilesetBuildingExtractor.ts](src/core/TilesetBuildingExtractor.ts)）、红/橙建筑禁飞体元与缓冲区分级可视化及基础三维 A* 绕飞演示。

### 1.4 动态经纬度、路径网格生成与可调用 API
- **前端运行时 SDK（`window.BeidouGridAPI`）**：
  - `encodePoint(point, level)`：单点 WGS84 编码为北斗 2D/3D 网格码与空间边界
  - `decodeCode(code)`：自动识别并解码 2D/3D 北斗位置码
  - `generatePathGrids(request)`：传入任意 WGS84 坐标或轨迹序列，按多级别并行生成路径网格序列
  - `ingestGeoJson(geoJson, levels, layerStyle)`：直接解析 GeoJSON `Point` / `LineString` / `FeatureCollection`
  - `renderLayer(layerId, request)` / `clearLayer(layerId)`：以 2D 平面、3D 立体、半透明体积或融合形态实时渲染至 Cesium 场景
  - `checkTrajectoryObstacles(waypoints, options)`：对轨迹执行基础建筑避障冲突检测与绕飞重规划
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
| **L6** | `2" × 2"` | ~61.84 m | `61.84 m` | 12 位 | 20 位 | 街区航道与建筑群宏网格 |
| **L7** | `1/4" × 1/4"` | ~7.73 m | `7.73 m` | 14 位 | 23 位 | 建筑占空柱体与无人机避障 |
| **L8** | `1/32" × 1/32"` | ~0.97 m | `0.97 m` | 16 位 | 26 位 | 亚米级建筑贴合与起降点 |
| **L9** | `1/256" × 1/256"` | ~0.121 m | `0.121 m` | 18 位 | 29 位 | 分米级精细外立面体素 |
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
# TypeScript 类型检查 + Vite 生产打包（含 MassiveVoxelWorker 打包）
npm run build

# 运行北斗编解码、建筑体素化、1.1 Indexed LINES 与 1.2 亿级体素核心单元测试
npm test
```

---

## 项目目录结构

```text
├── .env.example                            # 环境变量配置模板
├── GIT_SYNC.md                             # GitHub (main) + Gitee (master) 双仓同步说明
├── public/
│   └── futian-3dtiles/                     # 福田区建筑白膜 3D Tiles 示范资产 (tileset.json + 15x .glb)
├── vite.config.ts                          # Vite 配置与北斗 REST API 中间件
├── src/
│   ├── App.tsx                             # 主应用状态编排与四模块隔离调度
│   ├── api/
│   │   ├── BeidouGridApi.ts                # 可调用 SDK (window.BeidouGridAPI) 与 GeoJSON 接入
│   │   └── gisDataConfig.ts                # 环境变量驱动的影像/3D Tiles 资源配置
│   ├── core/
│   │   ├── BeidouGridCode.ts               # GB/T 39409-2020 2D/3D 编解码核心引擎
│   │   ├── BeidouGridEngine.ts             # 路径网格生成、范围枚举与 3D A* 避障规划
│   │   ├── AirspaceVoxelizer.ts            # 建筑体素化、缓冲区扩展与低空分层（1.3 原型）
│   │   ├── MassiveVoxelEngine.ts           # 3D Tiles 三角面稀疏栅格化、L6–L10 视口调度与宏块切分
│   │   ├── VoxelBufferBuilder.ts           # 原生 Indexed LINES、2D 贪心合并与紧凑三角网扫线光栅化
│   │   ├── MassiveVoxelWorker.ts           # 亿级体素与地表网后台异步构建 Web Worker
│   │   ├── TilesetBuildingExtractor.ts     # 3D Tiles (.glb/.b3dm) 建筑轮廓与高程提取器
│   │   ├── GridLayerManager.ts             # Cesium Indexed Primitive、L1 缓存与宏块对象池管理器
│   │   └── SampleCityData.ts               # 城市预设视角、示范建筑与测试航线
│   ├── components/
│   │   ├── CesiumViewport.tsx              # Cesium 三维视图、高帧调优、滚轮对数缩放与拾取遥测
│   │   ├── ControlPanel.tsx                # 四模块工作台容器 (1.1 全球 / 1.2 亿级体素 / 1.3 避障 / 1.4 API)
│   │   ├── TopHudBar.tsx                   # 顶部实时帧率、高程与北斗编码监控栏
│   │   ├── GridInspectorCard.tsx           # 右侧体元属性与邻接拓扑探针
│   │   ├── ApiPlaygroundDrawer.tsx         # 动态路径 / API 交互调试抽屉
│   │   └── panels/
│   │       ├── panelTypes.ts               # 分模块面板 Props 契约定义
│   │       ├── GlobalGridPanel.tsx         # 1.1 全球视图、LOD 1–10 与极限高帧模式控制面板
│   │       ├── FutianVoxelPanel.tsx        # 1.2 亿级体素样式、高程阈值滑块与地标飞行面板
│   │       ├── ObstacleAvoidancePanel.tsx  # 1.3 避障控制面板（🚧 待建设）
│   │       └── DynamicApiPanel.tsx         # 1.4 动态路径生成与 API 调试面板
│   ├── types/beidou.ts                     # TypeScript 核心类型定义
│   └── __tests__/beidouGrid.test.ts        # 14 项核心编解码、Indexed LINES 与亿级体素单元测试
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
