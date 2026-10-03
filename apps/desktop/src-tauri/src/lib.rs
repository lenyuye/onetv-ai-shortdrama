//! OneTV 桌面端 Tauri 壳：命令层只做参数转换，业务在 onetv-* crates。

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::Arc;

use onetv_core::agent::executor::Executor;
use onetv_core::agent::{route_intent, AgentEnv, Plan};
use onetv_core::jobs::{EventSink, JobKind, JobManager};
use onetv_core::providers::gateway::Gateway;
use onetv_core::providers::router::ModelRouter;
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

#[tauri::command]
fn settings_update(state: TState, patch: serde_json::Value) -> Result<AppSettings, CommandError> {
    let out = state.settings.update(|s| apply_patch(s, &patch));
    state.sync_policy();
    if let Some(agent) = AGENT.get() {
        agent.env.set_offline(out.offline_mode);
        agent.jobs.set_concurrency(out.max_concurrent_jobs);
        agent.env.set_model_defaults(model_defaults_map(&out));
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
struct FfmpegStatus {
    ok: bool,
    ffmpeg_path: Option<String>,
    ffprobe_path: Option<String>,
    ffmpeg_version: Option<String>,
    message: String,
}

#[tauri::command]
fn ffmpeg_status(state: TState) -> FfmpegStatus {
    match state.media.resolve() {
        Ok(r) => FfmpegStatus {
            ok: true,
            ffmpeg_path: Some(r.ffmpeg.to_string_lossy().into_owned()),
            ffprobe_path: Some(r.ffprobe.to_string_lossy().into_owned()),
            ffmpeg_version: r.version,
            message: "FFmpeg 就绪（本地合成可用）".into(),
        },
        Err(e) => FfmpegStatus {
            ok: false,
            ffmpeg_path: None,
            ffprobe_path: None,
            ffmpeg_version: None,
            message: e.to_string(),
        },
    }
}

/* ---------------- 最近项目 ---------------- */

#[derive(Serialize)]
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
fn project_delete(state: TState, project_dir: String) -> Result<(), CommandError> {
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
    std::fs::remove_dir_all(&dir).map_err(err)?;
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
struct AgentChatResult {
    plan: Plan,
    auto_executed: bool,
    job_ids: Vec<String>,
}

#[tauri::command]
async fn agent_chat(
    state: tauri::State<'_, Arc<AppState>>,
    agent: tauri::State<'_, Arc<AgentState>>,
    text: String,
    provider_id: Option<String>,
    model_id: Option<String>,
) -> Result<AgentChatResult, CommandError> {
    let episode = {
        let p = state.project.read();
        p.manifest.as_ref().and_then(|m| m.episodes.first().map(|e| e.id.clone()))
    };
    let intent = route_intent(&text);
    let mut plan = onetv_core::agent::build_plan(intent, &text, episode.as_deref());
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
            p.handle
                .as_ref()
                .map(|h| h.root().clone())
                .unwrap_or_else(std::env::temp_dir)
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
            "capabilities": m.capabilities.iter().map(|c| c.as_str()).collect::<Vec<_>>()
        })).collect::<Vec<_>>(),
        "timeoutMs": p.timeout_ms,
        "concurrency": p.concurrency,
        "enabled": p.enabled,
        "hasKey": has_key,
        "httpTemplate": p.http_template,
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
        ProviderDriverKind::Comfyui => (&[Cap::ImageGeneration], "ComfyUI（仅生图）"),
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
        ProviderDriverKind::CustomHttp | ProviderDriverKind::Comfyui | ProviderDriverKind::Plugin => {
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

fn mail_config_of(email: &str) -> Option<(onetv_core::mail::MailConfig, String)> {
    let configs = mail_store();
    let cfg = configs.iter().find(|c| c.email == email)?.clone();
    let secret = onetv_security::SecretStore::get(&format!("mail/{email}")).ok().flatten()?;
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
    onetv_security::SecretStore::set(&format!("mail/{email}"), &auth_code).map_err(err)?;
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
    // 已配置 SMTP 的邮箱：必须先通过验证码（v2.2 要求）
    if let Some(e) = email.as_deref().map(|s| s.to_string()).or_else(|| state.auth.info().and_then(|i| i.email)) {
        let e = e.to_lowercase();
        if mail_config_of(&e).is_some() {
            let Some(code) = &email_code else {
                return Err(err("该邮箱已启用验证码验证：请先点击「发送验证码」并填入邮件中的 6 位验证码"));
            };
            verify_store_named()
                .verify(&e, "change", code)
                .map_err(err)?;
        }
    }
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
    if mail_config_of(&e).is_some() {
        let Some(code) = &email_code else {
            return Err(err("该邮箱已启用验证码验证：请先点击「发送验证码」并填入邮件中的 6 位验证码"));
        };
        verify_store_named()
            .verify(&e, "reset", code)
            .map_err(err)?;
    }
    state
        .auth
        .reset_with_email(&email, &new_password)
        .map_err(err)?;
    state.audit.record("auth.reset_with_email", "", None);
    Ok(serde_json::json!({ "ok": true }))
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
) -> Result<serde_json::Value, CommandError> {
    let (root, manifest) = open_ctx(&state)?;
    let default_name = format!("{}.ytv.zip", manifest.project.title);
    let Some(dest) = save_path(&app, "导出工程包".into(), default_name).await else {
        return Err(err("已取消"));
    };
    let path = onetv_core::pkg::export_project(&root, &dest).map_err(err)?;
    state.audit.record("project.export_pkg", &path.to_string_lossy(), None);
    Ok(serde_json::json!({ "ok": true, "path": path.to_string_lossy() }))
}

#[tauri::command]
async fn project_import_pkg(
    state: tauri::State<'_, Arc<AppState>>,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, CommandError> {
    let Some(zip_path) = pick_path(&app, "选择 .ytv.zip 工程包".into(), false).await else {
        return Err(err("已取消"));
    };
    let Some(parent) = pick_path(&app, "选择导入位置".into(), true).await else {
        return Err(err("已取消"));
    };
    let path = onetv_core::pkg::import_project(&zip_path, &parent).map_err(err)?;
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
#[tauri::command]
fn agent_attach_path(state: TState, path: String) -> Result<serde_json::Value, CommandError> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(err(format!("文件不存在: {path}")));
    }
    agent_attach_import(&state, &p)
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
fn agent_attach_data(
    state: TState,
    name: String,
    data_b64: String,
) -> Result<serde_json::Value, CommandError> {
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
    let result = agent_attach_import(&state, &tmp_path);
    let _ = std::fs::remove_dir_all(&tmp_dir); // 导入即复制进工程，临时文件即删
    result
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
        "text" | "script" | "storyboard" | "condition" | "review" | "export" => {
            return Err(err(format!(
                "节点类型「{node_type}」暂不支持面板直发生成；图片/视频/音频节点可直接生成"
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

/* ---------------- 意识模块：记忆（v2.3.5+） ---------------- */

#[tauri::command]
fn memory_list(state: TState) -> Result<Vec<onetv_project::ops::MemoryRecord>, CommandError> {
    let (root, _) = open_ctx(&state)?;
    onetv_project::ops::list_memories(&root).map_err(err)
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
            if let Some(t) = &token {
                if token_header.as_deref() != Some(t.as_str()) {
                    (401, serde_json::json!({ "error": "token 不匹配" }))
                } else {
                    hermes_invoke(&state, &env, &jobs, &body).await
                }
            } else {
                hermes_invoke(&state, &env, &jobs, &body).await
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
    let json = serde_json::to_string_pretty(&doc).map_err(err)?;
    std::fs::write(path, json).map_err(err)?;

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

fn serve_asset(state: &AppState, uri: &tauri::http::Uri) -> tauri::http::Response<Cow<'static, [u8]>> {
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
    let Ok(bytes) = std::fs::read(&canon) else {
        return not_found();
    };
    drop(guard);
    tauri::http::Response::builder()
        .header("Content-Type", mime_of(&canon))
        .header("Cache-Control", "no-store")
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
        .manage(state.clone())
        .register_uri_scheme_protocol("onetv-asset", |ctx, request| {
            let st = ctx.app_handle().state::<Arc<AppState>>();
            serve_asset(&st, request.uri())
        })
        .register_uri_scheme_protocol("onetv-app", |ctx, request| {
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

            // 事件桥（Rust → 前端）
            let h2 = handle.clone();
            let sink: EventSink = Arc::new(move |name: &str, payload: serde_json::Value| {
                let _ = h2.emit(name, payload);
            });

            let gateway = Arc::new(Gateway::new(state.policy.clone(), state.audit.clone()));
            let jobs = JobManager::with_handle(tauri::async_runtime::handle().inner().clone(), sink.clone());
            let env = AgentEnv::new(gateway, registry.clone(), state.media.clone(), sink);

            // 注册全部 Agent 处理器
            onetv_core::agent::executor::register_all_handlers(env.clone(), &jobs);

            // 设置同步：离线模式 / 并发 / 生成模型默认
            let s = state.settings.get();
            env.set_offline(s.offline_mode);
            jobs.set_concurrency(s.max_concurrent_jobs);
            env.set_model_defaults(model_defaults_map(&s));

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
            canvas_get,
            canvas_save,
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
            // 点击 Dock 图标 / Reopen：重新显示主窗口
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
}
