//! Agent 引擎（规格 §5）：不是聊天机器人，而是“可审计制作总监”。
//!
//! L0 System Policy（在 Gateway/Policy 层）→ L1 Intent Router → L2 Planner（结构化 Plan，
//! 不发请求）→ L3 Executor（经 Provider Gateway）→ L4 Reviewer → L5 User Approval。

pub mod executor;
pub mod handlers;
pub mod tools;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use onetv_media::MediaLocator;
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

use crate::jobs::EventSink;
use crate::providers::gateway::Gateway;
use crate::providers::ProviderRegistry;

/// Agent 运行环境（Executor/Handler 共享；不包含任何密钥）。
pub struct AgentEnv {
    pub gateway: Arc<Gateway>,
    pub registry: Arc<RwLock<ProviderRegistry>>,
    pub media: MediaLocator,
    offline: Arc<AtomicBool>,
    events_sink: EventSink,
    /// 各能力默认生成模型（设置 → 模型 → 生成模型设置）：
    /// key = chat | image | video | tts；handlers 未显式指定模型时回退到这里。
    defaults: RwLock<std::collections::HashMap<String, (String, String)>>,
}

impl AgentEnv {
    pub fn new(
        gateway: Arc<Gateway>,
        registry: Arc<RwLock<ProviderRegistry>>,
        media: MediaLocator,
        events_sink: EventSink,
    ) -> Arc<Self> {
        Arc::new(Self {
            gateway,
            registry,
            media,
            offline: Arc::new(AtomicBool::new(false)),
            events_sink,
            defaults: RwLock::new(std::collections::HashMap::new()),
        })
    }

    pub fn gateway(&self) -> &Gateway {
        &self.gateway
    }
    pub fn media(&self) -> &MediaLocator {
        &self.media
    }
    pub fn offline_mode(&self) -> bool {
        self.offline.load(Ordering::Relaxed)
    }
    pub fn set_offline(&self, v: bool) {
        self.offline.store(v, Ordering::Relaxed);
    }
    pub fn events(&self, name: &str, payload: serde_json::Value) {
        (self.events_sink)(name, payload);
    }

    /// 同步「生成模型设置」（settings.modelDefaults → env）。
    pub fn set_model_defaults(&self, map: std::collections::HashMap<String, (String, String)>) {
        *self.defaults.write() = map;
    }

    /// 某能力的默认 (providerId, modelId)。
    pub fn model_default(&self, cap: &str) -> Option<(String, String)> {
        self.defaults.read().get(cap).cloned()
    }
}

/* ---------------- Intent（规格 §5.2） ---------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    Chat,
    ScriptGenerate,
    StoryboardGenerate,
    ImageGenerate,
    VideoGenerate,
    TimelineCompose,
    Export,
    VideoUnderstand,
}

impl Intent {
    pub fn as_str(&self) -> &'static str {
        match self {
            Intent::Chat => "chat",
            Intent::ScriptGenerate => "script.generate",
            Intent::StoryboardGenerate => "storyboard.generate",
            Intent::ImageGenerate => "image.generate",
            Intent::VideoGenerate => "video.generate",
            Intent::TimelineCompose => "timeline.compose",
            Intent::Export => "export",
            Intent::VideoUnderstand => "video.understand",
        }
    }
}

/// L1 Intent Router：规则优先（可审计、离线可用）；未来可叠加 LLM 分类。
pub fn route_intent(text: &str) -> Intent {
    let t = text.trim();
    let lower = t.to_lowercase();
    let has = |k: &[&str]| k.iter().any(|k| lower.contains(k));

    if has(&["合成成片", "合成", "时间线", "拼接", "做成片"]) && !t.contains("分镜图") {
        return Intent::TimelineCompose;
    }
    if has(&["分镜", "镜头表", "storyboard", "拆成镜头", "拆分镜头"]) {
        return Intent::StoryboardGenerate;
    }
    if has(&["写剧本", "生成剧本", "写第", "第一集", "写一集", "script"]) && !t.contains("分镜") {
        return Intent::ScriptGenerate;
    }
    if has(&["导出", "export", "竖版", "横版"]) {
        return Intent::Export;
    }
    if has(&["视频理解", "复刻", "分析这个视频", "understand"]) {
        return Intent::VideoUnderstand;
    }
    if has(&["生成图片", "生图", "定妆照", "画一张"]) {
        return Intent::ImageGenerate;
    }
    if has(&["生成视频镜头", "图生视频", "文生视频", "video.generate"]) {
        return Intent::VideoGenerate;
    }
    Intent::Chat
}

/* ---------------- Plan（规格 §5.3） ---------------- */

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanStep {
    pub id: String,
    pub tool: String,
    #[serde(default)]
    pub input: serde_json::Value,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub approval: String, // auto | required
    #[serde(default)]
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub plan_id: String,
    pub intent: String,
    pub summary: String,
    pub estimated: Estimated,
    pub steps: Vec<PlanStep>,
    pub created_at: String,
    #[serde(default)]
    pub status: String, // draft | approved | executing | done | rejected
    /// L4 Reviewer（v2.13）：执行前启发式复核备注（风险/参数完整性/一致性）
    #[serde(default)]
    pub review_notes: Vec<String>,
}

/// L4 Reviewer（轻量版）：不发请求，纯规则复核——给出执行前提示。
pub fn review_plan(plan: &mut Plan, offline_mode: bool) {
    let mut notes = Vec::new();
    if plan.estimated.remote_calls > 0 && offline_mode {
        notes.push("⚠️ 当前为 Local-only 离线模式，远程调用将被策略引擎拒绝".into());
    }
    for step in &plan.steps {
        if matches!(step.tool.as_str(), "image.generate" | "video.generate")
            && step.input.get("prompt").and_then(|p| p.as_str()).unwrap_or_default().trim().is_empty()
        {
            notes.push(format!("⚠️ 步骤 {}（{}）缺少提示词，执行可能失败", step.id, step.tool));
        }
    }
    if plan.estimated.remote_calls >= 10 {
        notes.push(format!(
            "💡 本计划包含 {} 次远程调用，注意成本（可在设置开启预算守卫）",
            plan.estimated.remote_calls
        ));
    }
    if notes.is_empty() {
        notes.push("✅ 复核通过：参数完整，成本与模式无冲突".into());
    }
    plan.review_notes = notes;
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Estimated {
    pub jobs: u32,
    pub remote_calls: u32,
    pub risk: String, // low | medium | high
}

const REMOTE_TOOLS: &[&str] = &[
    "script.generate",
    "image.generate",
    "storyboard.image_batch",
    "video.generate",
    "audio.tts",
    // bible.generate 无 handler（功能由 bible_generate 命令独立实现，v2.12 清理）
];

pub fn is_remote_tool(tool: &str) -> bool {
    REMOTE_TOOLS.contains(&tool)
}

/// L2 Planner：为意图生成结构化、可审计的执行计划（不发任何请求）。
pub fn build_plan(intent: Intent, text: &str, episode_id: Option<&str>) -> Plan {
    let plan_id = format!("plan_{}", uuid::Uuid::new_v4().simple());
    let ep = episode_id.unwrap_or("").to_string();
    let (summary, steps, risk) = match intent {
        Intent::Chat => (
            "对话回复（将调用已配置的 LLM Provider；Mock/本地模型不出公网）".to_string(),
            vec![PlanStep {
                id: "s1".into(),
                tool: "chat.reply".into(),
                input: serde_json::json!({ "text": text }),
                depends_on: vec![],
                approval: "auto".into(),
                description: "LLM 对话".into(),
            }],
            "low",
        ),
        Intent::ScriptGenerate => (
            format!("生成剧本：{text}（LLM 生成结构化 ScriptDocument）"),
            vec![
                PlanStep {
                    id: "s1".into(),
                    tool: "script.generate".into(),
                    input: serde_json::json!({ "brief": text, "episode": ep }),
                    depends_on: vec![],
                    approval: "auto".into(),
                    description: "调用 LLM 生成结构化剧本 JSON".into(),
                },
            ],
            "medium",
        ),
        Intent::StoryboardGenerate => (
            "把当前剧本拆成镜头表（本地计算，可再批量生成分镜图）".to_string(),
            vec![
                PlanStep {
                    id: "s1".into(),
                    tool: "shot.split".into(),
                    input: serde_json::json!({ "episode": ep }),
                    depends_on: vec![],
                    approval: "auto".into(),
                    description: "本地解析剧本 → Shot List".into(),
                },
                PlanStep {
                    id: "s2".into(),
                    tool: "character.bind".into(),
                    input: serde_json::json!({}),
                    depends_on: vec!["s1".to_string()],
                    approval: "auto".into(),
                    description: "镜头绑定角色/场景参考（一致性）".into(),
                },
                PlanStep {
                    id: "s3".into(),
                    tool: "storyboard.image_batch".into(),
                    input: serde_json::json!({ "episode": ep }),
                    depends_on: vec!["s2".to_string()],
                    approval: "required".into(),
                    description: "批量生成分镜图（逐镜 1 张，涉及远程/本地生图调用）".into(),
                },
            ],
            "medium",
        ),
        Intent::ImageGenerate => (
            format!("生成图片：{text}"),
            vec![PlanStep {
                id: "s1".into(),
                tool: "image.generate".into(),
                input: serde_json::json!({ "prompt": text }),
                depends_on: vec![],
                approval: "auto".into(),
                description: "调用图像 Provider 生图".into(),
            }],
            "medium",
        ),
        Intent::VideoGenerate => (
            format!("生成视频镜头：{text}"),
            vec![PlanStep {
                id: "s1".into(),
                tool: "video.generate".into(),
                input: serde_json::json!({ "prompt": text, "episode": ep }),
                depends_on: vec![],
                approval: "required".into(),
                description: "调用视频 Provider 生视频（高成本，需要确认）".into(),
            }],
            "high",
        ),
        Intent::TimelineCompose => (
            "按分镜顺序本地合成时间线（FFmpeg，不出网）".to_string(),
            vec![
                PlanStep {
                    id: "s1".into(),
                    tool: "timeline.build".into(),
                    input: serde_json::json!({ "episode": ep }),
                    depends_on: vec![],
                    approval: "auto".into(),
                    description: "从分镜/输出资产构建 timeline.json".into(),
                },
                PlanStep {
                    id: "s2".into(),
                    tool: "timeline.render".into(),
                    input: serde_json::json!({ "episode": ep }),
                    depends_on: vec!["s1".to_string()],
                    approval: "auto".into(),
                    description: "FFmpeg 本地合成 MP4（含字幕）".into(),
                },
            ],
            "low",
        ),
        Intent::Export => (
            "导出成片（本地 FFmpeg 转码多版本）".to_string(),
            vec![PlanStep {
                id: "s1".into(),
                tool: "export.render".into(),
                input: serde_json::json!({ "episode": ep, "preset": "douyin_vertical" }),
                depends_on: vec![],
                approval: "auto".into(),
                description: "按预设导出 1080x1920 MP4 + SRT".into(),
            }],
            "low",
        ),
        Intent::VideoUnderstand => (
            "视频理解：本地抽帧/场景切分 → 结构化镜头 JSON（VLM 可选）".to_string(),
            vec![PlanStep {
                id: "s1".into(),
                tool: "video.understand".into(),
                input: serde_json::json!({ "text": text }),
                depends_on: vec![],
                approval: "auto".into(),
                description: "分析本地视频生成复刻计划".into(),
            }],
            "low",
        ),
    };
    let remote_calls = steps.iter().filter(|s| is_remote_tool(&s.tool)).count() as u32;
    Plan {
        plan_id,
        intent: intent.as_str().into(),
        summary,
        estimated: Estimated { jobs: steps.len() as u32, remote_calls, risk: risk.into() },
        steps,
        created_at: chrono::Utc::now().to_rfc3339(),
        review_notes: Vec::new(),
        status: "draft".into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_intents() {
        assert_eq!(route_intent("把第一集拆成分镜"), Intent::StoryboardGenerate);
        assert_eq!(route_intent("根据这个梗概写第一集剧本"), Intent::ScriptGenerate);
        assert_eq!(route_intent("按分镜顺序合成成片"), Intent::TimelineCompose);
        assert_eq!(route_intent("你好呀"), Intent::Chat);
    }

    #[test]
    fn storyboard_plan_requires_approval_for_batch() {
        let p = build_plan(Intent::StoryboardGenerate, "x", Some("ep01"));
        assert!(p.steps.iter().any(|s| s.approval == "required"));
        assert_eq!(p.estimated.remote_calls, 1);
    }
}
