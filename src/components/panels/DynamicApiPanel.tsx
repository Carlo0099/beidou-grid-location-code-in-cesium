import React, { useState } from "react";
import type { GridLevel, Wgs84Point } from "../../types/beidou";
import { RouteIcon } from "../Icons";
import { LAYER_STYLES, type DynamicApiPanelProps } from "./panelTypes";

const DEFAULT_TRAJECTORY = JSON.stringify(
  [
    { lon: 116.308, lat: 39.9902, height: 110 },
    { lon: 116.3112, lat: 39.9922, height: 145 },
    { lon: 116.3144, lat: 39.9941, height: 175 },
    { lon: 116.3172, lat: 39.9959, height: 150 },
  ],
  null,
  2,
);

export const DynamicApiPanel: React.FC<DynamicApiPanelProps> = React.memo(
  (props) => {
    const [trajectoryJson, setTrajectoryJson] = useState(DEFAULT_TRAJECTORY);
    const [jsonError, setJsonError] = useState("");

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
            <label>目标生成级别 (1-10级全支持 · 可多级叠加)</label>
            <div className="btn-row" style={{ flexWrap: "wrap", gap: 4 }}>
              {([4, 5, 6, 7, 8, 9, 10] as GridLevel[]).map((lv) => {
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

          {jsonError && <div className="alert-banner danger">{jsonError}</div>}

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
    );
  },
);
