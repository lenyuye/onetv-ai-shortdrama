//! Job Queue / 状态机（规格 §11）。
//!
//! QUEUED → VALIDATING → (AWAITING_APPROVAL) → SUBMITTING → RUNNING
//!        → DOWNLOADING → POST_PROCESSING → SUCCEEDED
//!        → FAILED → RETRY_WAIT → QUEUED（指数退避，只重试可重试错误）
//!        → CANCELED
//!
//! 持久化于 SQLite jobs/job_events；重启后未完成任务恢复调度；
//! 幂等键 hash(input+model+params) 防重复扣费。

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use futures::future::BoxFuture;
use parking_lot::{Mutex, RwLock};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

pub type EventSink = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/* ---------------- 数据结构 ---------------- */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum JobState {
    Queued,
    Validating,
    AwaitingApproval,
    Submitting,
    Running,
    Downloading,
    PostProcessing,
    Succeeded,
    Failed,
    RetryWait,
    Canceled,
}

impl JobState {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobState::Queued => "QUEUED",
            JobState::Validating => "VALIDATING",
            JobState::AwaitingApproval => "AWAITING_APPROVAL",
            JobState::Submitting => "SUBMITTING",
            JobState::Running => "RUNNING",
            JobState::Downloading => "DOWNLOADING",
            JobState::PostProcessing => "POST_PROCESSING",
            JobState::Succeeded => "SUCCEEDED",
            JobState::Failed => "FAILED",
            JobState::RetryWait => "RETRY_WAIT",
            JobState::Canceled => "CANCELED",
        }
    }
    pub fn is_terminal(&self) -> bool {
        matches!(self, JobState::Succeeded | JobState::Failed | JobState::Canceled)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JobKind {
    Chat,
    Script,
    ImageGeneration,
    VideoGeneration,
    Tts,
    TimelineRender,
    Export,
    VideoUnderstand,
}

impl JobKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            JobKind::Chat => "chat",
            JobKind::Script => "script",
            JobKind::ImageGeneration => "image_generation",
            JobKind::VideoGeneration => "video_generation",
            JobKind::Tts => "tts",
            JobKind::TimelineRender => "timeline_render",
            JobKind::Export => "export",
            JobKind::VideoUnderstand => "video_understand",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "script" => JobKind::Script,
            "image_generation" => JobKind::ImageGeneration,
            "video_generation" => JobKind::VideoGeneration,
            "tts" => JobKind::Tts,
            "timeline_render" => JobKind::TimelineRender,
            "export" => JobKind::Export,
            "video_understand" => JobKind::VideoUnderstand,
            _ => JobKind::Chat,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct JobRecord {
    pub id: String,
    pub kind: JobKind,
    pub title: String,
    pub state: JobState,
    pub progress: f64,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub node_id: Option<String>,
    pub episode_id: Option<String>,
    pub params: serde_json::Value,
    pub egress: Option<serde_json::Value>,
    pub error: Option<String>,
    pub remote_job_id: Option<String>,
    pub idempotency_key: String,
    pub attempts: u32,
    pub outputs: Vec<String>,
    /// 任务结果元数据：非文件类产出（如对话回复文本）与 provider/model 归属，随任务落库。
    #[serde(default)]
    pub result: serde_json::Value,
    pub created_at: String,
    pub updated_at: String,
}

pub struct JobContext {
    pub job_id: String,
    pub params: serde_json::Value,
    pub root: PathBuf,
    pub episode_id: Option<String>,
    pub cancel: Arc<AtomicBool>,
    progress: Arc<dyn Fn(f64, &str) + Send + Sync>,
    /// 处理器回写结果元数据（providerId/model/reply），立即持久化到 jobs 表。
    set_meta: Arc<dyn Fn(serde_json::Value) + Send + Sync>,
}

impl JobContext {
    pub fn report(&self, p: f64, msg: &str) {
        (self.progress)(p.clamp(0.0, 1.0), msg);
    }
    pub fn set_meta(&self, meta: serde_json::Value) {
        (self.set_meta)(meta);
    }
    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// 测试/工具用构造器
    #[allow(clippy::too_many_arguments)]
    pub fn for_test(
        job_id: &str,
        params: serde_json::Value,
        root: PathBuf,
        episode_id: Option<String>,
    ) -> Self {
        Self {
            job_id: job_id.into(),
            params,
            root,
            episode_id,
            cancel: Arc::new(AtomicBool::new(false)),
            progress: Arc::new(|_, _| {}),
            set_meta: Arc::new(|_| {}),
        }
    }
}

pub type JobHandler =
    Arc<dyn Fn(JobContext) -> BoxFuture<'static, Result<Vec<String>, JobError>> + Send + Sync>;

#[derive(Debug, Clone, serde::Serialize)]
pub struct JobError {
    pub message: String,
    /// 网络超时/5xx/429 → 可重试；401/参数错误 → 不可重试
    pub retryable: bool,
}

impl JobError {
    pub fn fatal(m: impl Into<String>) -> Self {
        Self { message: m.into(), retryable: false }
    }
    pub fn transient(m: impl Into<String>) -> Self {
        Self { message: m.into(), retryable: true }
    }
}

/* ---------------- 引擎 ---------------- */

struct Runtime {
    handlers: RwLock<HashMap<JobKind, JobHandler>>,
    cancel_flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
    concurrency: AtomicU32,
    active: AtomicU32,
}

pub struct JobManager {
    rt: Arc<Runtime>,
    root: RwLock<Option<PathBuf>>,
    events: EventSink,
    /// 新任务进入队列时通知调度器
    scheduler_tx: tokio::sync::mpsc::UnboundedSender<()>,
    /// tokio 运行时句柄（Tauri setup 时无异步上下文，必须显式提供）
    runtime: tokio::runtime::Handle,
}

const MAX_ATTEMPTS: u32 = 3;

impl JobManager {
    pub fn new(events: EventSink) -> Arc<Self> {
        Self::with_handle(tokio::runtime::Handle::try_current().expect("JobManager::new 需要在 tokio 上下文中调用，或改用 with_handle"), events)
    }

    pub fn with_handle(runtime: tokio::runtime::Handle, events: EventSink) -> Arc<Self> {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let mgr = Arc::new(Self {
            rt: Arc::new(Runtime {
                handlers: RwLock::new(HashMap::new()),
                cancel_flags: Mutex::new(HashMap::new()),
                concurrency: AtomicU32::new(2),
                active: AtomicU32::new(0),
            }),
            root: RwLock::new(None),
            events,
            scheduler_tx: tx,
            runtime: runtime.clone(),
        });
        // 调度循环
        let weak = Arc::downgrade(&mgr);
        runtime.spawn(async move {
            while rx.recv().await.is_some() {
                let Some(mgr) = weak.upgrade() else { break };
                mgr.schedule_ready();
            }
        });
        mgr
    }

    fn spawn_task<F>(&self, fut: F)
    where
        F: std::future::Future<Output = ()> + Send + 'static,
    {
        self.runtime.spawn(fut);
    }

    pub fn set_project_root(&self, root: Option<PathBuf>) {
        *self.root.write() = root;
    }

    pub fn set_concurrency(&self, n: u32) {
        self.rt.concurrency.store(n.clamp(1, 8), Ordering::Relaxed);
    }

    pub fn register_handler(&self, kind: JobKind, handler: JobHandler) {
        self.rt.handlers.write().insert(kind, handler);
    }

    fn db(&self) -> Option<Connection> {
        let root = self.root.read().clone()?;
        onetv_project::db::open(&root.join("database.sqlite")).ok()
    }

    /* ---- 持久化 ---- */

    fn persist(&self, job: &JobRecord) {
        if let Some(conn) = self.db() {
            let _ = conn.execute(
                "INSERT INTO jobs(id, node_id, episode_id, kind, provider_id, model, params_json, state, progress, title, cost_json, error, remote_job_id, idempotency_key, attempts, result_json, created_at, updated_at)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
                 ON CONFLICT(id) DO UPDATE SET state=?8, progress=?9, error=?12, remote_job_id=?13, attempts=?15, result_json=?16, provider_id=?5, model=?6, updated_at=?18",
                rusqlite::params![
                    job.id, job.node_id, job.episode_id, job.kind.as_str(), job.provider_id,
                    job.model, serde_json::to_string(&job.params).unwrap_or_default(),
                    job.state.as_str(), job.progress, job.title, "{}",
                    job.error, job.remote_job_id, job.idempotency_key,
                    job.attempts, serde_json::to_string(&job.result).unwrap_or_default(),
                    job.created_at, job.updated_at
                ],
            );
        }
    }

    fn add_event(&self, job_id: &str, event_type: &str, payload: serde_json::Value) {
        if let Some(conn) = self.db() {
            let _ = conn.execute(
                "INSERT INTO job_events(job_id, seq, event_type, payload_json, time)
                 VALUES (?1, COALESCE((SELECT MAX(seq)+1 FROM job_events WHERE job_id=?1), 0), ?2, ?3, ?4)",
                rusqlite::params![job_id, event_type, payload.to_string(), chrono::Utc::now().to_rfc3339()],
            );
        }
    }

    /* ---- 创建/控制 ---- */

    #[allow(clippy::too_many_arguments)]
    pub fn create_job(
        &self,
        kind: JobKind,
        title: impl Into<String>,
        provider_id: Option<String>,
        model: Option<String>,
        params: serde_json::Value,
        node_id: Option<String>,
        episode_id: Option<String>,
        require_approval: bool,
        egress: Option<serde_json::Value>,
    ) -> JobRecord {
        // 幂等：相同输入+模型+参数 且已成功 → 直接复用，不重复提交
        let idempotency_key = idempotency_hash(&kind, &model, &params);
        // 幂等：已成功 → 复用；仍在队列/运行中 → 复用，防止重复提交扣费（规格 §11.2）
        if let Some(existing) = self.find_existing_by_key(&idempotency_key) {
            return existing;
        }
        let id = format!("job_{}", uuid::Uuid::new_v4().simple());
        let now = chrono::Utc::now().to_rfc3339();
        let job = JobRecord {
            id: id.clone(),
            kind,
            title: title.into(),
            state: if require_approval { JobState::AwaitingApproval } else { JobState::Queued },
            progress: 0.0,
            provider_id,
            model,
            node_id,
            episode_id,
            params,
            egress,
            error: None,
            remote_job_id: None,
            idempotency_key,
            attempts: 0,
            outputs: Vec::new(),
            result: serde_json::json!({}),
            created_at: now.clone(),
            updated_at: now,
        };
        self.persist(&job);
        self.add_event(&id, "created", serde_json::json!({"title": job.title, "state": job.state.as_str()}));
        self.emit("job.created", job_public(&job));
        if job.state == JobState::AwaitingApproval {
            self.emit("job.awaitingApproval", serde_json::json!({
                "job": job_public(&job),
                "egress": job.egress,
                "message": "该任务将向远程 Provider 发送数据，请确认"
            }));
        } else {
            let _ = self.scheduler_tx.send(());
        }
        job
    }

    /// 幂等去重只对「仍在途」的任务生效（排队/运行中）：防止重复提交扣费。
    /// 已成功/失败/取消的任务不再拦截 —— 否则用户再次批准同一计划时会静默复用
    /// 旧任务、不产生任何新任务（表现即"批准执行后零任务产生"）。
    fn find_existing_by_key(&self, key: &str) -> Option<JobRecord> {
        let conn = self.db()?;
        conn.query_row(
            "SELECT id, provider_id, model, title FROM jobs
             WHERE idempotency_key = ?1
               AND state IN ('QUEUED','VALIDATING','AWAITING_APPROVAL','SUBMITTING','RUNNING','DOWNLOADING','POST_PROCESSING','RETRY_WAIT')
             ORDER BY created_at DESC LIMIT 1",
            [key],
            |r| {
                Ok(JobRecord {
                    id: r.get::<_, String>(0)?,
                    kind: JobKind::Chat, // 幂等复用仅用于展示
                    title: r.get::<_, String>(3)?,
                    state: JobState::Queued,
                    progress: 0.0,
                    provider_id: r.get(1)?,
                    model: r.get(2)?,
                    node_id: None,
                    episode_id: None,
                    params: serde_json::json!({}),
                    egress: None,
                    error: None,
                    remote_job_id: None,
                    idempotency_key: key.into(),
                    attempts: 1,
                    outputs: Vec::new(),
                    result: serde_json::json!({}),
                    created_at: String::new(),
                    updated_at: String::new(),
                })
            },
        )
        .ok()
    }

    pub fn approve(&self, job_id: &str) -> Result<(), String> {
        let mut job = self.load(job_id).ok_or("任务不存在")?;
        if job.state != JobState::AwaitingApproval {
            return Err(format!("任务状态为 {}，无法批准", job.state.as_str()));
        }
        job.state = JobState::Queued;
        job.updated_at = now();
        self.persist(&job);
        self.add_event(job_id, "approved", serde_json::json!({}));
        self.emit("job.progress", job_public(&job));
        self.emit("agent.plan.approved", serde_json::json!({"jobId": job_id}));
        let _ = self.scheduler_tx.send(());
        Ok(())
    }

    pub fn cancel(&self, job_id: &str) -> Result<(), String> {
        if let Some(flag) = self.rt.cancel_flags.lock().get(job_id).cloned() {
            flag.store(true, Ordering::Relaxed);
        }
        let mut job = self.load(job_id).ok_or("任务不存在")?;
        if job.state.is_terminal() {
            return Ok(());
        }
        job.state = JobState::Canceled;
        job.updated_at = now();
        self.persist(&job);
        self.add_event(job_id, "canceled", serde_json::json!({}));
        self.emit("job.progress", job_public(&job));
        Ok(())
    }

    pub fn retry(&self, job_id: &str) -> Result<(), String> {
        let mut job = self.load(job_id).ok_or("任务不存在")?;
        if !matches!(job.state, JobState::Failed | JobState::Canceled) {
            return Err("只有失败/取消的任务可以重试".into());
        }
        job.state = JobState::Queued;
        job.error = None;
        job.attempts = 0;
        job.updated_at = now();
        self.persist(&job);
        let _ = self.scheduler_tx.send(());
        Ok(())
    }

    pub fn load(&self, job_id: &str) -> Option<JobRecord> {
        let conn = self.db()?;
        query_job(&conn, job_id)
    }

    pub fn list(&self, limit: u32) -> Vec<JobRecord> {
        let Some(conn) = self.db() else { return vec![] };
        let mut stmt = match conn.prepare("SELECT id FROM jobs ORDER BY created_at DESC LIMIT ?1") {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        let ids: Vec<String> = stmt
            .query_map([limit], |r| r.get::<_, String>(0))
            .ok()
            .map(|rows| rows.filter_map(|r| r.ok()).collect())
            .unwrap_or_default();
        ids.iter().filter_map(|id| query_job(&conn, id)).collect()
    }

    pub fn events_of(&self, job_id: &str) -> Vec<(String, String, String)> {
        let Some(conn) = self.db() else { return vec![] };
        let mut stmt = match conn.prepare(
            "SELECT event_type, payload_json, time FROM job_events WHERE job_id = ?1 ORDER BY seq",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };
        stmt.query_map([job_id], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })
        .ok()
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
    }

    /// 应用启动恢复：非终态任务重新排队（幂等键防止远程重复扣费）。
    pub fn resume_on_restart(&self) -> usize {
        let Some(conn) = self.db() else { return 0 };
        let ids: Vec<String> = {
            let mut stmt = match conn.prepare(
                "SELECT id FROM jobs WHERE state IN ('QUEUED','VALIDATING','SUBMITTING','RUNNING','DOWNLOADING','POST_PROCESSING','RETRY_WAIT','AWAITING_APPROVAL')",
            ) {
                Ok(s) => s,
                Err(_) => return 0,
            };
            stmt.query_map([], |r| r.get::<_, String>(0))
                .ok()
                .map(|rows| rows.filter_map(|r| r.ok()).collect())
                .unwrap_or_default()
        };
        let n = ids.len();
        for id in ids {
            let _ = conn.execute(
                "UPDATE jobs SET state='QUEUED', error=COALESCE(error, '应用重启后恢复排队（幂等保护，未重复提交）'), updated_at=?2 WHERE id=?1 AND state IN ('VALIDATING','SUBMITTING','RUNNING','DOWNLOADING','POST_PROCESSING','RETRY_WAIT')",
                rusqlite::params![id, now()],
            );
        }
        if n > 0 {
            let _ = self.scheduler_tx.send(());
        }
        n
    }

    /* ---- 调度 ---- */

    fn schedule_ready(&self) {
        let limit = self.rt.concurrency.load(Ordering::Relaxed) as usize;
        while (self.rt.active.load(Ordering::Relaxed) as usize) < limit {
            let Some(mut job) = self.next_queued() else { break };
            let Some(handler) = self.rt.handlers.read().get(&job.kind).cloned() else {
                job.state = JobState::Failed;
                job.error = Some("没有注册该任务类型的处理器".into());
                job.updated_at = now();
                self.persist(&job);
                self.emit("job.failed", job_public(&job));
                continue;
            };
            job.state = JobState::Validating;
            job.attempts += 1;
            job.updated_at = now();
            self.persist(&job);

            let mgr = Arc::new(Self {
                rt: self.rt.clone(),
                root: RwLock::new(self.root.read().clone()),
                events: self.events.clone(),
                scheduler_tx: self.scheduler_tx.clone(),
                runtime: self.runtime.clone(),
            });
            let root = self.root.read().clone();
            let cancel = Arc::new(AtomicBool::new(false));
            self.rt.cancel_flags.lock().insert(job.id.clone(), cancel.clone());
            self.rt.active.fetch_add(1, Ordering::Relaxed);

            let job_id = job.id.clone();
            let mgr2 = mgr.clone();
            let spawn = mgr2.clone();
            mgr.spawn_task(async move {
                let _ = &spawn;
                let mgr3 = mgr2.clone();
                mgr3.run_job(job, root, cancel, handler).await;
                mgr2.rt.active.fetch_sub(1, Ordering::Relaxed);
                mgr2.rt.cancel_flags.lock().remove(&job_id);
                let _ = mgr2.scheduler_tx.send(()); // 触发下一个调度
            });
        }
    }

    fn next_queued(&self) -> Option<JobRecord> {
        let conn = self.db()?;
        let id: String = conn
            .query_row(
                "SELECT id FROM jobs WHERE state='QUEUED' ORDER BY created_at LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok()?;
        query_job(&conn, &id)
    }

    async fn run_job(
        self: Arc<Self>,
        mut job: JobRecord,
        root: Option<PathBuf>,
        cancel: Arc<AtomicBool>,
        handler: JobHandler,
    ) {
        let Some(root) = root else {
            self.finish_failed(&mut job, "项目未打开".into(), false).await;
            return;
        };
        let mgr = self.clone();
        let job_id = job.id.clone();
        let persist_progress: Arc<dyn Fn(f64, &str) + Send + Sync> = {
            let mgr2 = mgr.clone();
            let job_id2 = job_id.clone();
            Arc::new(move |p, msg| {
                if let Some(mut j) = mgr2.load(&job_id2) {
                    j.progress = p;
                    j.updated_at = now();
                    mgr2.persist(&j);
                    mgr2.emit("job.progress", serde_json::json!({
                        "job": job_public(&j), "message": msg
                    }));
                }
            })
        };
        // 处理器回写的结果元数据（provider/model/reply）：本地快照 + 立即落库
        let meta_snapshot: Arc<RwLock<serde_json::Value>> = Arc::new(RwLock::new(serde_json::json!({})));
        let set_meta: Arc<dyn Fn(serde_json::Value) + Send + Sync> = {
            let mgr2 = mgr.clone();
            let job_id2 = job_id.clone();
            let snapshot = meta_snapshot.clone();
            Arc::new(move |meta| {
                *snapshot.write() = meta.clone();
                if let Some(mut j) = mgr2.load(&job_id2) {
                    if let Some(p) = meta.get("providerId").and_then(|v| v.as_str()) {
                        j.provider_id = Some(p.to_string());
                    }
                    if let Some(m) = meta.get("model").and_then(|v| v.as_str()) {
                        j.model = Some(m.to_string());
                    }
                    if let Some(r) = meta.get("reply") {
                        j.result["reply"] = r.clone();
                        mgr2.add_event(&job_id2, "reply", serde_json::json!({"text": r}));
                    }
                    j.updated_at = now();
                    mgr2.persist(&j);
                }
            })
        };

        // 状态推进：VALIDATING → RUNNING
        for st in [JobState::Submitting, JobState::Running] {
            job.state = st;
            job.updated_at = now();
            mgr.persist(&job);
            mgr.add_event(&job_id, "state", serde_json::json!({"state": st.as_str()}));
            mgr.emit("job.progress", job_public(&job));
        }

        let ctx = JobContext {
            job_id: job_id.clone(),
            params: job.params.clone(),
            root,
            episode_id: job.episode_id.clone(),
            cancel,
            progress: persist_progress,
            set_meta,
        };

        let cancel_for_check = ctx.cancel.clone();
        let result = handler(ctx).await;

        match result {
            Ok(outputs) => {
                job.state = JobState::PostProcessing;
                job.updated_at = now();
                mgr.persist(&job);
                // 结果注册为资产（hash 去重）
                let mut asset_ids = Vec::new();
                if let Some(rootp) = mgr.root.read().clone() {
                    for out in &outputs {
                        let p = PathBuf::from(out);
                        if !p.exists() {
                            continue;
                        }
                        if let Ok(rec) = onetv_project::ops::import_asset(&rootp, &p, kind_dir(&job.kind)) {
                            asset_ids.push(rec.id);
                        }
                    }
                }
                job.state = JobState::Succeeded;
                job.progress = 1.0;
                job.outputs = asset_ids;
                job.error = None;
                job.updated_at = now();
                // 非文件产出（如对话回复）随成功状态落库
                job.result = meta_snapshot.read().clone();
                // 产物资产 id 一并持久化进 result_json：query_job 重建时据此还原 outputs，
                // 否则 job_list / job 事件里的 outputs 恒为空（节点生成面板无法回填 outputAssetId）
                job.result["outputs"] = serde_json::json!(job.outputs);
                mgr.persist(&job);
                mgr.add_event(&job_id, "succeeded", serde_json::json!({
                    "outputs": job.outputs,
                    "reply": job.result.get("reply").cloned().unwrap_or(serde_json::Value::Null)
                }));
                mgr.emit("job.succeeded", job_public(&job));
            }
            Err(e) => {
                if cancel_for_check.load(Ordering::Relaxed) {
                    job.state = JobState::Canceled;
                    job.updated_at = now();
                    mgr.persist(&job);
                    mgr.emit("job.progress", job_public(&job));
                    return;
                }
                if e.retryable && job.attempts < MAX_ATTEMPTS {
                    let delay = backoff_ms(job.attempts);
                    job.state = JobState::RetryWait;
                    job.error = Some(e.message.clone());
                    job.updated_at = now();
                    mgr.persist(&job);
                    mgr.add_event(&job_id, "retry_wait", serde_json::json!({"attempt": job.attempts, "delayMs": delay, "error": e.message}));
                    mgr.emit("job.failed", serde_json::json!({
                        "job": job_public(&job),
                        "willRetry": true,
                        "retryIn": delay
                    }));
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                    // 回到 QUEUED
                    job.state = JobState::Queued;
                    job.updated_at = now();
                    mgr.persist(&job);
                    let _ = mgr.scheduler_tx.send(());
                } else {
                    mgr.finish_failed(&mut job, e.message, true).await;
                }
            }
        }
    }

    async fn finish_failed(&self, job: &mut JobRecord, message: String, emit: bool) {
        job.state = JobState::Failed;
        job.error = Some(onetv_security::redact::redact_text(&message));
        job.updated_at = now();
        self.persist(job);
        self.add_event(&job.id, "failed", serde_json::json!({"error": job.error}));
        if emit {
            self.emit("job.failed", serde_json::json!({"job": job_public(job), "willRetry": false}));
        }
    }

    fn emit(&self, name: &str, payload: serde_json::Value) {
        (self.events)(name, payload);
    }
}

/* ---------------- helpers ---------------- */

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn idempotency_hash(kind: &JobKind, model: &Option<String>, params: &serde_json::Value) -> String {
    let canon = serde_json::to_string(params).unwrap_or_default();
    format!("{:?}|{}|{}", kind, model.clone().unwrap_or_default(), canon)
}

fn backoff_ms(attempt: u32) -> u64 {
    // 2s, 8s, 32s 指数退避
    2000u64.saturating_mul(1u64 << (2 * (attempt.saturating_sub(1))))
}

fn kind_dir(kind: &JobKind) -> &'static str {
    match kind {
        JobKind::ImageGeneration => "images",
        JobKind::VideoGeneration | JobKind::TimelineRender | JobKind::Export => "videos",
        JobKind::Tts => "audio",
        _ => "references",
    }
}

fn query_job(conn: &Connection, id: &str) -> Option<JobRecord> {
    conn.query_row(
        "SELECT id, kind, title, state, progress, provider_id, model, node_id, episode_id, params_json, error, remote_job_id, idempotency_key, created_at, updated_at, attempts, result_json FROM jobs WHERE id = ?1",
        [id],
        |r| {
            let state_str: String = r.get(3)?;
            let state = match state_str.as_str() {
                "QUEUED" => JobState::Queued,
                "VALIDATING" => JobState::Validating,
                "AWAITING_APPROVAL" => JobState::AwaitingApproval,
                "SUBMITTING" => JobState::Submitting,
                "RUNNING" => JobState::Running,
                "DOWNLOADING" => JobState::Downloading,
                "POST_PROCESSING" => JobState::PostProcessing,
                "SUCCEEDED" => JobState::Succeeded,
                "RETRY_WAIT" => JobState::RetryWait,
                "CANCELED" => JobState::Canceled,
                _ => JobState::Failed,
            };
            let result: serde_json::Value =
                serde_json::from_str(&r.get::<_, String>(16).unwrap_or_default()).unwrap_or_default();
            // 从 result_json["outputs"] 还原产物资产 id（成功时由 run_job 持久化）
            let outputs = result
                .get("outputs")
                .and_then(|v| v.as_array())
                .map(|arr| arr.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            Ok(JobRecord {
                id: r.get(0)?,
                kind: JobKind::from_str(&r.get::<_, String>(1)?),
                title: r.get(2)?,
                state,
                progress: r.get::<_, f64>(4)?,
                provider_id: r.get(5)?,
                model: r.get(6)?,
                node_id: r.get(7)?,
                episode_id: r.get(8)?,
                params: serde_json::from_str(&r.get::<_, String>(9)?).unwrap_or_default(),
                egress: None,
                error: r.get(10)?,
                remote_job_id: r.get(11)?,
                idempotency_key: r.get(12)?,
                attempts: r.get::<_, i64>(15).unwrap_or(0).max(0) as u32,
                outputs,
                result,
                created_at: r.get(13)?,
                updated_at: r.get(14)?,
            })
        },
    )
    .ok()
}

fn job_public(job: &JobRecord) -> serde_json::Value {
    serde_json::json!({
        "id": job.id,
        "kind": job.kind.as_str(),
        "title": job.title,
        "state": job.state.as_str(),
        "progress": job.progress,
        "providerId": job.provider_id,
        "model": job.model,
        "nodeId": job.node_id,
        "episodeId": job.episode_id,
        "error": job.error,
        "attempts": job.attempts,
        "outputs": job.outputs,
        "reply": job.result.get("reply").cloned().unwrap_or(serde_json::Value::Null),
        "createdAt": job.created_at,
        "updatedAt": job.updated_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_is_exponential() {
        assert_eq!(backoff_ms(1), 2000);
        assert_eq!(backoff_ms(2), 8000);
        assert_eq!(backoff_ms(3), 32000);
    }

    #[test]
    fn idempotency_key_stable_for_same_input() {
        let a = idempotency_hash(&JobKind::VideoGeneration, &Some("m".into()), &serde_json::json!({"prompt": "x"}));
        let b = idempotency_hash(&JobKind::VideoGeneration, &Some("m".into()), &serde_json::json!({"prompt": "x"}));
        let c = idempotency_hash(&JobKind::VideoGeneration, &Some("m".into()), &serde_json::json!({"prompt": "y"}));
        assert_eq!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn state_names_and_terminal() {
        assert_eq!(JobState::AwaitingApproval.as_str(), "AWAITING_APPROVAL");
        assert!(JobState::Succeeded.is_terminal());
        assert!(!JobState::RetryWait.is_terminal());
    }
}
