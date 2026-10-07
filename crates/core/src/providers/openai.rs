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
    // MiniMax M3 等模型内联 <think> 推理——最终文本同样剥离
    let text = ThinkFilter::finish(&text);
    Ok(ChatResult { text, usage: resp.get("usage").cloned() })
}

/// 流式 chat（v2.6.2 SSE）：POST stream=true，逐 delta 回调 on_delta，
/// 返回拼接后的完整文本。SSE 行格式：`data: {json}` / `data: [DONE]`。
/// 网络分片可能把一行拆到多个 chunk，这里维护行缓冲后再解析。
/// MiniMax M3/Text-01 等模型会把 `<think>…</think>` 推理过程内联在 content 里输出——
/// 流式与最终文本都要剥离，否则对话气泡会显示整段思考（v2.26.18）。
pub struct ThinkFilter {
    in_think: bool,
    /// 可能是不完整 "<think>" 前缀的尾巴，等下一个分片补全判断
    pending: String,
}

impl ThinkFilter {
    pub fn new() -> Self {
        Self { in_think: false, pending: String::new() }
    }

    /// 输入一个流式分片，返回可展示的文本（可能为空）。
    pub fn push(&mut self, delta: &str) -> String {
        self.pending.push_str(delta);
        let mut out = String::new();
        loop {
            if self.in_think {
                match self.pending.find("</think>") {
                    Some(pos) => {
                        self.pending.drain(..pos + 8);
                        self.in_think = false;
                    }
                    None => {
                        // 仍可能在 think 内；保留可能是 "</think>" 前缀的尾巴（按字符边界截，避免切进多字节字符）
                        let len = self.pending.len();
                        let mut keep = len.saturating_sub(8);
                        while keep < len && !self.pending.is_char_boundary(keep) {
                            keep += 1;
                        }
                        let emit_len = self.pending.rfind('<').unwrap_or(len);
                        let cut = keep.min(emit_len);
                        self.pending.drain(..cut);
                        return out;
                    }
                }
            } else {
                match self.pending.find("<think>") {
                    Some(pos) => {
                        out.push_str(&self.pending[..pos]);
                        self.pending.drain(..pos + 7);
                        self.in_think = true;
                    }
                    None => {
                        // 输出除"可能是 <think> 前缀"尾巴外的全部（按字符边界匹配，避免切进多字节字符）
                        let tail = self.pending.clone();
                        let len = tail.len();
                        let tail_len = (1..=7.min(len))
                            .find(|k| {
                                let start = len - k;
                                tail.is_char_boundary(start) && "<think>".starts_with(&tail[start..])
                            })
                            .unwrap_or(0);
                        let cut = len - tail_len;
                        out.push_str(&tail[..cut]);
                        self.pending.drain(..cut);
                        return out;
                    }
                }
            }
        }
    }

    /// 流结束：清空缓冲并返回完整文本的最终净化版（用于落库/事件）。
    pub fn finish(full: &str) -> String {
        let mut out = String::new();
        let mut rest = full;
        while let Some(a) = rest.find("<think>") {
            out.push_str(&rest[..a]);
            match rest.find("</think>") {
                Some(b) => rest = &rest[b + 8..],
                None => return out, // 未闭合：丢弃剩余
            }
        }
        out.push_str(rest);
        out.trim().to_string()
    }
}

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
    let mut tf = ThinkFilter::new();
    // 流式空闲超时（v2.26.19）：180 秒无任何数据视为流挂死，避免任务永久卡 RUNNING
    const STREAM_IDLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(180);
    loop {
        let chunk = match tokio::time::timeout(STREAM_IDLE_TIMEOUT, byte_stream.next()).await {
            Ok(Some(c)) => c,
            Ok(None) => break, // 流正常结束（未发 [DONE]）
            Err(_) => {
                return Err(GatewayError::Network(
                    "流式响应超时：180 秒未收到任何数据（服务商无响应或连接挂死）".into(),
                ))
            }
        };
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
                    let shown = tf.push(delta);
                    if !shown.is_empty() {
                        on_delta(&shown);
                    }
                }
            }
        }
    }
    // 最终返回值同样剥 <think>（落库/回复事件用这个，不能带推理过程）
    Ok(ThinkFilter::finish(&full))
}

/// 视觉理解（v2.14，项20）：OpenAI 兼容 chat/completions 多模态内容
/// （text + image_url data URI）。返回模型文本回复。
pub async fn vision_describe(
    gw: &Gateway,
    profile: &ProviderProfile,
    model: &str,
    prompt: &str,
    image_data_url: &str,
) -> GatewayResult<String> {
    if profile.driver == ProviderDriverKind::Mock {
        return Err(GatewayError::PolicyDenied("mock 驱动请走 mock::chat".into()));
    }
    let url = join_url(&profile.base_url, "chat/completions");
    let body = json!({
        "model": model,
        "messages": [{
            "role": "user",
            "content": [
                { "type": "text", "text": prompt },
                { "type": "image_url", "image_url": { "url": image_data_url } }
            ]
        }],
        "max_tokens": 500,
    });
    let egress = json!({
        "endpoint": url,
        "data": "关键帧图片 + 分析指令",
        "model": model,
        "sensitive": "视频关键帧将发送给该服务商"
    });
    let resp = gw
        .send_json(profile, reqwest::Method::POST, &url, vec![], Some(body), egress)
        .await?;
    resp.pointer("/choices/0/message/content")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| GatewayError::Parse(format!("视觉响应缺少 choices[0].message.content: {resp}")))
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

#[cfg(test)]
mod think_tests {
    use super::ThinkFilter;

    #[test]
    fn think_filter_stream_and_finish() {
        // 流式分片剥离：think 跨分片也要剥干净
        let mut f = ThinkFilter::new();
        assert_eq!(f.push("你好"), "你好");
        assert_eq!(f.push("<th"), "");
        assert_eq!(f.push("ink>思考"), "");
        assert_eq!(f.push("</th"), "");
        assert_eq!(f.push("ink>答案"), "答案");
        // finish 兜底剥未流式剥离的整块
        assert_eq!(ThinkFilter::finish("<think>推理</think>最终"), "最终");
        assert_eq!(ThinkFilter::finish("无think"), "无think");
        assert_eq!(ThinkFilter::finish("开头<think>未闭合"), "开头");
        // 多字节中文分片回归（v2.26.23）：尾窗切片必须落在字符边界上
        let mut g = ThinkFilter::new();
        assert_eq!(g.push("你好"), "你好");
        assert_eq!(g.push("世界<th"), "世界");
        assert_eq!(g.push("ink>嗯"), "");
        assert_eq!(g.push("</th"), "");
        assert_eq!(g.push("ink>好了"), "好了");
        assert_eq!(ThinkFilter::finish("开头<think>推理中</think>结尾"), "开头结尾");
    }
}
