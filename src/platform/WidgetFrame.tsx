/**
 * 棂 / Lattice —— 组件宿主
 *
 * 一个组件实例 = 一个沙箱 iframe。
 * 这里做三件事：加载入口、接桥请求、把主题变化推给组件。
 *
 * v0.2 把 iframe 换成独立的 Tauri WebviewWindow 时，
 * 只需替换渲染部分，桥的协议与权限校验完全不用改。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  BRIDGE_TAG,
  handleBridgeRequest,
  isBridgeRequest,
  readThemeTokens,
  type BridgeResponseMessage,
} from "../runtime/bridge";
import { PERMISSION_LABELS, type Permission } from "../runtime/manifest";
import { normalizeAppearance } from "../runtime/appearance";
import { resolveConfig } from "../runtime/config";
import { createScheduler } from "../runtime/schedule";
import {
  ERROR_KIND_LABEL,
  errorSignature,
  isWidgetErrorReport,
  pickPrimary,
  type WidgetErrorReport,
} from "../runtime/diagnostics";
import { isTauri, type WidgetRecord } from "../runtime/registry";
import { isWidgetLog, trace } from "../runtime/debug";
import { WidgetIconMark } from "./icons";
import { snap, useLattice, type Placement } from "./store";

/** 画布上最多记几条。这里只显示一条，其余靠 +N 提示，不需要留太多 */
const MAX_CANVAS_ERRORS = 6;

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

  /*
   * 这个实例的配置。
   *
   * 只存"改过的键"，缺的用清单里的出厂值补 —— 合并交给 `resolveConfig`，
   * 这样画布和桌面两个宿主拿到的是同一份规则，不会一个补默认值一个不补。
   */
  const configOverrides = useLattice((state) => state.configs[placement.instanceId]);
  const config = useMemo(
    () => resolveConfig(record.manifest.config, configOverrides),
    [record.manifest.config, configOverrides],
  );

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

  /*
   * 组件报上来的错。换一份 iframe（授权变了、手动重载）就清空 ——
   * 不清的话旧错误会挂在新内容上面，看着像还没修好。
   */
  const [errors, setErrors] = useState<WidgetErrorReport[]>([]);
  useEffect(() => setErrors([]), [reloadKey]);

  /*
   * 授权变了，卡片上那句 "Needs …" 也得跟着走。
   *
   * `missing` 是组件撞到 `permission_denied` 时记下的，以前只有点卡片上那颗
   * `Grant` 才会清 —— 用户改去属性面板勾上同一项，提示就一直挂在那儿，明明
   * 已经能用了。这里按最新授权过滤一遍：已经有的划掉，仍然缺的留着。
   */
  useEffect(() => {
    const grantedNow = new Set(grants ?? []);
    setMissing((prev) => {
      const next = prev.filter((permission) => !grantedNow.has(permission));
      return next.length === prev.length ? prev : next;
    });
  }, [grantSignature]);

  // 权限会在运行期被用户改动，用 ref 让监听器始终读到最新值
  const grantedRef = useRef<ReadonlySet<Permission>>(new Set());
  grantedRef.current = new Set(grants ?? []);

  /** 配置同理：属性面板改一下就换一份，桥每次调用读最新的 */
  const configRef = useRef(config);
  configRef.current = config;

  const post = useCallback((payload: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(payload, "*");
  }, []);

  /*
   * 画布上的每个组件实例也有一条自己的时间轴。
   *
   * 主窗口最小化时整个文档变成 hidden，`createScheduler` 内部会把定时器
   * 停掉 —— 这正是"不可见就暂停"要的效果：桌面上还摆着的组件照常跳，
   * 画布里的这些不跳。
   */
  const scheduler = useMemo(() => createScheduler(post), [post]);

  /** 换一份 iframe（重载 / 授权变化 / 实例被删）就把旧订阅作废 */
  useEffect(() => {
    scheduler.reset();
    return () => scheduler.reset();
  }, [scheduler, reloadKey]);

  // 桥：来源窗口校验 → 权限校验 → 回话
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;

      const data = event.data as Record<string, unknown> | null;

      /*
       * 组件自己抛的错。桌面窗口那边由协议层注入的脚本报上来，
       * 画布这一份 iframe 走的是同一个入口地址，所以同样会报 ——
       * 以前这里没有读者，错误就静默丢了。
       */
      if (isWidgetErrorReport(data)) {
        const signature = errorSignature(data);
        setErrors((prev) =>
          prev.some((item) => errorSignature(item) === signature)
            ? prev
            : [...prev, data].slice(-MAX_CANVAS_ERRORS),
        );
        return;
      }

      /*
       * 组件的 console。画布这一份和桌面窗口那一份由同一段注入脚本转发，
       * 所以这里也要收 —— 否则"在设计态里调组件"反而看不到它的日志。
       */
      if (isWidgetLog(data)) {
        const level = String((data.payload as { level?: unknown })?.level ?? "log");
        trace({
          kind: "log",
          widgetId: record.manifest.id,
          instanceId: placement.instanceId,
          name: level,
          ok: level !== "error",
          ms: 0,
          text: String((data.payload as { text?: unknown })?.text ?? ""),
        });
        return;
      }

      if (data && data[BRIDGE_TAG] === 1 && data.type === "ready") {
        post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
        return;
      }
      if (!isBridgeRequest(data)) return;

      void handleBridgeRequest(data, {
        instanceId: placement.instanceId,
        widgetId: record.manifest.id,
        granted: grantedRef.current,
        config: configRef.current,
        schedule: scheduler,
        reply: (payload: BridgeResponseMessage) => {
          const denied = payload.code === "permission_denied" ? payload.permission : undefined;
          if (denied) {
            setMissing((prev) => (prev.includes(denied) ? prev : [...prev, denied]));
          }
          post(payload);
        },
        close: () => remove(placement.instanceId),
        trace: (entry) => {
          trace({
            kind: "call",
            widgetId: record.manifest.id,
            instanceId: placement.instanceId,
            name: entry.method,
            ok: entry.ok,
            ms: entry.ms,
            text: entry.text ?? entry.code ?? "",
          });
        },
      });
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [placement.instanceId, record.manifest.id, post, remove, scheduler]);

  // 主题切换时主动通知组件，避免组件各自去猜明暗
  useEffect(() => {
    post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
  }, [theme, post]);

  /*
   * 配置变了，推一份给组件。
   *
   * 组件启动时会 `config.get` 读一次，但用户接着在属性面板里拨开关时它不会
   * 自己知道 —— 那条路只有这个推送。不重载 iframe 是刻意的：配置是"调参"，
   * 不是"换权限"，重载会把组件里没落盘的草稿一起冲掉。
   */
  useEffect(() => {
    post({ [BRIDGE_TAG]: 1, type: "config-changed", payload: { config } });
  }, [config, post]);

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

  /*
   * 画布上的底板预览。
   *
   * 画布没有壁纸可采样，所以只能算"底色盖在主题底色上"的合成色 —— 模糊和
   * 壁纸纹理都欠奉，只是让拖滑杆时能立刻看到颜色变了，别对着一个不动的卡片调。
   * 用 color-mix 而不是在 JS 里算：主题一换，CSS 自己就跟着重算，没有读不到
   * 新值的时序问题；浏览器不支持这条声明时会被丢掉，退回原来的主题底色。
   */
  const appearance = normalizeAppearance(placement.appearance ?? record.manifest.appearance);
  const previewBackdrop =
    appearance.tint === "auto"
      ? undefined
      : `color-mix(in srgb, ${appearance.tint} ${Math.round(appearance.alpha * 100)}%, var(--lattice-surface))`;

  const primaryError = pickPrimary(errors);
  const otherErrors = primaryError ? errors.filter((item) => item !== primaryError) : [];

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
        background: previewBackdrop,
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
        {record.iconUrl && <WidgetIconMark url={record.iconUrl} size={12} />}
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

      {primaryError && (
        /*
         * 绝对定位，不挤 iframe：组件该占多大还是多大，报错不该改变它自己的布局。
         * 画布上只给一行 —— 完整的堆栈在桌面窗口那张卡里，这里够判断"是不是它炸了"。
         */
        <div
          className="lattice-widget-error"
          title={[
            `${ERROR_KIND_LABEL[primaryError.kind]}: ${primaryError.message}`,
            primaryError.where,
            ...otherErrors.map((item) => `${ERROR_KIND_LABEL[item.kind]}: ${item.message}`),
          ]
            .filter(Boolean)
            .join("\n")}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <span className="lattice-widget-error-kind">{ERROR_KIND_LABEL[primaryError.kind]}</span>
          <span className="lattice-widget-error-message">{primaryError.message}</span>
          {otherErrors.length > 0 && (
            <span className="lattice-widget-error-more">+{otherErrors.length}</span>
          )}
          <button
            type="button"
            className="lattice-widget-error-reload"
            title="Reload widget"
            onClick={() => setReloadKey((value) => value + 1)}
          >
            Reload
          </button>
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
