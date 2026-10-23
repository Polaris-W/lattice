//! 桌面那一层的像素 —— 磨砂底板的原料。
//!
//! 组件的"磨砂"不是系统 acrylic：DWM 给的模糊半径是写死的，做不出连续滑杆。
//! 所以自己糊 —— 把窗口背后那块桌面截下来，交给宿主页用 `filter: blur(Npx)`
//! 处理，半径想要多细有多细。
//!
//! # 为什么是 PrintWindow(Progman)
//!
//! - `BitBlt(GetDC(NULL))` 拿的是"屏幕上此刻可见的东西"，组件窗口自己就在上面，
//!   截出来是它自己。
//! - `PrintWindow(GetDesktopWindow())` 实测返回 0，整张黑。
//! - `PrintWindow(Progman, PW_RENDERFULLCONTENT)` 渲染的是桌面窗口树，
//!   不含任何顶层窗口，两台显示器一次拿全（实测 3456×1081 约 24ms）。
//!   壁纸模式（填充/适应/平铺）、每台显示器不同的壁纸、幻灯片、动态壁纸
//!   全都不用管 —— 拿到的是"桌面此刻真正画出来的样子"。
//!
//! 24ms 一张，所以缓存两秒：桌面不变时反复截没意义，变了也就晚两秒。
//!
//! # 传输格式
//!
//! `[u32 宽][u32 高][RGBA…]`，小端，走 `tauri::ipc::Response` 的二进制通道。
//! 宽高塞在头 8 字节里，省掉"先问尺寸再取像素"的第二次往返。

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::ipc::Response;
use windows_sys::Win32::Foundation::{HWND, RECT};
use windows_sys::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HDC,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{FindWindowW, GetWindowRect};

// PrintWindow 在 windows-sys 里被归到 Win32_Storage_Xps 这个 feature 下面，
// 为一个函数多开一整个 feature 不划算，直接声明（user32 的公开 API，签名稳定）。
#[link(name = "user32")]
unsafe extern "system" {
    fn PrintWindow(hwnd: HWND, hdc: HDC, flags: u32) -> i32;
}

/// 桌面不变时反复截没有意义，变了也就晚两秒
const CACHE_TTL: Duration = Duration::from_secs(2);
const PW_RENDERFULLCONTENT: u32 = 2;

struct Snapshot {
    taken: Instant,
    left: i32,
    top: i32,
    width: u32,
    height: u32,
    /// BGRA，行优先，自上而下
    pixels: Vec<u8>,
}

/// 双屏 3456×1081 一张就是 15MB，所以缓存里放 `Arc`：
/// 命中时只拷一个指针，不拷像素
static CACHE: Mutex<Option<Arc<Snapshot>>> = Mutex::new(None);

fn capture() -> Result<Snapshot, String> {
    unsafe {
        let class: Vec<u16> = "Progman\0".encode_utf16().collect();
        let progman = FindWindowW(class.as_ptr(), std::ptr::null());
        if progman.is_null() {
            return Err("找不到桌面窗口（Progman）".to_string());
        }

        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(progman, &mut rect) == 0 {
            return Err("读不到桌面窗口的矩形".to_string());
        }
        let width = (rect.right - rect.left).max(1) as u32;
        let height = (rect.bottom - rect.top).max(1) as u32;

        let screen = GetDC(std::ptr::null_mut());
        if screen.is_null() {
            return Err("拿不到屏幕 DC".to_string());
        }
        let mem = CreateCompatibleDC(screen);
        let bitmap = CreateCompatibleBitmap(screen, width as i32, height as i32);
        let previous = SelectObject(mem, bitmap);

        let printed = PrintWindow(progman, mem, PW_RENDERFULLCONTENT);

        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = width as i32;
        // 负高度 = 自上而下，省得每行都翻
        info.bmiHeader.biHeight = -(height as i32);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB;

        let mut pixels = vec![0u8; (width * height * 4) as usize];
        let rows = GetDIBits(
            mem,
            bitmap,
            0,
            height,
            pixels.as_mut_ptr() as *mut core::ffi::c_void,
            &mut info,
            DIB_RGB_COLORS,
        );

        SelectObject(mem, previous);
        DeleteObject(bitmap);
        DeleteDC(mem);
        ReleaseDC(std::ptr::null_mut(), screen);

        if printed == 0 {
            return Err("PrintWindow(桌面) 返回失败".to_string());
        }
        if rows == 0 {
            return Err("GetDIBits 没拿到像素".to_string());
        }

        Ok(Snapshot {
            taken: Instant::now(),
            left: rect.left,
            top: rect.top,
            width,
            height,
            pixels,
        })
    }
}

fn snapshot() -> Result<Arc<Snapshot>, String> {
    // 命中缓存就拷一个 Arc 出去 —— 调用方要的是裁剪，不该占着锁
    let cached = {
        let guard = CACHE.lock().map_err(|_| "缓存锁被毒化".to_string())?;
        guard
            .as_ref()
            .filter(|snap| snap.taken.elapsed() < CACHE_TTL)
            .cloned()
    };
    if let Some(snap) = cached {
        return Ok(snap);
    }

    let fresh = Arc::new(capture()?);
    let mut guard = CACHE.lock().map_err(|_| "缓存锁被毒化".to_string())?;
    *guard = Some(Arc::clone(&fresh));
    Ok(fresh)
}

/// 从快照里裁一块，越界的地方用边缘像素复制。
///
/// 窗口贴着屏幕边时，想要的那块会有一部分在桌面之外；不补的话宿主页的
/// canvas 会在边上露出一条透明缝（模糊之后就是一条发黑的边）。
fn crop(snap: &Snapshot, x: i32, y: i32, w: u32, h: u32) -> Vec<u8> {
    let mut out = Vec::with_capacity((w * h * 4) as usize);
    let max_x = snap.left + snap.width as i32 - 1;
    let max_y = snap.top + snap.height as i32 - 1;

    for row in 0..h {
        let sy = (y + row as i32).clamp(snap.top, max_y) - snap.top;
        for col in 0..w {
            let sx = (x + col as i32).clamp(snap.left, max_x) - snap.left;
            let i = ((sy as u32 * snap.width + sx as u32) * 4) as usize;
            out.push(snap.pixels[i + 2]);
            out.push(snap.pixels[i + 1]);
            out.push(snap.pixels[i]);
            out.push(255);
        }
    }
    out
}

/// 取"我背后那块桌面"，给宿主页当磨砂底。
///
/// `pad` 是逻辑像素的外扩量：宿主页要把图铺得比卡片大一圈，模糊的边缘才落在
/// 卡片外面（否则四条边会发黑）。返回的图比窗口大 `2 × pad`。
#[tauri::command]
pub async fn widget_wallpaper(
    window: tauri::WebviewWindow,
    pad: u32,
) -> Result<Response, String> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let hwnd = match window.window_handle().map(|h| h.as_raw()) {
        Ok(RawWindowHandle::Win32(win32)) => win32.hwnd.get() as HWND,
        _ => return Err("拿不到窗口句柄".to_string()),
    };

    let scale = window.scale_factor().unwrap_or(1.0);
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    if unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
        return Err("读不到组件窗口的位置".to_string());
    }

    let pad_px = (pad as f64 * scale).round() as i32;
    let x = rect.left - pad_px;
    let y = rect.top - pad_px;
    let w = ((rect.right - rect.left).max(1) as i32 + pad_px * 2) as u32;
    let h = ((rect.bottom - rect.top).max(1) as i32 + pad_px * 2) as u32;

    let snap = snapshot()?;
    let pixels = crop(&snap, x, y, w, h);
    let mut body = Vec::with_capacity(8 + pixels.len());
    body.extend_from_slice(&w.to_le_bytes());
    body.extend_from_slice(&h.to_le_bytes());
    body.extend_from_slice(&pixels);

    Ok(Response::new(body))
}
