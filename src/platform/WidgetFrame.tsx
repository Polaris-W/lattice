/**
 * 棂 / Lattice —— 组件宿主
 *
 * 一个组件实例 = 一个沙箱 iframe。
 * 这里做三件事：加载入口、接桥请求、把主题变化推给组件。
 *
 * v0.2 把 iframe 换成独立的 Tauri WebviewWindow 时，
 * 只需替换渲染部分，桥的协议与权限校验完全不用改。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  BRIDGE_TAG,
  handleBridgeRequest,
  isBridgeRequest,
  readThemeTokens,
  type BridgeResponseMessage,
} from "../runtime/bridge";
import { PERMISSION_LABELS, type Permission } from "../runtime/manifest";
import { isTauri, type WidgetRecord } from "../runtime/registry";
import { snap, useLattice, type Placement } from "./store";

interface WidgetFrameProps {
  record: WidgetRecord;
  placement: Placement;
}

export function WidgetFrame({ record, placement }: WidgetFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const selected = useLattice((state) => state.selectedInstanceId === placement.instanceId);
  const grants = useLattice((state) => state.grants[record.manifest.id]);
  const theme = useLattice((state) => state.theme);
  const select = useLattice((state) => state.select);
  const remove = useLattice((state) => state.removePlacement);
  const update = useLattice((state) => state.updatePlacement);
  const grant = useLattice((state) => state.grant);

  /** 组件撞到未授权的权限时记在这里，就地提示，不用去右边面板翻 */
  const [missing, setMissing] = useState<Permission[]>([]);

  /**
   * 权限集合变化后重挂 iframe，让组件重新走一遍初始化。
   * 不这么做的话，组件在授权前就把"权限被拒"写进了自己的状态，
   * 用户点完授权界面上还是旧样子 —— 组件没法知道权限变了。
   */
  const [reloadKey, setReloadKey] = useState(0);
  const grantSignature = [...(grants ?? [])].sort().join(",");
  const lastSignature = useRef(grantSignature);
  useEffect(() => {
    if (lastSignature.current === grantSignature) return;
    lastSignature.current = grantSignature;
    setReloadKey((value) => value + 1);
  }, [grantSignature]);

  // 权限会在运行期被用户改动，用 ref 让监听器始终读到最新值
  const grantedRef = useRef<ReadonlySet<Permission>>(new Set());
  grantedRef.current = new Set(grants ?? []);

  const post = useCallback((payload: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(payload, "*");
  }, []);

  // 桥：来源窗口校验 → 权限校验 → 回话
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;

      const data = event.data as Record<string, unknown> | null;
      if (data && data[BRIDGE_TAG] === 1 && data.type === "ready") {
        post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
        return;
      }
      if (!isBridgeRequest(data)) return;

      void handleBridgeRequest(data, {
        instanceId: placement.instanceId,
        widgetId: record.manifest.id,
        granted: grantedRef.current,
        reply: (payload: BridgeResponseMessage) => {
          const denied = payload.code === "permission_denied" ? payload.permission : undefined;
          if (denied) {
            setMissing((prev) => (prev.includes(denied) ? prev : [...prev, denied]));
          }
          post(payload);
        },
        close: () => remove(placement.instanceId),
      });
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [placement.instanceId, record.manifest.id, post, remove]);

  // 主题切换时主动通知组件，避免组件各自去猜明暗
  useEffect(() => {
    post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
  }, [theme, post]);

  /*
   * 组件存储被**别的实例**改了，转告这个 iframe。
   *
   * 同一个组件在画布上和桌面上各有一份内存副本，不转发的话两边各写各的：
   * 桌面那边加了两条，画布这边还是旧列表，随便动一下就把那两条写没了。
   * 事件由 Rust 在每次落盘后广播（见 widget_store.rs）。
   */
  useEffect(() => {
    if (!isTauri()) return;
    let dispose: (() => void) | undefined;
    let disposed = false;

    void listen<{ widgetId: string; key: string }>("lattice:widget-store", (event) => {
      if (event.payload.widgetId !== record.manifest.id) return;
      post({
        [BRIDGE_TAG]: 1,
        type: "store-changed",
        payload: { key: event.payload.key },
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else dispose = unlisten;
    });

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [post, record.manifest.id]);

  // ---- 拖动 ----
  const dragState = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(
    null,
  );

  const onDragStart = (event: React.PointerEvent) => {
    event.preventDefault();
    select(placement.instanceId);
    dragState.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: placement.x,
      originY: placement.y,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onDragMove = (event: React.PointerEvent) => {
    const state = dragState.current;
    if (!state) return;
    const { snapToGrid } = useLattice.getState();
    update(placement.instanceId, {
      x: snap(Math.max(0, state.originX + (event.clientX - state.startX)), snapToGrid),
      y: snap(Math.max(0, state.originY + (event.clientY - state.startY)), snapToGrid),
    });
  };

  const onDragEnd = (event: React.PointerEvent) => {
    dragState.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  };

  // ---- 缩放 ----
  const resizeState = useRef<{
    startX: number;
    startY: number;
    originW: number;
    originH: number;
  } | null>(null);

  const onResizeStart = (event: React.PointerEvent) => {
    event.preventDefault();
    event.stopPropagation();
    select(placement.instanceId);
    resizeState.current = {
      startX: event.clientX,
      startY: event.clientY,
      originW: placement.w,
      originH: placement.h,
    };
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  };

  const onResizeMove = (event: React.PointerEvent) => {
    const state = resizeState.current;
    if (!state) return;
    const { minW, minH } = record.manifest.size;
    const { snapToGrid } = useLattice.getState();
    update(placement.instanceId, {
      w: Math.max(minW, snap(state.originW + (event.clientX - state.startX), snapToGrid)),
      h: Math.max(minH, snap(state.originH + (event.clientY - state.startY), snapToGrid)),
    });
  };

  const onResizeEnd = (event: React.PointerEvent) => {
    resizeState.current = null;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  };

  return (
    <div
      className={`lattice-widget${selected ? " is-selected" : ""}${
        placement.layer === "top" ? " is-top" : ""
      }`}
      style={{
        left: placement.x,
        top: placement.y,
        width: placement.w,
        height: placement.h,
      }}
      onPointerDown={() => select(placement.instanceId)}
    >
      <div
        className="lattice-widget-bar"
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        title="Drag to move"
      >
        <span className="lattice-widget-title">{record.manifest.name}</span>
        <span className={`lattice-chip${placement.layer === "top" ? " is-accent" : ""}`}>
          {placement.layer === "top" ? "On top" : "Desktop"}
        </span>
      </div>

      {record.entryUrl ? (
        <iframe
          key={reloadKey}
          ref={iframeRef}
          className="lattice-widget-frame"
          title={record.manifest.name}
          src={record.entryUrl}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          style={{ pointerEvents: placement.clickThrough ? "none" : "auto" }}
        />
      ) : (
        <div className="lattice-pending">
          <span className="lattice-pending-title">Entry URL is empty</span>
          <p className="lattice-hint">The manifest entry could not be resolved — check manifest.json.</p>
          <code className="lattice-mono lattice-path">{record.dir}</code>
        </div>
      )}

      {missing.length > 0 && missing[0] !== undefined && (
        <div className="lattice-perm-prompt">
          <span className="lattice-perm-prompt-text">
            Needs {PERMISSION_LABELS[missing[0]]}
            {missing.length > 1 ? ` +${missing.length - 1} more` : ""}
          </span>
          <button
            type="button"
            className="lattice-btn is-small is-primary"
            onClick={(event) => {
              event.stopPropagation();
              // 一次给全，不然组件会一项一项撞过来，用户要点好几次
              for (const permission of missing) grant(record.manifest.id, permission);
              setMissing([]);
            }}
          >
            {missing.length > 1 ? "Grant all" : "Grant"}
          </button>
        </div>
      )}

      {selected && (
        <div
          className="lattice-resize-handle"
          onPointerDown={onResizeStart}
          onPointerMove={onResizeMove}
          onPointerUp={onResizeEnd}
          title="Drag to resize"
        />
      )}
    </div>
  );
}
