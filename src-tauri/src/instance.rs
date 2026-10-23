//! 单实例：第二次启动唤回已经在跑的那个
//!
//! 桌面组件平台必须保证"一个进程"。两个进程会各建一套组件窗口（屏幕上
//! 出现两份一模一样的组件），还会同时往 `state.json` 里写 —— 谁后写谁覆盖，
//! 用户在 A 里摆好的布局被 B 启动时的空状态冲掉。
//!
//! 不引 `tauri-plugin-single-instance`（本地 cargo 缓存里没有它，也不值得
//! 为这一件事多一个依赖），直接用 Win32 的两个命名内核对象：
//!
//! - **命名互斥体** `Local\Lattice.Instance`：第一个进程创建成功；后来的
//!   进程拿到 `ERROR_ALREADY_EXISTS`，就知道已经有人在跑
//! - **命名事件** `Local\Lattice.Wake`：后来的进程 `SetEvent` 一下就退出；
//!   先来的那个有线程在等这个事件，等到就把主窗口翻出来
//!
//! 用 `Local\` 而不是 `Global\`：同一登录会话里一个实例就够，不同用户
//! 各跑各的（`Global\` 还要额外的权限，非管理员可能建不出来）。
//!
//! # 为什么互斥体句柄不能关
//!
//! 命名互斥体的生命周期跟句柄绑在一起。创建完就 `CloseHandle`，对象立刻
//! 消失，下一个进程会以为自己是第一个 —— 单实例就失效了。所以句柄要一直
//! 攥到进程退出（系统会回收），这里刻意不关。

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use tauri::{AppHandle, Manager};
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS};
use windows_sys::Win32::System::Threading::{
    CreateEventW, CreateMutexW, SetEvent, WaitForSingleObject, INFINITE,
};

const MUTEX_NAME: &str = "Local\\Lattice.Instance";
const WAKE_NAME: &str = "Local\\Lattice.Wake";

/// Win32 要的是 NUL 结尾的宽字符串
fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

/// 抢占实例锁。返回 `false` 表示已经有别的 Lattice 在跑。
pub fn claim() -> bool {
    let name = wide(MUTEX_NAME);
    // SAFETY: 名字是静态字符串且以 NUL 结尾；句柄刻意不关（见模块注释）
    let handle = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
    if handle.is_null() {
        // 连互斥体都建不出来（极端情况）。这时候宁可让用户双开，
        // 也不要因为一个锁打不开应用
        return true;
    }

    // SAFETY: CreateMutexW 失败时才需要读 last error，这里只关心"是否已存在"
    let taken = unsafe { GetLastError() } == ERROR_ALREADY_EXISTS;
    if taken {
        // SAFETY: 这个句柄没用了，关掉；已存在的是别人那个对象
        unsafe { CloseHandle(handle) };
        return false;
    }
    true
}

/// 告诉已经在跑的那个实例"有人又点了一次图标"
pub fn signal_existing() {
    let name = wide(WAKE_NAME);
    // SAFETY: 事件对象用完就关；auto-reset，没人等的时候会一直保持有信号
    unsafe {
        let event = CreateEventW(std::ptr::null(), 0, 0, name.as_ptr());
        if event.is_null() {
            return;
        }
        SetEvent(event);
        CloseHandle(event);
    }
}

/// 起一条线程等唤醒事件，收到就把主窗口翻出来
///
/// 不能在主线程上等：那会把消息循环堵死，窗口反而画不出来。
pub fn listen(app: AppHandle) {
    std::thread::spawn(move || {
        let name = wide(WAKE_NAME);
        // SAFETY: 句柄活在这条线程里，循环结束（进程退出）时一并回收
        let event = unsafe { CreateEventW(std::ptr::null(), 0, 0, name.as_ptr()) };
        if event.is_null() {
            eprintln!("[lattice] could not create the wake event; second launch will not reopen the window");
            return;
        }

        loop {
            // SAFETY: INFINITE 等待，返回 0（WAIT_OBJECT_0）表示事件被触发
            let status = unsafe { WaitForSingleObject(event, INFINITE) };
            if status != 0 {
                // 句柄失效之类：退出等待线程，别空转
                break;
            }
            // 回到主线程再动窗口：窗口操作必须在窗口线程上做
            let for_main = app.clone();
            let _ = app.run_on_main_thread(move || show_main(&for_main));
        }
    });
}

/// 把主窗口从"收起 / 最小化"里翻出来并聚焦
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        // 从"收起"回来时尺寸没变，不会触发 Resized —— 得自己报一声，
        // 不然画布上的组件会一直以为窗口还藏着，定时器永远不恢复
        crate::visibility::sync(&window);
    }
}
