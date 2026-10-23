/*lattice-diagnostics*/
/*
 * 组件文档里被注入的那段上报脚本 —— 只此一份。
 *
 * 组件跑在 sandbox="allow-scripts" 的 iframe 里，源是不透明的，宿主读不到它的
 * window.onerror。所以平台在**发文档的那一刻**往里注一段脚本，让它自己把错误
 * postMessage 给宿主。两条发文档的路都要注：
 *
 *   1. 组件协议源（用户组件）—— Rust 侧 `diagnostics.rs::inject_reporter`
 *      通过 include_str! 把这个文件编进二进制
 *   2. 应用自己的源（内置组件，dev 是 vite、打包后是 tauri 资源协议）——
 *      `scripts/widget-diagnostics-plugin.mjs` 在 dev 中间件和 build 收尾时注入
 *
 * 所以这个文件是**唯一真源**，两条路都读它，不要各写一份。改完记得两边都会自动
 * 生效，但压缩方式必须一致：整段按行 trim 再用空格连成一行（见两边各自的 snippet）。
 *
 * 为什么非要压成一行：`event.lineno` 数的是**文档里的行**。注入的脚本只要多占
 * 一行，组件里所有内联 `<script>` 的行号就整体往下错位 —— 真机上撞到过，明明在
 * 第 15 行抛的错，卡片上写着 index.html:67:25。
 *
 * 因此：**这个文件里不许出现两个连写的斜杠**（压成一行时它会把后面全注释掉，
 * 脚本静默失效）。连协议名都别照抄 —— `lattice-widget` 后面那两个斜杠一样会
 * 踩雷，写「组件协议源」就行。`diagnostics.rs` 有一条单测钉着这件事，
 * 注释一律用这种块注释。
 *
 * 其他几条规矩：
 *   - 同一个错误 800ms 内只报一次（渲染循环里抛错时否则一秒能刷 60 条）
 *   - 一共最多 12 条，报满了就闭嘴 —— 这是给人看的提示，不是日志管道
 *   - 消息截断到 400 字、堆栈 1400 字，别把 postMessage 撑爆
 *   - `capture: true` 是必须的：资源加载失败（img / link）不冒泡
 *   - 除了报错，这里还负责把 console 转发给宿主（调试面板的"实时日志"），
 *     因为组件窗口的 console 在 dev 下根本不出现在终端里
 *
 * 消息标记 `__lattice_diag` 和 `src/runtime/diagnostics.ts` 里的 `REPORT_TAG`
 * 必须一致 —— 那边是唯一的读者。日志走的是桥那条通道（`__lattice` 加
 * `type: "log"`），两个宿主都要认。
 */
(function () {
  "use strict";
  if (window.parent === window) return;
  var LIMIT = 12;
  var sent = 0;
  var lastKey = "";
  var lastAt = 0;

  function baseName(url) {
    var parts = String(url).split("?")[0].split("#")[0].split("/");
    return parts[parts.length - 1] || String(url);
  }

  function send(kind, message, where, stack) {
    if (sent >= LIMIT) return;
    var now = Date.now();
    var key = kind + "|" + message + "|" + (where || "");
    if (key === lastKey && now - lastAt < 800) return;
    lastKey = key;
    lastAt = now;
    sent += 1;
    var payload = { tag: "__lattice_diag", kind: kind, message: String(message).slice(0, 400) };
    if (where) payload.where = String(where).slice(0, 300);
    if (stack) payload.stack = String(stack).slice(0, 1400);
    try {
      window.parent.postMessage(payload, "*");
    } catch (error) {
      /* 父窗口已经没了，没什么可做的 */
    }
  }

  window.addEventListener("error", function (event) {
    var target = event.target;
    if (target && target !== window && target.nodeType === 1 && (target.src || target.href)) {
      send("resource", "Failed to load " + String(target.tagName || "resource").toLowerCase(), target.src || target.href);
      return;
    }
    var where = "";
    if (event.filename) {
      where = baseName(event.filename) + ":" + (event.lineno || 0) + ":" + (event.colno || 0);
    }
    var error = event.error;
    send("script", (error && error.message) || event.message || "Script error", where, error && error.stack);
  }, true);

  window.addEventListener("unhandledrejection", function (event) {
    var reason = event.reason;
    var message = reason && reason.message ? reason.message : String(reason);
    send("promise", "Unhandled rejection: " + message, "", reason && reason.stack);
  });

  /*
   * 把 console 转发给宿主（调试面板的"实时日志"）。
   *
   * 组件窗口的 console 在 vite dev 下**不会**出现在终端里，WebView2 的
   * devtools 又要单独开远程调试端口 —— 作者写一句 console.log 之后基本
   * 无从确认它有没有跑。所以在这里包一层。
   *
   * 三条限制都是为了"别把桥淹掉"：
   *   - 每秒最多 40 条（渲染循环里打日志一秒能刷几百条）
   *   - 每条正文截到 300 字
   *   - 只转 log / warn / error 三级；debug / table 之类不管
   *
   * 转发失败一律咽掉：日志转发不该影响组件自己的输出。
   */
  var LOG_LIMIT = 40;
  var logSent = 0;
  var logWindow = 0;

  function describe(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.message;
    try {
      var json = JSON.stringify(value);
      return json === undefined ? String(value) : json;
    } catch (error) {
      return String(value);
    }
  }

  function forward(level, args) {
    var now = Date.now();
    if (now - logWindow > 1000) {
      logWindow = now;
      logSent = 0;
    }
    if (logSent >= LOG_LIMIT) return;
    logSent += 1;

    var parts = [];
    for (var index = 0; index < args.length && parts.length < 6; index += 1) {
      parts.push(describe(args[index]));
    }
    try {
      window.parent.postMessage(
        { __lattice: 1, type: "log", payload: { level: level, text: parts.join(" ").slice(0, 300) } },
        "*"
      );
    } catch (error) {
      /* 父窗口没了就算了 */
    }
  }

  ["log", "warn", "error"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      try {
        forward(level, arguments);
      } catch (error) {
        /* 转发炸了也不能挡住下面那行原始输出 */
      }
      if (original) original.apply(console, arguments);
    };
  });
})();
