//! OpenAI 兼容驱动（规格 §22.3，P0）：/chat/completions、/models、/images/generations、/audio/speech。
//! 兼容差异处理：models 读取失败允许手工填写；vision/tools 由 capability matrix 控制。

use serde_json::json;

use super::gateway::{Gateway, GatewayError, GatewayResult};
use super::{ProviderProfile, ProviderDriverKind};

pub fn join_url(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

impl ChatMessage {
    pub fn system(c: impl Into<String>) -> Self {
        Self { role: "system".into(), content: c.into() }
    }
    pub fn user(c: impl Into<String>) -> Self {
        Self { role: "user".into(), content: c.into() }
    }
    pub fn assistant(c: impl Into<String>) -> Self {
        Self { role: "assistant".into(), content: c.into() }
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct ChatResult {
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<serde_json::Value>,
}

pub async fn chat(
    gw: &Gateway,
    profile: &ProviderProfile,
    model: &str,
    messages: &[ChatMessage],
    json_mode: bool,
    max_tokens: Option<u64>,
    temperature: Option<f64>,
) -> GatewayResult<ChatResult> {
    if profile.driver == ProviderDriverKind::Mock {
        return Err(GatewayError::PolicyDenied("mock 驱动请走 mock::chat".into()));
    }
    let url = join_url(&profile.base_url, "chat/completions");
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": false,
    });
    if json_mode {
        body["response_format"] = json!({"type": "json_object"});
    }
    if let Some(t) = max_tokens {
        body["max_tokens"] = json!(t);
    }
    if let Some(t) = temperature {
        body["temperature"] = json!(t);
    }
    let egress = json!({
        "endpoint": url,
        "data": "text prompt（含系统/用户消息）",
        "model": model,
        "sensitive": "prompt 文本将发送给该服务商"
    });
    let resp = gw
        .send_json(profile, reqwest::Method::POST, &url, vec![], Some(body), egress)
        .await?;
    let text = resp
        .pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .ok_or_else(|| GatewayError::Parse(format!("响应缺少 choices[0].message.content: {}", resp)))?
        .to_string();
    Ok(ChatResult { text, usage: resp.get("usage").cloned() })
}

/// 流式 chat（v2.6.2 SSE）：POST stream=true，逐 delta 回调 on_delta，
/// 返回拼接后的完整文本。SSE 行格式：`data: {json}` / `data: [DONE]`。
/// 网络分片可能把一行拆到多个 chunk，这里维护行缓冲后再解析。
pub async fn chat_stream(
    gw: &Gateway,
    profile: &ProviderProfile,
    model: &str,
    messages: &[ChatMessage],
    json_mode: bool,
    on_delta: &(dyn Fn(&str) + Send + Sync),
) -> GatewayResult<String> {
    use futures::StreamExt;
    if profile.driver == ProviderDriverKind::Mock {
        return Err(GatewayError::PolicyDenied("mock 驱动请走 mock::chat".into()));
    }
    let url = join_url(&profile.base_url, "chat/completions");
    let mut body = json!({
        "model": model,
        "messages": messages,
        "stream": true,
    });
    if json_mode {
        body["response_format"] = json!({"type": "json_object"});
    }
    let egress = json!({
        "endpoint": url,
        "data": "text prompt（含系统/用户消息）",
        "model": model,
        "sensitive": "prompt 文本将发送给该服务商",
        "stream": true
    });
    let mut byte_stream = gw.send_json_stream(profile, &url, body, egress).await?;
    let mut buf = String::new();
    let mut full = String::new();
    while let Some(chunk) = byte_stream.next().await {
        let bytes = chunk.map_err(|e| GatewayError::Network(e.to_string()))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf[..pos].trim_end_matches('\r').into();
            buf.drain(..=pos);
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                return Ok(full);
            }
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else { continue };
            if let Some(delta) = v.pointer("/choices/0/delta/content").and_then(|c| c.as_str()) {
                if !delta.is_empty() {
                    full.push_str(delta);
                    on_delta(delta);
                }
            }
        }
    }
    Ok(full)
}

pub async fn list_models(gw: &Gateway, profile: &ProviderProfile) -> GatewayResult<Vec<String>> {
    let url = join_url(&profile.base_url, "models");
    let resp = gw
        .send_json(profile, reqwest::Method::GET, &url, vec![], None, json!({"endpoint": url, "data": "none"}))
        .await?;
    let models = resp
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
}

/// 生图：兼容 /images/generations（b64_json 或 url 两种返回）。
/// 返回保存的本地文件路径列表。
pub async fn generate_image(
    gw: &Gateway,
    profile: &ProviderProfile,
    model: &str,
    prompt: &str,
    size: Option<&str>,
    n: u32,
    out_dir: &std::path::Path,
) -> GatewayResult<Vec<std::path::PathBuf>> {
    let url = join_url(&profile.base_url, "images/generations");
    let mut body = json!({ "model": model, "prompt": prompt, "n": n, "response_format": "b64_json" });
    if let Some(s) = size {
        body["size"] = json!(s);
    }
    let egress = json!({
        "endpoint": url,
        "data": "prompt 文本",
        "model": model,
        "sensitive": "生图 prompt 将发送给该服务商"
    });
    let resp = gw
        .send_json(profile, reqwest::Method::POST, &url, vec![], Some(body), egress)
        .await?;
    let mut outs = Vec::new();
    if let Some(arr) = resp.get("data").and_then(|d| d.as_array()) {
        for (i, item) in arr.iter().enumerate() {
            let dest = out_dir.join(format!("img_{}_{}.png", chrono::Utc::now().timestamp_millis(), i));
            if let Some(b64) = item.get("b64_json").and_then(|v| v.as_str()) {
                use base64::Engine;
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(b64)
                    .map_err(|e| GatewayError::Parse(e.to_string()))?;
                std::fs::create_dir_all(out_dir).map_err(|e| GatewayError::Network(e.to_string()))?;
                std::fs::write(&dest, bytes).map_err(|e| GatewayError::Network(e.to_string()))?;
                outs.push(dest);
            } else if let Some(u) = item.get("url").and_then(|v| v.as_str()) {
                outs.push(gw.download(profile, u, &dest).await?);
            }
        }
    }
    if outs.is_empty() {
        return Err(GatewayError::Parse("响应中没有图片数据".into()));
    }
    Ok(outs)
}

/// TTS：兼容 /audio/speech（二进制音频返回）。
pub async fn tts(
    gw: &Gateway,
    profile: &ProviderProfile,
    model: &str,
    text: &str,
    voice: &str,
    out_path: &std::path::Path,
) -> GatewayResult<std::path::PathBuf> {
    let url = join_url(&profile.base_url, "audio/speech");
    let body = json!({ "model": model, "input": text, "voice": voice, "response_format": "mp3" });
    let egress = json!({ "endpoint": url, "data": "配音文本", "model": model, "sensitive": "文本将发送给该服务商" });
    gw.check(&url)?;
    gw.audit_record_manual(&profile.id, &egress);
    let req = gw
        .client()
        .post(&url)
        .timeout(std::time::Duration::from_millis(profile.timeout_ms.max(300_000)))
        .json(&body);
    let resp = gw
        .apply_auth(req, profile)?
        .send()
        .await
        .map_err(|e| GatewayError::Network(e.to_string()))?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        let t = resp.text().await.unwrap_or_default();
        return Err(GatewayError::Http { status, body: onetv_security::redact::redact_text(&t) });
    }
    let bytes = resp.bytes().await.map_err(|e| GatewayError::Network(e.to_string()))?;
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| GatewayError::Network(e.to_string()))?;
    }
    std::fs::write(out_path, &bytes).map_err(|e| GatewayError::Network(e.to_string()))?;
    Ok(out_path.to_path_buf())
}
