/**
 * Agent 对话状态（模块级 zustand store，v2.6.3 多会话版）。
 * 数据结构：每个项目（root 路径）下有多个会话（ChatSession），消息存于会话内；
 * localStorage 持久化（v2 格式；v2.6.1 的单流格式自动迁移为「默认会话」）。
 * agent.message / agent.message.delta 在模块层订阅一次，按 jobId 归档到
 * 发起对话的项目+会话，切视图/切项目/切会话期间到达的回复都不会丢失。
 */
import { create } from "zustand";
import * as api from "./api";
import { useApp } from "./store";

/** 产物卡片（v2.26.29，LibTV 式）：生成完成后随 agent.message 下发的资产信息 */
export interface ChatMsgAsset {
  assetId: string;
  path: string;
  kind: string;
  mime?: string;
  name?: string;
}

export interface ChatMsg {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  plan?: {
    planId: string;
    intent: string;
    summary: string;
    risk: string;
    remoteCalls: number;
    steps: { id: string; tool: string; description: string; approval: string }[];
    /** L4 Reviewer 复核备注（v2.13） */
    reviewNotes?: string[];
    /** 低风险自动执行的计划：不显示批准/拒绝按钮 */
    auto?: boolean;
    /** 批准/拒绝后置位：按钮消失，状态不再自相矛盾 */
    decided?: "approved" | "rejected";
  };
  /** v2.26.29：产物卡片（图片/视频/音频内嵌预览 + 加入画布） */
  assets?: ChatMsgAsset[];
  time: string;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  msgs: ChatMsg[];
}

const LS_KEY = "onetv-agent-chat-v2";
const LS_KEY_V1 = "onetv-agent-chat-v1";
/** 每个项目保留的最大会话数 / 每会话最大消息数（localStorage 容量保护） */
const MAX_SESSIONS_PER_PROJECT = 30;
const MAX_MSGS_PER_SESSION = 400;
/** jobId 归档表上限（防无限增长） */
const MAX_JOB_MAP = 200;
/** 会话默认标题 */
export const DEFAULT_SESSION_TITLE = "新会话";
/** 自动落画布开关（v2.26.29，localStorage；"0"=关闭，默认开） */
export const AUTO_CANVAS_KEY = "onetv-agent-autocanvas";

export const uid = () => Math.random().toString(36).slice(2, 10);

function newSession(title: string = DEFAULT_SESSION_TITLE): ChatSession {
  return { id: uid(), title, createdAt: Date.now(), msgs: [] };
}

interface PersistShape {
  v: 2;
  sessions: Record<string, ChatSession[]>;
  current: Record<string, string>;
}

function loadPersist(): PersistShape {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistShape;
      if (parsed?.v === 2 && parsed.sessions && typeof parsed.sessions === "object") {
        // 容量保护：截断超限
        for (const k of Object.keys(parsed.sessions)) {
          parsed.sessions[k] = parsed.sessions[k].slice(-MAX_SESSIONS_PER_PROJECT);
          for (const s of parsed.sessions[k]) s.msgs = (s.msgs ?? []).slice(-MAX_MSGS_PER_SESSION);
        }
        return { v: 2, sessions: parsed.sessions, current: parsed.current ?? {} };
      }
    }
    // v1 → v2 迁移：单条消息流变成每项目一个「默认会话」
    const v1raw = localStorage.getItem(LS_KEY_V1);
    if (v1raw) {
      const v1 = JSON.parse(v1raw) as Record<string, ChatMsg[]>;
      const sessions: Record<string, ChatSession[]> = {};
      const current: Record<string, string> = {};
      for (const [k, msgs] of Object.entries(v1)) {
        if (!Array.isArray(msgs)) continue;
        const s = newSession("默认会话");
        s.msgs = msgs.slice(-MAX_MSGS_PER_SESSION);
        sessions[k] = [s];
        current[k] = s.id;
      }
      return { v: 2, sessions, current };
    }
  } catch {
    /* 损坏数据当作空处理 */
  }
  return { v: 2, sessions: {}, current: {} };
}

let persistTimer: number | null = null;
function schedulePersist(getSessions: () => Record<string, ChatSession[]>, getCurrent: () => Record<string, string>) {
  if (persistTimer !== null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ v: 2, sessions: getSessions(), current: getCurrent() } satisfies PersistShape));
    } catch {
      // 超容量：全局截半重试一次，仍失败则放弃（内存态不受影响）
      try {
        const sessions = getSessions();
        const trimmed: Record<string, ChatSession[]> = {};
        for (const [k, list] of Object.entries(sessions)) {
          trimmed[k] = list.slice(-Math.ceil(MAX_SESSIONS_PER_PROJECT / 2)).map((s) => ({ ...s, msgs: s.msgs.slice(-MAX_MSGS_PER_SESSION / 2) }));
        }
        localStorage.setItem(LS_KEY, JSON.stringify({ v: 2, sessions: trimmed, current: getCurrent() } satisfies PersistShape));
      } catch {
        /* ignore */
      }
    }
  }, 300);
}

/** 执行过程卡条目（v2.26.29，codex 式）：任务在对话流中的实时进度 */
export interface JobRun {
  jobId: string;
  root: string;
  sessionId: string;
  title: string;
  state: string;
  progress: number;
  note?: string;
  error?: string | null;
  /** 终态时间戳：3s 后从过程卡列表移除（产物消息/失败提示随后已到） */
  finishedAt?: number;
}

interface AgentChatState {
  sessionsByProject: Record<string, ChatSession[]>;
  currentByProject: Record<string, string>;
  busyByProject: Record<string, boolean>;
  /** 每项目进行中的对话/计划任务（停止生成用） */
  activeJobsByProject: Record<string, string[]>;
  /** 流式进行中的回复，按 jobId 索引（打字机气泡；完整回复到达后移除） */
  streamingByJob: Record<string, { root: string; sessionId: string; text: string }>;
  /** v2.26.29：执行中的任务过程卡，按 jobId 索引（job:progress/succeeded/failed 事件驱动） */
  jobRuns: Record<string, JobRun>;

  sessionsOf: (key: string | null) => ChatSession[];
  currentSessionOf: (key: string | null) => ChatSession | null;
  busyOf: (key: string | null) => boolean;
  activeJobsOf: (key: string | null) => string[];

  setBusy: (key: string, v: boolean) => void;
  setActiveJobs: (key: string, ids: string[]) => void;
  newSession: (key: string) => string;
  switchSession: (key: string, sessionId: string) => void;
  renameSession: (key: string, sessionId: string, title: string) => void;
  deleteSession: (key: string, sessionId: string) => void;
  /** 向指定会话追加消息（事件桥按 jobId 调用，可跨会话） */
  appendTo: (key: string, sessionId: string, msg: ChatMsg) => void;
  /** 按 planId 原位更新（批准/拒绝状态回写） */
  updateByPlanId: (key: string, sessionId: string, planId: string, patch: (m: ChatMsg) => ChatMsg) => void;
  appendDelta: (root: string, sessionId: string, jobId: string, delta: string) => void;
  finishStreaming: (jobId: string) => void;
  /** v2.26.29：过程卡 upsert / 移除 */
  upsertJobRun: (run: JobRun) => void;
  removeJobRun: (jobId: string) => void;
  /** 清空当前会话消息 */
  clearCurrent: (key: string) => void;
  /** v2.26.103 删除单条消息（右键菜单，微信式） */
  deleteMsg: (key: string, sessionId: string, msgId: string) => void;
  /** v2.26.103 删除指定消息及其之后的所有消息（截断） */
  deleteMsgsFrom: (key: string, sessionId: string, msgId: string) => void;
}

function ensureSession(list: ChatSession[], currentMap: Record<string, string>, key: string): { list: ChatSession[]; sessionId: string } {
  const curId = currentMap[key];
  if (curId && list.some((s) => s.id === curId)) return { list, sessionId: curId };
  const first = list[0] ?? newSession();
  const next = list[0] ? list : [first];
  return { list: next, sessionId: first.id };
}

function autoTitle(s: ChatSession) {
  if (s.title !== DEFAULT_SESSION_TITLE || s.msgs.length === 0) return;
  const firstUser = s.msgs.find((m) => m.role === "user");
  if (firstUser) s.title = firstUser.text.replace(/\s+/g, " ").trim().slice(0, 20) || DEFAULT_SESSION_TITLE;
}

export const useAgentChat = create<AgentChatState>((set, get) => {
  const initial = loadPersist();
  const persist = () => schedulePersist(() => get().sessionsByProject, () => get().currentByProject);

  return {
    sessionsByProject: initial.sessions,
    currentByProject: initial.current,
    busyByProject: {},
    activeJobsByProject: {},
    streamingByJob: {},
    jobRuns: {},

    sessionsOf: (key) => (key ? get().sessionsByProject[key] ?? [] : []),
    currentSessionOf: (key) => {
      if (!key) return null;
      const list = get().sessionsByProject[key] ?? [];
      const curId = get().currentByProject[key];
      return list.find((s) => s.id === curId) ?? list[0] ?? null;
    },
    busyOf: (key) => (key ? get().busyByProject[key] ?? false : false),
    activeJobsOf: (key) => (key ? get().activeJobsByProject[key] ?? [] : []),

    setBusy: (key, v) => set((s) => ({ busyByProject: { ...s.busyByProject, [key]: v } })),
    setActiveJobs: (key, ids) => set((s) => ({ activeJobsByProject: { ...s.activeJobsByProject, [key]: ids } })),

    newSession: (key) => {
      const s = newSession();
      set((st) => ({
        sessionsByProject: { ...st.sessionsByProject, [key]: [...(st.sessionsByProject[key] ?? []), s].slice(-MAX_SESSIONS_PER_PROJECT) },
        currentByProject: { ...st.currentByProject, [key]: s.id },
      }));
      persist();
      return s.id;
    },
    switchSession: (key, sessionId) => {
      set((st) => ({ currentByProject: { ...st.currentByProject, [key]: sessionId } }));
      persist();
    },
    renameSession: (key, sessionId, title) => {
      const t = title.trim();
      if (!t) return;
      set((st) => ({
        sessionsByProject: {
          ...st.sessionsByProject,
          [key]: (st.sessionsByProject[key] ?? []).map((s) => (s.id === sessionId ? { ...s, title: t } : s)),
        },
      }));
      persist();
    },
    deleteSession: (key, sessionId) => {
      set((st) => {
        const list = (st.sessionsByProject[key] ?? []).filter((s) => s.id !== sessionId);
        const next: Partial<Record<string, ChatSession[]>> = { ...st.sessionsByProject, [key]: list };
        const current = { ...st.currentByProject };
        if (current[key] === sessionId) {
          if (list.length > 0) {
            current[key] = list[list.length - 1].id;
          } else {
            const fresh = newSession();
            next[key] = [fresh];
            current[key] = fresh.id;
          }
        }
        return { sessionsByProject: next as Record<string, ChatSession[]>, currentByProject: current };
      });
      persist();
    },

    appendTo: (key, sessionId, msg) => {
      set((st) => {
        let list = st.sessionsByProject[key] ?? [];
        let rebuilt = false;
        if (!list.some((s) => s.id === sessionId)) {
          // 兜底：会话不存在（如 jobId 归档表已过期）时按原 id 重建，消息不丢
          list = [...list, { id: sessionId, title: DEFAULT_SESSION_TITLE, createdAt: Date.now(), msgs: [] }];
          rebuilt = true;
        }
        return {
          // v2.26.110：兜底重建的会话同时设为当前会话，避免回复写进侧栏里非当前会话而"看不见"
          currentByProject: rebuilt ? { ...st.currentByProject, [key]: sessionId } : st.currentByProject,
          sessionsByProject: {
            ...st.sessionsByProject,
            [key]: list.map((s) => {
              if (s.id !== sessionId) return s;
              const next = { ...s, msgs: [...s.msgs, msg].slice(-MAX_MSGS_PER_SESSION) };
              autoTitle(next);
              return next;
            }),
          },
        };
      });
      persist();
    },

    updateByPlanId: (key, sessionId, planId, patch) => {
      set((st) => {
        const list = st.sessionsByProject[key];
        if (!list) return st;
        return {
          sessionsByProject: {
            ...st.sessionsByProject,
            [key]: list.map((s) =>
              s.id === sessionId
                ? { ...s, msgs: s.msgs.map((m) => (m.plan?.planId === planId ? patch(m) : m)) }
                : s
            ),
          },
        };
      });
      persist();
    },

    appendDelta: (root, sessionId, jobId, delta) =>
      set((st) => {
        const cur = st.streamingByJob[jobId];
        const text = (cur?.text ?? "") + delta;
        return { streamingByJob: { ...st.streamingByJob, [jobId]: { root, sessionId, text } } };
      }),

    finishStreaming: (jobId) =>
      set((st) => {
        if (!st.streamingByJob[jobId]) return st;
        const next = { ...st.streamingByJob };
        delete next[jobId];
        return { streamingByJob: next };
      }),

    upsertJobRun: (run) =>
      set((st) => ({ jobRuns: { ...st.jobRuns, [run.jobId]: run } })),
    removeJobRun: (jobId) =>
      set((st) => {
        if (!st.jobRuns[jobId]) return st;
        const next = { ...st.jobRuns };
        delete next[jobId];
        return { jobRuns: next };
      }),

    clearCurrent: (key) => {
      const cur = get().currentSessionOf(key);
      if (!cur) return;
      set((st) => ({
        sessionsByProject: {
          ...st.sessionsByProject,
          [key]: (st.sessionsByProject[key] ?? []).map((s) => (s.id === cur.id ? { ...s, msgs: [] } : s)),
        },
        activeJobsByProject: { ...st.activeJobsByProject, [key]: [] },
      }));
      persist();
    },

    deleteMsg: (key, sessionId, msgId) => {
      set((st) => ({
        sessionsByProject: {
          ...st.sessionsByProject,
          [key]: (st.sessionsByProject[key] ?? []).map((s) =>
            s.id === sessionId ? { ...s, msgs: s.msgs.filter((m) => m.id !== msgId) } : s
          ),
        },
      }));
      persist();
    },

    deleteMsgsFrom: (key, sessionId, msgId) => {
      set((st) => ({
        sessionsByProject: {
          ...st.sessionsByProject,
          [key]: (st.sessionsByProject[key] ?? []).map((s) => {
            if (s.id !== sessionId) return s;
            const idx = s.msgs.findIndex((m) => m.id === msgId);
            return idx < 0 ? s : { ...s, msgs: s.msgs.slice(0, idx) };
          }),
        },
      }));
      persist();
    },
  };
});

/* ---------------- jobId 归档与全局事件桥 ---------------- */

/** jobId → 发起对话的项目+会话（事件按此归档；未知 jobId 落当前项目当前会话） */
const jobToSession = new Map<string, { root: string; sessionId: string }>();

export function rememberJobSession(jobIds: string[], root: string, sessionId: string) {
  for (const id of jobIds) {
    jobToSession.set(id, { root, sessionId });
  }
  if (jobToSession.size > MAX_JOB_MAP) {
    const excess = jobToSession.size - MAX_JOB_MAP;
    let dropped = 0;
    for (const k of jobToSession.keys()) {
      if (dropped++ >= excess) break;
      jobToSession.delete(k);
    }
  }
}

let bridgeInited = false;

/** 事件桥定位（v2.26.29 导出复用）：jobId → 项目+会话；未知 jobId 落当前项目当前会话 */
export function locateJob(jobId?: string): { root: string; sessionId: string } | null {
  const app = useApp.getState();
  const hit = (jobId && jobToSession.get(jobId)) || null;
  if (hit) return hit;
  const root = app.projectRoot;
  const st = useAgentChat.getState();
  const cur = root ? st.currentSessionOf(root) : null;
  return root && cur ? { root, sessionId: cur.id } : null;
}

/** 应用生命周期内只调用一次（App.tsx）：agent.message(.delta) 全局订阅 → 按项目+会话归档 */
export function initAgentChatBridge() {
  if (bridgeInited) return;
  bridgeInited = true;
  // 流式增量：按 jobId 累加（v2.6.2）
  api
    .onAppEvent<{ jobId?: string; delta?: string }>("agent:message:delta", (p) => {
      if (!p?.delta) return;
      const loc = locateJob(p.jobId);
      if (!loc) return;
      useAgentChat.getState().appendDelta(loc.root, loc.sessionId, p.jobId ?? "", p.delta);
    })
    .catch(() => { bridgeInited = false; });
  // 执行过程卡（v2.26.29，codex 式）：job.created/progress 实时刷新，终态 3s 后移除
  // v2.26.103 修复：后端 job state 是大写（SUCCEEDED/FAILED/CANCELED/RUNNING），
  // 此前终态判定用小写导致永匹配不上 → 过程卡 100% 卡死不消失。
  const FINISHED_STATES = ["succeeded", "failed", "canceled", "cancelled"];
  const upsertFromJobEvent = (p: { id?: string; title?: string; state?: string; progress?: number; error?: string | null }) => {
    if (!p?.id) return;
    const loc = locateJob(p.id);
    if (!loc) return;
    const cur = useAgentChat.getState().jobRuns[p.id];
    const state = (p.state ?? cur?.state ?? "running").toLowerCase();
    useAgentChat.getState().upsertJobRun({
      jobId: p.id,
      root: loc.root,
      sessionId: loc.sessionId,
      title: p.title ?? cur?.title ?? "任务执行中",
      state,
      progress: typeof p.progress === "number" ? p.progress : (cur?.progress ?? 0),
      error: p.error ?? cur?.error ?? null,
      finishedAt: FINISHED_STATES.includes(state) ? (cur?.finishedAt ?? Date.now()) : undefined,
    });
    // 终态：同时清理流式气泡（v2.26.110——失败/取消且后端不再发 agent:message 时，
    // 否则该会话底部永久残留「正在输入…」）+ 3s 后移除过程卡
    if (FINISHED_STATES.includes(state)) {
      useAgentChat.getState().finishStreaming(p.id);
      window.setTimeout(() => useAgentChat.getState().removeJobRun(p.id!), 3000);
    }
  };
  api.onAppEvent<Record<string, unknown>>("job:created", (p) => upsertFromJobEvent(p as { id?: string; title?: string; state?: string; progress?: number; error?: string | null })).catch(() => { bridgeInited = false; });
  api.onAppEvent<Record<string, unknown>>("job:progress", (p) => upsertFromJobEvent(p as { id?: string; title?: string; state?: string; progress?: number; error?: string | null })).catch(() => { bridgeInited = false; });
  // job:succeeded/failed 的 payload 就是 job_public（含 state 字段），直接透传即可
  api.onAppEvent<Record<string, unknown>>("job:succeeded", (p) => upsertFromJobEvent(p as { id?: string; title?: string; state?: string; progress?: number; error?: string | null })).catch(() => { bridgeInited = false; });
  api.onAppEvent<Record<string, unknown>>("job:failed", (p) => upsertFromJobEvent(p as { id?: string; title?: string; state?: string; progress?: number; error?: string | null })).catch(() => { bridgeInited = false; });
  // 完整回复：收尾对应流式气泡并把正式消息写入会话
  api
    .onAppEvent<{ text: string; kind?: string; jobId?: string; assets?: ChatMsgAsset[] }>("agent:message", (p) => {
      if (!p?.text) return;
      // 兜底定位（v2.24.2）：chat 意图在 agent_chat invoke 内联执行，事件先于 invoke 返回，
      // jobId 归档表可能尚未登记；会话也不存在时新建，保证回复永不丢。
      let loc = locateJob(p.jobId);
      if (!loc) {
        const root = useApp.getState().projectRoot;
        if (root) {
          const st = useAgentChat.getState();
          const cur = st.currentSessionOf(root);
          loc = { root, sessionId: cur?.id ?? st.newSession(root) };
        }
      }
      if (!loc) return;
      try {
        if (p.jobId) useAgentChat.getState().finishStreaming(p.jobId);
        useAgentChat.getState().appendTo(loc.root, loc.sessionId, {
          id: uid(),
          role: "assistant",
          text: p.text,
          assets: Array.isArray(p.assets) && p.assets.length > 0 ? p.assets : undefined,
          time: new Date().toISOString(),
        });
        // v2.26.29（LibTV 式）：带产物的消息自动落画布（开关可关，见 AgentChatView 头部）
        if (Array.isArray(p.assets) && p.assets.length > 0 && localStorage.getItem(AUTO_CANVAS_KEY) !== "0") {
          void import("./canvasSend").then((m) => m.autoDropAssetsToCanvas(p.assets!));
        }
      } catch (e) {
        console.error("[agentChat] reply archive failed", e);
      }
    })
    .catch(() => { bridgeInited = false; });
}
