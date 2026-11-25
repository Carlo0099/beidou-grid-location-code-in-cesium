import React, { useMemo } from 'react';
import type { BeidouVoxelCell } from '../types/beidou';
import { getNeighbors } from '../core/BeidouGridCode';
import { CloseIcon, CubeIcon } from './Icons';

interface GridInspectorCardProps {
  cell: BeidouVoxelCell | null;
  onClose: () => void;
  onSelectNeighborCode: (code: string) => void;
}

const CATEGORY_TEXT: Record<BeidouVoxelCell['category'], { label: string; color: string }> = {
  'global-shell': { label: '全球球壳网格', color: '#38bdf8' },
  'local-airspace': { label: '局部空域网格', color: '#38bdf8' },
  'airspace-free': { label: '低空适飞空域', color: '#94a3b8' },
  'building-obstacle': { label: '建筑物占用禁飞体元', color: '#f43f5e' },
  'obstacle-buffer': { label: '建筑周边避障缓冲区', color: '#f59e0b' },
  'flight-corridor': { label: '路径规划空域走廊', color: '#22d3ee' },
  'flight-conflict': { label: '航线碰撞冲突体元', color: '#ff1e42' },
  'flight-detour': { label: '避障绕飞安全体元', color: '#34d399' },
  'query-highlight': { label: '点/码查询高亮单元', color: '#60a5fa' },
};

export const GridInspectorCard: React.FC<GridInspectorCardProps> = ({
  cell,
  onClose,
  onSelectNeighborCode,
}) => {
  const neighbors = useMemo(() => {
    if (!cell) return null;
    try {
      return getNeighbors(cell.code3D);
    } catch {
      return null;
    }
  }, [cell]);

  if (!cell) return null;

  const meta = CATEGORY_TEXT[cell.category] ?? {
    label: cell.category,
    color: '#38bdf8',
  };

  return (
    <aside className="inspector-card glass-panel">
      <div className="card-title-row">
        <div className="card-title">
          <CubeIcon size={15} />
          <span>北斗网格体元探针</span>
        </div>
        <button
          type="button"
          className="btn btn-ghost"
          style={{ padding: '3px 6px' }}
          onClick={onClose}
          aria-label="关闭网格检查器"
        >
          <CloseIcon size={13} />
        </button>
      </div>

      <div
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: meta.color,
          background: 'rgba(6, 12, 24, 0.72)',
          border: `1px solid ${meta.color}55`,
          borderRadius: 6,
          padding: '5px 8px',
        }}
      >
        状态：{meta.label} · L{cell.level}
        {cell.buildingName ? ` (${cell.buildingName})` : ''}
        {cell.distanceToObstacleMeters !== undefined
          ? ` · 距建筑 ${cell.distanceToObstacleMeters}m`
          : ''}
      </div>

      <div className="field-box">
        <label>二维位置码 (点击复制)</label>
        <input
          readOnly
          value={cell.code2D}
          onClick={() => navigator.clipboard?.writeText(cell.code2D)}
        />
      </div>

      <div className="field-box">
        <label>三维交叉位置码 (GB/T 39409-2020)</label>
        <input
          readOnly
          value={cell.code3D}
          onClick={() => navigator.clipboard?.writeText(cell.code3D)}
        />
      </div>

      <div className="card-subtitle" style={{ fontFamily: 'Consolas, monospace', fontSize: 10 }}>
        经度: {cell.minLon.toFixed(6)}° ~ {cell.maxLon.toFixed(6)}°
        <br />
        纬度: {cell.minLat.toFixed(6)}° ~ {cell.maxLat.toFixed(6)}°
        <br />
        高度: {cell.minHeight.toFixed(2)} m ~ {cell.maxHeight.toFixed(2)} m
      </div>

      {neighbors && (
        <div>
          <div className="card-subtitle" style={{ marginBottom: 4 }}>
            邻接三维网格拓扑 (点击跳转解码)
          </div>
          <div className="neighbor-compass">
            <button
              type="button"
              className="neighbor-btn"
              onClick={() => onSelectNeighborCode(neighbors.northwest)}
              title={neighbors.northwest}
            >
              ↖ {neighbors.northwest.slice(-6)}
            </button>
            <button
              type="button"
              className="neighbor-btn"
              onClick={() => onSelectNeighborCode(neighbors.north)}
              title={neighbors.north}
            >
              ↑ {neighbors.north.slice(-6)}
            </button>
            <button
              type="button"
              className="neighbor-btn"
              onClick={() => onSelectNeighborCode(neighbors.northeast)}
              title={neighbors.northeast}
            >
              ↗ {neighbors.northeast.slice(-6)}
            </button>
            <button
              type="button"
              className="neighbor-btn"
              onClick={() => onSelectNeighborCode(neighbors.west)}
              title={neighbors.west}
            >
              ← {neighbors.west.slice(-6)}
            </button>
            <button type="button" className="neighbor-btn center" title={cell.code3D}>
              当前体元
            </button>
            <button
              type="button"
              className="neighbor-btn"
              onClick={() => onSelectNeighborCode(neighbors.east)}
              title={neighbors.east}
            >
              → {neighbors.east.slice(-6)}
            </button>
            <button
              type="button"
              className="neighbor-btn"
              onClick={() => onSelectNeighborCode(neighbors.southwest)}
              title={neighbors.southwest}
            >
              ↙ {neighbors.southwest.slice(-6)}
            </button>
            <button
              type="button"
              className="neighbor-btn"
              onClick={() => onSelectNeighborCode(neighbors.south)}
              title={neighbors.south}
            >
              ↓ {neighbors.south.slice(-6)}
            </button>
            <button
              type="button"
              className="neighbor-btn"
              onClick={() => onSelectNeighborCode(neighbors.southeast)}
              title={neighbors.southeast}
            >
              ↘ {neighbors.southeast.slice(-6)}
            </button>
          </div>
          {neighbors.up && neighbors.down && (
            <div className="btn-row" style={{ marginTop: 6 }}>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ flex: 1, fontSize: 11, padding: '4px 6px' }}
                onClick={() => onSelectNeighborCode(neighbors.up!)}
              >
                ⬆ 上层 ({neighbors.up.slice(-6)})
              </button>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ flex: 1, fontSize: 11, padding: '4px 6px' }}
                onClick={() => onSelectNeighborCode(neighbors.down!)}
              >
                ⬇ 下层 ({neighbors.down.slice(-6)})
              </button>
            </div>
          )}
        </div>
      )}
    </aside>
  );
};
