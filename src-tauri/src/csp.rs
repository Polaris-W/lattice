//! 组件文档的 CSP。
//!
//! 组件是第三方代码。沙箱 iframe 挡住了"碰不到宿主 DOM"，但**挡不住网络**：
//! 一个组件完全可以在用户不知情的时候 `fetch("https://…")` 把便签内容发出去。
//! 网络白名单代理是最终答案，可是在那之前得先有一道浏览器层面的闸门 ——
//! 没有 CSP 的 `connect-src 'none'`，所谓白名单只是指望组件"自觉"不直连。//!
//! # 为什么不用 `'self'`
//!
//! 组件跑在 `sandbox="allow-scripts"` 的 iframe 里，文档源是 **opaque** 的。
//! CSP 的 `'self'` 对 opaque origin 匹配不到任何东西 —— 写上等于把组件自己的
//! `widget.js`、`style.css` 也一起拦了，组件当场白屏。
//!
//! 所以这里把组件自己的 origin **显式写出来**。协议处理函数本来就知道自己在
//! 发谁的文件（第一段路径就是组件 id），也就完全知道那个 origin 是什么。
//!
//! # 只给用户组件加
//!
//! 内置组件的文件跟着前端资源走（开发时是 vite，打包后在应用源下），
//! 那条路径我们插不进响应头；而且它们随二进制分发，信任级别和平台本体一样。
//! 所有**第三方**代码都会落到 `lattice-widget://` 上（`registry.rs::loadUser`
//! 只认用户目录），所以这一道头覆盖的正好是全部不可信面。
//!
//! # 留下的口子
//!
//! - `img-src` / `media-src` / `font-src` 只放行组件自己的 origin 和 `data:`/`blob:`，
//!   所以"把数据拼进 `<img src>` 打出去"这条路也堵上了。
//! - **`eval` 是关着的**（没有 `'unsafe-eval'`）。组件不需要它；某个库非要 eval
//!   的话，请用非 eval 的构建产物 —— 这是有意的，不是漏配。
//! - 真要联网的组件走桥上的 `network.fetch`（见 `network.rs`），由 Rust 侧
//!   按清单白名单代发。所以 `connect-src` **不需要**为它放开任何东西 ——
//!   这也是选择"IPC 代理"而不是"本地 HTTP 代理"的原因：后者得在这里多开
//!   一个地址，而多开的每一个地址都是组件可以直接连的一条路。
//! - **自己跳走这条路 CSP 关不住**。iframe 是 `sandbox="allow-scripts"`，没有
//!   `allow-top-navigation`，所以它动不了宿主页面 —— 但它可以把自己这个 frame
//!   导航到 `https://某处/?d=<便签内容>`，一次 GET 就是一次出网。Chromium 里
//!   没有 `navigate-to`（提案已废弃），`frame-src` 管的是"能不能嵌别人"，不是
//!   "自己能不能走"。要真堵死得在 WebView2 层拦帧导航
//!   （`FrameNavigationStarting` / `WebResourceRequested`），见 roadmap 的"出网闸门"。
//!
//!   这一条写在这里，是因为"CSP 做完就安全了"是错觉。CSP 把 `fetch` / 图片 /
//!   表单 / 套框这几条最好用的通道关了，剩下的这条要另一层来关。

use crate::protocol::SCHEME;

/// 组件文档自己的 origin。
///
/// Windows 上自定义协议被映射成 `http://<scheme>.localhost`，其他平台是
/// `<scheme>://localhost`。和前端 `registry.ts::widgetSchemeBase` 必须一致 ——
/// 两处对不上，组件自己的脚本就会被自己的 CSP 拦掉。
fn widget_origin() -> String {
    if cfg!(windows) {
        format!("http://{SCHEME}.localhost")
    } else {
        format!("{SCHEME}://localhost")
    }
}

/// 发给组件文档的完整策略（走响应头）。
///
/// 每一句都在收紧，没有一句是"为了能跑起来先放开"：
///
/// - `default-src 'none'`：没列出来的一律不给。以后新增资源类型默认是关的，
///   要开得有人主动来加一行
/// - `script-src` / `style-src` 放行组件自己的 origin + 内联：组件是任意代码，
///   内联脚本对它没有额外风险，卡住反而让一堆正常组件白屏
/// - `connect-src` 只放行组件自己的 origin：**这条是重点**。外部地址一律拦掉，
///   组件无法把数据发到任何别的地方。为什么不是 `'none'` —— 组件经常要
///   `fetch("./data.json")` 读自己目录里的数据，写死 `'none'` 会把这些正常
///   组件一起打死。而放行自己那个 origin 不构成出网通道：`lattice-widget://`
///   是一个**只读**的文件服务，GET 进去只能拿回自己的文件，服务端不记日志、
///   不看查询串，写不进任何东西
/// - 这一条就是 `network` 权限的全部底牌：授权之后组件**仍然**连不上外网，
///   它只是获得了"请 Rust 代发"的资格。代理在 `network.rs`，白名单在清单里
/// - `frame-src 'none'`：不许套 iframe。套一个外部页面等于绕开上面所有限制
/// - `object-src 'none'`：`<embed>` / `<object>` 是另一条能加载外部内容的旧路
/// - `base-uri 'none'`：不许改 `<base>`，否则相对路径可以被劫持到别的源
/// - `form-action 'none'`：沙箱给了 `allow-forms`，但提交表单同样是一次出网
pub fn document_policy() -> String {
    let origin = widget_origin();
    format!(
        "default-src 'none'; \
         script-src {origin} 'unsafe-inline'; \
         style-src {origin} 'unsafe-inline'; \
         img-src {origin} data: blob:; \
         font-src {origin} data:; \
         media-src {origin} data: blob:; \
         connect-src {origin}; \
         frame-src 'none'; \
         object-src 'none'; \
         base-uri 'none'; \
         form-action 'none'"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_egress_channel_is_closed() {
        let policy = document_policy();
        // 这几条是"组件能不能把数据发出去"的全部答案，少一条都等于没做
        assert!(policy.contains(&format!("connect-src {}", widget_origin())));
        assert!(!policy.contains("connect-src *"), "出网通道不许放开");
        assert!(policy.contains("form-action 'none'"));
        assert!(policy.contains("frame-src 'none'"));
        assert!(!policy.contains("'unsafe-eval'"), "eval 是有意关掉的");
    }

    #[test]
    fn widget_assets_are_still_allowed() {
        let policy = document_policy();
        let origin = widget_origin();
        // 组件自己的脚本/样式必须放行，否则组件直接白屏
        assert!(policy.contains(&format!("script-src {origin}")));
        assert!(policy.contains(&format!("style-src {origin}")));
        assert!(!policy.contains("default-src *"), "默认必须是全关，不是全开");
    }

    #[test]
    fn origin_matches_the_protocol_mapping() {
        let origin = widget_origin();
        if cfg!(windows) {
            assert_eq!(origin, "http://lattice-widget.localhost");
        } else {
            assert_eq!(origin, "lattice-widget://localhost");
        }
    }
}
