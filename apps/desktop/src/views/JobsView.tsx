/**
 * 任务队列视图 —— 队列监控 / 状态流转 / 人工批准 / 事件时间线（规格 §11.3）。
 *
 * - 任务表：标题 / 类型 tag / 状态彩色 tag（成功绿 / 失败红 / 运行蓝 / 等待琥珀 / 取消灰）/
 *   进度条 / Provider·Model / 错误（截断点击展开）/ 创建时间
 * - 行操作：取消（非终态）、重试（FAILED/CANCELED）、查看事件（时间线 modal）
 * - AWAITING_APPROVAL 行突出显示：[批准] 按钮 + Egress 预览（目标/数据/敏感项）。
 *   job_list 本身不返回 egress，预览数据来自 job.awaitingApproval 事件订阅，
 *   以及对等待行 job_events 的兜底扫描。
 * - 顶部：并发说明 + 刷新 + 自动刷新开关（15s 兜底轮询 job_list，实时更新靠事件订阅）；
 *   另订阅 job.created / job.progress / job.succeeded / job.failed 实时更新（cleanup unlisten）。
 *
 * 复用 global.css 设计系统，布局细节用本组件内 scoped <style> 补充（无法修改 global.css）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api-providers";
import type { EgressPreview, JobDto, JobEventDto } from "../api-providers";
import { errMsg, onAppEvent } from "../api";
import { getLang, t, useT } from "../i18n";
import { useApp } from "../store";

/* ---------------- 常量 ---------------- */

/** 状态 → 中文标签 + 颜色类（成功绿 / 失败红 / 运行蓝 / 等待琥珀 / 取消灰=默认 tag） */
const STATE_META: Record<string, { label: string; cls: string }> = {
  QUEUED: { label: "排队中", cls: "amber" },
  VALIDATING: { label: "校验中", cls: "blue" },
  AWAITING_APPROVAL: { label: "等待确认", cls: "amber" },
  SUBMITTING: { label: "提交中", cls: "blue" },
  RUNNING: { label: "运行中", cls: "blue" },
  DOWNLOADING: { label: "下载中", cls: "blue" },
  POST_PROCESSING: { label: "后处理中", cls: "blue" },
  SUCCEEDED: { label: "已完成", cls: "green" },
  FAILED: { label: "失败", cls: "red" },
  RETRY_WAIT: { label: "重试等待", cls: "amber" },
  CANCELED: { label: "已取消", cls: "" },
};

const KIND_META: Record<string, string> = {
  chat: "对话",
  script: "剧本生成",
  vision: "视觉理解",
  structured_output: "结构化输出",
  image_generation: "图片生成",
  image_edit: "改图",
  video_generation: "视频生成",
  video_edit: "剪视频",
  video_extend: "视频延展",
  tts: "配音",
  music: "音乐",
  embedding: "向量",
  timeline_render: "本地合成",
  export: "导出成片",
  import: "导入",
  video_understand: "视频理解",
};

const kindLabel = (k: string) => KIND_META[k] ?? k;

/** 终态：不再允许取消 */
const TERMINAL_STATES = new Set(["SUCCEEDED", "FAILED", "CANCELED"]);
/** 允许重试的状态 */
const RETRYABLE_STATES = new Set(["FAILED", "CANCELED"]);

/* ---------------- 工具 ---------------- */

function formatTime(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString(getLang() === "en" ? "en-US" : "zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** 事件 payload 展示：字符串形式的 JSON 先 parse 再用 2 空格缩进格式化，避免原样显示转义串 */
function formatPayload(v: unknown): string {
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      if (parsed && typeof parsed === "object") return JSON.stringify(parsed, null, 2);
    } catch {
      /* 非 JSON 字符串，原样展示 */
    }
    return v;
  }
  return safeJson(v);
}

/** 折叠任务标题中重复的前缀（如「生成剧本：生成剧本：xx」→「生成剧本：xx」） */
function collapseTitle(title: string): string {
  const m = title.match(/^([^：:]+[：:])([\s\S]*)$/);
  if (!m) return title;
  const prefix = m[1];
  let rest = m[2];
  while (rest.startsWith(prefix)) rest = rest.slice(prefix.length);
  return prefix + rest;
}

/** 事件 payload 中提取 egress（job.awaitingApproval = { job, egress, message }） */
function extractEgress(payload: unknown): EgressPreview | null {
  if (!payload || typeof payload !== "object") return null;
  const eg = (payload as Record<string, unknown>)["egress"];
  if (eg && typeof eg === "object") return eg as EgressPreview;
  return null;
}

/** 事件 payload 中提取 jobId（payload 本身是 job 或 { job }） */
function extractJobId(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const job = o["job"];
  if (job && typeof job === "object") {
    const id = (job as Record<string, unknown>)["id"];
    if (typeof id === "string") return id;
  }
  return typeof o["id"] === "string" ? (o["id"] as string) : null;
}

/** 从事件时间线（新→旧）里兜底扫描 egress */
function findEgressInEvents(events: JobEventDto[]): EgressPreview | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const eg = extractEgress(events[i].payload);
    if (eg) return eg;
  }
  return null;
}

/* ---------------- Egress 预览 ---------------- */

function EgressBox({ eg }: { eg: EgressPreview }) {
  const t = useT();
  const texts = Array.isArray(eg.textFields) ? eg.textFields.map(String) : [];
  const assets = Array.isArray(eg.assets) ? eg.assets.map(String) : [];
  const sensitive: string[] = [...texts, ...assets];
  return (
    <div className="egress-box">
      <div>
        <span className="k">{t("目标")}</span>
        {eg.endpoint ?? "—"}
        {eg.model ? t(" · 模型 {model}", { model: eg.model }) : ""}
        {eg.providerId ? ` · provider ${eg.providerId}` : ""}
      </div>
      <div>
        <span className="k">{t("数据")}</span>
        {texts.length ? t("文本字段：{fields}", { fields: texts.join("、") }) : t("无文本字段")}
        {assets.length ? t("；资产 {count} 项", { count: assets.length }) : ""}
      </div>
      <div>
        <span className="k">{t("敏感项")}</span>
        {sensitive.length ? (
          <>
            {t("{count} 项内容将发送至远程 Provider（{detail}）", {
              count: sensitive.length,
              detail: truncate(sensitive.join("、"), 80),
            })}
          </>
        ) : (
          t("无")
        )}
      </div>
    </div>
  );
}

/* ---------------- 主视图 ---------------- */

export default function JobsView() {
  const t = useT();
  const { settings, toast } = useApp();

  const [jobs, setJobs] = useState<JobDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [egressMap, setEgressMap] = useState<Record<string, EgressPreview>>({});
  const [eventsModal, setEventsModal] = useState<{ job: JobDto; events: JobEventDto[] } | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);

  /** 已兜底扫描过 egress 的 job，避免轮询/事件刷新时反复拉事件 */
  const egressCheckedRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.jobList(200);
      setJobs(list);
      setLastRefresh(new Date());
    } catch (e) {
      console.error("jobList", e);
    } finally {
      setLoading(false);
    }
  }, []);

  /* 首次加载 */
  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* 自动刷新：事件订阅（见下）为主，15s 兜底轮询。
     此前是 2s 全量轮询——事件已覆盖所有状态变化，高频轮询只是重复拉全量列表；
     保留低频兜底是为了容错事件总线不可用 / 丢事件的场景。 */
  useEffect(() => {
    if (!autoRefresh) return;
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, refresh]);

  /* 事件订阅：job.created / job.progress / job.succeeded / job.failed / job.awaitingApproval */
  useEffect(() => {
    const unlistens: (() => void)[] = [];
    let alive = true;
    const names = ["job:created", "job:progress", "job:succeeded", "job:failed", "job:awaitingApproval"];
    void (async () => {
      for (const name of names) {
        try {
          const un = await onAppEvent(name, (payload: unknown) => {
            if (name === "job:awaitingApproval") {
              const jobId = extractJobId(payload);
              const eg = extractEgress(payload);
              if (jobId && eg) setEgressMap((m) => ({ ...m, [jobId]: eg }));
            }
            void refresh();
          });
          if (!alive) {
            un();
            return;
          }
          unlistens.push(un);
        } catch {
          /* 事件总线不可用时静默降级为轮询 */
        }
      }
    })();
    return () => {
      alive = false;
      unlistens.forEach((u) => u());
    };
  }, [refresh]);

  /* 等待确认行的 egress 兜底：视图加载 / 轮询后发现 AWAITING_APPROVAL 行时扫描一次事件 */
  useEffect(() => {
    const pending = jobs.filter(
      (j) => j.state === "AWAITING_APPROVAL" && !egressCheckedRef.current.has(j.id),
    );
    if (pending.length === 0) return;
    pending.forEach((j) => egressCheckedRef.current.add(j.id));
    void (async () => {
      for (const j of pending) {
        try {
          const events = await api.jobEvents(j.id);
          const eg = findEgressInEvents(events);
          if (eg) setEgressMap((m) => ({ ...m, [j.id]: eg }));
        } catch {
          /* ignore */
        }
      }
    })();
  }, [jobs]);

  /* ---------- 行操作 ---------- */

  const doCancel = async (j: JobDto) => {
    try {
      await api.jobCancel(j.id);
      toast(t("已请求取消：{title}", { title: j.title }), "ok");
      await refresh();
    } catch (e) {
      const msg = errMsg(e);
      if (msg.includes("已取消")) return; // 用户主动取消，静默
      toast(t("取消失败：{msg}", { msg }), "err");
    }
  };

  const doRetry = async (j: JobDto) => {
    try {
      await api.jobRetry(j.id);
      toast(t("已重新入队：{title}", { title: j.title }), "ok");
      await refresh();
    } catch (e) {
      const msg = errMsg(e);
      if (msg.includes("已取消")) return; // 取消类错误静默
      toast(t("重试失败：{msg}", { msg }), "err");
    }
  };

  const doApprove = async (j: JobDto) => {
    try {
      await api.jobApprove(j.id);
      toast(t("已批准：{title}", { title: j.title }), "ok");
      await refresh();
    } catch (e) {
      const msg = errMsg(e);
      if (msg.includes("已取消")) return; // 取消类错误静默
      toast(t("批准失败：{msg}", { msg }), "err");
    }
  };

  const openEvents = async (j: JobDto) => {
    setEventsModal({ job: j, events: [] });
    setEventsLoading(true);
    try {
      const events = await api.jobEvents(j.id);
      setEventsModal({ job: j, events });
    } catch (e) {
      const msg = errMsg(e);
      if (!msg.includes("已取消")) toast(t("读取事件失败：{msg}", { msg }), "err");
      setEventsModal(null);
    } finally {
      setEventsLoading(false);
    }
  };

  /* ---------- 统计 ---------- */

  const runningCount = jobs.filter((j) => !TERMINAL_STATES.has(j.state)).length;
  const awaitingCount = jobs.filter((j) => j.state === "AWAITING_APPROVAL").length;

  return (
    <div className="page">
      <style>{JOBS_CSS}</style>

      <div className="page-header">
        <div>
          <h1>{t("⏳ 任务队列")}</h1>
          <div className="desc">
            {t(
              "全局并发上限 {max}（可在「设置 → 任务引擎」调整），每个 Provider 另有独立并发上限 · 共 {total} 条 · 进行中 {running}",
              { max: settings?.maxConcurrentJobs ?? 2, total: jobs.length, running: runningCount }
            )}
            {awaitingCount > 0 ? t(" · 待确认 {count}", { count: awaitingCount }) : ""}
          </div>
        </div>
        <div className="jobs-toolbar">
          <label className="checkbox-row">
            <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} />
            {t("自动刷新（15s 兜底）")}
          </label>
          <button className="btn ghost" disabled={loading} onClick={() => void refresh()}>
            {loading ? t("刷新中…") : t("⟳ 刷新")}
          </button>
          {lastRefresh && (
            <span className="hint" style={{ marginLeft: 6 }}>
              {t("已刷新 {time}", { time: lastRefresh.toLocaleTimeString("zh-CN", { hour12: false }) })}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="page hint">{t("加载中…")}</div>
      ) : jobs.length === 0 ? (
        <div className="empty-state" style={{ padding: "80px 20px" }}>
          <div className="big">⏳</div>
          <h2>{t("暂无任务")}</h2>
          <p>{t("在创作视图发起生成 / 渲染后，任务会出现在这里")}</p>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflowX: "auto" }}>
          <table className="table jobs-table">
            <thead>
              <tr>
                <th>{t("标题")}</th>
                <th>{t("类型")}</th>
                <th>{t("状态")}</th>
                <th>{t("进度")}</th>
                <th>{t("Provider / 模型")}</th>
                <th>{t("错误")}</th>
                <th>{t("创建时间")}</th>
                <th>{t("操作")}</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => {
                const meta = STATE_META[j.state] ?? { label: j.state, cls: "" };
                const pct = Math.round((Number(j.progress) || 0) * 100);
                const eg = j.state === "AWAITING_APPROVAL" ? egressMap[j.id] : undefined;
                return (
                  <JobRow
                    key={j.id}
                    job={j}
                    meta={meta}
                    pct={pct}
                    egress={eg}
                    expanded={!!expanded[j.id]}
                    onToggleError={() => setExpanded((x) => ({ ...x, [j.id]: !x[j.id] }))}
                    onCancel={() => void doCancel(j)}
                    onRetry={() => void doRetry(j)}
                    onApprove={() => void doApprove(j)}
                    onEvents={() => void openEvents(j)}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="jobs-foot">
        <span>🛡️</span>
        <span>
          {t(
            "任务状态机：QUEUED → VALIDATING →（AWAITING_APPROVAL，需人工批准）→ SUBMITTING → RUNNING → DOWNLOADING → POST_PROCESSING → SUCCEEDED / FAILED；失败自动重试进入 RETRY_WAIT"
          )}
        </span>
      </div>

      {/* 事件时间线 modal */}
      {eventsModal && (
        <div className="modal-overlay" onClick={() => setEventsModal(null)}>
          <div className="modal" style={{ width: "min(680px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{t("事件时间线 · {title}", { title: collapseTitle(eventsModal.job.title) })}</span>
              <button className="btn sm ghost" onClick={() => setEventsModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              {eventsLoading ? (
                <div className="hint">{t("加载中…")}</div>
              ) : eventsModal.events.length === 0 ? (
                <div className="hint">{t("暂无事件")}</div>
              ) : (
                eventsModal.events.map((ev, i) => (
                  <div className="ev-item" key={i}>
                    <div className="ev-head">
                      <span className="tag blue">{ev.type}</span>
                      <span className="ev-time">{formatTime(ev.time)}</span>
                    </div>
                    <pre className="ev-payload">{formatPayload(ev.payload)}</pre>
                  </div>
                ))
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setEventsModal(null)}>{t("关闭")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- 单行 ---------------- */

type QcSummary = { ok: boolean; detail: string } | null;
function qcSummary(job: JobDto): QcSummary {
  const reports = job.qc;
  if (!reports || !Array.isArray(reports) || reports.length === 0) return null;
  let black = 0;
  let silence = 0;
  for (const r of reports) {
    for (const seg of r.black ?? []) black += Math.max(0, (seg.end ?? 0) - (seg.start ?? 0));
    for (const seg of r.silence ?? []) silence += Math.max(0, (seg.end ?? 0) - (seg.start ?? 0));
  }
  const parts: string[] = [];
  if (black > 1) parts.push(t("黑帧 {dur}s", { dur: black.toFixed(1) }));
  if (silence > 3) parts.push(t("静音 {dur}s", { dur: silence.toFixed(1) }));
  if (reports.some((r) => r.hasAudio === false)) parts.push(t("无音轨"));
  if (parts.length === 0) return { ok: true, detail: t("黑帧/静音/音轨检测未见异常") };
  return { ok: false, detail: parts.join(" · ") };
}

function JobRow({
  job,
  meta,
  pct,
  egress,
  expanded,
  onToggleError,
  onCancel,
  onRetry,
  onApprove,
  onEvents,
}: {
  job: JobDto;
  meta: { label: string; cls: string };
  pct: number;
  egress?: EgressPreview;
  expanded: boolean;
  onToggleError: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onApprove: () => void;
  onEvents: () => void;
}) {
  const t = useT();
  const awaiting = job.state === "AWAITING_APPROVAL";
  const qc = qcSummary(job);
  return (
    <>
      <tr className={awaiting ? "await" : ""}>
        <td className="jobs-title" title={job.id}>
          {collapseTitle(job.title)}
          {awaiting && <span className="jobs-await-mark">{t("（等待确认，请批准后执行）")}</span>}
          {qc && (
            <div className="jobs-qc" title={qc.detail}>
              <span className={`tag ${qc.ok ? "" : "amber"}`}>
                {qc.ok ? t("🔍 QC 通过") : t("⚠️ QC：{detail}", { detail: qc.detail })}
              </span>
            </div>
          )}
        </td>
        <td><span className="tag">{t(kindLabel(job.kind))}</span></td>
        <td>
          <span className={`tag ${meta.cls}`}>{t(meta.label)}</span>
          {(job.attempts ?? 0) > 0 && <span className="jobs-attempts">{t(" ·第 {n} 次", { n: (job.attempts ?? 0) + 1 })}</span>}
        </td>
        <td>
          <div className="prog-cell">
            <div className="progress-mini"><div style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>
            <span className="prog-pct">{pct}%</span>
          </div>
        </td>
        <td className="jobs-pm">
          {job.providerId || "—"}
          {job.model ? <span className="jobs-model"> / {job.model}</span> : null}
        </td>
        <td className="jobs-err">
          {job.error ? (
            expanded ? (
              <div className="err-full" onClick={onToggleError} title={t("点击收起")}>
                {job.error}
              </div>
            ) : (
              <span className="err-text" onClick={onToggleError} title={t("{error}\n（点击展开）", { error: job.error })}>
                {truncate(job.error, 60)}
              </span>
            )
          ) : (
            "—"
          )}
        </td>
        <td className="jobs-time">{formatTime(job.createdAt)}</td>
        <td className="jobs-ops">
          {awaiting && (
            <button className="btn sm blue" onClick={onApprove}>{t("批准")}</button>
          )}
          {!TERMINAL_STATES.has(job.state) && (
            <button className="btn sm" onClick={onCancel}>{t("取消")}</button>
          )}
          {RETRYABLE_STATES.has(job.state) && (
            <button className="btn sm" onClick={onRetry}>{t("重试")}</button>
          )}
          <button className="btn sm ghost" onClick={onEvents}>{t("事件")}</button>
        </td>
      </tr>
      {/* 等待确认行的 Egress 预览（仅在事件 / 事件时间线里携带了 egress 时显示） */}
      {awaiting && egress && (
        <tr className="egress-row">
          <td colSpan={8}>
            <div className="egress-wrap">
              <span className="tag amber">{t("Egress 预览 · 批准后将向以下目标发送数据")}</span>
              <EgressBox eg={egress} />
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ---------------- 视图局部样式（补充 global.css，深色一致） ---------------- */

const JOBS_CSS = `
.jobs-toolbar { display: flex; align-items: center; gap: 14px; }
.jobs-table { min-width: 980px; }
.jobs-table tr.await td { background: rgba(255, 181, 71, 0.07); border-bottom-color: rgba(255, 181, 71, 0.25); }
.jobs-table tr.await:hover td { background: rgba(255, 181, 71, 0.12); }
.jobs-title { color: var(--text); max-width: 220px; }
.jobs-await-mark { color: var(--amber); font-size: 11px; }
.jobs-attempts { font-size: 10.5px; color: var(--muted); }
.prog-cell { display: flex; align-items: center; gap: 8px; }
.prog-pct { font-family: var(--mono); font-size: 10.5px; color: var(--muted); min-width: 34px; }
.jobs-pm { max-width: 160px; word-break: break-all; }
.jobs-model { color: var(--text); font-family: var(--mono); font-size: 11px; }
.jobs-err { max-width: 200px; }
.err-text { color: var(--red); cursor: pointer; word-break: break-all; }
.err-text:hover { text-decoration: underline; }
.err-full {
  color: var(--red); cursor: pointer; word-break: break-all;
  white-space: pre-wrap; font-size: 11.5px; user-select: text;
}
.jobs-time { font-family: var(--mono); font-size: 10.5px; white-space: nowrap; color: var(--muted); }
.jobs-ops { display: flex; gap: 6px; flex-wrap: wrap; }
.egress-row td { background: rgba(255, 181, 71, 0.04); }
.egress-wrap { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.egress-box {
  display: flex; flex-direction: column; gap: 3px; font-size: 11.5px; color: var(--text-dim);
  background: var(--bg-deep); border: 1px solid rgba(255, 181, 71, 0.3);
  border-radius: var(--radius-sm); padding: 8px 10px; width: 100%;
}
.egress-box .k { color: var(--amber); margin-right: 8px; }
.jobs-foot {
  display: flex; align-items: center; gap: 8px;
  margin-top: 16px; font-size: 11.5px; color: var(--muted);
}
.ev-item { border-bottom: 1px solid var(--border); padding: 8px 0; display: flex; flex-direction: column; gap: 4px; }
.ev-item:last-child { border-bottom: none; }
.ev-head { display: flex; align-items: center; gap: 8px; }
.ev-time { font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
.ev-payload {
  margin: 0; font-family: var(--mono); font-size: 11px; color: var(--text-dim);
  white-space: pre-wrap; word-break: break-all;
  background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 6px 8px;
  max-height: 160px; overflow: auto; user-select: text;
}
`;
