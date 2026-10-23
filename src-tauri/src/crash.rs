//! 渲染进程崩溃的检测与自动恢复
//!
//! # 只管一件事
//!
//! **整个渲染进程挂掉**（WebView2 的 process gone）。这时窗口还在、画面冻在
//! 最后一帧或者干脆变白板，前端一点反应都不会有 —— 因为它自己就是那个进程。
//!
//! 不在这里重做 JS 异常和资源 404：那两条已经有兜底页和错误卡（见
//! `diagnostics.rs`），混进来只会让"组件白屏"重新变成一锅粥。
//!
//! # 怎么知道挂了
//!
//! `ICoreWebView2::add_ProcessFailed`。wry 不暴露这个事件，只能自己从
//! controller 上拿 `ICoreWebView2` 挂 —— 和出网闸门（`egress.rs`）同一条路子。
//!
//! 几种 kind 的处理不一样：
//!
//! | kind | 含义 | 处理 |
//! | --- | --- | --- |
//! | `RENDER_PROCESS_EXITED` / `FRAME_RENDER_PROCESS_EXITED` | 组件那个渲染进程没了 | 重载 |
//! | `GPU_PROCESS_EXITED` | GPU 进程没了 | 重载（画面会花/白，重载能救回来） |
//! | `RENDER_PROCESS_UNRESPONSIVE` | 卡住但还活着 | 只记日志。WebView2 自己会尝试恢复，这时候重载反而可能把用户正在编辑的草稿一起弄丢 |
//! | `BROWSER_PROCESS_EXITED` | 浏览器进程没了 | 窗口已经废了，重载没用；上报主窗口，让用户手动重开 |
//! | 其余（`UTILITY` / `SANDBOX_HELPER` / `PPAPI_*` / `UNKNOWN`） | 辅助进程退出，**不是**组件挂了 | 只记一行日志，**绝不重载** |
//!
//! # 为什么"其余"一律不重载
//!
//! 这条是踩出来的。第一版把不认识的 kind 也当成"挂了"去重载，结果在
//! `--in-process-gpu` 下每次导航都会看到辅助进程退出（实测是
//! `UTILITY_PROCESS_EXITED`，kind 4），重载又触发下一次事件 —— 两个窗口在
//! 几十秒里各重载了一千多次，日志刷到 1.5MB，界面一直在闪。
//!
//! 教训：**只有明确知道"重载能修好"的情况才重载**。剩下的记一行就够了；
//! 拿不准时重载的代价是"把一个偶发事件变成死循环"。
//!
//! # 崩溃循环
//!
//! 一个组件如果每次加载都崩，无脑重载会变成每秒重启一次的死循环。所以
//! 记次数：**60 秒窗口内超过 3 次就停手**，上报主窗口让人知道"这个组件坏了"。
//! 计数按窗口实例算，正常跑一段时间之后窗口重置。放弃之后连日志也不再刷。
//!
//! 判定本身抽成了纯函数 `decide()`，`tests` 里那一组断言钉着它 —— 上面那条
//! 死循环就是"判定写错"的后果，值得单独测。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, WebviewWindow};

use crate::crash_policy::{decide, Action, Ledger};

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CrashPayload {
    instance_id: String,
    /// `render` / `gpu` / `browser` / `unresponsive`
    kind: String,
    /// 这一次是不是最后一次尝试（true 表示已经不打算再重载了）
    gave_up: bool,
}

/// 给一个组件窗口挂上崩溃监听。
///
/// 失败只记一行：窗口已经建好了，因为"加固没成功"把它弄没更糟。
pub fn guard(app: &AppHandle, window: &WebviewWindow, instance_id: &str) {
    #[cfg(windows)]
    {
        let label = window.label().to_string();
        let instance = instance_id.to_string();
        let app = app.clone();
        let target = window.clone();
        let for_log = label.clone();

        let result = window.with_webview(move |webview| {
            // SAFETY: controller 属于这个 webview，with_webview 保证跑在持有它的线程上；
            // 事件处理器交给 WebView2 之后由它 AddRef
            unsafe { install(webview.controller(), &label, &instance, app, target) };
        });

        if let Err(error) = result {
            eprintln!("[lattice] crash guard failed ({for_log}): {error}");
        }
    }

    #[cfg(not(windows))]
    {
        let _ = (app, window, instance_id);
    }
}

#[cfg(windows)]
unsafe fn install(
    controller: webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Controller,
    label: &str,
    instance_id: &str,
    app: AppHandle,
    window: WebviewWindow,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED,
    };
    use webview2_com::ProcessFailedEventHandler;

    // SAFETY: controller 有效且已初始化（窗口 build 完就有 CoreWebView2）
    let core = match unsafe { controller.CoreWebView2() } {
        Ok(core) => core,
        Err(error) => {
            eprintln!("[lattice] crash guard unavailable ({label}): {error}");
            return;
        }
    };

    let ledger: Arc<Mutex<Ledger>> = Arc::new(Mutex::new(Ledger::default()));
    let label = label.to_string();
    let instance = instance_id.to_string();
    let guard_label = label.clone();

    let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
        let Some(args) = args else { return Ok(()) };
        let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED;
        // SAFETY: args 是本次事件的参数对象，事件处理期间有效
        if unsafe { args.ProcessFailedKind(&mut kind) }.is_err() {
            return Ok(());
        }

        // 认不出来的 kind 单独归一类，绝不重载（见文件头的教训）
        let name: &'static str = match kind {
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => "render",
            COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => "render",
            COREWEBVIEW2_PROCESS_FAILED_KIND_GPU_PROCESS_EXITED => "gpu",
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => "unresponsive",
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => "browser",
            COREWEBVIEW2_PROCESS_FAILED_KIND_UTILITY_PROCESS_EXITED => "utility",
            COREWEBVIEW2_PROCESS_FAILED_KIND_SANDBOX_HELPER_PROCESS_EXITED => "sandbox-helper",
            COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_PLUGIN_PROCESS_EXITED => "ppapi-plugin",
            COREWEBVIEW2_PROCESS_FAILED_KIND_PPAPI_BROKER_PROCESS_EXITED => "ppapi-broker",
            COREWEBVIEW2_PROCESS_FAILED_KIND_UNKNOWN_PROCESS_EXITED => "unknown",
            _ => "unrecognized",
        };

        let action = {
            let mut state = match ledger.lock() {
                Ok(state) => state,
                Err(_) => return Ok(()),
            };
            decide(name, &mut state, Instant::now())
        };

        match action {
            Action::Ignore => {}
            Action::Report(kind) => eprintln!(
                "[lattice] widget process event ({guard_label}): {kind} (kind {}) — not reloading",
                kind_code(kind)
            ),
            Action::GiveUp(kind) => {
                eprintln!("[lattice] widget renderer gave up ({guard_label}, {kind}) — not reloading again");
                let _ = app.emit_to(
                    "main",
                    "lattice:widget-crashed",
                    CrashPayload {
                        instance_id: instance.clone(),
                        kind: kind.to_string(),
                        gave_up: true,
                    },
                );
            }
            Action::Reload(attempt) => {
                eprintln!("[lattice] widget renderer crashed ({guard_label}, {name}, attempt {attempt}) — reloading");
                let _ = app.emit_to(
                    "main",
                    "lattice:widget-crashed",
                    CrashPayload {
                        instance_id: instance.clone(),
                        kind: name.to_string(),
                        gave_up: false,
                    },
                );

                // 别在 COM 回调里直接重载：那会让 WebView2 在自己的事件里拆自己。
                // 换一条线程、等一小会儿，等它把这个回调走完。
                let window = window.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(120));
                    if let Err(error) = window.reload() {
                        eprintln!("[lattice] could not reload the crashed widget window: {error}");
                    }
                });
            }
        }

        Ok(())
    }));

    let mut token = 0;
    // SAFETY: 同上；token 不需要注销 —— 窗口销毁时 WebView2 自己清
    if let Err(error) = unsafe { core.add_ProcessFailed(&handler, &mut token) } {
        eprintln!("[lattice] could not watch for renderer crashes ({label}): {error}");
    }
}

/// 日志里那个 kind 数字，方便对着 WebView2 的枚举查
#[cfg(windows)]
fn kind_code(kind: &str) -> i32 {
    match kind {
        "browser" => 0,
        "render" => 1,
        "unresponsive" => 2,
        "gpu" => 6,
        "utility" => 4,
        "sandbox-helper" => 5,
        "ppapi-plugin" => 7,
        "ppapi-broker" => 8,
        "unknown" => 9,
        _ => -1,
    }
}
