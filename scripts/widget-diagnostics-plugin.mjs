/**
 * 给**内置组件**的 HTML 注入错误上报脚本。
 *
 * 背景：组件跑在沙箱 iframe 里，源是不透明的，宿主读不到它的 `window.onerror`。
 * 所以平台必须在"发文档的那一刻"往里注一段脚本。用户组件由 Rust 协议层注入
 * （`src-tauri/src/diagnostics.rs`），内置组件不经过协议层 —— 它们的文件由
 * vite（dev）或 tauri 资源协议（打包后）直接发出去。这个插件补的就是这一半。
 *
 * 两条注入路径的规则必须一致，所以脚本只有一份：
 * `src/runtime/widget-reporter.js`（Rust 用 `include_str!`，这里用 readFileSync）。
 * 连"插在第几个字节"的逻辑也照抄 Rust 那份，`scripts/widget-diagnostics.test.mjs`
 * 用同一组 fixture 钉住两边。改一处请改两处。
 *
 * 为什么要在构建期动手、而不是在宿主页里补：沙箱 iframe 的异常宿主读不到，
 * 唯一能装监听器的地方就是文档自己。别指望 `iframe.onerror`。
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** 注入标记。组件作者在 DevTools 里看到它就说明这段是平台加的 */
const MARK = "lattice-diagnostics";

/** 和 Rust 侧同一份源码 */
const REPORTER_PATH = new URL("../src/runtime/widget-reporter.js", import.meta.url);

/**
 * 压成一行之后的完整 `<script>` 标签。
 *
 * 为什么非要一行：`event.lineno` 数的是**文档里的行**。注入的脚本多占一行，
 * 组件里所有内联 `<script>` 的行号就整体错位（真撞到过：第 15 行抛的错报成
 * `index.html:67:25`）。压完行数不变，只有第一行的列号会偏。
 *
 * **每次现读、不缓存**：缓存到模块级看着省事，代价是"改了上报脚本得重启 dev
 * server 才生效"—— 一个只在调上报脚本时踩到、又特别像"我改的没生效"的坑。
 * 文件才几 KB，一次文档请求读一遍不值一提。
 */
function snippet() {
  const source = readFileSync(REPORTER_PATH, "utf8");
  const flat = source
    .split("\n")
    .map((line) => line.trim())
    .join(" ")
    .trim();
  return `<script data-lattice="diagnostics">${flat}</script>`;
}

/**
 * 把上报脚本插进 HTML，插在 `<head>` 之后（没有 head 就 `<body>` 之后）。
 *
 * 必须插在那么前面：组件的第一行 `<script>` 就可能抛错，插在后面抓不到。
 * 规则和 Rust 的 `insertion_point` 逐条对齐：
 *   - `<head` / `<body` 后面必须是空白、`>` 或 `/`（`<header>` 不算）
 *   - 都没有就退到 `<!doctype>` 之后 —— 塞到 doctype 前面会让文档掉进怪异模式
 *   - 什么都没有就插到最前面
 */
function insertionPoint(html) {
  const lower = html.toLowerCase();

  for (const tag of ["<head", "<body"]) {
    let from = 0;
    for (;;) {
      const at = lower.indexOf(tag, from);
      if (at < 0) break;
      const after = lower[at + tag.length];
      const boundary =
        after === ">" || after === " " || after === "\t" || after === "\n" || after === "\r" || after === "/";
      if (boundary) {
        const end = lower.indexOf(">", at);
        if (end >= 0) return end + 1;
      }
      from = at + tag.length;
    }
  }

  // 只按 ASCII 空白算前导：Rust 的 trim_start 不认 BOM，两边要同一个偏移量
  const lead = /^[ \t\r\n]*/.exec(html)[0].length;
  if (lower.startsWith("<!doctype", lead)) {
    const end = lower.indexOf(">", lead);
    if (end >= 0) return end + 1;
  }

  return 0;
}

/** 幂等：已经注过就原样返回（dev 里同一个文件可能被请求很多次） */
export function injectReporter(html) {
  if (html.includes(MARK)) return html;
  let script;
  try {
    script = snippet();
  } catch {
    // 上报脚本读不出来（打包产物里没有 src/、或者文件被移走）：宁可少注一次，
    // 也不能让组件文档整个 500 —— 那会把"组件不报错"变成"组件打不开"。
    return html;
  }
  const at = insertionPoint(html);
  return html.slice(0, at) + script + html.slice(at);
}

/** 内置组件文档的路径形状：`/widgets/<id>/<something>.html` */
const WIDGET_HTML = /^\/widgets\/[^/]+\/[^?#]+\.html?$/i;

/**
 * dev：拦在 vite 静态服务前面，按需注入。
 *
 * 只认 `.html`：`manifest.json`、`widget.js`、`index.json` 一律放行 ——
 * 往 JSON 里塞脚本会让组件拿到一个和真实原因无关的解析错误。
 */
function devMiddleware(server, publicDir) {
  const rootDir = resolve(server.config.root, publicDir);

  return (req, res, next) => {
    const path = (req.url || "").split("?")[0];
    if (!WIDGET_HTML.test(path)) return next();
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    let target;
    try {
      target = resolve(rootDir, `.${decodeURIComponent(path)}`);
    } catch {
      // 百分号编码坏掉（`%zz`）—— 交给 vite 去回 400
      return next();
    }
    // `..` 之类的越界请求不该由这个中间件来回答
    if (!target.startsWith(rootDir + sep)) return next();

    let html;
    try {
      if (!statSync(target).isFile()) return next();
      html = readFileSync(target, "utf8");
    } catch {
      // 文件不存在：让 vite 自己回 404，不要在这里编一页
      return next();
    }

    const body = injectReporter(html);
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    // 组件改完存盘就得看到新内容，跟协议层一个口径
    res.setHeader("Cache-Control", "no-cache");
    res.end(req.method === "HEAD" ? undefined : body);
  };
}

/** build：`public/` 被原样拷进 `dist/` 之后，就地改写那几份 HTML */
function patchBuiltWidgets(outDir) {
  const widgetsDir = join(outDir, "widgets");
  let ids;
  try {
    ids = readdirSync(widgetsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    // 没有内置组件（或 publicDir 被关掉）：什么都不用做
    return 0;
  }

  let patched = 0;
  for (const id of ids) {
    const dir = join(widgetsDir, id);
    for (const file of readdirSync(dir)) {
      if (!/\.html?$/i.test(file)) continue;
      const full = join(dir, file);
      const html = readFileSync(full, "utf8");
      const next = injectReporter(html);
      if (next === html) continue;
      writeFileSync(full, next, "utf8");
      patched += 1;
    }
  }
  return patched;
}

/**
 * vite 插件。
 *
 * `apply` 不写死，两边都要：dev 走中间件，build 走收尾钩子。
 * 注意 `closeBundle` 在 `vite build` 里跑在 public 目录拷贝之后 —— 顺序反了
 * 就会被随后的拷贝盖掉，症状是"打包后的组件又不报错了"。
 */
export function widgetDiagnostics({ publicDir = "public" } = {}) {
  let outDir = "dist";
  let command = "build";

  return {
    name: "lattice:widget-diagnostics",

    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      command = config.command;
    },

    configureServer(server) {
      server.middlewares.use(devMiddleware(server, publicDir));
    },

    closeBundle() {
      // dev 里关服务器时 vite 也会调 closeBundle。那时 `dist/` 是上一次打包的
      // 旧产物，去改它既没意义又容易让人以为"dev 在写构建目录"。
      if (command !== "build") return;
      const count = patchBuiltWidgets(outDir);
      if (count > 0) {
        this.info(`[lattice] 错误上报已注入 ${count} 份内置组件文档`);
      }
    },
  };
}

export default widgetDiagnostics;
