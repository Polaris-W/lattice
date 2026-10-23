//! 组件出问题时给人看的东西。
//!
//! 两件事，都在 `protocol.rs` 发文件的那条路上：
//!
//! 1. **兜底页** —— 请求失败时返回一页说明，而不是空白 body。以前组件加载
//!    不出来就是一片白，用户分不清是路径写错、文件没装、还是组件自己的 JS
//!    崩了；现在至少能看见"哪个组件、哪个文件、为什么"。
//!
//! 2. **错误上报** —— 组件跑在 `sandbox` 的 iframe 里，源是不透明的，宿主
//!    读不到它的 `window.onerror`。所以往发出去的 HTML 里注一小段脚本，
//!    让它自己把错误 `postMessage` 给宿主。注入点必须在组件自己的脚本之前，
//!    否则第一行就抛的错根本抓不到。
//!
//! 注入只发生在 `lattice-widget://` 这条路上，也就是**用户装的组件**。
//! 内置组件的文件走应用自己的源（dev 是 vite，打包后是 tauri 资源协议），
//! 协议层碰不到 —— 这个缺口写在 AGENTS.md 的"已知缺口"里。

use std::path::Path;

/// 失败的原因。分得细一点，兜底页才说得清楚 ——
/// "组件没装"和"目录在但文件不在"是两件完全不同的事。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// 请求路径不像 `<id>/<相对路径>`
    BadPath,
    /// 用户组件目录拿不到（建不出来 / 权限）
    NoStorage,
    /// 组件目录不存在
    MissingWidget,
    /// 目录在，文件不在
    MissingFile,
    /// 文件在，读不出来（被别的程序锁住之类）
    Unreadable,
    /// 不是 GET / HEAD
    BadMethod,
}

impl Failure {
    pub fn status(self) -> u16 {
        match self {
            Failure::BadPath => 400,
            Failure::BadMethod => 405,
            Failure::NoStorage | Failure::Unreadable => 500,
            Failure::MissingWidget | Failure::MissingFile => 404,
        }
    }

    fn headline(self) -> &'static str {
        match self {
            Failure::BadPath => "Malformed request path",
            Failure::NoStorage => "Widget folder unavailable",
            Failure::MissingWidget => "Widget not installed",
            Failure::MissingFile => "File not found",
            Failure::Unreadable => "File could not be read",
            Failure::BadMethod => "Method not allowed",
        }
    }

    fn detail(self) -> &'static str {
        match self {
            Failure::BadPath => {
                "The request doesn't look like a widget path. Widgets can only read files inside their own folder."
            }
            Failure::NoStorage => "Lattice couldn't open the folder where user widgets live.",
            Failure::MissingWidget => "No folder exists for this widget id.",
            Failure::MissingFile => "The widget folder exists, but this file isn't in it.",
            Failure::Unreadable => {
                "The file is there but couldn't be read — it may be locked by another program."
            }
            Failure::BadMethod => "Widget files are read-only; only GET and HEAD are supported.",
        }
    }

    fn hint(self) -> &'static str {
        match self {
            Failure::BadPath => "Use plain relative paths such as ./style.css. `..`, drive letters and backslashes are rejected.",
            Failure::NoStorage => "Restart Lattice. If this keeps happening the app data folder isn't writable.",
            Failure::MissingWidget => "Install the widget from the library, or copy its folder into the widgets directory.",
            Failure::MissingFile => "Check the `entry` field in manifest.json — it must match a real file in the widget folder.",
            Failure::Unreadable => "Close whatever has the file open, then reload the widget.",
            Failure::BadMethod => "A form posting back into the widget can't be handled; keep widget state in the bridge store instead.",
        }
    }
}

/// 拼一页兜底说明。
///
/// `root` 是用户组件目录：只在一路成功定位到目录之后才传进来 ——
/// 它带着用户的 Windows 用户名，没必要发给"连目录都没找到"的请求。
pub fn error_document(failure: Failure, id: &str, relative: &str, root: Option<&Path>) -> String {
    let mut out = String::with_capacity(2400);
    out.push_str("<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">");
    out.push_str("<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">");
    out.push_str("<title>");
    out.push_str(failure.headline());
    out.push_str("</title><style>");
    out.push_str(STYLE);
    out.push_str("</style></head><body>");

    out.push_str("<h1>");
    out.push_str(failure.headline());
    out.push_str("<span class=\"code\">");
    out.push_str(&failure.status().to_string());
    out.push_str("</span></h1>");

    out.push_str("<p class=\"lead\">");
    out.push_str(failure.detail());
    out.push_str("</p>");

    // 有 id 才列这张表：路径非法时 id 可能是空的，列出来只是噪音
    if !id.is_empty() {
        out.push_str("<dl>");
        row(&mut out, "Widget", id);
        if !relative.is_empty() {
            row(&mut out, "Requested", relative);
        }
        out.push_str("</dl>");
    }

    if let Some(dir) = root {
        let target = if id.is_empty() {
            dir.display().to_string()
        } else {
            dir.join(id).display().to_string()
        };
        out.push_str("<div class=\"box\"><span class=\"label\">Looked in</span><code>");
        out.push_str(&esc(&target.replace('\\', "/")));
        out.push_str("</code></div>");
    }

    out.push_str("<p class=\"hint\">");
    out.push_str(failure.hint());
    out.push_str("</p>");

    out.push_str("</body></html>");
    out
}

fn row(out: &mut String, label: &str, value: &str) {
    out.push_str("<dt>");
    out.push_str(label);
    out.push_str("</dt><dd>");
    out.push_str(&esc(value));
    out.push_str("</dd>");
}

fn esc(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(ch),
        }
    }
    out
}

/// 兜底页的样式。
///
/// 三条约束：卡片可能只有 200×140（组件窗口的最小尺寸），所以要能滚、
/// 字号不能大；不能引外部资源（协议只发组件自己目录里的文件）；
/// 明暗跟着系统走 —— 这一页在 iframe 里，拿不到平台的 `--lattice-*` 令牌。
const STYLE: &str = r#"
:root{color-scheme:light dark}
*{box-sizing:border-box}
html,body{height:100%}
body{
  margin:0;padding:14px 15px;
  display:flex;flex-direction:column;gap:7px;
  font:12px/1.55 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;
  color:#1b1b1f;background:#fbfaf8;overflow:auto;
  -webkit-font-smoothing:antialiased;
}
h1{margin:0 0 1px;font-size:12.5px;font-weight:600;display:flex;align-items:center;gap:7px}
h1::before{content:"";width:7px;height:7px;border-radius:50%;background:#e2564d;flex:none}
.code{margin-left:auto;font:10.5px/1 ui-monospace,"Cascadia Mono",Consolas,monospace;opacity:.45}
p{margin:0}
.lead{color:#57574f}
dl{margin:2px 0 0;display:grid;grid-template-columns:auto 1fr;gap:3px 10px;font-size:11.5px}
dt{color:#8a8a82}
dd{margin:0;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;word-break:break-all}
.box{padding:7px 9px;border:1px solid #e4e2dc;border-radius:7px;background:#f3f1ed;display:grid;gap:2px}
.box .label{font-size:10px;letter-spacing:.04em;text-transform:uppercase;color:#8a8a82}
.box code{font:11px/1.45 ui-monospace,"Cascadia Mono",Consolas,monospace;word-break:break-all}
.hint{margin-top:auto;padding-top:4px;font-size:11px;color:#6f6f67}
@media (prefers-color-scheme:dark){
  body{color:#ecebe6;background:#15151a}
  .lead{color:#a3a39b}
  dt,.box .label,.hint{color:#83838b}
  .box{background:#1d1d24;border-color:#2c2c35}
}
"#;

/// 注进组件文档的那段脚本。
///
/// 规矩：
///   - 同一个错误 800ms 内只报一次（渲染循环里抛错时否则一秒能刷 60 条）
///   - 一共最多 12 条，报满了就闭嘴 —— 这是给人看的提示，不是日志管道
///   - 消息截断到 400 字、堆栈 1400 字，别把 postMessage 撑爆
///   - `capture: true` 是必须的：资源加载失败（`<img>`、`<link>`）不冒泡
///   - **一行都不许有 `//` 注释** —— 注入时整段会被压成一行（见 `snippet`），
///     `//` 会把后面所有代码注释掉。`//` 出现的地方用 `/* */` 代替
///
/// 消息标记 `__lattice_diag` 和 `src/runtime/diagnostics.ts` 里的
/// `REPORT_TAG` 必须一致 —— 那边是唯一的读者。
const REPORTER_SOURCE: &str = r##"/*lattice-diagnostics*/
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
})();"##;

/// 压成一行之后的完整 `<script>` 标签。
///
/// 为什么非要一行：`event.lineno` 数的是**文档里的行**。注入的脚本只要多占
/// 一行，组件里所有内联 `<script>` 的行号就整体往下错位 —— 真机上撞到过，
/// 明明在第 21 行抛的错，卡片上写着 `index.html:67:25`。压成一行之后
/// 行数不变，只有第一行的列号会偏，而那通常是 `<head>`。
///
/// 外部脚本（`widget.js` 这种）报的是自己的文件名和行号，本来就不受影响。
fn snippet() -> &'static str {
    static SNIPPET: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    SNIPPET.get_or_init(|| {
        let flat = REPORTER_SOURCE
            .split('\n')
            .map(str::trim)
            .collect::<Vec<_>>()
            .join(" ");
        format!("<script data-lattice=\"diagnostics\">{flat}</script>")
    })
}

/// 注入标记。组件作者在源码里看到它就说明这段是平台加的，不是自己的。
const MARK: &str = "lattice-diagnostics";

/// 把上报脚本插进 HTML，插在 `<head>` 之后（没有 head 就 `<body>` 之后）。
///
/// 为什么非要插在那么前面：组件的第一行 `<script>` 就可能抛错，
/// 插在后面就抓不到；而且组件如果自己写了 `<meta http-equiv="CSP">`，
/// 我们排它前面才不会被它拦掉。
pub fn inject_reporter(html: &str) -> String {
    if html.contains(MARK) {
        return html.to_string();
    }

    let snippet = snippet();
    let at = insertion_point(html);
    let mut out = String::with_capacity(html.len() + snippet.len());
    out.push_str(&html[..at]);
    out.push_str(snippet);
    out.push_str(&html[at..]);
    out
}

/// 该往第几个字节插。
///
/// `to_ascii_lowercase` 只动 ASCII 字母，字节长度不变 —— 所以在小写副本上
/// 找到的下标可以直接用回原串（组件文档里有中文，这点很重要）。
fn insertion_point(html: &str) -> usize {
    let lower = html.to_ascii_lowercase();

    for tag in ["<head", "<body"] {
        let mut from = 0;
        while let Some(offset) = lower[from..].find(tag) {
            let at = from + offset;
            let after = lower.as_bytes().get(at + tag.len()).copied();
            // `<header>` 不算 head：后面必须是空白、`>` 或 `/`
            let boundary = matches!(after, Some(b'>') | Some(b' ') | Some(b'\t') | Some(b'\n') | Some(b'\r') | Some(b'/'));
            if boundary {
                if let Some(end) = lower[at..].find('>') {
                    return at + end + 1;
                }
            }
            from = at + tag.len();
        }
    }

    // 连 head / body 都没写（或者写成了 `<HEAD>` 之外的花样）：退到 doctype 后面。
    // 直接把 script 塞到 `<!doctype>` 前面会让文档掉进怪异模式。
    let trimmed = lower.trim_start();
    if trimmed.starts_with("<!doctype") {
        let lead = lower.len() - trimmed.len();
        if let Some(end) = lower[lead..].find('>') {
            return lead + end + 1;
        }
    }

    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reporter_lands_right_after_head() {
        let html = "<!doctype html><html><head><title>x</title></head><body></body></html>";
        let out = inject_reporter(html);
        assert!(out.starts_with("<!doctype html><html><head><script"));
        // 组件的 title 还在，顺序没被搅乱
        assert!(out.contains("<title>x</title></head>"));
    }

    #[test]
    fn head_with_attributes_still_works() {
        let html = "<html><head lang=\"zh\" data-x=\"1\"><meta charset=\"utf-8\"></head></html>";
        let out = inject_reporter(html);
        assert!(out.contains("<head lang=\"zh\" data-x=\"1\"><script"));
    }

    #[test]
    fn header_tag_is_not_mistaken_for_head() {
        let html = "<html><body><header>hi</header></body></html>";
        let out = inject_reporter(html);
        assert!(out.contains("<body><script"));
        // 不能插到 <header> 后面去
        assert!(!out.contains("</header><script"));
    }

    #[test]
    fn fragment_without_head_falls_back_to_body() {
        let out = inject_reporter("<body><p>hi</p></body>");
        assert!(out.starts_with("<body><script"));
    }

    #[test]
    fn doctype_only_document_inserts_after_doctype() {
        let out = inject_reporter("<!doctype html><p>hi</p>");
        assert!(out.starts_with("<!doctype html><script"));
        // 怪异模式的开关不能动
        assert!(!out.starts_with("<script"));
    }

    #[test]
    fn injection_is_idempotent() {
        let html = "<html><head></head><body></body></html>";
        let once = inject_reporter(html);
        let twice = inject_reporter(&once);
        assert_eq!(once, twice);
    }

    #[test]
    fn multibyte_text_survives_injection() {
        let html = "<html><head><title>便签</title></head><body>你好</body></html>";
        let out = inject_reporter(html);
        assert!(out.contains("<title>便签</title>"));
        assert!(out.ends_with("<body>你好</body></html>"));
    }

    #[test]
    fn snippet_is_a_single_line() {
        let snippet = snippet();
        assert!(!snippet.contains('\n'), "注入的脚本不能占第二行");
        assert!(snippet.starts_with("<script"));
        assert!(snippet.ends_with("</script>"));
    }

    #[test]
    fn reporter_source_has_no_line_comments() {
        // 压成一行时 `//` 会把后面所有代码注释掉，然后脚本静默失效
        assert!(!REPORTER_SOURCE.contains("//"), "REPORTER_SOURCE 里不许有 // 注释");
    }

    #[test]
    fn injection_keeps_line_numbers() {
        // 行号是给人看的：`event.lineno` 数的是文档里的行。
        // 注入多占一行，组件里所有内联脚本的行号就整体错位。
        let html = "<!doctype html>\n<html>\n<head>\n<title>x</title>\n</head>\n<body>\n<script>\nboom();\n</script>\n</body>\n</html>\n";
        let out = inject_reporter(html);
        assert_eq!(out.lines().count(), html.lines().count());
        // `boom();` 原来在第 8 行，注入之后还在第 8 行
        let boom = out.lines().position(|line| line.trim() == "boom();");
        assert_eq!(boom, Some(7));
    }

    #[test]
    fn error_page_escapes_the_requested_path() {
        let page = error_document(Failure::MissingFile, "demo", "a<b>&\".html", None);
        assert!(page.contains("a&lt;b&gt;&amp;&quot;.html"));
        // 原样的尖括号一个都不能留
        assert!(!page.contains("a<b>"));
    }

    #[test]
    fn error_page_lists_the_folder_only_when_known() {
        let page = error_document(Failure::MissingFile, "demo", "index.html", Some(Path::new(r"C:\w")));
        assert!(page.contains("C:/w/demo"));

        let blind = error_document(Failure::BadPath, "", "/", None);
        assert!(!blind.contains("Looked in"));
    }

    #[test]
    fn statuses_are_what_they_claim() {
        assert_eq!(Failure::BadPath.status(), 400);
        assert_eq!(Failure::MissingWidget.status(), 404);
        assert_eq!(Failure::MissingFile.status(), 404);
        assert_eq!(Failure::NoStorage.status(), 500);
        assert_eq!(Failure::BadMethod.status(), 405);
    }

    #[test]
    fn every_failure_has_words_for_it() {
        for failure in [
            Failure::BadPath,
            Failure::NoStorage,
            Failure::MissingWidget,
            Failure::MissingFile,
            Failure::Unreadable,
            Failure::BadMethod,
        ] {
            let page = error_document(failure, "demo", "index.html", None);
            assert!(page.contains(failure.headline()), "{failure:?} 没标题");
            assert!(page.contains(failure.detail()), "{failure:?} 没说明");
            assert!(page.contains(failure.hint()), "{failure:?} 没提示");
            assert!(page.ends_with("</html>"));
        }
    }
}
