import React from 'react';
import type { TelemetrySnapshot } from '../types/beidou';
import { ApiIcon, LayersIcon } from './Icons';

interface TopHudBarProps {
  telemetry: TelemetrySnapshot;
  workbenchOpen: boolean;
  onToggleWorkbench: () => void;
  onOpenApiModal: () => void;
}

export const TopHudBar: React.FC<TopHudBarProps> = ({
  telemetry,
  workbenchOpen,
  onToggleWorkbench,
  onOpenApiModal,
}) => {
  const altStr =
    telemetry.cameraHeightMeters >= 10000
      ? `${(telemetry.cameraHeightMeters / 1000).toFixed(1)} km`
      : `${Math.round(telemetry.cameraHeightMeters)} m`;

  return (
    <header className="top-hud glass-panel">
      <div className="hud-brand">
        <span className="hud-pulse" />
        <span className="hud-title">北斗低空空域网格化与建筑避障系统</span>
        <span className="hud-badge">GB/T 39409-2020 · React+TS+Cesium</span>
      </div>

      <div className="hud-metrics">
        <div className="hud-metric">
          <span className="hud-metric-label">渲染帧率</span>
          <span
            className={`hud-metric-val ${
              telemetry.fps >= 48 ? 'emerald' : 'amber'
            }`}
          >
            {telemetry.fps} FPS
          </span>
        </div>

        <div className="hud-metric">
          <span className="hud-metric-label">相机高程 / 推荐级别</span>
          <span className="hud-metric-val cyan">
            {altStr} · L{telemetry.adaptiveLevel}
          </span>
        </div>

        <div className="hud-metric">
          <span className="hud-metric-label">体元 / 建筑提取</span>
          <span className="hud-metric-val">
            {telemetry.renderedVoxelCount.toLocaleString()} 格 ·{' '}
            {telemetry.renderedBuildingCount} 栋
          </span>
        </div>

        <div className="hud-metric">
          <span className="hud-metric-label">实时光标 WGS84</span>
          <span className="hud-metric-val">
            {telemetry.mouseLon !== null && telemetry.mouseLat !== null
              ? `${telemetry.mouseLon.toFixed(6)}°, ${telemetry.mouseLat.toFixed(6)}° (${Math.round(telemetry.mouseHeight ?? 0)}m)`
              : '-- , --'}
          </span>
        </div>

        <div className="hud-metric">
          <span className="hud-metric-label">实时北斗二维位置码</span>
          <span className="hud-metric-val cyan">
            {telemetry.mouseCode2D || '--'}
          </span>
        </div>
      </div>

      <div className="hud-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onToggleWorkbench}
          title="切换左侧工作台面板"
        >
          <LayersIcon size={14} />
          {workbenchOpen ? '收起面板' : '展开面板'}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onOpenApiModal}
        >
          <ApiIcon size={14} />
          API 接入台
        </button>
      </div>
    </header>
  );
};
