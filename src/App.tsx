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
  light: "Light",
  dark: "Dark",
  system: "System",
};

function nextTheme(current: ThemeMode): ThemeMode {
  return THEME_CYCLE[(THEME_CYCLE.indexOf(current) + 1) % THEME_CYCLE.length];
}

/**
 * 给 IPC 调用加一道超时。
 *
 * 平时用不上，但一旦 invoke 的响应丢了（实测过：主窗口闲置一段时间后
 * 走 IPC 自定义协议的 fetch 会 `Failed to fetch`，退到 postMessage 之后
 * 长命令的响应就再也不回来了），`desktopBusy` 会永远停在 true ——
 * 那颗按钮从此是灰的，用户除了重启没别的办法。
 *
 * 超时只是让界面能恢复，不代表 Rust 那边真的停了：所以超时之后不要
 * 立刻再发一次同步，先让人看见报错。
 */
function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} did not answer within ${ms / 1000}s`)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
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

/**
 * 组件目录里有文件变了（`watch.rs` 发过来的）。
 *
 * 载荷里带的是相对路径，但主窗口只用它当"有事发生了"的信号 —— 它要重读的
 * 是清单，而清单可能被改的就是任意一个文件。真正按路径过滤的是宿主页那边
 * （只有自己那份文件变了才重载），见 `widgetHost.ts`。
 */
interface WidgetsChangedEvent {
  files: string[];
}

/** 渲染进程整个挂掉（`crash.rs`）。`gaveUp` 为真表示自动重载已经放弃了 */
interface CrashEvent {
  instanceId: string;
  kind: "render" | "gpu" | "browser" | "unresponsive" | "other";
  gaveUp: boolean;
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
  const configs = useLattice((state) => state.configs);
  const libraryOpen = useLattice((state) => state.libraryOpen);
  const inspectorOpen = useLattice((state) => state.inspectorOpen);
  const setPanelOpen = useLattice((state) => state.setPanelOpen);
  const setDesktopRect = useLattice((state) => state.setDesktopRect);
  const updatePlacement = useLattice((state) => state.updatePlacement);
  const removePlacement = useLattice((state) => state.removePlacement);
  const lastClosed = useLattice((state) => state.lastClosed);
  const restoreLastClosed = useLattice((state) => state.restoreLastClosed);
  const dismissLastClosed = useLattice((state) => state.dismissLastClosed);
  const setPaused = useLattice((state) => state.setPaused);
  const [desktopBusy, setDesktopBusy] = useState(false);
  /** 安装结果提示：成功会自己消失，失败留着让人看清 */
  const [notice, setNotice] = useState<InstallNotice | null>(null);
  /**
   * 崩溃后放弃自动恢复的那个组件。
   *
   * 只有 `gaveUp` 的才记 —— 前三次崩溃由 Rust 静默重载，每次都弹一条提示
   * 等于把"偶发一次 GPU 进程重启"变成骚扰。连着崩三次说明这个组件真的坏了，
   * 那时才值得占用户一行屏幕。
   */
  const [crash, setCrash] = useState<CrashEvent | null>(null);

  useEffect(() => {
    if (notice?.kind !== "ok") return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  // 撤销条只活 8 秒。按 `at` 重置计时：连删两个组件时，第二条要重新给满时间
  useEffect(() => {
    if (!lastClosed) return;
    const timer = setTimeout(() => dismissLastClosed(), 8000);
    return () => clearTimeout(timer);
  }, [lastClosed, dismissLastClosed]);

  const records = useMemo(() => new Map(widgets.map((item) => [item.manifest.id, item])), [widgets]);

  /**
   * 崩溃提示里要写的那个名字。
   *
   * 从 instanceId 反查 placement 再查清单 —— 事件里只有 instanceId，而用户
   * 认得的是"便签"这两个字，不是 `lattice.note@a1b2`。
   */
  const crashName = useMemo(() => {
    if (!crash) return "";
    const widgetId = placements.find((item) => item.instanceId === crash.instanceId)?.widgetId;
    return (widgetId ? records.get(widgetId)?.manifest.name : "") || widgetId || crash.instanceId;
  }, [crash, placements, records]);

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
   * 崩溃之后手动再试一次。
   *
   * 先把提示条收掉再发命令：这条提示说的是"已经不打算再重载了"，点完
   * 之后它就不再成立 —— 留着它，用户会以为没点着。
   *
   * 注意 Rust 那边的崩溃计数不会因为这一次重置：如果它加载起来立刻又崩，
   * 会直接落到"放弃"那一支，而不是再给三次机会。这是对的 —— 连着崩三次
   * 之后手动重试仍然崩，说明文件本身有问题，多试几次只是多闪几下白屏。
   */
  const retryCrash = useCallback(async () => {
    if (!crash) return;
    const target = crash.instanceId;
    setCrash(null);
    try {
      await invoke("widget_reload", { instanceId: target });
    } catch (error) {
      setNotice({ kind: "error", text: `Could not reload the widget: ${String(error)}` });
    }
  }, [crash]);

  /*
   * 暂停状态在 Rust 那边（托盘菜单是主入口），这里补一次初始值。
   *
   * 正常情况下 `lattice:paused` 事件已经把状态送过来了，但主窗口被藏起来
   * 一段时间之后重新打开，事件早就过去了 —— 不补这一句，设置里那个开关
   * 会显示"没暂停"，而桌面上的组件其实全藏着。
   */
  useEffect(() => {
    if (!isTauri()) return;
    void invoke<boolean>("widgets_paused")
      .then(setPaused)
      .catch(() => {});
  }, [setPaused]);

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
    // 组件目录里有人动了文件（编辑器存盘、手工拷进去、脚本生成）。
    // 重读一遍清单：新增的包要出现在组件库里，删掉的要消失，
    // 改了 manifest 的尺寸/权限要跟着变
    bind<WidgetsChangedEvent>("lattice:widgets-changed", () => {
      void refresh();
    });
    // 托盘菜单也能暂停/恢复，主窗口得跟着变 —— 否则设置里那个开关是死的
    bind<{ paused: boolean }>("lattice:paused", (payload) => {
      setPaused(payload.paused);
    });
    // 崩溃已经自动重载的不打扰用户（只有连着崩才值得说一句）
    bind<CrashEvent>("lattice:widget-crashed", (payload) => {
      if (payload.gaveUp) setCrash(payload);
    });

    return () => {
      disposed = true;
      for (const dispose of disposers) dispose();
    };
  }, [refresh, removePlacement, setDesktopRect, setPaused, updatePlacement]);

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

  /**
   * 启动时把组件放回桌面。
   *
   * 上次退出时是运行态（`desktopMode` 已持久化），而且用户没关掉
   * "Restore widgets on launch"，就在这里把窗口重建一遍。
   *
   * 三个前提缺一不可：
   *   - 状态已水合（否则 placements 还是空的，同步会把窗口全关掉）
   *   - 清单已读到（records 为空时 buildSpecs 会跳过所有实例）
   *   - 画布上真有组件
   *
   * 刻意**不**最小化主窗口：开机就把窗口藏起来，用户会以为应用没打开。
   * 画布和桌面组件同时在场，什么时候收主窗口交给用户。
   */
  useEffect(() => {
    if (!isTauri()) return;
    if (records.size === 0) return;

    const restore = () => {
      const state = useLattice.getState();
      if (!state.desktopMode) return;
      if (!state.restoreOnLaunch || state.placements.length === 0) {
        // 用户关掉了自动恢复：这一轮就当设计态，别让按钮一直写着 "Bring back"
        setDesktopMode(false);
        return;
      }
      void withTimeout(
        syncDesktop(
          buildSpecs(state.placements, records, state.grants, state.desktopRects, state.configs),
        ),
        20000,
        "Restoring desktop widgets",
      ).catch((error) => {
        setErrors((prev) => [...prev, { dir: "(restore)", message: String(error) }]);
      });
    };

    if (useLattice.persist.hasHydrated()) {
      restore();
      return;
    }
    return useLattice.persist.onFinishHydration(restore);
  }, [records, setDesktopMode]);

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
            failed.push(`"${id}" collides with a bundled widget id — rename it and try again`);
            continue;
          }
          installWidget(id);
          installed.push(id);
        } catch (error) {
          const message = String(error);
          // 「不是组件目录」是拖错了，不是出错，不必打扰
          if (message.includes("Not a widget folder")) continue;
          failed.push(message);
        }
      }

      if (installed.length > 0) await refresh();

      if (failed.length > 0) {
        setNotice({ kind: "error", text: failed.join("; ") });
      } else if (installed.length > 0) {
        setNotice({
          kind: "ok",
          text: `Installed ${installed.join(", ")} — click a card to place it on the canvas`,
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
      setNotice({ kind: "error", text: `Could not open the widgets folder: ${String(error)}` });
    }
  }, []);

  const toggleDesktop = useCallback(async () => {
    if (!isTauri()) return;
    setDesktopBusy(true);
    try {
      if (desktopMode) {
        await withTimeout(closeDesktop(), 10000, "Bringing widgets back");
        setDesktopMode(false);
      } else {
        const state = useLattice.getState();
        await withTimeout(
          syncDesktop(
          buildSpecs(state.placements, records, state.grants, state.desktopRects, state.configs),
        ),
          20000,
          "Sending widgets to the desktop",
        );
        setDesktopMode(true);
        // 让位这一步不阻塞按钮：最小化偶尔会慢一拍，不该把 busy 卡在这里
        void minimizeMain().catch(() => {});
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
      void syncDesktop(buildSpecs(placements, records, grants, desktopRects, configs)).catch((error) => {
        setErrors((prev) => [...prev, { dir: "(desktop)", message: String(error) }]);
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [desktopMode, placements, records, grants, desktopRects, configs]);

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
          <span className="lattice-brand-name">Lattice</span>
          <span className="lattice-brand-sub">widgets</span>
        </div>

        <div className="lattice-topbar-actions">
          <span className="lattice-stat">
            <span className="lattice-stat-dot" aria-hidden />
            <b>{placements.length}</b> on canvas · <b>{installedSet.size}</b> installed
          </span>

          <button
            type="button"
            className={`lattice-btn${desktopMode ? " is-active" : " is-primary"}`}
            onClick={() => void toggleDesktop()}
            disabled={!isTauri() || desktopBusy}
            title={
              isTauri()
                ? "Turn canvas widgets into real desktop windows; the main window will step aside"
                : "Not available in browser preview — run npm run tauri:dev"
            }
          >
            {desktopMode ? "Bring back" : "Send to desktop"}
          </button>

          <button
            type="button"
            className="lattice-icon-btn is-large"
            onClick={() => setTheme(nextTheme(theme))}
            title={`Theme: ${THEME_LABEL[theme]} — click for ${THEME_LABEL[nextTheme(theme)]}`}
            aria-label={`Theme: ${THEME_LABEL[theme]}`}
          >
            <ThemeGlyph mode={theme} />
          </button>

          <button
            type="button"
            className={`lattice-icon-btn is-large${loading ? " is-spinning" : ""}`}
            onClick={() => void refresh()}
            title="Rescan the widgets folder"
            aria-label="Refresh widgets"
          >
            <Glyph d={ICON.refresh} />
          </button>

          <SettingsMenu
            installedCount={installedSet.size}
            placementCount={placements.length}
            onQuit={() => {
              if (isTauri()) void invoke("quit_app");
            }}
          />
        </div>
      </header>

      <main
        className={[
          "lattice-main",
          libraryOpen ? "" : "is-left-collapsed",
          inspectorOpen ? "" : "is-right-collapsed",
        ]
          .filter(Boolean)
          .join(" ")}
      >
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
          open={libraryOpen}
          onToggle={() => setPanelOpen("library", !libraryOpen)}
        />
        <Canvas records={records} installedIds={installedSet} onDropWidget={onDropWidget} />
        <InspectorPanel
          records={records}
          open={inspectorOpen}
          onToggle={() => setPanelOpen("inspector", !inspectorOpen)}
        />
      </main>

      {/*
        删除是可以反悔的。
        两颗 ✕ 都是不可逆删除，而它们只有 22×22、还挂在会淡入的窗饰上 ——
        手滑一次用户的布局就少一块。删的时候 store 留了快照，这里弹 8 秒。

        两条提示都塞进同一个底部容器：它们可能同时在场（删了一个、另一个正好崩了），
        各自 fixed 会叠在一起。
      */}
      <div className="lattice-toasts">
        {/*
          连着崩了三次、Rust 那边已经不再自动重载的组件。
          这不是"提醒一下"：它的窗口现在是一块白板，不告诉用户就只能干看着。
          也不给"删掉"这种选项 —— 大部分情况下改完文件点一下重试就好了，
          真要删，画布上那颗 ✕ 一直都在。
        */}
        {crash ? (
          <div className="lattice-crash" role="alert">
            <span className="lattice-crash-text">
              <b>{crashName}</b> keeps crashing — its window stopped reloading.
            </span>
            <button type="button" className="lattice-crash-action" onClick={() => void retryCrash()}>
              Try again
            </button>
            <button
              type="button"
              className="lattice-undo-dismiss"
              onClick={() => setCrash(null)}
              title="Dismiss"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ) : null}

        {lastClosed ? (
          <div className="lattice-undo" role="status">
            <span className="lattice-undo-text">
              Removed <b>{records.get(lastClosed.placement.widgetId)?.manifest.name ?? lastClosed.placement.widgetId}</b>
            </span>
            <button type="button" className="lattice-undo-action" onClick={restoreLastClosed}>
              Undo
            </button>
            <button
              type="button"
              className="lattice-undo-dismiss"
              onClick={dismissLastClosed}
              title="Dismiss"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
