//! Agent 侧 Job 处理器（L3 Executor 的具体执行体）。
//! 每个处理器：解析参数 → 经 ModelRouter/Gateway 调 Provider → 产出本地文件 → 返回路径。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use parking_lot::RwLock;
use serde_json::json;

use crate::agent::tools::{ScriptDoc, SCRIPT_SYSTEM_PROMPT};
use crate::jobs::{JobContext, JobError, JobHandler};
use crate::providers::mock;
use crate::providers::ollama;
use crate::providers::openai::{self, ChatMessage};
use crate::providers::router::ModelRouter;
use crate::providers::{Capability, ProviderDriverKind, ProviderRegistry};

use super::AgentEnv;

fn fatal(m: impl Into<String>) -> JobError {
    JobError::fatal(m)
}
fn transient(m: impl Into<String>) -> JobError {
    JobError::transient(m)
}
fn route_err(e: impl std::fmt::Display) -> JobError {
    JobError::fatal(e.to_string())
}

/// 模型选择优先级：任务参数显式指定（providerId/model，来自 UI 模型选择器）
/// → 设置的「生成模型默认」（AgentEnv.defaults，cap = chat|image|video|tts）→ Router 自动。
fn preferred_model(
    env: &AgentEnv,
    params: &serde_json::Value,
    cap: &str,
) -> (Option<String>, Option<String>) {
    let from_params_p = params.get("providerId").and_then(|v| v.as_str()).map(String::from);
    let from_params_m = params.get("model").and_then(|v| v.as_str()).map(String::from);
    if from_params_p.is_some() || from_params_m.is_some() {
        return (from_params_p, from_params_m);
    }
    env.model_default(cap).map(|(p, m)| (Some(p), Some(m))).unwrap_or((None, None))
}

/// 统一 LLM 对话入口：按 Router 选择 Provider，按驱动分发。返回文本。
pub async fn llm_chat(
    env: &AgentEnv,
    messages: &[ChatMessage],
    json_mode: bool,
    preferred_provider: Option<&str>,
    preferred_model: Option<&str>,
) -> Result<(String, String, String), JobError> {
    let registry = { env.registry.read().clone() };
    let offline = env.offline_mode();
    let decision = ModelRouter::route(
        &registry,
        Capability::Chat,
        preferred_provider,
        preferred_model,
        offline,
        false,
    )
    .map_err(route_err)?;

    let text = match decision.provider.driver {
        ProviderDriverKind::Mock => {
            mock::chat(&(), &decision.provider, messages).await.map_err(|e| fatal(e.to_string()))?.text
        }
        ProviderDriverKind::Ollama => {
            ollama::chat(env.gateway(), &decision.provider, &decision.model_id, messages, json_mode)
                .await
                .map_err(|e| fatal(e.to_string()))?
                .text
        }
        ProviderDriverKind::OpenaiCompatible => {
            openai::chat(env.gateway(), &decision.provider, &decision.model_id, messages, json_mode, None, None)
                .await
                .map_err(|e| fatal(e.to_string()))?
                .text
        }
        ProviderDriverKind::CustomHttp => {
            return Err(fatal("Custom HTTP 驱动暂不支持 chat 能力（请配置 OpenAI 兼容 / Ollama / Mock）"));
        }
        other => return Err(fatal(format!("驱动 {other:?} 不支持 chat 能力"))),
    };
    Ok((text, decision.provider.id, decision.model_id))
}

/* ---------------- script.generate ---------------- */

pub fn script_generate_handler(env: Arc<AgentEnv>) -> JobHandler {
    Arc::new(move |ctx: JobContext| {
        let env = env.clone();
        Box::pin(async move {
            let brief = ctx.params.get("brief").and_then(|v| v.as_str()).unwrap_or("写一集都市情感短剧").to_string();
            ctx.report(0.1, "正在调用 LLM 生成剧本…");
            let messages = vec![
                ChatMessage::system(SCRIPT_SYSTEM_PROMPT),
                ChatMessage::user(format!("短剧需求：{brief}\n\n请输出本集剧本 JSON。")),
            ];
            let (raw, provider_id, model) = {
                let (pp, pm) = preferred_model(&env, &ctx.params, "chat");
                llm_chat(&env, &messages, true, pp.as_deref(), pm.as_deref()).await?
            };
            ctx.set_meta(json!({ "providerId": provider_id, "model": model }));
            ctx.report(0.7, "解析剧本 JSON…");
            let doc = ScriptDoc::parse(&raw).map_err(route_err)?;
            let doc = serde_json::to_value(&doc).map_err(|e| fatal(e.to_string()))?;

            // 写入 episodes/<ep>/script.json
            let episode = ctx
                .episode_id
                .clone()
                .or_else(|| ctx.params.get("episode").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .ok_or_else(|| fatal("未指定分集"))?;
            write_episode_doc(&ctx.root, &episode, "script", &doc)?;
            ctx.report(1.0, "剧本已保存");
            env.events("agent.message", json!({
                "text": format!("剧本已生成并保存到第 {episode} 集脚本（Provider: {provider_id} / {model}）。说「生成分钟」或「拆成分镜」可以继续。"),
                "kind": "script.done"
            }));
            Ok(vec![episode_script_path(&ctx.root, &episode).to_string_lossy().into_owned()])
        })
    })
}

/* ---------------- chat.reply ---------------- */

pub fn chat_reply_handler(env: Arc<AgentEnv>) -> JobHandler {
    Arc::new(move |ctx: JobContext| {
        let env = env.clone();
        Box::pin(async move {
            let text = ctx.params.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let messages = vec![
                ChatMessage::system("你是 OneTV 短剧制作台的 AI 助手，熟悉剧本、分镜与生成工作流，回答简洁专业，用中文。"),
                ChatMessage::user(text),
            ];
            let (reply, provider_id, model) = {
                let (pp, pm) = preferred_model(&env, &ctx.params, "chat");
                llm_chat(&env, &messages, false, pp.as_deref(), pm.as_deref()).await?
            };
            // 回复双通道：实时事件驱动对话流 + result 元数据落库（任务事件可追溯）。
            // 之前只发事件且回写 outputs=[]，任务显示"已完成"但回复既不在对话流也无法追溯。
            ctx.set_meta(json!({ "providerId": provider_id, "model": model, "reply": reply }));
            env.events("agent.message", json!({ "text": reply, "kind": "chat" }));
            Ok(vec![])
        })
    })
}

/* ---------------- image.generate / storyboard.image_batch ---------------- */

async fn generate_one_image(
    env: &AgentEnv,
    prompt: &str,
    aspect: &str,
    out_dir: &Path,
    preferred_provider: Option<&str>,
    preferred_model_id: Option<&str>,
) -> Result<(Vec<PathBuf>, String, String), JobError> {
    let registry = { env.registry.read().clone() };
    let decision = ModelRouter::route(
        &registry,
        Capability::ImageGeneration,
        preferred_provider,
        preferred_model_id,
        env.offline_mode(),
        false,
    )
    .map_err(route_err)?;
    let files = match decision.provider.driver {
        ProviderDriverKind::Mock => {
            mock::generate_image(env.media(), prompt, aspect, out_dir)
                .await
                .map_err(|e| transient(e.to_string()))?
        }
        ProviderDriverKind::OpenaiCompatible => {
            let size = match aspect {
                "16:9" => Some("1792x1024"),
                "1:1" => Some("1024x1024"),
                _ => Some("1024x1792"),
            };
            openai::generate_image(env.gateway(), &decision.provider, &decision.model_id, prompt, size, 1, out_dir)
                .await
                .map_err(|e| transient(e.to_string()))?
        }
        ProviderDriverKind::StableDiffusion => {
            crate::providers::sd::txt2img(
                env.gateway(),
                &decision.provider,
                &decision.model_id,
                prompt,
                "低质量, 模糊, 变形, 多余肢体, 文字水印",
                aspect,
                30,
                out_dir,
            )
            .await
            .map_err(|e| transient(e.to_string()))?
        }
        ProviderDriverKind::Comfyui => {
            // 与 SD 驱动同一逻辑：本地直连、免鉴权、Local-only 可用
            crate::providers::comfyui::txt2img(
                env.gateway(),
                &decision.provider,
                &decision.model_id,
                prompt,
                "低质量, 模糊, 变形, 多余肢体, 文字水印",
                aspect,
                20,
                out_dir,
                || false,
            )
            .await
            .map_err(|e| transient(e.to_string()))?
        }
        other => return Err(fatal(format!("驱动 {other:?} 暂不支持生图；请使用 OpenAI 兼容 / Mock Provider"))),
    };
    Ok((files, decision.provider.id, decision.model_id))
}

pub fn image_generate_handler(env: Arc<AgentEnv>) -> JobHandler {
    Arc::new(move |ctx: JobContext| {
        let env = env.clone();
        Box::pin(async move {
            let prompt = ctx.params.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let aspect = ctx.params.get("aspect").and_then(|v| v.as_str()).unwrap_or("9:16").to_string();
            let out_dir = ctx.root.join("renders").join(&ctx.job_id);
            ctx.report(0.2, "调用生图 Provider…");
            let (pp, pm) = preferred_model(&env, &ctx.params, "image");
            let (files, provider_id, model) =
                generate_one_image(&env, &prompt, &aspect, &out_dir, pp.as_deref(), pm.as_deref()).await?;
            ctx.set_meta(json!({ "providerId": provider_id, "model": model }));
            ctx.report(0.9, "保存结果…");
            Ok(files.iter().map(|p| p.to_string_lossy().into_owned()).collect())
        })
    })
}

pub fn storyboard_image_batch_handler(env: Arc<AgentEnv>) -> JobHandler {
    Arc::new(move |ctx: JobContext| {
        let env = env.clone();
        Box::pin(async move {
            let episode = ctx
                .episode_id
                .clone()
                .or_else(|| ctx.params.get("episode").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .ok_or_else(|| fatal("未指定分集"))?;
            let sb = read_episode_doc(&ctx.root, &episode, "storyboard")?;
            let shots = sb
                .get("shots")
                .and_then(|v| v.as_array())
                .cloned()
                .ok_or_else(|| fatal("分镜表为空，请先执行「拆成分镜」"))?;
            if shots.is_empty() {
                return Err(fatal("分镜表为空"));
            }
            let bible_style = read_bible_style(&ctx.root);
            let out_dir = ctx.root.join("renders").join(&ctx.job_id);
            let total = shots.len();
            let mut updated = shots.clone();
            for (i, shot) in shots.iter().enumerate() {
                if ctx.is_cancelled() {
                    return Err(fatal("已取消"));
                }
                let prompt = build_shot_prompt(shot, &bible_style);
                ctx.report(i as f64 / total as f64, &format!("生成分镜图 {}/{}…", i + 1, total));
                let (pp, pm) = preferred_model(&env, &ctx.params, "image");
                let (files, provider_id, model) =
                    generate_one_image(&env, &prompt, "9:16", &out_dir, pp.as_deref(), pm.as_deref()).await?;
                ctx.set_meta(json!({ "providerId": provider_id, "model": model }));
                if let Some(asset_id) = register_asset(&ctx.root, files.first(), "images") {
                    updated[i]["outputAssetId"] = json!(asset_id);
                    updated[i]["status"] = json!("ready");
                }
            }
            ctx.report(0.95, "写回分镜表…");
            let sb_out = json!({
                "schemaVersion": sb.get("schemaVersion").cloned().unwrap_or(json!("1.0")),
                "episodeId": episode,
                "shots": updated,
                "updatedAt": chrono::Utc::now().to_rfc3339()
            });
            write_episode_doc(&ctx.root, &episode, "storyboard", &sb_out)?;
            env.events("agent.message", json!({
                "text": format!("分镜图批量生成完成：{total} 张已入库。可以在「分镜」页逐个审核，或直接说「合成成片」。"),
                "kind": "storyboard.done"
            }));
            Ok(vec![])
        })
    })
}

fn build_shot_prompt(shot: &serde_json::Value, style: &str) -> String {
    let scene = shot.get("scene").and_then(|v| v.as_str()).unwrap_or("");
    let size = shot.get("shotSize").and_then(|v| v.as_str()).unwrap_or("中景");
    let cam = shot
        .get("camera")
        .and_then(|c| c.get("movement"))
        .and_then(|v| v.as_str())
        .unwrap_or("固定机位");
    let action = shot.get("action").and_then(|v| v.as_str()).unwrap_or("");
    let expr = shot.get("expression").and_then(|v| v.as_str()).unwrap_or("");
    let time = shot.get("time").and_then(|v| v.as_str()).unwrap_or("夜");
    format!(
        "电影感短剧剧照，{scene}，{time}，{size}，{cam}。画面：{action}。{expr}。视觉风格：{style}。高清写实，浅景深，霓虹光效，中文都市剧质感。"
    )
}

fn read_bible_style(root: &Path) -> String {
    let p = root.join("bible").join("story.json");
    if let Ok(raw) = std::fs::read_to_string(p) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(s) = v.pointer("/story/visualStyle").and_then(|x| x.as_str()) {
                return s.to_string();
            }
        }
    }
    "赛博朋克霓虹，深蓝与品红撞色".into()
}

fn register_asset(root: &Path, file: Option<&PathBuf>, kind: &str) -> Option<String> {
    let f = file?;
    onetv_project::ops::import_asset(root, f, kind).ok().map(|r| r.id)
}

/* ---------------- video.generate ---------------- */

pub fn video_generate_handler(env: Arc<AgentEnv>) -> JobHandler {
    Arc::new(move |ctx: JobContext| {
        let env = env.clone();
        Box::pin(async move {
            let prompt = ctx.params.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string();
            let aspect = ctx.params.get("aspect").and_then(|v| v.as_str()).unwrap_or("9:16").to_string();
            let duration = ctx.params.get("duration").and_then(|v| v.as_u64()).unwrap_or(5) as u32;
            let registry = { env.registry.read().clone() };
            let (vpp, vpm) = preferred_model(&env, &ctx.params, "video");
            let decision = ModelRouter::route(
                &registry,
                Capability::VideoGeneration,
                vpp.as_deref(),
                vpm.as_deref(),
                env.offline_mode(),
                false,
            )
            .map_err(route_err)?;
            ctx.report(0.15, &format!("调用视频 Provider：{}/{}", decision.provider.name, decision.model_id));
            let provider_id = decision.provider.id.clone();
            let model_id = decision.model_id.clone();
            let out_dir = ctx.root.join("renders").join(&ctx.job_id);
            let files = match decision.provider.driver {
                ProviderDriverKind::Mock => {
                    mock::generate_video(env.media(), &prompt, duration, &aspect, &out_dir)
                        .await
                        .map_err(|e| transient(e.to_string()))?
                }
                ProviderDriverKind::CustomHttp => {
                    let tmpl_val = decision
                        .provider
                        .http_template
                        .clone()
                        .ok_or_else(|| fatal("Custom HTTP Provider 缺少请求模板（httpTemplate 字段）"))?;
                    let tmpl: crate::providers::custom_http::HttpTemplate =
                        serde_json::from_value(tmpl_val).map_err(|e| fatal(format!("模板解析失败: {e}")))?;
                    let secret = if decision.provider.auth.auth_type != "none" {
                        Some(env.gateway().secret_for(&decision.provider).map_err(route_err)?)
                    } else {
                        None
                    };
                    let input = json!({
                        "prompt": prompt,
                        "aspectRatio": aspect,
                        "durationSec": duration
                    });
                    let out = crate::providers::custom_http::execute(
                        env.gateway(),
                        &decision.provider,
                        &decision.model_id,
                        &tmpl,
                        &input,
                        secret,
                        &out_dir,
                        || ctx.is_cancelled(),
                    )
                    .await
                    .map_err(|e| transient(e.to_string()))?;
                    out.result_urls.iter().map(PathBuf::from).collect()
                }
                other => {
                    return Err(fatal(format!(
                        "驱动 {other:?} 暂不支持生视频：请使用 Mock（离线演示）或配置 Custom HTTP 视频模板"
                    )))
                }
            };
            ctx.report(0.9, "下载/保存结果…");
            ctx.set_meta(json!({ "providerId": provider_id, "model": model_id }));
            Ok(files.iter().map(|p| p.to_string_lossy().into_owned()).collect())
        })
    })
}

/* ---------------- audio.tts ---------------- */

pub fn tts_handler(env: Arc<AgentEnv>) -> JobHandler {
    Arc::new(move |ctx: JobContext| {
        let env = env.clone();
        Box::pin(async move {
            let text = ctx.params.get("text").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if text.trim().is_empty() {
                return Err(fatal("没有可配音的文本"));
            }
            let registry = { env.registry.read().clone() };
            let (tpp, tpm) = preferred_model(&env, &ctx.params, "tts");
            let decision = ModelRouter::route(&registry, Capability::Tts, tpp.as_deref(), tpm.as_deref(), env.offline_mode(), false)
                .map_err(route_err)?;
            let out_dir = ctx.root.join("renders").join(&ctx.job_id);
            let dest = out_dir.join("voice.mp3");
            ctx.report(0.3, "调用 TTS Provider…");
            match decision.provider.driver {
                ProviderDriverKind::Mock => {
                    mock::tts(env.media(), &text, &dest).await.map_err(|e| transient(e.to_string()))?;
                }
                ProviderDriverKind::OpenaiCompatible => {
                    openai::tts(env.gateway(), &decision.provider, &decision.model_id, &text, "alloy", &dest)
                        .await
                        .map_err(|e| transient(e.to_string()))?;
                }
                other => return Err(fatal(format!("驱动 {other:?} 暂不支持 TTS"))),
            }
            ctx.set_meta(json!({ "providerId": decision.provider.id, "model": decision.model_id }));
            Ok(vec![dest.to_string_lossy().into_owned()])
        })
    })
}

/* ---------------- 本地工具：shot.split / character.bind ---------------- */

pub fn split_shots_of_script(script: &ScriptDoc) -> Vec<serde_json::Value> {
    let mut shots = Vec::new();
    const SIZES: [&str; 4] = ["中景", "近景", "特写", "全景"];
    const CAMS: [&str; 4] = ["固定机位", "slow_push_in", "handheld", "pan_right"];
    let mut idx = 0;
    for (si, scene) in script.scenes.iter().enumerate() {
        // 建立镜头（场景交代）
        idx += 1;
        shots.push(json!({
            "shotId": format!("EP01-S{:03}", idx),
            "scene": scene.heading,
            "time": scene_time(&scene.heading),
            "shotSize": if si == 0 { "全景" } else { "中景" },
            "camera": {"movement": "establishing", "angle": "eye_level"},
            "characters": [],
            "action": scene.synopsis,
            "expression": "",
            "dialogue": "",
            "subtitle": "",
            "durationSec": 3.0,
            "prompt": "",
            "referenceAssets": [],
            "generation": {"type": "text_to_video", "duration": 3, "aspectRatio": "9:16"},
            "status": "draft"
        }));
        for d in &scene.dialogues {
            idx += 1;
            let dur = ((2.0 + d.line.chars().count() as f64 / 5.0).min(8.0)).max(2.5);
            shots.push(json!({
                "shotId": format!("EP01-S{:03}", idx),
                "scene": scene.heading,
                "time": scene_time(&scene.heading),
                "shotSize": SIZES[idx % SIZES.len()],
                "camera": {"movement": CAMS[idx % CAMS.len()], "angle": "eye_level", "lens": "50mm"},
                "characters": [d.character_name],
                "action": format!("{}说话", d.character_name),
                "expression": d.parenthetical.clone().unwrap_or_default(),
                "dialogue": d.line,
                "subtitle": d.line,
                "durationSec": (dur * 10.0).round() / 10.0,
                "prompt": "",
                "referenceAssets": [],
                "generation": {"type": "text_to_video", "duration": (dur.ceil() as u32).max(3), "aspectRatio": "9:16"},
                "status": "draft"
            }));
        }
    }
    shots
}

fn scene_time(heading: &str) -> String {
    if heading.contains("夜") {
        "夜".into()
    } else if heading.contains("黄昏") || heading.contains("傍晚") {
        "黄昏".into()
    } else {
        "日".into()
    }
}

pub fn storyboard_build_handler(_env: Arc<AgentEnv>) -> JobHandler {
    Arc::new(move |ctx: JobContext| {
        Box::pin(async move {
            let episode = ctx
                .episode_id
                .clone()
                .or_else(|| ctx.params.get("episode").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .ok_or_else(|| fatal("未指定分集"))?;
            let script_raw = read_episode_doc(&ctx.root, &episode, "script")?;
            let script: ScriptDoc =
                serde_json::from_value(script_raw).map_err(|e| fatal(format!("剧本读取失败: {e}")))?;
            ctx.report(0.3, "拆分镜头…");
            let shots = split_shots_of_script(&script);
            ctx.report(0.8, "绑定角色参考…");
            let shots = bind_characters(&ctx.root, shots);
            let sb = json!({
                "schemaVersion": "1.0",
                "episodeId": episode,
                "shots": shots,
                "updatedAt": chrono::Utc::now().to_rfc3339()
            });
            write_episode_doc(&ctx.root, &episode, "storyboard", &sb)?;
            Ok(vec![])
        })
    })
}

/// 从 bible 的 characters + assets 表为镜头绑定参考资产。
fn bind_characters(root: &Path, mut shots: Vec<serde_json::Value>) -> Vec<serde_json::Value> {
    // 收集 bible 角色：name → ref asset path
    let mut name_to_ref: std::collections::HashMap<String, String> = Default::default();
    if let Ok(raw) = std::fs::read_to_string(root.join("bible").join("story.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(chars) = v.get("characters").and_then(|c| c.as_array()) {
                for c in chars {
                    if let (Some(name), Some(ref_id)) = (
                        c.get("name").and_then(|x| x.as_str()),
                        c.get("refAssetId").and_then(|x| x.as_str()),
                    ) {
                        name_to_ref.insert(name.to_string(), ref_id.to_string());
                    }
                }
            }
        }
    }
    for shot in shots.iter_mut() {
        if let Some(chars) = shot.get_mut("characters").and_then(|c| c.as_array_mut()) {
            let mut refs: Vec<String> = Vec::new();
            for c in chars.iter() {
                if let Some(name) = c.as_str() {
                    if let Some(id) = name_to_ref.get(name) {
                        refs.push(id.clone());
                    }
                }
            }
            shot["referenceAssets"] = json!(refs);
        }
    }
    shots
}

/* ---------------- 共享 IO helpers ---------------- */

pub fn episode_script_path(root: &Path, episode: &str) -> PathBuf {
    root.join("episodes").join(episode).join("script.json")
}

pub fn read_episode_doc(root: &Path, episode: &str, kind: &str) -> Result<serde_json::Value, JobError> {
    let p = root
        .join("episodes")
        .join(episode)
        .join(match kind {
            "script" => "script.json",
            "storyboard" => "storyboard.json",
            "canvas" => "canvas.json",
            "timeline" => "timeline.json",
            other => return Err(fatal(format!("未知文档类型 {other}"))),
        });
    if !p.exists() {
        return Err(fatal(format!("文档不存在: {}", p.display())));
    }
    let raw = std::fs::read_to_string(p).map_err(|e| fatal(e.to_string()))?;
    serde_json::from_str(&raw).map_err(|e| fatal(e.to_string()))
}

pub fn write_episode_doc(
    root: &Path,
    episode: &str,
    kind: &str,
    doc: &serde_json::Value,
) -> Result<(), JobError> {
    let dir = root.join("episodes").join(episode);
    std::fs::create_dir_all(&dir).map_err(|e| fatal(e.to_string()))?;
    let p = dir.join(match kind {
        "script" => "script.json",
        "storyboard" => "storyboard.json",
        "canvas" => "canvas.json",
        "timeline" => "timeline.json",
        other => return Err(fatal(format!("未知文档类型 {other}"))),
    });
    let json = serde_json::to_string_pretty(doc).map_err(|e| fatal(e.to_string()))?;
    std::fs::write(p, json).map_err(|e| fatal(e.to_string()))
}

pub fn cancel_flag(_ctx: &JobContext) -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

pub fn cancel_check(ctx: &JobContext) -> bool {
    ctx.cancel.load(Ordering::Relaxed)
}

/* ---------------- timeline.build + render ---------------- */

fn asset_path_by_id(root: &Path, asset_id: &str) -> Option<PathBuf> {
    let conn = onetv_project::db::open(&root.join("database.sqlite")).ok()?;
    conn.query_row("SELECT path FROM assets WHERE id = ?1", [asset_id], |r| r.get::<_, String>(0))
        .ok()
        .map(PathBuf::from)
}

fn latest_asset_of_kind(root: &Path, kind: &str) -> Option<(String, PathBuf)> {
    let conn = onetv_project::db::open(&root.join("database.sqlite")).ok()?;
    conn.query_row(
        "SELECT id, path FROM assets WHERE kind = ?1 ORDER BY created_at DESC LIMIT 1",
        [kind],
        |r| Ok((r.get::<_, String>(0)?, PathBuf::from(r.get::<_, String>(1)?))),
    )
    .ok()
}

fn is_image_path(p: &Path) -> bool {
    matches!(
        p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("webp") | Some("gif")
    )
}

pub fn timeline_render_handler(env: Arc<AgentEnv>) -> JobHandler {
    Arc::new(move |ctx: JobContext| {
        let env = env.clone();
        Box::pin(async move {
            use onetv_media::render::{compose, write_srt, ClipSource, RenderSpec};
            let episode = ctx
                .episode_id
                .clone()
                .or_else(|| ctx.params.get("episode").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .ok_or_else(|| fatal("未指定分集"))?;
            let sb = read_episode_doc(&ctx.root, &episode, "storyboard")?;
            let shots = sb
                .get("shots")
                .and_then(|v| v.as_array())
                .cloned()
                .ok_or_else(|| fatal("分镜表为空"))?;

            let mut clips = Vec::new();
            let mut cues: Vec<(f64, f64, String)> = Vec::new();
            let mut t = 0.0f64;
            for shot in &shots {
                if ctx.is_cancelled() {
                    return Err(fatal("已取消"));
                }
                let Some(asset_id) = shot.get("outputAssetId").and_then(|v| v.as_str()) else { continue };
                let Some(path) = asset_path_by_id(&ctx.root, asset_id) else { continue };
                let dur = shot.get("durationSec").and_then(|v| v.as_f64()).unwrap_or(3.0).max(1.0);
                let text = shot.get("subtitle").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if !text.is_empty() {
                    cues.push((t, t + dur.min(4.0), text));
                }
                t += dur;
                clips.push(ClipSource { is_image: is_image_path(&path), path: path.clone(), duration: dur, text: None });
            }
            if clips.is_empty() {
                return Err(fatal("没有已生成的镜头产物。请先审批并批量生成分镜图/视频"));
            }
            ctx.report(0.2, "构建时间线…");
            // timeline.json 持久化（规格 §12.2）
            let timeline = json!({
                "schemaVersion": "1.0",
                "fps": 30,
                "tracks": [
                    {"id": "v1", "type": "video", "clips": clips.iter().map(|c| json!({
                        "asset": c.path.to_string_lossy(), "start": 0.0, "duration": c.duration
                    })).collect::<Vec<_>>()},
                    {"id": "sub1", "type": "subtitle", "clips": cues.iter().map(|(s,e,x)| json!({
                        "asset": "", "text": x, "start": s, "duration": e - s
                    })).collect::<Vec<_>>()}
                ]
            });
            write_episode_doc(&ctx.root, &episode, "timeline", &timeline)?;

            let work = ctx.root.join("renders").join(format!("{episode}_compose_{}", chrono::Utc::now().timestamp()));
            let srt_path = work.join("subs.srt");
            std::fs::create_dir_all(&work).map_err(|e| fatal(e.to_string()))?;
            write_srt(&cues, &srt_path).map_err(|e| fatal(e.to_string()))?;
            // 音轨：最近一次 TTS 产物（若有）
            let audio = latest_asset_of_kind(&ctx.root, "audio").map(|(_, p)| p);

            let spec = RenderSpec {
                width: 1080,
                height: 1920,
                fps: 30,
                clips,
                subtitle_srt: Some(srt_path.clone()),
                audio,
                crf: 20,
            };
            let out = ctx.root.join("renders").join(format!("{episode}_draft_{}.mp4", chrono::Utc::now().timestamp()));
            ctx.report(0.4, "FFmpeg 本地合成中（不出网）…");
            compose(env.media(), &spec, &out, &work).map_err(|e| fatal(e.to_string()))?;
            // SRT 侧车始终输出（无论是否硬字幕）
            let srt_out = out.with_extension("srt");
            let _ = std::fs::copy(&srt_path, &srt_out);
            ctx.report(0.95, "入库…");
            env_agent_message(&env, &format!("成片初剪已合成（{:.1}s，含硬字幕）。可在「任务」查看，或说「导出竖版」。", t), "timeline.done");
            Ok(vec![out.to_string_lossy().into_owned()])
        })
    })
}

fn env_agent_message(env: &AgentEnv, text: &str, kind: &str) {
    env.events("agent.message", json!({ "text": text, "kind": kind }));
}

/* ---------------- export.render ---------------- */

pub fn export_render_handler(env: Arc<AgentEnv>) -> JobHandler {
    Arc::new(move |ctx: JobContext| {
        let env = env.clone();
        Box::pin(async move {
            use onetv_media::render::preset_size;
            let preset = ctx.params.get("preset").and_then(|v| v.as_str()).unwrap_or("douyin_vertical").to_string();
            let (w, h) = preset_size(&preset);
            let Some((_, src)) = latest_asset_of_kind(&ctx.root, "videos") else {
                return Err(fatal("没有可导出的成片。请先「合成成片」"));
            };
            ctx.report(0.2, "本地转码导出（不出网）…");
            let locator = env.media().clone();
            let resolved = locator.resolve().map_err(|e| fatal(e.to_string()))?;
            let out = ctx.root.join("renders").join(format!(
                "export_{}_{}.mp4",
                preset,
                chrono::Utc::now().timestamp()
            ));
            let status = std::process::Command::new(&resolved.ffmpeg)
                .args(["-y", "-v", "error", "-i"])
                .arg(&src)
                .args(["-vf", &format!("scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2")])
                .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "21", "-c:a", "aac"])
                .arg(&out)
                .status()
                .map_err(|e| fatal(e.to_string()))?;
            if !status.success() {
                return Err(fatal("导出转码失败"));
            }
            ctx.report(0.9, "导出完成");
            env_agent_message(&env, &format!("已导出 {w}×{h} 版本：{}", out.display()), "export.done");
            Ok(vec![out.to_string_lossy().into_owned()])
        })
    })
}

/* ---------------- video.understand ---------------- */

pub fn video_understand_handler(env: Arc<AgentEnv>) -> JobHandler {
    Arc::new(move |ctx: JobContext| {
        let env = env.clone();
        Box::pin(async move {
            let locator = env.media().clone();
            let resolved = locator.resolve().map_err(|e| fatal(e.to_string()))?;
            // 目标视频：参数 assetId > 最近导入的视频资产
            let video = match ctx.params.get("assetId").and_then(|v| v.as_str()) {
                Some(id) => asset_path_by_id(&ctx.root, id).ok_or_else(|| fatal("找不到该视频资产"))?,
                None => {
                    latest_asset_of_kind(&ctx.root, "videos")
                        .map(|(_, p)| p)
                        .ok_or_else(|| fatal("项目中没有视频。请先导入一个本地视频（资产页）"))?
                }
            };
            ctx.report(0.1, "读取媒体信息…");
            let info = onetv_media::probe(&locator, &video).map_err(|e| fatal(e.to_string()))?;
            ctx.report(0.3, "场景切分检测…");
            // 场景检测：select scene 阈值，showinfo 输出 pts_time
            let output = std::process::Command::new(&resolved.ffmpeg)
                .args(["-i"])
                .arg(&video)
                .args(["-vf", "select='gt(scene,0.30)',showinfo", "-f", "null", "-"])
                .stderr(std::process::Stdio::piped())
                .stdout(std::process::Stdio::null())
                .output()
                .map_err(|e| fatal(e.to_string()))?;
            let mut cuts: Vec<f64> = vec![0.0];
            let err_text = String::from_utf8_lossy(&output.stderr);
            for line in err_text.lines() {
                if let Some(pos) = line.find("pts_time:") {
                    if let Ok(t) = line[pos + 9..].split(' ').next().unwrap_or("").parse::<f64>() {
                        cuts.push(t);
                    }
                }
            }
            cuts.retain(|t| *t < info.duration_sec - 0.2);
            cuts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            cuts.dedup();

            ctx.report(0.55, "抽取关键帧…");
            let work = ctx.root.join("renders").join(format!("understand_{}", chrono::Utc::now().timestamp()));
            std::fs::create_dir_all(&work).map_err(|e| fatal(e.to_string()))?;
            let mut shots = Vec::new();
            for (i, &start) in cuts.iter().enumerate() {
                if ctx.is_cancelled() {
                    return Err(fatal("已取消"));
                }
                let end = cuts.get(i + 1).copied().unwrap_or(info.duration_sec).min(info.duration_sec);
                let dur = (end - start).max(0.4);
                let mid = start + dur / 2.0;
                let frame = work.join(format!("kf_{i:03}.png"));
                let _ = onetv_media::thumbnail(&locator, &video, mid, &frame, 640);
                let size = match (info.width, info.height) {
                    (Some(w), Some(h)) if h > w => "竖版画面",
                    (Some(w), Some(h)) if w > h => "横版画面",
                    _ => "未知画幅",
                };
                shots.push(json!({
                    "shotId": format!("SRC-S{:03}", i + 1),
                    "timestamp": {"start": (start * 10.0).round() / 10.0, "end": (end * 10.0).round() / 10.0},
                    "durationSec": (dur * 10.0).round() / 10.0,
                    "shotSize": "",
                    "camera": {"movement": "", "angle": ""},
                    "scene": "",
                    "characters": [],
                    "action": "",
                    "speech": "",
                    "silentText": "",
                    "audio": "",
                    "transition": if i == 0 { "开片" } else { "切" },
                    "color": "",
                    "sourceFrame": frame.to_string_lossy(),
                    "recreationPrompt": format!("复刻镜头 {i}: {size}，时长 {dur:.1}s，关键帧见 sourceFrame"),
                    "continuity": ""
                }));
                ctx.report(0.55 + 0.35 * (i as f64 / cuts.len().max(1) as f64), &format!("分析镜头 {}/{}…", i + 1, cuts.len()));
            }
            let doc = json!({
                "schemaVersion": "1.0",
                "source": video.to_string_lossy(),
                "durationSec": info.duration_sec,
                "width": info.width,
                "height": info.height,
                "fps": info.fps,
                "hasAudio": info.has_audio,
                "shots": shots,
                "notes": "VLM 语义分析（台词/人物/表情识别）需要在设置中配置 Vision 能力的 Provider；当前为确定性管线结果。",
                "updatedAt": chrono::Utc::now().to_rfc3339()
            });
            let episode = ctx.episode_id.clone().unwrap_or_else(|| "ep01".into());
            let out = ctx.root.join("episodes").join(&episode).join("understanding.json");
            std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| fatal(e.to_string()))?;
            std::fs::write(&out, serde_json::to_string_pretty(&doc).map_err(|e| fatal(e.to_string()))?)
                .map_err(|e| fatal(e.to_string()))?;
            env_agent_message(&env, &format!(
                "视频理解完成：检测到 {} 个镜头切分，结构化结果已写入 {}（可在分镜页复刻）",
                shots.len(),
                out.display()
            ), "understand.done");
            Ok(vec![out.to_string_lossy().into_owned()])
        })
    })
}
