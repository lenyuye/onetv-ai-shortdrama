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
                out.insert(k.clone(), render_template(v, ctx)?);
            }
            Ok(Value::Object(out))
        }
        Value::Array(arr) => Ok(Value::Array(
            arr.iter().map(|v| render_template(v, ctx)).collect::<Result<Vec<_>, _>>()?,
        )),
        other => Ok(other.clone()),
    }
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
    for (i, u) in result_urls.iter().enumerate() {
        if cancel() {
            return Err(GatewayError::Network("任务已取消".into()));
        }
        let ext = u.rsplit('.').next().map(|e| e.chars().take(5).collect::<String>()).unwrap_or("bin".into());
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
