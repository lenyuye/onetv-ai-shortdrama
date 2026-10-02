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

#[tauri::command]
fn settings_update(state: TState, patch: serde_json::Value) -> Result<AppSettings, CommandError> {
    let out = state.settings.update(|s| apply_patch(s, &patch));
    state.sync_policy();
    if let Some(agent) = AGENT.get() {
        agent.env.set_offline(out.offline_mode);
        agent.jobs.set_concurrency(out.max_concurrent_jobs);
    }
    Ok(out)
}

fn apply_patch(s: &mut AppSettings, patch: &serde_json::Value) {
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

fn save_path(app: &tauri::AppHandle, title: String, default_name: String) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel::<Option<PathBuf>>();
    app.dialog()
        .file()
        .set_title(title)
        .set_file_name(default_name)
        .save_file(move |f| {
            let _ = tx.send(f.and_then(|p| p.as_path().map(|p| p.to_path_buf())));
        });
    rx.recv().ok().flatten()
}

fn pick_path(app: &tauri::AppHandle, title: String, folder: bool) -> Option<PathBuf> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel::<Option<PathBuf>>();
    let dialog = app.dialog().file().set_title(title);
    if folder {
        dialog.pick_folder(move |f| {
            let _ = tx.send(f.and_then(|p| p.as_path().map(|p| p.to_path_buf())));
        });
    } else {
        dialog.pick_file(move |f| {
            let _ = tx.send(f.and_then(|p| p.as_path().map(|p| p.to_path_buf())));
        });
    }
    rx.recv().ok().flatten()
}

#[tauri::command]
fn pick_directory(app: tauri::AppHandle, title: String) -> Option<String> {
    pick_path(&app, title, true).map(|p| p.to_string_lossy().into_owned())
}

#[tauri::command]
fn pick_file(app: tauri::AppHandle, title: String) -> Option<String> {
    pick_path(&app, title, false).map(|p| p.to_string_lossy().into_owned())
}

/* ---------------- 项目 ---------------- */

#[derive(serde::Deserialize)]
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
) -> Result<AgentChatResult, CommandError> {
    let episode = {
        let p = state.project.read();
        p.manifest.as_ref().and_then(|m| m.episodes.first().map(|e| e.id.clone()))
    };
    let intent = route_intent(&text);
    let mut plan = onetv_core::agent::build_plan(intent, &text, episode.as_deref());
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
            "outputs": j.outputs, "createdAt": j.created_at, "updatedAt": j.updated_at
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
    })
}

fn profile_from_json(v: serde_json::Value) -> Result<onetv_core::providers::ProviderProfile, CommandError> {
    serde_json::from_value(v).map_err(err)
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
        ProviderDriverKind::CustomHttp | ProviderDriverKind::Comfyui | ProviderDriverKind::Plugin => {
            agent.env.gateway().check(&profile.base_url).map_err(|e| e.to_string())
        }
    };
    let latency = started.elapsed().as_millis() as u64;
    Ok(serde_json::json!({
        "ok": result.is_ok(),
        "message": result.err().unwrap_or_else(|| "连接成功".into()),
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
fn skill_install(state: TState, app: tauri::AppHandle) -> Result<serde_json::Value, CommandError> {
    let Some(dir) = pick_path(&app, "选择包含 skill.json 的 Skill 文件夹".into(), true) else {
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
fn project_export_pkg(
    state: TState,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, CommandError> {
    let (root, manifest) = open_ctx(&state)?;
    let default_name = format!("{}.ytv.zip", manifest.project.title);
    let Some(dest) = save_path(&app, "导出工程包".into(), default_name) else {
        return Err(err("已取消"));
    };
    let path = onetv_core::pkg::export_project(&root, &dest).map_err(err)?;
    state.audit.record("project.export_pkg", &path.to_string_lossy(), None);
    Ok(serde_json::json!({ "ok": true, "path": path.to_string_lossy() }))
}

#[tauri::command]
fn project_import_pkg(
    state: TState,
    app: tauri::AppHandle,
) -> Result<serde_json::Value, CommandError> {
    let Some(zip_path) = pick_path(&app, "选择 .ytv.zip 工程包".into(), false) else {
        return Err(err("已取消"));
    };
    let Some(parent) = pick_path(&app, "选择导入位置".into(), true) else {
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
fn asset_import(state: TState, app: tauri::AppHandle, kind: String) -> Result<onetv_project::ops::AssetRecord, CommandError> {
    let (root, _) = open_ctx(&state)?;
    let Some(path) = pick_path(&app, "选择要导入的素材文件".into(), false) else {
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

/* ---------------- 启动 ---------------- */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    onetv_core::init_tracing();

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
    // 内置 Skills 预置安装（开发环境仓库 skills/；打包后可经资源目录）
    if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
        let builtin = PathBuf::from(&manifest_dir).join("../../../skills");
        if builtin.is_dir() {
            onetv_core::skills::seed_builtin(&skills, &builtin);
        }
    }
    let state = Arc::new(AppState {
        settings,
        media,
        policy: policy.clone(),
        audit,
        project: RwLock::new(OpenedProject::default()),
        skills,
    });

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(state.clone())
        .register_uri_scheme_protocol("onetv-asset", |ctx, request| {
            let st = ctx.app_handle().state::<Arc<AppState>>();
            serve_asset(&st, request.uri())
        })
        .setup(move |app| {
            let handle = app.handle().clone();

            // Provider 注册表（首次启动自动内置 Mock 离线演示 Provider）
            let mut registry = ProviderRegistry::load(&data_dir);
            if registry.list().is_empty() {
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
                tracing::info!("seeded builtin mock provider");
            }
            let registry = Arc::new(RwLock::new(registry));

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

            // 设置同步：离线模式 / 并发
            let s = state.settings.get();
            env.set_offline(s.offline_mode);
            jobs.set_concurrency(s.max_concurrent_jobs);

            let agent_state = Arc::new(AgentState {
                env,
                jobs,
                plans: Mutex::new(std::collections::HashMap::new()),
                registry,
            });
            let _ = AGENT.set(agent_state.clone());
            app.manage(agent_state);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            settings_get,
            settings_update,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running OneTV");
}
