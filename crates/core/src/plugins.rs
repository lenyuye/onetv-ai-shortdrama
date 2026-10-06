//! Plugin SDK 最小完整版（规格 §22，v2.15 框架版 → 最小实现）：
//! 插件 = 提示词包（prompt-pack）。plugin.json 声明若干 prompt 模板，
//! 调用即做纯文本模板渲染 —— 不加载/执行任何插件代码、不做任何网络请求
//! （安全边界与 Skill 一致）；插件目录锁定在 plugins/ 内，防 ../ 逃逸。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// kind 白名单：当前只支持提示词包
pub const PLUGIN_KIND_PROMPT_PACK: &str = "prompt-pack";

/// 单个提示词模板（plugin.json prompts[] 元素）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPrompt {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// 模板正文：支持 {{input}} 与 {{project.name}} / {{episode.title}} 上下文变量
    pub template: String,
}

/// 插件清单（plugin.json）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub author: String,
    pub kind: String,
    #[serde(default)]
    pub prompts: Vec<PluginPrompt>,
}

/// plugin_list 出参行：合法插件带完整摘要；坏清单 valid=false 并带 error（跳过不崩）。
/// 兼容 v2.15 框架版字段（id/name/version/description/dir 全部保留）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginListItem {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub dir: String,
    pub kind: String,
    pub prompts_count: usize,
    pub valid: bool,
    /// 清单解析/校验失败原因；合法插件为空串
    #[serde(default)]
    pub error: String,
}

/// 模板渲染上下文：取得到就填，取不到留空（None → 空串）
#[derive(Debug, Clone, Default)]
pub struct RenderContext {
    pub project_name: Option<String>,
    pub episode_title: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum PluginError {
    #[error("{0}")]
    Invalid(String),
    #[error("插件不存在：{0}")]
    NotFound(String),
    #[error("IO: {0}")]
    Io(#[from] std::io::Error),
}

/// id 字符白名单（与 Skill 一致）：小写字母/数字/-/_。
/// 该白名单天然阻断 `..`、`/`、`\` 等路径逃逸字符。
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// semver 校验：必须是 x.y.z 三段非负整数（比 Skill 更严格——各段必须为数字）
pub fn validate_semver(v: &str) -> Result<(), PluginError> {
    let ok = v.split('.').count() == 3
        && v.split('.').all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_digit()) && p.parse::<u64>().is_ok());
    if ok {
        Ok(())
    } else {
        Err(PluginError::Invalid("version 必须是 semver（x.y.z，三段数字）".into()))
    }
}

impl PluginManifest {
    /// 校验清单契约：id/semver/kind 白名单 + prompts 非空且 id 唯一。
    pub fn validate(&self) -> Result<(), PluginError> {
        if !valid_id(&self.id) {
            return Err(PluginError::Invalid("id 只允许小写字母/数字/-/_".into()));
        }
        validate_semver(&self.version)?;
        if self.kind != PLUGIN_KIND_PROMPT_PACK {
            return Err(PluginError::Invalid(format!(
                "kind 只允许 {PLUGIN_KIND_PROMPT_PACK}（发现 {}）",
                self.kind
            )));
        }
        if self.prompts.is_empty() {
            return Err(PluginError::Invalid("prompts 不能为空（提示词包至少声明一个 prompt）".into()));
        }
        let mut seen = std::collections::HashSet::new();
        for p in &self.prompts {
            if !valid_id(&p.id) {
                return Err(PluginError::Invalid(format!("prompt.id 非法（只允许小写字母/数字/-/_）：{}", p.id)));
            }
            if p.name.trim().is_empty() {
                return Err(PluginError::Invalid(format!("prompt {} 的 name 不能为空", p.id)));
            }
            if p.template.trim().is_empty() {
                return Err(PluginError::Invalid(format!("prompt {} 的 template 不能为空", p.id)));
            }
            if !seen.insert(p.id.clone()) {
                return Err(PluginError::Invalid(format!("prompt.id 重复：{}", p.id)));
            }
        }
        Ok(())
    }
}

/// 模板渲染（纯函数）：
/// - `{{input}}` → 入参文本（缺省空串）；
/// - `{{project.name}}` / `{{episode.title}}` → 上下文值（缺失留空）；
/// - 未知变量 → 留空；未闭合的 `{{` 原样保留。
pub fn render_template(template: &str, input: Option<&str>, ctx: &RenderContext) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find("{{") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find("}}") {
            Some(end) => {
                let key = after[..end].trim();
                let val = match key {
                    "input" => input.unwrap_or(""),
                    "project.name" => ctx.project_name.as_deref().unwrap_or(""),
                    "episode.title" => ctx.episode_title.as_deref().unwrap_or(""),
                    _ => "", // 未知变量留空
                };
                out.push_str(val);
                rest = &after[end + 2..];
            }
            None => {
                // 没有配对的 }}：原样输出剩余文本，结束扫描
                out.push_str("{{");
                out.push_str(after);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// 插件目录扫描器（与 SkillHub 同风格：构造时确保目录存在）
pub struct PluginHub {
    dir: PathBuf,
}

impl PluginHub {
    pub fn new(dir: &Path) -> Self {
        let _ = std::fs::create_dir_all(dir);
        Self { dir: dir.to_path_buf() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// 解析插件子目录：id 白名单 + canonicalize 后必须仍在插件根目录内（双保险防逃逸）。
    fn resolve(&self, id: &str) -> Result<PathBuf, PluginError> {
        if !valid_id(id) {
            return Err(PluginError::Invalid("非法插件 id（只允许小写字母/数字/-/_）".into()));
        }
        let p = self.dir.join(id);
        let canon_root = self.dir.canonicalize()?;
        let canon = p.canonicalize().map_err(|_| PluginError::NotFound(id.to_string()))?;
        if !canon.starts_with(&canon_root) {
            return Err(PluginError::Invalid("插件路径越界（逃逸 plugins/ 目录）".into()));
        }
        Ok(canon)
    }

    fn load_manifest(path: &Path) -> Result<PluginManifest, PluginError> {
        let raw = std::fs::read_to_string(path)?;
        serde_json::from_str(&raw).map_err(|e| PluginError::Invalid(format!("plugin.json 解析失败: {e}")))
    }

    /// 列举全部插件：坏清单生成 valid=false 行（带 error），绝不 panic/中断整表。
    pub fn list(&self) -> Vec<PluginListItem> {
        let mut out = Vec::new();
        let Ok(entries) = std::fs::read_dir(&self.dir) else {
            return out;
        };
        for e in entries.flatten() {
            let path = e.path();
            let mf = path.join("plugin.json");
            if !mf.is_file() {
                continue; // 不是插件文件夹，静默跳过
            }
            let dir_str = path.to_string_lossy().to_string();
            let row = match Self::load_manifest(&mf).and_then(|m| match m.validate() {
                Ok(()) => Ok(m),
                Err(e) => Err(e),
            }) {
                Ok(m) => PluginListItem {
                    id: m.id.clone(),
                    name: m.name,
                    version: m.version,
                    description: m.description,
                    dir: dir_str,
                    kind: m.kind,
                    prompts_count: m.prompts.len(),
                    valid: true,
                    error: String::new(),
                },
                Err(e) => PluginListItem {
                    id: String::new(),
                    name: String::new(),
                    version: String::new(),
                    description: String::new(),
                    dir: dir_str,
                    kind: String::new(),
                    prompts_count: 0,
                    valid: false,
                    error: e.to_string(),
                },
            };
            out.push(row);
        }
        out.sort_by(|a, b| a.id.cmp(&b.id).then(a.dir.cmp(&b.dir)));
        out
    }

    /// 读取单个插件完整清单（含 prompts）；清单非法即报错。
    pub fn get(&self, id: &str) -> Result<PluginManifest, PluginError> {
        let dir = self.resolve(id)?;
        let m = Self::load_manifest(&dir.join("plugin.json"))?;
        m.validate()?;
        Ok(m)
    }

    /// 渲染插件的指定提示词模板（纯文本拼接，无任何代码执行/网络）。
    pub fn render_prompt(
        &self,
        id: &str,
        prompt_id: &str,
        input: Option<&str>,
        ctx: &RenderContext,
    ) -> Result<String, PluginError> {
        let m = self.get(id)?;
        let p = m
            .prompts
            .iter()
            .find(|p| p.id == prompt_id)
            .ok_or_else(|| PluginError::NotFound(format!("提示词 {prompt_id}（插件 {id}）")))?;
        Ok(render_template(&p.template, input, ctx))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good_manifest() -> PluginManifest {
        serde_json::from_value(serde_json::json!({
            "id": "demo-pack", "name": "示例插件", "version": "1.2.3",
            "description": "d", "author": "a", "kind": "prompt-pack",
            "prompts": [
                { "id": "greet", "name": "问好", "template": "你好 {{project.name}}，本集：{{episode.title}}，输入：{{input}}" }
            ]
        }))
        .unwrap()
    }

    #[test]
    fn validate_accepts_good_manifest_and_semver() {
        let m = good_manifest();
        m.validate().unwrap();
        validate_semver("0.0.1").unwrap();
        validate_semver("10.20.30").unwrap();
    }

    #[test]
    fn validate_rejects_bad_semver() {
        for v in ["1.0", "1", "a.b.c", "1.0.x", "1.0.", ".1.0", ""] {
            assert!(validate_semver(v).is_err(), "version「{v}」应被拒绝");
        }
        let mut m = good_manifest();
        m.version = "1.0".into();
        assert!(m.validate().is_err());
    }

    #[test]
    fn validate_enforces_id_and_kind_whitelist() {
        let mut m = good_manifest();
        m.id = "Bad_ID!".into();
        assert!(m.validate().is_err(), "id 大写/特殊字符必须拒绝");
        let mut m = good_manifest();
        m.id = "../evil".into();
        assert!(m.validate().is_err(), "id 含路径字符必须拒绝");
        let mut m = good_manifest();
        m.kind = "code".into();
        assert!(m.validate().is_err(), "kind 白名单外必须拒绝");
    }

    #[test]
    fn validate_requires_nonempty_unique_prompts() {
        let mut m = good_manifest();
        m.prompts.clear();
        assert!(m.validate().is_err(), "prompts 为空必须拒绝");
        let mut m = good_manifest();
        let dup = m.prompts[0].clone();
        m.prompts.push(dup);
        assert!(m.validate().is_err(), "prompt.id 重复必须拒绝");
        let mut m = good_manifest();
        m.prompts[0].template = "  ".into();
        assert!(m.validate().is_err(), "template 空白必须拒绝");
    }

    #[test]
    fn render_template_supports_input_and_context() {
        let ctx = RenderContext {
            project_name: Some("霓虹夜行".into()),
            episode_title: Some("第 1 集".into()),
        };
        let out = render_template("给《{{project.name}}》第{{episode.title}}写：{{input}}", Some("开场夜戏"), &ctx);
        assert_eq!(out, "给《霓虹夜行》第第 1 集写：开场夜戏");
    }

    #[test]
    fn render_template_missing_context_and_unknown_vars_render_empty() {
        let ctx = RenderContext::default();
        assert_eq!(render_template("P={{project.name}} E={{episode.title}} I={{input}}", None, &ctx), "P= E= I=");
        // 未知变量留空；未闭合 {{ 原样保留
        assert_eq!(render_template("X={{unknown.var}} Y={{oops", None, &ctx), "X= Y={{oops");
        // 变量名允许两侧空白：{{ input }} 同样命中
        let ctx2 = RenderContext { project_name: Some("A".into()), episode_title: None };
        assert_eq!(render_template("{{ project.name }}", None, &ctx2), "A");
    }

    #[test]
    fn list_parses_and_skips_bad_plugins() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugins");
        // 合法插件
        let ok = root.join("demo-pack");
        std::fs::create_dir_all(&ok).unwrap();
        std::fs::write(
            ok.join("plugin.json"),
            serde_json::to_string(&good_manifest()).unwrap(),
        )
        .unwrap();
        // 坏 JSON
        let badjson = root.join("bad-json");
        std::fs::create_dir_all(&badjson).unwrap();
        std::fs::write(badjson.join("plugin.json"), "{ not json").unwrap();
        // 坏 semver
        let badver = root.join("bad-ver");
        std::fs::create_dir_all(&badver).unwrap();
        std::fs::write(
            badver.join("plugin.json"),
            serde_json::json!({
                "id": "bad-ver", "name": "x", "version": "1.0",
                "kind": "prompt-pack", "prompts": [{ "id": "p", "name": "p", "template": "t" }]
            })
            .to_string(),
        )
        .unwrap();
        // 非 plugin 文件夹（无 plugin.json）应被静默跳过
        std::fs::create_dir_all(root.join("not-a-plugin")).unwrap();

        let hub = PluginHub::new(&root);
        let items = hub.list();
        assert_eq!(items.len(), 3, "无 plugin.json 的文件夹不应出现");
        let ok_row = items.iter().find(|x| x.valid).unwrap();
        assert_eq!(ok_row.id, "demo-pack");
        assert_eq!(ok_row.prompts_count, 1);
        assert_eq!(items.iter().filter(|x| !x.valid).count(), 2);
        assert!(items.iter().filter(|x| !x.valid).all(|x| !x.error.is_empty()));
    }

    #[test]
    fn get_and_render_prompt_via_hub() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugins");
        let ok = root.join("demo-pack");
        std::fs::create_dir_all(&ok).unwrap();
        std::fs::write(
            ok.join("plugin.json"),
            serde_json::to_string(&good_manifest()).unwrap(),
        )
        .unwrap();
        let hub = PluginHub::new(&root);
        let m = hub.get("demo-pack").unwrap();
        assert_eq!(m.prompts.len(), 1);
        let ctx = RenderContext { project_name: Some("项目P".into()), episode_title: None };
        let text = hub
            .render_prompt("demo-pack", "greet", Some("写一版台词"), &ctx)
            .unwrap();
        assert_eq!(text, "你好 项目P，本集：，输入：写一版台词");
        assert!(hub.render_prompt("demo-pack", "no-such", None, &ctx).is_err());
        assert!(hub.get("no-such-pack").is_err());
    }

    #[test]
    fn path_escape_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("plugins");
        // 在插件目录外放置一个“插件”，尝试 ../ 逃逸读取
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(
            outside.join("plugin.json"),
            serde_json::to_string(&good_manifest()).unwrap(),
        )
        .unwrap();
        let hub = PluginHub::new(&root);
        for evil in ["../outside", "..", "a/b", "a\\b", ".", "", "OK", "白"] {
            assert!(hub.get(evil).is_err(), "逃逸 id「{evil}」必须被拒绝");
        }
    }
}
