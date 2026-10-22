//! 运行态：把画布上的 Placement 变成真正的桌面窗口
//!
//! 设计上刻意不在窗口里直接加载组件页面，而是加载 `widget-host.html`，
//! 由它再套一层沙箱 iframe。这样桌面窗口和主窗口里的预览**跑的是同一套
//! 桥与权限校验**，不会出现"预览能用、桌面上不能用"的分叉。
//!
//! 窗口本身是透明、无边框、不进任务栏、不抢焦点的，
//! 层级与穿透交给 desktop 模块落到 Win32。
//!
//! # 为什么这里没有"窗口表"
//!
//! 最初版本用一个 `Mutex<HashMap<label, WebviewWindow>>` 记账，结果一创建
//! 窗口就死锁：命令线程持锁 → `build()` 等主线程建 webview → 主线程里
//! 宿主页发 IPC 调 `widget_host_config` → 它要抢同一把锁。三边一卡，
//! 界面直接冻住，组件一个也出不来。
//!
//! 现在窗口的存在性交给 Tauri 自己的窗口注册表（`app.get_webview_window`），
//! 我们只额外记一张**极轻的配置表**（label → 宿主页配置），
//! 且配置在 `build()` **之前**写入，宿主页随时来问都能立刻拿到，不会等锁。

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::desktop::{self, WindowLayer};

/// 所有组件窗口的 label 前缀，用来把平台窗口和组件窗口区分开
const LABEL_PREFIX: &str = "widget-";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WidgetWindowSpec {
    pub instance_id: String,
    pub widget_id: String,
    /// 相对应用根的入口，例如 `widgets/lattice.clock/index.html`
    pub entry: String,
    /// 已授予的权限，宿主页据此放行桥调用
    pub permissions: Vec<String>,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub layer: WindowLayer,
    pub click_through: bool,
    /// 平台当前解析出来的明暗，桌面窗口据此上色，
    /// 不跟随系统 —— 否则用户把平台切成深色，桌面卡片还是白的
    pub theme: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub widget_id: String,
    pub entry: String,
    pub permissions: Vec<String>,
    pub theme: String,
}

/// 只存宿主页启动时要问的那点东西，按窗口 label 索引
#[derive(Default)]
pub struct Runner {
    configs: Mutex<HashMap<String, HostConfig>>,
    /// 上一次真正写进 Win32 的窗口状态。层级和裁剪每次都要 EnumWindows、
    /// 还要给 Progman 发同步消息，拖动时每秒重做十几次太浪费，
    /// 状态没变就跳过。
    applied: Mutex<HashMap<String, Applied>>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Applied {
    layer: WindowLayer,
    click_through: bool,
    w: f64,
    h: f64,
}

impl Runner {
    fn put(&self, label: &str, config: HostConfig) {
        if let Ok(mut map) = self.configs.lock() {
            map.insert(label.to_string(), config);
        }
    }

    fn get(&self, label: &str) -> Option<HostConfig> {
        self.configs.lock().ok()?.get(label).cloned()
    }

    fn forget(&self, label: &str) {
        if let Ok(mut map) = self.configs.lock() {
            map.remove(label);
        }
        if let Ok(mut map) = self.applied.lock() {
            map.remove(label);
        }
    }

    /// 状态有变化才返回 true
    fn needs_apply(&self, label: &str, next: Applied) -> bool {
        let Ok(mut map) = self.applied.lock() else {
            return true;
        };
        if map.get(label) == Some(&next) {
            return false;
        }
        map.insert(label.to_string(), next);
        true
    }
}

/// 窗口标签只允许字母数字和 `-` `_`，实例 id 里的 `#` 等要换掉
fn label_for(instance_id: &str) -> String {
    let safe: String = instance_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .collect();
    format!("{LABEL_PREFIX}{safe}")
}

fn create(app: &AppHandle, spec: &WidgetWindowSpec, runner: &Runner) -> Result<(), String> {
    let label = label_for(&spec.instance_id);

    // 先登记配置再建窗口：宿主页一加载完就会来问，此时表里必须已经有答案
    runner.put(
        &label,
        HostConfig {
            widget_id: spec.widget_id.clone(),
            entry: spec.entry.clone(),
            permissions: spec.permissions.clone(),
            theme: spec.theme.clone(),
        },
    );

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("widget-host.html".into()))
        .title(&spec.widget_id)
        .inner_size(spec.w, spec.h)
        .position(spec.x, spec.y)
        .decorations(false)
        .resizable(false)
        .shadow(false)
        .skip_taskbar(true)
        .focused(false)
        .visible(false);

    let window = match builder.build() {
        Ok(window) => window,
        Err(error) => {
            runner.forget(&label);
            return Err(format!("创建组件窗口失败：{error}"));
        }
    };

    // 先显示再落到层级：ShowWindow 会把窗口提到最前，
    // 顺序反过来的话，刚压到 HWND_BOTTOM / WorkerW 的窗口又被顶上去了
    let _ = window.show();
    if let Err(error) = desktop::apply_to(&window, spec.layer, spec.click_through) {
        // 层级失败不该让整个同步失败：窗口已经建好了，至少先让人看见
        eprintln!("[lattice] 应用窗口层级失败（{label}）：{error}");
    } else {
        runner.needs_apply(
            &label,
            Applied {
                layer: spec.layer,
                click_through: spec.click_through,
                w: spec.w,
                h: spec.h,
            },
        );
    }

    Ok(())
}

/// 增量同步：缺的创建、多的关闭、在的更新位置与层级。
/// 拖动时会被高频调用，所以只做必要的写入。
///
/// # 为什么是 async
///
/// Tauri 2 的同步命令跑在**主线程**上，而 `WebviewWindowBuilder::build()`
/// 需要把建窗口的活儿投递回主线程再等它做完 —— 命令自己占着主线程等自己，
/// 于是永久卡死（日志停在 `sync specs=3` 就没了，连报错都没有）。
/// 改成 async 之后命令落到运行时线程池，主线程空出来接这个投递，窗口才建得出来。
#[tauri::command]
pub async fn sync_widget_windows(
    app: AppHandle,
    runner: State<'_, Runner>,
    specs: Vec<WidgetWindowSpec>,
) -> Result<(), String> {
    let wanted: std::collections::HashSet<String> = specs
        .iter()
        .map(|spec| label_for(&spec.instance_id))
        .collect();

    // 关掉已经不在画布上的组件窗口
    for (label, window) in app.webview_windows() {
        if label.starts_with(LABEL_PREFIX) && !wanted.contains(&label) {
            let _ = window.close();
            runner.forget(&label);
        }
    }

    let mut failures: Vec<String> = Vec::new();

    for spec in specs {
        let label = label_for(&spec.instance_id);
        match app.get_webview_window(&label) {
            Some(window) => {
                // 位置每次写：拖动时这一步就是全部开销，也最便宜
                let _ = window.set_position(LogicalPosition::new(spec.x, spec.y));
                let _ = window.set_size(LogicalSize::new(spec.w, spec.h));

                let next = Applied {
                    layer: spec.layer,
                    click_through: spec.click_through,
                    w: spec.w,
                    h: spec.h,
                };
                if runner.needs_apply(&label, next) {
                    if let Err(error) =
                        desktop::apply_to(&window, spec.layer, spec.click_through)
                    {
                        eprintln!("[lattice] 更新窗口层级失败（{label}）：{error}");
                    }
                }
            }
            None => {
                if let Err(error) = create(&app, &spec, &runner) {
                    failures.push(format!("{}：{error}", spec.widget_id));
                }
            }
        }
    }

    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("\n"))
    }
}

/// 同样要走 async：`close()` 也是投递到主线程执行
#[tauri::command]
pub async fn close_widget_windows(
    app: AppHandle,
    runner: State<'_, Runner>,
) -> Result<(), String> {
    for (label, window) in app.webview_windows() {
        if label.starts_with(LABEL_PREFIX) {
            let _ = window.close();
            runner.forget(&label);
        }
    }
    Ok(())
}

/// 宿主页启动时问自己该装哪个组件、拿到了哪些权限
#[tauri::command]
pub fn widget_host_config(
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
) -> Result<HostConfig, String> {
    runner
        .get(window.label())
        .ok_or_else(|| format!("窗口 {} 没有登记组件配置", window.label()))
}
