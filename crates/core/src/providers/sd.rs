//! Stable Diffusion WebUI 本地驱动（v2.1）：AUTOMATIC1111 / Forge 的 /sdapi 接口。
//!
//! 用于辅助生成资产（人物定妆 / 场景参考）：
//! - txt2img：文生图（image_generation）
//! - img2img：图生图/重绘（image_edit）
//! - 默认 http://127.0.0.1:7860，本地不出公网，Local-only 模式可用。

use base64::Engine;
use serde_json::json;

use super::gateway::{Gateway, GatewayError, GatewayResult};
use super::ProviderProfile;

fn api(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

pub async fn health(gw: &Gateway, profile: &ProviderProfile) -> GatewayResult<()> {
    let url = api(&profile.base_url, "sdapi/v1/options");
    gw.check(&url)?;
    let resp = gw
        .client()
        .get(&url)
        .timeout(std::time::Duration::from_secs(6))
        .send()
        .await
        .map_err(|e| GatewayError::Network(format!("SD WebUI 不可达（请确认已启动且开启 api）: {e}")))?;
    if resp.status().is_success() {
        Ok(())
    } else {
        Err(GatewayError::Http { status: resp.status().as_u16(), body: String::new() })
    }
}

pub async fn list_models(gw: &Gateway, profile: &ProviderProfile) -> GatewayResult<Vec<String>> {
    let url = api(&profile.base_url, "sdapi/v1/sd-models");
    let egress = json!({"endpoint": url, "data": "none"});
    let resp = gw
        .send_json(profile, reqwest::Method::GET, &url, vec![], None, egress)
        .await?;
    Ok(resp
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    m.get("title")
                        .or_else(|| m.get("model_name"))
                        .and_then(|v| v.as_str())
                        .map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default())
}

/// 文生图。aspect: "9:16" | "16:9" | "1:1"。
pub async fn txt2img(
    gw: &Gateway,
    profile: &ProviderProfile,
    model: &str,
    prompt: &str,
    negative_prompt: &str,
    aspect: &str,
    steps: u32,
    out_dir: &std::path::Path,
) -> GatewayResult<Vec<std::path::PathBuf>> {
    let (w, h) = match aspect {
        "16:9" => (1216, 688),
        "1:1" => (1024, 1024),
        _ => (768, 1344),
    };
    let url = api(&profile.base_url, "sdapi/v1/txt2img");
    let body = json!({
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "width": w,
        "height": h,
        "steps": steps.clamp(8, 60),
        "cfg_scale": 7.0,
        "sampler_name": "DPM++ 2M",
        "override_settings": { "sd_model_checkpoint": model },
        "override_settings_restore_afterwards": true
    });
    let egress = json!({
        "endpoint": url,
        "data": "prompt 文本",
        "model": model,
        "sensitive": "prompt 将发送给本地 SD WebUI（127.0.0.1，不出公网）"
    });
    let resp = gw
        .send_json(profile, reqwest::Method::POST, &url, vec![], Some(body), egress)
        .await?;
    decode_images(&resp, out_dir, "sd_txt2img")
}

/// 图生图（重绘/风格化）。init_image 为本地参考图路径。
#[allow(clippy::too_many_arguments)]
pub async fn img2img(
    gw: &Gateway,
    profile: &ProviderProfile,
    model: &str,
    prompt: &str,
    negative_prompt: &str,
    init_image: &std::path::Path,
    denoising_strength: f64,
    out_dir: &std::path::Path,
) -> GatewayResult<Vec<std::path::PathBuf>> {
    let bytes = std::fs::read(init_image).map_err(|e| GatewayError::Parse(e.to_string()))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let mime = if init_image
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase().contains("png"))
        .unwrap_or(true)
    {
        "image/png"
    } else {
        "image/jpeg"
    };
    let url = api(&profile.base_url, "sdapi/v1/img2img");
    let body = json!({
        "init_images": [format!("data:{mime};base64,{b64}")],
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "steps": 30,
        "cfg_scale": 7.0,
        "width": 768,
        "height": 1344,
        "denoising_strength": denoising_strength.clamp(0.1, 0.95),
        "override_settings": { "sd_model_checkpoint": model },
        "override_settings_restore_afterwards": true
    });
    let egress = json!({
        "endpoint": url,
        "data": "prompt + 本地参考图",
        "model": model,
        "sensitive": "参考图与 prompt 发送给本地 SD WebUI（不出公网）"
    });
    let resp = gw
        .send_json(profile, reqwest::Method::POST, &url, vec![], Some(body), egress)
        .await?;
    decode_images(&resp, out_dir, "sd_img2img")
}

fn decode_images(
    resp: &serde_json::Value,
    out_dir: &std::path::Path,
    tag: &str,
) -> GatewayResult<Vec<std::path::PathBuf>> {
    let images = resp
        .get("images")
        .and_then(|v| v.as_array())
        .ok_or_else(|| GatewayError::Parse(format!("SD 响应缺少 images: {}", resp)))?;
    std::fs::create_dir_all(out_dir).map_err(|e| GatewayError::Network(e.to_string()))?;
    let mut outs = Vec::new();
    for (i, img) in images.iter().enumerate() {
        let Some(s) = img.as_str() else { continue };
        // SD 可能返回 data URL 前缀
        let b64 = s.split_once("base64,").map(|(_, r)| r).unwrap_or(s);
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| GatewayError::Parse(format!("base64 解码失败: {e}")))?;
        let dest =
            out_dir.join(format!("{}_{}_{}.png", tag, chrono::Utc::now().timestamp_millis(), i));
        std::fs::write(&dest, bytes).map_err(|e| GatewayError::Network(e.to_string()))?;
        outs.push(dest);
    }
    if outs.is_empty() {
        return Err(GatewayError::Parse("SD 未返回图片".into()));
    }
    Ok(outs)
}
