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
  /** 当前已启用的组件 id；不在里面的包即使被摆放了也不该渲染 */
  installedIds: Set<string>;
  onDropWidget: (event: React.DragEvent) => void;
}

export function Canvas({ records, installedIds, onDropWidget }: CanvasProps) {
  const placements = useLattice((state) => state.placements);
  const snapToGrid = useLattice((state) => state.snapToGrid);
  const select = useLattice((state) => state.select);
  const hasInstalled = installedIds.size > 0;

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
          <div className="lattice-empty-art" aria-hidden />
          {hasInstalled ? (
            <>
              <p className="lattice-empty-title">The desktop is still empty</p>
              <p className="lattice-empty-hint">
                Drag one from the library, or just click a widget card
              </p>
            </>
          ) : (
            <>
              <p className="lattice-empty-title">Empty — exactly as intended</p>
              <p className="lattice-empty-hint">
                The platform ships with no widgets. Install a pack on the left, or drop your own into the widgets/ folder.
              </p>
            </>
          )}
        </div>
      )}

      {placements.map((placement) => {
        const record = records.get(placement.widgetId);
        const live = record && installedIds.has(record.manifest.id);
        if (!live) {
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
                <span className="lattice-broken-title">
                  {record ? "Widget not installed" : "Widget missing"}
                </span>
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
