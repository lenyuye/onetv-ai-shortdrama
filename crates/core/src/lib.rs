//! OneTV 核心：应用设置、数据目录、最近工作区、Provider 体系、Agent 引擎、Job 队列。

pub mod agent;
pub mod auth;
pub mod jobs;
pub mod mail;
pub mod pkg;
pub mod skills;
pub mod providers;
pub mod settings;

pub use settings::{AppSettings, SettingsStore};

use std::path::PathBuf;

/// 应用数据目录：~/Library/Application Support/OneTV (macOS)
pub fn app_data_dir() -> PathBuf {
    dirs::data_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("OneTV")
}

pub fn init_tracing() {
    let dir = app_data_dir().join("logs");
    let _ = std::fs::create_dir_all(&dir);
    let ts = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(format!("onetv-{ts}.log")))
        .or_else(|_| std::fs::File::create(std::path::Path::new("/dev/null")));
    if let Ok(file) = file {
        tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| "info,onetv*=debug".into()),
            )
            .with_writer(move || {
                file.try_clone()
                    .unwrap_or_else(|_| std::fs::File::create("/dev/null").unwrap())
            })
            .with_ansi(false)
            .try_init()
            .ok();
    }
}
