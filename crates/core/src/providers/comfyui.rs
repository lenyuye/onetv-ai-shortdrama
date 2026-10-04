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
            &format!("view?filename={filename}&subfolder={subfolder}&type=output"),
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
    mut workflow: serde_json::Value,
    image: Option<&std::path::Path>,
    out_dir: &std::path::Path,
    cancel: impl Fn() -> bool,
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

    // 轮询（生视频可能数十分钟，取 timeout_ms 与 30 分钟较大者）
    let history_url = api(&profile.base_url, &format!("history/{prompt_id}"));
    let deadline =
        std::time::Instant::now() + std::time::Duration::from_millis(profile.timeout_ms.max(1_800_000));
    let mut outputs: Vec<(String, String, String)> = Vec::new(); // (filename, subfolder, type)
    loop {
        if cancel() {
            return Err(GatewayError::Network("任务已取消".into()));
        }
        if std::time::Instant::now() > deadline {
            return Err(GatewayError::Network("ComfyUI 工作流执行超时".into()));
        }
        tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
        let egress = json!({"endpoint": history_url, "data": "轮询状态"});
        let hist = gw
            .send_json(profile, reqwest::Method::GET, &history_url, vec![], None, egress)
            .await?;
        let Some(entry) = hist.get(&prompt_id) else { continue };
        let status_err = entry
            .get("status")
            .and_then(|s| s.get("status_str"))
            .and_then(|v| v.as_str())
            == Some("error");
        if status_err {
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
            &format!("view?filename={filename}&subfolder={subfolder}&type={typ}"),
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
    use serde_json::json;

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
}
