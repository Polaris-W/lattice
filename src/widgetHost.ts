/**
 * 棂 / Lattice —— 桌面组件窗口的宿主页
 *
 * 每个桌面窗口加载这一个页面，它再套一层沙箱 iframe 装真正的组件。
 *
 * 为什么不直接在窗口里加载组件页面：那样 `parent` 就是它自己，
 * 桥请求会发给自己然后超时；更糟的是组件拿到了窗口的完整权限，
 * 沙箱就没了。多一层 iframe 之后，桌面窗口和主窗口里的预览
 * 跑的是同一套桥、同一套权限校验。
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./styles.css";
import {
  BRIDGE_TAG,
  handleBridgeRequest,
  isBridgeRequest,
  readThemeTokens,
} from "./runtime/bridge";
import type { Permission } from "./runtime/manifest";

interface HostConfig {
  widgetId: string;
  entry: string;
  permissions: string[];
  theme: "light" | "dark";
}

/** 明暗跟着平台走，不跟系统走 —— 平台切深色，桌面卡片也得是深色 */
function applyTheme(theme: "light" | "dark") {
  document.documentElement.dataset.theme = theme;
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

  // 相对应用根解析，dev 下是 http://localhost:1420/，打包后是 tauri://localhost/
  const base = window.location.href.replace(/[^/]*$/, "");
  iframe.src = base + config.entry;
  document.body.appendChild(iframe);

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
      instanceId: "desktop",
      widgetId: config.widgetId,
      granted,
      reply: post,
      close: () => {
        void getCurrentWindow().close();
      },
    });
  });

  iframe.addEventListener("load", () => {
    post({ [BRIDGE_TAG]: 1, type: "theme", payload: readThemeTokens() });
  });
}

void boot();
