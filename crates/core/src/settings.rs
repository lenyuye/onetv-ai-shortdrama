//! 应用设置（settings.json，位于应用数据目录；不包含任何密钥）。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

pub const SETTINGS_SCHEMA_VERSION: &str = "1.0";

/// 预算守卫（v2.10）：远程生成（生图/生视频/配音）调用额度
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostGuardSettings {
    pub enabled: bool,
    /// 单项目每日远程生成次数上限
    pub daily_remote_limit: u32,
    /// 单项目累计远程生成次数上限
    pub project_total_limit: u32,
    /// 单项目每日金额上限（元，0 = 不限；按模型单价/次累计，v2.14）
    #[serde(default)]
    pub daily_cost_limit: f64,
    /// 单项目累计金额上限（元，0 = 不限）
    #[serde(default)]
    pub project_cost_limit: f64,
}

impl Default for CostGuardSettings {
    fn default() -> Self {
        Self { enabled: false, daily_remote_limit: 100, project_total_limit: 1000, daily_cost_limit: 0.0, project_cost_limit: 0.0 }
    }
}

/// v2.22 出站 Webhook 回调配置
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WebhookOutConfig {
    /// 总开关（默认关闭）
    pub enabled: bool,
    /// 回调 URL（POST；本地地址直发，远程地址须在 allowed_hosts）
    pub url: String,
    /// 签名密钥（HMAC-SHA256 of body → X-OneTV-Signature；空则不签名）
    pub secret: String,
}

impl Default for WebhookOutConfig {
    fn default() -> Self {
        Self { enabled: false, url: String::new(), secret: String::new() }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// 预算守卫（v2.10）
    #[serde(default)]
    pub cost_guard: CostGuardSettings,
    #[serde(alias = "schema_version")]
    pub schema_version: String,
    pub theme: String,
    pub language: String,
    /// Local-only 完全离线模式
    #[serde(alias = "offline_mode")]
    pub offline_mode: bool,
    /// 恒为 false；产品中不存在任何遥测代码路径
    pub telemetry: bool,
    #[serde(default, alias = "ffmpeg_path")]
    pub ffmpeg_path: Option<String>,
    #[serde(default, alias = "ffprobe_path")]
    pub ffprobe_path: Option<String>,
    #[serde(alias = "max_concurrent_jobs")]
    pub max_concurrent_jobs: u32,
    #[serde(alias = "auto_save_interval_sec")]
    pub auto_save_interval_sec: u32,
    #[serde(default, alias = "default_project_folder")]
    pub default_project_folder: Option<String>,
    /// 最近工作区/工程（不存密钥）
    #[serde(default, alias = "recent_projects")]
    pub recent_projects: Vec<RecentEntry>,
    /// 网络策略：用户明确允许的主机（来自 Provider Base URL）
    #[serde(default, alias = "allowed_hosts")]
    pub allowed_hosts: Vec<String>,
    /// 自定义皮肤图片（存于应用数据目录 themes/ 下的文件名，onetv-app:// 提供）
    #[serde(default)]
    pub skin: Option<String>,
    /// 皮肤不透明度 0.0 ~ 1.0
    #[serde(default = "default_skin_opacity", alias = "skin_opacity")]
    pub skin_opacity: f64,
    /// 最近一次打开的 .ytv 工程目录绝对路径（None = 未打开过；重启后用于恢复）
    #[serde(default)]
    pub last_project: Option<String>,
    /// 各能力默认生成模型（v2.3.5「生成模型设置」）：
    /// key = chat | image | video | tts（推理/文本同 chat 口），value = provider+model。
    #[serde(default, alias = "model_defaults")]
    pub model_defaults: std::collections::HashMap<String, ModelRef>,
    /// Hermes agent 桥接地址（仅允许本机/局域网回环地址；v2.3.5）
    #[serde(default, alias = "hermes_url")]
    pub hermes_url: Option<String>,
    /// 本机回环监听端口（Hermes → OneTV 反向控制入口；0 = 随机不可用，默认 8766）
    #[serde(default = "default_hermes_port", alias = "hermes_listen_port")]
    pub hermes_listen_port: u16,
    /// 是否启用 Hermes 反向控制监听
    #[serde(default, alias = "hermes_enabled")]
    pub hermes_enabled: bool,
    /// v2.22 出站 Webhook 回调：任务终态 POST 到用户配置的 URL
    #[serde(default, alias = "webhook_out")]
    pub webhook_out: WebhookOutConfig,
}

fn default_hermes_port() -> u16 {
    8766
}

/// 默认生成模型引用（能力 → Provider + Model）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelRef {
    pub provider_id: String,
    pub model_id: String,
}

fn default_skin_opacity() -> f64 {
    0.18
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub path: String,
    pub name: String,
    #[serde(alias = "last_opened_at")]
    pub last_opened_at: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            cost_guard: CostGuardSettings::default(),
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
            last_project: None,
            model_defaults: std::collections::HashMap::new(),
            hermes_url: None,
            hermes_listen_port: default_hermes_port(),
            hermes_enabled: false,
            webhook_out: WebhookOutConfig::default(),
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

    #[test]
    fn loads_legacy_snake_case_settings() {
        // v2.2 及之前磁盘上是 snake_case；camelCase 化后必须仍能读取（别名兼容）
        let legacy = r#"{
            "schema_version": "1.0",
            "theme": "light",
            "language": "zh-CN",
            "offline_mode": false,
            "telemetry": false,
            "max_concurrent_jobs": 3,
            "auto_save_interval_sec": 5,
            "recent_projects": [
                {"path": "/tmp/a.ytv", "name": "A", "last_opened_at": "2026-10-02T00:00:00+00:00"}
            ],
            "allowed_hosts": ["http://127.0.0.1:7860"],
            "skin": "skin.png",
            "skin_opacity": 0.14
        }"#;
        let s: AppSettings = serde_json::from_str(legacy).unwrap();
        assert_eq!(s.theme, "light");
        assert_eq!(s.max_concurrent_jobs, 3);
        assert_eq!(s.skin.as_deref(), Some("skin.png"));
        assert!((s.skin_opacity - 0.14).abs() < 1e-9);
        assert_eq!(s.recent_projects[0].last_opened_at.len() > 0, true);
        // camelCase 同样可读（新写入格式）
        let s2: AppSettings =
            serde_json::from_str(r#"{"schemaVersion":"1.0","theme":"dark","language":"zh-CN","offlineMode":true,"telemetry":false,"maxConcurrentJobs":2,"autoSaveIntervalSec":30,"skinOpacity":0.4}"#).unwrap();
        assert!(s2.offline_mode);
        assert!((s2.skin_opacity - 0.4).abs() < 1e-9);
    }
}
