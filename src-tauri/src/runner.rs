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

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl,
    WebviewWindowBuilder,
};

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
    /// 清单里声明的最小尺寸，宿主页缩放时据此夹紧
    pub min_w: f64,
    pub min_h: f64,
    pub layer: WindowLayer,
    pub click_through: bool,
    /// 组件要不要键盘焦点。false 的窗口带 `WS_EX_NOACTIVATE`，点了不抢焦点；
    /// true 的窗口可以激活，便签/待办才打得进字
    pub interactive: bool,
    /// 别针：锁住位置与大小，宿主页把拖拽/缩放手柄收掉
    pub pinned: bool,
    /// 平台当前解析出来的明暗，桌面窗口据此上色，
    /// 不跟随系统 —— 否则用户把平台切成深色，桌面卡片还是白的
    pub theme: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostConfig {
    pub instance_id: String,
    pub widget_id: String,
    pub entry: String,
    pub permissions: Vec<String>,
    pub theme: String,
    pub pinned: bool,
    pub min_w: f64,
    pub min_h: f64,
    pub layer: WindowLayer,
    pub click_through: bool,
    pub interactive: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RectPayload {
    instance_id: String,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PinnedPayload {
    instance_id: String,
    pinned: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayerPayload {
    instance_id: String,
    layer: WindowLayer,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstancePayload {
    instance_id: String,
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
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    layer: WindowLayer,
    click_through: bool,
    interactive: bool,
}

/// 这次同步相对上次真正写进 Win32 的状态，哪些维度变了
#[derive(Debug, Default, Clone, Copy)]
struct Change {
    pos: bool,
    size: bool,
    layer: bool,
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

    /// 记住某个窗口刚被写进去的状态（新建窗口时用，避免第一次同步重复写）
    fn remember(&self, label: &str, applied: Applied) {
        if let Ok(mut map) = self.applied.lock() {
            map.insert(label.to_string(), applied);
        }
    }

    /// 只改层级那一格，位置和尺寸保持原样。
    ///
    /// 这里必须"就地改"，不能整条覆盖 —— 覆盖成 0 的话，下一次同步会以为
    /// 位置变了，把窗口 set_position 到左上角去。
    fn patch_layer(&self, label: &str, layer: WindowLayer, click_through: bool) {
        if let Ok(mut map) = self.applied.lock() {
            if let Some(entry) = map.get_mut(label) {
                entry.layer = layer;
                entry.click_through = click_through;
            }
        }
    }

    /// 比对并记录：返回 None 表示这一轮什么都不用做。
    ///
    /// 只写变化的部分不只是省开销 —— 用户在桌面上拖动组件时，
    /// 那条 120ms 防抖同步如果无条件 set_position，就会把窗口拽回去。
    /// 位置没变就一根手指都不碰窗口，拖动才不会被抢。
    fn diff(&self, label: &str, next: Applied) -> Option<Change> {
        let mut map = self.applied.lock().ok()?;
        match map.get(label) {
            Some(prev) if *prev == next => None,
            Some(prev) => {
                let change = Change {
                    pos: prev.x != next.x || prev.y != next.y,
                    size: prev.w != next.w || prev.h != next.h,
                    layer: prev.layer != next.layer
                        || prev.click_through != next.click_through
                        || prev.interactive != next.interactive,
                };
                map.insert(label.to_string(), next);
                Some(change)
            }
            None => {
                map.insert(label.to_string(), next);
                Some(Change {
                    pos: true,
                    size: true,
                    layer: true,
                })
            }
        }
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
            instance_id: spec.instance_id.clone(),
            widget_id: spec.widget_id.clone(),
            entry: spec.entry.clone(),
            permissions: spec.permissions.clone(),
            theme: spec.theme.clone(),
            pinned: spec.pinned,
            min_w: spec.min_w,
            min_h: spec.min_h,
            layer: spec.layer,
            click_through: spec.click_through,
            interactive: spec.interactive,
        },
    );

    let builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("widget-host.html".into()))
        .title(&spec.widget_id)
        .inner_size(spec.w, spec.h)
        .position(spec.x, spec.y)
        .decorations(false)
        // 尺寸由宿主页自己算（它要知道最小尺寸、也要在拖边时同步移动窗口），
        // 所以窗口本身不开可调整，避免系统边框和自绘手柄打架
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

    // 缩放时窗口尺寸变了，圆角裁剪区域得跟着重算。
    // 放在 Rust 里做，省掉"上报前端 → 存 store → 再同步回来"这一圈，拖动边缘才跟手。
    if let Ok(handle) = window.window_handle() {
        if let RawWindowHandle::Win32(win32) = handle.as_raw() {
            let hwnd = win32.hwnd.get();
            let radius = desktop::CORNER_RADIUS * window.scale_factor().unwrap_or(1.0);

            window.on_window_event(move |event| {
                if let tauri::WindowEvent::Resized(size) = event {
                    let _ = desktop::clip_rounded(hwnd, size.width, size.height, radius);
                }
            });
        }
    }

    // 先显示再落到层级：ShowWindow 会把窗口提到最前，
    // 顺序反过来的话，刚压到 HWND_BOTTOM / WorkerW 的窗口又被顶上去了
    let _ = window.show();
    if let Err(error) = desktop::apply_to(&window, spec.layer, spec.click_through, spec.interactive) {
        // 层级失败不该让整个同步失败：窗口已经建好了，至少先让人看见
        eprintln!("[lattice] 应用窗口层级失败（{label}）：{error}");
    } else {
        runner.remember(
            &label,
            Applied {
                x: spec.x,
                y: spec.y,
                w: spec.w,
                h: spec.h,
                layer: spec.layer,
                click_through: spec.click_through,
                interactive: spec.interactive,
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
            // 先藏再关：close() 要等 WebView2 把渲染进程拆完，窗口会定格几百毫秒
            let _ = window.hide();
            let _ = window.close();
            runner.forget(&label);
        }
    }

    let mut failures: Vec<String> = Vec::new();

    for spec in specs {
        let label = label_for(&spec.instance_id);
        match app.get_webview_window(&label) {
            Some(window) => {
                let next = Applied {
                    x: spec.x,
                    y: spec.y,
                    w: spec.w,
                    h: spec.h,
                    layer: spec.layer,
                    click_through: spec.click_through,
                    interactive: spec.interactive,
                };
                if let Some(change) = runner.diff(&label, next) {
                    if change.pos {
                        let _ = window.set_position(LogicalPosition::new(spec.x, spec.y));
                    }
                    if change.size {
                        let _ = window.set_size(LogicalSize::new(spec.w, spec.h));
                    }
                    if change.layer {
                        if let Err(error) = desktop::apply_to(
                            &window,
                            spec.layer,
                            spec.click_through,
                            spec.interactive,
                        ) {
                            eprintln!("[lattice] 更新窗口层级失败（{label}）：{error}");
                        }
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
            let _ = window.hide();
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

// ---------------------------------------------------------------------------
// 宿主页 → 主窗口的动作通道
//
// 组件窗口和主窗口是两个 webview，彼此看不见对方的状态。宿主页上用户拖了、
// 缩了、点了别针，都要经由 Rust 转一手：Rust 改自己那份配置、必要时直接落到
// Win32，然后 emit 给主窗口，让 store 记下来。
//
// 为什么不让宿主页直接改 store：它没有 store，也不该有 —— 组件窗口只是渲染层。
// ---------------------------------------------------------------------------

/// 用户在桌面上拖完/缩完之后上报真实矩形
#[tauri::command]
pub fn widget_report_rect(
    app: AppHandle,
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
) -> Result<(), String> {
    let config = runner
        .get(window.label())
        .ok_or_else(|| "这个窗口不在组件窗口表里".to_string())?;

    // 顺手把缓存更新掉：下一次同步就不会再拿旧坐标去 set_position
    runner.remember(
        window.label(),
        Applied {
            x,
            y,
            w,
            h,
            layer: config.layer,
            click_through: config.click_through,
            interactive: config.interactive,
        },
    );

    let _ = app.emit_to(
        "main",
        "lattice:widget-rect",
        RectPayload {
            instance_id: config.instance_id,
            x,
            y,
            w,
            h,
        },
    );
    Ok(())
}

/// 别针开关
#[tauri::command]
pub fn widget_set_pinned(
    app: AppHandle,
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
    pinned: bool,
) -> Result<(), String> {
    let mut config = runner
        .get(window.label())
        .ok_or_else(|| "这个窗口不在组件窗口表里".to_string())?;
    config.pinned = pinned;
    runner.put(window.label(), config.clone());

    let _ = app.emit_to(
        "main",
        "lattice:widget-pinned",
        PinnedPayload {
            instance_id: config.instance_id,
            pinned,
        },
    );
    Ok(())
}

/// 层级切换：贴桌面 / 置顶
#[tauri::command]
pub fn widget_set_layer(
    app: AppHandle,
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
    layer: WindowLayer,
) -> Result<(), String> {
    let mut config = runner
        .get(window.label())
        .ok_or_else(|| "这个窗口不在组件窗口表里".to_string())?;
    config.layer = layer;
    runner.put(window.label(), config.clone());

    // 立即落到 Win32，不等主窗口那一圈同步，点完马上就能看到效果
    desktop::apply_to(&window, layer, config.click_through, config.interactive)?;
    runner.patch_layer(window.label(), layer, config.click_through);

    let _ = app.emit_to(
        "main",
        "lattice:widget-layer",
        LayerPayload {
            instance_id: config.instance_id,
            layer,
        },
    );
    Ok(())
}

/// 收回这一个组件（不只是关窗口，还要让主窗口把 placement 删掉）
#[tauri::command]
pub async fn widget_close(
    app: AppHandle,
    window: tauri::WebviewWindow,
    runner: State<'_, Runner>,
) -> Result<(), String> {
    if let Some(config) = runner.get(window.label()) {
        let _ = app.emit_to(
            "main",
            "lattice:widget-close",
            InstancePayload {
                instance_id: config.instance_id,
            },
        );
    }
    runner.forget(window.label());
    // 先藏再关：close() 要等 WebView2 把渲染进程拆完，窗口会定格几百毫秒
    let _ = window.hide();
    let _ = window.close();
    Ok(())
}

/// 平台换了明暗，把已经在桌面上的组件一起改过来。
///
/// 组件的明暗是在建窗口时定下的，之后平台再切主题就跟它没关系了。
/// 广播一条事件，各宿主页自己重上色。
#[tauri::command]
pub fn widget_set_theme(app: AppHandle, theme: String) -> Result<(), String> {
    let _ = app.emit("lattice:theme", theme);
    Ok(())
}
