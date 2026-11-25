import React, { useState } from 'react';
import type {
  GridLayerStyle,
  GridLevel,
  PathGridGenerationResponse,
} from '../types/beidou';
import { ApiIcon, CloseIcon, PlayIcon } from './Icons';

interface ApiPlaygroundDrawerProps {
  open: boolean;
  onClose: () => void;
  onExecuteLayerCall: (
    layerId: string,
    coords: Array<{ lon: number; lat: number; height?: number }>,
    levels: GridLevel[],
    layerStyle: GridLayerStyle,
  ) => PathGridGenerationResponse | null;
  onClearApiLayer: (layerId: string) => void;
}

const DEFAULT_PAYLOAD = JSON.stringify(
  {
    layerId: 'api-demo-corridor',
    layerStyle: 'translucent-volume',
    levels: [5, 6, 7],
    corridorRadiusMeters: 20,
    coordinates: [
      { lon: 116.308, lat: 39.9902, height: 140 },
      { lon: 116.3126, lat: 39.9932, height: 165 },
      { lon: 116.317, lat: 39.9958, height: 185 },
    ],
  },
  null,
  2,
);

export const ApiPlaygroundDrawer: React.FC<ApiPlaygroundDrawerProps> = ({
  open,
  onClose,
  onExecuteLayerCall,
  onClearApiLayer,
}) => {
  const [payloadText, setPayloadText] = useState(DEFAULT_PAYLOAD);
  const [responseText, setResponseText] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string>('');

  if (!open) return null;

  const runSdkCall = () => {
    setErrorMsg('');
    try {
      const parsed = JSON.parse(payloadText) as {
        layerId?: string;
        layerStyle?: GridLayerStyle;
        levels?: GridLevel[];
        coordinates: Array<{ lon: number; lat: number; height?: number }>;
      };
      const res = onExecuteLayerCall(
        parsed.layerId ?? 'api-demo-corridor',
        parsed.coordinates ?? [],
        parsed.levels ?? [6],
        parsed.layerStyle ?? 'translucent-volume',
      );
      if (res) {
        const preview = {
          ...res,
          levels: res.levels.map((l) => ({
            level: l.level,
            cellCount: l.cellCount,
            codes2DPreview: l.codes2D.slice(0, 12),
            codes3DPreview: l.codes3D.slice(0, 12),
          })),
        };
        setResponseText(JSON.stringify(preview, null, 2));
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'JSON 解析失败');
    }
  };

  const runRestHttpCall = async () => {
    setErrorMsg('');
    try {
      const res = await fetch('/api/beidou/path-grids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payloadText,
      });
      const json = await res.json();
      setResponseText(JSON.stringify(json, null, 2).slice(0, 5000));
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : 'HTTP 请求失败');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-window glass-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <div className="card-title">
            <ApiIcon size={16} />
            <span>北斗网格多图层可调用 API 控制台 (SDK &amp; HTTP REST)</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={onClose}
            style={{ padding: '4px 8px' }}
          >
            <CloseIcon size={14} />
          </button>
        </div>

        <div className="modal-body">
          <p className="card-subtitle">
            支持外部业务系统通过 <code>window.BeidouGridAPI.renderLayer(...)</code>{' '}
            或 HTTP <code>POST /api/beidou/path-grids</code> 接入任意 WGS84
            经纬度/轨迹数组，实时生成多级别北斗网格并返回或叠加到 Cesium 场景（支持{' '}
            <code>2d-plane</code> / <code>3d-wireframe</code> /{' '}
            <code>translucent-volume</code> / <code>hybrid</code>）。
          </p>

          <div className="field-grid-2">
            <div className="field-box">
              <label>请求载荷 JSON (WGS84 轨迹 + 多级别 + 图层样式)</label>
              <textarea
                className="code-textarea"
                style={{ minHeight: 210 }}
                value={payloadText}
                onChange={(e) => setPayloadText(e.target.value)}
              />
            </div>

            <div className="field-box">
              <label>SDK / REST 接口调用示例</label>
              <pre className="api-pre" style={{ minHeight: 210, margin: 0 }}>
{`// 1. 浏览器运行时直接调用多图层 API
const res = window.BeidouGridAPI.renderLayer("uav-corridor-1", {
  coordinates: [
    { lon: 114.0535, lat: 22.5405, height: 140 },
    { lon: 114.0615, lat: 22.5452, height: 185 }
  ],
  levels: [5, 6, 7],
  layerStyle: "translucent-volume", // 2d-plane | 3d-wireframe | translucent-volume | hybrid
  corridorRadiusMeters: 20
});

// 2. HTTP REST 服务调用 (Vite 中间件实时响应)
fetch("/api/beidou/path-grids", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ coordinates: [...], levels: [6, 7] })
});`}
              </pre>
            </div>
          </div>

          <div className="btn-row">
            <button type="button" className="btn btn-primary" onClick={runSdkCall}>
              <PlayIcon size={13} />
              执行 SDK 实时渲染到 Cesium 场景
            </button>
            <button type="button" className="btn btn-emerald" onClick={runRestHttpCall}>
              测试 HTTP POST /api/beidou/path-grids
            </button>
            <button
              type="button"
              className="btn btn-danger"
              onClick={() => onClearApiLayer('api-demo-corridor')}
            >
              清除 API 测试图层
            </button>
          </div>

          {errorMsg && <div className="alert-banner danger">{errorMsg}</div>}

          {responseText && (
            <div>
              <div className="card-subtitle" style={{ marginBottom: 4 }}>
                接口返回响应预览：
              </div>
              <pre className="api-pre">{responseText}</pre>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
