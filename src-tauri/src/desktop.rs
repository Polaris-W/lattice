//! 桌面层控制（Windows）
//!
//! 小组件"贴桌面"和"置顶"是两套完全不同的窗口行为：
//!
//! - `desktop`：把窗口挂到 WorkerW 下（Wallpaper Engine 那套做法），
//!   窗口就沉到桌面图标之上、普通窗口之下，切窗口不会被挡住。
//!   拿不到 WorkerW 时降级为 `HWND_BOTTOM`，至少不会浮在最上层。
//! - `top`：还原父子关系后设为 `HWND_TOPMOST`。
//!
//! 两种层级都会顺手加上 `WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW`：
//! 点组件不该抢走当前窗口的焦点，也不该出现在 Alt+Tab 里。
//!
//! # 关于圆角
//!
//! 组件窗口是**不透明**的，圆角靠 `SetWindowRgn` 把窗口本身裁成圆角矩形，
//! 而不是靠 `border-radius` + 透明窗口。原因是逐像素透明要求
//! WebView2 走 DirectComposition 合成，在混合显卡 / 虚拟显示适配器环境下
//! 直接建不出 webview（`HRESULT(0x8007139F)`）；就算建出来了，
//! 一旦软件渲染，透明背景也会退回成白底。
//!
//! 裁剪方案没有这些前提：窗口照常渲染，形状由系统负责，
//! 代价是圆角边缘没有抗锯齿。对一个贴桌面的小组件来说这笔交易很划算。

use serde::Deserialize;

/// 组件窗口的圆角半径（逻辑像素），与画布里 `.lattice-widget` 的 12px 对齐
pub const CORNER_RADIUS: f64 = 12.0;

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WindowLayer {
    Desktop,
    Top,
}

/// 对给定窗口句柄应用层级与穿透设置
pub fn apply_layer(hwnd: isize, layer: WindowLayer, click_through: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        imp::apply(hwnd, layer, click_through)
    }
    #[cfg(not(windows))]
    {
        let _ = (hwnd, layer, click_through);
        Err("窗口层级控制目前只实现了 Windows".to_string())
    }
}

/// 把层级与穿透设置应用到某个 Tauri 窗口
pub fn apply_to(
    window: &tauri::WebviewWindow,
    layer: WindowLayer,
    click_through: bool,
) -> Result<(), String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let handle = window.window_handle().map_err(|error| error.to_string())?;

    // 裁剪区域用的是物理像素，先把逻辑尺寸按 DPI 放缩
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window
        .inner_size()
        .map_err(|error| error.to_string())?;

    #[cfg(windows)]
    {
        if let RawWindowHandle::Win32(win32) = handle.as_raw() {
            let hwnd = win32.hwnd.get();
            apply_layer(hwnd, layer, click_through)?;
            imp::clip_rounded(hwnd, size.width, size.height, CORNER_RADIUS * scale)?;
            return Ok(());
        }
        Err("拿不到 Win32 窗口句柄".to_string())
    }
    #[cfg(not(windows))]
    {
        let _ = (handle, scale, size);
        Err("窗口层级控制目前只实现了 Windows".to_string())
    }
}

#[tauri::command]
pub fn apply_window_layer(
    window: tauri::WebviewWindow,
    layer: WindowLayer,
    click_through: bool,
) -> Result<(), String> {
    apply_to(&window, layer, click_through)
}

#[cfg(windows)]
mod imp {
    use super::WindowLayer;
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::Graphics::Gdi::{CreateRoundRectRgn, DeleteObject, SetWindowRgn};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, FindWindowExW, FindWindowW, GWL_EXSTYLE, GetWindowLongPtrW, HWND_BOTTOM,
        HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SendMessageTimeoutW, SetParent,
        SetWindowLongPtrW, SetWindowPos, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
        WS_EX_TRANSPARENT,
    };

    /// Progman 收到这条未公开消息后会派生出承载壁纸的 WorkerW
    const SPAWN_WORKER_W: u32 = 0x052C;

    /// 把窗口裁成圆角矩形。区域坐标是物理像素，宽高要 +1：
    /// GDI 的区域是右开区间，少 1px 会吃掉最后一行/列。
    pub fn clip_rounded(hwnd: isize, width: u32, height: u32, radius: f64) -> Result<(), String> {
        if hwnd == 0 {
            return Err("窗口句柄为空".to_string());
        }
        if width == 0 || height == 0 {
            return Ok(());
        }
        let diameter = (radius * 2.0).round().max(2.0) as i32;
        let region = unsafe {
            CreateRoundRectRgn(
                0,
                0,
                width as i32 + 1,
                height as i32 + 1,
                diameter,
                diameter,
            )
        };
        if region.is_null() {
            return Err("创建圆角裁剪区域失败".to_string());
        }
        // 成功后区域归系统所有，不能再删；失败才需要自己释放
        let ok = unsafe { SetWindowRgn(hwnd as HWND, region, 1) };
        if ok == 0 {
            unsafe {
                DeleteObject(region);
            }
            return Err("设置窗口裁剪区域失败".to_string());
        }
        Ok(())
    }

    fn wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    struct Search {
        found: HWND,
    }

    unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> i32 {
        let shell_class = wide("SHELLDLL_DefView");
        let worker_class = wide("WorkerW");

        // 桌面图标挂在带 SHELLDLL_DefView 子窗口的那个窗口下，
        // 我们要找的是它的兄弟 WorkerW —— 壁纸层
        let shell = unsafe {
            FindWindowExW(hwnd, std::ptr::null_mut(), shell_class.as_ptr(), std::ptr::null())
        };
        if !shell.is_null() {
            let worker = unsafe {
                FindWindowExW(
                    std::ptr::null_mut(),
                    hwnd,
                    worker_class.as_ptr(),
                    std::ptr::null(),
                )
            };
            if !worker.is_null() {
                let search = unsafe { &mut *(lparam as *mut Search) };
                search.found = worker;
                return 0; // 找到即停止枚举
            }
        }
        1 // 继续
    }

    fn find_worker_w() -> Option<HWND> {
        let progman_class = wide("Progman");
        let progman = unsafe { FindWindowW(progman_class.as_ptr(), std::ptr::null()) };
        if !progman.is_null() {
            let mut result: usize = 0;
            unsafe {
                SendMessageTimeoutW(progman, SPAWN_WORKER_W, 0, 0, 0, 1000, &mut result);
            }
        }

        let mut search = Search {
            found: std::ptr::null_mut(),
        };
        unsafe {
            EnumWindows(Some(enum_proc), &mut search as *mut Search as LPARAM);
        }
        if search.found.is_null() {
            None
        } else {
            Some(search.found)
        }
    }

    pub fn apply(hwnd: isize, layer: WindowLayer, click_through: bool) -> Result<(), String> {
        if hwnd == 0 {
            return Err("窗口句柄为空".to_string());
        }
        let hwnd = hwnd as HWND;

        unsafe {
            let mut style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
            style |= (WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW) as isize;
            if click_through {
                style |= (WS_EX_LAYERED | WS_EX_TRANSPARENT) as isize;
            } else {
                style &= !(WS_EX_TRANSPARENT as isize);
            }
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style);

            match layer {
                WindowLayer::Desktop => match find_worker_w() {
                    Some(worker) => {
                        SetParent(hwnd, worker);
                    }
                    None => {
                        // 降级：不挂 WorkerW，但至少压到最底层
                        SetParent(hwnd, std::ptr::null_mut());
                        SetWindowPos(
                            hwnd,
                            HWND_BOTTOM,
                            0,
                            0,
                            0,
                            0,
                            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                        );
                    }
                },
                WindowLayer::Top => {
                    // 之前可能挂在 WorkerW 下，先脱离再置顶
                    SetParent(hwnd, std::ptr::null_mut());
                    SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        0,
                        0,
                        0,
                        0,
                        SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
                    );
                }
            }
        }

        Ok(())
    }
}
