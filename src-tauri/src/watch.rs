//! 组件目录的文件系统监听
//!
//! 改完组件文件（`widget.js` / `style.css` / `index.html`）存盘，桌面上的卡片
//! 自己就刷新，不用再去点窗饰上那颗重载按钮。
//!
//! # 为什么不引 `notify`
//!
//! 需要的只是"某个目录树里有东西变了"这一个信号，`ReadDirectoryChangesW`
//! 一个 API 就够了。引一个跨平台的 watcher 库会带进来一整套依赖图，
//! 而这里只跑 Windows —— 和 `metrics.rs` 手搓 Win32 采样同一条理由。
//!
//! # 两个线程，职责分开
//!
//! - **采集线程**（每个根目录一条）：阻塞在 `ReadDirectoryChangesW` 上，
//!   收到一批变化就把文件名丢进 channel
//! - **合并线程**（全局一条）：等到"安静 300ms"再发事件
//!
//! 为什么要合并：`install_widget` 是一次递归拷贝，几十个文件会在几十毫秒内
//! 各报一次；不合并的话，桌面上那个组件会被重载几十次，每次都在重建 iframe。
//! 合并的判据是"静默"而不是"固定窗口"：拷贝持续 2 秒，事件就等 2 秒后再发一次。
//! 另外加了 `MAX_HOLD`，防止某个组件一直往自己目录里写导致事件永远发不出去。
//!
//! # 只认变化，不认内容
//!
//! 事件里带的是相对路径（`lattice.clock/widget.js`），宿主页据此判断
//! "变的是不是我这份"。不带的话只能全量重载 —— 编辑一个组件，五个卡片一起闪。

use std::path::{Path, PathBuf};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_DIR_NAME,
    FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE,
    FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, OPEN_EXISTING, ReadDirectoryChangesW,
};

/// 安静多久才算"这一批改完了"
const DEBOUNCE: Duration = Duration::from_millis(300);
/// 一直有人在写的时候，最多攒这么久就先发一次
const MAX_HOLD: Duration = Duration::from_millis(2000);

/// 事件名。主窗口和所有宿主页都在听它
pub const EVENT: &str = "lattice:widgets-changed";

#[derive(Clone, Serialize)]
struct ChangedPayload {
    /// 相对根目录的路径，统一用 `/` 分隔
    files: Vec<String>,
}

/// 正在安装/卸载组件时把事件压住。
///
/// 拷贝本身已经被去抖合并过了，但"安装"这个动作之后主窗口会自己 `refresh()`，
/// 再来一条事件只是重复刷新。压住它更干净，也顺手挡掉"卸载时删目录"的那一串。
static SUPPRESS: AtomicBool = AtomicBool::new(false);

/// 安装/卸载期间压住事件；drop 时放开
pub struct Suppress;

impl Suppress {
    pub fn new() -> Self {
        SUPPRESS.store(true, Ordering::SeqCst);
        Self
    }
}

impl Drop for Suppress {
    fn drop(&mut self) {
        SUPPRESS.store(false, Ordering::SeqCst);
    }
}

fn wide(value: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

/// 把一批 FILE_NOTIFY_INFORMATION 记录拆成相对路径。
///
/// 解析本身在 `watch_policy.rs` —— 那是纯函数，拆出去才跑得动单测
/// （`cargo test` 在这台机器上链接不出来）。这里只留一句转发，
/// 调用点不用关心它在哪个文件里。
fn parse_notifications(buffer: &[u8]) -> Vec<String> {
    crate::watch_policy::parse_notifications(buffer)
}

/// 一个根目录的采集线程
fn spawn_watcher(root: PathBuf, tx: Sender<String>) {
    std::thread::spawn(move || {
        if !root.is_dir() {
            return;
        }
        let path = wide(&root);
        // SAFETY: 路径以 NUL 结尾；共享模式全开，免得占用目录让别人删不掉
        let handle = unsafe {
            CreateFileW(
                path.as_ptr(),
                FILE_LIST_DIRECTORY,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS,
                std::ptr::null_mut(),
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            eprintln!("[lattice] could not watch {}: the directory cannot be opened", root.display());
            return;
        }

        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            let mut returned: u32 = 0;
            // SAFETY: 同步调用（overlapped 传 null），缓冲区独占；返回 0 表示失败
            let ok = unsafe {
                ReadDirectoryChangesW(
                    handle,
                    buffer.as_mut_ptr() as *mut _,
                    buffer.len() as u32,
                    1, // 递归
                    FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME | FILE_NOTIFY_CHANGE_LAST_WRITE,
                    &mut returned,
                    std::ptr::null_mut(),
                    None,
                )
            };
            if ok == 0 {
                // 目录被删掉 / 句柄失效：这条线程收工，别空转
                break;
            }
            if returned == 0 {
                continue;
            }
            for name in parse_notifications(&buffer[..returned as usize]) {
                if tx.send(name).is_err() {
                    break;
                }
            }
        }

        // SAFETY: 句柄是本线程建的，线程退出前关掉
        unsafe { CloseHandle(handle) };
    });
}

/// 要监听的目录：用户装的 + 内置的（后者只在开发机上存在）
fn roots(app: &AppHandle) -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(dir) = crate::widgets::user_widgets_dir(app) {
        out.push(dir);
    }

    // 内置组件在 `public/widgets`，开发时就在源码树里。打包之后这个路径
    // 在用户机器上不存在（`is_dir()` 会挡掉），所以这里不用区分 dev/release。
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/widgets");
    if bundled.is_dir() {
        if let Ok(canonical) = bundled.canonicalize() {
            out.push(canonical);
        }
    }
    out
}

/// 起监听。只在启动时调一次。
pub fn start(app: AppHandle) {
    let roots = roots(&app);
    if roots.is_empty() {
        return;
    }
    for root in &roots {
        eprintln!("[lattice] watching {} for widget changes", root.display());
    }

    let (tx, rx) = channel::<String>();
    for root in roots {
        spawn_watcher(root, tx.clone());
    }
    // 发送端要一直活着：所有采集线程退出时 channel 才会断开，那时合并线程收工
    drop(tx);

    std::thread::spawn(move || {
        loop {
            // 第一条：没有变化就阻塞等着
            match rx.recv() {
                Ok(_) => {}
                Err(_) => return,
            }

            let mut files: Vec<String> = Vec::new();
            let started = Instant::now();

            // 之后：一直收到"安静下来"为止
            loop {
                match rx.recv_timeout(DEBOUNCE) {
                    Ok(name) => {
                        files.push(name);
                        if started.elapsed() > MAX_HOLD {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => break,
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }

            files.sort();
            files.dedup();
            if files.is_empty() || SUPPRESS.load(Ordering::SeqCst) {
                continue;
            }

            // 只是看一眼日志，不参与判断
            if std::env::var_os("LATTICE_WATCH_TRACE").is_some() {
                eprintln!("[lattice] widgets changed: {}", files.join(", "));
            }
            let _ = app.emit(EVENT, ChangedPayload { files });
        }
    });
}
