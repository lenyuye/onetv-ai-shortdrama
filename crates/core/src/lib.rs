//! OneTV 核心：应用设置、数据目录、最近工作区、Provider 体系、Agent 引擎、Job 队列。

pub mod agent;
pub mod auth;
pub mod jobs;
pub mod qc;
pub mod mail;
pub mod pkg;
pub mod plugins;
pub mod skills;
pub mod providers;
pub mod settings;

pub use settings::{AppSettings, SettingsStore};

use std::path::PathBuf;
use std::sync::OnceLock;

use tracing_subscriber::fmt::format::Writer as FmtWriter;
use tracing_subscriber::fmt::time::FormatTime;

/// 应用数据目录：~/Library/Application Support/OneTV (macOS)
pub fn app_data_dir() -> PathBuf {
    match dirs::data_dir() {
        Some(d) => d.join("OneTV"),
        None => {
            tracing::warn!("无法定位系统数据目录，回退到当前目录 ./OneTV（数据可能不可持久）");
            PathBuf::from(".").join("OneTV")
        }
    }
}

/// 日志时间戳使用本地时间，与日志文件名（Local 命名）保持一致。
/// tracing-subscriber 未启用 chrono feature，故用 chrono 自定义 timer。
struct LocalTimer;

impl FormatTime for LocalTimer {
    fn format_time(&self, w: &mut FmtWriter<'_>) -> std::fmt::Result {
        write!(w, "{}", chrono::Local::now().format("%Y-%m-%dT%H:%M:%S%.3f%:z"))
    }
}

/// 保证 init_tracing 每个进程只生效一次：重复调用不再新建日志文件
///（此前重复初始化会留下一个从未写入的 0 字节文件）。
static TRACING_INITIALIZED: OnceLock<()> = OnceLock::new();

pub fn init_tracing() {
    if TRACING_INITIALIZED.get().is_some() {
        return;
    }
    let dir = app_data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let path = dir.join(format!("onetv-{ts}.log"));
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .or_else(|_| std::fs::File::create(std::path::Path::new("/dev/null")));
    let Ok(file) = file else { return };
    // 同步 writer：每条事件直写文件（append 打开、无缓冲），不需要 non-blocking 的 guard 保活
    let initialized = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,onetv*=debug".into()),
        )
        .with_writer(move || {
            file.try_clone()
                .unwrap_or_else(|_| std::fs::File::create("/dev/null").unwrap())
        })
        .with_timer(LocalTimer)
        .with_ansi(false)
        .try_init()
        .is_ok();
    let _ = TRACING_INITIALIZED.set(());
    // 每次进程启动必须留下一条记录：避免静默重启/早期退出产生 0 字节日志
    tracing::info!(
        pid = std::process::id(),
        version = env!("CARGO_PKG_VERSION"),
        log = %path.display(),
        initialized,
        "app started"
    );
}
