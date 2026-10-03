//! Mock 驱动（离线演示/验收测试，规格 §19：Provider 保持接口 + mock adapter）。
//!
//! 不出网：
//! - chat：根据 prompt 关键词返回结构化剧本 JSON 或说明文本；
//! - image：本机 FFmpeg 合成渐变测试图；
//! - video：本机 FFmpeg 合成 testsrc2 测试视频；
//! - tts：本机 FFmpeg 合成音调 WAV。

use serde_json::json;

use super::gateway::GatewayResult;
use super::openai::ChatResult;
use super::ProviderProfile;
use onetv_media::MediaLocator;

pub async fn chat(_gw: &(), profile: &ProviderProfile, messages: &[super::openai::ChatMessage]) -> GatewayResult<ChatResult> {
    let _ = profile;
    let joined: String = messages.iter().map(|m| m.content.as_str()).collect::<Vec<_>>().join("\n");
    // 剧本生成：返回符合 ScriptDocument schema 的 JSON（离线可跑通全流程）
    if joined.contains("\"scenes\"") || joined.contains("ScriptDocument") || joined.contains("剧本 JSON") {
        let script = serde_json::json!({
            "schemaVersion": "1.0",
            "episodeId": "",
            "title": "霓虹夜行·第一集（Mock）",
            "logline": "深夜的城市里，一个秘密交易改变了两个人的命运。",
            "scenes": [
                {
                    "id": "sc01",
                    "heading": "内景 - 咖啡店后门 - 夜",
                    "synopsis": "雨夜，林娜在咖啡店后门等待接头人。",
                    "dialogues": [
                        {"characterName": "林娜", "line": "你怎么会在这里？", "parenthetical": "压低声音"},
                        {"characterName": "陈默", "line": "有人比我先找到了你。"}
                    ]
                },
                {
                    "id": "sc02",
                    "heading": "外景 - 天台 - 夜",
                    "synopsis": "两人对峙，真相逐渐浮出水面。",
                    "dialogues": [
                        {"characterName": "林娜", "line": "告诉我全部。"},
                        {"characterName": "陈默", "line": "从头开始，你就明白了。"}
                    ]
                }
            ],
            "updatedAt": chrono::Utc::now().to_rfc3339()
        });
        return Ok(ChatResult {
            text: serde_json::to_string(&script).unwrap(),
            usage: Some(json!({"mock": true})),
        });
    }
    Ok(ChatResult {
        text: "（Mock 模型）我已收到你的消息。配置一个真实的 LLM Provider 后即可生成正式内容；当前离线演示模式可以完整跑通「剧本→分镜→生成→合成」流程。".into(),
        usage: Some(json!({"mock": true})),
    })
}

pub async fn list_models(profile: &ProviderProfile) -> GatewayResult<Vec<String>> {
    let _ = profile;
    Ok(vec!["mock-chat-v1".into(), "mock-image-v1".into(), "mock-video-v1".into(), "mock-tts-v1".into()])
}

pub async fn generate_image(
    locator: &MediaLocator,
    prompt: &str,
    aspect: &str,
    ref_image: Option<&std::path::Path>,
    out_dir: &std::path::Path,
) -> GatewayResult<Vec<std::path::PathBuf>> {
    let resolved = locator.resolve().map_err(|e| super::gateway::GatewayError::Network(e.to_string()))?;
    let (w, h) = match aspect {
        "16:9" => (1280, 720),
        "1:1" => (1024, 1024),
        _ => (720, 1280),
    };
    std::fs::create_dir_all(out_dir).map_err(|e| super::gateway::GatewayError::Network(e.to_string()))?;
    let dest = out_dir.join(format!("mock_img_{}.png", chrono::Utc::now().timestamp_millis()));
    // 用 prompt hash 做随机种子，保证同 prompt 结果可复现（Reproducible 原则）
    let seed: u64 = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        prompt.hash(&mut h);
        // ffmpeg gradients 的 seed 允许范围 [-1, u32::MAX]
        h.finish() % 4_000_000_000
    };
    let status = match ref_image {
        // 图生图（离线 Mock）：参考图缩放裁切为底图，叠加 prompt 种子渐变层，体现"基于参考重绘"
        Some(ref_img) => std::process::Command::new(&resolved.ffmpeg)
            .args(["-y", "-v", "error"])
            .arg("-i")
            .arg(ref_img)
            .args(["-f", "lavfi", "-i"])
            .arg(format!("gradients=s={w}x{h}:c0=0x1a2550:c1=0xd42a8c:c2=0x2a9df4:seed={seed}:nb_colors=3"))
            .args([
                "-filter_complex",
                &format!("[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}[base];[1:v]format=rgba,colorchannelmixer=aa=0.25[ov];[base][ov]overlay=0:0"),
            ])
            .args(["-frames:v", "1"])
            .arg(&dest)
            .status()
            .map_err(|e| super::gateway::GatewayError::Network(e.to_string()))?,
        None => std::process::Command::new(&resolved.ffmpeg)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("gradients=s={w}x{h}:c0=0x1a2550:c1=0xd42a8c:c2=0x2a9df4:seed={seed}:nb_colors=3"))
            .args(["-frames:v", "1"])
            .arg(&dest)
            .status()
            .map_err(|e| super::gateway::GatewayError::Network(e.to_string()))?,
    };
    if !status.success() {
        return Err(super::gateway::GatewayError::Network("mock 生图失败（FFmpeg）".into()));
    }
    Ok(vec![dest])
}

pub async fn generate_video(
    locator: &MediaLocator,
    prompt: &str,
    duration: u32,
    aspect: &str,
    ref_image: Option<&std::path::Path>,
    out_dir: &std::path::Path,
) -> GatewayResult<Vec<std::path::PathBuf>> {
    let resolved = locator.resolve().map_err(|e| super::gateway::GatewayError::Network(e.to_string()))?;
    let (w, h) = match aspect {
        "16:9" => (1280, 720),
        "1:1" => (720, 720),
        _ => (720, 1280),
    };
    std::fs::create_dir_all(out_dir).map_err(|e| super::gateway::GatewayError::Network(e.to_string()))?;
    let dest = out_dir.join(format!("mock_vid_{}.mp4", chrono::Utc::now().timestamp_millis()));
    let seed: u64 = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        prompt.hash(&mut h);
        h.finish()
    };
    let status = match ref_image {
        // 图生视频（离线 Mock）：参考图循环为底视频，叠加 hue 偏移的测试图案层
        Some(ref_img) => std::process::Command::new(&resolved.ffmpeg)
            .args(["-y", "-v", "error"])
            .args(["-loop", "1", "-t", &duration.to_string()])
            .arg("-i")
            .arg(ref_img)
            .args(["-f", "lavfi", "-i"])
            .arg(format!("testsrc2=duration={duration}:size={w}x{h}:rate=30"))
            .args([
                "-filter_complex",
                &format!("[0:v]scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}[base];[1:v]format=rgba,colorchannelmixer=aa=0.18,hue=h={}:s=1.4[ov];[base][ov]overlay=0:0", seed % 360),
            ])
            .args(["-t", &duration.to_string()])
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast"])
            .arg(&dest)
            .status()
            .map_err(|e| super::gateway::GatewayError::Network(e.to_string()))?,
        None => std::process::Command::new(&resolved.ffmpeg)
            .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("testsrc2=duration={duration}:size={w}x{h}:rate=30"))
            .args(["-vf", &format!("hue=h={}:s=1.4", seed % 360)])
            .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast"])
            .arg(&dest)
            .status()
            .map_err(|e| super::gateway::GatewayError::Network(e.to_string()))?,
    };
    if !status.success() {
        return Err(super::gateway::GatewayError::Network("mock 生视频失败（FFmpeg）".into()));
    }
    Ok(vec![dest])
}

pub async fn tts(
    locator: &MediaLocator,
    text: &str,
    out_path: &std::path::Path,
) -> GatewayResult<std::path::PathBuf> {
    let resolved = locator.resolve().map_err(|e| super::gateway::GatewayError::Network(e.to_string()))?;
    let dur = ((text.chars().count() as f64) / 6.0).clamp(1.0, 12.0);
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| super::gateway::GatewayError::Network(e.to_string()))?;
    }
    let status = std::process::Command::new(&resolved.ffmpeg)
        .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
        .arg(format!("sine=frequency=440:duration={dur:.1}"))
        .args(["-af", "volume=0.3", "-c:a", "pcm_s16le"])
        .arg(out_path)
        .status()
        .map_err(|e| super::gateway::GatewayError::Network(e.to_string()))?;
    if !status.success() {
        return Err(super::gateway::GatewayError::Network("mock tts 失败（FFmpeg）".into()));
    }
    Ok(out_path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn mock_chat_returns_script_when_asked() {
        let p = ProviderProfile::new("mock", crate::providers::ProviderDriverKind::Mock, "mock://local");
        let msgs = vec![crate::providers::openai::ChatMessage::user("请生成剧本 JSON（ScriptDocument），包含 scenes")];
        let r = chat(&(), &p, &msgs).await.unwrap();
        let v: serde_json::Value = serde_json::from_str(&r.text).unwrap();
        assert!(v["scenes"].as_array().unwrap().len() >= 2);
    }
}
