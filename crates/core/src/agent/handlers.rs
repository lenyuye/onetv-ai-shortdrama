//! Agent 侧 Job 处理器（L3 Executor 的具体执行体）。
//! 每个处理器：解析参数 → 经 ModelRouter/Gateway 调 Provider → 产出本地文件 → 返回路径。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde_json::json;

use crate::agent::tools::{ScriptDoc, SCRIPT_SYSTEM_PROMPT};
use crate::jobs::{JobContext, JobError, JobHandler};
use crate::providers::mock;
use crate::providers::ollama;
use crate::providers::openai::{self, ChatMessage};
use crate::providers::router::ModelRouter;
use crate::providers::{Capability, ProviderDriverKind};

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

/// 解析 params.referenceAssetIds → 项目资产记录。
/// 节点生成面板绑定的参考（本地上传 / 画布节点产物 / 节点已挂参考）经此真正进入生成链路；
/// 此前该字段只落进 params JSON、无任何消费方（绑定后不生效）。
fn resolve_references(root: &Path, params: &serde_json::Value) -> Vec<onetv_project::ops::AssetRecord> {
    let ids: Vec<&str> = params
        .get("referenceAssetIds")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|x| x.as_str()).collect())
        .unwrap_or_default();
    if ids.is_empty() {
        return vec![];
    }
    let assets = onetv_project::ops::list_assets(root).unwrap_or_default();
    ids.iter()
        .filter_map(|id| assets.iter().find(|a| &a.id == id).cloned())
        .collect()
}

/// 首个图片参考的本地路径（图生图 / 图生视频底图用）。
fn first_image_ref(refs: &[onetv_project::ops::AssetRecord]) -> Option<PathBuf> {
    refs.iter().find(|a| a.kind == "images").map(|a| PathBuf::from(&a.path))
}

/// CustomHttp 模板可用的参考清单（模板变量 input.references / input.referenceAssetIds）。
fn refs_json(refs: &[onetv_project::ops::AssetRecord]) -> serde_json::Value {
    serde_json::Value::Array(
        refs.iter()
            .map(|a| json!({ "assetId": a.id, "path": a.path, "kind": a.kind }))
            .collect(),
    )
}

/// 统一 LLM 对话入口：按 Router 选择 Provider，按驱动分发。返回文本。
/// on_delta：Some 且驱动支持（OpenAI 兼容）时走 SSE 流式，逐 delta 回调；None 或不支持则一次性返回。
#[allow(clippy::too_many_arguments)]
pub async fn llm_chat(
    env: &AgentEnv,
    messages: &[ChatMessage],
    json_mode: bool,
    preferred_provider: Option<&str>,
    preferred_model: Option<&str>,
    on_delta: Option<&(dyn Fn(&str) + Send + Sync)>,
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
            if let Some(cb) = on_delta {
                openai::chat_stream(env.gateway(), &decision.provider, &decision.model_id, messages, json_mode, cb)
                    .await
                    .map_err(|e| fatal(e.to_string()))?
            } else {
                openai::chat(env.gateway(), &decision.provider, &decision.model_id, messages, json_mode, None, None)
                    .await
                    .map_err(|e| fatal(e.to_string()))?
                    .text
            }
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
                llm_chat(&env, &messages, true, pp.as_deref(), pm.as_deref(), None).await?
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
                "kind": "script.done",
                "jobId": ctx.job_id
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
            // 会话上下文（v2.6.3）：前端随消息附带本会话最近几轮历史，chat 才有连贯记忆
            // 自定义指令（v2.26.16）：设置 → 自定义指令 的持久指令追加到系统提示（Codex AGENTS.md 式）
            let mut system_prompt =
                "你是 OneTV 短剧制作台的 AI 助手，熟悉剧本、分镜与生成工作流，回答简洁专业，用中文。".to_string();
            let custom = env.custom_instructions();
            if !custom.trim().is_empty() {
                system_prompt.push_str("\n\n用户自定义指令（必须遵守）：\n");
                system_prompt.push_str(custom.trim().chars().take(4000).collect::<String>().as_str());
            }
            let mut messages = vec![ChatMessage::system(system_prompt)];
            if let Some(hist) = ctx.params.get("history").and_then(|h| h.as_array()) {
                for m in hist.iter().take(16) {
                    let role = m.get("role").and_then(|v| v.as_str()).unwrap_or_default();
                    let content = m
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .chars()
                        .take(2000)
                        .collect::<String>();
                    if content.trim().is_empty() {
                        continue;
                    }
                    match role {
                        "user" => messages.push(ChatMessage::user(content)),
                        "assistant" => messages.push(ChatMessage::assistant(content)),
                        _ => {}
                    }
                }
            }
            // 自动记忆注入（v2.26.15）：开启时把与本次消息最相关的长期记忆作为系统上下文；
            // 关闭时与旧版行为一致（记忆仅手动 CRUD，不参与生成）。
            if env.auto_memory() {
                match onetv_project::ops::search_memories(&ctx.root, &text, 5) {
                    Ok(hits) => {
                        let mut items: Vec<String> = hits
                            .into_iter()
                            .filter(|(_, score)| *score >= 0.12)
                            .map(|(m, _)| format!("- {}", m.text))
                            .collect();
                        if items.is_empty() {
                            if let Ok(recent) = onetv_project::ops::list_memories(&ctx.root) {
                                items = recent
                                    .into_iter()
                                    .take(3)
                                    .map(|m| format!("- {}", m.text))
                                    .collect();
                            }
                        }
                        if !items.is_empty() {
                            messages.insert(
                                1,
                                ChatMessage::system(format!(
                                    "以下是用户的长期记忆（本机私有存储，供参考）：\n{}",
                                    items.join("\n")
                                )),
                            );
                        }
                    }
                    Err(e) => tracing::warn!("记忆注入失败: {e}"),
                }
            }
            messages.push(ChatMessage::user(text.clone()));
            // 流式（v2.6.2）：OpenAI 兼容驱动逐 delta 经 ctx.stream_delta 推送；
            // 其他驱动仍一次性返回（前端只收完整回复，行为不变）。
            // quiet（节点面板直发）不推流，回复由面板轮询消费
            let quiet = ctx.params.get("quiet").and_then(|v| v.as_bool()).unwrap_or(false);
            let on_delta = |d: &str| {
                if !quiet {
                    ctx.stream_delta(d);
                }
            };
            let (reply, provider_id, model) = {
                let (pp, pm) = preferred_model(&env, &ctx.params, "chat");
                llm_chat(&env, &messages, false, pp.as_deref(), pm.as_deref(), Some(&on_delta)).await?
            };
            // 回复双通道：实时事件驱动对话流 + result 元数据落库（任务事件可追溯）。
            // 之前只发事件且回写 outputs=[]，任务显示"已完成"但回复既不在对话流也无法追溯。
            ctx.set_meta(json!({ "providerId": provider_id, "model": model, "reply": reply }));
            // quiet=true（画布文本节点面板生成）时不推送到 Agent 对话流，回复由面板/节点回填消费
            let quiet = ctx.params.get("quiet").and_then(|v| v.as_bool()).unwrap_or(false);
            if !quiet {
                env.events("agent.message", json!({ "text": reply, "kind": "chat", "jobId": ctx.job_id }));
            }
            // 自动记忆提取（v2.26.15）：后台异步，不阻塞任务完成、失败不影响回复
            if env.auto_memory() && !quiet {
                let env2 = env.clone();
                let root = ctx.root.clone();
                let user_text = text.clone();
                let reply_text = reply.clone();
                let ex_provider = provider_id.clone();
                let ex_model = model.clone();
                tokio::spawn(async move {
                    // 复用主回复的同一 Provider/模型——否则自动路由到 Mock 会解析不出记忆
                    if let Err(e) =
                        extract_memories(&env2, &root, &user_text, &reply_text, &ex_provider, &ex_model).await
                    {
                        tracing::warn!("自动记忆提取失败: {e}");
                    }
                });
            }
            Ok(vec![])
        })
    })
}

/// 自动记忆提取（v2.26.15）：用当前对话模型从本轮对话中提取 0~3 条值得长期记住的事实，
/// 与既有记忆去重（二元组余弦 > 0.55 视为重复）后写入项目记忆库。
async fn extract_memories(
    env: &AgentEnv,
    root: &std::path::Path,
    user_text: &str,
    reply_text: &str,
    provider_id: &str,
    model_id: &str,
) -> Result<(), String> {
    let user_text: String = user_text.chars().take(1200).collect();
    let reply_text: String = reply_text.chars().take(1200).collect();
    if user_text.trim().chars().count() < 6 {
        return Ok(()); // 过短（打招呼等）没有记忆价值
    }
    let messages = vec![
        ChatMessage::system(
            "你是记忆提取器。从用户与助手的对话中提取值得长期记住的信息（用户身份/偏好/项目设定/人物设定/工作习惯等）。             只输出一个 JSON 字符串数组，每项是一句独立、自包含的中文短句（不超过60字）；没有值得记的就输出 []。不要输出任何解释或围栏。",
        ),
        ChatMessage::user(format!("用户说：{}\n\n助手答：{}", user_text, reply_text)),
    ];
    let (reply, _, _) = llm_chat(
        env,
        &messages,
        false,
        Some(provider_id),
        Some(model_id),
        None,
    )
    .await
    .map_err(|e| e.message)?;
    for item in parse_memory_items(&reply).into_iter().take(3) {
        // 去重：与最相似既有记忆比较
        let dup = onetv_project::ops::search_memories(root, &item, 1)
            .ok()
            .and_then(|hits| hits.first().map(|(_, sc)| *sc > 0.55))
            .unwrap_or(false);
        if dup {
            continue;
        }
        onetv_project::ops::add_memory(root, &item, "auto")
            .map_err(|e| format!("写入记忆失败: {e}"))?;
        tracing::info!("自动记忆已保存: {item}");
    }
    Ok(())
}

/// 宽容解析提取输出：剥围栏、截取首个 JSON 数组、过滤空串与超长项。
fn parse_memory_items(raw: &str) -> Vec<String> {
    let s = raw.trim();
    let s = s
        .strip_prefix("```json")
        .or_else(|| s.strip_prefix("```"))
        .unwrap_or(s)
        .trim()
        .strip_suffix("```")
        .unwrap_or(s)
        .trim();
    // 截取首个 '[' 到最后一个 ']'（模型偶尔夹带说明文字）
    let arr = match (s.find('['), s.rfind(']')) {
        (Some(a), Some(b)) if b > a => &s[a..=b],
        _ => return Vec::new(),
    };
    serde_json::from_str::<Vec<String>>(arr)
        .unwrap_or_default()
        .into_iter()
        .map(|t| t.trim().to_string())
        .filter(|t| {
            let n = t.chars().count();
            n >= 4 && n <= 80
        })
        .collect()
}

/* ---------------- image.generate / storyboard.image_batch ---------------- */

async fn generate_one_image(
    env: &AgentEnv,
    prompt: &str,
    aspect: &str,
    out_dir: &Path,
    preferred_provider: Option<&str>,
    preferred_model_id: Option<&str>,
    references: &[onetv_project::ops::AssetRecord],
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
    // 参考图（图生图）目前只有 Mock（离线合成）与 CustomHttp（模板自取路径）两个驱动可用；
    // 其余驱动带参考时明确报错，避免静默丢弃参考造成"已生效"的错觉
    if !references.is_empty()
        && !matches!(decision.provider.driver, ProviderDriverKind::Mock | ProviderDriverKind::CustomHttp)
    {
        return Err(fatal(format!(
            "驱动 {:?} 暂不支持参考图（图生图）；请移除参考，或改用 Mock / Custom HTTP Provider",
            decision.provider.driver
        )));
    }
    let files = match decision.provider.driver {
        ProviderDriverKind::Mock => {
            mock::generate_image(env.media(), prompt, aspect, first_image_ref(references).as_deref(), out_dir)
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
                "referenceAssetIds": references.iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
                "references": refs_json(references),
            });
            let out = crate::providers::custom_http::execute(
                env.gateway(),
                &decision.provider,
                &decision.model_id,
                &tmpl,
                &input,
                secret,
                out_dir,
                || false,
            )
            .await
            .map_err(crate::jobs::JobError::from)?;
            out.result_urls.iter().map(PathBuf::from).collect()
        }
        ProviderDriverKind::OpenaiCompatible => {
            let size = match aspect {
                "16:9" => Some("1792x1024"),
                "1:1" => Some("1024x1024"),
                _ => Some("1024x1792"),
            };
            openai::generate_image(env.gateway(), &decision.provider, &decision.model_id, prompt, size, 1, out_dir)
                .await
                .map_err(crate::jobs::JobError::from)?
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
            .map_err(crate::jobs::JobError::from)?
        }
        ProviderDriverKind::Comfyui => {
            // 与 SD 驱动同一逻辑：本地直连、免鉴权、Local-only 可用；
            // 配置了工作流模板则走模板（FLUX/自定义工作流），否则内置 SD 工作流
            if let Some(mut wf) = decision.provider.workflow_template.clone() {
                crate::providers::comfyui::patch_workflow(&mut wf, prompt, "低质量, 模糊, 变形, 多余肢体, 文字水印");
                let image = references.iter().find(|a| a.kind == "images").map(|a| PathBuf::from(&a.path));
                crate::providers::comfyui::run_workflow(env.gateway(), &decision.provider, wf, image.as_deref(), out_dir, || false, |_p| {}).await
            } else {
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
            }
            .map_err(crate::jobs::JobError::from)?
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
            let references = resolve_references(&ctx.root, &ctx.params);
            let out_dir = ctx.root.join("renders").join(&ctx.job_id);
            ctx.report(0.2, "调用生图 Provider…");
            let (pp, pm) = preferred_model(&env, &ctx.params, "image");
            let (files, provider_id, model) =
                generate_one_image(&env, &prompt, &aspect, &out_dir, pp.as_deref(), pm.as_deref(), &references).await?;
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
                    generate_one_image(&env, &prompt, "9:16", &out_dir, pp.as_deref(), pm.as_deref(), &[]).await?;
                ctx.set_meta(json!({ "providerId": provider_id, "model": model }));
                if let Some(asset_id) = register_generated_asset(&ctx.root, files.first(), "images") {
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
                "kind": "storyboard.done",
                "jobId": ctx.job_id
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

/// 生成类产物（图片等小文件）登记：走 import_asset 拷贝进 assets/，
/// 与成片类的零拷贝 ops::register_asset 区分（assets/ 目录的拷贝隔离只对生成产物有意义）。
fn register_generated_asset(root: &Path, file: Option<&PathBuf>, kind: &str) -> Option<String> {
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
            let references = resolve_references(&ctx.root, &ctx.params);
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
                    mock::generate_video(env.media(), &prompt, duration, &aspect, first_image_ref(&references).as_deref(), &out_dir)
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
                    // 首帧参考图 → data URI（远程平台图生视频用；无参考图为 null，模板用 ${input.firstFrameBase64?} 可选链）
                    let first_frame_b64 = first_image_ref(&references).and_then(|p| {
                        std::fs::read(&p).ok().and_then(|bytes| {
                            if bytes.len() > 12 * 1024 * 1024 {
                                tracing::warn!(size = bytes.len(), "首帧参考图超过 12MB，跳过 base64 注入");
                                return None;
                            }
                            let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("png").to_lowercase();
                            let mime = match ext.as_str() {
                                "jpg" | "jpeg" => "image/jpeg",
                                "webp" => "image/webp",
                                _ => "image/png",
                            };
                            use base64::Engine as _;
                            Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
                        })
                    });
                    // mode（v2.14）："extend" = 续写（以参考图/尾帧延续）；"generate" = 新生成。
                    // Mock：extend 走参考图生视频；CustomHttp 模板可用 ${input.mode} 区分端点。
                    let mode = ctx.params.get("mode").and_then(|v| v.as_str()).unwrap_or("generate").to_string();
                    let input = json!({
                        "prompt": prompt,
                        "aspectRatio": aspect,
                        "durationSec": duration,
                        "mode": mode,
                        "referenceAssetIds": references.iter().map(|a| a.id.clone()).collect::<Vec<_>>(),
                        "references": refs_json(&references),
                        "firstFrameBase64": first_frame_b64,
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
                    .map_err(crate::jobs::JobError::from)?;
                    out.result_urls.iter().map(PathBuf::from).collect()
                }
                ProviderDriverKind::Comfyui => {
                    // 本地生视频（v2.7）：Wan2.x 等开源权重经 ComfyUI 工作流，不出网零 API 成本
                    let Some(mut wf) = decision.provider.workflow_template.clone() else {
                        return Err(fatal(
                            "ComfyUI 生视频需要工作流模板：在 Provider 配置中粘贴 ComfyUI「API 格式」导出的工作流 JSON（文本节点用 __prompt__ 占位，seed 填 0 = 随机，首帧图自动上传到 LoadImage 节点）",
                        ));
                    };
                    crate::providers::comfyui::patch_workflow(&mut wf, &prompt, "");
                    // 画幅/时长 → Wan 常用数值占位（480p 档；16fps，帧数 = 时长×16+1）
                    let (width, height) = match aspect.as_str() {
                        "16:9" => (832, 480),
                        "1:1" => (624, 624),
                        _ => (480, 832),
                    };
                    let frames = (duration.saturating_mul(16)).saturating_add(1).clamp(33, 121);
                    crate::providers::comfyui::patch_workflow_vars(
                        &mut wf,
                        &[
                            ("width", serde_json::json!(width)),
                            ("height", serde_json::json!(height)),
                            ("frames", serde_json::json!(frames)),
                        ],
                    );
                    let image = references.iter().find(|a| a.kind == "images").map(|a| PathBuf::from(&a.path));
                    crate::providers::comfyui::run_workflow(env.gateway(), &decision.provider, wf, image.as_deref(), &out_dir, || ctx.is_cancelled(), |p| {
                        ctx.report(0.15 + p * 0.7, "ComfyUI 生成中（本地工作流）…");
                    })
                    .await
                    .map_err(crate::jobs::JobError::from)?
                }
                other => {
                    return Err(fatal(format!(
                        "驱动 {other:?} 暂不支持生视频：请使用 Mock（离线演示）、Custom HTTP 视频模板或 ComfyUI 工作流（Wan 本地）"
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
                    mock::tts(env.media(), &text, &dest).await.map_err(crate::jobs::JobError::from)?;
                }
                ProviderDriverKind::OpenaiCompatible => {
                    openai::tts(env.gateway(), &decision.provider, &decision.model_id, &text, "alloy", &dest)
                        .await
                        .map_err(crate::jobs::JobError::from)?;
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
            // 连续性校验（v2.13）：镜头角色须在 Story Bible 中登记（一致性上游）
            let bible_chars: Vec<String> = std::fs::read_to_string(ctx.root.join("bible").join("story.json"))
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
                .and_then(|v| v.get("characters").and_then(|c| c.as_array()).cloned())
                .unwrap_or_default()
                .into_iter()
                .filter_map(|c| c.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
                .collect();
            let mut continuity_warnings = Vec::new();
            for (i, shot) in shots.iter().enumerate() {
                if let Some(chars) = shot.get("characters").and_then(|c| c.as_array()) {
                    for name in chars.iter().filter_map(|c| c.as_str()) {
                        if !bible_chars.iter().any(|b| b == name) {
                            continuity_warnings.push(format!(
                                "镜头 {} 出现角色「{}」但 Story Bible 未登记（生成参考图时无法绑定参考）",
                                i + 1,
                                name
                            ));
                        }
                    }
                }
            }
            let sb = json!({
                "schemaVersion": "1.0",
                "episodeId": episode,
                "shots": shots,
                "continuityWarnings": continuity_warnings,
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
    write_bytes_atomic(&p, json.as_bytes())
}

/// 原子写：临时文件 + rename，防崩溃产生半截 JSON（v2.12.0）
pub fn write_bytes_atomic(p: &Path, bytes: &[u8]) -> Result<(), JobError> {
    let tmp = p.with_extension(format!(
        "tmp-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    std::fs::write(&tmp, bytes).map_err(|e| fatal(e.to_string()))?;
    std::fs::rename(&tmp, p).map_err(|e| fatal(e.to_string()))
}

pub fn cancel_flag(_ctx: &JobContext) -> Arc<AtomicBool> {
    Arc::new(AtomicBool::new(false))
}

pub fn cancel_check(ctx: &JobContext) -> bool {
    ctx.cancel.load(Ordering::Relaxed)
}

/* ---------------- timeline.build + render ---------------- */

/// 资产 id → 本地文件路径（sqlite assets 表 path 列）。
/// 时间线渲染的 assetId 解析与桌面端 timeline_probe_asset 共用。
pub fn asset_path_by_id(root: &Path, asset_id: &str) -> Option<PathBuf> {
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

/// 扫描 <root>/renders/ 下的 *.mp4（含一级子目录），按修改时间取最新的一个。
/// 时间线渲染（timeline_render）产物只落 renders/、不进 assets 表，
/// 该兜底保证「渲染成片」后即使 assets 表没有最新记录也能找到成片。
fn latest_render_output(root: &Path) -> Option<PathBuf> {
    fn consider(best: &mut Option<(std::time::SystemTime, PathBuf)>, p: PathBuf) {
        let is_mp4 = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("mp4"))
            .unwrap_or(false);
        if !is_mp4 {
            return;
        }
        if let Ok(mtime) = std::fs::metadata(&p).and_then(|m| m.modified()) {
            if best.as_ref().map(|(t, _)| mtime > *t).unwrap_or(true) {
                *best = Some((mtime, p));
            }
        }
    }
    let mut best: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in std::fs::read_dir(root.join("renders")).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            for sub in std::fs::read_dir(&path).ok()?.flatten() {
                let p = sub.path();
                if p.is_file() {
                    consider(&mut best, p);
                }
            }
        } else if path.is_file() {
            consider(&mut best, path);
        }
    }
    best.map(|(_, p)| p)
}

/// 导出源解析（三层兜底）：
/// ① params.sourcePath（预留，可选，显式指定优先）；
/// ② assets 表最新 videos（latest_asset_of_kind）；
/// ③ <root>/renders/*.mp4 按 mtime 取最新（递归一层，覆盖未入库的时间线渲染产物）。
/// 全部落空返回 None，由调用方给出可读报错。
fn resolve_export_source(root: &Path, source_path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = source_path {
        let p = p.trim();
        if !p.is_empty() {
            let path = PathBuf::from(p);
            if path.is_file() {
                return Some(path);
            }
        }
    }
    if let Some((_, path)) = latest_asset_of_kind(root, "videos") {
        if path.is_file() {
            return Some(path);
        }
    }
    latest_render_output(root)
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
            let episode = ctx
                .episode_id
                .clone()
                .or_else(|| ctx.params.get("episode").and_then(|v| v.as_str()).map(|s| s.to_string()))
                .ok_or_else(|| fatal("未指定分集"))?;

            /* ── §12.2 schemaVersion 2.0：编辑器多轨时间线 → onetv_media::timeline 多轨引擎 ──
             * 无 schemaVersion 或非 2.0 的旧文档走下方线性拼接逻辑，行为保持不动。 */
            let tl_path = ctx.root.join("episodes").join(&episode).join("timeline.json");
            let tl_doc = std::fs::read_to_string(&tl_path)
                .ok()
                .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());
            let is_v2 = tl_doc
                .as_ref()
                .and_then(|v| v.get("schemaVersion"))
                .and_then(|v| v.as_str())
                == Some("2.0");
            if is_v2 {
                use onetv_media::timeline::{render_timeline, TimelineSpec};
                let spec: TimelineSpec = serde_json::from_value(tl_doc.unwrap())
                    .map_err(|e| fatal(format!("时间线文档解析失败: {e}")))?;
                if ctx.is_cancelled() {
                    return Err(fatal("已取消"));
                }
                ctx.report(0.05, "多轨时间线渲染中（FFmpeg 本地，不出网）…");
                let track_count = spec.tracks.len();
                let locator = env.media().clone();
                let root = ctx.root.clone();
                let resolver = move |id: &str| asset_path_by_id(&root, id);
                let work = ctx
                    .root
                    .join("renders")
                    .join(format!("{episode}_timeline_{}", chrono::Utc::now().timestamp()));
                let out = ctx
                    .root
                    .join("renders")
                    .join(format!("{episode}_timeline_{}.mp4", chrono::Utc::now().timestamp()));
                // 渲染是分钟级阻塞调用：放阻塞线程池；进度经 channel 转发给 ctx.report
                let (ptx, mut prx) = tokio::sync::mpsc::unbounded_channel::<(f64, String)>();
                let work2 = work.clone();
                let out2 = out.clone();
                let handle = tokio::task::spawn_blocking(move || {
                    render_timeline(&locator, &spec, &resolver, &out2, &work2, &move |p, m| {
                        let _ = ptx.send((p, m.to_string()));
                    })
                    .map_err(|e| fatal(e.to_string()))
                });
                while let Some((p, m)) = prx.recv().await {
                    ctx.report(p, &m);
                }
                let rendered = handle.await.map_err(|e| fatal(e.to_string()))??;
                // SRT 侧车始终输出（与线性分支一致）
                let srt_out = out.with_extension("srt");
                let _ = std::fs::copy(&rendered.srt, &srt_out);
                // 成片零拷贝登记（kind=videos）：成片已在 renders/ 有唯一副本，不复制进 assets/；
                // 失败不阻断渲染结果
                if let Err(e) = onetv_project::ops::register_asset(&ctx.root, &out, "videos") {
                    tracing::warn!("成片入库失败（不阻断）: {e}");
                }
                env_agent_message(
                    &env,
                    &ctx.job_id,
                    &format!(
                        "多轨时间线渲染完成（{track_count} 轨）：{}。SRT 字幕侧车已同步输出。可在「任务」查看，或说「导出竖版」。",
                        out.display()
                    ),
                    "timeline.done",
                );
                return Ok(vec![out.to_string_lossy().into_owned()]);
            }

            /* ── 线性拼接（旧逻辑，保持不动） ── */
            use onetv_media::render::{compose, write_srt, ClipSource, RenderSpec};
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
            // compose 是分钟级阻塞调用：放阻塞线程池，避免饿死 tokio worker（v2.12.0）
            let media_for_compose = env.media().clone();
            let out2 = out.clone();
            let work2 = work.clone();
            tokio::task::spawn_blocking(move || compose(&media_for_compose, &spec, &out2, &work2))
                .await
                .map_err(|e| fatal(e.to_string()))?
                .map_err(|e| fatal(e.to_string()))?;
            // SRT 侧车始终输出（无论是否硬字幕）
            let srt_out = out.with_extension("srt");
            let _ = std::fs::copy(&srt_path, &srt_out);
            // 成片零拷贝登记（kind=videos）：成片已在 renders/ 有唯一副本，不复制进 assets/；
            // 失败不阻断渲染结果
            if let Err(e) = onetv_project::ops::register_asset(&ctx.root, &out, "videos") {
                tracing::warn!("成片入库失败（不阻断）: {e}");
            }
            ctx.report(0.95, "入库…");
            env_agent_message(&env, &ctx.job_id, &format!("成片初剪已合成（{:.1}s，含硬字幕）。可在「任务」查看，或说「导出竖版」。", t), "timeline.done");
            Ok(vec![out.to_string_lossy().into_owned()])
        })
    })
}

fn env_agent_message(env: &AgentEnv, job_id: &str, text: &str, kind: &str) {
    // 带 jobId：前端按任务归属把回复归档到发起对话的项目（切项目/切视图不串流）
    env.events("agent.message", json!({ "text": text, "kind": kind, "jobId": job_id }));
}

/* ---------------- export.render ---------------- */

pub fn export_render_handler(env: Arc<AgentEnv>) -> JobHandler {
    Arc::new(move |ctx: JobContext| {
        let env = env.clone();
        Box::pin(async move {
            use onetv_media::render::preset_size;
            let preset = ctx.params.get("preset").and_then(|v| v.as_str()).unwrap_or("douyin_vertical").to_string();
            let (w, h) = preset_size(&preset);
            // 多版本导出（v2.13）：真正消费 burnSubtitle/includeSrt 参数
            let burn_subtitle = ctx.params.get("burnSubtitle").and_then(|v| v.as_bool()).unwrap_or(false);
            let include_srt = ctx.params.get("includeSrt").and_then(|v| v.as_bool()).unwrap_or(false);
            let Some(src) = resolve_export_source(&ctx.root, ctx.params.get("sourcePath").and_then(|v| v.as_str()))
            else {
                return Err(fatal("没有可导出的成片。请先「合成成片」或「渲染成片」"));
            };
            // 字幕源：成片旁的 SRT 侧车（合成成片时始终输出）
            let srt_src = src.with_extension("srt");
            let has_srt = srt_src.exists();
            if burn_subtitle && !has_srt {
                return Err(fatal("未找到字幕文件（成片缺少 SRT 侧车），无法烧录字幕；可用 includeSrt 仅导出字幕文件"));
            }
            ctx.report(0.2, "本地转码导出（不出网）…");
            let locator = env.media().clone();
            let resolved = locator.resolve().map_err(|e| fatal(e.to_string()))?;
            let out = ctx.root.join("renders").join(format!(
                "export_{}_{}.mp4",
                preset,
                chrono::Utc::now().timestamp()
            ));
            // 转码为分钟级阻塞调用：放阻塞线程池（v2.12.0）
            let ffmpeg_bin = resolved.ffmpeg.clone();
            let src2 = src.clone();
            let out2 = out.clone();
            // master 预设 (0,0) = 保持源画幅，不缩放不补边（否则会拼出 scale=0:0 非法滤镜）
            let mut vf = if w == 0 || h == 0 {
                "null".to_string()
            } else {
                format!("scale={w}:{h}:force_original_aspect_ratio=decrease,pad={w}:{h}:(ow-iw)/2:(oh-ih)/2")
            };
            if burn_subtitle {
                // 烧录字幕：subtitles 滤镜（机器无 libass 时 ffmpeg 会失败并给出可读错误）
                let srt_escaped = srt_src
                    .to_string_lossy()
                    .replace('\\', "/")
                    .replace(':', "\\:")
                    .replace('\'', "'\\\''");
                vf.push_str(&format!(",subtitles='{srt_escaped}'"));
            }
            let status = tokio::task::spawn_blocking(move || {
                std::process::Command::new(&ffmpeg_bin)
                    .args(["-y", "-v", "error", "-i"])
                    .arg(&src2)
                    .args(["-vf", &vf])
                    .args(["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-crf", "21", "-c:a", "aac"])
                    .arg(&out2)
                    .status()
            })
            .await
            .map_err(|e| fatal(e.to_string()))?
            .map_err(|e| fatal(e.to_string()))?;
            if !status.success() {
                return Err(fatal("导出转码失败"));
            }
            // includeSrt：SRT 侧车随导出复制
            let mut outputs = vec![out.to_string_lossy().into_owned()];
            if include_srt && has_srt {
                let srt_out = out.with_extension("srt");
                std::fs::copy(&srt_src, &srt_out).map_err(|e| fatal(e.to_string()))?;
                outputs.push(srt_out.to_string_lossy().into_owned());
            }
            ctx.report(0.9, "导出完成");
            // 产物零拷贝登记进 assets 表（kind=videos）：导出成片已落在 renders/（工程内唯一副本），
            // 不再复制进 assets/ 双倍占盘；按 sha256 幂等，重复导出同内容不重录，
            // 「导出/合成成片」的产物可被 latest_asset_of_kind 命中。
            // 登记失败不阻断导出结果（文件已落 renders/）。
            if let Err(e) = onetv_project::ops::register_asset(&ctx.root, &out, "videos") {
                tracing::warn!("导出成片入库失败（不阻断）: {e}");
            }
            ctx.report(0.95, "入库…");
            let sub_note = if burn_subtitle && has_srt { "含硬字幕" } else { "无硬字幕" };
            env_agent_message(&env, &ctx.job_id, &format!("已导出 {w}×{h} 版本（{sub_note}）：{}", out.display()), "export.done");
            Ok(outputs)
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
            // 场景检测为全片扫描（分钟级阻塞）：放阻塞线程池（v2.12.0）
            let ffmpeg_bin = resolved.ffmpeg.clone();
            let video2 = video.clone();
            let output = tokio::task::spawn_blocking(move || {
                std::process::Command::new(&ffmpeg_bin)
                    .args(["-i"])
                    .arg(&video2)
                    .args(["-vf", "select='gt(scene,0.30)',showinfo", "-f", "null", "-"])
                    .stderr(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::null())
                    .output()
            })
            .await
            .map_err(|e| fatal(e.to_string()))?
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
            // VLM 语义分析（v2.14，项20）：自动探测 Vision 能力 Provider（含 fallback 路由），
            // 对前 4 个关键帧逐帧描述并回填镜头字段；未配置 Vision 时保持确定性管线结果。
            let vision_route = {
                let registry = env.registry.read().clone();
                crate::providers::router::ModelRouter::route(
                    &registry,
                    crate::providers::Capability::Vision,
                    None,
                    None,
                    env.offline_mode(),
                    false,
                )
                .ok()
            };
            let mut vlm_provider = String::new();
            let mut vlm_model = String::new();
            if let Some(decision) = &vision_route {
                if decision.provider.driver == crate::providers::ProviderDriverKind::OpenaiCompatible {
                    vlm_provider = decision.provider.id.clone();
                    vlm_model = decision.model_id.clone();
                }
            }
            let vlm_prompt = "你是短剧分镜分析师。分析这张视频关键帧，只输出 JSON（不要解释/围栏）：{\"shotSize\":\"景别(远景/全景/中景/近景/特写)\",\"cameraMovement\":\"推/拉/摇/移/固定\",\"scene\":\"场景描述(20字内)\",\"characters\":[\"出现的角色描述\"],\"action\":\"画面动作(30字内)\",\"color\":\"色调\"}。不确定的字段留空字符串。";
            let mut vlm_ok = 0usize;
            if !vlm_provider.is_empty() {
                let registry = env.registry.read().clone();
                let vprofile = registry.get(&vlm_provider);
                if let Some(profile) = vprofile {
                    let total_vlm = shots.len().min(4);
                    for (i, shot) in shots.iter_mut().enumerate().take(4) {
                        if ctx.is_cancelled() {
                            return Err(fatal("已取消"));
                        }
                        let Some(frame_path) = shot
                            .get("sourceFrame")
                            .and_then(|v| v.as_str())
                            .map(PathBuf::from)
                        else {
                            continue;
                        };
                        let Some(bytes) = std::fs::read(&frame_path).ok() else { continue };
                        if bytes.len() > 8 * 1024 * 1024 {
                            continue;
                        }
                        use base64::Engine as _;
                        let data_url = format!(
                            "data:image/png;base64,{}",
                            base64::engine::general_purpose::STANDARD.encode(&bytes)
                        );
                        ctx.report(
                            0.6 + 0.3 * (i as f64 / total_vlm.max(1) as f64),
                            &format!("VLM 分析关键帧 {}/{}…", i + 1, total_vlm),
                        );
                        let res = crate::providers::openai::vision_describe(
                            env.gateway(),
                            &profile,
                            &vlm_model,
                            &vlm_prompt,
                            &data_url,
                        )
                        .await;
                        match res {
                            Ok(text) => {
                                let trimmed = text.trim();
                                let json_str = match (trimmed.find('{'), trimmed.rfind('}')) {
                                    (Some(a), Some(b)) if b > a => &trimmed[a..=b],
                                    _ => trimmed,
                                };
                                if let Ok(v) = serde_json::from_str::<serde_json::Value>(json_str) {
                                    if let Some(x) = v.get("shotSize").and_then(|x| x.as_str()) {
                                        shot["shotSize"] = json!(x);
                                    }
                                    if let Some(x) = v.get("cameraMovement").and_then(|x| x.as_str()) {
                                        shot["camera"] = json!({ "movement": x, "angle": "" });
                                    }
                                    if let Some(x) = v.get("scene").and_then(|x| x.as_str()) {
                                        shot["scene"] = json!(x);
                                    }
                                    if let Some(x) = v.get("characters").and_then(|x| x.as_array()) {
                                        shot["characters"] = json!(x);
                                    }
                                    if let Some(x) = v.get("action").and_then(|x| x.as_str()) {
                                        shot["action"] = json!(x);
                                    }
                                    if let Some(x) = v.get("color").and_then(|x| x.as_str()) {
                                        shot["color"] = json!(x);
                                    }
                                    vlm_ok += 1;
                                }
                            }
                            _ => {
                                tracing::warn!(shot = i, "VLM 关键帧分析失败（跳过该帧）");
                            }
                        }
                    }
                }
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
                "notes": if vlm_ok > 0 {
                    format!("VLM 语义分析已完成 {vlm_ok} 帧（Provider: {vlm_provider} / {vlm_model}）。台词级识别需 ASR 能力，暂未启用。")
                } else {
                    "VLM 语义分析（台词/人物/表情识别）需要在设置中配置 Vision 能力的 Provider；当前为确定性管线结果。".to_string()
                },
                "updatedAt": chrono::Utc::now().to_rfc3339()
            });
            let episode = ctx.episode_id.clone().unwrap_or_else(|| "ep01".into());
            let out = ctx.root.join("episodes").join(&episode).join("understanding.json");
            std::fs::create_dir_all(out.parent().unwrap()).map_err(|e| fatal(e.to_string()))?;
            std::fs::write(&out, serde_json::to_string_pretty(&doc).map_err(|e| fatal(e.to_string()))?)
                .map_err(|e| fatal(e.to_string()))?;
            env_agent_message(&env, &ctx.job_id, &format!(
                "视频理解完成：检测到 {} 个镜头切分，结构化结果已写入 {}（可在分镜页复刻）",
                shots.len(),
                out.display()
            ), "understand.done");
            Ok(vec![out.to_string_lossy().into_owned()])
        })
    })
}

#[cfg(test)]
mod memory_tests {
    use super::parse_memory_items;

    #[test]
    fn parse_memory_items_variants() {
        assert_eq!(parse_memory_items("[]"), Vec::<String>::new());
        assert_eq!(
            parse_memory_items("[\"主角叫林晚，27岁刑警\"]"),
            vec!["主角叫林晚，27岁刑警".to_string()]
        );
        // 围栏包裹
        assert_eq!(
            parse_memory_items("```json\n[\"用户偏好竖屏 9:16\"]\n```"),
            vec!["用户偏好竖屏 9:16".to_string()]
        );
        // 夹带说明文字
        assert_eq!(
            parse_memory_items("提取结果如下：[\"用户在做都市情感短剧\"] 以上。"),
            vec!["用户在做都市情感短剧".to_string()]
        );
        // 非法 JSON / 无数组 → 空
        assert!(parse_memory_items("没有值得记住的").is_empty());
        // 过短/过长过滤
        assert!(parse_memory_items("[\"好的\"]").is_empty());
        let long = "很".repeat(81);
        assert!(parse_memory_items(format!("[\"{}\"]", long).as_str()).is_empty());
    }
}
