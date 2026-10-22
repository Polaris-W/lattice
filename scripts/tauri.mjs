#!/usr/bin/env node
/**
 * 包一层 tauri CLI，只为了补两样本机缺的东西：
 *   1. windres（Rust 的 windows-gnu 工具链不自带，tauri-winres 要用它编 .rc）
 *   2. gcc（windres 默认 spawn 它做预处理，见 .toolchain/gcc-shim）
 *
 * 两样都放在项目旁边的 .toolchain/ 里，不改系统 PATH，也不动全局环境。
 * 想换位置就设 LATTICE_TOOLCHAIN 环境变量。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const toolchain = process.env.LATTICE_TOOLCHAIN || resolve(root, "..", ".toolchain");

const binDir = join(toolchain, "mingw64", "bin");
const shimDir = join(toolchain, "gcc-shim");

const prepend = [];
if (existsSync(join(binDir, "windres.exe"))) prepend.push(binDir);
if (existsSync(join(shimDir, "gcc.exe"))) prepend.push(shimDir);

if (prepend.length === 0) {
  console.warn(`[lattice] 没在 ${toolchain} 找到 windres/gcc，直接沿用系统 PATH。`);
  console.warn("[lattice] 如果编译报 windres 相关错误，见 docs/ROADMAP.md 的环境一节。");
} else {
  console.log(`[lattice] 工具链：${prepend.join(" ; ")}`);
}

const env = {
  ...process.env,
  PATH: [...prepend, process.env.PATH ?? ""].join(";"),
};

const child = spawn("npx", ["tauri", ...process.argv.slice(2)], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: true,
});

child.on("exit", (code) => process.exit(code ?? 0));
