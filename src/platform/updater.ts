/**
 * 平台自身的更新检查 —— 和组件更新是**两套**，别混。
 *
 *   组件更新：目录 JSON → `.lattice` 包 → ed25519 验签 → 解到用户目录
 *   平台更新：`latest.json` → NSIS 安装包 → minisign 验签 → 覆盖安装 + 重启
 *
 * 两者共用"静态文件 + 签名 + 没有服务端"这套思路，但代码路径、密钥、产物
 * 都不一样。把组件那套的 `planInstall` 拿过来用是不行的：安装包不是解压，
 * 是跑一个安装器。
 *
 * # 只在用户点的时候查
 *
 * 没有后台轮询。一个一年发几次版的项目，让每台机器每天替你发一次请求，
 * 换来的只是"可能早点知道"—— 而用户真正的诉求是"我现在是不是最新的"，
 * 那是个点击动作。
 *
 * # 非 Tauri 环境要能跑
 *
 * 前端在浏览器里（`npm run dev` 直接开 1420）也能加载，那里没有插件。
 * 所以插件是**动态 import**，且先判 `isTauri()` —— 静态 import 会让整个
 * 设置菜单在浏览器里白屏。
 */
import { invoke } from "@tauri-apps/api/core";

import { isTauri } from "../runtime/registry";

export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "current" }
  | { status: "available"; version: string; notes: string }
  | { status: "downloading"; version: string; percent: number }
  | { status: "error"; message: string };

/**
 * 已经查到的那次更新。
 *
 * `check()` 返回的对象上挂着 `downloadAndInstall`，**必须留着**：
 * 再 `check()` 一次会拿到另一个对象，之前那个下载进度就断了。
 */
type PendingUpdate = {
  version: string;
  body?: string | null;
  downloadAndInstall: (
    onEvent: (event: { event: string; data?: { contentLength?: number; chunkLength?: number } }) => void,
  ) => Promise<void>;
};

let pending: PendingUpdate | null = null;

function friendly(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/could not fetch|failed to fetch|network|dns|connect/i.test(message)) {
    return "Could not reach the update server — check your connection.";
  }
  if (/signature/i.test(message)) {
    return "The update failed signature verification — it was not installed.";
  }
  return message;
}

export async function checkForUpdate(): Promise<UpdateState> {
  if (!isTauri()) {
    return { status: "error", message: "Updates only work in the installed app." };
  }
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      pending = null;
      return { status: "current" };
    }
    pending = update as unknown as PendingUpdate;
    return {
      status: "available",
      version: update.version,
      notes: (update.body ?? "").trim(),
    };
  } catch (error) {
    return { status: "error", message: friendly(error) };
  }
}

/**
 * 下载并安装，然后重启。
 *
 * 进度按"已收字节 / 总字节"算。`contentLength` 偶尔是 0（服务器没给
 * `Content-Length`），这时不猜百分比 —— 停在 0% 比跳到 90% 再卡住更诚实。
 */
export async function installUpdate(
  version: string,
  onProgress: (percent: number) => void,
): Promise<void> {
  if (!pending) {
    const state = await checkForUpdate();
    if (state.status !== "available") {
      throw new Error("no update is available any more");
    }
  }
  const update = pending;
  if (!update) throw new Error("no update is available any more");
  // 查完到点装之间，release 可能又发了一版（或者菜单被重新打开过）。
  // 装一个不是用户看到的那个版本，比报错更糟
  if (update.version !== version) {
    throw new Error(`the update changed to v${update.version} — check again`);
  }

  let total = 0;
  let received = 0;

  await update.downloadAndInstall((event) => {
    if (event.event === "Started") {
      total = event.data?.contentLength ?? 0;
      onProgress(0);
    } else if (event.event === "Progress") {
      received += event.data?.chunkLength ?? 0;
      onProgress(total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0);
    } else if (event.event === "Finished") {
      onProgress(100);
    }
  });

  pending = null;
  // 装完必须换进程：老的进程里跑的还是老二进制
  await invoke("restart_app");
}

/** 当前版本号（来自 `tauri.conf.json` 的 `version`，不是前端的 package.json） */
export async function appVersion(): Promise<string> {
  if (!isTauri()) return "dev";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "unknown";
  }
}
