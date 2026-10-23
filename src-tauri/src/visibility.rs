//! 窗口"到底看不看得见" —— `document.visibilityState` 给不了的那一半
//!
//! 实测（本机 Windows 11 + WebView2）：主窗口最小化之后，画布里组件 iframe 的
//! `document.visibilityState` 仍然是 `visible`。WebView2 只在**整个 webview 被
//! 藏起来**时才翻这个属性，而最小化只是把窗口收进任务栏，渲染进程照跑 ——
//! 于是调度器那句"不可见就停摆"在桌面端从来没生效过：主窗口收起来之后，
//! 画布上每个组件还在按心跳空转，这正是调度器要解决的那个问题。
//!
//! 可见性只有窗口自己知道，所以由 Rust 观测、**按窗口**下发给它自己的页面：
//!
//! - 最小化 / 还原在 Windows 上都是 `WM_SIZE`（最小化那一下尺寸是 0×0），
//!   tao 把它映射成 `WindowEvent::Resized`，所以这一条事件就够
//! - `hide()` / `show()` 不改尺寸、不触发 Resized，得由调用点显式 `sync()`
//!
//! # 为什么用 `emit_to` 而不是 `emit`
//!
//! 主窗口最小化时，桌面上的组件窗口还在屏幕上摆着。广播会让它们的定时器
//! 一起停掉 —— 系统监控那张卡会当场冻住。可见性从来只跟"哪个窗口"有关。

//! # 为什么载荷里要带 label
//!
//! `emit_to(label)` 听起来是"只发给这个窗口"，其实不是：JS 侧 `listen()` 注册的
//! 监听器 target 是 `Any`，而 Tauri 的匹配规则是 `target == Any || filter(target)`
//! —— 也就是说**任何** emit 都会送到**每个**窗口的 `Any` 监听器上（见
//! tauri/src/event/listener.rs 的 `match_any_or_filter`）。实测主窗口最小化时，
//! 四个组件窗口全都收到了这条事件，跟着一起停摆。
//!
//! 所以载荷里带上 label，由页面自己比对。听起来笨，但这是唯一不依赖 Tauri
//! 内部匹配细节的做法 —— 换个版本行为变了，这里也不会跟着错。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{Emitter, WebviewWindow};

pub const EVENT: &str = "lattice:window-visible";

#[derive(Clone, Serialize)]
struct Payload {
    /// 发这条事件的窗口。页面拿它跟自己比，不是自己就丢掉
    label: String,
    visible: bool,
}

/// 每个窗口上一次发出去的状态。只在**变化**时发 —— 拖边缩放会连着触发
/// 几十次 Resized，每次都发等于让组件把心跳重排几十遍。
static LAST: OnceLock<Mutex<HashMap<String, bool>>> = OnceLock::new();

/// 盯住这个窗口：最小化 / 还原时告诉它的页面
pub fn watch(window: &WebviewWindow) {
    let handle = window.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Resized(_)) {
            sync(&handle);
        }
    });
}

/// 重新算一次可见性，变了才下发
///
/// 除了 Resized，`hide()` / `show()` 之后也要手动叫一次 —— 那两个不动尺寸。
pub fn sync(window: &WebviewWindow) {
    let visible = is_visible(window);

    let last = LAST.get_or_init(|| Mutex::new(HashMap::new()));
    // 锁中毒不该让窗口卡死：这里存的只是"上次发了什么"，坏了重来一遍就是
    let mut map = match last.lock() {
        Ok(map) => map,
        Err(poisoned) => poisoned.into_inner(),
    };
    if map.insert(window.label().to_string(), visible) == Some(visible) {
        return;
    }
    drop(map);

    // 事件会送到所有窗口，靠载荷里的 label 让它们自己认领（见模块注释）
    let _ = window.emit(
        EVENT,
        Payload {
            label: window.label().to_string(),
            visible,
        },
    );
}

fn is_visible(window: &WebviewWindow) -> bool {
    // 读不到就当可见：宁可多跑几拍，也别因为一次查询失败把组件的时钟停死
    let minimized = window.is_minimized().unwrap_or(false);
    let shown = window.is_visible().unwrap_or(true);
    !minimized && shown
}
