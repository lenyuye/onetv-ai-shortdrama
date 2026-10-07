//! 邮箱验证码（v2.2）：本机 SMTP 直发验证码，无须任何自建服务器。
//!
//! - 验证码 6 位数字，5 分钟有效，存哈希不存明文，验证一次即失效；
//! - SMTP 配置存本机 mail.json（host/port/发件邮箱/TLS），授权码只进 OS 钥匙串；
//! - 常见服务商预设（QQ/163/126/Gmail/Outlook）+ 自定义；
//! - 未配置 SMTP 时上层可选择降级策略（如仅校验邮箱地址），本模块只负责发信与校验。

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::Digest;

const CODE_TTL_SECS: u64 = 300;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MailConfig {
    pub email: String,
    pub smtp_host: String,
    pub smtp_port: u16,
    /// true = 465 隐式 TLS；false = 587 STARTTLS
    pub use_tls: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum MailError {
    #[error("{0}")]
    Invalid(String),
    #[error("SMTP 发送失败: {0}")]
    Send(String),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
    #[error("序列化: {0}")]
    Serde(#[from] serde_json::Error),
}

pub fn validate_email(email: &str) -> Result<String, MailError> {
    let e = email.trim().to_lowercase();
    let parts: Vec<&str> = e.split('@').collect();
    let ok = parts.len() == 2
        && !parts[0].is_empty()
        && parts[0].len() <= 64
        && parts[1].contains('.')
        && !parts[1].starts_with('.')
        && !parts[1].ends_with('.')
        && parts[1].split('.').all(|s| !s.is_empty())
        && e.len() <= 254
        && e.chars().all(|c| c.is_ascii() && !c.is_whitespace());
    if ok {
        Ok(e)
    } else {
        Err(MailError::Invalid("邮箱地址格式不正确".into()))
    }
}

/// 常见服务商预设（前端也有一份展示用；此处保证后端校验一致）
pub fn preset_for(email: &str) -> Option<(String, u16, bool)> {
    let domain = email.split('@').nth(1)?;
    match domain {
        "qq.com" | "foxmail.com" => Some(("smtp.qq.com".into(), 465, true)),
        "163.com" => Some(("smtp.163.com".into(), 465, true)),
        "126.com" => Some(("smtp.126.com".into(), 465, true)),
        "gmail.com" => Some(("smtp.gmail.com".into(), 465, true)),
        "outlook.com" | "hotmail.com" | "live.com" => {
            Some(("smtp.office365.com".into(), 587, false))
        }
        _ => None,
    }
}

pub fn generate_code() -> String {
    let mut buf = [0u8; 4];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| std::io::Read::read_exact(&mut f, &mut buf))
        .is_err()
    {
        let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
        buf.copy_from_slice(&n.to_le_bytes()[..4]);
    }
    let n = u32::from_le_bytes(buf) % 1_000_000;
    format!("{n:06}")
}

/* ---------------- 验证码存储 ---------------- */

#[derive(Debug, Serialize, Deserialize, Default)]
struct CodeRecord {
    email: String,
    purpose: String,
    code_hash: String,
    expires_at: u64,
    attempts: u32,
}

pub struct VerificationStore {
    path: PathBuf,
}

impl VerificationStore {
    pub fn new(dir: &std::path::Path) -> Self {
        let _ = std::fs::create_dir_all(dir);
        Self { path: dir.join("verify_codes.json") }
    }

    fn load(&self) -> Vec<CodeRecord> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    fn save(&self, records: &[CodeRecord]) -> Result<(), MailError> {
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_string(records)?)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }

    pub fn issue(&self, email: &str, purpose: &str, code: &str) -> Result<(), MailError> {
        let mut records: Vec<CodeRecord> = self
            .load()
            .into_iter()
            .filter(|r| r.expires_at > now_secs() && !(r.email == email && r.purpose == purpose))
            .collect();
        records.push(CodeRecord {
            email: email.into(),
            purpose: purpose.into(),
            code_hash: hash_code(code),
            expires_at: now_secs() + CODE_TTL_SECS,
            attempts: 0,
        });
        self.save(&records)
    }

    /// 校验并消费（一次性）。最多 5 次尝试，防暴力猜码。
    pub fn verify(&self, email: &str, purpose: &str, code: &str) -> Result<(), MailError> {
        let mut records = self.load();
        let now = now_secs();
        let Some(idx) = records
            .iter()
            .position(|r| r.email == email && r.purpose == purpose && r.expires_at > now)
        else {
            return Err(MailError::Invalid("验证码已过期或未发送，请重新获取".into()));
        };
        let r = &mut records[idx];
        if r.attempts >= 5 {
            records.remove(idx);
            self.save(&records)?;
            return Err(MailError::Invalid("尝试次数过多，请重新获取验证码".into()));
        }
        if r.code_hash == hash_code(code) {
            records.remove(idx);
            self.save(&records)?;
            Ok(())
        } else {
            r.attempts += 1;
            self.save(&records)?;
            Err(MailError::Invalid("验证码不正确".into()))
        }
    }

    /// 清除某邮箱某用途的未消费验证码（例如修改绑定邮箱后）。
    pub fn revoke(&self, email: &str, purpose: &str) {
        let records: Vec<CodeRecord> = self
            .load()
            .into_iter()
            .filter(|r| !(r.email == email && r.purpose == purpose))
            .collect();
        let _ = self.save(&records);
    }
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn hash_code(code: &str) -> String {
    let mut h = sha2::Sha256::new();
    h.update(b"onetv-verify:");
    h.update(code.as_bytes());
    hex::encode(h.finalize())
}

/* ---------------- SMTP 发送（阻塞实现，调用方需放在阻塞线程） ---------------- */

pub fn send_code_mail(
    config: &MailConfig,
    auth_code: &str,
    to_email: &str,
    code: &str,
) -> Result<(), MailError> {
    let to = validate_email(to_email)?;
    let from = validate_email(&config.email)?;
    let subject = "OneTV 验证码";
    let ttl_mins = CODE_TTL_SECS / 60;
    let body = format!(
        "你正在 OneTV 中进行邮箱验证。\n\n验证码：{code}\n\n{ttl_mins} 分钟内有效。如非本人操作，请忽略本邮件。\n\n—— OneTV（本机发送，无需回复）"
    );

    use lettre::message::{header::ContentType, Mailbox, SinglePart};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};

    let email = Message::builder()
        .from(Mailbox::new(None, from.parse().map_err(|e| MailError::Invalid(format!("发件邮箱不合法: {e}")))?))
        .to(Mailbox::new(None, to.parse().map_err(|e| MailError::Invalid(format!("收件邮箱不合法: {e}")))?))
        .subject(subject)
        .header(ContentType::TEXT_PLAIN)
        .singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).body(body))
        .map_err(|e| MailError::Invalid(format!("邮件构造失败: {e}")))?;

    let creds = Credentials::new(from.clone(), auth_code.to_string());

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|e| MailError::Send(e.to_string()))?;

    let result = rt.block_on(async move {
        let mailer = if config.use_tls {
            AsyncSmtpTransport::<Tokio1Executor>::relay(&config.smtp_host)
                .map_err(|e| MailError::Send(format!("SMTP 连接配置失败: {e}")))?
                .port(config.smtp_port)
                .credentials(creds)
                .build()
        } else {
            AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&config.smtp_host)
                .map_err(|e| MailError::Send(format!("SMTP 连接配置失败: {e}")))?
                .port(config.smtp_port)
                .credentials(creds)
                .build()
        };
        mailer.send(email).await.map_err(|e| MailError::Send(format!("{e}")))
    })?;

    let _ = result; // Response
    tracing::info!(to = %to, "verification code mail sent");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_format_and_hash() {
        let code = generate_code();
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        let dir = tempfile::tempdir().unwrap();
        let store = VerificationStore::new(dir.path());
        store.issue("a@b.cn", "change", &code).unwrap();
        assert!(store.verify("a@b.cn", "change", &code).is_ok());
        // 一次性：再次验证失败
        assert!(store.verify("a@b.cn", "change", &code).is_err());
    }

    #[test]
    fn wrong_code_counts_attempts() {
        let dir = tempfile::tempdir().unwrap();
        let store = VerificationStore::new(dir.path());
        store.issue("x@y.cn", "reset", "123456").unwrap();
        for _ in 0..5 {
            assert!(store.verify("x@y.cn", "reset", "000000").is_err());
        }
        // 正确码也因次数超限被拒
        assert!(store.verify("x@y.cn", "reset", "123456").is_err());
    }

    #[test]
    fn presets() {
        assert_eq!(preset_for("a@qq.com"), Some(("smtp.qq.com".into(), 465, true)));
        assert_eq!(preset_for("b@163.com"), Some(("smtp.163.com".into(), 465, true)));
        assert_eq!(preset_for("c@whatever.io"), None);
    }

    #[test]
    fn email_validation() {
        assert!(validate_email("a@b.cn").is_ok());
        assert!(validate_email("bad@@b.cn").is_err());
    }
}
