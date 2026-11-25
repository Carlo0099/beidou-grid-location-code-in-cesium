import React, { useState } from "react";
import type {
  BeidouVoxelCell,
  CityPreset,
  FlightPathAnalysisResult,
  GridLayerStyle,
  GridLevel,
  LocalAssetsAvailability,
  PathGridGenerationResponse,
  Wgs84Point,
} from "../types/beidou";
import {
  BeidouGridCode,
  GRID_LEVEL_SPECS,
  HEIGHT_STEPS,
} from "../core/BeidouGridCode";
import { CITY_PRESETS, FLIGHT_PRESETS } from "../core/SampleCityData";
import {
  BuildingIcon,
  GlobeIcon,
  PauseIcon,
  PlayIcon,
  RouteIcon,
  ShieldIcon,
} from "./Icons";

export type WorkbenchTab = "global-local" | "airspace-obstacle" | "dynamic-api";

interface ControlPanelProps {
  activeTab: WorkbenchTab;
  onChangeTab: (tab: WorkbenchTab) => void;
  collapsed: boolean;

  // 1.1 Global & Local
  activePresetId: string;
  onSelectPreset: (preset: CityPreset) => void;
  localAssets: LocalAssetsAvailability | null;
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
  onQueryPointOrCode: (point?: Wgs84Point, code?: string) => void;

  // 1.2 Airspace & Buildings
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

  // Flight plan & obstacle avoidance
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

  // 1.3 Dynamic path & API
  apiLevels: GridLevel[];
  onChangeApiLevels: (levels: GridLevel[]) => void;
  apiLayerStyle: GridLayerStyle;
  onChangeApiLayerStyle: (style: GridLayerStyle) => void;
  apiPathResult: PathGridGenerationResponse | null;
  onRunDynamicPathGeneration: (coords: Wgs84Point[]) => void;
  onClearDynamicPathLayer: () => void;
  onOpenApiModal: () => void;
}

const LAYER_STYLES: Array<{ value: GridLayerStyle; label: string }> = [
  { value: "2d-plane", label: "2D 平面" },
  { value: "3d-wireframe", label: "3D 立体" },
  { value: "translucent-volume", label: "半透明体" },
  { value: "hybrid", label: "融合叠加" },
];

export const ControlPanel: React.FC<ControlPanelProps> = (props) => {
  const [lonInput, setLonInput] = useState("114.057868");
  const [latInput, setLatInput] = useState("22.543099");
  const [altInput, setAltInput] = useState("120");
  const [codeInput, setCodeInput] = useState("N050F000500032078031000");

  const [trajectoryJson, setTrajectoryJson] = useState(() =>
    JSON.stringify(
      [
        { lon: 114.0532, lat: 22.5402, height: 110 },
        { lon: 114.0568, lat: 22.5425, height: 145 },
        { lon: 114.0604, lat: 22.5448, height: 175 },
        { lon: 114.0632, lat: 22.5466, height: 150 },
      ],
      null,
      2,
    ),
  );
  const [jsonError, setJsonError] = useState("");

  const levelSpec = GRID_LEVEL_SPECS[props.gridLevel - 1];

  const handleEncodeQuery = () => {
    const lon = parseFloat(lonInput);
    const lat = parseFloat(latInput);
    const height = parseFloat(altInput) || 0;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return;
    const code3D = BeidouGridCode.encode3D(lat, lon, height, props.gridLevel);
    setCodeInput(code3D);
    props.onQueryPointOrCode({ lon, lat, height }, undefined);
  };

  const handleDecodeQuery = () => {
    if (!codeInput.trim()) return;
    props.onQueryPointOrCode(undefined, codeInput.trim());
  };

  const toggleApiLevel = (lv: GridLevel) => {
    const exists = props.apiLevels.includes(lv);
    if (exists && props.apiLevels.length === 1) return;
    const next = exists
      ? props.apiLevels.filter((x) => x !== lv)
      : [...props.apiLevels, lv].sort((a, b) => a - b);
    props.onChangeApiLevels(next);
  };

  const handleParseAndGeneratePath = () => {
    setJsonError("");
    try {
      const parsed = JSON.parse(trajectoryJson);
      let coords: Wgs84Point[] = [];
      if (Array.isArray(parsed)) {
        coords = parsed;
      } else if (
        parsed?.type === "LineString" &&
        Array.isArray(parsed.coordinates)
      ) {
        coords = parsed.coordinates.map((c: number[]) => ({
          lon: c[0],
          lat: c[1],
          height: c[2] ?? 120,
        }));
      } else {
        throw new Error(
          "请输入 WGS84 坐标数组 [{lon, lat, height}] 或 GeoJSON LineString",
        );
      }
      props.onRunDynamicPathGeneration(coords);
    } catch (e) {
      setJsonError(e instanceof Error ? e.message : "坐标数据格式错误");
    }
  };

  return (
    <aside
      className={`left-workbench glass-panel ${props.collapsed ? "collapsed" : ""}`}
    >
      <nav className="workbench-tabs">
        <button
          type="button"
          className={`wb-tab ${props.activeTab === "global-local" ? "active" : ""}`}
          onClick={() => props.onChangeTab("global-local")}
        >
          <GlobeIcon size={14} />
          1.1 全球/局部
        </button>
        <button
          type="button"
          className={`wb-tab ${props.activeTab === "airspace-obstacle" ? "active" : ""}`}
          onClick={() => props.onChangeTab("airspace-obstacle")}
        >
          <BuildingIcon size={14} />
          1.2 空域/避障
        </button>
        <button
          type="button"
          className={`wb-tab ${props.activeTab === "dynamic-api" ? "active" : ""}`}
          onClick={() => props.onChangeTab("dynamic-api")}
        >
          <RouteIcon size={14} />
          1.3 路径/API
        </button>
      </nav>

      <div className="workbench-body">
        {props.activeTab === "global-local" && (
          <>
            <div className="panel-card">
              <div className="card-title-row">
                <div className="card-title">场景尺度与 3D Tiles 城市切换</div>
              </div>
              <div className="chip-grid">
                {CITY_PRESETS.map((preset) => {
                  const key = preset.tilesetKey;
                  const hasLocal =
                    !key ||
                    key === "sample-cbd" ||
                    Boolean(props.localAssets?.tilesets?.[key]);
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      className={`chip-btn ${props.activePresetId === preset.id ? "active" : ""}`}
                      onClick={() => props.onSelectPreset(preset)}
                    >
                      <strong>{preset.name}</strong>
                      <small>
                        {preset.subtitle}
                        {!hasLocal ? " (内置兜底)" : ""}
                      </small>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="panel-card">
              <div className="card-title-row">
                <div className="card-title">北斗网格分辨率与图层模式</div>
                <span className="hud-badge">L{props.gridLevel}</span>
              </div>

              <label className="toggle-row">
                <span>相机高度自适应分辨率 (Adaptive LOD)</span>
                <input
                  type="checkbox"
                  checked={props.adaptiveLevelEnabled}
                  onChange={(e) =>
                    props.onToggleAdaptiveLevel(e.target.checked)
                  }
                />
              </label>

              <div className="slider-group">
                <div className="slider-label-row">
                  <span>编码级别 (1-10级)</span>
                  <strong>
                    L{props.gridLevel} · {levelSpec.angularLabel} (~
                    {levelSpec.approxGroundMeters >= 1000
                      ? `${(levelSpec.approxGroundMeters / 1000).toFixed(1)}km`
                      : `${levelSpec.approxGroundMeters}m`}
                    )
                  </strong>
                </div>
                <input
                  type="range"
                  min={1}
                  max={10}
                  step={1}
                  value={props.gridLevel}
                  onChange={(e) =>
                    props.onChangeGridLevel(Number(e.target.value) as GridLevel)
                  }
                />
                <div className="card-subtitle">
                  高度步长：{HEIGHT_STEPS[props.gridLevel - 1]} m · 适用尺度：
                  {levelSpec.recommendedScale}
                </div>
              </div>

              <div>
                <div className="card-subtitle" style={{ marginBottom: 4 }}>
                  可视化图层形式
                </div>
                <div className="segmented-row">
                  {LAYER_STYLES.map((st) => (
                    <button
                      key={st.value}
                      type="button"
                      className={`seg-btn ${props.layerStyle === st.value ? "active" : ""}`}
                      onClick={() => props.onChangeLayerStyle(st.value)}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="toggle-row">
                <span>全球立体多层球壳网格 (全球尺度)</span>
                <input
                  type="checkbox"
                  checked={props.showGlobalShell}
                  onChange={(e) => props.onToggleGlobalShell(e.target.checked)}
                />
              </label>

              <label className="toggle-row">
                <span>局部/城市区域立体空域网格</span>
                <input
                  type="checkbox"
                  checked={props.showLocalGrid}
                  onChange={(e) => props.onToggleLocalGrid(e.target.checked)}
                />
              </label>

              <label className="toggle-row">
                <span>显示北斗位置码标注</span>
                <input
                  type="checkbox"
                  checked={props.showGridLabels}
                  onChange={(e) => props.onToggleGridLabels(e.target.checked)}
                />
              </label>
            </div>

            <div className="panel-card">
              <div className="card-title">单点 WGS84 编解码与网格飞入</div>
              <div className="field-grid-3">
                <div className="field-box">
                  <label>经度 (Lon)</label>
                  <input
                    value={lonInput}
                    onChange={(e) => setLonInput(e.target.value)}
                  />
                </div>
                <div className="field-box">
                  <label>纬度 (Lat)</label>
                  <input
                    value={latInput}
                    onChange={(e) => setLatInput(e.target.value)}
                  />
                </div>
                <div className="field-box">
                  <label>高度 (m)</label>
                  <input
                    value={altInput}
                    onChange={(e) => setAltInput(e.target.value)}
                  />
                </div>
              </div>
              <div className="field-box">
                <label>北斗网格位置码 (2D 最多20位 / 3D 最多32位)</label>
                <input
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                />
              </div>
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  onClick={handleEncodeQuery}
                >
                  编码并高亮定位
                </button>
                <button
                  type="button"
                  className="btn btn-emerald"
                  style={{ flex: 1 }}
                  onClick={handleDecodeQuery}
                >
                  解码并飞入
                </button>
              </div>
            </div>
          </>
        )}

        {props.activeTab === "airspace-obstacle" && (
          <>
            <div className="panel-card">
              <div className="card-title-row">
                <div className="card-title">
                  <BuildingIcon size={14} />
                  建筑轮廓自动提取与三维网格化
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ padding: "4px 8px", fontSize: 11 }}
                  onClick={props.onReextractBuildings}
                  disabled={props.isExtractingBuildings}
                >
                  {props.isExtractingBuildings ? "提取中..." : "提取当前视区"}
                </button>
              </div>

              <div className="stat-pills">
                <div className="stat-pill">
                  <span>提取建筑体</span>
                  <strong style={{ color: "#38bdf8" }}>
                    {props.voxelStats.buildingCount}
                  </strong>
                </div>
                <div className="stat-pill">
                  <span>红区建筑体元</span>
                  <strong style={{ color: "#f43f5e" }}>
                    {props.voxelStats.obstacleVoxelCount}
                  </strong>
                </div>
                <div className="stat-pill">
                  <span>黄区避障缓冲</span>
                  <strong style={{ color: "#fbbf24" }}>
                    {props.voxelStats.bufferVoxelCount}
                  </strong>
                </div>
              </div>

              <label className="toggle-row">
                <span>建筑实体三维体素网格 (红框白边包裹)</span>
                <input
                  type="checkbox"
                  checked={props.buildingGridEnabled}
                  onChange={(e) => props.onToggleBuildingGrid(e.target.checked)}
                />
              </label>

              <label className="toggle-row">
                <span>自动生成周边避障安全缓冲区</span>
                <input
                  type="checkbox"
                  checked={props.bufferGridEnabled}
                  onChange={(e) => props.onToggleBufferGrid(e.target.checked)}
                />
              </label>

              <label className="toggle-row">
                <span>低空空域分层基准网格 (背景层)</span>
                <input
                  type="checkbox"
                  checked={props.strataGridEnabled}
                  onChange={(e) => props.onToggleStrataGrid(e.target.checked)}
                />
              </label>

              <div className="field-grid-2">
                <div className="field-box">
                  <label>体素网格细分级别</label>
                  <select
                    value={props.buildingLevel}
                    onChange={(e) =>
                      props.onChangeBuildingLevel(
                        Number(e.target.value) as GridLevel,
                      )
                    }
                  >
                    <option value={5}>L5 (4" · ~124m)</option>
                    <option value={6}>L6 (2" · ~62m)</option>
                    <option value={7}>L7 (0.25" · ~7.7m 精细)</option>
                  </select>
                </div>

                <div className="field-box">
                  <label>高度维度层步长 (m)</label>
                  <select
                    value={props.verticalStepMeters}
                    onChange={(e) =>
                      props.onChangeVerticalStepMeters(Number(e.target.value))
                    }
                  >
                    <option value={7.73}>7.73 m (L7 国标)</option>
                    <option value={15}>15.0 m (低空精细层)</option>
                    <option value={30}>30.0 m (标准航层)</option>
                    <option value={61.84}>61.84 m (L6 国标)</option>
                  </select>
                </div>
              </div>

              <div className="slider-group">
                <div className="slider-label-row">
                  <span>水平避障安全外扩</span>
                  <strong>{props.horizontalBufferMeters} m</strong>
                </div>
                <input
                  type="range"
                  min={0}
                  max={60}
                  step={5}
                  value={props.horizontalBufferMeters}
                  onChange={(e) =>
                    props.onChangeHorizontalBufferMeters(Number(e.target.value))
                  }
                />
              </div>

              <div className="slider-group">
                <div className="slider-label-row">
                  <span>屋顶垂直净空缓冲 / 空域上限</span>
                  <strong>
                    +{props.verticalBufferMeters} m / {props.maxAirspaceHeight}{" "}
                    m
                  </strong>
                </div>
                <div className="field-grid-2">
                  <input
                    type="range"
                    min={0}
                    max={45}
                    step={5}
                    value={props.verticalBufferMeters}
                    onChange={(e) =>
                      props.onChangeVerticalBufferMeters(Number(e.target.value))
                    }
                  />
                  <input
                    type="range"
                    min={150}
                    max={600}
                    step={30}
                    value={props.maxAirspaceHeight}
                    onChange={(e) =>
                      props.onChangeMaxAirspaceHeight(Number(e.target.value))
                    }
                  />
                </div>
              </div>
            </div>

            <div className="panel-card">
              <div className="card-title-row">
                <div className="card-title">
                  <ShieldIcon size={14} />
                  飞行计划避障冲突分析与自动绕飞
                </div>
              </div>

              <div className="field-box">
                <label>预置飞行计划航线</label>
                <select
                  value={props.selectedFlightPresetId}
                  onChange={(e) => props.onSelectFlightPreset(e.target.value)}
                >
                  {FLIGHT_PRESETS.map((fp) => (
                    <option key={fp.id} value={fp.id}>
                      {fp.name}
                    </option>
                  ))}
                  <option value="custom">
                    自定义拾取航线 ({props.waypoints.length} 点)
                  </option>
                </select>
              </div>

              <div className="slider-group">
                <div className="slider-label-row">
                  <span>飞行安全包络走廊半径</span>
                  <strong>{props.corridorRadiusMeters} m</strong>
                </div>
                <input
                  type="range"
                  min={0}
                  max={35}
                  step={5}
                  value={props.corridorRadiusMeters}
                  onChange={(e) =>
                    props.onChangeCorridorRadiusMeters(Number(e.target.value))
                  }
                />
              </div>

              <div className="btn-row">
                <button
                  type="button"
                  className={`btn ${props.isPickingWaypoint ? "btn-amber" : "btn-ghost"}`}
                  style={{ flex: 1 }}
                  onClick={() =>
                    props.onTogglePickWaypoint(!props.isPickingWaypoint)
                  }
                >
                  {props.isPickingWaypoint
                    ? "点击地图加点中..."
                    : "+ 地图选点规划"}
                </button>
                <div className="field-box" style={{ width: 78 }}>
                  <input
                    type="number"
                    value={props.pickWaypointHeight}
                    onChange={(e) =>
                      props.onChangePickWaypointHeight(
                        Number(e.target.value) || 80,
                      )
                    }
                    title="新增航点默认海拔(m)"
                  />
                </div>
                <button
                  type="button"
                  className="btn btn-danger"
                  onClick={() => props.onUpdateWaypoints([])}
                >
                  清空
                </button>
              </div>

              {props.flightAnalysis && (
                <div
                  className={`alert-banner ${
                    props.flightAnalysis.isSafe ? "safe" : "danger"
                  }`}
                >
                  {props.flightAnalysis.isSafe ? (
                    <>
                      <strong>✅ 飞行计划净空安全</strong> · 航程{" "}
                      {props.flightAnalysis.summary.totalDistanceMeters} m ·
                      占用 {props.flightAnalysis.summary.totalPathVoxels}{" "}
                      个北斗网格 · 最小净距{" "}
                      {props.flightAnalysis.minClearanceMeters} m
                    </>
                  ) : (
                    <>
                      <strong>⚠ 检测到建筑避障冲突！</strong> 命中{" "}
                      {props.flightAnalysis.summary.conflictCount}{" "}
                      个建筑禁飞体元， 侵入{" "}
                      {props.flightAnalysis.summary.bufferWarningCount}{" "}
                      个缓冲警戒格 (最小净距{" "}
                      {props.flightAnalysis.minClearanceMeters} m)。
                      {props.flightAnalysis.summary.hasDetour &&
                        " 已基于三维北斗 A* 自动规划绿色无冲突绕飞航线！"}
                    </>
                  )}
                </div>
              )}

              <label className="toggle-row">
                <span>叠加三维北斗 A* 避障推荐绕飞航线</span>
                <input
                  type="checkbox"
                  checked={props.showDetourRoute}
                  onChange={(e) =>
                    props.onToggleShowDetourRoute(e.target.checked)
                  }
                />
              </label>

              <div className="btn-row">
                <button
                  type="button"
                  className={`btn ${props.isSimulatingFlight ? "btn-amber" : "btn-emerald"}`}
                  style={{ flex: 1 }}
                  onClick={props.onToggleSimulateFlight}
                >
                  {props.isSimulatingFlight ? (
                    <>
                      <PauseIcon size={13} /> 暂停无人机实时模拟
                    </>
                  ) : (
                    <>
                      <PlayIcon size={13} /> 启动实时轨迹飞行与编码追踪
                    </>
                  )}
                </button>
              </div>

              {props.liveFlightCell && (
                <div
                  style={{
                    fontSize: 11,
                    fontFamily: "Consolas, monospace",
                    background: "rgba(6,12,24,0.85)",
                    border: "1px solid rgba(52, 211, 153, 0.45)",
                    borderRadius: 6,
                    padding: "6px 8px",
                    color: "#6ee7b7",
                  }}
                >
                  实时轨迹位置码: {props.liveFlightCell.code3D}
                </div>
              )}
            </div>
          </>
        )}

        {props.activeTab === "dynamic-api" && (
          <>
            <div className="panel-card">
              <div className="card-title-row">
                <div className="card-title">
                  <RouteIcon size={14} />
                  动态经纬度 / 轨迹网格实时生成 (GB/T 20254)
                </div>
              </div>
              <p className="card-subtitle">
                输入任意 WGS84 坐标序列或 GeoJSON
                LineString，实时生成不同分辨率级别的北斗路径网格区域。
              </p>

              <div className="field-box">
                <label>目标生成级别 (可多级并行叠加)</label>
                <div className="btn-row">
                  {([4, 5, 6, 7, 8] as GridLevel[]).map((lv) => {
                    const active = props.apiLevels.includes(lv);
                    return (
                      <button
                        key={lv}
                        type="button"
                        className={`seg-btn ${active ? "active" : ""}`}
                        style={{ flex: 1 }}
                        onClick={() => toggleApiLevel(lv)}
                      >
                        L{lv}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="field-box">
                <label>调用图层形式</label>
                <div className="segmented-row">
                  {LAYER_STYLES.map((st) => (
                    <button
                      key={st.value}
                      type="button"
                      className={`seg-btn ${props.apiLayerStyle === st.value ? "active" : ""}`}
                      onClick={() => props.onChangeApiLayerStyle(st.value)}
                    >
                      {st.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="field-box">
                <label>WGS84 轨迹数据 (JSON 数组或 GeoJSON)</label>
                <textarea
                  className="code-textarea"
                  value={trajectoryJson}
                  onChange={(e) => setTrajectoryJson(e.target.value)}
                />
              </div>

              {jsonError && (
                <div className="alert-banner danger">{jsonError}</div>
              )}

              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flex: 1 }}
                  onClick={handleParseAndGeneratePath}
                >
                  生成动态路径网格图层
                </button>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={props.onClearDynamicPathLayer}
                >
                  清除
                </button>
              </div>
            </div>

            {props.apiPathResult && (
              <div className="panel-card">
                <div className="card-title-row">
                  <div className="card-title">路径生成北斗编码清单</div>
                  <span className="hud-badge">
                    {props.apiPathResult.levels.reduce(
                      (a, b) => a + b.cellCount,
                      0,
                    )}{" "}
                    体元
                  </span>
                </div>

                {props.apiPathResult.levels.map((lvRes) => (
                  <div
                    key={lvRes.level}
                    style={{ display: "flex", flexDirection: "column", gap: 4 }}
                  >
                    <div className="card-subtitle">
                      <strong>L{lvRes.level}</strong> · 2D 网格{" "}
                      {lvRes.codes2D.length} 个 · 3D 体元 {lvRes.cellCount} 个
                    </div>
                    <div className="code-list-box">
                      {lvRes.codes3D.slice(0, 36).map((c) => (
                        <span
                          key={c}
                          className="code-tag"
                          onClick={() => props.onQueryPointOrCode(undefined, c)}
                          title="点击飞入并高亮该网格"
                        >
                          {c}
                        </span>
                      ))}
                      {lvRes.codes3D.length > 36 && (
                        <span className="code-tag">
                          +{lvRes.codes3D.length - 36} 更多...
                        </span>
                      )}
                    </div>
                  </div>
                ))}

                <button
                  type="button"
                  className="btn btn-emerald"
                  onClick={props.onOpenApiModal}
                >
                  打开完整 SDK / HTTP REST API 调试台
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  );
};
