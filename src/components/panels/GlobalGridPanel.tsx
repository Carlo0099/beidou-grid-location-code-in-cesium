import React, { useState } from "react";
import type { GridLevel } from "../../types/beidou";
import {
  BeidouGridCode,
  GRID_LEVEL_SPECS,
  HEIGHT_STEPS,
} from "../../core/BeidouGridCode";
import { DEFAULT_AIRSPACE_CENTER } from "../../core/SampleCityData";
import { GlobeIcon } from "../Icons";
import { LAYER_STYLES, type GlobalGridPanelProps } from "./panelTypes";

export const GlobalGridPanel: React.FC<GlobalGridPanelProps> = React.memo(
  (props) => {
    const [lonInput, setLonInput] = useState(String(DEFAULT_AIRSPACE_CENTER.lon));
    const [latInput, setLatInput] = useState(String(DEFAULT_AIRSPACE_CENTER.lat));
    const [altInput, setAltInput] = useState("120");
    const [codeInput, setCodeInput] = useState("N050J0047050390B8020001800000000");

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

    return (
      <>
        <div className="panel-card">
          <div className="card-title-row">
            <div className="card-title">
              <GlobeIcon size={14} />
              全球宏观视野控制
            </div>
            <span className="hud-badge">
              {props.cameraView.cameraHeightMeters >= 10000
                ? `${(props.cameraView.cameraHeightMeters / 1000).toFixed(1)} km`
                : props.cameraView.cameraHeightMeters >= 10
                  ? `${Math.round(props.cameraView.cameraHeightMeters)} m`
                  : `${props.cameraView.cameraHeightMeters.toFixed(2)} m`}
            </span>
          </div>
          <p className="card-subtitle">
            滚轮缩放相机高度时，系统可自适应切换 L1-L10 北斗网格编码与三维分辨率；L1
            全球尺度下每个网格单元均附带位置编码。
          </p>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              style={{ flex: 1 }}
              onClick={props.onFlyToGlobal}
            >
              <GlobeIcon size={13} /> 飞回全球宏观视野 (L1)
            </button>
          </div>
          <div className="card-subtitle">
            视区中心：{props.cameraView.centerLon.toFixed(4)}°,{" "}
            {props.cameraView.centerLat.toFixed(4)}° · 推荐级别 L
            {props.cameraView.adaptiveLevel}
          </div>
        </div>

        <div className="panel-card">
          <div className="card-title-row">
            <div className="card-title">北斗网格分辨率与图层模式</div>
            <span className="hud-badge">L{props.gridLevel}</span>
          </div>

          <label className="toggle-row">
            <span>相机高度自适应分辨率 (Adaptive LOD 1-10级)</span>
            <input
              type="checkbox"
              checked={props.adaptiveLevelEnabled}
              onChange={(e) => props.onToggleAdaptiveLevel(e.target.checked)}
            />
          </label>

          <div className="slider-group">
            <div className="slider-label-row">
              <span>编码级别 (1-10级)</span>
              <strong>
                L{props.gridLevel} · {levelSpec.angularLabel} (~
                {levelSpec.approxGroundMeters >= 1000
                  ? `${(levelSpec.approxGroundMeters / 1000).toFixed(1)}km`
                  : levelSpec.approxGroundMeters >= 1
                    ? `${levelSpec.approxGroundMeters}m`
                    : `${(levelSpec.approxGroundMeters * 100).toFixed(1)}cm`}
                )
              </strong>
            </div>
            <input
              type="range"
              min={1}
              max={10}
              step={1}
              value={props.gridLevel}
              onChange={(e) => {
                if (props.adaptiveLevelEnabled) {
                  props.onToggleAdaptiveLevel(false);
                }
                props.onChangeGridLevel(Number(e.target.value) as GridLevel);
              }}
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
            <span>全球立体多层球壳网格 (L1 全球尺度)</span>
            <input
              type="checkbox"
              checked={props.showGlobalShell}
              onChange={(e) => props.onToggleGlobalShell(e.target.checked)}
            />
          </label>

          <label className="toggle-row">
            <span>视口自适应网格 (L2-L10 满视口渲染)</span>
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

          <label className="toggle-row">
            <span>244Hz 极限高帧模式（动态分辨率与地球降载）</span>
            <input
              type="checkbox"
              checked={props.turbo244Mode}
              onChange={(e) => props.onToggleTurbo244Mode(e.target.checked)}
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
    );
  },
);
