/**
 * 钉住构建期注入的插入规则。
 *
 * 这里的 fixture 和 `src-tauri/src/diagnostics.rs` 的单测是**同一组** ——
 * 同一个脚本有两条注入路径（协议层 / 构建期），两边各有一份"插在第几个字节"
 * 的实现。Rust 那边跑不了 cargo test 的时候（这台机器的安全策略会拦
 * `target/debug/deps` 下新写的 exe），至少这份能证明构建期这一半没走样。
 *
 * 跑法：`npm run test:injection`
 */
import test from "node:test";
import assert from "node:assert/strict";
import { injectReporter } from "./widget-diagnostics-plugin.mjs";

test("插在 <head> 之后，且不搅乱原有顺序", () => {
  const html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
  const out = injectReporter(html);
  assert.ok(out.startsWith("<!doctype html><html><head><script"));
  assert.ok(out.includes("<title>x</title></head>"));
});

test("<head> 带属性照样认", () => {
  const html = '<html><head lang="zh" data-x="1"><meta charset="utf-8"></head></html>';
  assert.ok(injectReporter(html).includes('<head lang="zh" data-x="1"><script'));
});

test("<header> 不会被当成 <head>", () => {
  const out = injectReporter("<html><body><header>hi</header></body></html>");
  assert.ok(out.includes("<body><script"));
  assert.ok(!out.includes("</header><script"));
});

test("没有 head 就退到 body 之后", () => {
  assert.ok(injectReporter("<body><p>hi</p></body>").startsWith("<body><script"));
});

test("只有 doctype 的文档插在 doctype 之后（不能掉进怪异模式）", () => {
  const out = injectReporter("<!doctype html><p>hi</p>");
  assert.ok(out.startsWith("<!doctype html><script"));
  assert.ok(!out.startsWith("<script"));
});

test("幂等：注过的不再注第二遍", () => {
  const html = "<html><head></head><body></body></html>";
  const once = injectReporter(html);
  assert.equal(injectReporter(once), once);
});

test("注入只占一行，组件里的行号不错位", () => {
  const html =
    "<!doctype html>\n<html>\n<head>\n<title>x</title>\n</head>\n<body>\n<script>\nboom();\n</script>\n</body>\n</html>\n";
  const out = injectReporter(html);
  assert.equal(out.split("\n").length, html.split("\n").length);
  const boom = out.split("\n").findIndex((line) => line.trim() === "boom();");
  assert.equal(boom, 7);
});

test("多字节内容不会被改坏", () => {
  const html = "<html><head><title>便签</title></head><body>你好</body></html>";
  const out = injectReporter(html);
  assert.ok(out.includes("<title>便签</title>"));
  assert.ok(out.endsWith("<body>你好</body></html>"));
});

test("注入的标记与两条路径共用同一个字面量", () => {
  // 宿主侧只认 `data-lattice="diagnostics"` 这个标记（见 docs/WIDGET_SPEC 8.2），
  // 组件作者在 DevTools 里也靠它认出"这段是平台加的"
  assert.ok(injectReporter("<html><head></head></html>").includes('<script data-lattice="diagnostics">'));
});
