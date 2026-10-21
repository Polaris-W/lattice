//! 棂 / Lattice —— Windows 桌面小组件平台
//!
//! 分三层：
//!   - 前端（src/）：平台外壳 + 组件运行时（沙箱 iframe + RPC 桥）
//!   - 本模块：把前端需要的能力收敛成少量命令
//!   - desktop：窗口层级 / 穿透 / 焦点等 Win32 行为
//!
//! 现在主窗口承担"设计态"：摆组件、调层级、授权限。
//! 下一阶段会把 Placement 渲染成真正的独立 WebviewWindow，主窗口退成纯设置面板。

pub mod desktop;
pub mod widgets;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            widgets::list_widgets,
            widgets::widgets_dir,
            widgets::install_widget,
            widgets::uninstall_widget,
            desktop::apply_window_layer,
        ])
        .run(tauri::generate_context!())
        .expect("启动 Lattice 失败");
}
