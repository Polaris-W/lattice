/**
 * 生成 public/widgets/index.json
 *
 * 内置组件随前端资源打包，Rust 在生产环境读不到它们的目录，
 * 所以由这个脚本在 dev/build 前扫一遍，把 id 列表写进 index.json，
 * 前端据此按需拉取每个组件的 manifest。
 *
 * 用 id（而不是目录名）作为索引键，因为目录名和清单 id 允许不一致，
 * 以清单里的 id 为准。
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const widgetsDir = path.join(root, "public", "widgets");
const outputFile = path.join(widgetsDir, "index.json");

async function main() {
  if (!existsSync(widgetsDir)) {
    console.warn("[widget-index] 没有 public/widgets 目录，跳过");
    return;
  }

  const entries = await readdir(widgetsDir, { withFileTypes: true });
  const ids = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(widgetsDir, entry.name, "manifest.json");
    if (!existsSync(manifestPath)) {
      console.warn(`[widget-index] ${entry.name} 缺少 manifest.json，跳过`);
      continue;
    }
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      if (typeof manifest.id !== "string" || !manifest.id) {
        console.warn(`[widget-index] ${entry.name} 的 manifest 没有 id，跳过`);
        continue;
      }
      if (!manifest.entry || typeof manifest.entry !== "string") {
        console.warn(`[widget-index] ${entry.name} 的 manifest 没有 entry，跳过`);
        continue;
      }
      ids.push(manifest.id);
    } catch (error) {
      console.warn(`[widget-index] ${entry.name} 的 manifest 解析失败：${error.message}`);
    }
  }

  ids.sort();
  await writeFile(outputFile, `${JSON.stringify(ids, null, 2)}\n`, "utf8");
  console.log(`[widget-index] 已写入 ${ids.length} 个组件：${ids.join(", ") || "(空)"}`);
}

await main();
