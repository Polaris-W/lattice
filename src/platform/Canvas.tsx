/**
 * 棂 / Lattice —— 桌面画布
 *
 * 主窗口里的这块区域是"桌面预览"：所见即桌面上摆出来的样子。
 * 拖拽、缩放、层级、穿透都在这里落到 Placement 上。
 */

import { useLattice } from "./store";
import { WidgetFrame } from "./WidgetFrame";
import type { WidgetRecord } from "../runtime/registry";

interface CanvasProps {
  records: Map<string, WidgetRecord>;
  onDropWidget: (event: React.DragEvent) => void;
}

export function Canvas({ records, onDropWidget }: CanvasProps) {
  const placements = useLattice((state) => state.placements);
  const snapToGrid = useLattice((state) => state.snapToGrid);
  const select = useLattice((state) => state.select);

  return (
    <div
      className={`lattice-canvas${snapToGrid ? " has-grid" : ""}`}
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) select(null);
      }}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={onDropWidget}
    >
      {placements.length === 0 && (
        <div className="lattice-empty">
          <p className="lattice-empty-title">桌面还是空的</p>
          <p className="lattice-empty-hint">
            从左侧组件库拖一个到画布，或者直接点击组件卡片
          </p>
        </div>
      )}

      {placements.map((placement) => {
        const record = records.get(placement.widgetId);
        if (!record) {
          return (
            <div
              key={placement.instanceId}
              className="lattice-widget is-broken"
              style={{
                left: placement.x,
                top: placement.y,
                width: placement.w,
                height: placement.h,
              }}
            >
              <div className="lattice-broken-body">
                <span className="lattice-broken-title">组件缺失</span>
                <code className="lattice-mono">{placement.widgetId}</code>
              </div>
            </div>
          );
        }
        return <WidgetFrame key={placement.instanceId} record={record} placement={placement} />;
      })}
    </div>
  );
}
