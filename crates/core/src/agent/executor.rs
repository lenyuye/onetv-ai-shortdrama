//! Plan Executor：把 Planner 的结构化计划转为一组 Job（或本地立即执行的工具调用）。

use std::sync::Arc;

use serde_json::json;

use crate::agent::handlers;
use crate::agent::{Plan, PlanStep};
use crate::jobs::{JobKind, JobManager};

use super::AgentEnv;

pub struct Executor {
    pub env: Arc<AgentEnv>,
    pub jobs: Arc<JobManager>,
}

/// 生成任务标题：文本自带同类前缀（如用户输入"生成剧本：…"）时不再叠加，
/// 避免"生成剧本：生成剧本：…"式重复。
fn titled(prefix: &str, text: &str) -> String {
    let t = text.trim();
    if t.starts_with(prefix) {
        t.to_string()
    } else {
        format!("{prefix}{t}")
    }
}

impl Executor {
    /// 执行已批准的 Plan：本地工具立即执行，远程/长任务入 Job 队列。
    /// 返回创建的 job id 列表（含本地步骤跳过说明）。
    pub async fn execute(
        &self,
        plan: &Plan,
        root: &std::path::Path,
        episode_id: Option<String>,
    ) -> Result<Vec<String>, String> {
        let mut created = Vec::new();
        // 简单拓扑：按 depends_on 分层；依赖不在本计划步骤集合内的视为已满足
        // （支持只执行计划的一部分，如单独重跑某一步）
        let step_ids: Vec<String> = plan.steps.iter().map(|s| s.id.clone()).collect();
        let mut done: Vec<String> = Vec::new();
        let mut steps = plan.steps.clone();
        while !steps.is_empty() {
            let Some(idx) = steps.iter().position(|s| {
                s.depends_on.iter().all(|d| !step_ids.contains(d) || done.contains(d))
            }) else {
                return Err("计划存在循环依赖".into());
            };
            let step = steps.remove(idx);
            let job_ids = self.run_step(&step, root, episode_id.clone()).await?;
            created.extend(job_ids);
            done.push(step.id);
        }
        Ok(created)
    }

    async fn run_step(
        &self,
        step: &PlanStep,
        root: &std::path::Path,
        episode_id: Option<String>,
    ) -> Result<Vec<String>, String> {
        let jobs = &self.jobs;
        let ep = episode_id.clone().or_else(|| step.input.get("episode").and_then(|v| v.as_str()).map(|s| s.to_string()));
        match step.tool.as_str() {
            // ---- 本地立即执行（不进队列） ----
            "shot.split" | "character.bind" | "storyboard.build" => {
                // 绑定与拆分合并成一个 storyboard build job（本地、秒级）
                let job = jobs.create_job(
                    JobKind::Script,
                    "拆分镜头表",
                    None,
                    None,
                    json!({ "episode": ep.clone().unwrap_or_default(), "op": "storyboard.build" }),
                    None,
                    episode_id.clone(),
                    false,
                    None,
                );
                Ok(vec![job.id])
            }
            "timeline.build" | "timeline.render" => {
                let job = jobs.create_job(
                    JobKind::TimelineRender,
                    "本地合成时间线（FFmpeg）",
                    None,
                    None,
                    json!({ "episode": ep.clone().unwrap_or_default() }),
                    None,
                    episode_id.clone(),
                    false,
                    None,
                );
                Ok(vec![job.id])
            }
            "export.render" => {
                let job = jobs.create_job(
                    JobKind::Export,
                    "导出成片",
                    None,
                    None,
                    json!({
                        "episode": ep.clone().unwrap_or_default(),
                        "preset": step.input.get("preset").cloned().unwrap_or(json!("douyin_vertical")),
                        "burnSubtitle": true,
                        "includeSrt": true
                    }),
                    None,
                    episode_id,
                    false,
                    None,
                );
                Ok(vec![job.id])
            }
            "video.understand" => {
                let job = jobs.create_job(
                    JobKind::VideoUnderstand,
                    "视频理解与复刻",
                    None,
                    None,
                    step.input.clone(),
                    None,
                    episode_id,
                    false,
                    None,
                );
                Ok(vec![job.id])
            }

            // ---- Job 队列（远程/耗时） ----
            "chat.reply" => {
                let job = jobs.create_job(
                    JobKind::Chat,
                    "Agent 对话",
                    None,
                    None,
                    json!({
                        "text": step.input.get("text").cloned().unwrap_or(json!("")),
                        "providerId": step.input.get("providerId").cloned().unwrap_or(serde_json::Value::Null),
                        "model": step.input.get("model").cloned().unwrap_or(serde_json::Value::Null)
                    }),
                    None,
                    None,
                    false,
                    None,
                );
                Ok(vec![job.id])
            }
            "script.generate" => {
                let egress = Some(json!({
                    "destination": "LLM Provider（由 Model Router 选择）",
                    "data": "需求文本 + 系统提示词",
                    "sensitive": "剧本需求将发送给所配置的 LLM 服务商"
                }));
                let job = jobs.create_job(
                    JobKind::Script,
                    titled("生成剧本：", step.input.get("brief").and_then(|v| v.as_str()).unwrap_or("")),
                    None,
                    None,
                    step.input.clone(),
                    None,
                    episode_id,
                    false,
                    egress,
                );
                Ok(vec![job.id])
            }
            "image.generate" => {
                let egress = Some(json!({
                    "destination": "Image Provider（由 Model Router 选择）",
                    "data": "生图 prompt",
                    "sensitive": "prompt 将发送给图像服务商"
                }));
                let job = jobs.create_job(
                    JobKind::ImageGeneration,
                    titled("生成图片：", step.input.get("prompt").and_then(|v| v.as_str()).unwrap_or("")),
                    None,
                    None,
                    step.input.clone(),
                    None,
                    episode_id,
                    false,
                    egress,
                );
                Ok(vec![job.id])
            }
            "storyboard.image_batch" => {
                let egress = Some(json!({
                    "destination": "Image Provider（逐镜 1 次调用）",
                    "data": "每镜 prompt（场景/景别/动作）",
                    "sensitive": "分镜描述将发送给图像服务商"
                }));
                let job = jobs.create_job(
                    JobKind::ImageGeneration,
                    "批量生成分镜图",
                    None,
                    None,
                    json!({ "episode": ep.unwrap_or_default(), "op": "storyboard.image_batch" }),
                    None,
                    episode_id,
                    false,
                    egress,
                );
                Ok(vec![job.id])
            }
            "video.generate" => {
                let egress = Some(json!({
                    "destination": "Video Provider",
                    "data": "镜头 prompt + 参考资产",
                    "sensitive": "prompt/参考图将发送给视频服务商"
                }));
                let job = jobs.create_job(
                    JobKind::VideoGeneration,
                    format!("生成视频：{}", step.input.get("prompt").and_then(|v| v.as_str()).unwrap_or("").to_string()),
                    step.input.get("providerId").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    step.input.get("model").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    step.input.clone(),
                    None,
                    episode_id,
                    false,
                    egress,
                );
                Ok(vec![job.id])
            }
            "audio.tts" => {
                let job = jobs.create_job(
                    JobKind::Tts,
                    "配音（TTS）",
                    None,
                    None,
                    step.input.clone(),
                    None,
                    episode_id,
                    false,
                    Some(json!({"destination": "TTS Provider", "data": "台词文本", "sensitive": "台词将发送给 TTS 服务商"})),
                );
                Ok(vec![job.id])
            }
            other => Err(format!("未知工具: {other}")),
        }
    }
}

/// 为 JobManager 注册全部 Agent 处理器。
pub fn register_all_handlers(env: Arc<AgentEnv>, jobs: &Arc<JobManager>) {
    use crate::jobs::JobKind;

    let env_chat = env.clone();
    jobs.register_handler(
        JobKind::Chat,
        Arc::new(move |ctx| handlers::chat_reply_handler(env_chat.clone())(ctx)),
    );
    let env_script = env.clone();
    jobs.register_handler(
        JobKind::Script,
        Arc::new(move |ctx| {
            // storyboard.build 也是 Script kind（本地操作）
            if ctx.params.get("op").and_then(|v| v.as_str()) == Some("storyboard.build") {
                handlers::storyboard_build_handler(env_script.clone())(ctx)
            } else {
                handlers::script_generate_handler(env_script.clone())(ctx)
            }
        }),
    );
    let env_image = env.clone();
    jobs.register_handler(
        JobKind::ImageGeneration,
        Arc::new(move |ctx| {
            if ctx.params.get("op").and_then(|v| v.as_str()) == Some("storyboard.image_batch") {
                handlers::storyboard_image_batch_handler(env_image.clone())(ctx)
            } else {
                handlers::image_generate_handler(env_image.clone())(ctx)
            }
        }),
    );
    let env_video = env.clone();
    jobs.register_handler(
        JobKind::VideoGeneration,
        Arc::new(move |ctx| handlers::video_generate_handler(env_video.clone())(ctx)),
    );
    let env_tts = env.clone();
    jobs.register_handler(
        JobKind::Tts,
        Arc::new(move |ctx| handlers::tts_handler(env_tts.clone())(ctx)),
    );
    let env_tl = env.clone();
    jobs.register_handler(
        JobKind::TimelineRender,
        Arc::new(move |ctx| handlers::timeline_render_handler(env_tl.clone())(ctx)),
    );
    let env_ex = env.clone();
    jobs.register_handler(
        JobKind::Export,
        Arc::new(move |ctx| handlers::export_render_handler(env_ex.clone())(ctx)),
    );
    let env_vu = env.clone();
    jobs.register_handler(
        JobKind::VideoUnderstand,
        Arc::new(move |ctx| handlers::video_understand_handler(env_vu.clone())(ctx)),
    );
}
