//! 系统指标采样（CPU / 内存 / 磁盘 / 网络）
//!
//! 为什么要有缓存：指标是"一次采样、多处复用"的。五个组件各自每秒拉一次，
//! 如果每次调用都真去问一遍系统，同一秒里会有五次完全相同的采样，CPU 那点
//! 占用还会被算进它自己头上（`GetSystemTimes` 读的是全局计数，采样本身也在
//! 消耗 CPU）。所以这里留一个 1 秒的缓存窗口：窗口内第一个调用者采样，其余
//! 直接拿结果。
//!
//! 为什么不用 `sysinfo` 之类的 crate：这个项目只跑 Windows，需要的四个数
//! 各自对应一个 Win32 调用（`GetSystemTimes` / `GlobalMemoryStatusEx` /
//! `GetDiskFreeSpaceExW` / `GetIfTable2`），加起来不到 200 行。多一个依赖
//! 就要多一份供应链风险，而组件跑的是任意代码 —— 平台自身的依赖越少越好。
//!
//! 速率类指标（CPU 占用、网络吞吐）必须靠两次采样做差，所以缓存里同时存着
//! "上一次的原始计数"。第一次调用没有前值，占用返回 0 —— 这是刻意的：
//! 与其编一个看起来合理的假数字，不如老实说"还没测出来"。

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use windows_sys::Win32::Foundation::FILETIME;
use windows_sys::Win32::NetworkManagement::IpHelper::{
    FreeMibTable, GetIfTable2, IF_TYPE_SOFTWARE_LOOPBACK, MIB_IF_TABLE2,
};
use windows_sys::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows_sys::Win32::System::Threading::GetSystemTimes;

/// 缓存窗口。1 秒对应"组件最细的心跳就是 1 秒"，再密也没有意义
const CACHE_WINDOW: Duration = Duration::from_millis(1000);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Metrics {
    pub cpu: Cpu,
    pub memory: Memory,
    pub disk: Disk,
    pub network: Network,
    /// 采样时刻（Unix 毫秒）。组件可以据此判断这份数据有多旧
    pub sampled_at: u64,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cpu {
    /// 0–1。第一次采样没有前值，返回 0
    pub usage: f64,
    /// 逻辑核数
    pub cores: u32,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub used: u64,
    pub total: u64,
    pub usage: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Disk {
    /// 系统盘盘符，例如 `C:`
    pub mount: String,
    pub used: u64,
    pub total: u64,
    pub usage: f64,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    /// 每秒字节数。第一次采样没有前值，返回 0
    pub rx_per_sec: f64,
    pub tx_per_sec: f64,
    /// 开机以来的累计字节数
    pub rx_total: u64,
    pub tx_total: u64,
}

#[derive(Clone, Copy, Default)]
struct CpuTimes {
    idle: u64,
    total: u64,
}

#[derive(Clone, Copy, Default)]
struct NetTotals {
    rx: u64,
    tx: u64,
}

/// 上一次的原始计数。速率类指标全靠它做差
#[derive(Clone, Copy, Default)]
struct Previous {
    at: Option<Instant>,
    cpu: CpuTimes,
    net: NetTotals,
}

#[derive(Default)]
struct Sampler {
    previous: Previous,
    cached: Option<(Instant, Metrics)>,
}

static SAMPLER: OnceLock<Mutex<Sampler>> = OnceLock::new();

/// 取一份指标。缓存窗口内重复调用不会再问系统
pub fn snapshot() -> Metrics {
    let lock = SAMPLER.get_or_init(|| Mutex::new(Sampler::default()));
    // 采样过程不会 panic，但真被毒化了也不该让组件拿不到数据
    let mut sampler = lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

    if let Some((at, metrics)) = &sampler.cached {
        if at.elapsed() < CACHE_WINDOW {
            return metrics.clone();
        }
    }

    let now = Instant::now();
    let cpu_now = cpu_times();
    let net_now = net_totals();

    // 有前值才谈得上"速率"，没有就报 0
    let (cpu_usage, rx_per_sec, tx_per_sec) = match sampler.previous.at {
        Some(previous_at) => {
            let seconds = now.duration_since(previous_at).as_secs_f64().max(0.001);
            let idle = cpu_now.idle.saturating_sub(sampler.previous.cpu.idle);
            let total = cpu_now.total.saturating_sub(sampler.previous.cpu.total);
            // kernel 时间本身包含 idle，所以忙 = 总 - 空闲
            let usage = if total == 0 { 0.0 } else { (total - idle) as f64 / total as f64 };
            let rx = net_now.rx.saturating_sub(sampler.previous.net.rx) as f64 / seconds;
            let tx = net_now.tx.saturating_sub(sampler.previous.net.tx) as f64 / seconds;
            (usage.clamp(0.0, 1.0), rx, tx)
        }
        None => (0.0, 0.0, 0.0),
    };

    sampler.previous = Previous {
        at: Some(now),
        cpu: cpu_now,
        net: net_now,
    };

    let metrics = Metrics {
        cpu: Cpu {
            usage: cpu_usage,
            cores: std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(0),
        },
        memory: memory(),
        disk: disk(),
        network: Network {
            rx_per_sec,
            tx_per_sec,
            rx_total: net_now.rx,
            tx_total: net_now.tx,
        },
        sampled_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    };

    sampler.cached = Some((now, metrics.clone()));
    metrics
}

/// `GetSystemTimes` 给的是开机以来的累计值，单位 100ns。
/// `kernel` 里已经包含了 `idle`，所以总量是 `kernel + user`。
fn cpu_times() -> CpuTimes {
    let mut idle = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut kernel = idle;
    let mut user = idle;
    let ok = unsafe { GetSystemTimes(&mut idle, &mut kernel, &mut user) };
    if ok == 0 {
        return CpuTimes::default();
    }
    CpuTimes {
        idle: filetime(idle),
        total: filetime(kernel) + filetime(user),
    }
}

fn filetime(value: FILETIME) -> u64 {
    ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64
}

fn memory() -> Memory {
    let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
    status.dwLength = std::mem::size_of::<MEMORYSTATUSEX>() as u32;
    if unsafe { GlobalMemoryStatusEx(&mut status) } == 0 {
        return Memory {
            used: 0,
            total: 0,
            usage: 0.0,
        };
    }
    let total = status.ullTotalPhys;
    let used = total.saturating_sub(status.ullAvailPhys);
    Memory {
        used,
        total,
        usage: if total == 0 { 0.0 } else { used as f64 / total as f64 },
    }
}

fn disk() -> Disk {
    // 系统盘而不是应用数据盘：用户看"磁盘满了没有"看的是 C:
    let mount = std::env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
    let root = format!("{mount}\\");
    let wide: Vec<u16> = root.encode_utf16().chain(std::iter::once(0)).collect();

    let mut available = 0u64;
    let mut total = 0u64;
    let mut free = 0u64;
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut available, &mut total, &mut free) };
    if ok == 0 {
        return Disk {
            mount,
            used: 0,
            total: 0,
            usage: 0.0,
        };
    }
    let used = total.saturating_sub(free);
    Disk {
        mount,
        used,
        total,
        usage: if total == 0 { 0.0 } else { used as f64 / total as f64 },
    }
}

/// 所有"已连接且在工作"的物理网卡字节数之和。
///
/// 跳过回环（`IF_TYPE_SOFTWARE_LOOPBACK`）和没连上的网卡：虚拟网卡、断开的
/// VPN 适配器都会留在表里，把它们算进去，用户会看到一个和实际流量对不上的数。
/// 更细的口径（按网卡分别列出）留给以后 —— 现在这张卡上只放一个总数。
fn net_totals() -> NetTotals {
    let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
    if unsafe { GetIfTable2(&mut table) } != 0 || table.is_null() {
        return NetTotals::default();
    }

    let mut totals = NetTotals::default();
    unsafe {
        let count = (*table).NumEntries as usize;
        // Table 声明成 [MIB_IF_ROW2; 1]，实际是变长数组，按首地址加偏移取
        let rows = (*table).Table.as_ptr();
        for index in 0..count {
            let row = &*rows.add(index);
            if row.OperStatus != IfOperStatusUp || row.Type == IF_TYPE_SOFTWARE_LOOPBACK {
                continue;
            }
            totals.rx = totals.rx.saturating_add(row.InOctets);
            totals.tx = totals.tx.saturating_add(row.OutOctets);
        }
        FreeMibTable(table as *const core::ffi::c_void);
    }
    totals
}

#[tauri::command]
pub fn system_metrics() -> Metrics {
    snapshot()
}
