//! 出网闸门：组件窗口只许导航到"它该待的地方"。
//!
//! # 为什么 CSP 不够
//!
//! `csp.rs` 把 `fetch` / 图片 / 表单 / 套框这几条通道全关了，但有一条它管不了：
//! **把组件自己这个 frame 导航走**。`location.href = "https://某处/?d=" + 便签内容`
//! 就是一次干净的出网 —— 一次 GET，数据在查询串里。Chromium 没有 `navigate-to`
//! 指令（提案已废弃），`frame-src` 管的是"能不能嵌别人"，不是"自己能不能走"。
//!
//! 所以这道闸只能下沉到 WebView2：`FrameNavigationStarting` 在导航**发生前**
//! 触发，取消掉就真的不发生。wry 只暴露顶层导航（`on_navigation`），
//! 帧导航得自己拿 `ICoreWebView2` 挂事件。
//!
//! # 放行什么
//!
//! 白名单只有三样东西，其余一律取消：
//!
//! 1. **宿主页自己的 origin** —— 开发期是 `http://localhost:1420`，打包后是
//!    `http://tauri.localhost`。内置组件的 iframe 就在这个源上，不能拦。
//!    从窗口当前 URL 现算，不写死：写死的话换个端口、换台机器就全白屏了。
//! 2. **组件协议的 origin** —— `http://lattice-widget.localhost`（Windows）
//!    或 `lattice-widget://localhost`。用户组件的文档从这里来。
//! 3. **`about:` / `data:` / `blob:`** —— 本地文档，没有网络。iframe 刚建出来
//!    时就是 `about:blank`，拦掉它组件根本起不来。
//!
//! # 这里拦不住的
//!
//! 顶层导航也一起拦了（组件窗口本来只该停在宿主页上），但**主窗口不设闸** ——
//! 那是用户自己的浏览器，点外链该跳就跳（走 opener 插件丢给系统浏览器）。
//! 组件碰不到主窗口的 webview，这条不构成缺口。
//!
//! 另外：闸是"建窗口之后立刻挂"的，理论上存在一个极短的窗口期（宿主页已经
//! 加载、闸还没挂上）。要利用它，组件得在宿主页还没把 iframe 建出来之前就
//! 完成一次导航 —— 而 iframe 是宿主页建的，这条路径不存在。

use tauri::{AppHandle, WebviewWindow};

/// 从 URL 里取 origin（`scheme://host[:port]/`），取不到就是 `None`。
///
/// 不用 URL 解析库：这里只需要"协议 + 主机 + 端口"这一段，而多一个依赖
/// 就多一份要跟 tauri 对齐的版本。大小写按 ASCII 折平 —— origin 不区分大小写。
fn origin_of(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    let scheme_end = lower.find("://")?;
    let rest = &lower[scheme_end + 3..];
    let host_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    if host_end == 0 {
        return None;
    }
    Some(format!("{}/", &lower[..scheme_end + 3 + host_end]))
}

/// 宿主页可能来自哪些 origin。
///
/// **不能从窗口当前 URL 现取** —— `build()` 返回时窗口还没开始导航，
/// `window.url()` 是 `about:blank`，取出来就是 `None`（第一版就是这么翻的：
/// 闸根本没挂上，日志里四条 `egress gate skipped … no origin`）。
///
/// 所以从配置里算：开发期是 `dev_url`（vite 的 `http://localhost:1420`），
/// 打包后是 tauri 自己的资源协议。后者各版本/各平台写法不同，三种都留着 ——
/// 多一条前缀的判断成本可以忽略，漏一条就是全量白屏。
fn host_origins(app: &AppHandle) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(dev) = app.config().build.dev_url.as_ref() {
        if let Some(origin) = origin_of(dev.as_str()) {
            out.push(origin);
        }
    }
    out.extend(
        ["http://tauri.localhost/", "https://tauri.localhost/", "tauri://localhost/"]
            .map(String::from),
    );
    out
}

/// 白名单：一组前缀，命中即放行。
fn allowed_prefixes(host_origins: &[String]) -> Vec<String> {
    let mut out = host_origins.to_vec();
    // 用户组件的只读文件服务。两个平台映射不一样，两个都留着
    out.push(format!("http://{}.localhost/", crate::protocol::SCHEME));
    out.push(format!("{}://localhost/", crate::protocol::SCHEME));
    // 本地文档：没有网络可言
    out.push("about:".to_string());
    out.push("data:".to_string());
    out.push("blob:".to_string());
    out
}

/// 这个地址该不该放行。
///
/// 前缀比较：`http://localhost:1420/` 不会误放行 `http://localhost:1420.evil.com/`
/// —— 端口后面那个字符是 `.` 而不是 `/`，前缀对不上。
pub fn is_allowed(url: &str, allowed: &[String]) -> bool {
    let lower = url.to_ascii_lowercase();
    allowed.iter().any(|prefix| lower.starts_with(prefix.as_str()))
}

/// 给一个组件窗口挂上闸。失败只记一行日志 —— 窗口已经建好了，
/// 让整个同步失败等于因为"加固没成功"把组件弄没了。
pub fn guard(app: &AppHandle, window: &WebviewWindow) {
    #[cfg(windows)]
    {
        let label = window.label().to_string();
        let allowed = allowed_prefixes(&host_origins(app));
        let guard_label = label.clone();
        let result = window.with_webview(move |webview| {
            // SAFETY: controller 是这个 webview 自己的 COM 对象，with_webview
            // 保证我们跑在持有它的线程上；事件处理器交给 WebView2 之后由它 AddRef
            unsafe { install(webview.controller(), &guard_label, allowed) };
        });

        if let Err(error) = result {
            eprintln!("[lattice] egress gate failed ({label}): {error}");
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (app, window);
    }
}

#[cfg(windows)]
unsafe fn install(
    controller: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    label: &str,
    allowed: Vec<String>,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationStartingEventHandler;
    use webview2_com::NavigationStartingEventHandler;

    // SAFETY: controller 有效且已被 WebView2 初始化（窗口 build 完就有 CoreWebView2）
    let core = match unsafe { controller.CoreWebView2() } {
        Ok(core) => core,
        Err(error) => {
            eprintln!("[lattice] egress gate unavailable ({label}): {error}");
            return;
        }
    };

    /// 把"取消 + 记一行"包成同一个动作，两条路（顶层 / 帧）行为一致。
    ///
    /// 放行的导航默认不打日志（组件每次重载、每次加时间戳重新导航都会来一条，
    /// 平时刷屏）。要查"闸到底挂上没挂上、挂在第几次导航之前"，设
    /// `LATTICE_EGRESS_TRACE=1` —— 放行的也打一行。
    fn blocker(
        label: String,
        allowed: Vec<String>,
        kind: &'static str,
    ) -> ICoreWebView2NavigationStartingEventHandler {
        let trace = std::env::var("LATTICE_EGRESS_TRACE").is_ok_and(|value| value != "0");
        NavigationStartingEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            let Some(uri) = read_uri(&args) else { return Ok(()) };
            if is_allowed(&uri, &allowed) {
                if trace {
                    eprintln!("[lattice] egress allow ({label}, {kind}): {uri}");
                }
                return Ok(());
            }
            // 拦下来要留痕：组件"突然不联网了"和"本来就该拦"从外面看一模一样
            eprintln!("[lattice] egress blocked ({label}, {kind}): {uri}");
            // SAFETY: args 是本次事件的参数对象，事件处理期间有效
            let _ = unsafe { args.SetCancel(true) };
            Ok(())
        }))
    }

    let top = blocker(label.to_string(), allowed.clone(), "top");
    let mut top_token = 0;
    // SAFETY: 同上；token 不需要注销 —— 窗口销毁时 WebView2 自己清
    if let Err(error) = unsafe { core.add_NavigationStarting(&top, &mut top_token) } {
        eprintln!("[lattice] could not guard top navigation ({label}): {error}");
    }

    let frame = blocker(label.to_string(), allowed, "frame");
    let mut frame_token = 0;
    // SAFETY: 同上。这条才是真正要堵的缝
    if let Err(error) = unsafe { core.add_FrameNavigationStarting(&frame, &mut frame_token) } {
        eprintln!("[lattice] could not guard frame navigation ({label}): {error}");
    }
}

/// 读事件参数里的目标地址。
///
/// `Uri` 回填的是 COM 分配的 `PWSTR`，不归我们释放（由参数对象持有）。
/// 里面那两处 `unsafe` 收在这里，调用点就不用再包一层。
#[cfg(windows)]
fn read_uri(
    args: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationStartingEventArgs,
) -> Option<String> {
    let mut raw = windows::core::PWSTR::null();
    // SAFETY: args 有效，raw 是栈上可写指针
    unsafe { args.Uri(&mut raw) }.ok()?;
    if raw.is_null() {
        return None;
    }
    // SAFETY: COM 保证回填的是以 NUL 结尾的宽字符串，生命周期到下一次调用为止
    unsafe { raw.to_string() }.ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed_for(host: &str) -> Vec<String> {
        allowed_prefixes(&[host.to_string()])
    }

    #[test]
    fn origin_is_scheme_host_port() {
        assert_eq!(
            origin_of("http://localhost:1420/widget-host.html").as_deref(),
            Some("http://localhost:1420/")
        );
        assert_eq!(
            origin_of("http://tauri.localhost/index.html?x=1#y").as_deref(),
            Some("http://tauri.localhost/")
        );
        // 没有路径也要能取
        assert_eq!(origin_of("https://example.com").as_deref(), Some("https://example.com/"));
        // 大小写折平
        assert_eq!(origin_of("HTTP://LOCALHOST:1420/a").as_deref(), Some("http://localhost:1420/"));
        // 缺 scheme / 缺主机就取不到
        assert_eq!(origin_of("localhost:1420/x"), None);
        assert_eq!(origin_of("http:///x"), None);
    }

    #[test]
    fn host_and_widget_origins_are_allowed() {
        let allowed = allowed_for("http://localhost:1420/");
        // 宿主页和内置组件（同源）
        assert!(is_allowed("http://localhost:1420/widget-host.html", &allowed));
        assert!(is_allowed("http://localhost:1420/widgets/lattice.note/index.html", &allowed));
        // 用户组件
        assert!(is_allowed("http://lattice-widget.localhost/lattice.note/index.html", &allowed));
        assert!(is_allowed("lattice-widget://localhost/lattice.note/index.html", &allowed));
        // iframe 的初始状态
        assert!(is_allowed("about:blank", &allowed));
    }

    #[test]
    fn everything_else_is_blocked() {
        let allowed = allowed_for("http://localhost:1420/");
        // 这条就是这道闸存在的理由：组件把自己 frame 导航出去
        assert!(!is_allowed("https://example.com/?d=secret", &allowed));
        assert!(!is_allowed("http://127.0.0.1:1420/widget-host.html", &allowed));
        assert!(!is_allowed("https://lattice-widget.localhost/x", &allowed));
        // 前缀比较不能把 evil 后缀一起放进来
        assert!(!is_allowed("http://localhost:1420.evil.com/x", &allowed));
        assert!(!is_allowed("http://lattice-widget.localhost.evil.com/x", &allowed));
        // 别的协议一律不放
        assert!(!is_allowed("file:///C:/Windows/System32/drivers/etc/hosts", &allowed));
        assert!(!is_allowed("javascript:fetch('https://example.com')", &allowed));
    }
}
