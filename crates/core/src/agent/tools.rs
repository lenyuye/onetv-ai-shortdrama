//! Agent 工具注册表与提示词（规格 §5.4 / §18）。
//! 工具只能通过 Job/Executor 执行；权限在注册表中声明并强制。

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct ToolDef {
    pub name: &'static str,
    pub label: &'static str,
    pub permission: &'static str,
    pub remote: bool,
}

pub const TOOL_REGISTRY: &[ToolDef] = &[
    ToolDef { name: "fs.read_project", label: "读取项目文件", permission: "project", remote: false },
    ToolDef { name: "fs.write_project", label: "写入项目文件", permission: "project", remote: false },
    ToolDef { name: "asset.search", label: "检索素材", permission: "local", remote: false },
    ToolDef { name: "script.parse", label: "解析剧本", permission: "local", remote: false },
    ToolDef { name: "script.generate", label: "生成剧本", permission: "llm_provider", remote: true },
    ToolDef { name: "storyboard.build", label: "生成镜头表", permission: "local", remote: false },
    ToolDef { name: "character.bind", label: "绑定角色参考", permission: "local", remote: false },
    ToolDef { name: "image.generate", label: "生图", permission: "image_provider", remote: true },
    ToolDef { name: "storyboard.image_batch", label: "批量分镜图", permission: "image_provider", remote: true },
    ToolDef { name: "video.generate", label: "生视频", permission: "video_provider", remote: true },
    ToolDef { name: "audio.tts", label: "配音", permission: "tts_provider", remote: true },
    ToolDef { name: "timeline.build", label: "构建时间线", permission: "local", remote: false },
    ToolDef { name: "timeline.render", label: "FFmpeg 合成", permission: "local", remote: false },
    ToolDef { name: "export.render", label: "导出成片", permission: "local", remote: false },
    ToolDef { name: "video.understand", label: "视频理解", permission: "local+optional_vlm", remote: false },
    ToolDef { name: "provider.health", label: "探测模型可用性", permission: "provider_endpoint", remote: true },
];

pub fn tool_def(name: &str) -> Option<&'static ToolDef> {
    TOOL_REGISTRY.iter().find(|t| t.name == name)
}

/* ---------------- 提示词模板（skills/short-drama 对应） ---------------- */

pub const SCRIPT_SYSTEM_PROMPT: &str = r#"你是顶级短剧编剧与制作总监。根据用户需求输出一集短剧的剧本。
必须只输出一个 JSON 对象（不要 markdown 代码块、不要解释），schema 如下：
{
  "schemaVersion": "1.0",
  "episodeId": "",
  "title": "本集标题",
  "logline": "一句话梗概",
  "scenes": [
    {
      "id": "sc01",
      "heading": "内景/外景 - 地点 - 时间",
      "synopsis": "场景概要（将用于生成画面）",
      "dialogues": [
        {"characterName": "角色名", "line": "台词", "parenthetical": "语气提示(可选)"}
      ]
    }
  ],
  "updatedAt": ""
}
要求：
- 6~12 个场景；每场景 1~4 句台词；节奏快、钩子强、适合竖屏短剧；
- 中文；角色名固定；
- 只输出 JSON。"#;

pub const STORYBOARD_PROMPT: &str =
    "你是分镜师。把场景拆成可拍摄的镜头：景别（远景/全景/中景/近景/特写）、运镜（推拉摇移跟）、动作、台词、时长。";

/// 让 LLM 输出干净 JSON（部分模型会包 ```json 围栏）。
pub fn extract_json(text: &str) -> Option<serde_json::Value> {
    let t = text.trim();
    let t = t.strip_prefix("```json").or_else(|| t.strip_prefix("```")).unwrap_or(t);
    let t = t.strip_suffix("```").unwrap_or(t).trim();
    serde_json::from_str(t).ok().or_else(|| {
        // 退化：找第一个 { 到最后一个 }
        let s = t.find('{')?;
        let e = t.rfind('}')?;
        serde_json::from_str(&t[s..=e]).ok()
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ScriptDoc {
    #[serde(default = "default_sv")]
    pub schema_version: String,
    #[serde(rename = "episodeId", default)]
    pub episode_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub logline: String,
    #[serde(default)]
    pub scenes: Vec<Scene>,
    #[serde(rename = "updatedAt", default)]
    pub updated_at: String,
}

fn default_sv() -> String {
    "1.0".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Scene {
    pub id: String,
    pub heading: String,
    #[serde(default)]
    pub synopsis: String,
    #[serde(default)]
    pub dialogues: Vec<Dialogue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Dialogue {
    #[serde(rename = "characterName", default)]
    pub character_name: String,
    #[serde(rename = "characterId", default)]
    pub character_id: Option<String>,
    #[serde(default)]
    pub line: String,
    #[serde(default)]
    pub parenthetical: Option<String>,
}

impl ScriptDoc {
    pub fn parse(raw: &str) -> Result<Self, String> {
        let v = extract_json(raw).ok_or("LLM 输出不是合法 JSON")?;
        let mut doc: ScriptDoc =
            serde_json::from_value(v).map_err(|e| format!("剧本 schema 不匹配: {e}"))?;
        if doc.scenes.is_empty() {
            return Err("剧本没有场景".into());
        }
        for (i, sc) in doc.scenes.iter_mut().enumerate() {
            if sc.id.is_empty() {
                sc.id = format!("sc{:02}", i + 1);
            }
        }
        Ok(doc)
    }
}
