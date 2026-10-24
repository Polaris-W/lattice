//! 组件窗口有没有被别的窗口整个盖住（Windows）
//!
//! `visibility.rs` 只管"最小化 / 收起"这两种看不见 —— 那是窗口自己的状态，
//! 系统会告诉它。但**被别的窗口挡住**这件事没有任何事件：另一个窗口挪过来、
//! 浏览器最大化、播放器全屏，我们的窗口什么都没收到，心跳照跑。系统监控那种
//! 每秒采一次 CPU 的组件，就这么在浏览器后面一直烧着。
//!
//! # 怎么判
//!
//! 在窗口里取九个点（见 `occlusion_policy::sample_points`），每个点问系统
//! 一句"这个位置最上面是哪个窗口"（`WindowFromPoint`），九个都答的不是自己
//! 才算被挡住。
//!
//! 三条边界：
//!
//! - **点透窗口跳过这一套**。`WindowFromPoint` 会**跳过** `WS_EX_TRANSPARENT`
//!   的窗口（那正是"点透"的定义），拿它判点透组件永远是"被挡住"，于是组件
//!   会被永久停摆。点透的组件按"看得见"处理 —— 它们本来就是贴在桌面上的
//!   装饰，误判的代价是它不刷新，那是可见的坏；而少省的那点电是看不见的。
//! - **`DwmGetWindowAttribute(DWMWA_CLOAKED)` 也算挡住**。虚拟桌面切换、
//!   被 UWP 挂起的窗口，系统会把它们 cloak 掉 —— 这种窗口 `IsWindowVisible`
//!   仍然是 true，但屏幕上根本没有。
//! - **任何一次查询失败都当"看得见"**。和 `visibility.rs` 同一条规矩：
//!   宁可多跑几拍，也别因为一次 API 失败把组件的时钟停死。
//!
//! # 为什么要轮询
//!
//! 遮挡变化不产生任何窗口事件，只能自己看。1.5 秒一轮、每个窗口九次
//! `WindowFromPoint`（纯命中测试，不碰渲染），代价可以忽略；而且
//! `visibility::sync` 只在**状态变了**的时候才发事件，轮询本身不会吵到组件。

use std::time::Duration;

use tauri::{AppHandle, Manager, WebviewWindow};

use crate::occlusion_policy;

/// 多久看一次。挡上之后最多晚这么久停摆 —— 这个延迟换来的是零事件监听
const POLL: Duration = Duration::from_millis(1500);

/// 组件窗口的 label 前缀（和 `runner::label_for` 一致）
const WIDGET_PREFIX: &str = "widget-";

/// 这个窗口现在是不是被整个盖住了
pub fn covered(window: &WebviewWindow) -> bool {
    #[cfg(windows)]
    {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};

        let Ok(handle) = window.window_handle() else {
            return false;
        };
        let RawWindowHandle::Win32(win32) = handle.as_raw() else {
            return false;
        };
        covered_hwnd(win32.hwnd.get())
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        false
    }
}

/// 起一条轮询线程：被挡住 / 又露出来了，都要跟着改可见性
///
/// 只在有组件窗口时才干活；主窗口不在这里 —— 它的可见性由最小化事件驱动，
/// 而"主窗口被浏览器挡住"时画布上的组件本来也没人看，但主窗口一旦被挡住，
/// 用户多半马上就要点回来，停它反而会看到一次重排。
pub fn watch_all(app: &AppHandle) {
    let handle = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(POLL);
        for (label, window) in handle.webview_windows() {
            if !label.starts_with(WIDGET_PREFIX) {
                continue;
            }
            // sync 内部会比对上一次的结果，没变就不发事件
            crate::visibility::sync(&window);
        }
    });
}

#[cfg(windows)]
fn covered_hwnd(hwnd: isize) -> bool {
    use windows_sys::Win32::Foundation::{POINT, RECT};
    // ClientToScreen 在 Gdi 下，不在 WindowsAndMessaging —— 和 GetClientRect
    // 分在两个命名空间里，按名字猜会猜错
    use windows_sys::Win32::Graphics::Gdi::ClientToScreen;
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClientRect, GetWindowLongPtrW, IsChild, WindowFromPoint, GWL_EXSTYLE, WS_EX_TRANSPARENT,
    };

    let hwnd = hwnd as windows_sys::Win32::Foundation::HWND;

    // 点透的窗口问不出结果（WindowFromPoint 会跳过它），直接按看得见处理
    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    if ex_style & (WS_EX_TRANSPARENT as isize) != 0 {
        return false;
    }

    // 被系统 cloak 掉的窗口：虚拟桌面里那一半、被挂起的 UWP，屏幕上没有
    if is_cloaked(hwnd) {
        return true;
    }

    let mut rect = RECT { left: 0, top: 0, right: 0, bottom: 0 };
    if unsafe { GetClientRect(hwnd, &mut rect) } == 0 {
        return false;
    }
    let points = occlusion_policy::sample_points(rect.right - rect.left, rect.bottom - rect.top);
    if points.is_empty() {
        return false;
    }

    let mut hits = 0usize;
    for (x, y) in &points {
        let mut point = POINT { x: *x, y: *y };
        if unsafe { ClientToScreen(hwnd, &mut point) } == 0 {
            // 转屏幕坐标失败：这一个点算"没问出来"，不当成被挡住
            continue;
        }
        let at = unsafe { WindowFromPoint(point) };
        if at.is_null() {
            continue;
        }
        /*
         * 用 `IsChild` 而不是比 `GetAncestor(GA_ROOT)`：桌面层的组件被
         * `SetParent` 挂到了 WorkerW 下面，那时它的 root 是 WorkerW 而不是
         * 自己 —— 比 root 会把这类窗口永远判成"被挡住"。`IsChild` 问的是
         * "这个窗口是不是我的后代"，两种层级都成立。
         */
        if at == hwnd || unsafe { IsChild(hwnd, at) } != 0 {
            hits += 1;
        }
    }

    occlusion_policy::covered(hits, points.len())
}

#[cfg(windows)]
fn is_cloaked(hwnd: windows_sys::Win32::Foundation::HWND) -> bool {
    use windows_sys::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};

    let mut cloaked: u32 = 0;
    let status = unsafe {
        DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED as u32,
            &mut cloaked as *mut u32 as *mut core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        )
    };
    // 非 0 是失败（老系统不认这个属性）—— 失败就当没 cloak
    status == 0 && cloaked != 0
}
