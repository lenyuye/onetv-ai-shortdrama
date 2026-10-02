//! OS Secret Store 封装（规格 §9.3 / §22.13）。
//!
//! 硬规则：
//! - API Key 只允许进入 OS Secret Store（macOS Keychain / Windows Credential Manager）；
//! - 严禁写入 project.json、SQLite、日志、Crash report、Git；
//! - 本模块是唯一可以“读取”原始 Key 的地方，且读取结果只能交给 Provider Gateway。

use keyring::Entry;

use thiserror::Error;

const SERVICE: &str = "OneTV";

#[derive(Debug, Error)]
pub enum SecretError {
    #[error("Keychain 错误: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("providerId 不合法: {0}")]
    BadId(String),
}

pub struct SecretStore;

fn validate_provider_id(id: &str) -> Result<(), SecretError> {
    let ok = !id.is_empty()
        && id.len() <= 128
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if ok {
        Ok(())
    } else {
        Err(SecretError::BadId(id.to_string()))
    }
}

fn entry(provider_id: &str) -> Result<Entry, SecretError> {
    validate_provider_id(provider_id)?;
    // keyRef 约定: secret://provider/<id> → Keychain 条目 service=OneTV user=provider/<id>
    Ok(Entry::new(SERVICE, &format!("provider/{provider_id}"))?)
}

impl SecretStore {
    pub fn set(provider_id: &str, key: &str) -> Result<(), SecretError> {
        if key.trim().is_empty() {
            return Err(SecretError::BadId("key 为空".into()));
        }
        // keyring v3 的 set_password 语义为创建或覆盖
        entry(provider_id)?.set_password(key)?;
        tracing::info!(provider = provider_id, "secret stored (value never logged)");
        Ok(())
    }

    /// 仅 Provider Gateway 内部使用；禁止将返回值写入任何日志/文件。
    pub fn get(provider_id: &str) -> Result<Option<String>, SecretError> {
        match entry(provider_id)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(err.into()),
        }
    }

    pub fn delete(provider_id: &str) -> Result<(), SecretError> {
        let e = entry(provider_id)?;
        match e.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(err.into()),
        }
    }

    /// 列出已存 Key 的 providerId（只返回 ID，绝不返回值）。
    pub fn list_ids() -> Vec<String> {
        // keyring crate 不提供枚举；由应用层维护 provider 注册表，
        // 逐个 exists 查询即可。此处返回空，注册表见 provider registry。
        Vec::new()
    }

    pub fn exists(provider_id: &str) -> bool {
        match entry(provider_id) {
            Ok(e) => matches!(e.get_password(), Ok(_)),
            Err(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_bad_ids() {
        assert!(validate_provider_id("my-provider_1").is_ok());
        assert!(validate_provider_id("../evil").is_err());
        assert!(validate_provider_id("").is_err());
        assert!(validate_provider_id("has space").is_err());
    }
}
