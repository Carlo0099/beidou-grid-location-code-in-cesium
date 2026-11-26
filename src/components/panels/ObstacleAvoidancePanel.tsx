import React from "react";
import type { GridLevel } from "../../types/beidou";
import { FLIGHT_PRESETS } from "../../core/SampleCityData";
import {
  BuildingIcon,
  PauseIcon,
  PlayIcon,
  ShieldIcon,
} from "../Icons";
import type { ObstacleAvoidancePanelProps } from "./panelTypes";

export const ObstacleAvoidancePanel: React.FC<ObstacleAvoidancePanelProps> =
  React.memo((props) => {
    return (
      <>
        <div className="panel-card">
          <div className="card-title-row">
            <div className="card-title">
              <BuildingIcon size={14} />
              建筑轮廓提取与空域三维网格化
            </div>
            <button
              type="button"
              className="btn btn-primary"
              style={{ padding: "4px 8px", fontSize: 11 }}
              onClick={props.onReextractBuildings}
              disabled={props.isExtractingBuildings}
            >
              {props.isExtractingBuildings ? "构建中..." : "在当前视区生成"}
            </button>
          </div>

          <div className="btn-row">
            <button
              type="button"
              className="btn btn-emerald"
              style={{ flex: 1, fontSize: 11 }}
              onClick={props.onLoadFutianDemoForAvoidance}
              disabled={props.isExtractingBuildings}
              title="加载本地复制的福田区 3D Tiles 建筑白膜并提取轮廓"
            >
              加载福田 3D Tiles 白膜
            </button>
            <button
              type="button"
              className="btn btn-ghost"
              style={{ flex: 1, fontSize: 11 }}
              onClick={props.onLoadOsmBuildings}
              disabled={!props.hasIonToken}
              title={
                props.hasIonToken
                  ? "加载 Cesium OSM Buildings 全球三维建筑"
                  : "需在 .env 中配置 VITE_CESIUM_ION_TOKEN 后启用"
              }
            >
              {props.hasIonToken ? "Cesium OSM 建筑" : "OSM (需 Token)"}
            </button>
          </div>

          <div className="field-box">
            <label>自定义 3D Tileset URL (可选)</label>
            <div className="btn-row">
              <input
                value={props.customTilesetUrl}
                placeholder="https://.../tileset.json"
                onChange={(e) => props.onChangeCustomTilesetUrl(e.target.value)}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn btn-ghost"
                onClick={props.onLoadCustomTileset}
                disabled={
                  props.isExtractingBuildings || !props.customTilesetUrl.trim()
                }
              >
                提取
              </button>
            </div>
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
                  props.onChangeBuildingLevel(Number(e.target.value) as GridLevel)
                }
              >
                <option value={5}>L5 (4&quot; · ~124m)</option>
                <option value={6}>L6 (2&quot; · ~62m)</option>
                <option value={7}>L7 (0.25&quot; · ~7.7m 精细)</option>
                <option value={8}>L8 (1/32&quot; · ~0.97m 亚米)</option>
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
                +{props.verticalBufferMeters} m / {props.maxAirspaceHeight} m
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
              onClick={() => props.onTogglePickWaypoint(!props.isPickingWaypoint)}
            >
              {props.isPickingWaypoint ? "点击地图加点中..." : "+ 地图选点规划"}
            </button>
            <div className="field-box" style={{ width: 78 }}>
              <input
                type="number"
                value={props.pickWaypointHeight}
                onChange={(e) =>
                  props.onChangePickWaypointHeight(Number(e.target.value) || 80)
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
                  {props.flightAnalysis.summary.totalDistanceMeters} m · 占用{" "}
                  {props.flightAnalysis.summary.totalPathVoxels} 个北斗网格 · 最小净距{" "}
                  {props.flightAnalysis.minClearanceMeters} m
                </>
              ) : (
                <>
                  <strong>⚠ 检测到建筑避障冲突！</strong> 命中{" "}
                  {props.flightAnalysis.summary.conflictCount} 个建筑禁飞体元， 侵入{" "}
                  {props.flightAnalysis.summary.bufferWarningCount} 个缓冲警戒格 (最小净距{" "}
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
              onChange={(e) => props.onToggleShowDetourRoute(e.target.checked)}
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
    );
  });
