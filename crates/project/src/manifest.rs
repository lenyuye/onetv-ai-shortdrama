//! project.json manifest 读写（可读 JSON 双层保存：JSON 负责 Git/备份/diff，SQLite 负责查询）。

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::error::{ProjectError, ProjectResult};

pub const SCHEMA_VERSION: &str = "1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectMeta {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub logline: Option<String>,
    #[serde(default)]
    pub cover_asset_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default = "default_aspect")]
    pub aspect_ratio: String,
    #[serde(default)]
    pub target_platform: Option<String>,
    #[serde(default)]
    pub privacy: Privacy,
}

fn default_aspect() -> String {
    "9:16".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Privacy {
    pub telemetry: bool,
    pub cloud_sync: bool,
}

impl Default for Privacy {
    fn default() -> Self {
        // 默认值即安全值（规格 §0.2）
        Privacy { telemetry: false, cloud_sync: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EpisodeRef {
    pub id: String,
    pub number: u32,
    pub title: String,
    pub script: String,
    pub storyboard: String,
    pub canvas: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectManifest {
    pub schema_version: String,
    pub project: ProjectMeta,
    #[serde(default)]
    pub provider_profiles: Vec<String>,
    #[serde(default)]
    pub episodes: Vec<EpisodeRef>,
}

impl ProjectManifest {
    pub fn new(title: &str, aspect_ratio: &str) -> Self {
        let now = chrono::Utc::now().to_rfc3339();
        Self {
            schema_version: SCHEMA_VERSION.into(),
            project: ProjectMeta {
                id: uuid::Uuid::new_v4().to_string(),
                title: title.into(),
                logline: None,
                cover_asset_id: None,
                created_at: now.clone(),
                updated_at: now,
                aspect_ratio: aspect_ratio.into(),
                target_platform: None,
                privacy: Privacy::default(),
            },
            provider_profiles: Vec::new(),
            episodes: Vec::new(),
        }
    }

    pub fn load(path: &Path) -> ProjectResult<Self> {
        let raw = std::fs::read_to_string(path)
            .map_err(|e| ProjectError::Invalid(format!("读取 project.json 失败: {e}")))?;
        let m: ProjectManifest = serde_json::from_str(&raw)?;
        if m.schema_version != SCHEMA_VERSION {
            return Err(ProjectError::SchemaVersion(m.schema_version));
        }
        Ok(m)
    }

    pub fn save(&self, path: &Path) -> ProjectResult<()> {
        let mut m = self.clone();
        m.project.updated_at = chrono::Utc::now().to_rfc3339();
        let json = serde_json::to_string_pretty(&m)?;
        std::fs::write(path, json)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("project.json");
        let m = ProjectManifest::new("霓虹夜行", "9:16");
        m.save(&p).unwrap();
        let m2 = ProjectManifest::load(&p).unwrap();
        assert_eq!(m.project.title, m2.project.title);
        assert_eq!(m2.project.privacy.telemetry, false);
    }

    #[test]
    fn rejects_unknown_schema() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("project.json");
        std::fs::write(&p, r#"{"schemaVersion":"9.9","project":{}}"#).unwrap();
        assert!(ProjectManifest::load(&p).is_err());
    }
}
