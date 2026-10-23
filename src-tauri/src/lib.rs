//! 棂 / Lattice —— Windows 桌面小组件平台
//!
//! 分三层：
//!   - 前端（src/）：平台外壳 + 组件运行时（沙箱 iframe + RPC 桥）
//!   - 本模块：把前端需要的能力收敛成少量命令
//!   - desktop / runner：窗口层级、裁剪、焦点，以及"把画布上的组件变成真窗口"
//!
//! 主窗口承担"设计态"：摆组件、调层级、授权限。
//! 点"投放到桌面"之后，每个 Placement 变成一个独立的 WebviewWindow，
//! 主窗口最小化退场，组件就留在桌面上。

pub mod desktop;
pub mod protocol;
pub mod runner;
pub mod state;
pub mod wallpaper;
pub mod widget_store;
pub mod widgets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 这台机器上 WebView2 的 GPU 进程起不来：窗口建出来了、URL 也对，
    // 但渲染进程不工作，画面一片白，脚本也不执行（eval 返回 Ok 却什么都没跑）。
    // 把 GPU 挪进浏览器进程（--in-process-gpu）就好了。
    //
    // 注意**不要**顺手加 --disable-gpu-compositing：它会把 DirectComposition
    // 关掉，WebView2 的透明背景直接退回白底；加上它之后透明窗口甚至建不出来
    // （HRESULT 0x8007139F）。想恢复默认行为：启动前设 LATTICE_GPU=1。
    let software_render = std::env::var("LATTICE_GPU").map(|v| v != "1").unwrap_or(true);
    if software_render && std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
        // SAFETY: 在任何线程创建之前设置，单线程阶段写入环境变量是安全的
        unsafe {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--in-process-gpu");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(runner::Runner::default())
        // 用户组件不在前端资源里，得靠自定义协议把 %APPDATA% 下的文件发给 iframe
        .register_uri_scheme_protocol(protocol::SCHEME, protocol::handle)
        .invoke_handler(tauri::generate_handler![
            widgets::list_widgets,
            widgets::widgets_dir,
            widgets::install_widget,
            widgets::uninstall_widget,
            desktop::apply_window_layer,
            state::state_read,
            state::state_write,
            state::state_clear,
            widget_store::widget_store_read,
            widget_store::widget_store_write,
            widget_store::widget_store_update,
            widget_store::widget_store_clear,
            runner::sync_widget_windows,
            runner::close_widget_windows,
            runner::widget_host_config,
            runner::widget_report_rect,
            runner::widget_set_pinned,
            runner::widget_set_layer,
            runner::widget_close,
            runner::widget_set_theme,
            runner::widget_set_appearance,
            wallpaper::widget_wallpaper,
        ])
        .run(tauri::generate_context!())
        .expect("failed to start Lattice");
}
