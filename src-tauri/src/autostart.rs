//! 开机自启：`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
//!
//! 只写当前用户（HKCU），不碰 HKLM：装到 `Program Files` 里也不需要管理员，
//! 卸载时也不会留下"给所有用户都设了自启"的烂摊子。
//!
//! # 为什么不引第三方 crate
//!
//! 就四个 API（建键 / 写值 / 查值 / 删值），`windows-sys` 里都有。
//! 引一个 `auto-launch` 之类的库，多出来的依赖比这 80 行代码重得多 ——
//! 和 `metrics.rs` 手搓 Win32 采样是同一条理由。
//!
//! # 值的形状
//!
//! `Run` 键下每条都是一个命令行，路径带空格时必须自己加引号，否则系统
//! 会把 `C:\Program Files\Lattice\lattice.exe` 拆成两段。这里统一写成
//! `"C:\path\to\lattice.exe"`（带引号、不带参数）。
//!
//! # 开发态会注册 debug 产物
//!
//! `current_exe()` 在 `tauri dev` 下是 `target/debug/lattice.exe`。这不是 bug，
//! 但用户看到"自启"打开、重启后跑起来的却是开发版会很困惑 —— 所以
//! `autostart_get` 把**当前进程路径**和**注册表里那份**一起返回，
//! 设置界面自己决定要不要提示"注册的是另一个构建"。

use std::ffi::OsStr;
use std::os::windows::ffi::OsStrExt;

use serde::Serialize;

use crate::autostart_policy::{command_path, run_command};
use windows_sys::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows_sys::Win32::System::Registry::{
    HKEY, HKEY_CURRENT_USER, KEY_READ, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
    RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegQueryValueExW, RegSetValueExW,
};

const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const VALUE_NAME: &str = "Lattice";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutostartState {
    /// 注册表里有没有这一项
    pub enabled: bool,
    /// 注册表里写的是哪个 exe（没开就是 None）
    pub target: Option<String>,
    /// 当前正在跑的 exe。和 `target` 不一致时，界面上该提示一句
    pub current: String,
}

fn wide(value: &str) -> Vec<u16> {
    OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

/// 打开（必要时创建）Run 键，拿到句柄交给闭包，出来时关掉。
///
/// 用 `RegCreateKeyExW` 而不是 `RegOpenKeyExW`：Run 键理论上一定存在，
/// 但被组策略或精简系统删掉的情况真见过 —— 那时读会报"找不到"，
/// 而写应该照常能建出来。
fn with_key<T>(access: u32, work: impl FnOnce(HKEY) -> Result<T, String>) -> Result<T, String> {
    let sub = wide(RUN_KEY);
    let mut key: HKEY = std::ptr::null_mut();
    // SAFETY: 子键名以 NUL 结尾；`key` 由系统写入，成功后我们负责关掉
    let status = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            sub.as_ptr(),
            0,
            std::ptr::null(),
            REG_OPTION_NON_VOLATILE,
            access,
            std::ptr::null(),
            &mut key,
            std::ptr::null_mut(),
        )
    };
    if status != ERROR_SUCCESS {
        return Err(format!("could not open the Run registry key (error {status})"));
    }
    let result = work(key);
    // SAFETY: key 是上面刚拿到、还没关的句柄
    unsafe { RegCloseKey(key) };
    result
}

/// 读注册表里那条命令（原始字符串，含引号）
fn read_command() -> Option<String> {
    with_key(KEY_READ, |key| {
        let name = wide(VALUE_NAME);
        let mut kind = REG_SZ;
        let mut bytes: u32 = 0;
        // 先问长度：值可能是任意长度，猜一个大小再截断会读到半个字符
        // SAFETY: 传空 data 只查长度，这是这个 API 的约定
        let status = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                std::ptr::null_mut(),
                &mut bytes,
            )
        };
        if status == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if status != ERROR_SUCCESS || bytes == 0 {
            return Ok(None);
        }

        let mut buffer = vec![0u8; bytes as usize];
        // SAFETY: buffer 长度就是刚查到的 bytes
        let status = unsafe {
            RegQueryValueExW(
                key,
                name.as_ptr(),
                std::ptr::null(),
                &mut kind,
                buffer.as_mut_ptr(),
                &mut bytes,
            )
        };
        if status != ERROR_SUCCESS {
            return Ok(None);
        }

        // REG_SZ：UTF-16 小端，末尾带 NUL。按 u16 解，别用 from_utf8
        let units: Vec<u16> = buffer
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .take_while(|unit| *unit != 0)
            .collect();
        Ok(Some(String::from_utf16_lossy(&units)))
    })
    .unwrap_or(None)
}

fn current_exe() -> String {
    std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_default()
}

pub fn state() -> AutostartState {
    let target = read_command().map(|command| command_path(&command));
    AutostartState {
        enabled: target.is_some(),
        target,
        current: current_exe(),
    }
}

/// 开 / 关。返回**写完之后**的真实状态（不是"你要求的状态"）——
/// 注册表写失败时界面不该显示"已开启"。
pub fn set_enabled(enabled: bool) -> Result<AutostartState, String> {
    if enabled {
        let exe = current_exe();
        if exe.is_empty() {
            return Err("could not resolve the path of this executable".to_string());
        }
        // 带引号：路径里有空格时系统会把命令拆错（规则在 autostart_policy.rs）
        write_command(&run_command(&exe))?;
    } else {
        with_key(KEY_SET_VALUE, |key| {
            let name = wide(VALUE_NAME);
            // SAFETY: 只是删一个值；不存在时返回 FILE_NOT_FOUND，不算错误
            let status = unsafe { RegDeleteValueW(key, name.as_ptr()) };
            if status != ERROR_SUCCESS && status != ERROR_FILE_NOT_FOUND {
                return Err(format!("could not remove the Run registry value (error {status})"));
            }
            Ok(())
        })?;
    }

    Ok(state())
}

/// 把一条命令写进 Run 键
fn write_command(command: &str) -> Result<(), String> {
    let data = wide(command);
    with_key(KEY_SET_VALUE, |key| {
        let name = wide(VALUE_NAME);
        // SAFETY: data 以 NUL 结尾；cbdata 按字节算（不含结尾那个 NUL）
        let status = unsafe {
            RegSetValueExW(
                key,
                name.as_ptr(),
                0,
                REG_SZ,
                data.as_ptr() as *const u8,
                ((data.len() - 1) * 2) as u32,
            )
        };
        if status != ERROR_SUCCESS {
            return Err(format!("could not write the Run registry value (error {status})"));
        }
        Ok(())
    })
}

/// 启动时对一次账：注册表里那条命令还指向当前这个 exe 吗？
///
/// # 为什么需要
///
/// 用户开着自启，然后换了安装位置（升级、从 D 盘挪到 C 盘、或者早期版本
/// 写进去的是开发态的 `target\debug\lattice.exe`）。注册表里那条命令就指向
/// 一个不存在的地方，下次登录会闪一个错误框 —— 而用户完全不知道发生了什么。
///
/// 放这里而不是放安装器：应用知道自己的路径，不用去猜 NSIS 模板里的 define，
/// 绿色版（不经安装器）也一并覆盖到。
///
/// # 只修不改
///
/// **只改已经存在的那条**，不会因为对账而把自启打开 —— 没开过就什么都不做。
/// 开不开是用户的决定，任何"顺手打开"都是在替他做主。
///
/// # 只在 release 构建里跑
///
/// 开发时 `current_exe()` 是 `target\debug\lattice.exe`。拿它去覆盖用户机器上
/// 那条安装路径，等于把用户的自启劫持到开发产物上 —— 跑一次 `tauri dev`，
/// 用户下次开机就起一个调试版。这个代价太大，所以 debug 构建直接返回。
/// 反过来那半边（开发态写进去的旧路径）由正式版在用户机器上修，正好。
pub fn reconcile() {
    if cfg!(debug_assertions) {
        return;
    }
    let Some(command) = read_command() else {
        return;
    };
    let exe = current_exe();
    if exe.is_empty() {
        return;
    }
    let registered = command_path(&command);
    // Windows 路径大小写不敏感
    if registered.eq_ignore_ascii_case(&exe) {
        return;
    }

    match write_command(&run_command(&exe)) {
        Ok(()) => eprintln!("[lattice] autostart entry repaired: {registered} -> {exe}"),
        Err(error) => eprintln!("[lattice] could not repair the autostart entry: {error}"),
    }
}

#[tauri::command]
pub fn autostart_get() -> AutostartState {
    state()
}

#[tauri::command]
pub fn autostart_set(enabled: bool) -> Result<AutostartState, String> {
    set_enabled(enabled)
}
