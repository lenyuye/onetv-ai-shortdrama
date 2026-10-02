//! 应用设置（settings.json，位于应用数据目录；不包含任何密钥）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

pub const SETTINGS_SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSettings {
    pub schema_version: String,
    pub theme: String,
    pub language: String,
    /// Local-only 完全离线模式
    pub offline_mode: bool,
    /// 恒为 false；产品中不存在任何遥测代码路径
    pub telemetry: bool,
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
    #[serde(default)]
    pub ffprobe_path: Option<String>,
    pub max_concurrent_jobs: u32,
    pub auto_save_interval_sec: u32,
    #[serde(default)]
    pub default_project_folder: Option<String>,
    /// 最近工作区/工程（不存密钥）
    #[serde(default)]
    pub recent_projects: Vec<RecentEntry>,
    /// 网络策略：用户明确允许的主机（来自 Provider Base URL）
    #[serde(default)]
    pub allowed_hosts: Vec<String>,
    /// 自定义皮肤图片（存于应用数据目录 themes/ 下的文件名，onetv-app:// 提供）
    #[serde(default)]
    pub skin: Option<String>,
    /// 皮肤不透明度 0.0 ~ 1.0
    #[serde(default = "default_skin_opacity")]
    pub skin_opacity: f64,
}

fn default_skin_opacity() -> f64 {
    0.18
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    pub last_opened_at: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            schema_version: SETTINGS_SCHEMA_VERSION.into(),
            theme: "dark".into(),
            language: "zh-CN".into(),
            offline_mode: false,
            telemetry: false,
            ffmpeg_path: None,
            ffprobe_path: None,
            max_concurrent_jobs: 2,
            auto_save_interval_sec: 30,
            default_project_folder: None,
            recent_projects: Vec::new(),
            allowed_hosts: Vec::new(),
            skin: None,
            skin_opacity: default_skin_opacity(),
        }
    }
}

pub struct SettingsStore {
    path: PathBuf,
    cache: Arc<RwLock<AppSettings>>,
}

impl SettingsStore {
    pub fn new(dir: &Path) -> Self {
        let _ = std::fs::create_dir_all(dir);
        let path = dir.join("settings.json");
        let settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<AppSettings>(&s).ok())
            .map(|mut s| {
                // 安全默认值不可被旧文件打开
                s.telemetry = false;
                if s.schema_version != SETTINGS_SCHEMA_VERSION {
                    s.schema_version = SETTINGS_SCHEMA_VERSION.into();
                }
                s
            })
            .unwrap_or_default();
        let store = Self { path, cache: Arc::new(RwLock::new(settings)) };
        store.persist();
        store
    }

    pub fn get(&self) -> AppSettings {
        self.cache.read().clone()
    }

    pub fn update<F: FnOnce(&mut AppSettings)>(&self, f: F) -> AppSettings {
        let mut s = self.cache.write();
        f(&mut s);
        s.telemetry = false; // 硬编码安全默认
        let out = s.clone();
        drop(s);
        self.persist();
        out
    }

    fn persist(&self) {
        if let Ok(json) = serde_json::to_string_pretty(&*self.cache.read()) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    pub fn touch_recent(&self, path: &str, name: &str) {
        self.update(|s| {
            s.recent_projects.retain(|r| r.path != path);
            s.recent_projects.insert(
                0,
                RecentEntry {
                    path: path.into(),
                    name: name.into(),
                    last_opened_at: chrono::Utc::now().to_rfc3339(),
                },
            );
            s.recent_projects.truncate(20);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_and_updates() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path());
        assert_eq!(store.get().telemetry, false);
        assert_eq!(store.get().max_concurrent_jobs, 2);

        store.update(|s| s.max_concurrent_jobs = 4);
        // 重新加载验证持久化
        let store2 = SettingsStore::new(dir.path());
        assert_eq!(store2.get().max_concurrent_jobs, 4);
        assert_eq!(store2.get().telemetry, false);
    }

    #[test]
    fn telemetry_cannot_be_enabled() {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path());
        let s = store.update(|s| s.telemetry = true);
        assert_eq!(s.telemetry, false);
    }
}
