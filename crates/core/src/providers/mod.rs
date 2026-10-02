//! Provider 能力协议与注册表（规格 §8 / §22）。
//!
//! 业务层只依赖 Capability，不依赖厂商。所有网络请求必须经 [`gateway::Gateway`]。

pub mod comfyui;
pub mod custom_http;
pub mod gateway;
pub mod mock;
pub mod ollama;
pub mod openai;
pub mod sd;
pub mod router;

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub const PROVIDER_SCHEMA_VERSION: &str = "1.1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Chat,
    Vision,
    StructuredOutput,
    ImageGeneration,
    ImageEdit,
    VideoGeneration,
    VideoEdit,
    VideoExtend,
    Tts,
    Music,
    Embedding,
}

impl Capability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Capability::Chat => "chat",
            Capability::Vision => "vision",
            Capability::StructuredOutput => "structured_output",
            Capability::ImageGeneration => "image_generation",
            Capability::ImageEdit => "image_edit",
            Capability::VideoGeneration => "video_generation",
            Capability::VideoEdit => "video_edit",
            Capability::VideoExtend => "video_extend",
            Capability::Tts => "tts",
            Capability::Music => "music",
            Capability::Embedding => "embedding",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderDriverKind {
    OpenaiCompatible,
    CustomHttp,
    Ollama,
    Mock,
    Comfyui,
    /// Stable Diffusion WebUI（AUTOMATIC1111/Forge，本地生图）
    StableDiffusion,
    Plugin,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderAuth {
    #[serde(rename = "type")]
    pub auth_type: String, // bearer | api-key | custom-header | none
    #[serde(default)]
    pub key_ref: Option<String>,
    #[serde(default)]
    pub header_name: Option<String>,
}

impl Default for ProviderAuth {
    fn default() -> Self {
        Self { auth_type: "bearer".into(), key_ref: None, header_name: None }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelBinding {
    pub model_id: String,
    #[serde(default)]
    pub display_name: String,
    pub capabilities: Vec<Capability>,
    #[serde(default)]
    pub endpoint: Option<String>,
    #[serde(default)]
    pub pricing: Option<serde_json::Value>,
    #[serde(default)]
    pub limits: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderProfile {
    pub id: String,
    pub name: String,
    pub driver: ProviderDriverKind,
    pub base_url: String,
    #[serde(default)]
    pub auth: ProviderAuth,
    pub models: Vec<ModelBinding>,
    #[serde(default = "default_timeout")]
    pub timeout_ms: u64,
    #[serde(default = "default_concurrency")]
    pub concurrency: u32,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub network_policy_id: String,
    #[serde(default)]
    pub created_at: String,
    /// Custom HTTP 驱动的请求模板（规格 §22.4；不含密钥，secret 以 keyRef 引用）
    #[serde(default)]
    pub http_template: Option<serde_json::Value>,
}

fn default_timeout() -> u64 {
    180_000
}
fn default_concurrency() -> u32 {
    2
}
fn default_true() -> bool {
    true
}

impl ProviderProfile {
    pub fn new(name: &str, driver: ProviderDriverKind, base_url: &str) -> Self {
        Self {
            id: format!("provider-{}", uuid::Uuid::new_v4().simple()),
            name: name.into(),
            driver,
            base_url: base_url.into(),
            auth: ProviderAuth::default(),
            models: Vec::new(),
            timeout_ms: default_timeout(),
            concurrency: default_concurrency(),
            enabled: true,
            network_policy_id: "default".into(),
            created_at: chrono::Utc::now().to_rfc3339(),
            http_template: None,
        }
    }

    pub fn key_ref(&self) -> String {
        self.auth
            .key_ref
            .clone()
            .unwrap_or_else(|| format!("secret://provider/{}", self.id))
    }

    pub fn models_with(&self, cap: Capability) -> Vec<&ModelBinding> {
        self.models.iter().filter(|m| m.capabilities.contains(&cap)).collect()
    }
}

/* ---------------- 注册表持久化（不含密钥，keyRef only） ---------------- */

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct ProviderRegistryFile {
    pub schema_version: String,
    pub providers: Vec<ProviderProfile>,
}

#[derive(Clone)]
pub struct ProviderRegistry {
    path: PathBuf,
    providers: BTreeMap<String, ProviderProfile>,
}

impl ProviderRegistry {
    pub fn load(dir: &Path) -> Self {
        let path = dir.join("providers.json");
        let providers: BTreeMap<String, ProviderProfile> = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<ProviderRegistryFile>(&s).ok())
            .map(|f| f.providers.into_iter().map(|p| (p.id.clone(), p)).collect())
            .unwrap_or_default();
        Self { path, providers }
    }

    pub fn list(&self) -> Vec<ProviderProfile> {
        self.providers.values().cloned().collect()
    }

    pub fn get(&self, id: &str) -> Option<ProviderProfile> {
        self.providers.get(id).cloned()
    }

    pub fn upsert(&mut self, profile: ProviderProfile) {
        self.providers.insert(profile.id.clone(), profile);
        self.persist();
    }

    pub fn delete(&mut self, id: &str) -> bool {
        let removed = self.providers.remove(id).is_some();
        if removed {
            self.persist();
        }
        removed
    }

    fn persist(&self) {
        let file = ProviderRegistryFile {
            schema_version: PROVIDER_SCHEMA_VERSION.into(),
            providers: self.providers.values().cloned().collect(),
        };
        if let Ok(json) = serde_json::to_string_pretty(&file) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_roundtrip_without_secrets() {
        let dir = tempfile::tempdir().unwrap();
        let mut reg = ProviderRegistry::load(dir.path());
        let mut p = ProviderProfile::new("我的中转", ProviderDriverKind::OpenaiCompatible, "https://api.example.com/v1");
        p.models.push(ModelBinding {
            model_id: "model-a".into(),
            display_name: "Model A".into(),
            capabilities: vec![Capability::Chat, Capability::Vision],
            endpoint: None,
            pricing: None,
            limits: None,
        });
        reg.upsert(p.clone());
        let reg2 = ProviderRegistry::load(dir.path());
        let got = reg2.get(&p.id).unwrap();
        assert_eq!(got.name, "我的中转");
        assert_eq!(got.models[0].model_id, "model-a");
        // 注册表文件不含任何密钥
        let raw = std::fs::read_to_string(dir.path().join("providers.json")).unwrap();
        assert!(!raw.contains("sk-"));
    }
}
