//! OneTV 桌面端 Tauri 壳：命令层只做参数转换，业务在 onetv-* crates。

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;

use onetv_core::agent::executor::Executor;
use onetv_core::agent::{route_intent, AgentEnv, Plan};
use onetv_core::jobs::{EventSink, JobManager};
use onetv_core::providers::gateway::Gateway;
use onetv_core::providers::{Capability, ProviderDriverKind, ProviderRegistry};
use onetv_core::{AppSettings, SettingsStore};
use onetv_media::MediaLocator;
use onetv_project::{manifest::ProjectManifest, ops, ProjectHandle};
use onetv_security::audit::AuditLog;
use onetv_security::{NetworkPolicy, SecretStore};
use parking_lot::{Mutex, RwLock};
use serde::Serialize;
use tauri::{Emitter, Manager, State};

#[derive(Default)]
pub struct OpenedProject {
    pub handle: Option<ProjectHandle>,
    pub manifest: Option<ProjectManifest>,
}

pub struct AppState {
    pub settings: SettingsStore,
    pub media: MediaLocator,
    pub policy: Arc<RwLock<NetworkPolicy>>,
    pub audit: Arc<AuditLog>,
    pub project: RwLock<OpenedProject>,
    pub skills: onetv_core::skills::SkillHub,
    pub auth: onetv_core::auth::AuthStore,
    pub logged_in: std::sync::atomic::AtomicBool,
}

impl AppState {
    fn sync_policy(&self) {
        let s = self.settings.get();
        let mut p = NetworkPolicy::new(s.offline_mode);
        for h in &s.allowed_hosts {
            p.allow_base_url(h);
        }
        *self.policy.write() = p;
        self.media.set_overrides(
            s.ffmpeg_path.map(PathBuf::from),
            s.ffprobe_path.map(PathBuf::from),
        );
    }
}

type TState<'a> = State<'a, Arc<AppState>>;

/// Agent / Provider / Job 运行时（setup 时创建）。
pub struct AgentState {
    pub env: Arc<AgentEnv>,
    pub jobs: Arc<JobManager>,
    pub plans: Mutex<std::collections::HashMap<String, Plan>>,
    pub registry: Arc<RwLock<ProviderRegistry>>,
}

static AGENT: std::sync::OnceLock<Arc<AgentState>> = std::sync::OnceLock::new();

fn verify_store_named() -> onetv_core::mail::VerificationStore {
    onetv_core::mail::VerificationStore::new(&onetv_core::app_data_dir().join("verify"))
}

#[derive(Serialize)]
struct CommandError {
    message: String,
}

fn err<E: std::fmt::Display>(e: E) -> CommandError {
    tracing::error!("{e}");
    CommandError { message: e.to_string() }
}

/* ---------------- 设置 ---------------- */

#[tauri::command]
fn settings_get(state: TState) -> AppSettings {
    state.settings.get()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    version: String,
    data_dir: String,
}

#[tauri::command]
fn app_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION").into(),
        data_dir: onetv_core::app_data_dir().display().to_string(),
    }
}

/// registry → 单价表：模型 pricing.perCall（元/次）
fn pricing_map(registry: &onetv_core::providers::ProviderRegistry) -> onetv_core::jobs::PricingMap {
    let mut m = onetv_core::jobs::PricingMap::new();
    for p in registry.list() {
        for mdl in &p.models {
            if let Some(price) = mdl.pricing.as_ref().and_then(|v| v.get("perCall")).and_then(|v| v.as_f64()) {
                if price > 0.0 {
                    m.insert(format!("{}/{}", p.id, mdl.model_id), price);
                }
            }
        }
    }
    m
}

#[tauri::command]
fn settings_update(state: TState, patch: serde_json::Value) -> Result<AppSettings, CommandError> {
    let out = state.settings.update(|s| apply_patch(s, &patch));
    // 出站 Webhook：启用且 URL 非空时自动把主机加入允许域名（与 provider_save 同策略）
    if out.webhook_out.enabled {
        if let Some(host) = onetv_core::webhook_out::host_of(&out.webhook_out.url) {
            if !state.policy.read().allowed_hosts.contains(&host) {
                state.policy.write().allow_base_url(&host);
                state.settings.update(|s| {
                    if !s.allowed_hosts.contains(&host) {
                        s.allowed_hosts.push(host.clone());
                    }
                });
                state.audit.record("webhook_out.allow_host", &host, None);
            }
        }
    }
    state.sync_policy();
    if let Some(agent) = AGENT.get() {
        agent.env.set_offline(out.offline_mode);
        agent.env.set_auto_memory(out.auto_memory);
        agent.env.set_custom_instructions(out.custom_instructions.clone());
        agent.jobs.set_concurrency(out.max_concurrent_jobs);
        agent.env.set_model_defaults(model_defaults_map(&out));
        agent.jobs.set_cost_guard(onetv_core::jobs::CostGuardConfig {
            enabled: out.cost_guard.enabled,
            daily_remote_limit: out.cost_guard.daily_remote_limit,
            project_total_limit: out.cost_guard.project_total_limit,
            daily_cost_limit: out.cost_guard.daily_cost_limit,
            project_cost_limit: out.cost_guard.project_cost_limit,
        });
        agent.jobs.set_pricing(pricing_map(&agent.registry.read()));
    }
    Ok(out)
}

/// settings.modelDefaults → env 默认模型表
fn model_defaults_map(
    s: &AppSettings,
) -> std::collections::HashMap<String, (String, String)> {
    s.model_defaults
        .iter()
        .map(|(k, v)| (k.clone(), (v.provider_id.clone(), v.model_id.clone())))
        .collect()
}

fn apply_patch(s: &mut AppSettings, patch: &serde_json::Value) {
    if let Some(v) = patch.get("theme").and_then(|v| v.as_str()) {
        if v == "dark" || v == "light" {
            s.theme = v.into();
        }
    }
    if let Some(v) = patch.get("skinOpacity").and_then(|v| v.as_f64()) {
        s.skin_opacity = v.clamp(0.0, 1.0);
    }
    if let Some(v) = patch.get("offlineMode").and_then(|v| v.as_bool()) {
        s.offline_mode = v;
    }
    if let Some(v) = patch.get("ffmpegPath").and_then(|v| v.as_str()) {
        s.ffmpeg_path = if v.trim().is_empty() { None } else { Some(v.into()) };
    }
    if let Some(v) = patch.get("ffprobePath").and_then(|v| v.as_str()) {
        s.ffprobe_path = if v.trim().is_empty() { None } else { Some(v.into()) };
    }
    if let Some(v) = patch.get("maxConcurrentJobs").and_then(|v| v.as_u64()) {
        s.max_concurrent_jobs = v.clamp(1, 8) as u32;
    }
    if let Some(v) = patch.get("autoSaveIntervalSec").and_then(|v| v.as_u64()) {
        s.auto_save_interval_sec = v.clamp(5, 300) as u32;
    }
    if let Some(v) = patch.get("defaultProjectFolder").and_then(|v| v.as_str()) {
        s.default_project_folder = if v.trim().is_empty() { None } else { Some(v.into()) };
    }
    // 自动记忆（v2.26.15）与自定义指令（v2.26.16）
    if let Some(v) = patch.get("autoMemory").and_then(|v| v.as_bool()) {
        s.auto_memory = v;
    }
    if let Some(v) = patch.get("customInstructions").and_then(|v| v.as_str()) {
        s.custom_instructions = v.to_string();
    }
    // 生成模型设置：{ chat: {providerId, modelId} | null, image: ..., video: ..., tts: ... }
    if let Some(md) = patch.get("modelDefaults").and_then(|v| v.as_object()) {
        for (cap, val) in md {
            let cap = cap.to_string();
            let entry = val.as_object().and_then(|obj| {
                let pid = obj.get("providerId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                let mid = obj.get("modelId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if pid.is_empty() || mid.is_empty() {
                    None
                } else {
                    Some(onetv_core::settings::ModelRef { provider_id: pid, model_id: mid })
                }
            });
            match entry {
                Some(mr) => {
                    s.model_defaults.insert(cap, mr);
                }
                None => {
                    s.model_defaults.remove(&cap);
                }
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FfmpegStatus {
    ok: bool,
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
    ffmpeg_version: Option<String>,
    message: String,
}

#[tauri::command]
async fn ffmpeg_status(state: tauri::State<'_, Arc<AppState>>) -> Result<FfmpegStatus, CommandError> {
    // resolve() 会真实执行 ffmpeg -version 子进程（多候选逐个尝试），放阻塞线程池
    let media = state.media.clone();
    let r = tokio::task::spawn_blocking(move || {
        media.resolve().map(|r| FfmpegStatus {
            ok: true,
            ffmpeg_path: Some(r.ffmpeg.to_string_lossy().into_owned()),
            ffprobe_path: Some(r.ffprobe.to_string_lossy().into_owned()),
            ffmpeg_version: r.version,
            message: "FFmpeg 就绪（本地合成可用）".into(),
        }).unwrap_or_else(|e| FfmpegStatus {
            ok: false,
            ffmpeg_path: None,
            ffprobe_path: None,
            ffmpeg_version: None,
            message: e.to_string(),
        })
    })
    .await
    .map_err(|e| err(e.to_string()))?;
    Ok(r)
}

/* ---------------- 最近项目 ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentDto {
    path: String,
    name: String,
    last_opened_at: String,
}

#[tauri::command]
fn workspace_recent_list(state: TState) -> Vec<RecentDto> {
    state
        .settings
        .get()
        .recent_projects
        .into_iter()
        .map(|r| RecentDto { path: r.path, name: r.name, last_opened_at: r.last_opened_at })
        .collect()
}

#[tauri::command]
fn workspace_recent_add(state: TState, path: String, name: String) {
    state.settings.touch_recent(&path, &name);
}

/* ---------------- 文件选择 ---------------- */

// ⚠️ 对话框实现（v2.4.1 重写）：一律使用插件的**回调 API + oneshot 通道**，
// 在 async 命令里 await 通道结果。此前 blocking_pick_file 在 async 上下文中
// 于 macOS 上会静默失败（立即返回 None → 前端当成"已取消"，表现为按钮点了
// 没反应——Agent 添加参考/上传皮肤实测复现）。回调 API 由插件派发到主线程，
// 并挂主窗口为父级，面板必然前置弹出。
use tauri_plugin_dialog::DialogExt;

fn dialog_builder(
    app: &tauri::AppHandle,
    title: String,
) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let mut b = app.dialog().file().set_title(title);
    if let Some(w) = app.get_webview_window("main") {
        b = b.set_parent(&w);
    }
    b
}

async fn pick_path(app: &tauri::AppHandle, title: String, folder: bool) -> Option<PathBuf> {
    pick_path_at(app, title, folder, None).await
}

async fn pick_path_at(
    app: &tauri::AppHandle,
    title: String,
    folder: bool,
    start_dir: Option<PathBuf>,
) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    let mut dialog = dialog_builder(app, title);
    if let Some(dir) = start_dir {
        dialog = dialog.set_directory(dir);
    }
    if folder {
        dialog.pick_folder(move |p| {
            let _ = tx.send(p.and_then(|f| f.as_path().map(|x| x.to_path_buf())));
        });
    } else {
        dialog.pick_file(move |p| {
            let _ = tx.send(p.and_then(|f| f.as_path().map(|x| x.to_path_buf())));
        });
    }
    rx.await.ok().flatten()
}

async fn save_path(app: &tauri::AppHandle, title: String, default_name: String) -> Option<PathBuf> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<PathBuf>>();
    dialog_builder(app, title)
        .set_file_name(default_name)
        .save_file(move |p| {
            let _ = tx.send(p.and_then(|f| f.as_path().map(|x| x.to_path_buf())));
        });
    rx.await.ok().flatten()
}

#[tauri::command]
async fn pick_directory(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    title: String,
) -> Result<Option<String>, String> {
    // 初始目录：默认项目文件夹 → ~/Documents/OneTV → ~/Documents
    // （界面提示"默认建议放在 文稿/OneTV 下"，对话框必须与提示一致）
    let start = {
        let s = state.settings.get();
        s.default_project_folder
            .clone()
            .map(PathBuf::from)
            .or_else(|| dirs_home().map(|h| h.join("Documents").join("OneTV")))
            .or_else(|| dirs_home().map(|h| h.join("Documents")))
    };
    let picked = pick_path_at(&app, title, true, start).await.map(|p| p.to_string_lossy().into_owned());
    Ok(picked)
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(PathBuf::from)
}

#[tauri::command]
async fn pick_file(app: tauri::AppHandle, title: String) -> Option<String> {
    pick_path(&app, title, false).await.map(|p| p.to_string_lossy().into_owned())
}

/* ---------------- 项目 ---------------- */

// 前端 IPC 传参为 camelCase（workspacePath/projectTitle/aspectRatio）：
// serde 只对外层命令参数做 camelCase 映射，结构体内部字段必须显式 rename，
// 否则反序列化全丢 → "missing field workspace_path"（v2.3.0 新建项目 100% 失败的根因）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateProjectInput {
    workspace_path: String,
    project_title: String,
    #[serde(default = "default_aspect")]
    aspect_ratio: String,
}

fn default_aspect() -> String {
    "9:16".into()
}

#[tauri::command]
fn project_create(state: TState, input: CreateProjectInput) -> Result<ProjectManifest, CommandError> {
    let ws = PathBuf::from(&input.workspace_path);
    let (handle, mut manifest) =
        ops::create_project(&ws, &input.project_title, &input.aspect_ratio).map_err(err)?;
    manifest.provider_profiles.clear();
    {
        let mut p = state.project.write();
        p.handle = Some(handle.clone());
        p.manifest = Some(manifest.clone());
    }
    state.settings.touch_recent(
        &handle.root().to_string_lossy(),
        &input.project_title,
    );
    // 记住最后打开的工程：重启后自动恢复（BUG：重启不恢复上次项目）
    state.settings.update(|s| s.last_project = Some(handle.root().to_string_lossy().into_owned()));
    if let Some(agent) = AGENT.get() {
        agent.jobs.set_project_root(Some(handle.root().clone()));
        let resumed = agent.jobs.resume_on_restart();
        if resumed > 0 {
            tracing::info!(resumed, "jobs resumed after restart");
        }
    }
    state.audit.record("project.create", &input.project_title, None);
    Ok(manifest)
}

#[tauri::command]
fn project_open(state: TState, project_dir: String) -> Result<ProjectManifest, CommandError> {
    let dir = PathBuf::from(&project_dir);
    let (handle, manifest) = ops::open_project(&dir).map_err(err)?;
    state.settings.touch_recent(&dir.to_string_lossy(), &manifest.project.title);
    state.settings.update(|s| s.last_project = Some(dir.to_string_lossy().into_owned()));
    state.audit.record("project.open", &project_dir, None);
    if let Some(agent) = AGENT.get() {
        agent.jobs.set_project_root(Some(dir.clone()));
        let resumed = agent.jobs.resume_on_restart();
        if resumed > 0 {
            tracing::info!(resumed, "jobs resumed after project open");
        }
    }
    {
        let mut p = state.project.write();
        p.handle = Some(handle);
        p.manifest = Some(manifest.clone());
    }
    Ok(manifest)
}

#[tauri::command]
fn project_close(state: TState) {
    if let Some(agent) = AGENT.get() {
        agent.jobs.set_project_root(None);
    }
    state.settings.update(|s| s.last_project = None);
    let mut p = state.project.write();
    p.handle = None;
    p.manifest = None;
    state.audit.record("project.close", "", None);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectInfo {
    manifest: Option<ProjectManifest>,
    root_path: Option<String>,
}

#[tauri::command]
fn project_info(state: TState) -> ProjectInfo {
    let p = state.project.read();
    ProjectInfo {
        manifest: p.manifest.clone(),
        root_path: p.handle.as_ref().map(|h| h.root().to_string_lossy().into_owned()),
    }
}

/* ---------------- 分集 ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EpisodeDto {
    id: String,
    number: u32,
    title: String,
    status: String,
}

#[tauri::command]
fn episode_list(state: TState) -> Result<Vec<EpisodeDto>, CommandError> {
    let p = state.project.read();
    let Some(handle) = &p.handle else { return Ok(Vec::new()) };
    let Some(manifest) = &p.manifest else { return Ok(Vec::new()) };
    let eps = ops::list_episodes(handle.root(), manifest).map_err(err)?;
    Ok(eps
        .into_iter()
        .map(|(ep, status)| EpisodeDto { id: ep.id, number: ep.number, title: ep.title, status })
        .collect())
}

#[tauri::command]
fn episode_create(state: TState, title: Option<String>) -> Result<EpisodeDto, CommandError> {
    let mut p = state.project.write();
    let root = p.handle.as_ref().map(|h| h.root().clone());
    let Some(root) = root else {
        return Err(err("未打开项目"));
    };
    let Some(manifest) = p.manifest.as_mut() else {
        return Err(err("未打开项目"));
    };
    let ep = ops::add_episode(&root, manifest, title.as_deref()).map_err(err)?;
    state.audit.record("episode.create", &ep.id, None);
    Ok(EpisodeDto { id: ep.id, number: ep.number, title: ep.title, status: "draft".into() })
}

#[tauri::command]
fn episode_delete(state: TState, episode_id: String) -> Result<(), CommandError> {
    let mut p = state.project.write();
    let root = p.handle.as_ref().map(|h| h.root().clone());
    let Some(root) = root else {
        return Err(err("未打开项目"));
    };
    let Some(manifest) = p.manifest.as_mut() else {
        return Err(err("未打开项目"));
    };
    ops::remove_episode(&root, manifest, &episode_id).map_err(err)?;
    state.audit.record("episode.delete", &episode_id, None);
    Ok(())
}

/* ---------------- 项目删除 ---------------- */

/// 删除 .ytv 工程：磁盘上整个工程文件夹不可恢复地删除，并从最近列表移除。
/// 若该工程当前处于打开状态则先关闭。安全边界：必须是有效 OneTV 工程目录。
#[tauri::command]
async fn project_delete(state: tauri::State<'_, Arc<AppState>>, project_dir: String) -> Result<(), CommandError> {
    let dir = PathBuf::from(&project_dir);
    // 必须是有效工程（校验 project.json 可解析），防止误删普通文件夹
    let (_, manifest) = ops::open_project(&dir).map_err(err)?;
    let title = manifest.project.title.clone();

    // 当前打开的就是该工程 → 先关闭（含任务队列解绑）
    {
        let p = state.project.read();
        if let Some(h) = &p.handle {
            if h.root() == &dir {
                drop(p);
                if let Some(agent) = AGENT.get() {
                    agent.jobs.set_project_root(None);
                }
                let mut p2 = state.project.write();
                p2.handle = None;
                p2.manifest = None;
                state.settings.update(|s| s.last_project = None);
            }
        }
    }
    // 大工程（可含数 GB 视频资产）的整目录删除放进阻塞线程池，避免卡住主线程
    let dir_for_rm = dir.clone();
    tokio::task::spawn_blocking(move || std::fs::remove_dir_all(&dir_for_rm))
        .await
        .map_err(|e| err(e.to_string()))?
        .map_err(err)?;
    state.settings.update(|s| {
        s.recent_projects.retain(|r| r.path != project_dir);
        if s.last_project.as_deref() == Some(project_dir.as_str()) {
            s.last_project = None;
        }
    });
    state.audit.record("project.delete", &format!("{title} ({project_dir})"), None);
    Ok(())
}

/// 从最近打开列表移除记录（不删除磁盘文件）。
#[tauri::command]
fn workspace_recent_remove(state: TState, path: String) {
    state.settings.update(|s| s.recent_projects.retain(|r| r.path != path));
}

/* ---------------- Keychain ---------------- */

#[tauri::command]
fn secure_key_set(provider_id: String, key: String) -> Result<(), CommandError> {
    SecretStore::set(&provider_id, &key).map_err(err)
}

#[tauri::command]
fn secure_key_delete(provider_id: String) -> Result<(), CommandError> {
    SecretStore::delete(&provider_id).map_err(err)
}

#[tauri::command]
fn secure_key_exists(provider_id: String) -> Result<bool, CommandError> {
    Ok(SecretStore::exists(&provider_id))
}

#[tauri::command]
fn secure_key_list(state: TState) -> Vec<String> {
    let p = state.project.read();
    let ids: Vec<String> = p
        .manifest
        .as_ref()
        .map(|m| m.provider_profiles.clone())
        .unwrap_or_default();
    ids.into_iter().filter(|id| SecretStore::exists(id)).collect()
}

fn model_binding(id: &str, caps: &[Capability]) -> onetv_core::providers::ModelBinding {
    onetv_core::providers::ModelBinding {
        model_id: id.into(),
        display_name: id.into(),
        capabilities: caps.to_vec(),
        endpoint: None,
        pricing: None,
        limits: None,
    }
}

/// onetv-app:// —— 仅服务应用数据目录 themes/ 内的皮肤文件（防路径穿越）。
fn serve_app_file(uri: &tauri::http::Uri) -> tauri::http::Response<Cow<'static, [u8]>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Cow::Borrowed(&b"not found"[..]))
            .unwrap()
    };
    let raw = uri.to_string();
    let Some(rest) = raw.strip_prefix("onetv-app://") else { return not_found() };
    let after_host = rest.split_once('/').map(|(_, r)| r).unwrap_or("");
    let name = percent_decode(after_host.split('?').next().unwrap_or(""));
    // 只允许 themes/<单个文件名>，禁子目录与穿越
    if name.is_empty() || name.contains('/') || name.contains("..") {
        return not_found();
    }
    let themes = onetv_core::app_data_dir().join("themes");
    let path = themes.join(&name);
    let Ok(canon) = std::fs::canonicalize(&path) else { return not_found() };
    if !canon.starts_with(&themes) {
        return not_found();
    }
    let Ok(bytes) = std::fs::read(&canon) else { return not_found() };
    tauri::http::Response::builder()
        .header("Content-Type", mime_of(&canon))
        .header("Cache-Control", "no-store")
        .body(Cow::Owned(bytes))
        .unwrap()
}

/* ---------------- Agent ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentChatResult {
    plan: Plan,
    auto_executed: bool,
    job_ids: Vec<String>,
}

#[tauri::command]
/// history：会话历史（v2.6.3）[{role, content}]，仅 chat 意图注入供 LLM 上下文
async fn agent_chat(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    text: String,
    provider_id: Option<String>,
    model_id: Option<String>,
    history: Option<Vec<serde_json::Value>>,
) -> Result<AgentChatResult, CommandError> {
    let episode = {
        let p = state.project.read();
        p.manifest.as_ref().and_then(|m| m.episodes.first().map(|e| e.id.clone()))
    };
    let intent = route_intent(&text);
    let mut plan = onetv_core::agent::build_plan(intent, &text, episode.as_deref());
    // L4 Reviewer（v2.13）：执行前启发式复核（离线冲突/缺参/成本提示）
    onetv_core::agent::review_plan(&mut plan, agent.env.offline_mode());
    if let Some(hist) = &history {
        // 只注入 chat 意图：剧本/生图等结构化任务的 prompt 不混入对话历史
        if matches!(intent, onetv_core::agent::Intent::Chat) {
            for step in &mut plan.steps {
                step.input["history"] = serde_json::json!(hist);
            }
        }
    }
    // UI 模型选择器：显式指定的模型写入每个步骤输入，handlers 优先使用
    if let Some(pid) = &provider_id {
        for step in &mut plan.steps {
            step.input["providerId"] = serde_json::json!(pid);
        }
    }
    if let Some(mid) = &model_id {
        for step in &mut plan.steps {
            step.input["model"] = serde_json::json!(mid);
        }
    }
    plan.status = "draft".into();

    // chat 意图低风险：直接执行
    if intent == onetv_core::agent::Intent::Chat {
        let executor = Executor { env: agent.env.clone(), jobs: agent.jobs.clone() };
        let root = {
            let p = state.project.read();
            match p.handle.as_ref().map(|h| h.root().clone()) {
                Some(r) => r,
                // v2.12.0：此前回退 temp 目录 → job 不落库、永不执行，表现为"发了消息没反应"
                None => return Err(err("未打开项目：请先在「工作区」打开项目后再对话")),
            }
        };
        let ids = executor.execute(&plan, &root, None).await.map_err(err)?;
        plan.status = "executing".into();
        agent.plans.lock().insert(plan.plan_id.clone(), plan.clone());
        return Ok(AgentChatResult { plan, auto_executed: true, job_ids: ids });
    }

    agent.plans.lock().insert(plan.plan_id.clone(), plan.clone());
    (agent.env).events("agent.plan.created", serde_json::json!({"planId": plan.plan_id, "summary": plan.summary}));
    Ok(AgentChatResult { plan, auto_executed: false, job_ids: vec![] })
}

#[tauri::command]
async fn agent_approve(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    plan_id: String,
) -> Result<Vec<String>, CommandError> {
    let plan = agent
        .plans
        .lock()
        .get(&plan_id)
        .cloned()
        .ok_or_else(|| err("计划不存在或已过期"))?;
    let root = {
        let p = state.project.read();
        p.handle.as_ref().map(|h| h.root().clone()).ok_or_else(|| err("未打开项目"))?
    };
    let episode = {
        let p = state.project.read();
        p.manifest.as_ref().and_then(|m| m.episodes.first().map(|e| e.id.clone()))
    };
    let executor = Executor { env: agent.env.clone(), jobs: agent.jobs.clone() };
    let mut approved = plan.clone();
    approved.status = "approved".into();
    agent.plans.lock().insert(plan_id.clone(), approved);
    state.audit.record("agent.plan.approved", &plan.intent, None);
    let ids = executor.execute(&plan, &root, episode).await.map_err(err)?;
    Ok(ids)
}

/* ---------------- Jobs ---------------- */

#[tauri::command]
fn job_list(agent: tauri::State<'_, Arc<AgentState>>, limit: Option<u32>) -> Vec<serde_json::Value> {
    agent
        .jobs
        .list(limit.unwrap_or(100))
        .iter()
        .map(|j| serde_json::json!({
            "id": j.id, "kind": j.kind.as_str(), "title": j.title, "state": j.state.as_str(),
            "progress": j.progress, "providerId": j.provider_id, "model": j.model,
            "episodeId": j.episode_id, "error": j.error, "attempts": j.attempts,
            "outputs": j.outputs, "reply": j.result.get("reply").cloned().unwrap_or(serde_json::Value::Null),
            "createdAt": j.created_at, "updatedAt": j.updated_at
        }))
        .collect()
}

#[tauri::command]
fn job_events(agent: tauri::State<'_, Arc<AgentState>>, id: String) -> Vec<serde_json::Value> {
    agent
        .jobs
        .events_of(&id)
        .into_iter()
        .map(|(t, p, time)| serde_json::json!({"type": t, "payload": p, "time": time}))
        .collect()
}

#[tauri::command]
fn job_cancel(agent: tauri::State<'_, Arc<AgentState>>, id: String) -> Result<(), CommandError> {
    agent.jobs.cancel(&id).map_err(err)
}

#[tauri::command]
fn job_retry(agent: tauri::State<'_, Arc<AgentState>>, id: String) -> Result<(), CommandError> {
    agent.jobs.retry(&id).map_err(err)
}

#[tauri::command]
fn job_approve(agent: tauri::State<'_, Arc<AgentState>>, id: String) -> Result<(), CommandError> {
    agent.jobs.approve(&id).map_err(err)
}

/* ---------------- Providers ---------------- */

#[tauri::command]
fn provider_list(agent: tauri::State<'_, Arc<AgentState>>) -> Vec<serde_json::Value> {
    agent
        .registry
        .read()
        .list()
        .iter()
        .map(|p| provider_public(p, SecretStore::exists(&p.id)))
        .collect()
}

fn provider_public(p: &onetv_core::providers::ProviderProfile, has_key: bool) -> serde_json::Value {
    serde_json::json!({
        "id": p.id, "name": p.name,
        "driver": match p.driver {
            ProviderDriverKind::OpenaiCompatible => "openai-compatible",
            ProviderDriverKind::CustomHttp => "custom-http",
            ProviderDriverKind::Ollama => "ollama",
            ProviderDriverKind::Mock => "mock",
            ProviderDriverKind::Comfyui => "comfyui",
            ProviderDriverKind::StableDiffusion => "stable-diffusion",
            ProviderDriverKind::Plugin => "plugin",
        },
        "baseUrl": p.base_url,
        "authType": p.auth.auth_type,
        "models": p.models.iter().map(|m| serde_json::json!({
            "modelId": m.model_id, "displayName": m.display_name,
            "capabilities": m.capabilities.iter().map(|c| c.as_str()).collect::<Vec<_>>(),
            "pricing": m.pricing,
        })).collect::<Vec<_>>(),
        "timeoutMs": p.timeout_ms,
        "concurrency": p.concurrency,
        "enabled": p.enabled,
        "hasKey": has_key,
        "httpTemplate": p.http_template,
        "workflowTemplate": p.workflow_template,
        "createdAt": p.created_at,
    })
}

fn profile_from_json(v: serde_json::Value) -> Result<onetv_core::providers::ProviderProfile, CommandError> {
    serde_json::from_value(v).map_err(err)
}

/// 驱动-能力校验：无效配置不入库，避免错误延迟到任务执行才暴露。
/// （历史案例：SD 驱动下 sd1 标记"对话"并保存成功，运行期任务失败
///   "驱动 StableDiffusion 不支持 chat 能力"。）
fn validate_driver_capabilities(
    p: &onetv_core::providers::ProviderProfile,
) -> Result<(), CommandError> {
    use onetv_core::providers::Capability as Cap;
    let (allowed, label): (&[Cap], &str) = match p.driver {
        ProviderDriverKind::StableDiffusion => (&[Cap::ImageGeneration], "Stable Diffusion（仅生图）"),
        ProviderDriverKind::Comfyui => {
            if p.workflow_template.is_some() {
                // 配置了工作流模板：图片（FLUX/自定义工作流）+ 视频（Wan 等本地工作流）
                (&[Cap::ImageGeneration, Cap::VideoGeneration], "ComfyUI（工作流模式：生图 + 生视频）")
            } else {
                (&[Cap::ImageGeneration], "ComfyUI（仅生图；配置工作流模板后可开生视频）")
            }
        }
        _ => return Ok(()),
    };
    for m in &p.models {
        for c in &m.capabilities {
            if !allowed.contains(c) {
                let cap_cn = match c {
                    Cap::Chat => "对话",
                    Cap::ImageGeneration => "生图",
                    Cap::VideoGeneration => "生视频",
                    Cap::Tts => "配音",
                    _ => "该能力",
                };
                return Err(err(format!(
                    "驱动 {label} 不支持「{cap_cn}」能力：请取消勾选模型 {} 的「{cap_cn}」，或改用支持该能力的 Provider",
                    m.model_id
                )));
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn provider_save(
    state: TState,
    agent: tauri::State<'_, Arc<AgentState>>,
    profile: serde_json::Value,
) -> Result<serde_json::Value, CommandError> {
    let mut p = profile_from_json(profile)?;
    if p.id.is_empty() {
        p.id = format!("provider-{}", uuid::Uuid::new_v4().simple());
    }
    validate_driver_capabilities(&p)?;
    // 网络策略：加入白名单（Local-only 下仍然会被拒绝）
    state.settings.update(|s| {
        if !s.allowed_hosts.contains(&p.base_url) {
            s.allowed_hosts.push(p.base_url.clone());
        }
    });
    state.sync_policy();
    agent.registry.write().upsert(p.clone());
    state.audit.record("provider.save", &p.id, None);
    Ok(provider_public(&p, SecretStore::exists(&p.id)))
}

#[tauri::command]
fn provider_delete(
    state: TState,
    agent: tauri::State<'_, Arc<AgentState>>,
    id: String,
) -> Result<(), CommandError> {
    let removed = agent.registry.write().delete(&id);
    if removed {
        let _ = SecretStore::delete(&id);
        state.audit.record("provider.delete", &id, None);
    }
    Ok(())
}

#[tauri::command]
async fn provider_test(
    _state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    id: String,
) -> Result<serde_json::Value, CommandError> {
    let profile = agent
        .registry
        .read()
        .get(&id)
        .ok_or_else(|| err("Provider 不存在"))?;
    let started = std::time::Instant::now();
    let result: Result<(), String> = match profile.driver {
        ProviderDriverKind::Mock => Ok(()),
        ProviderDriverKind::Ollama => {
            onetv_core::providers::ollama::health(agent.env.gateway(), &profile)
                .await
                .map_err(|e| e.to_string())
        }
        ProviderDriverKind::OpenaiCompatible => {
            onetv_core::providers::openai::list_models(agent.env.gateway(), &profile)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        ProviderDriverKind::StableDiffusion => {
            onetv_core::providers::sd::health(agent.env.gateway(), &profile)
                .await
                .map_err(|e| e.to_string())
        }
        ProviderDriverKind::Comfyui => {
            onetv_core::providers::comfyui::health(agent.env.gateway(), &profile)
                .await
                .map_err(|e| e.to_string())
        }
        ProviderDriverKind::CustomHttp | ProviderDriverKind::Plugin => {
            agent.env.gateway().check(&profile.base_url).map_err(|e| e.to_string())
        }
    };
    let latency = started.elapsed().as_millis() as u64;
    // 面向用户净化底层错误：reqwest 原文（如 "error sending request for url (...)"）
    // 中英混杂且不可读；失败时不宣传毫秒级延迟（会被误读为服务响应极快）。
    let friendly = |m: String| -> String {
        if m.contains("error sending request") || m.contains("timed out") || m.contains("timeout") {
            "无法连接到服务（请确认服务已启动且开启 API）".into()
        } else if m.contains("invalid peer certificate") || m.to_lowercase().contains("certificate") {
            "TLS 证书校验失败（自签名证书请在本机信任）".into()
        } else {
            m
        }
    };
    Ok(serde_json::json!({
        "ok": result.is_ok(),
        "message": match &result {
            Ok(()) => "连接成功".to_string(),
            Err(m) => friendly(m.clone()),
        },
        "latencyMs": latency
    }))
}

#[tauri::command]
async fn provider_models(
    agent: tauri::State<'_, Arc<AgentState>>,
    id: String,
) -> Result<serde_json::Value, CommandError> {
    let profile = agent.registry.read().get(&id).ok_or_else(|| err("Provider 不存在"))?;
    let models = match profile.driver {
        ProviderDriverKind::Mock => onetv_core::providers::mock::list_models(&profile).await,
        ProviderDriverKind::Ollama => {
            onetv_core::providers::ollama::list_models(agent.env.gateway(), &profile).await
        }
        ProviderDriverKind::OpenaiCompatible => {
            onetv_core::providers::openai::list_models(agent.env.gateway(), &profile).await
        }
        ProviderDriverKind::StableDiffusion => {
            onetv_core::providers::sd::list_models(agent.env.gateway(), &profile).await
        }
        ProviderDriverKind::Comfyui => {
            onetv_core::providers::comfyui::list_models(agent.env.gateway(), &profile).await
        }
        _ => Err(onetv_core::providers::gateway::GatewayError::PolicyDenied(
            "该驱动不支持自动读取模型，请手工填写".into(),
        )),
    };
    match models {
        Ok(list) => Ok(serde_json::json!({ "ok": true, "models": list })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "models": [], "message": e.to_string() })),
    }
}

/// 表单内「自动获取模型」（v2.26.0）：Provider 未保存时也能按 Base URL(+Key) 直接拉取
/// /models 列表。临时 Key 写入固定钥匙串条目后走既有 list_models 路径，用后即删
/// （Key 短暂存在于钥匙串，绝不落盘/日志）；Base URL 主机按 provider_save 同样语义加入白名单。
#[tauri::command]
async fn provider_fetch_models(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    driver: String,
    base_url: String,
    api_key: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    use onetv_core::providers::ProviderDriverKind;
    const TMP_ID: &str = "provider-tmp-fetch";
    let kind = match driver.as_str() {
        "openai-compatible" => ProviderDriverKind::OpenaiCompatible,
        "ollama" => ProviderDriverKind::Ollama,
        "stable-diffusion" => ProviderDriverKind::StableDiffusion,
        "comfyui" => ProviderDriverKind::Comfyui,
        _ => return Err(err("该驱动不支持自动获取模型，请手工填写")),
    };
    let base = base_url.trim().to_string();
    if base.is_empty() {
        return Err(err("请先填写 Base URL"));
    }
    let has_key = api_key.as_deref().map(|k| !k.trim().is_empty()).unwrap_or(false);
    if has_key {
        onetv_security::SecretStore::set(TMP_ID, api_key.as_deref().unwrap().trim())
            .map_err(|e| err(format!("钥匙串写入失败: {e}")))?;
    }
    // 与 provider_save 一致：把主机加入出站白名单（用户显式输入的地址）
    state.settings.update(|s| {
        if !s.allowed_hosts.contains(&base) {
            s.allowed_hosts.push(base.clone());
        }
    });
    state.sync_policy();
    let profile = onetv_core::providers::ProviderProfile {
        id: TMP_ID.into(),
        name: "临时拉取模型".into(),
        driver: kind,
        base_url: base,
        auth: onetv_core::providers::ProviderAuth {
            auth_type: if has_key || kind == ProviderDriverKind::OpenaiCompatible { "bearer".into() } else { "none".into() },
            key_ref: None,
            header_name: None,
        },
        models: vec![],
        timeout_ms: 30_000,
        concurrency: 1,
        enabled: true,
        network_policy_id: String::new(),
        created_at: String::new(),
        http_template: None,
        workflow_template: None,
    };
    let models = match kind {
        ProviderDriverKind::Ollama => {
            onetv_core::providers::ollama::list_models(agent.env.gateway(), &profile).await
        }
        ProviderDriverKind::OpenaiCompatible => {
            onetv_core::providers::openai::list_models(agent.env.gateway(), &profile).await
        }
        ProviderDriverKind::StableDiffusion => {
            onetv_core::providers::sd::list_models(agent.env.gateway(), &profile).await
        }
        ProviderDriverKind::Comfyui => {
            onetv_core::providers::comfyui::list_models(agent.env.gateway(), &profile).await
        }
        _ => Err(onetv_core::providers::gateway::GatewayError::PolicyDenied(
            "该驱动不支持自动读取模型".into(),
        )),
    };
    if has_key {
        let _ = onetv_security::SecretStore::delete(TMP_ID);
    }
    match models {
        Ok(list) => Ok(serde_json::json!({ "ok": true, "models": list })),
        Err(e) => {
            let _ = onetv_security::SecretStore::delete(TMP_ID);
            Ok(serde_json::json!({ "ok": false, "models": [], "message": e.to_string() }))
        }
    }
}

/// API Playground（规格 §22.9）：单次测试调用，响应脱敏。
#[tauri::command]
async fn playground_test(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    provider_id: String,
    model: String,
    text: String,
) -> Result<serde_json::Value, CommandError> {
    let profile = agent
        .registry
        .read()
        .get(&provider_id)
        .ok_or_else(|| err("Provider 不存在"))?;
    state.audit.record(
        "playground.test",
        &provider_id,
        Some(serde_json::json!({"model": model, "note": "用户在 API Playground 手动测试"})),
    );
    let started = std::time::Instant::now();
    let result = match profile.driver {
        ProviderDriverKind::Mock => {
            let msgs = vec![onetv_core::providers::openai::ChatMessage::user(text)];
            onetv_core::providers::mock::chat(&(), &profile, &msgs)
                .await
                .map(|r| r.text)
                .map_err(|e| e.to_string())
        }
        ProviderDriverKind::Ollama => {
            let msgs = vec![onetv_core::providers::openai::ChatMessage::user(text)];
            onetv_core::providers::ollama::chat(agent.env.gateway(), &profile, &model, &msgs, false)
                .await
                .map(|r| r.text)
                .map_err(|e| e.to_string())
        }
        ProviderDriverKind::OpenaiCompatible => {
            let msgs = vec![onetv_core::providers::openai::ChatMessage::user(text)];
            onetv_core::providers::openai::chat(agent.env.gateway(), &profile, &model, &msgs, false, None, None)
                .await
                .map(|r| r.text)
                .map_err(|e| e.to_string())
        }
        _ => Err("该驱动不支持 Playground 文本测试".into()),
    };
    let latency = started.elapsed().as_millis() as u64;
    match result {
        Ok(text) => {
            let redacted = onetv_security::redact::redact_text(&text);
            Ok(serde_json::json!({ "ok": true, "latencyMs": latency, "response": redacted.chars().take(2000).collect::<String>() }))
        }
        Err(e) => Ok(serde_json::json!({ "ok": false, "latencyMs": latency, "response": onetv_security::redact::redact_text(&e) })),
    }
}

/* ---------------- 外观/主题皮肤 ---------------- */

#[tauri::command]
async fn theme_set_skin(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, CommandError> {
    let Some(path) = pick_path(&app, "选择皮肤图片（jpg/png）".into(), false).await else {
        return Err(err("已取消"));
    };
    let themes_dir = onetv_core::app_data_dir().join("themes");
    std::fs::create_dir_all(&themes_dir).map_err(err)?;
    // 源文件必须是非空可读图片，防止复制出 0 字节残留（themes/ 曾出现 skin.jpg 0 字节垃圾）
    let meta = std::fs::metadata(&path).map_err(err)?;
    if meta.len() == 0 {
        return Err(err("所选图片文件为空（0 字节），已取消应用"));
    }
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .filter(|e| e == "jpg" || e == "jpeg" || e == "png" || e == "webp")
        .unwrap_or_else(|| "jpg".into());
    let name = format!("skin.{}", ext);
    std::fs::copy(&path, themes_dir.join(&name)).map_err(err)?;
    let copied = std::fs::metadata(themes_dir.join(&name)).map_err(err)?.len();
    if copied == 0 {
        let _ = std::fs::remove_file(themes_dir.join(&name));
        return Err(err("皮肤复制失败（写入 0 字节），已回滚"));
    }
    state.settings.update(|s| s.skin = Some(name.clone()));
    Ok(serde_json::json!({ "ok": true, "skin": name }))
}

#[tauri::command]
fn theme_clear_skin(state: TState) -> AppSettings {
    state.settings.update(|s| s.skin = None)
}

/* ---------------- 邮件发送配置 + 验证码（v2.2） ---------------- */

fn mail_store() -> Vec<onetv_core::mail::MailConfig> {
    let path = onetv_core::app_data_dir().join("mail.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_mail_store(configs: &[onetv_core::mail::MailConfig]) -> Result<(), CommandError> {
    let path = onetv_core::app_data_dir().join("mail.json");
    std::fs::write(&path, serde_json::to_string_pretty(configs).map_err(err)?).map_err(err)
}

/// 钥匙串条目 ID 只允许字母数字和 -_，邮箱中的 @ . 等字符需编码后存储
fn mail_secret_id(email: &str) -> String {
    use base64::Engine as _;
    format!(
        "mail-{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(email.to_lowercase().as_bytes())
    )
}

fn mail_config_of(email: &str) -> Option<(onetv_core::mail::MailConfig, String)> {
    let configs = mail_store();
    let cfg = configs.iter().find(|c| c.email == email)?.clone();
    let secret = onetv_security::SecretStore::get(&mail_secret_id(email)).ok().flatten()?;
    Some((cfg, secret))
}

#[tauri::command]
async fn mail_config_save(
    state: tauri::State<'_, Arc<AppState>>,
    email: String,
    smtp_host: String,
    smtp_port: u16,
    use_tls: bool,
    auth_code: String,
) -> Result<serde_json::Value, CommandError> {
    let email = onetv_core::mail::validate_email(&email).map_err(err)?;
    let cfg = onetv_core::mail::MailConfig {
        email: email.clone(),
        smtp_host: smtp_host.trim().into(),
        smtp_port,
        use_tls,
    };
    let mut configs = mail_store();
    configs.retain(|c| c.email != email);
    configs.push(cfg.clone());
    save_mail_store(&configs)?;
    onetv_security::SecretStore::set(&mail_secret_id(&email), &auth_code).map_err(err)?;
    state.audit.record("mail.config_save", &email, None);
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
fn mail_config_get(email: String) -> serde_json::Value {
    let email = email.trim().to_lowercase();
    match mail_config_of(&email) {
        Some((cfg, _)) => serde_json::json!({
            "configured": true, "host": cfg.smtp_host, "port": cfg.smtp_port, "useTls": cfg.use_tls,
            "preset": onetv_core::mail::preset_for(&email),
        }),
        None => serde_json::json!({
            "configured": false,
            "preset": onetv_core::mail::preset_for(&email),
        }),
    }
}

#[tauri::command]
async fn mail_test_send(state: tauri::State<'_, Arc<AppState>>, email: String) -> Result<serde_json::Value, CommandError> {
    let email = onetv_core::mail::validate_email(&email).map_err(err)?;
    let Some((cfg, secret)) = mail_config_of(&email) else {
        return Err(err("尚未配置该邮箱的 SMTP 发送设置"));
    };
    let email_for_send = email.clone();
    let send = tokio::task::spawn_blocking(move || {
        onetv_core::mail::send_code_mail(&cfg, &secret, &email_for_send, "000000")
    })
    .await
    .map_err(|e| err(e.to_string()))?;
    match send {
        Ok(()) => {
            state.audit.record("mail.test_send", &email, None);
            Ok(serde_json::json!({ "ok": true, "message": "测试邮件已发送，请查收（含演示验证码 000000）" }))
        }
        Err(e) => Ok(serde_json::json!({ "ok": false, "message": e.to_string() })),
    }
}

/// 发送验证码。purpose: "change"（设置中修改账户）| "reset"（登录页忘记密码）
#[tauri::command]
async fn auth_send_code(
    state: tauri::State<'_, Arc<AppState>>,
    purpose: String,
    email: String,
    current_password: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    let email = onetv_core::mail::validate_email(&email).map_err(err)?;
    let info = state.auth.info().ok_or_else(|| err("账户未初始化"))?;
    if !matches!(purpose.as_str(), "change" | "reset") {
        return Err(err("非法用途"));
    }
    if purpose == "change" {
        // 设置中发码：需当前密码正确，且邮箱与绑定一致（或即将绑定）
        let Some(pw) = &current_password else {
            return Err(err("请先输入当前密码"));
        };
        let ok = state.auth.verify_login(&info.username, pw).map_err(err)?;
        if !ok {
            return Err(err("当前密码不正确"));
        }
    }
    let bound_ok = info.email.as_deref() == Some(email.as_str());
    if purpose == "reset" && !bound_ok {
        return Err(err("该邮箱与绑定邮箱不一致"));
    }
    if purpose == "change" && info.email.is_some() && !bound_ok {
        return Err(err("该邮箱与绑定邮箱不一致"));
    }
    if info.has_default_password && purpose == "reset" {
        return Err(err("你还未设置账号和密码，请按默认方式登录（admin / 12345）"));
    }

    let Some((cfg, secret)) = mail_config_of(&email) else {
        // 未配置 SMTP：明确告知（前端允许降级为仅地址校验，见各提交命令）
        return Ok(serde_json::json!({
            "sent": false,
            "reason": "尚未配置该邮箱的 SMTP 发送设置。请在「邮件发送设置」中填写服务商与授权码；未配置时修改/重置将退回为仅验证邮箱地址。",
        }));
    };
    let code = onetv_core::mail::generate_code();
    verify_store_named()
        .issue(&email, &purpose, &code)
        .map_err(err)?;
    let email_for_send = email.clone();
    let send = tokio::task::spawn_blocking(move || {
        onetv_core::mail::send_code_mail(&cfg, &secret, &email_for_send, &code)
    })
    .await
    .map_err(|e| err(e.to_string()))?;
    match send {
        Ok(()) => {
            state.audit.record("auth.code_sent", &email, Some(serde_json::json!({"purpose": purpose})));
            Ok(serde_json::json!({ "sent": true, "message": format!("验证码已发送至 {email}，5 分钟内有效") }))
        }
        Err(e) => {
            verify_store_named().revoke(&email, &purpose);
            Ok(serde_json::json!({ "sent": false, "reason": format!("发送失败：{e}。请检查 SMTP 设置（服务商授权码而非登录密码）") }))
        }
    }
}

/* ---------------- 本地账户（登录门） ---------------- */

#[tauri::command]
fn auth_status(state: TState) -> serde_json::Value {
    // 会话保持（v2.3）：5 天内活跃则免登录自动恢复
    let mut logged = state.logged_in.load(std::sync::atomic::Ordering::Relaxed);
    if !logged && state.auth.refresh_session() {
        state
            .logged_in
            .store(true, std::sync::atomic::Ordering::Relaxed);
        logged = true;
        tracing::info!("session restored (within 5-day window)");
    }
    let info = state.auth.info();
    serde_json::json!({
        "loggedIn": logged,
        "username": info.as_ref().map(|i| i.username.clone()),
        "email": info.as_ref().and_then(|i| i.email.clone()),
        "hasDefaultPassword": info.as_ref().map(|i| i.has_default_password).unwrap_or(false),
    })
}

#[tauri::command]
fn auth_login(state: TState, username: String, password: String) -> Result<serde_json::Value, CommandError> {
    let ok = state.auth.verify_login(&username, &password).map_err(err)?;
    if ok {
        state
            .logged_in
            .store(true, std::sync::atomic::Ordering::Relaxed);
        let _ = state.auth.create_session(&username);
        state.audit.record("auth.login", &username, None);
    }
    Ok(serde_json::json!({ "ok": ok }))
}

#[tauri::command]
fn auth_logout(state: TState) {
    state.auth.clear_session();
    state
        .logged_in
        .store(false, std::sync::atomic::Ordering::Relaxed);
    // 登出也要留痕：与 auth.login 对称，审计链路不留缺口
    state.audit.record("auth.logout", "", None);
}

#[tauri::command]
fn auth_change_credentials(
    state: TState,
    current_password: String,
    new_username: Option<String>,
    new_password: Option<String>,
    email: Option<String>,
    email_code: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    // v2.6：验证码验证暂时下线，邮箱仅做地址格式校验（auth.rs 内 normalize_email）。
    // SMTP 配置与 auth_send_code 保留，便于后续恢复。
    let _ = &email_code;
    let info = state
        .auth
        .change_credentials(
            &current_password,
            new_username.as_deref(),
            new_password.as_deref(),
            email.as_deref(),
        )
        .map_err(err)?;
    state.audit.record("auth.change_credentials", &info.username, None);
    Ok(serde_json::json!({
        "username": info.username,
        "email": info.email,
    }))
}

#[tauri::command]
fn auth_reset_with_email(
    state: TState,
    email: String,
    new_password: String,
    email_code: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    let e = email.trim().to_lowercase();
    let _ = e; // v2.6：验证码验证暂时下线，仅校验绑定邮箱是否一致（reset_with_email 内部完成）
    let _ = &email_code;
    state
        .auth
        .reset_with_email(&email, &new_password)
        .map_err(err)?;
    state.audit.record("auth.reset_with_email", "", None);
    Ok(serde_json::json!({ "ok": true }))
}

/* ---------------- Story Bible（v2.8.0） ---------------- */

fn bible_path(root: &std::path::Path) -> std::path::PathBuf {
    root.join("bible").join("story.json")
}

#[tauri::command]
fn bible_get(state: TState) -> Result<serde_json::Value, CommandError> {
    let (root, _) = open_ctx(&state)?;
    match std::fs::read_to_string(bible_path(&root)) {
        Ok(raw) => serde_json::from_str(&raw).map_err(err),
        Err(_) => Ok(serde_json::json!({
            "story": { "title": "", "genre": "", "era": "", "location": "", "theme": "",
                       "targetDurationSec": 120, "targetPlatform": "抖音",
                       "aspectRatio": "9:16", "visualStyle": "" },
            "characters": [], "locations": [], "props": [], "continuity": []
        })),
    }
}

#[tauri::command]
fn bible_save(state: TState, doc: serde_json::Value) -> Result<(), CommandError> {
    let (root, _) = open_ctx(&state)?;
    let path = bible_path(&root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    // 原子写：临时文件 + rename，防崩溃产生半截 JSON
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, &path).map_err(err)?;
    state.audit.record("bible.save", "", None);
    Ok(())
}

/// AI 生成 Story Bible：单次 LLM 调用（chat 能力），产出结构化 JSON 并落盘。
#[tauri::command]
async fn bible_generate(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    brief: String,
) -> Result<serde_json::Value, CommandError> {
    let (root, manifest) = open_ctx(&state)?;
    let title = manifest.project.title.clone();
    if brief.trim().is_empty() {
        return Err(err("请先填写一句话需求（这部剧讲什么）"));
    }
    let system = "你是短剧编剧总监。根据用户的一句话需求，为这部剧输出完整的 Story Bible（故事圣经）JSON。\
只输出 JSON，不要任何解释文字或代码围栏。JSON 结构：\
{\"story\":{\"title\",\"genre\",\"era\",\"location\",\"theme\",\"visualStyle\"},\
\"characters\":[{\"name\",\"desc\",\"appearance\"}],\"locations\":[{\"name\",\"desc\"}],\
\"props\":[{\"name\",\"desc\"}],\"continuity\":[\"连续性规则字符串\"]}。\
要求：3-6 个角色（appearance 写可生成参考图的外形描述）；2-5 个主要场景；\
visualStyle 是给文生图用的英文风格描述（30-60 词，含镜头/光影/色调）；continuity 3-6 条。全部中文（visualStyle 除外）。";
    let messages = vec![
        onetv_core::providers::openai::ChatMessage::system(system),
        onetv_core::providers::openai::ChatMessage::user(format!("剧名：{title}
一句话需求：{}", brief.trim())),
    ];
    let (raw, provider_id, model) = onetv_core::agent::handlers::llm_chat(
        &agent.env,
        &messages,
        true,
        None,
        None,
        None,
    )
    .await
    .map_err(|e| err(e.message))?;
    // 容错解析：剥代码围栏，取首个 { 到末个 }
    let trimmed = raw.trim();
    let json_str = match (trimmed.find('{'), trimmed.rfind('}')) {
        (Some(a), Some(b)) if b > a => &trimmed[a..=b],
        _ => trimmed,
    };
    let mut doc: serde_json::Value = serde_json::from_str(json_str)
        .map_err(|e| err(format!("AI 返回的不是合法 JSON：{e}")))?;
    // 补齐结构 + 保留画幅/时长等既有设置（AI 不产出这些字段）
    let obj = doc.as_object_mut().ok_or_else(|| err("AI 返回的 JSON 不是对象"))?;
    for (k, v) in [
        ("characters", serde_json::json!([])),
        ("locations", serde_json::json!([])),
        ("props", serde_json::json!([])),
        ("continuity", serde_json::json!([])),
    ] {
        obj.entry(k).or_insert(v);
    }
    let story = obj.entry("story").or_insert_with(|| serde_json::json!({}));
    if let Some(story_obj) = story.as_object_mut() {
        story_obj
            .entry("title".to_string())
            .or_insert(serde_json::json!(title));
        for (k, v) in [
            ("targetDurationSec", serde_json::json!(120)),
            ("targetPlatform", serde_json::json!("抖音")),
            ("aspectRatio", serde_json::json!("9:16")),
        ] {
            story_obj.entry(k.to_string()).or_insert(v);
        }
    }
    let path = bible_path(&root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&doc).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, &path).map_err(err)?;
    state.audit.record(
        "bible.generate",
        &format!("provider={provider_id} model={model}"),
        None,
    );
    Ok(doc)
}

/* ---------------- 项目费用计数（v2.11.1） ---------------- */

/// 当前项目远程生成用量（预算守卫卡片看板数据）
#[tauri::command]
fn costs_get(state: TState) -> Result<serde_json::Value, CommandError> {
    let (root, _) = open_ctx(&state)?;
    let raw = std::fs::read_to_string(root.join("costs.json")).unwrap_or_default();
    let costs: serde_json::Value = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
    let today_key = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let total = costs.get("totalCalls").and_then(|v| v.as_u64()).unwrap_or(0);
    let today = costs
        .get("daily")
        .and_then(|d| d.get(&today_key))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let total_cost = costs.get("totalCost").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let today_cost = costs
        .get("dailyCost")
        .and_then(|d| d.get(&today_key))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);
    Ok(serde_json::json!({ "today": today, "total": total, "totalCost": total_cost, "todayCost": today_cost, "date": today_key }))
}

/* ---------------- 画布重建（v2.13，规格 §13 Recreate Planner 最小版） ---------------- */

/// 从视频理解结果（understanding.json 的 shots）重建画布：
/// 每个镜头生成一个文本节点（含时长/复刻提示），旧画布自动备份。
#[tauri::command]
fn recreate_canvas(state: TState, episode_id: String) -> Result<serde_json::Value, CommandError> {
    let (root, _) = open_ctx(&state)?;
    let ep_dir = root.join("episodes").join(&episode_id);
    let upath = ep_dir.join("understanding.json");
    let raw = std::fs::read_to_string(&upath)
        .map_err(|_| err("该分集尚无视频理解结果：请先在资产页对视频执行「视频理解」"))?;
    let doc: serde_json::Value = serde_json::from_str(&raw).map_err(err)?;
    let shots = doc
        .get("shots")
        .and_then(|v| v.as_array())
        .ok_or_else(|| err("understanding.json 缺少 shots"))?;
    if shots.is_empty() {
        return Err(err("视频理解结果为空"));
    }
    let mut nodes = Vec::new();
    for (i, shot) in shots.iter().enumerate() {
        let dur = shot
            .get("end")
            .and_then(|v| v.as_f64())
            .zip(shot.get("start").and_then(|v| v.as_f64()))
            .map(|(e, st)| e - st)
            .unwrap_or(0.0);
        let text = format!(
            "镜头 {}（{:.1}s，{}）\n{}",
            i + 1,
            dur,
            shot.get("shotSize").and_then(|v| v.as_str()).unwrap_or(""),
            shot.get("recreationPrompt").and_then(|v| v.as_str()).unwrap_or("")
        );
        nodes.push(serde_json::json!({
            "id": format!("shot-{}", i + 1),
            "type": "text",
            "title": format!("镜头 {}", i + 1),
            "position": { "x": 80 + (i % 4) * 280, "y": 80 + (i / 4) * 240 },
            "config": { "text": text, "status": "ready" }
        }));
    }
    let canvas = serde_json::json!({
        "schemaVersion": "1.0",
        "episodeId": episode_id,
        "nodes": nodes,
        "edges": [],
        "updatedAt": chrono::Utc::now().to_rfc3339()
    });
    let cpath = ep_dir.join("canvas.json");
    if cpath.exists() {
        let bak = ep_dir.join(format!("canvas.bak-{}.json", chrono::Utc::now().timestamp()));
        std::fs::rename(&cpath, &bak).map_err(err)?;
    }
    let tmp = cpath.with_extension(format!("json.tmp-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
    std::fs::write(&tmp, serde_json::to_string_pretty(&canvas).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, &cpath).map_err(err)?;
    state.audit.record("canvas.recreate", &episode_id, None);
    Ok(serde_json::json!({ "ok": true, "created": nodes.len() }))
}

/* ---------------- 生成平台预设（v2.6.4） ---------------- */

/// 内置图片/视频平台预设（Nano Banana/Seedream/FLUX/MJ-proxy；海螺 H3/可灵/即梦/万相/Pika/Runway）：
/// 前端「新增 Provider」一键填充 Custom HTTP 模板，用户只填 API Key。
#[tauri::command]
fn provider_preset_list() -> Vec<serde_json::Value> {
    onetv_core::providers::presets::gen_presets_json()
}

/* ---------------- Skills ---------------- */

#[tauri::command]
fn skill_list(state: TState) -> Vec<serde_json::Value> {
    state
        .skills
        .list()
        .iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id, "name": s.name, "version": s.version,
                "description": s.description, "trustLevel": s.trust_level,
                "permissions": {"network": s.permissions.network, "filesystem": s.permissions.filesystem},
                "source": s.source, "entry": s.entry
            })
        })
        .collect()
}

#[tauri::command]
async fn skill_install(state: tauri::State<'_, Arc<AppState>>, app: tauri::AppHandle) -> Result<serde_json::Value, CommandError> {
    let Some(dir) = pick_path(&app, "选择包含 skill.json 的 Skill 文件夹".into(), true).await else {
        return Err(err("已取消"));
    };
    let info = state.skills.install_from(&dir).map_err(err)?;
    state.audit.record("skill.install", &info.id, None);
    Ok(serde_json::json!({
        "ok": true, "message": format!("已安装 {} v{}（信任等级 L{}）", info.name, info.version, info.trust_level),
        "skill": info
    }))
}

#[tauri::command]
fn skill_uninstall(state: TState, id: String) -> Result<(), CommandError> {
    state.skills.uninstall(&id).map_err(err)?;
    state.audit.record("skill.uninstall", &id, None);
    Ok(())
}

/// 从 Git 仓库安装 Skill（v2.13）：clone --depth 1（可指定 tag/branch）后走同一校验安装链路。
#[tauri::command]
async fn skill_install_git(
    state: tauri::State<'_, Arc<AppState>>,
    url: String,
    tag: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    let url = url.trim().to_string();
    if !url.starts_with("https://") && !url.starts_with("http://") && !url.starts_with("git@") {
        return Err(err("URL 必须以 https:// / http:// / git@ 开头"));
    }
    // git 可用性
    let git_ok = tokio::task::spawn_blocking(|| std::process::Command::new("git").arg("--version").output())
        .await
        .map_err(|e| err(e.to_string()))?
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !git_ok {
        return Err(err("未检测到 git 命令行工具（请先安装 Xcode Command Line Tools 或 git）"));
    }
    let tmp = std::env::temp_dir().join(format!("onetv-skill-{}", uuid::Uuid::new_v4().simple()));
    let url2 = url.clone();
    let tag2 = tag.clone();
    let tmp2 = tmp.clone();
    let clone = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("git");
        cmd.args(["clone", "--depth", "1"]);
        if let Some(t) = &tag2 {
            cmd.args(["--branch", t]);
        }
        cmd.arg(&url2).arg(&tmp2).output()
    })
    .await
    .map_err(|e| err(e.to_string()))?;
    match clone {
        Ok(o) if o.status.success() => {}
        Ok(o) => {
            let _ = std::fs::remove_dir_all(&tmp);
            let msg = String::from_utf8_lossy(&o.stderr).chars().take(300).collect::<String>();
            return Err(err(format!("git clone 失败: {msg}")));
        }
        Err(e) => {
            let _ = std::fs::remove_dir_all(&tmp);
            return Err(err(e.to_string()));
        }
    }
    let info = state.skills.install_from(&tmp).map_err(|e| {
        let _ = std::fs::remove_dir_all(&tmp);
        err(e)
    })?;
    let _ = std::fs::remove_dir_all(&tmp);
    state.audit.record("skill.install_git", &format!("{url} (tag={})", tag.unwrap_or_default()), None);
    Ok(serde_json::json!({
        "ok": true,
        "message": format!("已从 Git 安装 {} v{}（信任等级 L{}）", info.name, info.version, info.trust_level),
        "skill": info,
    }))
}

/* ---------------- Provider 配置导入导出（v2.13，API-11） ---------------- */

/// 导出全部 Provider 配置（不含密钥——密钥只在钥匙串，导入后需重新填写）
#[tauri::command]
async fn provider_export(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, CommandError> {
    let Some(dest) = save_path(&app, "导出 Provider 配置".into(), "onetv-providers.json".into()).await else {
        return Err(err("已取消"));
    };
    let profiles = agent.registry.read().list().clone();
    let payload = serde_json::json!({
        "kind": "onetv-providers",
        "version": 1,
        "exportedAt": chrono::Utc::now().to_rfc3339(),
        "providers": profiles,
    });
    let tmp = dest.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&payload).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, &dest).map_err(err)?;
    state.audit.record("provider.export", &profiles.len().to_string(), None);
    Ok(serde_json::json!({ "ok": true, "path": dest.to_string_lossy(), "count": profiles.len() }))
}

/// 导入 Provider 配置（不含密钥；导入后需在「模型」页重新填写 API Key）
#[tauri::command]
async fn provider_import(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, CommandError> {
    let Some(path) = pick_path(&app, "选择 onetv-providers.json".into(), false).await else {
        return Err(err("已取消"));
    };
    let raw = tokio::task::spawn_blocking(move || std::fs::read_to_string(path))
        .await
        .map_err(|e| err(e.to_string()))?
        .map_err(err)?;
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| err(format!("不是合法 JSON: {e}")))?;
    let list = v
        .get("providers")
        .and_then(|p| p.as_array())
        .ok_or_else(|| err("文件缺少 providers 数组（确认是 OneTV 导出的配置文件）"))?;
    let mut imported = 0usize;
    for pv in list {
        let mut p = profile_from_json(pv.clone())?;
        if p.id.is_empty() {
            p.id = format!("provider-{}", uuid::Uuid::new_v4().simple());
        }
        validate_driver_capabilities(&p)?;
        // 导入的 Provider 密钥必然不在本机——标记未配置，前端展示「未配置 Key」
        p.auth.key_ref = None;
        agent.registry.write().upsert(p);
    if let Some(agent) = AGENT.get() {
        agent.jobs.set_pricing(pricing_map(&agent.registry.read()));
    }
        imported += 1;
    }
    state.audit.record("provider.import", &imported.to_string(), None);
    Ok(serde_json::json!({ "ok": true, "imported": imported }))
}

/* ---------------- 视频理解 ---------------- */

#[tauri::command]
fn video_understand(
    state: TState,
    agent: tauri::State<'_, Arc<AgentState>>,
    asset_id: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    let (root, manifest) = open_ctx(&state)?;
    let episode = manifest.episodes.first().map(|e| e.id.clone());
    let job = agent.jobs.create_job(
        onetv_core::jobs::JobKind::VideoUnderstand,
        "视频理解与复刻",
        None,
        None,
        serde_json::json!({ "assetId": asset_id }),
        None,
        episode,
        false,
        None,
    );
    let _ = root;
    Ok(serde_json::json!({ "ok": true, "jobId": job.id }))
}

/* ---------------- 工程包导入导出 ---------------- */

#[tauri::command]
async fn project_export_pkg(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    passphrase: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    let (root, manifest) = open_ctx(&state)?;
    let default_name = format!("{}.ytv.zip", manifest.project.title);
    let Some(dest) = save_path(&app, "导出工程包".into(), default_name).await else {
        return Err(err("已取消"));
    };
    // 空串视同 None（= 明文导出）；加解密为重 CPU/IO：放阻塞线程池（v2.20）
    let passphrase = passphrase.filter(|p| !p.trim().is_empty());
    let encrypted = passphrase.is_some();
    let path = tokio::task::spawn_blocking(move || {
        onetv_core::pkg::export_project(&root, &dest, passphrase.as_deref())
    })
    .await
    .map_err(|e| err(e.to_string()))?
    .map_err(err)?;
    state.audit.record("project.export_pkg", &path.to_string_lossy(), None);
    Ok(serde_json::json!({ "ok": true, "path": path.to_string_lossy(), "encrypted": encrypted }))
}

#[tauri::command]
async fn project_import_pkg(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    passphrase: Option<String>,
    zip_path: Option<String>,
    parent_path: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    // 重试场景：前端已拿到 zipPath/parentPath（needsPassphrase 返回），跳过文件选择框
    let zip_path = match zip_path.filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => pick_path(&app, "选择 .ytv.zip 工程包".into(), false)
            .await
            .ok_or_else(|| err("已取消"))?,
    };
    let parent = match parent_path.filter(|p| !p.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => pick_path(&app, "选择导入位置".into(), true)
            .await
            .ok_or_else(|| err("已取消"))?,
    };
    let passphrase = passphrase.filter(|p| !p.trim().is_empty());
    // zip 解压/解密为重 IO：放阻塞线程池（v2.12.0；v2.20 增加密包解密）
    let zip2 = zip_path.clone();
    let parent2 = parent.clone();
    let imported =
        tokio::task::spawn_blocking(move || onetv_core::pkg::import_project(&zip2, &parent2, passphrase.as_deref()))
            .await
            .map_err(|e| err(e.to_string()))?;
    let path = match imported {
        Ok(p) => p,
        // 结构化返回：前端据此弹密码框并携带 zipPath/parentPath + 密码重试
        Err(onetv_core::pkg::PkgError::PassphraseRequired) => {
            return Ok(serde_json::json!({
                "needsPassphrase": true,
                "zipPath": zip_path.to_string_lossy(),
                "parentPath": parent.to_string_lossy(),
            }));
        }
        Err(e) => return Err(err(e)),
    };
    state.audit.record("project.import_pkg", &path.to_string_lossy(), None);
    // 自动打开导入的工程
    let (handle, manifest) = ops::open_project(&path).map_err(err)?;
    if let Some(agent) = AGENT.get() {
        agent.jobs.set_project_root(Some(path.clone()));
        agent.jobs.resume_on_restart();
    }
    {
        let mut p = state.project.write();
        p.handle = Some(handle);
        p.manifest = Some(manifest.clone());
    }
    Ok(serde_json::json!({ "ok": true, "path": path.to_string_lossy(), "title": manifest.project.title }))
}

/* ---------------- 调试/测试钩子（时间边界 SESSION-005~008 解除阻塞） ---------------- */

/// 测试时钟偏移（秒）。前端入口：设置 → 关于 OneTV → 连点版本号 5 次；
/// 自动化入口：环境变量 ONETV_TEST_TIME_OFFSET_SEC（仅启动时读取）。
#[tauri::command]
fn debug_set_time_offset(seconds: i64) -> Result<serde_json::Value, CommandError> {
    // v2.12.0：仅开发构建可用——否则可把会话时钟拨到永不过期
    if !cfg!(debug_assertions) {
        return Err(err("测试时钟钩子仅在开发构建中可用"));
    }
    onetv_core::auth::set_time_offset(seconds);
    Ok(serde_json::json!({ "ok": true, "offsetSecs": seconds }))
}

#[tauri::command]
fn debug_session_status(state: TState) -> serde_json::Value {
    serde_json::json!({
        "offsetSecs": onetv_core::auth::time_offset(),
        "remainingSecs": state.auth.session_remaining_secs(),
    })
}

/* ---------------- Agent 附件（全格式上传） ---------------- */

fn classify_asset_kind(ext: &str) -> &'static str {
    match ext {
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "bmp" => "images",
        "mp4" | "mov" | "webm" | "m4v" | "avi" | "mkv" => "videos",
        "mp3" | "wav" | "m4a" | "aac" | "flac" | "ogg" => "audio",
        _ => "references",
    }
}

fn is_text_like(ext: &str) -> bool {
    matches!(
        ext,
        "txt" | "md" | "markdown" | "json" | "csv" | "log" | "srt" | "vtt" | "html" | "xml" | "yml" | "yaml" | "toml"
    )
}

const ATTACH_TEXT_PREVIEW_CHARS: usize = 4000;

/// Agent 对话附件：任意格式文件导入项目资产库；文本类附带回传内容预览
/// 供 LLM 上下文使用；二进制（doc/pdf/xlsx 等）只入库并在对话中说明。
#[tauri::command]
async fn agent_attach(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, CommandError> {
    let Some(path) = pick_path(&app, "选择要发送的附件（图片/视频/音频/文本/文档）".into(), false).await else {
        return Err(err("已取消"));
    };
    agent_attach_import(&state, &path)
}

/// 拖拽/粘贴路径版附件导入（Codex 式输入框：文件拖入或 ⌘V 粘贴）。
/// 导入含 SHA-256 全量哈希 + 复制（上限 50MB），放阻塞线程池避免卡主线程。
#[tauri::command]
async fn agent_attach_path(state: tauri::State<'_, Arc<AppState>>, path: String) -> Result<serde_json::Value, CommandError> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(err(format!("文件不存在: {path}")));
    }
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || agent_attach_import(&st, &p))
        .await
        .map_err(|e| err(e.to_string()))?
}

fn agent_attach_import(state: &Arc<AppState>, path: &std::path::Path) -> Result<serde_json::Value, CommandError> {
    let (root, _) = open_ctx(state)?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let kind = classify_asset_kind(&ext);
    let rec = onetv_project::ops::import_asset(&root, path, &kind).map_err(err)?;
    state.audit.record("asset.import", &rec.id, None);

    let text_preview = if is_text_like(&ext) {
        std::fs::read_to_string(path)
            .ok()
            .map(|s| s.chars().take(ATTACH_TEXT_PREVIEW_CHARS).collect::<String>())
    } else {
        None
    };
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    state.audit.record("agent.attach", &name, None);
    Ok(serde_json::json!({
        "assetId": rec.id,
        "name": name,
        "kind": kind,
        "mime": rec.mime,
        "sizeBytes": rec.size_bytes,
        "path": rec.path,
        "textPreview": text_preview,
    }))
}

/// 粘贴板附件导入：前端读不到粘贴文件的磁盘路径（WKWebView 限制），
/// 由前端读出内容（base64）传此命令落盘后走统一导入。上限 50MB。
#[tauri::command]
async fn agent_attach_data(
    state: tauri::State<'_, Arc<AppState>>,
    name: String,
    data_b64: String,
) -> Result<serde_json::Value, CommandError> {
    let st = state.inner().clone();
    tokio::task::spawn_blocking(move || {
        use base64::Engine as _;
        let name = name.trim();
        if name.is_empty() {
            return Err(err("附件名为空"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data_b64.as_bytes())
            .map_err(|e| err(format!("附件数据解码失败: {e}")))?;
        if bytes.len() > 50 * 1024 * 1024 {
            return Err(err("粘贴的附件超过 50MB 上限"));
        }
        let tmp_dir = std::env::temp_dir().join(format!("onetv-paste-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&tmp_dir).map_err(err)?;
        let safe_name: String = name
            .chars()
            .map(|c| if c == '/' || c == ':' { '_' } else { c })
            .collect();
        let tmp_path = tmp_dir.join(&safe_name);
        std::fs::write(&tmp_path, &bytes).map_err(err)?;
        let result = agent_attach_import(&st, &tmp_path);
        let _ = std::fs::remove_dir_all(&tmp_dir); // 导入即复制进工程，临时文件即删
        result
    })
    .await
    .map_err(|e| err(e.to_string()))?
}

/// 用系统默认应用打开文件（附件"打开/编辑"）。
#[tauri::command]
fn asset_open(app: tauri::AppHandle, path: String) -> Result<(), CommandError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().open_path(path, None::<&str>).map_err(err)
}

/// 在 Finder 中显示文件。
#[tauri::command]
fn asset_reveal(app: tauri::AppHandle, path: String) -> Result<(), CommandError> {
    use tauri_plugin_opener::OpenerExt;
    app.opener().reveal_item_in_dir(path).map_err(err)
}

/* ---------------- 画布节点生成（v2.5：LibTV 式节点聊天框） ---------------- */

/// 从画布 JSON 中读取指定节点（用于节点生成面板）。
fn read_canvas_node(
    root: &std::path::Path,
    episode_id: &str,
    node_id: &str,
) -> Result<serde_json::Value, CommandError> {
    let path = root.join("episodes").join(episode_id).join("canvas.json");
    let raw = std::fs::read_to_string(&path).map_err(err)?;
    let doc: serde_json::Value = serde_json::from_str(&raw).map_err(err)?;
    doc.get("nodes")
        .and_then(|n| n.as_array())
        .and_then(|arr| arr.iter().find(|n| n.get("id").and_then(|v| v.as_str()) == Some(node_id)))
        .cloned()
        .ok_or_else(|| err(format!("画布节点不存在: {node_id}")))
}

/// 节点生成面板直发：按节点类型创建对应生成任务（模型/画幅/提示词由面板传入），
/// 返回 jobId；前端轮询任务状态，成功后把 outputAssetId 回写到节点 config。
#[tauri::command]
fn canvas_node_run(
    state: TState,
    agent: tauri::State<'_, Arc<AgentState>>,
    episode_id: String,
    node_id: String,
    prompt: String,
    aspect: Option<String>,
    provider_id: Option<String>,
    model_id: Option<String>,
    reference_asset_ids: Option<Vec<String>>,
) -> Result<serde_json::Value, CommandError> {
    let (root, _) = open_ctx(&state)?;
    let node = read_canvas_node(&root, &episode_id, &node_id)?;
    if node.pointer("/config/disabled").and_then(|v| v.as_bool()) == Some(true) {
        return Err(err("节点已禁用：请在检查器中取消「禁用」后再运行"));
    }
    let node_type = node.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let title = node
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or(&node_id)
        .to_string();
    let prompt = prompt.trim().to_string();
    if prompt.is_empty() {
        return Err(err("提示词不能为空"));
    }
    let aspect = aspect.unwrap_or_else(|| "9:16".into());
    let provider_id = provider_id.filter(|s| !s.is_empty());
    let model_id = model_id.filter(|s| !s.is_empty());

    let (kind, params, title_full) = match node_type.as_str() {
        "image" => (
            onetv_core::jobs::JobKind::ImageGeneration,
            serde_json::json!({
                "prompt": prompt, "aspect": aspect,
                "providerId": provider_id, "model": model_id,
                "referenceAssetIds": reference_asset_ids.unwrap_or_default(),
                "nodeId": node_id,
            }),
            format!("生图（节点 {title}）"),
        ),
        "video" | "video-clip" => (
            onetv_core::jobs::JobKind::VideoGeneration,
            serde_json::json!({
                "prompt": prompt, "aspect": aspect,
                "providerId": provider_id, "model": model_id,
                "referenceAssetIds": reference_asset_ids.unwrap_or_default(),
                "nodeId": node_id,
            }),
            format!("生视频（节点 {title}）"),
        ),
        "audio" => (
            onetv_core::jobs::JobKind::Tts,
            serde_json::json!({
                "text": prompt,
                "providerId": provider_id, "model": model_id,
                "nodeId": node_id,
            }),
            format!("配音（节点 {title}）"),
        ),
        // 文本节点：面板直发文本生成（Chat 任务，quiet 不占用 Agent 对话流；回复由面板回填节点 text）
        "text" => (
            onetv_core::jobs::JobKind::Chat,
            serde_json::json!({
                "text": prompt,
                "providerId": provider_id, "model": model_id,
                "nodeId": node_id,
                "quiet": true,
            }),
            format!("文本生成（节点 {title}）"),
        ),
        "script" | "storyboard" | "asset" | "condition" | "review" | "export" => {
            return Err(err(format!(
                "节点类型「{node_type}」暂不支持面板直发生成；文本/图片/视频/音频节点可直接生成"
            )));
        }
        other => return Err(err(format!("未知节点类型: {other}"))),
    };
    let egress = Some(serde_json::json!({
        "destination": "Model Provider（由模型选择/生成模型设置决定）",
        "data": "节点提示词与参考素材",
        "via": "canvas-node-panel",
    }));
    let job = agent.jobs.create_job(
        kind,
        title_full,
        None,
        None,
        params,
        Some(node_id.clone()),
        Some(episode_id.clone()),
        false,
        egress,
    );
    state.audit.record("canvas.node_run", &format!("{node_id} → {}", job.id), None);
    Ok(serde_json::json!({ "jobId": job.id, "state": job.state.as_str() }))
}

/* ---------------- Webhook 入向（v2.15，规格 §22.5 最小版） ---------------- */

/// Webhook 监听：本机回环 HTTP（默认关闭；端口/token 独立于 Hermes）。
/// POST /webhook?token=… body {"event": "...", "data": {...}} → 转发为 app 事件
/// "webhook.received"（前端/技能可订阅），并写审计。动作执行走白名单：
/// create_image / agent_chat（复用 hermes_invoke 白名单语义）。
#[tauri::command]
async fn webhook_listen_start(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    port: u16,
    token: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    if WEBHOOK_STOP.lock().unwrap().is_some() {
        return Ok(serde_json::json!({ "ok": true, "already": true }));
    }
    let (tx, rx) = tokio::sync::watch::channel(false);
    *WEBHOOK_STOP.lock().unwrap() = Some(tx);
    let env = agent.env.clone();
    let jobs = agent.jobs.clone();
    let state2 = state.inner().clone();
    let token = token.filter(|t| !t.trim().is_empty());
    tauri::async_runtime::handle().spawn(async move {
        webhook_listen_loop(port, token, rx, state2, env, jobs).await;
    });
    tracing::info!(port, "webhook listener starting");
    state.audit.record("webhook.listen_start", &port.to_string(), None);
    Ok(serde_json::json!({ "ok": true, "port": port }))
}

#[tauri::command]
fn webhook_listen_stop(state: TState) -> Result<(), CommandError> {
    if let Some(tx) = WEBHOOK_STOP.lock().unwrap().take() {
        let _ = tx.send(true);
    }
    state.audit.record("webhook.listen_stop", "", None);
    Ok(())
}

static WEBHOOK_STOP: std::sync::Mutex<Option<tokio::sync::watch::Sender<bool>>> = std::sync::Mutex::new(None);

async fn webhook_listen_loop(
    port: u16,
    token: Option<String>,
    mut stop: tokio::sync::watch::Receiver<bool>,
    state: Arc<AppState>,
    env: Arc<onetv_core::agent::AgentEnv>,
    jobs: Arc<onetv_core::jobs::JobManager>,
) {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(port, error = %e, "webhook listener bind failed");
            env.events("webhook.error", serde_json::json!({ "error": format!("Webhook 监听 {port} 失败: {e}") }));
            return;
        }
    };
    tracing::info!(port, "webhook listener ready");
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            acc = listener.accept() => {
                let Ok((stream, _)) = acc else { continue };
                let token = token.clone();
                let state = state.clone();
                let env = env.clone();
                let jobs = jobs.clone();
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(20),
                        webhook_handle_conn(stream, token, state, env, jobs),
                    ).await;
                });
            }
        }
    }
    tracing::info!("webhook listener stopped");
}

async fn webhook_handle_conn(
    mut stream: tokio::net::TcpStream,
    token: Option<String>,
    state: Arc<AppState>,
    env: Arc<onetv_core::agent::AgentEnv>,
    jobs: Arc<onetv_core::jobs::JobManager>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = vec![0u8; 262_144];
    let n = match stream.read(&mut buf).await {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let raw = String::from_utf8_lossy(&buf[..n]).into_owned();
    let request_line = raw.lines().next().unwrap_or_default().to_string();
    let url = request_line.split_whitespace().nth(1).unwrap_or_default().to_string();
    // query token 校验（?token=…）；未配置 token 时拒绝（与 Hermes 同策略）
    let query = url.split_once('?').map(|(_, q)| q).unwrap_or_default();
    let got_token = query
        .split('&')
        .find_map(|kv| kv.strip_prefix("token="))
        .unwrap_or_default()
        .to_string();
    let body = raw.split_once("\r\n\r\n").map(|(_, b)| b.to_string()).unwrap_or_default();

    let (status, resp_json) = match (request_line.split_whitespace().next().unwrap_or(""), url.split('?').next().unwrap_or("")) {
        ("POST", "/webhook") => match (&token, ) {
            _ if token.is_none() => (403, serde_json::json!({ "error": "Webhook 未设置 token，已拒绝。请在启动监听时提供 token" })),
            _ if got_token != token.clone().unwrap_or_default() => (401, serde_json::json!({ "error": "token 不匹配" })),
            _ => webhook_dispatch(&state, &env, &jobs, &body).await,
        },
        _ => (404, serde_json::json!({ "error": "未知端点，可用：POST /webhook?token=…" })),
    };
    let payload = serde_json::to_string(&resp_json).unwrap_or_default();
    let resp = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        if status == 200 { "OK" } else if status == 401 || status == 403 { "Denied" } else { "Bad Request" },
        payload.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
    env.events("webhook.received", serde_json::json!({ "status": status, "response": resp_json }));
}

async fn webhook_dispatch(
    state: &Arc<AppState>,
    env: &Arc<onetv_core::agent::AgentEnv>,
    jobs: &Arc<onetv_core::jobs::JobManager>,
    body: &str,
) -> (u16, serde_json::Value) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return (400, serde_json::json!({ "error": "请求体必须是 JSON：{event, data}" }));
    };
    let event = v.get("event").and_then(|x| x.as_str()).unwrap_or_default().to_string();
    let data = v.get("data").cloned().unwrap_or(serde_json::json!({}));
    if event.is_empty() {
        return (400, serde_json::json!({ "error": "缺少 event 字段" }));
    }
    state.audit.record("webhook.event", &event, Some(data.clone()));
    // 白名单动作：create_image → 直接建生图任务；其余事件转发给前端/技能
    match event.as_str() {
        "create_image" => {
            let prompt = data.get("prompt").and_then(|x| x.as_str()).unwrap_or_default().to_string();
            if prompt.is_empty() {
                return (400, serde_json::json!({ "error": "create_image 需要 data.prompt" }));
            }
            let job = jobs.create_job(
                onetv_core::jobs::JobKind::ImageGeneration,
                format!("Webhook 生图：{}", prompt.chars().take(20).collect::<String>()),
                None,
                None,
                serde_json::json!({ "prompt": prompt }),
                None,
                None,
                false,
                Some(serde_json::json!({ "destination": "Model Provider", "data": "webhook 提示词", "via": "webhook" })),
            );
            (200, serde_json::json!({ "ok": true, "jobId": job.id }))
        }
        other => {
            env.events("webhook.event", serde_json::json!({ "event": other, "data": data }));
            (200, serde_json::json!({ "ok": true, "forwarded": other }))
        }
    }
}

/* ---------------- Plugin SDK（v2.15 框架版 → 最小完整版：prompt-pack 提示词包） ---------------- */

/// 插件 = 提示词包（plugin.json，契约与 Skill 对齐）。
/// 只做清单解析/校验/模板渲染 —— 不加载任意代码、不做网络请求（安全边界与 Skill 一致）。
#[tauri::command]
async fn plugin_list(_state: TState<'_>) -> Result<Vec<serde_json::Value>, CommandError> {
    let dir = onetv_core::app_data_dir().join("plugins");
    // 目录扫描是文件 IO 重活：spawn_blocking（构造 Hub 时顺带确保目录存在，供「打开插件目录」）
    let items = tokio::task::spawn_blocking(move || onetv_core::plugins::PluginHub::new(&dir).list())
        .await
        .map_err(err)?;
    Ok(items
        .iter()
        .map(|it| serde_json::to_value(it).unwrap_or_else(|_| serde_json::json!({ "dir": it.dir, "valid": false })))
        .collect())
}

/// 读取单个插件完整清单（含 prompts）。pluginId 非法/清单非法/不存在均返回结构化错误。
#[tauri::command]
fn plugin_get(_state: TState, plugin_id: String) -> Result<serde_json::Value, CommandError> {
    let dir = onetv_core::app_data_dir().join("plugins");
    let hub = onetv_core::plugins::PluginHub::new(&dir);
    let m = hub.get(&plugin_id).map_err(err)?;
    Ok(serde_json::json!({
        "id": m.id, "name": m.name, "version": m.version,
        "description": m.description, "author": m.author, "kind": m.kind,
        "dir": dir.join(&m.id).to_string_lossy(),
        "prompts": m.prompts,
    }))
}

/// 渲染插件提示词模板为纯文本（{{input}} / {{project.name}} / {{episode.title}}；
/// 上下文取当前项目名与第一分集标题，取不到留空）。
/// 安全红线：纯文本拼接，不执行插件代码、无网络；路径锁定在 plugins/ 内。
#[tauri::command]
fn plugin_render_prompt(
    state: TState,
    plugin_id: String,
    prompt_id: String,
    input: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    let ctx = {
        let p = state.project.read();
        onetv_core::plugins::RenderContext {
            project_name: p.manifest.as_ref().map(|m| m.project.title.clone()),
            episode_title: p
                .manifest
                .as_ref()
                .and_then(|m| m.episodes.first().map(|e| e.title.clone())),
        }
    };
    let dir = onetv_core::app_data_dir().join("plugins");
    let hub = onetv_core::plugins::PluginHub::new(&dir);
    let text = hub
        .render_prompt(&plugin_id, &prompt_id, input.as_deref(), &ctx)
        .map_err(err)?;
    state.audit.record("plugin.render_prompt", &plugin_id, None);
    Ok(serde_json::json!({ "text": text }))
}

/* ---------------- 画布批量运行（v2.14，规格 §7：condition/review 语义 + 禁用） ---------------- */

fn read_canvas_doc(root: &std::path::Path, episode_id: &str) -> Result<serde_json::Value, CommandError> {
    let raw = std::fs::read_to_string(root.join("episodes").join(episode_id).join("canvas.json"))
        .map_err(|_| err("画布为空：请先在「画布」页创建节点"))?;
    serde_json::from_str(&raw).map_err(err)
}

fn write_canvas_doc(root: &std::path::Path, episode_id: &str, doc: &serde_json::Value) -> Result<(), CommandError> {
    let p = root.join("episodes").join(episode_id).join("canvas.json");
    let tmp = p.with_extension(format!("json.tmp-{}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()));
    std::fs::write(&tmp, serde_json::to_string_pretty(doc).map_err(err)?).map_err(err)?;
    std::fs::rename(&tmp, &p).map_err(err)
}

fn sync_nodes(doc: &mut serde_json::Value, nodes: &[serde_json::Value]) {
    if let Some(arr) = doc.get_mut("nodes") {
        *arr = serde_json::Value::Array(nodes.to_vec());
    }
}

fn node_disabled(n: &serde_json::Value) -> bool {
    n.pointer("/config/disabled").and_then(|v| v.as_bool()) == Some(true)
}

/// 画布批量运行（拓扑序执行）：
/// - 禁用节点跳过；已完成的节点（batchStatus=done）在 resume 时跳过；
/// - text 节点视为内容（直接标记完成）；
/// - image/video/audio 节点创建生成任务并等待完成（产物回填 outputAssetId）；
/// - condition 节点求值 `contains:关键词`（对照上游文本节点内容），不满足时跳过 fail 分支下游；
/// - review 节点暂停批次等待人工批准（前端批准后 resume 继续）。
#[tauri::command]
async fn canvas_run_batch(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    episode_id: String,
    resume: Option<bool>,
) -> Result<serde_json::Value, CommandError> {
    let (root, _) = open_ctx(&state)?;
    let mut doc = read_canvas_doc(&root, &episode_id)?;
    let edges: Vec<(String, String, String)> = doc
        .get("edges")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .map(|e| {
                    (
                        e.get("source").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                        e.get("target").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                        e.get("sourcePort").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
                    )
                })
                .collect()
        })
        .unwrap_or_default();
    let mut nodes_arr: Vec<serde_json::Value> = doc
        .get("nodes")
        .and_then(|v| v.as_array())
        .cloned()
        .ok_or_else(|| err("画布没有节点"))?;
    if nodes_arr.is_empty() {
        return Err(err("画布没有节点"));
    }
    // 拓扑序（Kahn）
    let ids: Vec<String> = nodes_arr
        .iter()
        .map(|n| n.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string())
        .collect();
    let mut indegree: std::collections::HashMap<String, usize> = ids.iter().map(|i| (i.clone(), 0)).collect();
    for (src, tgt, _) in &edges {
        if indegree.contains_key(tgt) {
            *indegree.get_mut(tgt).unwrap() += 1;
            let _ = src;
        }
    }
    let mut queue: std::collections::VecDeque<String> =
        ids.iter().filter(|i| indegree[*i] == 0).cloned().collect();
    let mut order: Vec<String> = Vec::new();
    while let Some(id) = queue.pop_front() {
        order.push(id.clone());
        for (src, tgt, _) in &edges {
            if src == &id {
                let d = indegree.get_mut(tgt).unwrap();
                *d -= 1;
                if *d == 0 {
                    queue.push_back(tgt.clone());
                }
            }
        }
    }
    if order.len() != ids.len() {
        return Err(err("画布存在环：请检查连线后重试"));
    }

    let resume = resume.unwrap_or(false);
    let mut completed = 0usize;
    let mut skipped = 0usize;
    let mut recomputed = false; // condition 分支裁剪后需重算顺序

    // 拓扑执行（condition 裁剪分支时把下游标记 skipped 并继续按序处理）
    for nid in &order {
        let idx = nodes_arr
            .iter()
            .position(|n| n.get("id").and_then(|v| v.as_str()) == Some(nid.as_str()))
            .unwrap();
        let mut node = nodes_arr[idx].clone();
        if node_disabled(&node) {
            if let Some(cfg) = node.get_mut("config").and_then(|v| v.as_object_mut()) {
                cfg.insert("batchStatus".into(), serde_json::json!("skipped"));
                cfg.insert("batchNote".into(), serde_json::json!("节点已禁用"));
            }
            skipped += 1;
            continue;
        }
        if resume && node.pointer("/config/batchStatus").and_then(|v| v.as_str()) == Some("done") {
            skipped += 1;
            continue;
        }
        let ntype = node.get("type").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        let nid_str = nid.clone();

        match ntype.as_str() {
            "text" | "asset" => {
                // 文本/素材节点：无需执行（内容即产物）；上游连线语义在下游生成节点聚合
                let asset_count = if ntype == "asset" {
                    node.pointer("/config/referenceAssetIds").and_then(|v| v.as_array()).map(|a| a.len()).unwrap_or(0)
                } else {
                    0
                };
                if let Some(cfg) = node.get_mut("config").and_then(|v| v.as_object_mut()) {
                    cfg.insert("batchStatus".into(), serde_json::json!("done"));
                    if ntype == "asset" {
                        cfg.insert("batchNote".into(), serde_json::json!(format!(
                            "素材就绪（{asset_count} 个文件，供下游节点作参考）"
                        )));
                    }
                }
                nodes_arr[idx] = node;
                completed += 1;
            }
            "condition" => {
                // contains:关键词 —— 对照第一个上游文本节点内容
                let keyword = node
                    .pointer("/config/expression")
                    .and_then(|v| v.as_str())
                    .and_then(|e| e.strip_prefix("contains:"))
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                let mut pass = keyword.is_empty();
                if !keyword.is_empty() {
                    if let Some((_, src_id, _)) = edges.iter().find(|(_, t, _)| t == &nid_str) {
                        if let Some(src_node) = nodes_arr
                            .iter()
                            .find(|n| n.get("id").and_then(|v| v.as_str()) == Some(src_id.as_str()))
                        {
                            let upstream_text = src_node
                                .pointer("/config/text")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();
                            pass = upstream_text.contains(&keyword);
                        }
                    }
                }
                if !pass {
                    // 裁剪 fail 分支下游（BFS 标记 skipped；按 fail 端口连线）
                    let mut stack: Vec<String> = edges
                        .iter()
                        .filter(|(src, _, port)| src == &nid_str && port == "fail")
                        .map(|(_, tgt, _)| tgt.clone())
                        .collect();
                    let mut seen = std::collections::HashSet::new();
                    while let Some(t) = stack.pop() {
                        if !seen.insert(t.clone()) {
                            continue;
                        }
                        if let Some(ti) = nodes_arr
                            .iter()
                            .position(|n| n.get("id").and_then(|v| v.as_str()) == Some(t.as_str()))
                        {
                            if let Some(cfg) = nodes_arr[ti].get_mut("config").and_then(|v| v.as_object_mut()) {
                                cfg.insert("batchStatus".into(), serde_json::json!("skipped"));
                                cfg.insert("batchNote".into(), serde_json::json!("条件分支未命中"));
                            }
                            skipped += 1;
                        }
                        for (src, tgt, _) in &edges {
                            if src == &t {
                                stack.push(tgt.clone());
                            }
                        }
                    }
                    recomputed = true;
                }
                if let Some(cfg) = node.get_mut("config").and_then(|v| v.as_object_mut()) {
                    cfg.insert("batchStatus".into(), serde_json::json!("done"));
                    cfg.insert("batchNote".into(), serde_json::json!(if pass { "条件命中（pass）" } else { "条件未命中（裁剪 fail 分支）" }));
                }
                nodes_arr[idx] = node;
                completed += 1;
            }
            "review" => {
                if let Some(cfg) = node.get_mut("config").and_then(|v| v.as_object_mut()) {
                    cfg.insert("status".into(), serde_json::json!("awaiting_review"));
                    cfg.insert("batchStatus".into(), serde_json::json!("awaiting_review"));
                }
                nodes_arr[idx] = node;
                sync_nodes(&mut doc, &nodes_arr);
                write_canvas_doc(&root, &episode_id, &doc)?;
                state.audit.record("canvas.batch_pause_review", &nid_str, None);
                return Ok(serde_json::json!({
                    "ok": true, "paused": true, "reviewNodeId": nid_str,
                    "completed": completed, "skipped": skipped, "total": order.len(),
                    "message": "批次暂停：等待人工审核节点批准",
                }));
            }
            "image" | "video" | "video-clip" | "audio" => {
                // 生成节点：组装任务并等待完成
                let prompt = node
                    .pointer("/config/prompt")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_string())
                    .or_else(|| {
                        if ntype == "audio" {
                            node.pointer("/config/text").and_then(|v| v.as_str()).map(|s| s.trim().to_string())
                        } else {
                            None
                        }
                    })
                    .unwrap_or_default();
                if prompt.is_empty() {
                    if let Some(cfg) = node.get_mut("config").and_then(|v| v.as_object_mut()) {
                        cfg.insert("batchStatus".into(), serde_json::json!("skipped"));
                        cfg.insert("batchNote".into(), serde_json::json!("缺少提示词"));
                    }
                    nodes_arr[idx] = node;
                    skipped += 1;
                    continue;
                }
                let aspect = node
                    .pointer("/config/aspect")
                    .and_then(|v| v.as_str())
                    .unwrap_or("9:16")
                    .to_string();
                let provider_id = node.pointer("/config/providerId").and_then(|v| v.as_str()).map(|s| s.to_string());
                let model_id = node.pointer("/config/modelId").and_then(|v| v.as_str()).map(|s| s.to_string());
                let refs: Vec<String> = node
                    .pointer("/config/referenceAssetIds")
                    .and_then(|v| v.as_array())
                    .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
                    .unwrap_or_default();
                // v2.26.26 连线即参考（LibTV/即梦式）：聚合上游连线节点的产物与参考；
                // 上游文本节点内容作为文字约束并入提示词。
                let mut refs = refs;
                let mut upstream_texts: Vec<String> = Vec::new();
                for (src, tgt, _) in &edges {
                    if tgt != &nid_str {
                        continue;
                    }
                    if let Some(src_node) = nodes_arr
                        .iter()
                        .find(|n| n.get("id").and_then(|v| v.as_str()) == Some(src.as_str()))
                    {
                        let scfg = src_node.get("config");
                        let out = scfg
                            .and_then(|c| c.get("outputAssetId"))
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string();
                        if !out.is_empty() && !refs.contains(&out) {
                            refs.push(out);
                        }
                        if let Some(arr) = scfg.and_then(|c| c.get("referenceAssetIds")).and_then(|v| v.as_array()) {
                            for rid in arr.iter().filter_map(|x| x.as_str()) {
                                if !rid.is_empty() && !refs.contains(&rid.to_string()) {
                                    refs.push(rid.to_string());
                                }
                            }
                        }
                        // v2.26.101 语义：素材节点上传的 files 是"节点内容"，被下游连线引用时同样作为参考
                        if let Some(arr) = scfg.and_then(|c| c.get("files")).and_then(|v| v.as_array()) {
                            for f in arr.iter() {
                                if let Some(fid) = f.get("id").and_then(|x| x.as_str()) {
                                    if !fid.is_empty() && !refs.contains(&fid.to_string()) {
                                        refs.push(fid.to_string());
                                    }
                                }
                            }
                        }
                        if src_node.get("type").and_then(|v| v.as_str()) == Some("text") {
                            let ut = scfg
                                .and_then(|c| c.get("text"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.trim().to_string())
                                .unwrap_or_default();
                            if !ut.is_empty() {
                                upstream_texts.push(ut);
                            }
                        }
                    }
                }
                let prompt = if !upstream_texts.is_empty() {
                    // 上游文本并入提示词（文字约束）：节点自身提示词在前，上游文本按连线顺序在后
                    let mut parts = Vec::new();
                    if !prompt.is_empty() {
                        parts.push(prompt);
                    }
                    parts.extend(upstream_texts);
                    parts.join("\n")
                } else {
                    prompt
                };
                let (kind, params, title_full) = match ntype.as_str() {
                    "image" => (
                        onetv_core::jobs::JobKind::ImageGeneration,
                        serde_json::json!({ "prompt": prompt, "aspect": aspect, "providerId": provider_id, "model": model_id, "referenceAssetIds": refs, "nodeId": nid_str }),
                        format!("批量生图（节点 {}）", node.get("title").and_then(|v| v.as_str()).unwrap_or(&nid_str)),
                    ),
                    "video" | "video-clip" => (
                        onetv_core::jobs::JobKind::VideoGeneration,
                        serde_json::json!({ "prompt": prompt, "aspect": aspect, "providerId": provider_id, "model": model_id, "referenceAssetIds": refs, "nodeId": nid_str }),
                        format!("批量生视频（节点 {}）", node.get("title").and_then(|v| v.as_str()).unwrap_or(&nid_str)),
                    ),
                    _ => (
                        onetv_core::jobs::JobKind::Tts,
                        serde_json::json!({ "text": prompt, "providerId": provider_id, "model": model_id, "nodeId": nid_str }),
                        format!("批量配音（节点 {}）", node.get("title").and_then(|v| v.as_str()).unwrap_or(&nid_str)),
                    ),
                };
                let job = agent.jobs.create_job(
                    kind,
                    title_full,
                    None,
                    None,
                    params,
                    Some(nid_str.clone()),
                    Some(episode_id.clone()),
                    false,
                    Some(serde_json::json!({
                        "destination": "Model Provider（由模型选择/生成模型设置决定）",
                        "data": "节点提示词与参考素材",
                        "via": "canvas-batch",
                    })),
                );
                state.audit.record("canvas.batch_run", &format!("{nid_str} → {}", job.id), None);
                // 等待完成（单任务上限 20 分钟）
                let mut final_state = String::new();
                for _ in 0..2400 {
                    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
                    if let Some(j) = agent.jobs.load(&job.id) {
                        if j.state.is_terminal() {
                            final_state = j.state.as_str().to_string();
                            if let Some(oid) = j.result.get("outputs").and_then(|o| o.as_array()).and_then(|a| a.first()).and_then(|x| x.as_str()) {
                                if let Some(cfg) = node.get_mut("config").and_then(|v| v.as_object_mut()) {
                                    cfg.insert("outputAssetId".into(), serde_json::json!(oid));
                                }
                            }
                            break;
                        }
                    }
                }
                if final_state != "SUCCEEDED" {
                    if let Some(cfg) = node.get_mut("config").and_then(|v| v.as_object_mut()) {
                        cfg.insert("batchStatus".into(), serde_json::json!("failed"));
                    }
                    nodes_arr[idx] = node;
                    sync_nodes(&mut doc, &nodes_arr);
                    write_canvas_doc(&root, &episode_id, &doc)?;
                    return Err(err(format!(
                        "节点 {nid_str} 生成失败（{final_state}），批次已中止；已完成的节点保留，可修复后用「恢复运行」继续"
                    )));
                }
                if let Some(cfg) = node.get_mut("config").and_then(|v| v.as_object_mut()) {
                    cfg.insert("batchStatus".into(), serde_json::json!("done"));
                    cfg.insert("status".into(), serde_json::json!("ready"));
                }
                nodes_arr[idx] = node;
                completed += 1;
                let _ = recomputed;
            }
            "script" | "storyboard" | "export" => {
                if let Some(cfg) = node.get_mut("config").and_then(|v| v.as_object_mut()) {
                    cfg.insert("batchStatus".into(), serde_json::json!("skipped"));
                    cfg.insert("batchNote".into(), serde_json::json!("批量运行暂不支持该类型，请用面板/对话生成"));
                }
                nodes_arr[idx] = node;
                skipped += 1;
            }
            other => {
                if let Some(cfg) = node.get_mut("config").and_then(|v| v.as_object_mut()) {
                    cfg.insert("batchStatus".into(), serde_json::json!("skipped"));
                    cfg.insert("batchNote".into(), serde_json::json!(format!("未知类型 {other}")));
                }
                nodes_arr[idx] = node;
                skipped += 1;
            }
        }
        sync_nodes(&mut doc, &nodes_arr);
        write_canvas_doc(&root, &episode_id, &doc)?;
    }
    Ok(serde_json::json!({
        "ok": true, "paused": false,
        "completed": completed, "skipped": skipped, "total": order.len(),
    }))
}

/* ---------------- 意识模块：记忆（v2.3.5+） ---------------- */

#[tauri::command]
fn memory_list(state: TState) -> Result<Vec<onetv_project::ops::MemoryRecord>, CommandError> {
    let (root, _) = open_ctx(&state)?;
    onetv_project::ops::list_memories(&root).map_err(err)
}

/// 记忆语义搜索（v2.14）：余弦相似度排序，返回带分数的记录
#[tauri::command]
fn memory_search(state: TState, query: String, limit: Option<u32>) -> Result<Vec<serde_json::Value>, CommandError> {
    let (root, _) = open_ctx(&state)?;
    let scored = onetv_project::ops::search_memories(&root, &query, (limit.unwrap_or(20)) as usize).map_err(err)?;
    Ok(scored
        .into_iter()
        .map(|(m, score)| serde_json::json!({ "record": m, "score": (score * 1000.0).round() / 1000.0 }))
        .collect())
}

#[tauri::command]
fn memory_add(state: TState, text: String, scope: Option<String>) -> Result<onetv_project::ops::MemoryRecord, CommandError> {
    let (root, _) = open_ctx(&state)?;
    let rec = onetv_project::ops::add_memory(&root, &text, scope.as_deref().unwrap_or("project")).map_err(err)?;
    state.audit.record("memory.add", &rec.id, None);
    Ok(rec)
}

#[tauri::command]
fn memory_update(state: TState, id: String, text: String) -> Result<(), CommandError> {
    let (root, _) = open_ctx(&state)?;
    onetv_project::ops::update_memory(&root, &id, &text).map_err(err)?;
    state.audit.record("memory.update", &id, None);
    Ok(())
}

#[tauri::command]
fn memory_delete(state: TState, id: String) -> Result<(), CommandError> {
    let (root, _) = open_ctx(&state)?;
    onetv_project::ops::delete_memory(&root, &id).map_err(err)?;
    state.audit.record("memory.delete", &id, None);
    Ok(())
}

/* ---------------- Hermes agent 桥接（v2.3.5+，双向） ---------------- */
///
/// 出向：OneTV → Hermes（hermes_send，HTTP POST {url}/message）
/// 入向：Hermes → OneTV（本机回环监听 GET /health、POST /invoke，白名单动作，token 鉴权）
/// 安全：URL 与监听仅允许本机回环；监听默认关闭；建议设置 token；本地回环不受 Local-only 出站策略限制。

static HERMES_STOP: std::sync::Mutex<Option<tokio::sync::watch::Sender<bool>>> =
    std::sync::Mutex::new(None);

fn hermes_log_path() -> PathBuf {
    onetv_core::app_data_dir().join("hermes_log.jsonl")
}

fn hermes_log(kind: &str, payload: serde_json::Value) {
    use std::io::Write;
    let entry = serde_json::json!({
        "time": chrono::Utc::now().to_rfc3339(),
        "kind": kind,
        "payload": payload,
    });
    // v2.12.0：超过 5MB 轮转为 .old，防止无限增长
    let hlp = hermes_log_path();
    if let Ok(meta) = std::fs::metadata(&hlp) {
        if meta.len() > 5 * 1024 * 1024 {
            let _ = std::fs::rename(&hlp, hlp.with_extension("old.jsonl"));
        }
    }
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(hermes_log_path())
    {
        let _ = writeln!(f, "{entry}");
    }
}

fn hermes_token() -> Option<String> {
    onetv_security::SecretStore::get("hermes").ok().flatten()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HermesConfig {
    url: Option<String>,
    listen_port: u16,
    enabled: bool,
    has_token: bool,
}

#[tauri::command]
fn hermes_config_get(state: TState) -> HermesConfig {
    let s = state.settings.get();
    HermesConfig {
        url: s.hermes_url.clone(),
        listen_port: s.hermes_listen_port,
        enabled: s.hermes_enabled,
        has_token: hermes_token().is_some(),
    }
}

/// 保存 Hermes 配置；token 传 None 表示保持不变，传空串表示清除。
#[tauri::command]
fn hermes_config_save(
    state: TState,
    url: String,
    listen_port: u16,
    enabled: bool,
    token: Option<String>,
) -> Result<HermesConfig, CommandError> {
    let url = url.trim().to_string();
    if !url.is_empty() && !onetv_core::providers::router::is_local_base(&url) {
        return Err(err("Hermes 地址仅允许本机/局域网回环地址（如 http://127.0.0.1:8765）"));
    }
    if let Some(t) = &token {
        if t.is_empty() {
            let _ = onetv_security::SecretStore::delete("hermes");
        } else {
            onetv_security::SecretStore::set("hermes", t).map_err(err)?;
        }
    }
    let out = state.settings.update(|s| {
        s.hermes_url = if url.is_empty() { None } else { Some(url) };
        s.hermes_listen_port = listen_port.max(1024);
        s.hermes_enabled = enabled;
    });
    hermes_restart_listener(state.inner(), &out)?;
    Ok(HermesConfig {
        url: out.hermes_url.clone(),
        listen_port: out.hermes_listen_port,
        enabled: out.hermes_enabled,
        has_token: hermes_token().is_some(),
    })
}

#[tauri::command]
async fn hermes_test(state: TState<'_>) -> Result<serde_json::Value, CommandError> {
    let url = state
        .settings
        .get()
        .hermes_url
        .ok_or_else(|| err("尚未配置 Hermes 地址"))?;
    let token = hermes_token();
    let started = std::time::Instant::now();
    let url_for_req = url.clone();
    let result = tokio::task::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(4))
            .build()
            .map_err(|e| e.to_string())?;
        let mut req = client.get(format!("{url_for_req}/health"));
        if let Some(t) = &token {
            req = req.header("X-Hermes-Token", t);
        }
        let resp = req.send().map_err(|e| format!("无法连接 Hermes（{e}）"))?;
        resp.text().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| err(e.to_string()))?;
    let latency = started.elapsed().as_millis() as u64;
    match result {
        Ok(body) => Ok(serde_json::json!({ "ok": true, "latencyMs": latency, "body": body.chars().take(500).collect::<String>() })),
        Err(e) => Ok(serde_json::json!({ "ok": false, "message": e })),
    }
}

/// OneTV → Hermes：发送文本指令，返回 Hermes 回复文本。
#[tauri::command]
async fn hermes_send(state: TState<'_>, text: String) -> Result<serde_json::Value, CommandError> {
    let url = state
        .settings
        .get()
        .hermes_url
        .ok_or_else(|| err("尚未配置 Hermes 地址"))?;
    if text.trim().is_empty() {
        return Err(err("消息不能为空"));
    }
    let token = hermes_token();
    let text_for_req = text.clone();
    let result = tokio::task::spawn_blocking(move || {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .map_err(|e| e.to_string())?;
        let mut req = client.post(format!("{url}/message")).json(&serde_json::json!({
            "from": "onetv",
            "text": text_for_req,
        }));
        if let Some(t) = &token {
            req = req.header("X-Hermes-Token", t);
        }
        let resp = req.send().map_err(|e| format!("无法连接 Hermes（{e}）"))?;
        let status = resp.status();
        let body = resp.text().map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("Hermes 返回 {status}：{}", body.chars().take(300).collect::<String>()));
        }
        Ok(body)
    })
    .await
    .map_err(|e| err(e.to_string()))?;
    match result {
        Ok(body) => {
            hermes_log("outbound", serde_json::json!({ "text": text, "reply": body }));
            Ok(serde_json::json!({ "ok": true, "reply": body }))
        }
        Err(e) => {
            hermes_log("outbound_error", serde_json::json!({ "text": text, "error": e }));
            Ok(serde_json::json!({ "ok": false, "message": e }))
        }
    }
}

#[tauri::command]
fn hermes_log_recent(limit: Option<u32>) -> Vec<serde_json::Value> {
    let path = hermes_log_path();
    let Ok(raw) = std::fs::read_to_string(path) else { return vec![] };
    raw.lines()
        .filter_map(|l| serde_json::from_str::<serde_json::Value>(l).ok())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .take(limit.unwrap_or(100) as usize)
        .collect()
}

/// 按设置启动/停止 Hermes 反向控制监听。
fn hermes_restart_listener(state: &Arc<AppState>, s: &AppSettings) -> Result<(), CommandError> {
    // 停旧监听（watch 通道通知 + 旧 sender 丢弃）
    if let Some(tx) = HERMES_STOP.lock().unwrap().take() {
        let _ = tx.send(true);
    }
    if !s.hermes_enabled {
        tracing::info!("hermes listener disabled");
        return Ok(());
    }
    let Some(agent) = AGENT.get() else {
        return Err(err("运行时未就绪"));
    };
    let (tx, rx) = tokio::sync::watch::channel(false);
    *HERMES_STOP.lock().unwrap() = Some(tx);
    let env = agent.env.clone();
    let jobs = agent.jobs.clone();
    let state2 = state.clone();
    let port = s.hermes_listen_port;
    let token = hermes_token();
    tauri::async_runtime::handle().spawn(async move {
        hermes_listen_loop(port, token, rx, state2, env, jobs).await;
    });
    tracing::info!(port, "hermes listener starting");
    Ok(())
}

async fn hermes_listen_loop(
    port: u16,
    token: Option<String>,
    mut stop: tokio::sync::watch::Receiver<bool>,
    state: Arc<AppState>,
    env: Arc<onetv_core::agent::AgentEnv>,
    jobs: Arc<onetv_core::jobs::JobManager>,
) {
    let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(port, error = %e, "hermes listener bind failed");
            let msg = serde_json::json!({ "error": format!("Hermes 监听 {port} 失败（端口被占用？）: {e}") });
            env.events("hermes.inbound", msg);
            return;
        }
    };
    tracing::info!(port, "hermes listener ready");
    loop {
        tokio::select! {
            _ = stop.changed() => break,
            acc = listener.accept() => {
                let Ok((stream, _)) = acc else { continue };
                let token = token.clone();
                let state = state.clone();
                let env = env.clone();
                let jobs = jobs.clone();
                tokio::spawn(async move {
                    let _ = tokio::time::timeout(
                        std::time::Duration::from_secs(75),
                        hermes_handle_conn(stream, token, state, env, jobs),
                    ).await;
                });
            }
        }
    }
    tracing::info!("hermes listener stopped");
}

/// 极简 HTTP/1.1 处理：只支持 GET /health 与 POST /invoke（body ≤ 256KB）。
async fn hermes_handle_conn(
    mut stream: tokio::net::TcpStream,
    token: Option<String>,
    state: Arc<AppState>,
    env: Arc<onetv_core::agent::AgentEnv>,
    jobs: Arc<onetv_core::jobs::JobManager>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = vec![0u8; 262_144];
    let n = match stream.read(&mut buf).await {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let raw = String::from_utf8_lossy(&buf[..n]).into_owned();
    let mut lines = raw.split("\r\n");
    let request_line = lines.next().unwrap_or_default().to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("").to_uppercase();
    let url = parts.next().unwrap_or("").to_string();
    let mut token_header: Option<String> = None;
    let mut content_len = 0usize;
    for line in lines {
        let Some((k, v)) = line.split_once(':') else { continue };
        let k = k.trim().to_ascii_lowercase();
        let v = v.trim();
        if k == "x-hermes-token" {
            token_header = Some(v.to_string());
        } else if k == "content-length" {
            content_len = v.parse().unwrap_or(0);
        }
    }
    let body = raw
        .split_once("\r\n\r\n")
        .map(|(_, b)| b.chars().take(content_len.max(0)).collect::<String>())
        .unwrap_or_default();

    let (status, resp_json) = match (method.as_str(), url.as_str()) {
        ("GET", u) if u.starts_with("/health") => (
            200,
            serde_json::json!({ "ok": true, "app": "onetv", "version": env!("CARGO_PKG_VERSION") }),
        ),
        ("POST", u) if u.starts_with("/invoke") => {
            // v2.12.0：未设置 token 时拒绝 /invoke（仅放行 /health）——
            // 否则本机任意进程都能调用 agent_approve/create_image 消耗用户 API 配额
            match (&token, token_header.as_deref()) {
                (Some(t), Some(header)) if header == t.as_str() => {
                    hermes_invoke(&state, &env, &jobs, &body).await
                }
                (Some(_), _) => (401, serde_json::json!({ "error": "token 不匹配或缺失" })),
                (None, _) => (
                    403,
                    serde_json::json!({ "error": "本机未设置 Hermes token，反向控制已禁用。请在 OneTV「Hermes 连接」中设置 token" }),
                ),
            }
        }
        _ => (
            404,
            serde_json::json!({ "error": "未知端点，可用：GET /health、POST /invoke" }),
        ),
    };
    let payload = serde_json::to_string(&resp_json).unwrap_or_default();
    let resp = format!(
        "HTTP/1.1 {status} {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}",
        if status == 200 { "OK" } else if status == 401 { "Unauthorized" } else if status == 404 { "Not Found" } else if status == 409 { "Conflict" } else { "Bad Request" },
        payload.len()
    );
    let _ = stream.write_all(resp.as_bytes()).await;
    let _ = stream.shutdown().await;
    hermes_log("inbound", serde_json::json!({ "method": method, "url": url, "status": status, "response": resp_json }));
    env.events("hermes.inbound", serde_json::json!({ "method": method, "url": url, "status": status, "response": resp_json }));
}

/// Hermes → OneTV 反向控制白名单动作（异步，可访问项目状态与完整 Agent 链路）。
async fn hermes_invoke(
    state: &Arc<AppState>,
    env: &Arc<onetv_core::agent::AgentEnv>,
    jobs: &Arc<onetv_core::jobs::JobManager>,
    body: &str,
) -> (u16, serde_json::Value) {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(body) else {
        return (400, serde_json::json!({ "error": "请求体必须是 JSON：{action, params}" }));
    };
    let action = v.get("action").and_then(|x| x.as_str()).unwrap_or("");
    let params = v.get("params").cloned().unwrap_or(serde_json::json!({}));
    match action {
        "status" => {
            let project_open = state.project.read().handle.is_some();
            let queued = jobs.list(200).iter().filter(|j| !j.state.is_terminal()).count();
            (
                200,
                serde_json::json!({
                    "app": "onetv", "version": env!("CARGO_PKG_VERSION"),
                    "projectOpen": project_open, "offline": env.offline_mode(), "activeJobs": queued,
                }),
            )
        }
        "job_list" => {
            let limit = params.get("limit").and_then(|x| x.as_u64()).unwrap_or(20) as u32;
            let list: Vec<serde_json::Value> = jobs
                .list(limit)
                .iter()
                .map(|j| serde_json::json!({ "id": j.id, "kind": j.kind.as_str(), "title": j.title, "state": j.state.as_str(), "progress": j.progress }))
                .collect();
            (200, serde_json::json!({ "jobs": list }))
        }
        "job_status" => {
            let Some(id) = params.get("id").and_then(|x| x.as_str()) else {
                return (400, serde_json::json!({ "error": "缺少 params.id" }));
            };
            match jobs.load(id) {
                Some(j) => (200, serde_json::json!({ "id": j.id, "state": j.state.as_str(), "progress": j.progress, "error": j.error })),
                None => (404, serde_json::json!({ "error": format!("任务不存在: {id}") })),
            }
        }
        "create_image" => {
            let Some(prompt) = params.get("prompt").and_then(|x| x.as_str()) else {
                return (400, serde_json::json!({ "error": "缺少 params.prompt" }));
            };
            if state.project.read().handle.is_none() {
                return (409, serde_json::json!({ "error": "OneTV 未打开项目，无法创建生成任务" }));
            }
            let job = jobs.create_job(
                onetv_core::jobs::JobKind::ImageGeneration,
                format!("生成图片：{prompt}"),
                None,
                None,
                serde_json::json!({ "prompt": prompt }),
                None,
                None,
                false,
                Some(serde_json::json!({ "destination": "Image Provider", "via": "hermes" })),
            );
            (200, serde_json::json!({ "jobId": job.id, "state": job.state.as_str() }))
        }
        "agent_chat" | "agent_approve" => hermes_agent_action(state, env, jobs, action, &params).await,
        other => (
            400,
            serde_json::json!({
                "error": format!("未知动作 {other}"),
                "available": ["status", "job_list", "job_status", "create_image", "agent_chat", "agent_approve"],
            }),
        ),
    }
}

async fn hermes_agent_action(
    state: &Arc<AppState>,
    env: &Arc<onetv_core::agent::AgentEnv>,
    jobs: &Arc<onetv_core::jobs::JobManager>,
    action: &str,
    params: &serde_json::Value,
) -> (u16, serde_json::Value) {
    use onetv_core::agent::executor::Executor;
    if action == "agent_approve" {
        let Some(agent) = AGENT.get() else { return (500, serde_json::json!({ "error": "运行时未就绪" })) };
        let Some(plan_id) = params.get("planId").and_then(|x| x.as_str()) else {
            return (400, serde_json::json!({ "error": "缺少 params.planId" }));
        };
        let Some(plan) = agent.plans.lock().get(plan_id).cloned() else {
            return (404, serde_json::json!({ "error": format!("计划不存在或已过期: {plan_id}") }));
        };
        let (root, episode) = {
            let p = state.project.read();
            match (&p.handle, &p.manifest) {
                (Some(h), Some(m)) => (
                    h.root().clone(),
                    m.episodes.first().map(|e| e.id.clone()),
                ),
                _ => return (409, serde_json::json!({ "error": "OneTV 未打开项目" })),
            }
        };
        let executor = Executor { env: env.clone(), jobs: jobs.clone() };
        match executor.execute(&plan, &root, episode).await {
            Ok(ids) => (200, serde_json::json!({ "ok": true, "jobIds": ids })),
            Err(e) => (500, serde_json::json!({ "error": e })),
        }
    } else {
        // agent_chat
        let Some(text) = params.get("text").and_then(|x| x.as_str()) else {
            return (400, serde_json::json!({ "error": "缺少 params.text" }));
        };
        let intent = onetv_core::agent::route_intent(text);
        let episode = {
            let p = state.project.read();
            p.manifest.as_ref().and_then(|m| m.episodes.first().map(|e| e.id.clone()))
        };
        let mut plan = onetv_core::agent::build_plan(intent, text, episode.as_deref());
        plan.status = "draft".into();
        if intent == onetv_core::agent::Intent::Chat {
            let root = {
                let p = state.project.read();
                p.handle.as_ref().map(|h| h.root().clone()).unwrap_or_else(std::env::temp_dir)
            };
            let executor = Executor { env: env.clone(), jobs: jobs.clone() };
            match executor.execute(&plan, &root, None).await {
                Ok(ids) => (200, serde_json::json!({ "ok": true, "autoExecuted": true, "jobIds": ids })),
                Err(e) => (500, serde_json::json!({ "error": e })),
            }
        } else {
            let plan_id = plan.plan_id.clone();
            if let Some(agent) = AGENT.get() {
                agent.plans.lock().insert(plan_id.clone(), plan.clone());
            }
            (
                200,
                serde_json::json!({ "ok": true, "autoExecuted": false, "planId": plan_id, "summary": plan.summary,
                    "hint": "调用 action=agent_approve 并携带 planId 以执行该计划" }),
            )
        }
    }
}

/* ---------------- 审计 ---------------- */

#[tauri::command]
fn audit_recent(state: TState, limit: Option<u32>) -> Vec<onetv_security::audit::AuditEntry> {
    state.audit.recent(limit.unwrap_or(100) as usize)
}

/* ---------------- 文档（剧本/分镜/画布/时间线 JSON） ---------------- */

fn open_ctx(state: &AppState) -> Result<(PathBuf, ProjectManifest), CommandError> {
    let p = state.project.read();
    match (&p.handle, &p.manifest) {
        (Some(h), Some(m)) => Ok((h.root().clone(), m.clone())),
        _ => Err(err("未打开项目")),
    }
}

#[tauri::command]
fn doc_get(state: TState, episode_id: String, kind: String) -> Result<serde_json::Value, CommandError> {
    let (root, manifest) = open_ctx(&state)?;
    let ep = manifest
        .episodes
        .iter()
        .find(|e| e.id == episode_id)
        .ok_or_else(|| err(format!("分集不存在: {episode_id}")))?;
    let rel = match kind.as_str() {
        "script" => ep.script.clone(),
        "storyboard" => ep.storyboard.clone(),
        "canvas" => ep.canvas.clone(),
        "timeline" => format!("episodes/{}/timeline.json", ep.id),
        other => return Err(err(format!("未知文档类型: {other}"))),
    };
    let path = root.join(rel);
    if !path.exists() {
        return Ok(serde_json::json!({"schemaVersion": "1.0"}));
    }
    let raw = std::fs::read_to_string(path).map_err(err)?;
    serde_json::from_str(&raw).map_err(err)
}

/// 项目重命名（v2.26.22）：改 project.json 的 project.title（工作区卡片/顶栏标题）
#[tauri::command]
fn project_rename(state: TState, new_title: String) -> Result<serde_json::Value, CommandError> {
    let title = new_title.trim();
    if title.is_empty() {
        return Err(err("项目名不能为空"));
    }
    let (root, manifest) = open_ctx(&state)?;
    let mut m = manifest.clone();
    let old_title = m.project.title.clone();
    m.project.title = title.to_string();
    let path = root.join("project.json");
    let json = serde_json::to_string_pretty(&m).map_err(err)?;
    let tmp = path.with_extension(format!(
        "tmp-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    std::fs::write(&tmp, json).map_err(err)?;
    std::fs::rename(&tmp, &path).map_err(err)?;
    if let Some(mut guard) = state.project.try_write() {
        if let Some(mm) = guard.manifest.as_mut() {
            mm.project.title = title.to_string();
        }
    }
    state.settings.touch_recent(&root.to_string_lossy(), title);
    state
        .audit
        .record("project.rename", &format!("{old_title} → {title}"), None);
    Ok(serde_json::json!({ "ok": true, "title": title }))
}

#[tauri::command]
fn doc_save(
    state: TState,
    episode_id: String,
    kind: String,
    doc: serde_json::Value,
) -> Result<(), CommandError> {
    let (root, manifest) = open_ctx(&state)?;
    let ep = manifest
        .episodes
        .iter()
        .find(|e| e.id == episode_id)
        .ok_or_else(|| err(format!("分集不存在: {episode_id}")))?;
    let rel = match kind.as_str() {
        "script" => ep.script.clone(),
        "storyboard" => ep.storyboard.clone(),
        "canvas" => ep.canvas.clone(),
        "timeline" => format!("episodes/{}/timeline.json", ep.id),
        other => return Err(err(format!("未知文档类型: {other}"))),
    };
    let path = root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(err)?;
    }
    // 原子写：临时文件 + rename，防崩溃产生半截 JSON（v2.12.0）
    let json = serde_json::to_string_pretty(&doc).map_err(err)?;
    let tmp = path.with_extension(format!(
        "tmp-{}",
        chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    std::fs::write(&tmp, json).map_err(err)?;
    std::fs::rename(&tmp, &path).map_err(err)?;

    // 画布镜像到 SQLite（规格 §4.2：SQLite 负责查询，JSON 负责 diff/备份）
    if kind == "canvas" {
        mirror_canvas_to_db(&root, &episode_id, &doc)?;
    }
    Ok(())
}

fn mirror_canvas_to_db(
    root: &std::path::Path,
    episode_id: &str,
    doc: &serde_json::Value,
) -> Result<(), CommandError> {
    onetv_project::ops::mirror_canvas(root, episode_id, doc).map_err(err)
}

/* ---------------- 资产 ---------------- */

#[tauri::command]
async fn asset_import(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
    kind: String,
) -> Result<onetv_project::ops::AssetRecord, CommandError> {
    let (root, _) = open_ctx(&state)?;
    let Some(path) = pick_path(&app, "选择要导入的素材文件".into(), false).await else {
        return Err(err("已取消"));
    };
    let rec = onetv_project::ops::import_asset(&root, &path, &kind).map_err(err)?;
    state.audit.record("asset.import", &rec.id, None);
    Ok(rec)
}

#[tauri::command]
fn asset_list(state: TState) -> Result<Vec<onetv_project::ops::AssetRecord>, CommandError> {
    let (root, _) = open_ctx(&state)?;
    onetv_project::ops::list_assets(&root).map_err(err)
}

#[tauri::command]
fn asset_delete(state: TState, id: String) -> Result<(), CommandError> {
    let (root, _) = open_ctx(&state)?;
    onetv_project::ops::delete_asset(&root, &id).map_err(err)?;
    state.audit.record("asset.delete", &id, None);
    Ok(())
}

/* ---------------- 画布快捷命令（doc_get/doc_save 的 canvas 别名） ---------------- */

#[tauri::command]
fn canvas_get(state: TState, episode_id: String) -> Result<serde_json::Value, CommandError> {
    doc_get(state, episode_id, "canvas".into())
}

#[tauri::command]
fn canvas_save(
    state: TState,
    episode_id: String,
    doc: serde_json::Value,
) -> Result<(), CommandError> {
    doc_save(state, episode_id, "canvas".into(), doc)
}

/* ---------------- 时间线编辑器（规格 §12.2，多轨 schemaVersion 2.0） ---------------- */

#[tauri::command]
fn timeline_get(state: TState, episode: String) -> Result<serde_json::Value, CommandError> {
    let (root, manifest) = open_ctx(&state)?;
    if !manifest.episodes.iter().any(|e| e.id == episode) {
        return Err(err(format!("分集不存在: {episode}")));
    }
    let path = root.join("episodes").join(&episode).join("timeline.json");
    if !path.exists() {
        return Ok(serde_json::json!({ "exists": false, "timeline": serde_json::Value::Null }));
    }
    let raw = std::fs::read_to_string(&path).map_err(err)?;
    let timeline: serde_json::Value = serde_json::from_str(&raw).map_err(err)?;
    Ok(serde_json::json!({ "exists": true, "timeline": timeline }))
}

#[tauri::command]
fn timeline_save(
    state: TState,
    episode: String,
    timeline: serde_json::Value,
) -> Result<(), CommandError> {
    let (root, manifest) = open_ctx(&state)?;
    if !manifest.episodes.iter().any(|e| e.id == episode) {
        return Err(err(format!("分集不存在: {episode}")));
    }
    // 原子写复用 core 的 write_episode_doc（临时文件 + rename）
    onetv_core::agent::handlers::write_episode_doc(&root, &episode, "timeline", &timeline)
        .map_err(|e| err(e.message))?;
    state.audit.record("timeline.save", &episode, None);
    Ok(())
}

#[tauri::command]
async fn timeline_render(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    episode: String,
) -> Result<serde_json::Value, CommandError> {
    let (root, manifest) = open_ctx(&state)?;
    if !manifest.episodes.iter().any(|e| e.id == episode) {
        return Err(err(format!("分集不存在: {episode}")));
    }
    let _ = root;
    // create_job 轻量（仅落库 + 入队），无需 spawn_blocking
    let job = agent.jobs.create_job(
        onetv_core::jobs::JobKind::TimelineRender,
        "渲染时间线（编辑器）",
        None,
        None,
        serde_json::json!({ "episode": episode, "source": "editor" }),
        None,
        Some(episode),
        false,
        None,
    );
    Ok(serde_json::json!({ "jobId": job.id }))
}

#[tauri::command]
async fn timeline_probe_asset(
    state: tauri::State<'_, Arc<AppState>>,
    asset_id: String,
) -> Result<serde_json::Value, CommandError> {
    let (root, _) = open_ctx(&state)?;
    let path = onetv_core::agent::handlers::asset_path_by_id(&root, &asset_id)
        .ok_or_else(|| err(format!("找不到资产: {asset_id}")))?;
    // ffprobe 是子进程阻塞调用：放阻塞线程池
    let media = state.media.clone();
    let probe_path = path.clone();
    let info = tokio::task::spawn_blocking(move || onetv_media::probe(&media, &probe_path))
        .await
        .map_err(|e| err(e.to_string()))?
        .map_err(err)?;
    let is_image = matches!(
        path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).as_deref(),
        Some("png") | Some("jpg") | Some("jpeg") | Some("webp") | Some("gif")
    );
    // 图片：durationSec=0 / hasAudio=false
    let (duration_sec, has_audio) = if is_image {
        (0.0, false)
    } else {
        (info.duration_sec, info.has_audio)
    };
    Ok(serde_json::json!({
        "durationSec": duration_sec,
        "width": info.width.unwrap_or(0),
        "height": info.height.unwrap_or(0),
        "hasAudio": has_audio,
    }))
}

/* ---------------- 多版本导出（v2.13） ---------------- */

/// 已知导出画幅预设（与 onetv_media::render::preset_size 的显式分支一致；
/// preset_size 对未知键静默回退 douyin_vertical，因此命令层先显式校验）。
const EXPORT_PRESETS: &[&str] = &["douyin_vertical", "xhs_vertical", "horizontal_1080p", "square", "master"];

/// export_render 命令层参数构建与校验（纯函数，便于单测）：
/// presets 为空报中文错误、未知 preset 报错；每个 preset 生成一份 Job params
/// （camelCase 键，与 export_render_handler 的 params 约定逐字一致）。
fn export_job_params(
    episode: &str,
    presets: &[String],
    burn_subtitle: bool,
    include_srt: bool,
) -> Result<Vec<serde_json::Value>, String> {
    if presets.is_empty() {
        return Err("请至少选择一个画幅预设".to_string());
    }
    let mut out = Vec::with_capacity(presets.len());
    for preset in presets {
        if !EXPORT_PRESETS.contains(&preset.as_str()) {
            return Err(format!("未知的画幅预设: {preset}"));
        }
        out.push(serde_json::json!({
            "episode": episode,
            "preset": preset,
            "burnSubtitle": burn_subtitle,
            "includeSrt": include_srt,
        }));
    }
    Ok(out)
}

/// 多版本导出：一次为每个选中画幅预设各建一个 JobKind::Export 任务，返回 jobId 列表。
#[tauri::command]
async fn export_render(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    episode: String,
    presets: Vec<String>,
    // 参数名为前端 invoke 契约的 camelCase 键
    #[allow(non_snake_case)]
    burnSubtitle: bool,
    #[allow(non_snake_case)]
    includeSrt: bool,
) -> Result<serde_json::Value, CommandError> {
    let (_, manifest) = open_ctx(&state)?;
    if !manifest.episodes.iter().any(|e| e.id == episode) {
        return Err(err(format!("分集不存在: {episode}")));
    }
    let params_list = export_job_params(&episode, &presets, burnSubtitle, includeSrt).map_err(err)?;
    let mut jobs = Vec::with_capacity(params_list.len());
    for params in params_list {
        let preset = params
            .get("preset")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        // create_job 轻量（仅落库 + 入队），无需 spawn_blocking（与 timeline_render 一致）
        let job = agent.jobs.create_job(
            onetv_core::jobs::JobKind::Export,
            format!("导出成片（{preset}）"),
            None,
            None,
            params,
            None,
            Some(episode.clone()),
            false,
            None,
        );
        jobs.push(job.id);
    }
    state.audit.record("export.render", &episode, None);
    Ok(serde_json::json!({ "jobs": jobs }))
}

/* ---------------- onetv-asset:// 本地资源协议 ---------------- */

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn mime_of(path: &std::path::Path) -> &'static str {
    match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("svg") => "image/svg+xml",
        Some("mp4") | Some("m4v") => "video/mp4",
        Some("mov") => "video/quicktime",
        Some("webm") => "video/webm",
        Some("mp3") => "audio/mpeg",
        Some("wav") => "audio/wav",
        Some("m4a") => "audio/mp4",
        Some("srt") => "application/x-subrip",
        Some("vtt") => "text/vtt",
        Some("json") => "application/json",
        Some("md") => "text/markdown",
        Some("txt") => "text/plain",
        _ => "application/octet-stream",
    }
}

fn serve_asset_range(
    state: &AppState,
    uri: &tauri::http::Uri,
    range: Option<&str>,
) -> tauri::http::Response<Cow<'static, [u8]>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Cow::Borrowed(&b"not found"[..]))
            .unwrap()
    };
    let raw = uri.to_string();
    let Some(rest) = raw.strip_prefix("onetv-asset://") else {
        return not_found();
    };
    let after_host = rest.split_once('/').map(|(_, r)| r).unwrap_or("");
    let path = percent_decode(after_host.split('?').next().unwrap_or(""));
    let Ok(canon) = std::fs::canonicalize(&path) else {
        return not_found();
    };
    // 安边界：只服务当前打开工程目录内的文件（防路径穿越/越权读取）
    let guard = state.project.read();
    let Some(root) = guard.handle.as_ref().map(|h| h.root().clone()) else {
        return not_found();
    };
    if !canon.starts_with(&root) {
        tracing::warn!(path = %canon.display(), "asset request outside project root denied");
        return not_found();
    }
    drop(guard);
    // v2.12.0：支持 Range 请求（视频播放走 206 分段），避免主线程整文件读入内存
    let file_len = match std::fs::metadata(&canon) {
        Ok(m) => m.len(),
        Err(_) => return not_found(),
    };
    let mime = mime_of(&canon);

    if let Some(spec) = range.filter(|r| r.starts_with("bytes=")) {
        let spec = spec.trim_start_matches("bytes=");
        let (start_s, end_s) = spec.split_once('-').unwrap_or((spec, ""));
        let Ok(start) = start_s.parse::<u64>() else { return not_found() };
        if start >= file_len {
            return tauri::http::Response::builder()
                .status(416)
                .header("Content-Range", format!("bytes */{file_len}"))
                .body(Cow::Borrowed(&b"range not satisfiable"[..]))
                .unwrap();
        }
        // 单次响应上限 8MB（浏览器会自动续段），限定内存占用
        const MAX_CHUNK: u64 = 8 * 1024 * 1024;
        let end_req = end_s.parse::<u64>().unwrap_or(file_len.saturating_sub(1)).min(file_len - 1);
        let end = start.saturating_add(MAX_CHUNK - 1).min(end_req);
        let take = (end - start + 1) as usize;
        let mut bytes = vec![0u8; take];
        let ok = std::fs::File::open(&canon)
            .and_then(|mut f| {
                use std::io::{Read, Seek, SeekFrom};
                f.seek(SeekFrom::Start(start))?;
                f.read_exact(&mut bytes)?;
                Ok(())
            })
            .is_ok();
        if !ok {
            return not_found();
        }
        return tauri::http::Response::builder()
            .status(206)
            .header("Content-Type", mime)
            .header("Cache-Control", "no-store")
            .header("Accept-Ranges", "bytes")
            .header("Content-Range", format!("bytes {start}-{end}/{file_len}"))
            .body(Cow::Owned(bytes))
            .unwrap();
    }

    let Ok(bytes) = std::fs::read(&canon) else {
        return not_found();
    };
    tauri::http::Response::builder()
        .header("Content-Type", mime)
        .header("Cache-Control", "no-store")
        .header("Accept-Ranges", "bytes")
        .body(Cow::Owned(bytes))
        .unwrap()
}

/* ---------------- macOS 原生菜单栏 ---------------- */

/// 应用菜单含「设置…」（macOS 惯例）、File 提供产品功能入口、Help 提供使用说明。
/// 菜单项通过事件桥转发给前端（前端 App.tsx 监听 menu:* 切换视图）。
fn build_app_menu(app: tauri::AppHandle) {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    let version = env!("CARGO_PKG_VERSION").to_string();

    let app_submenu = Submenu::with_id_and_items(
        &app,
        "onetv-app",
        "OneTV",
        true,
        &[
            &PredefinedMenuItem::about(&app, Some("OneTV"), Some(AboutMetadata { version: Some(version.clone()), ..Default::default() })).unwrap(),
            &PredefinedMenuItem::separator(&app).unwrap(),
            &MenuItem::with_id(&app, "settings", "设置…", true, Some("CmdOrCtrl+,")).unwrap(),
            &PredefinedMenuItem::separator(&app).unwrap(),
            &PredefinedMenuItem::hide(&app, None).unwrap(),
            &PredefinedMenuItem::hide_others(&app, None).unwrap(),
            &PredefinedMenuItem::show_all(&app, None).unwrap(),
            &PredefinedMenuItem::separator(&app).unwrap(),
            &PredefinedMenuItem::quit(&app, None).unwrap(),
        ],
    )
    .unwrap();

    let file_submenu = Submenu::with_id_and_items(
        &app,
        "onetv-file",
        "文件",
        true,
        &[
            &MenuItem::with_id(&app, "new-project", "新建项目…", true, Some("CmdOrCtrl+N")).unwrap(),
            &MenuItem::with_id(&app, "open-project", "打开项目…", true, Some("CmdOrCtrl+O")).unwrap(),
            &PredefinedMenuItem::separator(&app).unwrap(),
            &MenuItem::with_id(&app, "export-pkg", "导出工程包…", true, Some("CmdOrCtrl+E")).unwrap(),
            &PredefinedMenuItem::separator(&app).unwrap(),
            &PredefinedMenuItem::close_window(&app, None).unwrap(),
        ],
    )
    .unwrap();

    let edit_submenu = Submenu::with_items(
        &app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(&app, None).unwrap(),
            &PredefinedMenuItem::redo(&app, None).unwrap(),
            &PredefinedMenuItem::separator(&app).unwrap(),
            &PredefinedMenuItem::cut(&app, None).unwrap(),
            &PredefinedMenuItem::copy(&app, None).unwrap(),
            &PredefinedMenuItem::paste(&app, None).unwrap(),
            &PredefinedMenuItem::select_all(&app, None).unwrap(),
        ],
    )
    .unwrap();

    let view_submenu = Submenu::with_items(
        &app,
        "显示",
        true,
        &[&PredefinedMenuItem::fullscreen(&app, None).unwrap()],
    )
    .unwrap();

    let window_submenu = Submenu::with_items(
        &app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(&app, None).unwrap(),
            &PredefinedMenuItem::maximize(&app, None).unwrap(),
        ],
    )
    .unwrap();

    let help_submenu = Submenu::with_id_and_items(
        &app,
        "onetv-help",
        "帮助",
        true,
        &[&MenuItem::with_id(&app, "help", "OneTV 使用说明", true, None::<&str>).unwrap()],
    )
    .unwrap();

    let menu = Menu::with_items(
        &app,
        &[
            &app_submenu,
            &file_submenu,
            &edit_submenu,
            &view_submenu,
            &window_submenu,
            &help_submenu,
        ],
    )
    .unwrap();
    let _ = app.set_menu(menu);

    let h = app.clone();
    app.on_menu_event(move |_app, event| {
        let id = event.id().as_ref();
        match id {
            "settings" => {
                let _ = h.emit("menu:settings", ());
            }
            "new-project" => {
                let _ = h.emit("menu:new-project", ());
            }
            "open-project" => {
                let _ = h.emit("menu:open-project", ());
            }
            "export-pkg" => {
                let _ = h.emit("menu:export-pkg", ());
            }
            "help" => {
                use tauri_plugin_dialog::DialogExt;
                h.dialog()
                    .message(format!(
                        "OneTV {version} — 本地优先的短剧创作工作台\n\n\
                         快速上手：\n\
                         1. 「工作区」新建或打开 .ytv 项目（菜单 文件/新建项目，⌘N）\n\
                         2. 「剧本」用 AI 生成或手写剧本\n\
                         3. 「分镜」拆分镜头、批量生图、合成成片\n\
                         4. 「模型」配置你的 Provider（内置 Mock 离线演示）\n\
                         5. 「设置」（⌘,）管理外观、账户、隐私与 FFmpeg\n\n\
                         数据边界：项目只存本机；API Key 只进 macOS 钥匙串；默认零遥测。"
                    ))
                    .show(|_| {});
            }
            _ => {}
        }
    });
}

/* ---------------- 启动 ---------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    onetv_core::init_tracing();

    // 时间边界测试钩子：ONETV_TEST_TIME_OFFSET_SEC=±秒数（启动时注入测试时钟偏移）
    if let Ok(v) = std::env::var("ONETV_TEST_TIME_OFFSET_SEC") {
        if let Ok(secs) = v.trim().parse::<i64>() {
            onetv_core::auth::set_time_offset(secs);
        }
    }

    let data_dir = onetv_core::app_data_dir();
    let settings = SettingsStore::new(&data_dir);
    let audit = Arc::new(AuditLog::new(&data_dir.join("audit")).expect("audit log dir"));
    let media = MediaLocator::new();
    let policy = {
        let s = settings.get();
        let mut p = NetworkPolicy::new(s.offline_mode);
        for h in &s.allowed_hosts {
            p.allow_base_url(h);
        }
        p
    };
    media.set_overrides(
        settings.get().ffmpeg_path.map(PathBuf::from),
        settings.get().ffprobe_path.map(PathBuf::from),
    );

    let policy = Arc::new(RwLock::new(policy));
    let skills = onetv_core::skills::SkillHub::new(&data_dir.join("skills"));
    let auth = onetv_core::auth::AuthStore::new(&data_dir);
    auth.ensure_initialized().ok();
    // 内置 Skills 预置安装：多路径探测（dev target/debug → 仓库 skills/；打包 .app → Resources/skills）
    {
        let mut builtin: Option<PathBuf> = None;
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                for cand in [
                    dir.join("../../skills"),        // target/debug|release → 仓库 skills/
                    dir.join("../Resources/skills"), // .app/Contents/MacOS → Resources
                    dir.join("../skills"),           // target → 仓库
                ] {
                    if cand.join("short-drama").join("skill.json").is_file() {
                        builtin = Some(cand);
                        break;
                    }
                }
            }
        }
        if let Some(b) = builtin {
            onetv_core::skills::seed_builtin(&skills, &b);
            tracing::info!(dir = %b.display(), "builtin skills seeded");
        }
    }
    let state = Arc::new(AppState {
        settings,
        media,
        policy: policy.clone(),
        audit,
        project: RwLock::new(OpenedProject::default()),
        skills,
        auth,
        logged_in: std::sync::atomic::AtomicBool::new(false),
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        // 窗口大小/位置/全屏态记忆（v2.11.0），关闭时自动保存
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(state.clone())
        // v2.12.0：异步协议 + Range 支持（视频播放不再整文件读入主线程内存）
        .register_asynchronous_uri_scheme_protocol("onetv-asset", |ctx, request, responder| {
            let state = ctx.app_handle().state::<Arc<AppState>>().inner().clone();
            let uri = request.uri().clone();
            let range = request
                .headers()
                .get(reqwest::header::RANGE)
                .and_then(|v| v.to_str().ok())
                .map(|r| r.to_string());
            tauri::async_runtime::spawn(async move {
                let resp = tauri::async_runtime::spawn_blocking(move || {
                    serve_asset_range(&state, &uri, range.as_deref())
                })
                .await
                .unwrap_or_else(|_| {
                    tauri::http::Response::builder()
                        .status(500)
                        .body(Cow::Borrowed(&b"internal error"[..]))
                        .unwrap()
                });
                responder.respond(resp);
            });
        })
        .register_uri_scheme_protocol("onetv-app", |_ctx, request| {
            serve_app_file(request.uri())
        })
        .setup(move |app| {
            let handle = app.handle().clone();

            // Provider 注册表（内置 Mock 离线演示 Provider 按 id 补种：
            // 仅在列表为空时补种的话，误删 Mock 后重启无法恢复）
            let mut registry = ProviderRegistry::load(&data_dir);
            if !registry.list().iter().any(|p| p.id == "builtin-mock") {
                let mut mock = onetv_core::providers::ProviderProfile::new(
                    "离线演示（Mock）",
                    ProviderDriverKind::Mock,
                    "mock://local",
                );
                mock.id = "builtin-mock".into();
                mock.models = vec![
                    model_binding("mock-chat-v1", &[Capability::Chat, Capability::StructuredOutput]),
                    model_binding("mock-image-v1", &[Capability::ImageGeneration]),
                    model_binding("mock-video-v1", &[Capability::VideoGeneration]),
                    model_binding("mock-tts-v1", &[Capability::Tts]),
                ];
                registry.upsert(mock);
                tracing::info!("seeded builtin mock provider (was missing)");
            }
            let registry = Arc::new(RwLock::new(registry));

            // 清理 themes/ 目录中的 0 字节残留（历史上传失败产物）
            {
                let themes = data_dir.join("themes");
                if let Ok(entries) = std::fs::read_dir(&themes) {
                    for e in entries.flatten() {
                        if let Ok(meta) = e.metadata() {
                            if meta.is_file() && meta.len() == 0 {
                                let _ = std::fs::remove_file(e.path());
                                tracing::warn!(file = %e.path().display(), "removed 0-byte skin residue");
                            }
                        }
                    }
                }
            }

            // macOS 原生菜单栏（应用菜单设「设置…」、File 功能入口、Help 帮助）
            build_app_menu(handle.clone());

            let gateway = Arc::new(Gateway::new(state.policy.clone(), state.audit.clone()));

            // 事件桥（Rust → 前端）+ 出站 Webhook 回调（v2.22：任务终态 POST 到用户配置 URL）
            let h2 = handle.clone();
            let hook_state = state.clone();
            let hook_gateway = gateway.clone();
            let sink: EventSink = Arc::new(move |name: &str, payload: serde_json::Value| {
                // Tauri v2 事件名只允许字母数字与 - / : _，含 '.' 的 emit 会被拒绝——
                // 此前 job.*/agent.*/webhook.*/hermes.* 全部被静默丢弃，前端只能靠轮询兜底。
                // 统一把 '.' 映射为 ':'；webhook_out::extract_job 仍用原始名匹配。
                let wire = name.replace('.', ":");
                let _ = h2.emit(&wire, payload.clone());
                if let Some(job) = onetv_core::webhook_out::extract_job(name, &payload) {
                    let wo = hook_state.settings.get().webhook_out.clone();
                    if wo.enabled && !wo.url.trim().is_empty() {
                        let hook_gateway = hook_gateway.clone();
                        let client = hook_gateway.client().clone();
                        let audit = hook_state.audit.clone();
                        let event = name.to_string();
                        let url = wo.url.trim().to_string();
                        let secret = wo.secret.clone();
                        tokio::spawn(async move {
                            // 远程地址须过策略（回环/私网由策略天然放行）；失败不重试不阻塞
                            if let Err(e) = hook_gateway.check(&url) {
                                audit.record("webhook_out.skipped", &url, Some(serde_json::json!({ "reason": e.to_string() })));
                                return;
                            }
                            let body = onetv_core::webhook_out::build_payload(&event, &job);
                            match onetv_core::webhook_out::deliver(client, &url, &secret, &event, &body).await {
                                Ok(()) => audit.record("webhook_out.delivered", &url, Some(serde_json::json!({ "event": event }))),
                                Err(e) => {
                                    tracing::warn!("出站 Webhook 投递失败 {url}: {e}");
                                    audit.record("webhook_out.failed", &url, Some(serde_json::json!({ "event": event, "error": e })));
                                }
                            }
                        });
                    }
                }
            });

            let jobs = JobManager::with_handle(tauri::async_runtime::handle().inner().clone(), sink.clone());
            let env = AgentEnv::new(gateway, registry.clone(), state.media.clone(), sink);

            // 注册全部 Agent 处理器
            onetv_core::agent::executor::register_all_handlers(env.clone(), &jobs);

            // 设置同步：离线模式 / 并发 / 生成模型默认 / 预算守卫 / QC 媒体定位
            let s = state.settings.get();
            env.set_offline(s.offline_mode);
            env.set_auto_memory(s.auto_memory);
            env.set_custom_instructions(s.custom_instructions.clone());
            jobs.set_concurrency(s.max_concurrent_jobs);
            env.set_model_defaults(model_defaults_map(&s));
            jobs.set_media(state.media.clone());
            jobs.set_cost_guard(onetv_core::jobs::CostGuardConfig {
                enabled: s.cost_guard.enabled,
                daily_remote_limit: s.cost_guard.daily_remote_limit,
                project_total_limit: s.cost_guard.project_total_limit,
                daily_cost_limit: s.cost_guard.daily_cost_limit,
                project_cost_limit: s.cost_guard.project_cost_limit,
            });
            jobs.set_pricing(pricing_map(&registry.read()));

            let agent_state = Arc::new(AgentState {
                env,
                jobs,
                plans: Mutex::new(std::collections::HashMap::new()),
                registry,
            });
            let _ = AGENT.set(agent_state.clone());
            app.manage(agent_state);

            // 启动时自动恢复上次打开的工程（BUG：重启后显示"未打开项目"，需手动重开）
            if let Some(last) = state.settings.get().last_project.clone() {
                let dir = PathBuf::from(&last);
                if dir.join("project.json").is_file() {
                    match ops::open_project(&dir) {
                        Ok((handle, manifest)) => {
                            state.settings.touch_recent(&last, &manifest.project.title);
                            if let Some(agent) = AGENT.get() {
                                agent.jobs.set_project_root(Some(dir.clone()));
                                let resumed = agent.jobs.resume_on_restart();
                                if resumed > 0 {
                                    tracing::info!(resumed, "jobs resumed on startup restore");
                                }
                            }
                            {
                                let mut p = state.project.write();
                                p.handle = Some(handle);
                                p.manifest = Some(manifest);
                            }
                            tracing::info!(path = %last, "restored last project on startup");
                        }
                        Err(e) => {
                            tracing::warn!(path = %last, error = %e, "failed to restore last project");
                        }
                    }
                } else {
                    tracing::warn!(path = %last, "last project no longer exists");
                }
            }

            // Hermes 反向控制监听（按设置启用；默认关闭）
            let s_snapshot = state.settings.get();
            if let Err(e) = hermes_restart_listener(&state, &s_snapshot) {
                tracing::warn!(error = e.message, "hermes listener failed to start");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_update,
            app_info,
            ffmpeg_status,
            workspace_recent_list,
            workspace_recent_add,
            pick_directory,
            pick_file,
            project_create,
            project_open,
            project_close,
            project_info,
            episode_list,
            episode_create,
            episode_delete,
            project_delete,
            workspace_recent_remove,
            doc_get,
            doc_save,
            project_rename,
            canvas_get,
            canvas_save,
            timeline_get,
            timeline_save,
            timeline_render,
            timeline_probe_asset,
            export_render,
            asset_import,
            asset_list,
            asset_delete,
            secure_key_set,
            secure_key_delete,
            secure_key_exists,
            secure_key_list,
            audit_recent,
            agent_chat,
            agent_approve,
            job_list,
            job_events,
            job_cancel,
            job_retry,
            job_approve,
            provider_list,
            provider_save,
            provider_delete,
            provider_test,
            provider_models,
            playground_test,
            skill_list,
            skill_install,
            skill_uninstall,
            video_understand,
            project_export_pkg,
            project_import_pkg,
            theme_set_skin,
            theme_clear_skin,
            auth_status,
            auth_login,
            auth_logout,
            auth_change_credentials,
            auth_reset_with_email,
            mail_config_save,
            mail_config_get,
            mail_test_send,
            auth_send_code,
            debug_set_time_offset,
            debug_session_status,
            agent_attach,
            canvas_node_run,
            provider_preset_list,
            provider_fetch_models,
            bible_get,
            costs_get,
            skill_install_git,
            recreate_canvas,
            canvas_run_batch,
            memory_search,
            webhook_listen_start,
            webhook_listen_stop,
            plugin_list,
            plugin_get,
            plugin_render_prompt,
            provider_export,
            provider_import,
            bible_save,
            bible_generate,
            agent_attach_path,
            agent_attach_data,
            asset_open,
            asset_reveal,
            memory_list,
            memory_add,
            memory_update,
            memory_delete,
            hermes_config_get,
            hermes_config_save,
            hermes_test,
            hermes_send,
            hermes_log_recent,
        ])
        .on_window_event(|window, event| {
            // macOS 惯例：点红色关闭按钮 = 隐藏窗口，应用驻留后台（不退出）
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building OneTV")
        .run(|app_handle, event| match event {
            // 点击 Dock 图标 / Reopen：重新显示主窗口（Reopen 事件仅存在于 macOS）
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(w) = app_handle.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
            }
            // 关闭最后一个窗口触发的退出请求 → 阻止，应用保持运行
            tauri::RunEvent::ExitRequested { api, code, .. } => {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// v2.3.4 回归：前端 camelCase 入参必须能反序列化（此前缺 rename_all 导致
    /// "missing field 'workspace_path'"，新建项目 100% 失败）。
    #[test]
    fn create_project_input_accepts_camel_case() {
        let raw = serde_json::json!({
            "workspacePath": "/tmp/demo",
            "projectTitle": "测试剧",
            "aspectRatio": "16:9"
        });
        let input: CreateProjectInput = serde_json::from_value(raw).expect("camelCase 反序列化失败");
        assert_eq!(input.workspace_path, "/tmp/demo");
        assert_eq!(input.project_title, "测试剧");
        assert_eq!(input.aspect_ratio, "16:9");
    }

    #[test]
    fn create_project_input_defaults_aspect() {
        let raw = serde_json::json!({
            "workspacePath": "/tmp/demo",
            "projectTitle": "测试剧"
        });
        let input: CreateProjectInput = serde_json::from_value(raw).unwrap();
        assert_eq!(input.aspect_ratio, "9:16");
    }

    /// 多版本导出（v2.13）：presets 两个 → 生成两份 Job params（键与 handler 契约逐字一致）。
    #[test]
    fn export_render_two_presets_build_two_job_params() {
        let params = export_job_params(
            "ep1",
            &["douyin_vertical".into(), "horizontal_1080p".into()],
            true,
            false,
        )
        .expect("两个合法预设应通过校验");
        assert_eq!(params.len(), 2);
        assert_eq!(params[0]["preset"], "douyin_vertical");
        assert_eq!(params[0]["episode"], "ep1");
        assert_eq!(params[0]["burnSubtitle"], true);
        assert_eq!(params[0]["includeSrt"], false);
        assert_eq!(params[1]["preset"], "horizontal_1080p");
        assert_eq!(params[1]["burnSubtitle"], true);
    }

    #[test]
    fn export_render_rejects_empty_and_unknown_presets() {
        let empty = export_job_params("ep1", &[], false, false).unwrap_err();
        assert!(empty.contains("至少选择一个"));
        let unknown = export_job_params("ep1", &["vertical_x".into()], false, false).unwrap_err();
        assert!(unknown.contains("vertical_x"));
    }
}
