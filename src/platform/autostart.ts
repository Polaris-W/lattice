/**
 * 开机自启（前端侧）
 *
 * 真相在注册表里（`HKCU\...\CurrentVersion\Run`），这里只是把两个命令包一层，
 * 顺手处理两件 Rust 那边不该管的事：
 *
 * 1. **浏览器里预览时没有这回事**。`npm run dev` 开的是普通浏览器，没有 IPC。
 *    这时返回 `null`，设置界面把这一行画成"只在桌面应用里可用"，而不是
 *    抛一个看不懂的错。
 * 2. **路径比较**。注册表里那份是 `tauri dev` 时期写进去的
 *    `target\debug\lattice.exe`，用户重启后跑起来的却是安装版 —— 界面得能
 *    看出这个差异并提示一句"注册的是另一个构建"。Windows 路径大小写不敏感、
 *    分隔符两种都见过，所以比较前先归一化。
 */

import { invoke } from "@tauri-apps/api/core";

export interface AutostartState {
  /** 注册表里有没有这一项 */
  enabled: boolean;
  /** 注册表里写的是哪个 exe（没开就是 null） */
  target: string | null;
  /** 当前正在跑的 exe */
  current: string;
}

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 读当前状态。读不到（浏览器预览 / 注册表被策略锁了）返回 null */
export async function readAutostart(): Promise<AutostartState | null> {
  if (!inTauri()) return null;
  try {
    return await invoke<AutostartState>("autostart_get");
  } catch (error) {
    console.error("Failed to read the autostart state", error);
    return null;
  }
}

/**
 * 开 / 关。
 *
 * 返回的是**写完之后**的真实状态，不是"你要求的状态" —— 注册表写失败时
 * 界面不能显示"已开启"，否则用户下次开机发现没起来，会以为是应用坏了。
 * 抛错交给调用方提示。
 */
export async function writeAutostart(enabled: boolean): Promise<AutostartState | null> {
  if (!inTauri()) return null;
  return await invoke<AutostartState>("autostart_set", { enabled });
}

function normalizePath(value: string): string {
  return value.trim().replace(/\//g, "\\").toLowerCase();
}

/**
 * 注册表里那份和当前跑的不是同一个可执行文件。
 *
 * 典型场景：开发时打开过自启，写进去的是 `target\debug\lattice.exe`；
 * 后来装了正式版，注册表没被覆盖，重启起来的还是开发版（或者干脆找不到）。
 * 界面据此提示"重新打开一次这个开关"。
 */
export function isStaleTarget(state: AutostartState | null): boolean {
  if (!state?.enabled || !state.target || !state.current) return false;
  return normalizePath(state.target) !== normalizePath(state.current);
}
