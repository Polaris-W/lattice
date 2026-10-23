/**
 * SDK 的两条不变式，用 `node --test` 钉住（`npm run test:sdk`，不需要 dev server）。
 *
 * 1. **没有漂移**：每个自带 SDK 的组件目录里那份 `lattice.js` / `lattice.d.ts`
 *    必须和 `packages/sdk/` 下的源**逐字节相同**。拷贝漂移是这个发布形态的
 *    固有代价（组件要自包含，所以不能 import 平台），唯一的解药就是这条断言。
 *
 * 2. **版本号是诚实的**：`runtime/manifest.ts` 里的 `SUPPORTED_SDK` 必须和
 *    `packages/sdk/package.json` 的版本对得上（`0.1.x` ↔ `^0.1`）。清单里
 *    声明 `sdk` 的组件是照这个区间写的，两边不一致等于在对作者说谎。
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FILES, vendoredDirs } from "./sdk-sync.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages", "sdk");

test("每个自带 SDK 的目录都与源逐字节一致", () => {
  const dirs = vendoredDirs(root);
  assert.ok(dirs.length > 0, "至少应该有一个自带 SDK 的目录（examples/counter）");

  for (const dir of dirs) {
    for (const file of FILES) {
      const expected = readFileSync(join(source, file));
      const actual = readFileSync(join(dir, file));
      assert.ok(
        expected.equals(actual),
        `${dir.slice(root.length + 1)}/${file} 与 packages/sdk/${file} 不一致 —— 跑 npm run sdk:sync`,
      );
    }
  }
});

test("SUPPORTED_SDK 与 SDK 包版本对得上", () => {
  const manifestTs = readFileSync(join(root, "src", "runtime", "manifest.ts"), "utf8");
  const declared = /SUPPORTED_SDK\s*=\s*"([^"]+)"/.exec(manifestTs);
  assert.ok(declared, "manifest.ts 里应该有 SUPPORTED_SDK");

  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  const [major, minor] = String(pkg.version).split(".");
  assert.equal(
    declared[1],
    `^${major}.${minor}`,
    `SDK 版本是 ${pkg.version}，清单侧的区间应该是 ^${major}.${minor}`,
  );
});
