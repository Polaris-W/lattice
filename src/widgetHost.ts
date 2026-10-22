/**
 * 棂 / Lattice —— 桌面组件窗口的宿主页
 *
 * 每个桌面窗口加载这一个页面，它再套一层沙箱 iframe 装真正的组件。
 *
 * 为什么不直接在窗口里加载组件页面：那样 `parent` 就是它自己，
 * 桥请求会发给自己然后超时；更糟的是组件拿到了窗口的完整权限，
 * 沙箱就没了。多一层 iframe 之后，桌面窗口和主窗口里的预览
 * 跑的是同一套桥、同一套权限校验。
 *
 * 除了装组件，这一页还负责"窗饰"：右上角的拖动/层级/别针/收回，
 * 以及八条缩放手柄。组件不该操心自己怎么被搬动。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  availableMonitors,
  getCurrentWindow,
  LogicalPosition,
  LogicalSize,
} from "@tauri-apps/api/window";
import "./styles.css";
import "./widgetHost.css";
import {
  BRIDGE_TAG,
  handleBridgeRequest,
  isBridgeRequest,
  readThemeTokens,
} from "./runtime/bridge";
import type { Permission } from "./runtime/manifest";

interface HostConfig {
  instanceId: string;
  widgetId: string;
  entry: string;
  permissions: string[];
  theme: "light" | "dark";
  pinned: boolean;
  minW: number;
  minH: number;
  layer: "desktop" | "top";
  clickThrough: boolean;
}

const win = getCurrentWindow();

const ICON = {
  grip: `<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
    <circle cx="6" cy="4" r="1.1"/><circle cx="10" cy="4" r="1.1"/>
    <circle cx="6" cy="8" r="1.1"/><circle cx="10" cy="8" r="1.1"/>
    <circle cx="6" cy="12" r="1.1"/><circle cx="10" cy="12" r="1.1"/>
  </svg>`,
  layerTop: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 12.5V4"/><path d="M4.4 7.6 8 4l3.6 3.6"/>
  </svg>`,
  layerDesktop: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M8 3.5V12"/><path d="M4.4 8.4 8 12l3.6-3.6"/>
  </svg>`,
  pin: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true">
    <circle cx="8" cy="5.6" r="2.9"/><path d="M8 8.6v4.1"/>
  </svg>`,
  pinned: `<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true">
    <circle cx="8" cy="5.6" r="2.9"/><rect x="7.2" y="8.2" width="1.6" height="4.6" rx="0.8"/>
  </svg>`,
  close: `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
    <path d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"/>
  </svg>`,
};

/** 明暗跟着平台走，不跟系统走 —— 平台切深色，桌面卡片也得是深色 */
function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
}

/**
 * 按住之后持续跟踪指针位移。
 *
 * 用 setPointerCapture：拖到窗口外面（甚至拖出屏幕）事件照样回到这个元素，
 * 不会因为指针离开 webview 就断线。
 */
function track(
  element: HTMLElement,
  event: PointerEvent,
  onMove: (dx: number, dy: number) => void,
  onEnd: () => void,
) {
  const startX = event.screenX;
  const startY = event.screenY;

  element.setPointerCapture(event.pointerId);
  document.body.classList.add("is-dragging");

  const move = (next: PointerEvent) => onMove(next.screenX - startX, next.screenY - startY);

  const finish = () => {
    element.removeEventListener("pointermove", move);
    element.removeEventListener("pointerup", finish);
    element.removeEventListener("pointercancel", finish);
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    document.body.classList.remove("is-dragging");
    onEnd();
  };

  element.addEventListener("pointermove", move);
  element.addEventListener("pointerup", finish);
  element.addEventListener("pointercancel", finish);
}

/** 把窗口当前位置与尺寸写回主窗口，让 store 记住用户摆到哪儿了 */
async function reportRect() {
  const scale = await win.scaleFactor();
  const position = (await win.outerPosition()).toLogical(scale);
  const size = (await win.innerSize()).toLogical(scale);
  await invoke("widget_report_rect", {
    x: Math.round(position.x),
    y: Math.round(position.y),
    w: Math.round(size.width),
    h: Math.round(size.height),
  });
}

/*
 * 拖动按钮在窗口右上角的落点：距右边 30px、距顶边 20px。
 * 窗口没有窗饰，用户唯一能抓的地方就是那颗按钮 —— 所以"别让它出界"
 * 就等于"别让组件拖出去回不来"。
 */
const ANCHOR_X = 30;
const ANCHOR_Y = 20;
/** 锚点至少要留在屏幕内这么多像素，否则点不准 */
const SCREEN_MARGIN = 24;

interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 所有显示器的**工作区**矩形，坐标跟 `outerPosition()` 同一套（逻辑像素） */
async function screenBoxes(scale: number): Promise<ScreenBox[]> {
  try {
    const monitors = await availableMonitors();
    return monitors.map((monitor) => {
      // 用 workArea 而不是 size：否则组件能停在任务栏底下，按钮被任务栏压住
      const area = monitor.workArea;
      const origin = (area?.position ?? monitor.position).toLogical(scale);
      const size = (area?.size ?? monitor.size).toLogical(scale);
      return { x: origin.x, y: origin.y, w: size.width, h: size.height };
    });
  } catch {
    // 拿不到显示器信息就别夹了：宁可能拖出去，也不要整个拖不动
    return [];
  }
}

/**
 * 把窗口夹回"右上角那颗按钮还点得到"的范围。
 *
 * 之前完全没有夹：组件拖到屏幕边缘外面，按钮跟着窗口一起出界，
 * 之后就再也拖不回来，只能手改 state.json。
 *
 * 两个刻意的取舍：
 *   - 只保证锚点在某块屏幕里，不要求窗口完整可见。半截悬在边上是很常见的用法。
 *   - 按锚点选屏幕，不按窗口矩形。跨屏拖动时窗口大部分还在出发屏上，
 *     按矩形算会在接缝处把窗口拽回来，手感像卡住。
 */
function clampAnchor(x: number, y: number, w: number, screens: ScreenBox[]): { x: number; y: number } {
  if (screens.length === 0) return { x, y };

  const anchorX = x + w - ANCHOR_X;
  const anchorY = y + ANCHOR_Y;

  let best = screens[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const screen of screens) {
    // 锚点到这块屏幕矩形的最短距离（在里面就是 0）
    const dx = Math.max(screen.x - anchorX, 0, anchorX - (screen.x + screen.w));
    const dy = Math.max(screen.y - anchorY, 0, anchorY - (screen.y + screen.h));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = screen;
    }
  }

  const targetX = Math.min(Math.max(anchorX, best.x + SCREEN_MARGIN), best.x + best.w - SCREEN_MARGIN);
  const targetY = Math.min(Math.max(anchorY, best.y + SCREEN_MARGIN), best.y + best.h - SCREEN_MARGIN);

  return { x: x + (targetX - anchorX), y: y + (targetY - anchorY) };
}

function buildChrome(config: HostConfig) {
  const chrome = document.createElement("div");
  chrome.className = "lw-chrome";
  chrome.innerHTML = `
    <div class="lw-pill">
      <button type="button" class="lw-btn lw-grip" data-act="drag">${ICON.grip}</button>
      <button type="button" class="lw-btn" data-act="layer"></button>
      <button type="button" class="lw-btn" data-act="pin"></button>
      <button type="button" class="lw-btn" data-act="close">${ICON.close}</button>
    </div>
    ${["n", "s", "w", "e", "nw", "ne", "sw", "se"]
      .map((dir) => `<div class="lw-edge" data-dir="${dir}"></div>`)
      .join("")}
  `;

  const grip = chrome.querySelector<HTMLButtonElement>('[data-act="drag"]')!;
  const layerBtn = chrome.querySelector<HTMLButtonElement>('[data-act="layer"]')!;
  const pinBtn = chrome.querySelector<HTMLButtonElement>('[data-act="pin"]')!;
  const closeBtn = chrome.querySelector<HTMLButtonElement>('[data-act="close"]')!;

  let pinned = config.pinned;
  let layer = config.layer;

  const paint = () => {
    document.body.classList.toggle("is-pinned", pinned);
    pinBtn.innerHTML = pinned ? ICON.pinned : ICON.pin;
    pinBtn.classList.toggle("is-on", pinned);
    pinBtn.title = pinned ? "已固定位置，点击解锁" : "固定位置（锁定拖动与缩放）";

    layerBtn.innerHTML = layer === "top" ? ICON.layerTop : ICON.layerDesktop;
    layerBtn.classList.toggle("is-on", layer === "top");
    layerBtn.title = layer === "top" ? "当前置顶，点击贴回桌面" : "当前贴桌面，点击置顶";
  };
  paint();

  // ---- 拖动 ----
  grip.addEventListener("pointerdown", (event) => {
    if (pinned || event.button !== 0) return;
    event.preventDefault();
    const element = event.currentTarget as HTMLElement;

    void (async () => {
      const scale = await win.scaleFactor();
      const start = (await win.outerPosition()).toLogical(scale);
      const size = (await win.innerSize()).toLogical(scale);
      // 显示器信息拖一次只取一次：拖拽期间显示器不会变
      const screens = await screenBoxes(scale);

      // 指针事件比 IPC 快，攒到下一帧再发，避免把窗口位置请求堆成队列
      let pending: { dx: number; dy: number } | null = null;
      let busy = false;
      const pump = async () => {
        if (busy) return;
        busy = true;
        while (pending) {
          const step = pending;
          pending = null;
          const target = clampAnchor(start.x + step.dx, start.y + step.dy, size.width, screens);
          await win.setPosition(
            new LogicalPosition(Math.round(target.x), Math.round(target.y)),
          );
        }
        busy = false;
      };

      track(
        element,
        event,
        (dx, dy) => {
          pending = { dx, dy };
          void pump();
        },
        () => void reportRect(),
      );
    })();
  });

  // ---- 缩放 ----
  chrome.querySelectorAll<HTMLElement>(".lw-edge").forEach((edge) => {
    const dir = edge.dataset.dir ?? "";
    edge.addEventListener("pointerdown", (event) => {
      if (pinned || event.button !== 0) return;
      event.preventDefault();
      const element = event.currentTarget as HTMLElement;

      void (async () => {
        const scale = await win.scaleFactor();
        const startPos = (await win.outerPosition()).toLogical(scale);
        const startSize = (await win.innerSize()).toLogical(scale);
        const screens = await screenBoxes(scale);

        const apply = async (dx: number, dy: number) => {
          let { x, y } = startPos;
          let w = startSize.width;
          let h = startSize.height;

          if (dir.includes("e")) w = Math.max(config.minW, startSize.width + dx);
          if (dir.includes("s")) h = Math.max(config.minH, startSize.height + dy);
          if (dir.includes("w")) {
            w = Math.max(config.minW, startSize.width - dx);
            x = startPos.x + (startSize.width - w);
          }
          if (dir.includes("n")) {
            h = Math.max(config.minH, startSize.height - dy);
            y = startPos.y + (startSize.height - h);
          }

          // 往右/往下拉大时按钮也会被推出屏幕，同样要夹回来
          const clamped = clampAnchor(x, y, w, screens);

          await win.setSize(new LogicalSize(Math.round(w), Math.round(h)));
          // 只有真的动了位置才 setPosition：从东/南边拉大时不该挪窗口
          const moved =
            dir.includes("w") ||
            dir.includes("n") ||
            Math.round(clamped.x) !== Math.round(x) ||
            Math.round(clamped.y) !== Math.round(y);
          if (moved) {
            await win.setPosition(new LogicalPosition(Math.round(clamped.x), Math.round(clamped.y)));
          }
        };

        let pending: { dx: number; dy: number } | null = null;
        let busy = false;
        const pump = async () => {
          if (busy) return;
          busy = true;
          while (pending) {
            const step = pending;
            pending = null;
            await apply(step.dx, step.dy);
          }
          busy = false;
        };

        track(
          element,
          event,
          (dx, dy) => {
            pending = { dx, dy };
            void pump();
          },
          () => void reportRect(),
        );
      })();
    });
  });

  // ---- 层级 / 别针 / 收回 ----
  layerBtn.addEventListener("click", () => {
    layer = layer === "top" ? "desktop" : "top";
    paint();
    void invoke("widget_set_layer", { layer });
  });

  pinBtn.addEventListener("click", () => {
    pinned = !pinned;
    paint();
    void invoke("widget_set_pinned", { pinned });
  });

  closeBtn.addEventListener("click", () => {
    // 先让窗口自己消失，再走 IPC 去真正销毁。
    // 只调 window.close() 的话，要等 WebView2 把渲染进程拆完（几百毫秒），
    // 这段时间窗口还完整地挂在屏幕上 —— 用户感受到的就是"点了没反应"。
    closeBtn.disabled = true;
    void win.hide().catch(() => {});
    void invoke("widget_close").catch(() => {
      // 真失败了就把窗口放回来，不然它会变成一个看不见又关不掉的幽灵
      closeBtn.disabled = false;
      void win.show().catch(() => {});
    });
  });

  document.body.appendChild(chrome);
}

async function boot() {
  applyTheme("dark");

  // 卡片底色由 widget-host.html 的样式负责，这里不再动背景，
  // 否则会和 SetWindowRgn 裁出来的圆角打架
  document.body.style.margin = "0";
  document.body.style.overflow = "hidden";

  const config = await invoke<HostConfig>("widget_host_config");
  applyTheme(config.theme);

  const granted = new Set<Permission>(config.permissions as Permission[]);

  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.setAttribute("referrerpolicy", "no-referrer");
  iframe.setAttribute(
    "style",
    "display:block;width:100vw;height:100vh;border:0;background:transparent;",
  );

  // entry 是主窗口算好的绝对地址：内置组件走应用源（dev 下是 vite，
  // 打包后是 tauri 协议），用户组件走 lattice-widget://。
  // 只有拿到老格式的相对路径时才退回按应用根解析。
  const base = window.location.href.replace(/[^/]*$/, "");
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(config.entry);
  iframe.src = absolute ? config.entry : base + config.entry;
  document.body.appendChild(iframe);

  buildChrome(config);

  const post = (payload: unknown) => iframe.contentWindow?.postMessage(payload, "*");

  window.addEventListener("message", (event) => {
    if (event.source !== iframe.contentWindow) return;

    const data = event.data as Record<string, unknown> | null;
    if (data && data[BRIDGE_TAG] === 1 && data.type === "ready") {
      post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
      return;
    }
    if (!isBridgeRequest(data)) return;

    void handleBridgeRequest(data, {
      instanceId: config.instanceId,
      widgetId: config.widgetId,
      granted,
      reply: post,
      close: () => {
        void invoke("widget_close");
      },
    });
  });

  iframe.addEventListener("load", () => {
    post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
  });

  // 平台切明暗时跟着换，否则桌面上的组件会一直停在建窗口那一刻的主题
  void listen<string>("lattice:theme", (event) => {
    applyTheme(event.payload === "light" ? "light" : "dark");
    post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
  });

  /*
   * 组件存储被别的实例改了（画布上还有一份同款组件），转告 iframe 去重读。
   * 不转的话两边各持一份列表，谁后写谁把对方的新增抹掉。
   */
  void listen<{ widgetId: string; key: string }>("lattice:widget-store", (event) => {
    if (event.payload.widgetId !== config.widgetId) return;
    post({ [BRIDGE_TAG]: 1, type: "store-changed", payload: { key: event.payload.key } });
  });

  /*
   * 开机自我纠正。
   *
   * 老版本没有夹边界，可能已经把窗口摆到屏幕外了 —— 那种窗口拖不动，
   * 也没法点按钮收回。这里建窗口时校正一次，顺手把新位置报回去，
   * 用户升级之后不用手改 state.json 就能把它拉回视野。
   *
   * 位置本来就正常时什么也不做，不会看到跳动。
   */
  void (async () => {
    try {
      const scale = await win.scaleFactor();
      const position = (await win.outerPosition()).toLogical(scale);
      const size = (await win.innerSize()).toLogical(scale);
      const target = clampAnchor(position.x, position.y, size.width, await screenBoxes(scale));
      if (Math.round(target.x) === Math.round(position.x) && Math.round(target.y) === Math.round(position.y)) {
        return;
      }
      await win.setPosition(new LogicalPosition(Math.round(target.x), Math.round(target.y)));
      await reportRect();
    } catch {
      // 校正失败不影响正常使用，下次投放还会再试
    }
  })();
}

void boot();
