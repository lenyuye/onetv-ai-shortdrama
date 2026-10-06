//! ComfyUI 本地驱动（v2.2）：与 Stable Diffusion 驱动同一套连接方式与实现逻辑——
//! 本机 HTTP 直连、免鉴权、Local-only 可用，提供对等的 image_generation（txt2img）。
//!
//! 流程：POST /prompt（API 格式 workflow）→ 轮询 /history/{id} → GET /view 取图。

use serde_json::json;

use super::gateway::{Gateway, GatewayError, GatewayResult};
use super::ProviderProfile;

fn api(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// 查询参数值 percent-encode（ComfyUI filename 可能含中文/空格/& 等）
fn enc_query(v: &str) -> String {
    let mut out = String::new();
    for b in v.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

pub async fn health(gw: &Gateway, profile: &ProviderProfile) -> GatewayResult<()> {
    let url = api(&profile.base_url, "system_stats");
    gw.check(&url)?;
    let resp = gw
        .client()
        .get(&url)
        .timeout(std::time::Duration::from_secs(6))
        .send()
        .await
        .map_err(|e| GatewayError::Network(format!("ComfyUI 不可达（请确认已启动）: {e}")))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(GatewayError::Http { status: resp.status().as_u16(), body: String::new() })
    }
}

pub async fn list_models(gw: &Gateway, profile: &ProviderProfile) -> GatewayResult<Vec<String>> {
    let url = api(&profile.base_url, "object_info/CheckpointLoaderSimple");
    let egress = json!({"endpoint": url, "data": "none"});
    let resp = gw
        .send_json(profile, reqwest::Method::GET, &url, vec![], None, egress)
        .await?;
    let models = resp
        .pointer("/CheckpointLoaderSimple/input/required/ckpt_name")
        .and_then(|v| v.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    Ok(models)
}

/// txt2img（与 SD 驱动对等的入参/返回）。
pub async fn txt2img(
    gw: &Gateway,
    profile: &ProviderProfile,
    model: &str,
    prompt: &str,
    negative_prompt: &str,
    aspect: &str,
    steps: u32,
    out_dir: &std::path::Path,
    cancel: impl Fn() -> bool,
) -> GatewayResult<Vec<std::path::PathBuf>> {
    let (w, h) = match aspect {
        "16:9" => (1280, 720),
        "1:1" => (1024, 1024),
        _ => (768, 1344),
    };
    let ckpt = if model.trim().is_empty() { "" } else { model };
    let workflow = json!({
        "3": {"class_type": "KSampler", "inputs": {
            "seed": chrono::Utc::now().timestamp_subsec_nanos() as u64,
            "steps": steps.clamp(8, 50), "cfg": 7.0,
            "sampler_name": "euler", "scheduler": "normal", "denoise": 1.0,
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]
        }},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": negative_prompt, "clip": ["4", 1]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"filename_prefix": "onetv", "images": ["8", 0]}}
    });

    // 提交
    let url = api(&profile.base_url, "prompt");
    let egress = json!({
        "endpoint": url, "data": "prompt 文本", "model": ckpt,
        "sensitive": "prompt 发送给本机 ComfyUI（不出公网）"
    });
    let resp = gw
        .send_json(profile, reqwest::Method::POST, &url, vec![], Some(json!({"prompt": workflow})), egress)
        .await?;
    let prompt_id = resp
        .get("prompt_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| GatewayError::Parse(format!("ComfyUI 响应缺少 prompt_id: {resp}")))?
        .to_string();

    // 轮询 history
    let history_url = api(&profile.base_url, &format!("history/{prompt_id}"));
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(profile.timeout_ms.max(120_000));
    let mut outputs: Vec<(String, String)> = Vec::new(); // (filename, subfolder)
    loop {
        if cancel() {
            return Err(GatewayError::Network("任务已取消".into()));
        }
        if std::time::Instant::now() > deadline {
            return Err(GatewayError::Network("ComfyUI 生成超时".into()));
        }
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        let egress = json!({"endpoint": history_url, "data": "轮询状态"});
        let hist = gw
            .send_json(profile, reqwest::Method::GET, &history_url, vec![], None, egress)
            .await?;
        if let Some(entry) = hist.get(&prompt_id) {
            let status_completed = entry
                .get("status")
                .and_then(|s| s.get("completed"))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let status_err = entry
                .get("status")
                .and_then(|s| s.get("status_str"))
                .and_then(|v| v.as_str())
                == Some("error");
            if status_err {
                return Err(GatewayError::Parse("ComfyUI 工作流执行失败（检查模型/节点）".into()));
            }
            if status_completed {
                if let Some(save) = entry.pointer("/outputs/9/images").and_then(|v| v.as_array()) {
                    for img in save {
                        let f = img.get("filename").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                        let sub = img.get("subfolder").and_then(|v| v.as_str()).unwrap_or_default().to_string();
                        outputs.push((f, sub));
                    }
                }
                break;
            }
        }
    }
    if outputs.is_empty() {
        return Err(GatewayError::Parse("ComfyUI 未返回图片输出".into()));
    }

    // 下载 /view
    std::fs::create_dir_all(out_dir).map_err(|e| GatewayError::Network(e.to_string()))?;
    let mut outs = Vec::new();
    for (i, (filename, subfolder)) in outputs.iter().enumerate() {
        let view = api(
            &profile.base_url,
            &format!("view?filename={}&subfolder={}&type=output", enc_query(&filename), enc_query(&subfolder)),
        );
        let dest = out_dir.join(format!("comfy_{}_{}.png", chrono::Utc::now().timestamp_millis(), i));
        gw.download(profile, &view, &dest).await?;
        outs.push(dest);
    }
    Ok(outs)
}


/* ---------------- 通用工作流运行器（v2.7：FLUX 出图 / Wan2.x 生视频） ---------------- */

/// 工作流占位符补丁。约定（用户在 ComfyUI 排好工作流、以「API 格式」导出后填写）：
/// - 文本节点（CLIPTextEncode 等）写 `__prompt__` / `__negative__` → 替换为本次提示词；
/// - `seed` / `noise_seed` 填 0 → 每次执行自动随机（非 0 则保持固定）。
pub fn patch_workflow(workflow: &mut serde_json::Value, prompt: &str, negative: &str) {
    let Some(nodes) = workflow.as_object_mut() else { return };
    let nanos = chrono::Utc::now().timestamp_subsec_nanos() as u64;
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let seed = (secs << 32) | nanos;
    for (_, node) in nodes.iter_mut() {
        let Some(inputs) = node.get_mut("inputs").and_then(|v| v.as_object_mut()) else { continue };
        for (k, v) in inputs.iter_mut() {
            match v {
                serde_json::Value::String(t) => {
                    let replaced = t.replace("__prompt__", prompt).replace("__negative__", negative);
                    if replaced != *t {
                        *t = replaced;
                    }
                }
                serde_json::Value::Number(n) => {
                    if (k == "seed" || k == "noise_seed") && n.as_u64() == Some(0) {
                        *v = serde_json::Value::Number(serde_json::Number::from(seed));
                    }
                }
                _ => {}
            }
        }
    }
}

/// 数值/任意占位符替换：input 值**整串等于** `__token__` 时替换为给定值。
/// 用于数字字段（ComfyUI API 格式里 width/length 等是数字，不能用文本替换）：
/// Wan 常用 `__width__` / `__height__` / `__frames__`，由画幅与时长推导后传入。
pub fn patch_workflow_vars(workflow: &mut serde_json::Value, vars: &[(&str, serde_json::Value)]) {
    let Some(nodes) = workflow.as_object_mut() else { return };
    for (_, node) in nodes.iter_mut() {
        let Some(inputs) = node.get_mut("inputs").and_then(|v| v.as_object_mut()) else { continue };
        for (_, v) in inputs.iter_mut() {
            if let serde_json::Value::String(t) = v {
                let trimmed = t.trim();
                if let Some(tok) = trimmed.strip_prefix("__").and_then(|x| x.strip_suffix("__")) {
                    if let Some(val) = vars.iter().find(|(k, _)| *k == tok) {
                        *v = val.1.clone();
                    }
                }
            }
        }
    }
}

/// 上传首帧参考图到 ComfyUI（POST /upload/image），返回可直接填入 LoadImage 的文件名。
async fn upload_image(
    gw: &Gateway,
    profile: &ProviderProfile,
    path: &std::path::Path,
) -> GatewayResult<String> {
    let bytes = std::fs::read(path).map_err(|e| GatewayError::Network(format!("读取首帧图失败: {e}")))?;
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();
    let name = format!("onetv_{}.{}", chrono::Utc::now().timestamp_millis(), ext);
    let url = api(&profile.base_url, "upload/image");
    gw.check(&url)?;
    let form = reqwest::multipart::Form::new().part(
        "image",
        reqwest::multipart::Part::bytes(bytes)
            .file_name(name.clone())
            .mime_str(if ext == "jpg" || ext == "jpeg" { "image/jpeg" } else { "image/png" })
            .map_err(|e| GatewayError::Network(e.to_string()))?,
    );
    let resp = gw
        .client()
        .post(&url)
        .multipart(form)
        .timeout(std::time::Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| GatewayError::Network(format!("上传首帧图失败: {e}")))?;
    if !resp.status().is_success() {
        return Err(GatewayError::Http { status: resp.status().as_u16(), body: String::new() });
    }
    let v: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| GatewayError::Parse(format!("上传响应解析失败: {e}")))?;
    let subfolder = v.get("subfolder").and_then(|x| x.as_str()).unwrap_or_default();
    let real_name = v.get("name").and_then(|x| x.as_str()).unwrap_or(&name);
    Ok(if subfolder.is_empty() {
        real_name.to_string()
    } else {
        format!("{subfolder}/{real_name}")
    })
}

/// 通用工作流执行：提交 /prompt → 轮询 /history → 收集全部节点输出 → /view 下载。
/// 支持 images/gifs/videos 等输出数组（SaveImage / SaveAnimatedWEBP / VHS_VideoCombine 等）。
pub async fn run_workflow(
    gw: &Gateway,
    profile: &ProviderProfile,
    workflow: serde_json::Value,
    image: Option<&std::path::Path>,
    out_dir: &std::path::Path,
    cancel: impl Fn() -> bool,
    // 轮询进度回调（0.0~1.0，按已用时间/超时估算；v2.9.1 接入 job progress）
    on_progress: impl Fn(f64),
) -> GatewayResult<Vec<std::path::PathBuf>> {
    // 轮询预算：生视频可能数十分钟，取 timeout_ms 与 30 分钟较大者。
    // 预算独立成参传给实现（测试注入短预算以覆盖超时路径，生产行为不变）
    run_workflow_impl(gw, profile, workflow, image, out_dir, cancel, on_progress, profile.timeout_ms.max(1_800_000))
        .await
}

/// run_workflow 实现：`budget_ms` 为轮询超时预算（毫秒），独立成参便于测试注入。
#[allow(clippy::too_many_arguments)]
async fn run_workflow_impl(
    gw: &Gateway,
    profile: &ProviderProfile,
    mut workflow: serde_json::Value,
    image: Option<&std::path::Path>,
    out_dir: &std::path::Path,
    cancel: impl Fn() -> bool,
    on_progress: impl Fn(f64),
    budget_ms: u64,
) -> GatewayResult<Vec<std::path::PathBuf>> {
    // 首帧参考图：上传后填入所有 LoadImage 类节点（WanImageToVideo / LoadImage 等）
    if let Some(img_path) = image {
        let uploaded = upload_image(gw, profile, img_path).await?;
        if let Some(nodes) = workflow.as_object_mut() {
            for (_, node) in nodes.iter_mut() {
                let class = node.get("class_type").and_then(|v| v.as_str()).unwrap_or_default();
                if class.contains("LoadImage") {
                    if let Some(inputs) = node.get_mut("inputs").and_then(|v| v.as_object_mut()) {
                        inputs.insert("image".to_string(), serde_json::json!(uploaded));
                    }
                }
            }
        }
    }

    // 提交
    let url = api(&profile.base_url, "prompt");
    let egress = json!({
        "endpoint": url, "data": "工作流参数（prompt/模型/尺寸）",
        "sensitive": "prompt 发送给本机 ComfyUI（不出公网）"
    });
    let resp = gw
        .send_json(
            profile,
            reqwest::Method::POST,
            &url,
            vec![],
            Some(json!({ "prompt": workflow, "client_id": "onetv" })),
            egress,
        )
        .await?;
    let prompt_id = resp
        .get("prompt_id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| GatewayError::Parse(format!("ComfyUI 响应缺少 prompt_id: {resp}")))?
        .to_string();

    // 轮询（budget_ms 由 run_workflow 计算：生视频可能数十分钟，取 timeout_ms 与 30 分钟较大者）
    let history_url = api(&profile.base_url, &format!("history/{prompt_id}"));
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
    let started = std::time::Instant::now();
    let mut outputs: Vec<(String, String, String)> = Vec::new(); // (filename, subfolder, type)
    loop {
        if cancel() {
            return Err(GatewayError::Network("任务已取消".into()));
        }
        if std::time::Instant::now() > deadline {
            return Err(GatewayError::Network("ComfyUI 工作流执行超时".into()));
        }
        on_progress(((started.elapsed().as_millis() as f64) / (budget_ms as f64) * 0.95).min(0.95));
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        let egress = json!({"endpoint": history_url, "data": "轮询状态"});
        let hist = gw
            .send_json(profile, reqwest::Method::GET, &history_url, vec![], None, egress)
            .await?;
        let Some(entry) = hist.get(&prompt_id) else { continue };
        let status_str = entry
            .get("status")
            .and_then(|s| s.get("status_str"))
            .and_then(|v| v.as_str());
        // 修复：此前只识别 "error"，部分分支/包装层报 "failed" 时会一直轮询到超时
        if matches!(status_str, Some("error") | Some("failed")) {
            return Err(GatewayError::Parse("ComfyUI 工作流执行失败（检查模型/节点显存）".into()));
        }
        let completed = entry
            .get("status")
            .and_then(|s| s.get("completed"))
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !completed {
            continue;
        }
        // 收集全部节点的输出（images/gifs/videos/animated）
        if let Some(out_map) = entry.get("outputs").and_then(|v| v.as_object()) {
            for (_, payload) in out_map {
                let Some(items) = payload.as_object() else { continue };
                for (key, val) in items {
                    if !matches!(key.as_str(), "images" | "gifs" | "videos" | "animated") {
                        continue;
                    }
                    if let Some(arr) = val.as_array() {
                        for item in arr {
                            let f = item.get("filename").and_then(|v| v.as_str()).unwrap_or_default();
                            if f.is_empty() {
                                continue;
                            }
                            let sub = item.get("subfolder").and_then(|v| v.as_str()).unwrap_or_default();
                            let typ = item.get("type").and_then(|v| v.as_str()).unwrap_or("output");
                            outputs.push((f.to_string(), sub.to_string(), typ.to_string()));
                        }
                    }
                }
            }
        }
        break;
    }
    if outputs.is_empty() {
        return Err(GatewayError::Parse("ComfyUI 工作流无产物输出（检查保存节点）".into()));
    }

    // 下载 /view
    std::fs::create_dir_all(out_dir).map_err(|e| GatewayError::Network(e.to_string()))?;
    let mut outs = Vec::new();
    for (i, (filename, subfolder, typ)) in outputs.iter().enumerate() {
        let view = api(
            &profile.base_url,
            &format!("view?filename={}&subfolder={}&type={typ}", enc_query(&filename), enc_query(&subfolder)),
        );
        let ext = filename.rsplit('.').next().map(|e| e.chars().take(4).collect::<String>()).unwrap_or("png".into());
        let dest = out_dir.join(format!("comfywf_{}_{}.{}", chrono::Utc::now().timestamp_millis(), i, ext));
        gw.download(profile, &view, &dest).await?;
        outs.push(dest);
    }
    Ok(outs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::{ProviderDriverKind, ProviderProfile};
    use parking_lot::Mutex;
    use serde_json::json;
    use std::sync::Arc;

    /* ---------------- Mock ComfyUI 服务器（行为可按场景配置） ---------------- */

    #[derive(Default)]
    struct MockCfg {
        /// /history 返回空对象（任务进行中）的轮询次数；usize::MAX = 永不完成（测超时）
        history_empty_polls: usize,
        /// /history 就绪后返回的 (status_str, completed)；None = 成功 + 双产物
        history_status: Option<(&'static str, bool)>,
        /// /prompt HTTP 状态码（默认 200）
        prompt_status: u16,
        /// /prompt 自定义响应体（如 node_errors、缺少 prompt_id 的场景）
        prompt_body: Option<serde_json::Value>,
        /// /view HTTP 状态码（默认 200）
        view_status: u16,
    }

    fn http_status_line(code: u16) -> &'static str {
        match code {
            200 => "200 OK",
            404 => "404 Not Found",
            500 => "500 Internal Server Error",
            _ => "200 OK",
        }
    }

    /// 极简 ComfyUI Mock 服务器：真实 HTTP 全链路（upload/prompt/history/view），
    /// 用于无 GPU 环境实测 run_workflow 管线。阻塞线程 + std TcpListener，
    /// 每个测试起独立端口/实例，按 MockCfg 配置错误场景。
    fn spawn_mock_comfy(cfg: MockCfg) -> (String, Arc<Mutex<serde_json::Value>>, Arc<Mutex<serde_json::Value>>) {
        use std::io::{Read, Write};
        use std::net::TcpListener;
        use std::sync::atomic::{AtomicUsize, Ordering};

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let submitted: Arc<Mutex<serde_json::Value>> = Arc::new(Mutex::new(serde_json::Value::Null));
        let uploaded: Arc<Mutex<serde_json::Value>> = Arc::new(Mutex::new(serde_json::Value::Null));
        let submitted2 = submitted.clone();
        let uploaded2 = uploaded.clone();

        std::thread::spawn(move || {
            let polls = AtomicUsize::new(0);
            for stream in listener.incoming() {
                let mut stream = match stream {
                    Ok(s) => s,
                    Err(_) => break,
                };
                // 读 header
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
                let mut body = vec![0u8; content_length];
                if content_length > 0 {
                    let _ = stream.read_exact(&mut body);
                }

                let respond = |stream: &mut std::net::TcpStream, status: &str, ctype: &str, body: Vec<u8>| {
                    let resp = format!("HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.write_all(&body);
                };

                if first_line.starts_with("POST /upload/image") {
                    *uploaded2.lock() = json!({ "bytes": body.len() });
                    respond(&mut stream, "200 OK", "application/json", json!({"name": "onetv_test.png", "subfolder": ""}).to_string().into_bytes());
                } else if first_line.starts_with("POST /prompt") {
                    let v: serde_json::Value = serde_json::from_slice(&body).unwrap_or(json!({}));
                    *submitted2.lock() = v.get("prompt").cloned().unwrap_or(json!({}));
                    let resp_body = cfg
                        .prompt_body
                        .clone()
                        .unwrap_or_else(|| json!({"prompt_id": "test-job-1"}));
                    respond(&mut stream, http_status_line(cfg.prompt_status), "application/json", resp_body.to_string().into_bytes());
                } else if first_line.starts_with("GET /history/") {
                    let n = polls.fetch_add(1, Ordering::SeqCst);
                    if n < cfg.history_empty_polls {
                        respond(&mut stream, "200 OK", "application/json", b"{}".to_vec());
                    } else {
                        let (status_str, completed) = cfg.history_status.unwrap_or(("success", true));
                        // 默认成功态带双产物（SaveImage png + SaveWEBM webm）；错误态只带状态
                        let outputs = if cfg.history_status.is_none() {
                            json!({
                                "11": {"images": [{"filename": "onetv_frame.png", "subfolder": "", "type": "output"}]},
                                "12": {"gifs": [{"filename": "onetv_video.webm", "subfolder": "vhs", "type": "output"}]}
                            })
                        } else {
                            json!({})
                        };
                        let hist = json!({
                            "test-job-1": {
                                "status": {"completed": completed, "status_str": status_str},
                                "outputs": outputs
                            }
                        });
                        respond(&mut stream, "200 OK", "application/json", hist.to_string().into_bytes());
                    }
                } else if first_line.starts_with("GET /view") {
                    // 按 query 里的 filename 产出可区分的字节
                    let marker: &[u8] = if first_line.contains("onetv_frame.png") { b"PNG-DATA" } else { b"WEBM-DATA" };
                    respond(&mut stream, http_status_line(cfg.view_status), "application/octet-stream", marker.to_vec());
                } else {
                    respond(&mut stream, "200 OK", "application/json", b"{}".to_vec());
                }
            }
        });
        (addr, submitted, uploaded)
    }

    /// 测试用网关 + Local-only 策略 + ComfyUI profile（base_url 指向 Mock 端口）
    fn test_gateway_and_profile(addr: &str, dir: &std::path::Path) -> (Gateway, ProviderProfile) {
        let audit = std::sync::Arc::new(onetv_security::audit::AuditLog::new(dir).unwrap());
        let gw = Gateway::new(
            std::sync::Arc::new(parking_lot::RwLock::new(onetv_security::NetworkPolicy::new(false))),
            audit,
        );
        let mut profile = ProviderProfile::new("comfy-mock", ProviderDriverKind::Comfyui, &format!("http://{addr}"));
        profile.auth.auth_type = "none".into();
        (gw, profile)
    }

    /* ---------------- run_workflow：正常双产物路径（v2.9.1 已有） ---------------- */

    #[tokio::test]
    async fn run_workflow_end_to_end_against_mock_comfy() {
        let (addr, submitted, uploaded) = spawn_mock_comfy(MockCfg { history_empty_polls: 2, ..Default::default() });

        let dir = tempfile::tempdir().unwrap();
        let (gw, profile) = test_gateway_and_profile(&addr, dir.path());

        // Wan 风格工作流：占位符 + 数值占位 + LoadImage
        let mut wf = json!({
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "__prompt__"}},
            "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "__negative__"}},
            "8": {"class_type": "LoadImage", "inputs": {"image": "placeholder.png"}},
            "9": {"class_type": "WanImageToVideo", "inputs": {"width": "__width__", "height": "__height__", "length": "__frames__"}},
            "10": {"class_type": "KSampler", "inputs": {"seed": 0}},
            "11": {"class_type": "VAEDecode", "inputs": {}},
            "12": {"class_type": "SaveWEBM", "inputs": {}}
        });
        patch_workflow(&mut wf, "少女在雨中奔跑", "低质量");
        patch_workflow_vars(&mut wf, &[("width", json!(480)), ("height", json!(832)), ("frames", json!(81))]);

        // 首帧参考图
        let img_path = dir.path().join("first_frame.png");
        std::fs::write(&img_path, b"fake-png-bytes").unwrap();

        let out_dir = dir.path().join("out");
        let progress = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(0));
        let progress2 = progress.clone();
        let outs = run_workflow(&gw, &profile, wf, Some(&img_path), &out_dir, || false, move |p| {
            progress2.store((p * 1000.0) as u64, std::sync::atomic::Ordering::SeqCst);
        })
        .await
        .expect("run_workflow 应成功");

        // 产物：1 png + 1 webm，内容与 /view 对应
        assert_eq!(outs.len(), 2);
        let names: Vec<String> = outs.iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
        assert!(names.iter().any(|n| n.ends_with(".png")));
        assert!(names.iter().any(|n| n.ends_with(".webm")));
        let png = outs.iter().find(|p| p.extension().unwrap() == "png").unwrap();
        assert_eq!(std::fs::read(png).unwrap(), b"PNG-DATA");

        // 提交的工作流：占位符已替换、seed 已随机、数值为真数字、首帧已上传
        let sent = submitted.lock().clone();
        assert_eq!(sent["6"]["inputs"]["text"], json!("少女在雨中奔跑"));
        assert_eq!(sent["7"]["inputs"]["text"], json!("低质量"));
        assert!(sent["10"]["inputs"]["seed"].as_u64().unwrap() > 0, "seed=0 应被随机化");
        assert_eq!(sent["9"]["inputs"]["width"], json!(480));
        assert_eq!(sent["9"]["inputs"]["height"], json!(832));
        assert_eq!(sent["9"]["inputs"]["length"], json!(81));
        assert_eq!(sent["8"]["inputs"]["image"], json!("onetv_test.png"), "LoadImage 应收到上传后的文件名");
        // 上传确实发生
        assert!(uploaded.lock().get("bytes").and_then(|b| b.as_u64()).unwrap_or(0) > 0);
        // 进度回调被触发过
        assert!(progress.load(std::sync::atomic::Ordering::SeqCst) > 0);
    }

    #[test]
    fn workflow_patch_replaces_placeholders_and_randomizes_zero_seed() {
        let mut wf = json!({
            "3": {"class_type": "KSampler", "inputs": {"seed": 0, "noise_seed": 0, "steps": 20}},
            "6": {"class_type": "CLIPTextEncode", "inputs": {"text": "__prompt__", "clip": ["4", 1]}},
            "7": {"class_type": "CLIPTextEncode", "inputs": {"text": "__negative__", "clip": ["4", 1]}},
            "10": {"class_type": "WanImageToVideo", "inputs": {"image": ["11", 0]}},
            "11": {"class_type": "LoadImage", "inputs": {"image": "placeholder.png"}}
        });
        patch_workflow(&mut wf, "一个少女在雨中奔跑", "低质量");
        assert_eq!(wf["6"]["inputs"]["text"], json!("一个少女在雨中奔跑"));
        assert_eq!(wf["7"]["inputs"]["text"], json!("低质量"));
        // seed=0 → 随机为非 0；非 0 固定值保持不变
        let s1 = wf["3"]["inputs"]["seed"].as_u64().unwrap();
        assert_ne!(s1, 0);
        assert_ne!(wf["3"]["inputs"]["noise_seed"].as_u64().unwrap(), 0);
        let mut wf2 = json!({"3": {"class_type": "KSampler", "inputs": {"seed": 42}}});
        patch_workflow(&mut wf2, "x", "");
        assert_eq!(wf2["3"]["inputs"]["seed"], json!(42));
    }

    /* ---------------- v2.9.1 补充：run_workflow 错误路径 ---------------- */

    /// /history 返回 status_str="error" → 应立即报中文可读错误（而非轮询到超时）
    #[tokio::test]
    async fn run_workflow_history_error_status_reports_readable_error() {
        let (addr, _submitted, _uploaded) =
            spawn_mock_comfy(MockCfg { history_status: Some(("error", false)), ..Default::default() });
        let dir = tempfile::tempdir().unwrap();
        let (gw, profile) = test_gateway_and_profile(&addr, dir.path());

        let wf = json!({"9": {"class_type": "SaveWEBM", "inputs": {}}});
        let err = run_workflow(&gw, &profile, wf, None, &dir.path().join("out"), || false, |_| {})
            .await
            .expect_err("status_str=error 应报错");
        assert!(err.to_string().contains("ComfyUI 工作流执行失败"), "实际错误: {err}");
    }

    /// /history 返回 status_str="failed"（部分分支/包装层的写法）→ 同样应报可读错误
    /// （回归：修复前只识别 "error"，"failed" 会一直轮询到 30 分钟超时）
    #[tokio::test]
    async fn run_workflow_history_failed_status_reports_readable_error() {
        let (addr, _submitted, _uploaded) =
            spawn_mock_comfy(MockCfg { history_status: Some(("failed", false)), ..Default::default() });
        let dir = tempfile::tempdir().unwrap();
        let (gw, profile) = test_gateway_and_profile(&addr, dir.path());

        let wf = json!({"9": {"class_type": "SaveWEBM", "inputs": {}}});
        let err = run_workflow(&gw, &profile, wf, None, &dir.path().join("out"), || false, |_| {})
            .await
            .expect_err("status_str=failed 应报错");
        assert!(err.to_string().contains("ComfyUI 工作流执行失败"), "实际错误: {err}");
    }

    /// /prompt 200 但返回 node_errors（无 prompt_id）→ 应报可读错误
    #[tokio::test]
    async fn run_workflow_prompt_node_errors_reports_readable_error() {
        let (addr, _submitted, _uploaded) = spawn_mock_comfy(MockCfg {
            prompt_body: Some(json!({
                "node_errors": {
                    "3": {"errors": [{"type": "value_not_in_list", "message": "ckpt_name invalid"}]}
                }
            })),
            ..Default::default()
        });
        let dir = tempfile::tempdir().unwrap();
        let (gw, profile) = test_gateway_and_profile(&addr, dir.path());

        let wf = json!({"9": {"class_type": "SaveWEBM", "inputs": {}}});
        let err = run_workflow(&gw, &profile, wf, None, &dir.path().join("out"), || false, |_| {})
            .await
            .expect_err("node_errors 响应应报错");
        assert!(err.to_string().contains("缺少 prompt_id"), "实际错误: {err}");
    }

    /// /prompt 非 200 → 应报带状态码的错误
    #[tokio::test]
    async fn run_workflow_prompt_http_500_reports_error() {
        let (addr, _submitted, _uploaded) =
            spawn_mock_comfy(MockCfg { prompt_status: 500, ..Default::default() });
        let dir = tempfile::tempdir().unwrap();
        let (gw, profile) = test_gateway_and_profile(&addr, dir.path());

        let wf = json!({"9": {"class_type": "SaveWEBM", "inputs": {}}});
        let err = run_workflow(&gw, &profile, wf, None, &dir.path().join("out"), || false, |_| {})
            .await
            .expect_err("prompt 500 应报错");
        assert!(err.to_string().contains("HTTP 500"), "实际错误: {err}");
    }

    /// /history 正常完成但 /view 下载 404 → 应报带状态码的错误
    #[tokio::test]
    async fn run_workflow_view_404_reports_error() {
        let (addr, _submitted, _uploaded) = spawn_mock_comfy(MockCfg { view_status: 404, ..Default::default() });
        let dir = tempfile::tempdir().unwrap();
        let (gw, profile) = test_gateway_and_profile(&addr, dir.path());

        let wf = json!({"9": {"class_type": "SaveWEBM", "inputs": {}}});
        let err = run_workflow(&gw, &profile, wf, None, &dir.path().join("out"), || false, |_| {})
            .await
            .expect_err("view 404 应报错");
        assert!(err.to_string().contains("HTTP 404"), "实际错误: {err}");
    }

    /// /history 一直 running（completed 永不为 true）→ 轮询预算耗尽后报超时。
    /// 通过 run_workflow_impl 注入 500ms 短预算（生产路径预算恒 ≥ 30 分钟，不受影响）。
    #[tokio::test]
    async fn run_workflow_history_timeout_reports_readable_error() {
        let (addr, _submitted, _uploaded) =
            spawn_mock_comfy(MockCfg { history_empty_polls: usize::MAX, ..Default::default() });
        let dir = tempfile::tempdir().unwrap();
        let (gw, profile) = test_gateway_and_profile(&addr, dir.path());

        let wf = json!({"9": {"class_type": "SaveWEBM", "inputs": {}}});
        let err = run_workflow_impl(&gw, &profile, wf, None, &dir.path().join("out"), || false, |_| {}, 500)
            .await
            .expect_err("一直 running 应超时");
        assert!(err.to_string().contains("ComfyUI 工作流执行超时"), "实际错误: {err}");
    }

    /* ---------------- patch_workflow_vars / seed 边界 ---------------- */

    #[test]
    fn workflow_patch_vars_edge_cases() {
        let mut wf = json!({
            "1": {"class_type": "WanImageToVideo", "inputs": {
                "width": "__width__",
                "height": " __height__ ",
                "length": "__frames__",
                "batch": "__unknown__",
                "prefix": "prefix__width__",
                "steps": 20,
                "cfg": 7.5
            }}
        });
        patch_workflow_vars(&mut wf, &[("width", json!(480)), ("height", json!(832)), ("frames", json!(81))]);
        // 整串占位符 → 替换为数值
        assert_eq!(wf["1"]["inputs"]["width"], json!(480));
        assert_eq!(wf["1"]["inputs"]["length"], json!(81));
        // 前后带空白的整串占位符（trim 后匹配）→ 同样替换
        assert_eq!(wf["1"]["inputs"]["height"], json!(832));
        // 未知 token、部分嵌入的 token → 原样保留
        assert_eq!(wf["1"]["inputs"]["batch"], json!("__unknown__"));
        assert_eq!(wf["1"]["inputs"]["prefix"], json!("prefix__width__"));
        // 非字符串输入不受影响
        assert_eq!(wf["1"]["inputs"]["steps"], json!(20));
        assert_eq!(wf["1"]["inputs"]["cfg"], json!(7.5));

        // 非 object 工作流：不 panic、原样返回
        let mut arr = json!([1, 2, 3]);
        patch_workflow_vars(&mut arr, &[("width", json!(480))]);
        assert_eq!(arr, json!([1, 2, 3]));
    }

    /// seed=0 → 每次调用随机：两次调用应得到不同的非 0 值
    #[test]
    fn patch_workflow_zero_seed_differs_between_calls() {
        let mut wf1 = json!({"3": {"class_type": "KSampler", "inputs": {"seed": 0}}});
        let mut wf2 = json!({"3": {"class_type": "KSampler", "inputs": {"seed": 0}}});
        patch_workflow(&mut wf1, "a", "");
        patch_workflow(&mut wf2, "a", "");
        let s1 = wf1["3"]["inputs"]["seed"].as_u64().unwrap();
        let s2 = wf2["3"]["inputs"]["seed"].as_u64().unwrap();
        assert_ne!(s1, 0, "seed=0 应被随机化");
        assert_ne!(s2, 0, "seed=0 应被随机化");
        assert_ne!(s1, s2, "两次调用应得到不同随机 seed（s1={s1}, s2={s2}）");
    }
}
