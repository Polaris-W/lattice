/**
 * 棂 / Lattice —— 平台外壳
 *
 * 布局：顶栏（产品 / 主题 / 网格 / 刷新） + 三栏（组件库 · 画布 · 属性）。
 * 这里只做编排，业务都在 platform/ 与 runtime/ 里。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Canvas } from "./platform/Canvas";
import { InspectorPanel } from "./platform/InspectorPanel";
import { LibraryPanel } from "./platform/LibraryPanel";
import { buildSpecs, closeDesktop, minimizeMain, syncDesktop } from "./platform/desktop";
import { nextFreeSlot, useLattice, type ThemeMode } from "./platform/store";
import { isTauri, loadRegistry, type WidgetLoadError, type WidgetRecord } from "./runtime/registry";

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
  const snapToGrid = useLattice((state) => state.snapToGrid);
  const toggleSnap = useLattice((state) => state.toggleSnap);
  const grants = useLattice((state) => state.grants);
  const desktopMode = useLattice((state) => state.desktopMode);
  const setDesktopMode = useLattice((state) => state.setDesktopMode);
  const [desktopBusy, setDesktopBusy] = useState(false);

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

  // 主题落到 <html data-theme>，CSS 变量与组件都从这里取色
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved: "light" | "dark" =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      root.dataset.theme = resolved;
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
      uninstallWidget(record.manifest.id);
    },
    [refresh, uninstallWidget],
  );

  const toggleDesktop = useCallback(async () => {
    if (!isTauri()) return;
    setDesktopBusy(true);
    try {
      if (desktopMode) {
        await closeDesktop();
        setDesktopMode(false);
      } else {
        const state = useLattice.getState();
        await syncDesktop(buildSpecs(state.placements, records, state.grants));
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
      void syncDesktop(buildSpecs(placements, records, grants)).catch((error) => {
        setErrors((prev) => [...prev, { dir: "(desktop)", message: String(error) }]);
      });
    }, 120);
    return () => clearTimeout(timer);
  }, [desktopMode, placements, records, grants]);

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
          <span className="lattice-hint lattice-inline-hint">
            {placements.length} 个组件 · {installedSet.size} 个已安装
          </span>

          <button
            type="button"
            className={`lattice-btn${snapToGrid ? " is-active" : ""}`}
            onClick={toggleSnap}
            title="拖动时对齐到 8px 网格"
          >
            网格吸附
          </button>

          <div className="lattice-segmented">
            {(["light", "system", "dark"] as ThemeMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`lattice-segment${theme === mode ? " is-active" : ""}`}
                onClick={() => setTheme(mode)}
              >
                {mode === "light" ? "浅色" : mode === "dark" ? "深色" : "跟随系统"}
              </button>
            ))}
          </div>

          <button
            type="button"
            className={`lattice-btn${desktopMode ? " is-active" : ""}`}
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

          <button type="button" className="lattice-btn" onClick={() => void refresh()}>
            刷新组件
          </button>
        </div>
      </header>

      <main className="lattice-main">
        <LibraryPanel
          widgets={widgets}
          installedIds={installedSet}
          errors={errors}
          loading={loading}
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
