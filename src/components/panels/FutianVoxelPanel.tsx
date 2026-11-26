import React from "react";
import {
  DEFAULT_ELEVATION_THRESHOLDS,
  type ElevationColorThresholds,
  type MassiveVoxelStyle,
} from "../../types/beidou";
import { FUTIAN_LANDMARKS } from "../../core/MassiveVoxelEngine";
import { CubeIcon } from "../Icons";
import type { FutianVoxelPanelProps } from "./panelTypes";

const VOXEL_STYLES: Array<{ id: MassiveVoxelStyle; title: string; sub: string }> = [
  { id: "conformal-white", title: "白膜贴合壳体", sub: "青白体素包裹全城白膜" },
  { id: "height-heatmap", title: "高程梯度体素", sub: "低中高超高层分级着色" },
  { id: "translucent-volume", title: "半透明全实体", sub: "建筑外壳+立体净空展示" },
  { id: "tileset-only", title: "仅福田白膜", sub: "关闭体素专注查看建筑" },
];

const LOD_MODES = [
  { value: "auto", label: "自适应 (L6-10)" },
  { value: 6, label: "L6 (62m)" },
  { value: 7, label: "L7 (7.7m)" },
  { value: 8, label: "L8 (0.97m)" },
  { value: 9, label: "L9 (12cm)" },
  { value: 10, label: "L10 (1.5cm)" },
] as const;

export const FutianVoxelPanel: React.FC<FutianVoxelPanelProps> = React.memo(
  (props) => {
    return (
      <>
        <div className="panel-card">
          <div className="card-title-row">
            <div className="card-title">
              <CubeIcon size={14} />
              福田 3D Tiles 白膜与亿级网格空间索引
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: "4px 8px", fontSize: 11 }}
              onClick={props.onRebuildFutianIndex}
              disabled={props.isIndexingFutian}
            >
              {props.isIndexingFutian ? "解析中..." : "重建索引"}
            </button>
          </div>

          <p className="card-subtitle">
            加载已内置的福田区 15 块精细 `.glb` 建筑白膜，实时三角面光栅化构建稀疏北斗体素索引，支持视口流式贴合渲染（点击任意体素可查 32 位北斗码）。
          </p>

          {props.isIndexingFutian && (
            <div className="alert-banner safe" style={{ fontSize: 11 }}>
              正在流式体素化福田 GLB 白膜：{props.futianIndexProgress.parsed} /{" "}
              {props.futianIndexProgress.total} 瓦片...
            </div>
          )}

          <div className="stat-pills">
            <div className="stat-pill">
              <span>L10 虚空间容积</span>
              <strong style={{ color: "#38bdf8" }}>
                {props.futianStats
                  ? props.futianStats.virtualCapacityL10 >= 1e12
                    ? `${Math.round(props.futianStats.virtualCapacityL10 / 1e12).toLocaleString()} 万亿格`
                    : `${(props.futianStats.virtualCapacityL10 / 1e8).toFixed(1)} 亿格`
                  : "--"}
              </strong>
            </div>
            <div className="stat-pill">
              <span>L8 虚空间容积</span>
              <strong style={{ color: "#a78bfa" }}>
                {props.futianStats
                  ? `${(props.futianStats.virtualCapacityL8 / 1e8).toFixed(1)} 亿格`
                  : "--"}
              </strong>
            </div>
            <div className="stat-pill">
              <span>视口流式体素</span>
              <strong style={{ color: "#34d399" }}>
                {props.futianStats
                  ? props.futianStats.renderedVoxels.toLocaleString()
                  : "0"}
              </strong>
            </div>
          </div>

          <div className="stat-pills">
            <div className="stat-pill">
              <span>解析建筑要素</span>
              <strong>
                {props.futianStats
                  ? props.futianStats.featureCount.toLocaleString()
                  : "--"}
              </strong>
            </div>
            <div className="stat-pill">
              <span>L7 占空体素柱</span>
              <strong>
                {props.futianStats
                  ? props.futianStats.occupiedColumnsL7.toLocaleString()
                  : "--"}
              </strong>
            </div>
            <div className="stat-pill">
              <span>全量体素总耗时</span>
              <strong>
                {props.futianStats ? `${props.futianStats.parseTimeMs} ms` : "--"}
              </strong>
            </div>
          </div>
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <div className="card-title">城市仿真贴合体素样式与 LOD</div>
            <span className="hud-badge">
              {props.futianStats?.activeLevelLabel ?? "L7"}
            </span>
          </div>

          <div className="chip-grid">
            {VOXEL_STYLES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`chip-btn ${props.massiveVoxelStyle === item.id ? "active" : ""}`}
                onClick={() => props.onChangeMassiveVoxelStyle(item.id)}
              >
                <strong>{item.title}</strong>
                <small>{item.sub}</small>
              </button>
            ))}
          </div>

          {(props.massiveVoxelStyle === "height-heatmap" ||
            props.massiveVoxelStyle === "translucent-volume") && (
            <div
              className="field-box"
              style={{
                padding: "8px 10px",
                borderRadius: 8,
                background: "rgba(15, 23, 42, 0.55)",
                border: "1px solid rgba(56, 189, 248, 0.2)",
                gap: 6,
              }}
            >
              <div className="slider-label-row" style={{ marginBottom: 2 }}>
                <span style={{ fontWeight: 600 }}>高程梯度颜色变化阈值 (m)</span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  style={{ padding: "2px 6px", fontSize: 10 }}
                  onClick={() =>
                    props.onChangeElevationThresholds(DEFAULT_ELEVATION_THRESHOLDS)
                  }
                >
                  恢复默认
                </button>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: 4,
                  fontSize: 10,
                }}
              >
                {[
                  {
                    color: "#38bdf8",
                    text: `<${props.elevationThresholds[0]}m`,
                  },
                  {
                    color: "#10b981",
                    text: `${props.elevationThresholds[0]}-${props.elevationThresholds[1]}m`,
                  },
                  {
                    color: "#f59e0b",
                    text: `${props.elevationThresholds[1]}-${props.elevationThresholds[2]}m`,
                  },
                  {
                    color: "#f43f5e",
                    text: `>=${props.elevationThresholds[2]}m`,
                  },
                ].map((band) => (
                  <div
                    key={band.color}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      color: "#cbd5e1",
                      whiteSpace: "nowrap",
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: band.color,
                        flexShrink: 0,
                      }}
                    />
                    <span>{band.text}</span>
                  </div>
                ))}
              </div>

              {(
                [
                  {
                    label: "低 → 中层阈值 (蓝/绿)",
                    idx: 0 as const,
                    min: 15,
                    max: 180,
                    val: props.elevationThresholds[0],
                    onInput: (v: number): ElevationColorThresholds => {
                      const t1 = Math.max(props.elevationThresholds[1], v + 10);
                      const t2 = Math.max(props.elevationThresholds[2], t1 + 10);
                      return [v, t1, t2];
                    },
                  },
                  {
                    label: "中 → 高层阈值 (绿/橙)",
                    idx: 1 as const,
                    min: 25,
                    max: 280,
                    val: props.elevationThresholds[1],
                    onInput: (v: number): ElevationColorThresholds => {
                      const t0 = Math.min(props.elevationThresholds[0], v - 10);
                      const t2 = Math.max(props.elevationThresholds[2], v + 10);
                      return [t0, v, t2];
                    },
                  },
                  {
                    label: "高 → 超高层阈值 (橙/红)",
                    idx: 2 as const,
                    min: 40,
                    max: 400,
                    val: props.elevationThresholds[2],
                    onInput: (v: number): ElevationColorThresholds => {
                      const t1 = Math.min(props.elevationThresholds[1], v - 10);
                      const t0 = Math.min(props.elevationThresholds[0], t1 - 10);
                      return [t0, t1, v];
                    },
                  },
                ]
              ).map((item) => (
                <div key={item.idx} className="slider-group">
                  <div className="slider-label-row" style={{ fontSize: 11 }}>
                    <span>{item.label}</span>
                    <strong>{item.val} m</strong>
                  </div>
                  <input
                    type="range"
                    min={item.min}
                    max={item.max}
                    step={5}
                    value={item.val}
                    onChange={(e) =>
                      props.onChangeElevationThresholds(
                        item.onInput(Number(e.target.value)),
                      )
                    }
                  />
                </div>
              ))}
            </div>
          )}

          <div>
            <div className="card-subtitle" style={{ marginBottom: 4 }}>
              流式体素 LOD 分辨率模式 (最大支持 L10 · 1.5cm 厘米极精)
            </div>
            <div className="segmented-row" style={{ flexWrap: "wrap", gap: 4 }}>
              {LOD_MODES.map((opt) => (
                <button
                  key={String(opt.value)}
                  type="button"
                  className={`seg-btn ${props.massiveLodMode === opt.value ? "active" : ""}`}
                  style={{ flex: "1 1 30%", minWidth: 82 }}
                  onClick={() => props.onChangeMassiveLodMode(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <label className="toggle-row">
            <span>铺设地表/广场连续贴合体素底网</span>
            <input
              type="checkbox"
              checked={props.includeGroundCarpet}
              onChange={(e) => props.onToggleGroundCarpet(e.target.checked)}
            />
          </label>

          <label className="toggle-row">
            <span>244Hz 极限高帧模式（动态分辨率与白膜SSE加速）</span>
            <input
              type="checkbox"
              checked={props.turbo244Mode}
              onChange={(e) => props.onToggleTurbo244Mode(e.target.checked)}
            />
          </label>

          <div className="slider-group">
            <div className="slider-label-row">
              <span>3D Tiles 白膜不透明度</span>
              <strong>{Math.round(props.whiteModelOpacity * 100)}%</strong>
            </div>
            <input
              type="range"
              min={0.15}
              max={1}
              step={0.05}
              value={props.whiteModelOpacity}
              onChange={(e) =>
                props.onChangeWhiteModelOpacity(Number(e.target.value))
              }
            />
          </div>

          <div className="slider-group">
            <div className="slider-label-row">
              <span>建筑体素最小高程筛选</span>
              <strong>&gt;= {props.minElevationFilterMeters} m</strong>
            </div>
            <input
              type="range"
              min={0}
              max={180}
              step={15}
              value={props.minElevationFilterMeters}
              onChange={(e) =>
                props.onChangeMinElevationFilter(Number(e.target.value))
              }
            />
          </div>
        </div>

        <div className="panel-card">
          <div className="card-title">福田白膜示范飞行视角切换</div>
          <div className="chip-grid">
            {FUTIAN_LANDMARKS.map((lm) => (
              <button
                key={lm.id}
                type="button"
                className={`chip-btn ${props.activeLandmarkId === lm.id ? "active" : ""}`}
                onClick={() => props.onSelectFutianLandmark(lm)}
              >
                <strong>{lm.name}</strong>
                <small>{lm.subtitle}</small>
              </button>
            ))}
          </div>
        </div>
      </>
    );
  },
);
