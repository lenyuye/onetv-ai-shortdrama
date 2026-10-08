//! 自定义 HTTP 驱动（规格 §22.4，P0/P1）。
//!
//! 请求模板 + 响应映射 + 可选异步轮询。模板变量只允许白名单根：
//! `input.*`、`model.id`、`secret.apiKey`、`jobId`；禁止任意脚本执行。

use serde_json::{json, Value};

use super::gateway::{Gateway, GatewayError, GatewayResult};
use super::ProviderProfile;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct HttpTemplate {
    #[serde(default = "default_method")]
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub headers: serde_json::Map<String, Value>,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub response: Option<ResponseMapping>,
    #[serde(default)]
    pub poll: Option<PollConfig>,
}

fn default_method() -> String {
    "POST".into()
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct ResponseMapping {
    #[serde(default)]
    pub job_id: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub result_url: Option<String>,
    #[serde(default)]
    pub result_b64: Option<String>,
    /// hex 编码结果（v2.26.19）：MiniMax t2a_v2 / music_generation 返回 data.audio 为 hex
    #[serde(default)]
    pub result_hex: Option<String>,
}

#[derive(Debug, Clone, serde::Deserialize)]
pub struct PollConfig {
    #[serde(default = "default_poll_method")]
    pub method: String,
    pub url: String,
    #[serde(default = "default_success_when")]
    pub success_when: String,
    #[serde(default)]
    pub failure_when: Option<String>,
    #[serde(default = "default_interval")]
    pub interval_ms: u64,
    #[serde(default = "default_poll_timeout")]
    pub timeout_ms: u64,
}

fn default_poll_method() -> String {
    "GET".into()
}
fn default_success_when() -> String {
    "$.data.status == \"succeeded\"".into()
}
fn default_interval() -> u64 {
    3000
}
fn default_poll_timeout() -> u64 {
    1_800_000
}

/* ---------------- 模板变量白名单解析 ---------------- */

/// 解析 `${expr}`：根只允许 input / model / secret / jobId（规格 §22.4）。
/// v2.26.157 增强（可选参数条件化，避免向远程 API 传 null 被拒）：
/// - 对象字段：值为可选链占位（`${...?}`）且解析为 null → **整个字段省略**；
/// - 数组项：项为可选链占位解析为 null → 整项省略；项为对象且含 `"$if"` 标记 →
///   `$if` 为 null/空串时整项省略（`$if` 不会出现在最终请求体里）。
pub fn render_template(value: &Value, ctx: &Value) -> Result<Value, GatewayError> {
    match value {
        Value::String(s) => {
            // 整串就是一个变量 → 保留类型；否则做字符串拼接
            let trimmed = s.trim();
            if trimmed.starts_with("${") && trimmed.ends_with("}") && trimmed[2..trimmed.len() - 1].find("${").is_none()
            {
                let expr = &trimmed[2..trimmed.len() - 1];
                let resolved = resolve_expr(expr, ctx)?;
                return Ok(resolved);
            }
            let mut out = s.clone();
            while let Some(start) = out.find("${") {
                let Some(end_rel) = out[start..].find('}') else {
                    return Err(GatewayError::Parse(format!("模板未闭合: {out}")));
                };
                let expr = out[start + 2..start + end_rel].trim().to_string();
                let v = resolve_expr(&expr, ctx)?;
                let repl = match v {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                out.replace_range(start..start + end_rel + 1, &repl);
            }
            Ok(Value::String(out))
        }
        Value::Object(map) => {
            let mut out = serde_json::Map::new();
            for (k, v) in map {
                let rendered = render_template(v, ctx)?;
                // 可选链占位解析为 null → 省略该字段（可选参数不发送）
                if rendered.is_null() && is_optional_placeholder(v) {
                    continue;
                }
                out.insert(k.clone(), rendered);
            }
            Ok(Value::Object(out))
        }
        Value::Array(arr) => {
            let mut out = Vec::new();
            for item in arr {
                // 条件项：在**渲染前**读取原始 "$if"（否则会被上面的 null 可选字段省略规则吃掉）
                if let Value::Object(m) = item {
                    if let Some(cond_tpl) = m.get("$if") {
                        let cond = render_template(cond_tpl, ctx)?;
                        let empty = cond.is_null()
                            || cond.as_str().map(|s| s.trim().is_empty()).unwrap_or(false);
                        if empty {
                            continue;
                        }
                        let mut rest = m.clone();
                        rest.remove("$if");
                        out.push(render_template(&Value::Object(rest), ctx)?);
                        continue;
                    }
                }
                let rendered = render_template(item, ctx)?;
                // 项本身是可选链占位且为 null → 整项省略
                if rendered.is_null() && is_optional_placeholder(item) {
                    continue;
                }
                out.push(rendered);
            }
            Ok(Value::Array(out))
        }
        other => Ok(other.clone()),
    }
}

/// 字符串是否整体为一个含可选链（末尾 `?` 段）的占位表达式。
fn is_optional_placeholder(v: &Value) -> bool {
    let Some(s) = v.as_str() else { return false };
    let trimmed = s.trim();
    if !(trimmed.starts_with("${") && trimmed.ends_with("}")) {
        return false;
    }
    let inner = &trimmed[2..trimmed.len() - 1];
    inner.split('.').any(|seg| seg.trim().ends_with('?'))
}

fn resolve_expr(expr: &str, ctx: &Value) -> Result<Value, GatewayError> {
    let expr = expr.trim();
    let mut parts = expr.split('.').peekable();
    let root = parts.next().unwrap_or_default();
    let allowed = matches!(root, "input" | "model" | "secret" | "jobId");
    if !allowed {
        return Err(GatewayError::Parse(format!(
            "模板变量 {root:?} 不在白名单（允许: input/model/secret/jobId）"
        )));
    }
    let mut cur = ctx.clone();
    for p in std::iter::once(root).chain(parts) {
        // 支持 input.image.base64? 形式的可选链
        let (key, optional) = match p.strip_suffix('?') {
            Some(k) => (k, true),
            None => (p, false),
        };
        cur = match cur.get(key) {
            Some(v) => v.clone(),
            None => {
                if optional {
                    Value::Null
                } else {
                    return Err(GatewayError::Parse(format!("模板变量缺失: {expr}")));
                }
            }
        };
    }
    Ok(cur)
}

/// JSONPath-lite：`$.a.b[0].c`（本实现仅支持取值，不支持过滤/通配）。
pub fn json_path(v: &Value, path: &str) -> Option<Value> {
    let path = path.strip_prefix("$.")?;
    let mut cur = v.clone();
    for seg in path.split('.') {
        // seg 可能带 [idx]
        let (key, idx) = match seg.find('[') {
            Some(i) => (&seg[..i], seg[i + 1..].trim_end_matches(']').parse::<usize>().ok()),
            None => (seg, None),
        };
        if !key.is_empty() {
            cur = cur.get(key)?.clone();
        }
        if let Some(i) = idx {
            cur = cur.get(i)?.clone();
        }
    }
    Some(cur)
}

fn eval_condition(resp: &Value, cond: &str) -> bool {
    // 仅支持 `$.path == "value"` 形式
    let Some((lhs, rhs)) = cond.split_once("==") else { return false };
    let lhs = lhs.trim();
    let rhs = rhs.trim().trim_matches('"');
    match json_path(resp, lhs) {
        Some(Value::String(s)) => s == rhs,
        Some(Value::Bool(b)) => b.to_string() == rhs,
        Some(Value::Number(n)) => n.to_string() == rhs,
        _ => false,
    }
}

/* ---------------- 执行 ---------------- */

pub struct CustomHttpOutput {
    pub text: Option<String>,
    pub result_urls: Vec<String>,
    pub remote_job_id: Option<String>,
}

/// 从结果 URL 推导安全的落盘扩展名（v2.26.156）：
/// 剥离查询串/锚点，仅接受 ≤5 位纯字母数字扩展名；不可信时回退 "bin"。
/// 此前 "https://x/a.mp4?e=签名" 会被推导出 "mp4?e"，产物文件名污染全链路。
pub fn result_ext_from_url(u: &str) -> String {
    let path_part = u.split(['?', '#']).next().unwrap_or(u);
    let last_seg = path_part.rsplit('/').next().unwrap_or(path_part);
    last_seg
        .rsplit('.')
        .next()
        .filter(|e| {
            !e.is_empty()
                && e.len() <= 5
                && *e != last_seg // 最后一段没有 '.'（rsplit 返回整段）→ 无扩展名
                && e.chars().all(|c| c.is_ascii_alphanumeric())
        })
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "bin".into())
}

/// 同步执行：POST → 解析响应 → （可选轮询）→ 返回结果。
#[allow(clippy::too_many_arguments)]
pub async fn execute(
    gw: &Gateway,
    profile: &ProviderProfile,
    model_id: &str,
    tmpl: &HttpTemplate,
    input: &Value,
    secret: Option<String>,
    out_dir: &std::path::Path,
    cancel: impl Fn() -> bool,
) -> GatewayResult<CustomHttpOutput> {
    let secret_val = secret.unwrap_or_default();
    let ctx = json!({
        "input": input,
        "model": { "id": model_id },
        "secret": { "apiKey": secret_val }
    });

    let url = render_template(&Value::String(tmpl.url.clone()), &ctx)?;
    let url = url.as_str().ok_or_else(|| GatewayError::Parse("url 模板不是字符串".into()))?.to_string();
    let method = reqwest::Method::from_bytes(tmpl.method.as_bytes())
        .map_err(|_| GatewayError::Parse(format!("非法 HTTP 方法: {}", tmpl.method)))?;
    let mut headers: Vec<(String, String)> = Vec::new();
    for (k, v) in &tmpl.headers {
        let rendered = render_template(v, &ctx)?;
        headers.push((k.clone(), rendered.as_str().unwrap_or_default().to_string()));
    }
    let body = match &tmpl.body {
        Some(b) => Some(render_template(b, &ctx)?),
        None => None,
    };
    let egress = json!({
        "endpoint": url,
        "data": "模板声明的输入字段",
        "model": model_id,
        "sensitive": "见模板 body 白名单变量"
    });
    let mut resp = gw
        .send_json(profile, method, &url, headers.clone(), body, egress)
        .await?;

    let mut remote_job_id = tmpl
        .response
        .as_ref()
        .and_then(|r| r.job_id.as_ref())
        .and_then(|p| json_path(&resp, p))
        .and_then(|v| v.as_str().map(|s| s.to_string()));

    // 异步轮询（规格 §22.5）
    if let (Some(poll), Some(job_id)) = (&tmpl.poll, remote_job_id.clone()) {
        let poll_ctx = json!({ "jobId": job_id, "input": input, "model": { "id": model_id }, "secret": { "apiKey": secret_val } });
        let poll_url = render_template(&Value::String(poll.url.clone()), &poll_ctx)?;
        let poll_url = poll_url.as_str().unwrap_or_default().to_string();
        gw.check(&poll_url)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_millis(poll.timeout_ms);
        loop {
            if cancel() {
                return Err(GatewayError::Network("任务已取消".into()));
            }
            if std::time::Instant::now() > deadline {
                return Err(GatewayError::Network("轮询超时".into()));
            }
            tokio::time::sleep(std::time::Duration::from_millis(poll.interval_ms)).await;
            resp = gw
                .send_json(profile, reqwest::Method::GET, &poll_url, headers.clone(), None, json!({"endpoint": poll_url, "data": "轮询状态"}))
                .await?;
            if let Some(f) = &poll.failure_when {
                if eval_condition(&resp, f) {
                    return Err(GatewayError::Http { status: 500, body: format!("远程任务失败: {resp}") });
                }
            }
            if eval_condition(&resp, &poll.success_when) {
                break;
            }
        }
        // 刷新 remote job id（poll 响应可能更新）
        if let Some(r) = &tmpl.response {
            if let Some(p) = &r.job_id {
                remote_job_id = json_path(&resp, p).and_then(|v| v.as_str().map(|s| s.to_string())).or(remote_job_id);
            }
        }
    }

    let mapping = tmpl.response.clone().unwrap_or(ResponseMapping {
        job_id: None,
        status: None,
        result_url: Some("$.data.output.url".into()),
        result_b64: None,
        result_hex: None,
    });

    let mut text = None;
    if let Some(t) = json_path(&resp, "$.data.text").or_else(|| json_path(&resp, "$.text")) {
        if let Value::String(s) = t {
            text = Some(s);
        }
    }

    let mut result_urls = Vec::new();
    if let Some(p) = &mapping.result_url {
        if let Some(v) = json_path(&resp, p) {
            if let Value::String(u) = v {
                result_urls.push(u);
            } else if let Value::Array(arr) = v {
                for it in arr {
                    if let Value::String(u) = it {
                        result_urls.push(u);
                    }
                }
            }
        }
    }

    // 下载结果
    std::fs::create_dir_all(out_dir).map_err(|e| GatewayError::Network(e.to_string()))?;
    let mut downloaded = Vec::new();

    // base64 结果（v2.6.4）：部分平台（如 Gemini 系图片模型）直接返回内联 base64，
    // 按 response.result_b64 映射解码落盘
    if downloaded.is_empty() {
        if let Some(p) = &mapping.result_b64 {
            if let Some(v) = json_path(&resp, p) {
                if let Value::String(b64) = v {
                    use base64::Engine as _;
                    let clean = b64.split(',').next_back().unwrap_or(&b64); // 兼容 data URI
                    let bytes = base64::engine::general_purpose::STANDARD
                        .decode(clean.trim())
                        .map_err(|e| GatewayError::Parse(format!("base64 结果解码失败: {e}")))?;
                    let dest = out_dir.join(format!("custom_{}.png", chrono::Utc::now().timestamp_millis()));
                    std::fs::write(&dest, &bytes).map_err(|e| GatewayError::Network(e.to_string()))?;
                    downloaded.push(dest.to_string_lossy().into_owned());
                }
            }
        }
    }
    // hex 结果（v2.26.19）：MiniMax t2a_v2 / music_generation 返回 data.audio 为 hex 编码
    if downloaded.is_empty() {
        if let Some(p) = &mapping.result_hex {
            if let Some(v) = json_path(&resp, p) {
                if let Value::String(hexs) = v {
                    let clean: String = hexs
                        .trim()
                        .chars()
                        .filter(|c| c.is_ascii_hexdigit())
                        .collect();
                    if clean.len() % 2 != 0 {
                        return Err(GatewayError::Parse("hex 结果长度为奇数，无法解码".into()));
                    }
                    let bytes = (0..clean.len())
                        .step_by(2)
                        .map(|i| u8::from_str_radix(&clean[i..i + 2], 16))
                        .collect::<Result<Vec<u8>, _>>()
                        .map_err(|e| GatewayError::Parse(format!("hex 结果解码失败: {e}")))?;
                    let dest = out_dir.join(format!(
                        "custom_{}.mp3",
                        chrono::Utc::now().timestamp_millis()
                    ));
                    std::fs::write(&dest, &bytes).map_err(|e| GatewayError::Network(e.to_string()))?;
                    downloaded.push(dest.to_string_lossy().into_owned());
                }
            }
        }
    }
    for (i, u) in result_urls.iter().enumerate() {
        if cancel() {
            return Err(GatewayError::Network("任务已取消".into()));
        }
        // v2.26.156 修复：结果 URL 常带查询串/锚点（如 "xxx.mp4?e=签名"），此前 rsplit('.')
        // 会把 "mp4?e" 整段当扩展名 → 落盘文件名为 *.mp4?e，Finder/播放器无法识别，
        // 且下游按扩展名的媒体类型判断（画布产物节点/预览）全部失灵。
        // 修复 = 先剥离 ?/# 与非法字符，只保留字母数字扩展名（≤5 位），否则回退 bin。
        let ext = crate::providers::custom_http::result_ext_from_url(u);
        let dest = out_dir.join(format!("custom_{}_{}.{}", chrono::Utc::now().timestamp_millis(), i, ext));
        gw.download(profile, u, &dest).await?;
        downloaded.push(dest.to_string_lossy().into_owned());
    }

    if text.is_none() && downloaded.is_empty() && remote_job_id.is_none() {
        return Err(GatewayError::Parse("无法从响应中解析任何结果（检查 response 映射）".into()));
    }

    Ok(CustomHttpOutput { text, result_urls: downloaded, remote_job_id })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn result_ext_strips_query_and_fragments() {
        // v2.26.156 回归：带查询串的结果 URL 不得把 "mp4?e" 当扩展名
        assert_eq!(result_ext_from_url("https://x.com/a/custom_1.mp4?e=abc123"), "mp4");
        assert_eq!(result_ext_from_url("https://x.com/a/v.MOV?t=1#frag"), "mov");
        assert_eq!(result_ext_from_url("https://x.com/a/img.PNG"), "png");
        // 无扩展名 / 主机名点号 / 非法字符 → bin
        assert_eq!(result_ext_from_url("https://x.com/download"), "bin");
        assert_eq!(result_ext_from_url("https://x.com/a.mp4?e=abc/odd"), "mp4");
        assert_eq!(result_ext_from_url("https://x.com/a.超长扩展名"), "bin");
        assert_eq!(result_ext_from_url("not-a-url"), "bin");
    }

    /// v2.26.157 回归：可选链占位为 null 时字段/数组项条件省略
    /// （H3 图生视频：无参考图时不得发送 first_frame 图片项，也不得发 null 字段）
    #[test]
    fn render_template_omits_optional_null() {
        let ctx_empty = json!({ "model": { "id": "MiniMax-H3" }, "input": { "prompt": "跳舞", "firstFrameBase64": null } });
        let tpl = json!({
            "model": "${model.id}",
            "content": [
                { "type": "text", "text": "${input.prompt}" },
                { "$if": "${input.firstFrameBase64?}", "type": "image_url",
                  "image_url": { "url": "${input.firstFrameBase64?}" }, "role": "first_frame" }
            ],
            "duration": 5,
            "first_frame_image": "${input.firstFrameBase64?}"
        });
        let out = render_template(&tpl, &ctx_empty).unwrap();
        // 无参考图 → 图片项与可选字段整体省略
        assert_eq!(out["content"].as_array().unwrap().len(), 1);
        assert!(out.get("first_frame_image").is_none());
        assert!(out["content"][0].get("$if").is_none(), "$if 标记不应出现在请求体");

        // 有参考图 → 图片项保留且注入 data URL
        let ctx_ref = json!({ "model": { "id": "MiniMax-H3" }, "input": { "prompt": "跳舞", "firstFrameBase64": "data:image/png;base64,AAAA" } });
        let out2 = render_template(&tpl, &ctx_ref).unwrap();
        assert_eq!(out2["content"].as_array().unwrap().len(), 2);
        assert_eq!(out2["content"][1]["role"], "first_frame");
        assert_eq!(out2["content"][1]["image_url"]["url"], "data:image/png;base64,AAAA");
        assert_eq!(out2["first_frame_image"], "data:image/png;base64,AAAA");
    }

    /// Mock 自定义平台：submit → poll（2 轮 queued）→ 返回结果 URL → /file 下载。
    /// 实测 execute 全链路（规格 API-03 Mock Server E2E，v2.13）。
    fn spawn_mock_platform() -> String {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let addr_for_server = addr.clone();
        std::thread::spawn(move || {
            let addr = addr_for_server;
            let polls = std::sync::atomic::AtomicUsize::new(0);
            let last_job = std::sync::Mutex::new(String::new());
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                let mut buf: Vec<u8> = Vec::new();
                let mut byte = [0u8; 1];
                while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                    if stream.read(&mut byte).unwrap_or(0) == 0 {
                        break;
                    }
                    buf.push(byte[0]);
                }
                let head = String::from_utf8_lossy(&buf).to_string();
                let first_line = head.lines().next().unwrap_or_default().to_string();
                let content_length = head
                    .to_lowercase()
                    .lines()
                    .find(|l| l.starts_with("content-length:"))
                    .and_then(|l| l.split(':').nth(1))
                    .and_then(|v| v.trim().parse::<usize>().ok())
                    .unwrap_or(0);
                if content_length > 0 {
                    let mut body = vec![0u8; content_length];
                    let _ = stream.read_exact(&mut body);
                }
                let respond = |stream: &mut std::net::TcpStream, body: String| {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                };
                if first_line.starts_with("POST /submit") {
                    respond(&mut stream, json!({"data": {"taskId": "t-1"}}).to_string());
                } else if first_line.starts_with("GET /poll") {
                    // 校验 jobId 已注入轮询 URL
                    assert!(first_line.contains("job=t-1"), "轮询 URL 应带 jobId: {first_line}");
                    let n = polls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    if n < 2 {
                        respond(&mut stream, json!({"data": {"status": "queued"}}).to_string());
                    } else {
                        respond(
                            &mut stream,
                            json!({"data": {"status": "succeeded", "videoUrl": format!("http://{addr}/file.bin")}}).to_string(),
                        );
                    }
                } else if first_line.starts_with("GET /file.bin") {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\nFILEDATA"
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else {
                    respond(&mut stream, "{}".to_string());
                }
                let _ = last_job;
            }
        });
        addr
    }

    #[tokio::test]
    async fn execute_end_to_end_against_mock_platform() {
        use crate::providers::{ProviderDriverKind, ProviderProfile};
        let addr = spawn_mock_platform();
        let dir = tempfile::tempdir().unwrap();
        let audit = std::sync::Arc::new(onetv_security::audit::AuditLog::new(dir.path()).unwrap());
        let gw = Gateway::new(
            std::sync::Arc::new(parking_lot::RwLock::new(onetv_security::NetworkPolicy::new(false))),
            audit,
        );
        let mut profile = ProviderProfile::new("custom-mock", ProviderDriverKind::CustomHttp, &format!("http://{addr}"));
        // 鉴权头直接走模板 ${secret.apiKey}（测试环境无钥匙串）
        profile.auth.auth_type = "none".into();

        let tmpl: HttpTemplate = serde_json::from_value(json!({
            "method": "POST",
            "url": format!("http://{addr}/submit"),
            "headers": { "Authorization": "Bearer ${secret.apiKey}" },
            "body": { "prompt": "${input.prompt}" },
            "response": { "job_id": "$.data.taskId", "result_url": "$.data.videoUrl" },
            "poll": {
                "method": "GET",
                "url": format!("http://{addr}/poll?job=${{jobId}}"),
                "success_when": "$.data.status == \"succeeded\"",
                "failure_when": "$.data.status == \"failed\"",
                "interval_ms": 10,
                "timeout_ms": 10_000
            }
        }))
        .unwrap();

        let out_dir = dir.path().join("out");
        let out = execute(
            &gw,
            &profile,
            "m1",
            &tmpl,
            &json!({ "prompt": "少女在雨中奔跑" }),
            Some("test-key".into()),
            &out_dir,
            || false,
        )
        .await
        .expect("execute 应成功");
        assert_eq!(out.remote_job_id.as_deref(), Some("t-1"));
        assert_eq!(out.result_urls.len(), 1);
        let content = std::fs::read(&out.result_urls[0]).unwrap();
        assert_eq!(content, b"FILEDATA");
    }

    #[test]
    fn template_whitelist() {
        let ctx = json!({"input": {"prompt": "hi"}, "model": {"id": "m1"}, "secret": {"apiKey": "k"}});
        let v = render_template(&json!("${input.prompt}"), &ctx).unwrap();
        assert_eq!(v, json!("hi"));
        assert!(render_template(&json!("${system.exit}"), &ctx).is_err(), "白名单外变量必须拒绝");
        let mixed = render_template(&json!("Hello ${input.prompt} / ${model.id}"), &ctx).unwrap();
        assert_eq!(mixed, json!("Hello hi / m1"));
    }

    #[test]
    fn json_path_basic() {
        let v = json!({"data": {"task_id": "t1", "items": [{"url": "u0"}]}});
        assert_eq!(json_path(&v, "$.data.task_id"), Some(json!("t1")));
        assert_eq!(json_path(&v, "$.data.items[0].url"), Some(json!("u0")));
        assert_eq!(json_path(&v, "$.data.missing"), None);
    }

    #[test]
    fn condition_eval() {
        let v = json!({"data": {"status": "succeeded"}});
        assert!(eval_condition(&v, "$.data.status == \"succeeded\""));
        assert!(!eval_condition(&v, "$.data.status == \"failed\""));
    }
}
