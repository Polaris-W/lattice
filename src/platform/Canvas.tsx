/**
 * 棂 / Lattice —— 桌面画布
 *
 * 主窗口里的这块区域是"桌面预览"：所见即桌面上摆出来的样子。
 * 拖拽、缩放、层级、穿透都在这里落到 Placement 上。
 */

import { useCallback, useRef, useState } from "react";
import { useLattice } from "./store";
import { WidgetFrame } from "./WidgetFrame";
import type { AlignResult } from "../runtime/align-guides";
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

  /*
   * 对齐参考线只活在这一层。
   *
   * 不放 store 里有两个原因：它每帧都变（store 一变就整份 `state.json` 落盘，
   * 拖一次组件等于写几百次盘），而且它不属于"用户摆好的布局" —— 松手就该没了。
   */
  const [guides, setGuides] = useState<AlignResult | null>(null);
  const onGuides = useCallback((next: AlignResult | null) => setGuides(next), []);
  const canvasRef = useRef<HTMLDivElement>(null);

  /*
   * 参考线的长度要覆盖**整块内容**，不是一屏。
   *
   * 画布是 `overflow: auto` 的，绝对定位的子元素以内容左上角为原点：写
   * `bottom: 0` 只能画到视口底边，往下滚之后线就跑到上面去了。所以按
   * `scrollHeight` 给长度。读 ref 是在渲染里做的一次性测量 —— 线的出现本来
   * 就伴随着一次 setState，不会因此多渲染一轮。
   */
  const spanW = canvasRef.current?.scrollWidth ?? 0;
  const spanH = canvasRef.current?.scrollHeight ?? 0;

  return (
    <div
      ref={canvasRef}
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
      {guides?.xs.map((x) => (
        <div
          key={`x${x}`}
          className="lattice-guide is-v"
          style={{ left: x, height: spanH || undefined }}
          aria-hidden
        />
      ))}
      {guides?.ys.map((y) => (
        <div
          key={`y${y}`}
          className="lattice-guide is-h"
          style={{ top: y, width: spanW || undefined }}
          aria-hidden
        />
      ))}
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
        return (
          <WidgetFrame
            key={placement.instanceId}
            record={record}
            placement={placement}
            onGuides={onGuides}
          />
        );
      })}
    </div>
  );
}
