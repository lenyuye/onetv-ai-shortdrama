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
