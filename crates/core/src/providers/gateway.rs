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
    /// 允许重定向：仅用于 download（无鉴权头，跨域 CDN 场景）
    client: reqwest::Client,
    /// 禁止自动重定向：send_json 专用——携带鉴权头的请求若被 302 转发，
    /// 密钥会发往任意跳转目标（绕过白名单）。手动逐跳跟随并重新过策略（v2.12.0）
    direct_client: reqwest::Client,
    policy: Arc<RwLock<NetworkPolicy>>,
    audit: Arc<AuditLog>,
}

/// 解析 Location（相对路径按当前 URL 拼接）
fn resolve_redirect(current: &str, location: &str) -> GatewayResult<String> {
    if location.starts_with("http://") || location.starts_with("https://") {
        return Ok(location.to_string());
    }
    if let Some(rest) = current.split_once("://").map(|(_, r)| r) {
        let authority = rest.split('/').next().unwrap_or_default();
        if location.starts_with('/') {
            let (scheme, _) = current.split_once("://").unwrap();
            return Ok(format!("{scheme}://{authority}{location}"));
        }
        let dir = rest
            .split_once('/')
            .map(|(_, r)| r)
            .and_then(|r| r.rsplit_once('/').map(|(d, _)| d))
            .unwrap_or_default();
        return Ok(format!(
            "{}://{}{}/{}",
            current.split_once("://").unwrap().0,
            authority,
            dir,
            location
        ));
    }
    Err(GatewayError::Parse(format!("无法解析重定向目标: {location}")))
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
        let direct_client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(20))
            .user_agent(concat!("OneTV/", env!("CARGO_PKG_VERSION")))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("http client (no-redirect)");
        Self { client, direct_client, policy, audit }
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

        let mut redirects_used = 0u8;
        // 手动跟随重定向（最多 3 跳）：每一跳重新过策略 + 重新挂鉴权，
        // 301/302/303 按语义转 GET；307/308 保持原方法与 body
        let mut current_url = url.to_string();
        let mut current_method = method;
        let mut current_body = body;
        let resp = loop {
            let mut req = self
                .direct_client
                .request(current_method.clone(), &current_url)
                .timeout(Duration::from_millis(profile.timeout_ms));
            req = self.apply_auth(req, profile)?;
            for (k, v) in &headers {
                req = req.header(k, v);
            }
            if let Some(b) = &current_body {
                req = req.json(b);
            }
            let resp = req
                .send()
                .await
                .map_err(|e| GatewayError::Network(onetv_security::redact::redact_text(&e.to_string())))?;
            let status = resp.status().as_u16();
            if (300..400).contains(&status) {
                if redirects_used >= 3 {
                    return Err(GatewayError::Network("重定向次数超限（3 跳）".into()));
                }
                redirects_used += 1;
                let loc = resp
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| GatewayError::Http { status, body: "重定向缺少 Location".into() })?
                    .to_string();
                let next = resolve_redirect(&current_url, &loc)?;
                self.check(&next)?;
                if matches!(status, 301 | 302 | 303) {
                    current_method = reqwest::Method::GET;
                    current_body = None;
                }
                current_url = next;
                continue;
            }
            break resp;
        };
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
            // 可灵开放平台（v2.7.2）：密钥存 "AK:SK"，每次请求现场签发短时 JWT（HS256）
            "kling-jwt" => {
                let secret = self.secret_for(profile)?;
                let token = kling_jwt(&secret).map_err(|e| GatewayError::Parse(format!("可灵 JWT 签名失败: {e}")))?;
                Ok(req.bearer_auth(&token))
            }
            _ => Ok(req),
        }
    }
}

/// 可灵开放平台 JWT（HS256）：header {alg:HS256,typ:JWT}，
/// payload {iss:AK, exp:now+1800, nbf:now-5}，SK 签名，base64url 无填充。
/// 密钥约定存 "AK:SK"（一个钥匙串条目）。
pub fn kling_jwt(ak_sk: &str) -> Result<String, String> {
    use base64::Engine as _;
    use hmac::Mac as _;
    let (ak, sk) = ak_sk
        .split_once(':')
        .ok_or_else(|| "密钥格式应为 AK:SK（可灵开放平台的 AccessKey 与 SecretKey 用冒号拼接）".to_string())?;
    let ak = ak.trim();
    let sk = sk.trim();
    if ak.is_empty() || sk.is_empty() {
        return Err("AK 或 SK 为空".into());
    }
    let b64 = |bytes: &[u8]| base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes);
    let now = chrono::Utc::now().timestamp();
    let header = b64(br#"{"alg":"HS256","typ":"JWT"}"#);
    let payload = b64(
        serde_json::json!({ "iss": ak, "exp": now + 1800, "nbf": now - 5 })
            .to_string()
            .as_bytes(),
    );
    let signing_input = format!("{header}.{payload}");
    let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(sk.as_bytes())
        .map_err(|e| e.to_string())?;
    mac.update(signing_input.as_bytes());
    let sig = b64(&mac.finalize().into_bytes());
    Ok(format!("{signing_input}.{sig}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kling_jwt_shape_and_signature() {
        use base64::Engine as _;
        let token = kling_jwt("ak-test:sk-test").unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        assert_eq!(parts.len(), 3);
        let dec = |s: &str| String::from_utf8(base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(s).unwrap()).unwrap();
        assert!(dec(parts[0]).contains(r#""alg":"HS256""#));
        let payload = dec(parts[1]);
        assert!(payload.contains(r#""iss":"ak-test""#), "payload: {payload}");
        assert!(payload.contains("exp") && payload.contains("nbf"));
        // 签名可被同一 SK 验证
        use hmac::Mac as _;
        let mut mac = hmac::Hmac::<sha2::Sha256>::new_from_slice(b"sk-test").unwrap();
        mac.update(format!("{}.{}", parts[0], parts[1]).as_bytes());
        assert!(mac.verify_slice(base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(parts[2]).unwrap().as_ref()).is_ok());
        // 格式错误必须报错
        assert!(kling_jwt("no-colon").is_err());
    }

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
