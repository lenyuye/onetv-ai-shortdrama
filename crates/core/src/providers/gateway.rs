//! Provider Gateway —— 唯一允许出网的组件（规格 §9.2/§19 安全硬要求）。
//!
//! 每个 `send` 前强制：
//! 1. NetworkPolicy 校验 URL（Local-only / 白名单 / mock）；
//! 2. 生成 EgressRecord 并写审计（脱敏后）；
//! 3. 日志不出现 Authorization header / 完整 token。

use std::sync::Arc;
use std::time::Duration;

use onetv_security::audit::AuditLog;
use onetv_security::policy::PolicyDecision;
use onetv_security::NetworkPolicy;
use parking_lot::RwLock;

use super::{ProviderDriverKind, ProviderProfile};

#[derive(Debug, thiserror::Error)]
pub enum GatewayError {
    #[error("策略拒绝: {0}")]
    PolicyDenied(String),
    #[error("网络错误: {0}")]
    Network(String),
    #[error("HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("密钥未配置: {0}")]
    MissingSecret(String),
    #[error("解析失败: {0}")]
    Parse(String),
}

pub type GatewayResult<T> = Result<T, GatewayError>;

pub struct Gateway {
    client: reqwest::Client,
    policy: Arc<RwLock<NetworkPolicy>>,
    audit: Arc<AuditLog>,
}

fn policy_denied(d: PolicyDecision) -> GatewayError {
    match d {
        PolicyDecision::Denied { reason } => GatewayError::PolicyDenied(reason),
        PolicyDecision::Allowed { reason } => {
            GatewayError::PolicyDenied(format!("内部错误: {reason}"))
        }
    }
}

impl Gateway {
    pub fn new(policy: Arc<RwLock<NetworkPolicy>>, audit: Arc<AuditLog>) -> Self {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .user_agent(concat!("OneTV/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("http client");
        Self { client, policy, audit }
    }

    pub fn check(&self, url: &str) -> GatewayResult<()> {
        let decision = self.policy.read().check_url(url);
        match decision {
            PolicyDecision::Allowed { .. } => Ok(()),
            PolicyDecision::Denied { .. } => Err(policy_denied(decision)),
        }
    }

    /// 发送 JSON 请求并解析 JSON 响应。mock 驱动不应走到这里。
    pub async fn send_json(
        &self,
        profile: &ProviderProfile,
        method: reqwest::Method,
        url: &str,
        headers: Vec<(String, String)>,
        body: Option<serde_json::Value>,
        egress_note: serde_json::Value,
    ) -> GatewayResult<serde_json::Value> {
        if profile.driver == ProviderDriverKind::Mock {
            return Err(GatewayError::PolicyDenied("mock 驱动不出网".into()));
        }
        self.check(url)?;
        self.audit.record("egress.sent", &profile.id, Some(egress_note));

        let mut req = self.client.request(method, url).timeout(Duration::from_millis(profile.timeout_ms));
        req = self.apply_auth(req, profile)?;
        for (k, v) in headers {
            req = req.header(k, v);
        }
        if let Some(b) = body {
            req = req.json(&b);
        }

        let resp = req.send().await.map_err(|e| GatewayError::Network(onetv_security::redact::redact_text(&e.to_string())))?;
        let status = resp.status().as_u16();
        let text = resp.text().await.map_err(|e| GatewayError::Network(e.to_string()))?;
        if !(200..300).contains(&status) {
            // 错误体可能回显 key，先脱敏
            return Err(GatewayError::Http {
                status,
                body: onetv_security::redact::redact_text(&text).chars().take(600).collect(),
            });
        }
        if text.trim().is_empty() {
            return Ok(serde_json::json!({}));
        }
        serde_json::from_str(&text).map_err(|e| GatewayError::Parse(format!("{e}; body: {}", onetv_security::redact::redact_text(&text).chars().take(300).collect::<String>())))
    }

    /// 流式 JSON 请求（v2.6.2 SSE）：策略校验/审计与 send_json 一致，
    /// 返回字节流由调用方解析。流式响应不设总超时（连接超时仍生效），
    /// 调用方需自行处理中断（如任务取消）。
    pub async fn send_json_stream(
        &self,
        profile: &ProviderProfile,
        url: &str,
        body: serde_json::Value,
        egress_note: serde_json::Value,
    ) -> GatewayResult<impl futures::Stream<Item = reqwest::Result<bytes::Bytes>>> {
        if profile.driver == ProviderDriverKind::Mock {
            return Err(GatewayError::PolicyDenied("mock 驱动不出网".into()));
        }
        self.check(url)?;
        self.audit.record("egress.sent", &profile.id, Some(egress_note));

        let req = self.client.post(url);
        let req = self.apply_auth(req, profile)?;
        let resp = req
            .json(&body)
            .send()
            .await
            .map_err(|e| GatewayError::Network(onetv_security::redact::redact_text(&e.to_string())))?;
        let status = resp.status().as_u16();
        if !(200..300).contains(&status) {
            let text = resp.text().await.unwrap_or_default();
            return Err(GatewayError::Http {
                status,
                body: onetv_security::redact::redact_text(&text).chars().take(600).collect(),
            });
        }
        Ok(resp.bytes_stream())
    }

    /// 下载二进制结果到本地路径（校验 URL 策略）。
    pub async fn download(
        &self,
        profile: &ProviderProfile,
        url: &str,
        dest: &std::path::Path,
    ) -> GatewayResult<std::path::PathBuf> {
        self.check(url)?;
        self.audit.record(
            "egress.download",
            &profile.id,
            Some(serde_json::json!({ "url_host": onetv_security::policy::host_of(url).unwrap_or_default() })),
        );
        let resp = self
            .client
            .get(url)
            .timeout(Duration::from_millis(profile.timeout_ms.max(300_000)))
            .send()
            .await
            .map_err(|e| GatewayError::Network(e.to_string()))?;
        if !resp.status().is_success() {
            return Err(GatewayError::Http { status: resp.status().as_u16(), body: String::new() });
        }
        let bytes = resp.bytes().await.map_err(|e| GatewayError::Network(e.to_string()))?;
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| GatewayError::Network(e.to_string()))?;
        }
        std::fs::write(dest, &bytes).map_err(|e| GatewayError::Network(e.to_string()))?;
        Ok(dest.to_path_buf())
    }

    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// 手工记录出站审计（二进制请求路径使用），内容先脱敏。
    pub fn audit_record_manual(&self, provider_id: &str, note: &serde_json::Value) {
        let mut note = note.clone();
        onetv_security::redact::redact_json_value(&mut note);
        self.audit.record("egress.sent", provider_id, Some(note));
    }

    /// 获取 Provider 密钥（仅 Gateway 内部使用，绝不落日志）。
    pub fn secret_for(&self, profile: &ProviderProfile) -> GatewayResult<String> {
        onetv_security::SecretStore::get(&profile.id)
            .map_err(|e| GatewayError::Network(e.to_string()))?
            .ok_or_else(|| GatewayError::MissingSecret(profile.name.clone()))
    }

    /// 按鉴权类型给请求挂上凭据。
    pub fn apply_auth(
        &self,
        req: reqwest::RequestBuilder,
        profile: &ProviderProfile,
    ) -> GatewayResult<reqwest::RequestBuilder> {
        match profile.auth.auth_type.as_str() {
            "bearer" => Ok(req.bearer_auth(&self.secret_for(profile)?)),
            "api-key" | "custom-header" => {
                let header = profile
                    .auth
                    .header_name
                    .clone()
                    .unwrap_or_else(|| "X-API-Key".into());
                Ok(req.header(header, self.secret_for(profile)?))
            }
            _ => Ok(req),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn policy_blocks_non_allowlisted() {
        let dir = tempfile::tempdir().unwrap();
        let audit = Arc::new(AuditLog::new(dir.path()).unwrap());
        let policy = Arc::new(RwLock::new(NetworkPolicy::new(false)));
        let gw = Gateway::new(policy.clone(), audit);
        let mut p = ProviderProfile::new("x", ProviderDriverKind::OpenaiCompatible, "https://api.example.com");
        p.auth.auth_type = "none".into();
        let e = gw
            .send_json(&p, reqwest::Method::GET, "https://evil.example.com/steal", vec![], None, serde_json::json!({}))
            .await
            .unwrap_err();
        assert!(matches!(e, GatewayError::PolicyDenied(_)), "{e:?}");
    }
}
