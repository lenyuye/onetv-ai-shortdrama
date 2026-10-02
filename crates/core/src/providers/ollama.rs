//! Ollama 本地驱动（规格 §8.2/§22.15）：/api/chat、/api/tags。Local-only 模式可用。

use serde_json::json;

use super::gateway::{Gateway, GatewayError, GatewayResult};
use super::openai::ChatMessage;
use super::ProviderProfile;

pub async fn list_models(gw: &Gateway, profile: &ProviderProfile) -> GatewayResult<Vec<String>> {
    let url = super::openai::join_url(&profile.base_url, "api/tags");
    let resp = gw
        .send_json(profile, reqwest::Method::GET, &url, vec![], None, json!({"endpoint": url, "data": "none"}))
        .await?;
    Ok(resp
        .get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("name").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default())
}

pub async fn chat(
    gw: &Gateway,
    profile: &ProviderProfile,
    model: &str,
    messages: &[ChatMessage],
    json_mode: bool,
) -> GatewayResult<super::openai::ChatResult> {
    let url = super::openai::join_url(&profile.base_url, "api/chat");
    let mut format = json!(null);
    if json_mode {
        format = json!("json");
    }
    let body = json!({
        "model": model,
        "messages": messages,
        "stream": false,
        "format": format,
    });
    let egress = json!({"endpoint": url, "data": "本地 Ollama（不出公网）", "model": model});
    let resp = gw
        .send_json(profile, reqwest::Method::POST, &url, vec![], Some(body), egress)
        .await?;
    let text = resp
        .pointer("/message/content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| GatewayError::Parse(format!("Ollama 响应缺少 message.content: {}", resp)))?
        .to_string();
    Ok(super::openai::ChatResult { text, usage: None })
}

/// 健康检查：GET /
pub async fn health(gw: &Gateway, profile: &ProviderProfile) -> GatewayResult<()> {
    let url = profile.base_url.trim_end_matches('/').to_string();
    gw.check(&url)?;
    let resp = gw
        .client()
        .get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .send()
        .await
        .map_err(|e| GatewayError::Network(format!("Ollama 不可达: {e}")))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(GatewayError::Http { status: resp.status().as_u16(), body: String::new() })
    }
}
