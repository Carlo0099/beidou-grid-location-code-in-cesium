import React from "react";
import { BuildingIcon, CubeIcon, GlobeIcon, RouteIcon } from "./Icons";
import { GlobalGridPanel } from "./panels/GlobalGridPanel";
import { FutianVoxelPanel } from "./panels/FutianVoxelPanel";
import { ObstacleAvoidancePanel } from "./panels/ObstacleAvoidancePanel";
import { DynamicApiPanel } from "./panels/DynamicApiPanel";
import type {
  DynamicApiPanelProps,
  FutianVoxelPanelProps,
  GlobalGridPanelProps,
  ObstacleAvoidancePanelProps,
  WorkbenchTab,
} from "./panels/panelTypes";

export type {
  DynamicApiPanelProps,
  FutianVoxelPanelProps,
  GlobalGridPanelProps,
  ObstacleAvoidancePanelProps,
  WorkbenchTab,
};

interface ControlPanelProps {
  activeTab: WorkbenchTab;
  onChangeTab: (tab: WorkbenchTab) => void;
  collapsed: boolean;
  globalPanel: GlobalGridPanelProps;
  futianPanel: FutianVoxelPanelProps;
  obstaclePanel: ObstacleAvoidancePanelProps;
  apiPanel: DynamicApiPanelProps;
}

const WORKBENCH_TABS: Array<{
  id: WorkbenchTab;
  label: string;
  renderIcon: () => React.ReactNode;
}> = [
  { id: "global-local", label: "1.1 全球", renderIcon: () => <GlobeIcon size={13} /> },
  {
    id: "futian-voxel-sim",
    label: "1.2 亿级体素",
    renderIcon: () => <CubeIcon size={13} />,
  },
  {
    id: "airspace-obstacle",
    label: "1.3 避障",
    renderIcon: () => <BuildingIcon size={13} />,
  },
  { id: "dynamic-api", label: "1.4 API", renderIcon: () => <RouteIcon size={13} /> },
];

export const ControlPanel: React.FC<ControlPanelProps> = React.memo((props) => {
  return (
    <aside
      className={`left-workbench glass-panel ${props.collapsed ? "collapsed" : ""}`}
    >
      <nav className="workbench-tabs">
        {WORKBENCH_TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`wb-tab ${props.activeTab === tab.id ? "active" : ""}`}
            onClick={() => props.onChangeTab(tab.id)}
          >
            {tab.renderIcon()}
            {tab.label}
          </button>
        ))}
      </nav>

      <div className="workbench-body">
        {props.activeTab === "global-local" && (
          <GlobalGridPanel {...props.globalPanel} />
        )}
        {props.activeTab === "futian-voxel-sim" && (
          <FutianVoxelPanel {...props.futianPanel} />
        )}
        {props.activeTab === "airspace-obstacle" && (
          <ObstacleAvoidancePanel {...props.obstaclePanel} />
        )}
        {props.activeTab === "dynamic-api" && (
          <DynamicApiPanel {...props.apiPanel} />
        )}
      </div>
    </aside>
  );
});
