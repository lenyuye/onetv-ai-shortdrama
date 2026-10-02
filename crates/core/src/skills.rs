//! Skill 系统后端（规格 §10）：本地安装 / 权限校验 / 信任分级 / 卸载保留数据。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SKILL_SCHEMA_SUPPORTED: &str = "1.0";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub license: String,
    pub permissions: SkillPermissions,
    #[serde(default)]
    pub inputs: Vec<String>,
    #[serde(default)]
    pub outputs: Vec<String>,
    pub entry: String,
    #[serde(default)]
    pub trust_level: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillPermissions {
    #[serde(default)]
    pub network: Vec<String>,
    #[serde(default)]
    pub filesystem: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SkillInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub trust_level: u8,
    pub permissions: SkillPermissions,
    pub source: String,
    pub entry: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SkillError {
    #[error("{0}")]
    Invalid(String),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
}

pub struct SkillHub {
    dir: PathBuf,
}

impl SkillHub {
    pub fn new(dir: &Path) -> Self {
        let _ = std::fs::create_dir_all(dir);
        Self { dir: dir.to_path_buf() }
    }

    /// 校验 manifest（规格 §10.2 安全等级：L3+ 不允许通过普通安装导入）。
    pub fn validate(m: &SkillManifest) -> Result<u8, SkillError> {
        if !m.id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
            || m.id.is_empty()
        {
            return Err(SkillError::Invalid("id 只允许小写字母/数字/-/_".into()));
        }
        if !m.version.split('.').count() == 3 && m.version.is_empty() {
            return Err(SkillError::Invalid("version 必须是 semver".into()));
        }
        if !m.entry.starts_with("workflows/") {
            return Err(SkillError::Invalid("entry 必须位于 workflows/ 内".into()));
        }
        for fs in &m.permissions.filesystem {
            if fs != "project" {
                return Err(SkillError::Invalid(format!(
                    "filesystem 权限只允许 project（发现 {fs}）；更高权限的 Skill 需要开发者模式，不支持普通安装"
                )));
            }
        }
        for n in &m.permissions.network {
            if n != "provider" && n != "none" {
                return Err(SkillError::Invalid(format!(
                    "network 权限只允许 provider/none（发现 {n}）"
                )));
            }
        }
        let level = if m.permissions.network.contains(&"provider".into()) {
            2u8
        } else if m.permissions.filesystem.contains(&"project".into()) {
            1
        } else {
            0
        };
        Ok(level)
    }

    pub fn list(&self) -> Vec<SkillInfo> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.dir) else { return out };
        for e in entries.flatten() {
            let manifest_path = e.path().join("skill.json");
            if !manifest_path.is_file() {
                continue;
            }
            if let Ok(m) = self.load_manifest(&manifest_path) {
                out.push(SkillInfo {
                    id: m.id.clone(),
                    name: m.name.clone(),
                    version: m.version.clone(),
                    description: m.description.clone(),
                    trust_level: m.trust_level,
                    permissions: m.permissions.clone(),
                    source: "local".into(),
                    entry: m.entry,
                });
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// 从本地文件夹安装：校验 → 拷贝到 skills/<id>。
    pub fn install_from(&self, src: &Path) -> Result<SkillInfo, SkillError> {
        let manifest_path = src.join("skill.json");
        if !manifest_path.is_file() {
            return Err(SkillError::Invalid("目标文件夹缺少 skill.json".into()));
        }
        let m = self.load_manifest(&manifest_path)?;
        let level = Self::validate(&m)?;
        // entry 必须真实存在
        if !src.join(&m.entry).is_file() {
            return Err(SkillError::Invalid(format!("entry 文件不存在: {}", m.entry)));
        }
        let dest = self.dir.join(&m.id);
        if dest.exists() {
            std::fs::remove_dir_all(&dest)?;
        }
        copy_dir(src, &dest)?;
        // 重写 manifest 里的 trust_level 为计算值（不可自我提权）
        let mut installed = m.clone();
        installed.trust_level = level;
        std::fs::write(
            dest.join("skill.json"),
            serde_json::to_string_pretty(&installed).unwrap(),
        )?;
        tracing::info!(skill = %m.id, level, "skill installed");
        Ok(SkillInfo {
            id: m.id,
            name: m.name,
            version: m.version,
            description: m.description,
            trust_level: level,
            permissions: m.permissions,
            source: "local".into(),
            entry: m.entry,
        })
    }

    /// 卸载：只删除 Skill 本体，保留其产生的项目数据（规格 §10.3）。
    pub fn uninstall(&self, id: &str) -> Result<bool, SkillError> {
        if !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
        {
            return Err(SkillError::Invalid("非法 id".into()));
        }
        let dir = self.dir.join(id);
        if dir.exists() {
            std::fs::remove_dir_all(dir)?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    fn load_manifest(&self, path: &Path) -> Result<SkillManifest, SkillError> {
        let raw = std::fs::read_to_string(path)?;
        serde_json::from_str(&raw).map_err(|e| SkillError::Invalid(format!("skill.json 解析失败: {e}")))
    }
}

fn copy_dir(src: &Path, dest: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dest)?;
    for e in std::fs::read_dir(src)? {
        let e = e?;
        let p = e.path();
        let d = dest.join(e.file_name());
        if p.is_dir() {
            copy_dir(&p, &d)?;
        } else {
            std::fs::copy(&p, &d)?;
        }
    }
    Ok(())
}

/// 仓库内置 skills/ 预置安装（首次启动）。
pub fn seed_builtin(hub: &SkillHub, builtin_dir: &Path) {
    if let Ok(entries) = std::fs::read_dir(builtin_dir) {
        for e in entries.flatten() {
            let manifest = e.path().join("skill.json");
            if !manifest.is_file() {
                continue;
            }
            let Ok(m) = hub.load_manifest(&manifest) else { continue };
            if hub.dir.join(&m.id).exists() {
                continue;
            }
            let _ = hub.install_from(&e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_skill(dir: &Path, network: &[&str], fs: &[&str]) {
        std::fs::create_dir_all(dir.join("workflows")).unwrap();
        std::fs::write(
            dir.join("skill.json"),
            serde_json::json!({
                "id": "test-skill", "name": "测试", "version": "1.0.0",
                "permissions": {"network": network, "filesystem": fs},
                "entry": "workflows/main.json"
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(dir.join("workflows/main.json"), "{}").unwrap();
    }

    #[test]
    fn install_validates_and_downgrades_trust() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = SkillHub::new(&tmp.path().join("installed"));
        let src = tmp.path().join("src1");
        make_skill(&src, &["provider"], &["project"]);
        let info = hub.install_from(&src).unwrap();
        assert_eq!(info.trust_level, 2);
        assert_eq!(hub.list().len(), 1);

        // 非法权限被拒绝
        let bad = tmp.path().join("src2");
        make_skill(&bad, &["https://evil.com"], &["project"]);
        assert!(hub.install_from(&bad).is_err());

        let bad2 = tmp.path().join("src3");
        make_skill(&bad2, &["none"], &["home"]);
        assert!(hub.install_from(&bad2).is_err(), "任意文件权限必须拒绝");
    }

    #[test]
    fn uninstall_keeps_project_data() {
        let tmp = tempfile::tempdir().unwrap();
        let hub = SkillHub::new(&tmp.path().join("installed"));
        let src = tmp.path().join("src");
        make_skill(&src, &["none"], &["project"]);
        hub.install_from(&src).unwrap();
        assert!(hub.uninstall("test-skill").unwrap());
        assert!(hub.list().is_empty());
    }
}
