/**
 * 棂 / Lattice —— 平台外壳
 *
 * 布局：顶栏（产品 / 主题 / 网格 / 刷新） + 三栏（组件库 · 画布 · 属性）。
 * 这里只做编排，业务都在 platform/ 与 runtime/ 里。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Canvas } from "./platform/Canvas";
import { InspectorPanel } from "./platform/InspectorPanel";
import { LibraryPanel, type InstallNotice } from "./platform/LibraryPanel";
import { buildSpecs, closeDesktop, minimizeMain, syncDesktop } from "./platform/desktop";
import { Glyph, ICON, ThemeGlyph } from "./platform/icons";
import { SettingsMenu } from "./platform/SettingsMenu";
import { nextFreeSlot, useLattice, type ThemeMode } from "./platform/store";
import { isTauri, loadRegistry, type WidgetLoadError, type WidgetRecord } from "./runtime/registry";
import type { WidgetLayer } from "./runtime/manifest";

/** 顶栏那颗按钮的循环顺序：浅色 → 深色 → 跟随系统 → 浅色 */
const THEME_CYCLE: ThemeMode[] = ["light", "dark", "system"];
const THEME_LABEL: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

function nextTheme(current: ThemeMode): ThemeMode {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
}

/** 桌面窗口回传的事件载荷 */
interface RectEvent {
  instanceId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
interface PinnedEvent {
  instanceId: string;
  pinned: boolean;
}
interface LayerEvent {
  instanceId: string;
  layer: WidgetLayer;
}
interface InstanceEvent {
  instanceId: string;
}

export default function App() {
  const [widgets, setWidgets] = useState<WidgetRecord[]>([]);
  const [errors, setErrors] = useState<WidgetLoadError[]>([]);
  const [loading, setLoading] = useState(true);

  const placements = useLattice((state) => state.placements);
  const addPlacement = useLattice((state) => state.addPlacement);
  const installedIds = useLattice((state) => state.installedIds);
  const installWidget = useLattice((state) => state.installWidget);
  const uninstallWidget = useLattice((state) => state.uninstallWidget);
  const theme = useLattice((state) => state.theme);
  const setTheme = useLattice((state) => state.setTheme);
  const grants = useLattice((state) => state.grants);
  const desktopMode = useLattice((state) => state.desktopMode);
  const setDesktopMode = useLattice((state) => state.setDesktopMode);
  const desktopRects = useLattice((state) => state.desktopRects);
  const setDesktopRect = useLattice((state) => state.setDesktopRect);
  const updatePlacement = useLattice((state) => state.updatePlacement);
  const removePlacement = useLattice((state) => state.removePlacement);
  const [desktopBusy, setDesktopBusy] = useState(false);
  /** 安装结果提示：成功会自己消失，失败留着让人看清 */
  const [notice, setNotice] = useState<InstallNotice | null>(null);

  useEffect(() => {
    if (notice?.kind !== "ok") return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const records = useMemo(() => new Map(widgets.map((item) => [item.manifest.id, item])), [widgets]);

  /**
   * 已启用的组件 id。
   * 用户目录里的包由磁盘状态决定（装上去就是装上了），
   * 随应用分发的包必须经过显式安装 —— 平台开箱是空白的。
   */
  const installedSet = useMemo(() => {
    const set = new Set<string>();
    for (const record of widgets) {
      if (record.source === "user" || installedIds.includes(record.manifest.id)) {
        set.add(record.manifest.id);
      }
    }
    return set;
  }, [widgets, installedIds]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await loadRegistry();
      setWidgets(snapshot.widgets);
      setErrors(snapshot.errors);
    } catch (error) {
      setErrors([{ dir: "(registry)", message: String(error) }]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 桌面窗口 → 主窗口的回传通道。
   *
   * 组件窗口是独立 webview，改不了这里的 store。用户在桌面上拖了、缩了、
   * 锁了、换层级了，都由 Rust 转成事件送回来，在这里落到状态里。
   */
  useEffect(() => {
    if (!isTauri()) return;
    const disposers: Array<() => void> = [];
    let disposed = false;

    const bind = <T,>(name: string, handler: (payload: T) => void) => {
      void listen<T>(name, (event) => handler(event.payload)).then((unlisten) => {
        if (disposed) unlisten();
        else disposers.push(unlisten);
      });
    };

    bind<RectEvent>("lattice:widget-rect", (payload) => {
      setDesktopRect(payload.instanceId, {
        x: payload.x,
        y: payload.y,
        w: payload.w,
        h: payload.h,
      });
    });
    bind<PinnedEvent>("lattice:widget-pinned", (payload) => {
      updatePlacement(payload.instanceId, { pinned: payload.pinned });
    });
    bind<LayerEvent>("lattice:widget-layer", (payload) => {
      updatePlacement(payload.instanceId, { layer: payload.layer });
    });
    bind<InstanceEvent>("lattice:widget-close", (payload) => {
      removePlacement(payload.instanceId);
    });

    return () => {
      disposed = true;
      for (const dispose of disposers) dispose();
    };
  }, [removePlacement, setDesktopRect, updatePlacement]);

  // 主题落到 <html data-theme>，CSS 变量与组件都从这里取色
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved: "light" | "dark" =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      root.dataset.theme = resolved;
      // 桌面上的组件窗口是独立 webview，得广播过去才会跟着换色
      if (isTauri()) void invoke("widget_set_theme", { theme: resolved }).catch(() => {});
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const addWidget = useCallback(
    (record: WidgetRecord) => {
      if (!installedSet.has(record.manifest.id)) return;
      const { w, h } = record.manifest.size;
      const slot = nextFreeSlot(useLattice.getState().placements, w, h);
      addPlacement({
        instanceId: `${record.manifest.id}#${crypto.randomUUID().slice(0, 8)}`,
        widgetId: record.manifest.id,
        x: slot.x,
        y: slot.y,
        w,
        h,
        layer: record.manifest.layer,
        clickThrough: false,
        pinned: false,
      });
    },
    [addPlacement, installedSet],
  );

  const install = useCallback(
    (record: WidgetRecord) => {
      installWidget(record.manifest.id);
    },
    [installWidget],
  );

  const installPack = useCallback(
    (records: WidgetRecord[]) => {
      for (const record of records) installWidget(record.manifest.id);
    },
    [installWidget],
  );

  const uninstall = useCallback(
    async (record: WidgetRecord) => {
      // 用户目录里的包是真在磁盘上的，要交给 Rust 删；内置包只是取消启用
      if (record.source === "user" && isTauri()) {
        try {
          await invoke("uninstall_widget", { id: record.manifest.id });
        } catch (error) {
          setErrors((prev) => [...prev, { dir: record.dir, message: String(error) }]);
          return;
        }
        await refresh();
      }
      /*
       * 连同画布上的实例一起撤掉。
       * 只删 id 不删 placement 的话，会留下一个指向不存在组件的幽灵：
       * 它还在 placements 里（顶栏计数多一个），但 records 里查不到，
       * 于是既画不出来也点不到 —— 只能清状态文件才能收拾。
       */
      const { placements: current, removePlacement } = useLattice.getState();
      for (const placement of current) {
        if (placement.widgetId === record.manifest.id) removePlacement(placement.instanceId);
      }
      uninstallWidget(record.manifest.id);
    },
    [refresh, uninstallWidget],
  );

  /**
   * 从磁盘装组件。
   *
   * 没有文件选择框：直接把组件文件夹从资源管理器拖进窗口就行。
   * Tauri 的拖放事件给的是真实路径，正好是 `install_widget` 要的入参。
   * 顺手把拖进来的非组件目录（随便一个文件夹、一个文件）挡掉，
   * 只留一句"不是组件目录"，不往错误列表里灌红字。
   */
  const installFromPaths = useCallback(
    async (paths: string[]) => {
      if (!isTauri() || paths.length === 0) return;
      const installed: string[] = [];
      const failed: string[] = [];
      // 官方组件的 id 不能被用户包顶掉：records 是按 id 索引的，
      // 重名会让官方那个悄悄消失，而且没有任何提示
      const officialIds = new Set(
        widgets.filter((item) => item.source === "bundled").map((item) => item.manifest.id),
      );

      for (const path of paths) {
        try {
          const id = await invoke<string>("install_widget", { sourceDir: path });
          if (officialIds.has(id)) {
            await invoke("uninstall_widget", { id });
            failed.push(`「${id}」和官方组件重名，换个 id 再装`);
            continue;
          }
          installWidget(id);
          installed.push(id);
        } catch (error) {
          const message = String(error);
          // 「不是组件目录」是拖错了，不是出错，不必打扰
          if (message.includes("不是组件目录")) continue;
          failed.push(message);
        }
      }

      if (installed.length > 0) await refresh();

      if (failed.length > 0) {
        setNotice({ kind: "error", text: failed.join("；") });
      } else if (installed.length > 0) {
        setNotice({
          kind: "ok",
          text: `已安装 ${installed.join("、")}，点一下卡片就能放到画布上`,
        });
      }
    },
    [installWidget, refresh, widgets],
  );

  // 拖放由 webview 接管（Tauri 默认 dragDropEnabled），这里只关心"放下了"
  useEffect(() => {
    if (!isTauri()) return;
    let dispose: (() => void) | undefined;
    let disposed = false;

    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        void installFromPaths(event.payload.paths);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else dispose = unlisten;
      })
      .catch((error) => setErrors((prev) => [...prev, { dir: "(drop)", message: String(error) }]));

    return () => {
      disposed = true;
      dispose?.();
    };
  }, [installFromPaths]);

  const openWidgetsDir = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const dir = await invoke<string>("widgets_dir");
      await revealItemInDir(dir);
    } catch (error) {
      setNotice({ kind: "error", text: `打不开组件目录：${String(error)}` });
    }
  }, []);

  const toggleDesktop = useCallback(async () => {
    if (!isTauri()) return;
    setDesktopBusy(true);
    try {
      if (desktopMode) {
        await closeDesktop();
        setDesktopMode(false);
      } else {
        const state = useLattice.getState();
        await syncDesktop(
          buildSpecs(state.placements, records, state.grants, state.desktopRects),
        );
        setDesktopMode(true);
        // 主窗口让位，否则组件全被它挡在后面
        await minimizeMain();
      }
    } catch (error) {
      setErrors((prev) => [...prev, { dir: "(desktop)", message: String(error) }]);
    } finally {
      setDesktopBusy(false);
    }
  }, [desktopMode, records, setDesktopMode]);

  // 运行态下改画布要同步到真窗口；拖动是高频的，攒一下再发
  useEffect(() => {
    if (!desktopMode) return;
    const timer = setTimeout(() => {
      void syncDesktop(buildSpecs(placements, records, grants, desktopRects)).catch((error) => {
        setErrors((prev) => [...prev, { dir: "(desktop)", message: String(error) }]);
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [desktopMode, placements, records, grants, desktopRects]);

  const onDropWidget = useCallback(
    (event: React.DragEvent) => {
      const widgetId = event.dataTransfer.getData("application/x-lattice-widget");
      const record = records.get(widgetId);
      if (!record || !installedSet.has(widgetId)) return;
      event.preventDefault();

      const bounds = event.currentTarget.getBoundingClientRect();
      const { w, h } = record.manifest.size;
      const x = Math.max(0, Math.round(event.clientX - bounds.left - w / 2));
      const y = Math.max(0, Math.round(event.clientY - bounds.top - 12));

      addPlacement({
        instanceId: `${record.manifest.id}#${crypto.randomUUID().slice(0, 8)}`,
        widgetId: record.manifest.id,
        x,
        y,
        w,
        h,
        layer: record.manifest.layer,
        clickThrough: false,
        pinned: false,
      });
    },
    [addPlacement, records, installedSet],
  );

  return (
    <div className="lattice-shell">
      <header className="lattice-topbar">
        <div className="lattice-brand">
          <span className="lattice-brand-mark" aria-hidden />
          <span className="lattice-brand-name">棂</span>
          <span className="lattice-brand-sub">Lattice</span>
        </div>

        <div className="lattice-topbar-actions">
          <span className="lattice-stat">
            <span className="lattice-stat-dot" aria-hidden />
            <b>{placements.length}</b> 个组件 · <b>{installedSet.size}</b> 个已安装
          </span>

          <button
            type="button"
            className={`lattice-btn${desktopMode ? " is-active" : " is-primary"}`}
            onClick={() => void toggleDesktop()}
            disabled={!isTauri() || desktopBusy}
            title={
              isTauri()
                ? "把画布上的组件变成真正的桌面窗口，主窗口会最小化"
                : "浏览器预览里不可用，请用 npm run tauri:dev 启动桌面端"
            }
          >
            {desktopMode ? "收回组件" : "投放到桌面"}
          </button>

          <button
            type="button"
            className="lattice-icon-btn is-large"
            onClick={() => setTheme(nextTheme(theme))}
            title={`外观：${THEME_LABEL[theme]} · 点击切到${THEME_LABEL[nextTheme(theme)]}`}
            aria-label={`外观：${THEME_LABEL[theme]}`}
          >
            <ThemeGlyph mode={theme} />
          </button>

          <button
            type="button"
            className={`lattice-icon-btn is-large${loading ? " is-spinning" : ""}`}
            onClick={() => void refresh()}
            title="重新扫描组件目录"
            aria-label="刷新组件"
          >
            <Glyph d={ICON.refresh} />
          </button>

          <SettingsMenu installedCount={installedSet.size} placementCount={placements.length} />
        </div>
      </header>

      <main className="lattice-main">
        <LibraryPanel
          widgets={widgets}
          installedIds={installedSet}
          errors={errors}
          loading={loading}
          notice={notice}
          onDismissNotice={() => setNotice(null)}
          onOpenWidgetsDir={() => void openWidgetsDir()}
          onAdd={addWidget}
          onInstall={install}
          onInstallPack={installPack}
          onUninstall={(record) => void uninstall(record)}
        />
        <Canvas records={records} installedIds={installedSet} onDropWidget={onDropWidget} />
        <InspectorPanel records={records} />
      </main>
    </div>
  );
}
