/**
 * 消息列表：空态引导卡 / 用户·系统·助手气泡（助手走 MdBlock + 计划卡）/ 流式打字气泡。
 * 自 views/AgentChatView.tsx 原样迁出；滚动容器 ref 仍由主视图持有（自动滚动逻辑留在主视图）。
 * v2.22 性能：历史气泡抽为 memo 组件——流式 delta 只重渲染打字气泡，不再重放整列表。
 */
import { memo, useEffect, useState, type RefObject } from "react";
import type { ChatMsg, JobRun } from "../../agentChatStore";
import { getLang, useT } from "../../i18n";
import { useApp } from "../../store";
import { AssetCards } from "./AssetCard";
import { MdBlock } from "./MdBlock";
import { PlanCard } from "./PlanCard";

/** 消息时间：v2.20 起存 ISO;旧数据是创建时固化的本地时间串,无法解析则原样显示。 */
function fmtChatTime(raw: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleTimeString(getLang() === "en" ? "en-US" : "zh-CN", { hour12: false });
    }
  }
  return raw;
}

/** 消息右键菜单（v2.26.19）：复制全文 / 复制选区——气泡文本可选中
 *  v2.26.103：新增「删除这条消息 / 删除此条及之后」（微信式对话记录管理） */
function MsgContextMenu({
  x, y, text, sel, msgId, onDelete, onDeleteFrom, onClose,
}: {
  x: number; y: number; text: string; sel: string; msgId: string;
  onDelete: (msgId: string) => void;
  onDeleteFrom: (msgId: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  useEffect(() => {
    const close = () => onClose();
    document.addEventListener("mousedown", close);
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const hasSel = sel.length > 0;
  return (
    <div
      className="msg-ctx-menu"
      style={{ position: "fixed", left: Math.min(x, window.innerWidth - 210), top: Math.min(y, window.innerHeight - 150), zIndex: 1200 }}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button
        onClick={() => {
          void navigator.clipboard.writeText(text).then(
            () => useApp.getState().toast(t("已复制到剪贴板"), "ok"),
            () => useApp.getState().toast(t("复制失败"), "err"),
          );
          onClose();
        }}
      >
        {t("复制全文")}
      </button>
      <button
        disabled={!hasSel}
        title={hasSel ? undefined : t("右键前先在气泡里选中要复制的文字")}
        onClick={() => {
          void navigator.clipboard.writeText(sel).then(
            () => useApp.getState().toast(t("已复制到剪贴板"), "ok"),
            () => useApp.getState().toast(t("复制失败"), "err"),
          );
          onClose();
        }}
      >
        {sel ? t("复制选区") : t("复制选区（先选中文字）")}
      </button>
      <div className="msg-ctx-sep" />
      <button
        className="danger"
        title={t("只删除这一条消息")}
        onClick={() => { onDelete(msgId); onClose(); }}
      >
        {t("🗑 删除这条消息")}
      </button>
      <button
        className="danger"
        title={t("删除这条消息以及它后面的所有消息（截断对话）")}
        onClick={() => { onDeleteFrom(msgId); onClose(); }}
      >
        {t("✂️ 删除此条及之后")}
      </button>
    </div>
  );
}

interface MessageListProps {
  msgs: ChatMsg[];
  /** 当前项目+会话的流式打字内容；undefined=无流式（由主视图选择器计算） */
  streamingText: string | undefined;
  approving: string | null;
  onApprove: (planId: string) => void;
  onReject: (planId: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** v2.26.103 删除消息回调（实现：agentChatStore.deleteMsg / deleteMsgsFrom） */
  onDeleteMsg: (msgId: string) => void;
  onDeleteMsgsFrom: (msgId: string) => void;
  /** v2.26.29：当前项目+会话的执行过程卡（进行中 + 3s 内的终态） */
  jobRuns?: JobRun[];
}

/** 执行过程卡（v2.26.29，codex 式）：Agent 干活的实时步骤/进度在对话流内可见 */
const JobRunCards = memo(function JobRunCards({ runs }: { runs: JobRun[] }) {
  const t = useT();
  if (runs.length === 0) return null;
  // v2.26.103：后端 state 大写（SUCCEEDED/RUNNING…），统一小写比较
  const stateOf = (r: JobRun): { icon: string; label: string } => {
    const st = r.state.toLowerCase();
    if (st === "succeeded") return { icon: "✅", label: t("完成") };
    if (st === "failed") return { icon: "❌", label: r.error || t("失败") };
    if (st === "canceled" || st === "cancelled") return { icon: "⛔", label: t("已取消") };
    if (st === "awaiting_approval") return { icon: "⏸", label: t("等待批准") };
    return { icon: "⏳", label: r.note || t("执行中…") };
  };
  return (
    <div className="agent-job-runs" style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 }}>
      {runs.map((r) => {
        const s = stateOf(r);
        const st = r.state.toLowerCase();
        const done = st === "succeeded";
        const failed = st === "failed" || st === "canceled" || st === "cancelled";
        return (
          <div key={r.jobId} className="agent-msg-bubble" style={{ display: "flex", justifyContent: "flex-start" }}>
            <div
              style={{
                width: "78%",
                background: "var(--panel-2)",
                border: `1px solid ${failed ? "rgba(255,107,107,.45)" : "var(--border)"}`,
                borderRadius: 10,
                padding: "9px 13px",
                fontSize: 12,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <span className={done || failed ? undefined : "agent-job-spin"} style={{ fontSize: 13 }}>{s.icon}</span>
                <span style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</span>
                <span style={{ marginLeft: "auto", color: "var(--muted)", flexShrink: 0 }}>
                  {done ? s.label : failed ? "" : `${Math.round((r.progress ?? 0) * 100)}%`}
                </span>
              </div>
              {!done && !failed && (
                <div style={{ marginTop: 6, height: 4, borderRadius: 2, background: "var(--panel-3)", overflow: "hidden" }}>
                  <div
                    className="agent-job-bar"
                    style={{ width: `${Math.max(4, Math.min(100, (r.progress ?? 0) * 100))}%`, height: "100%", borderRadius: 2, transition: "width .4s ease" }}
                  />
                </div>
              )}
              {s.label && !done && (
                <div style={{ marginTop: 5, color: failed ? "var(--danger, #ff6b6b)" : "var(--muted)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {s.label}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
});

/** 历史消息气泡列表（memo：msgs/approving 回调引用不变时跳过重渲染） */
const BubbleList = memo(function BubbleList({
  msgs,
  approving,
  onApprove,
  onReject,
  onDeleteMsg,
  onDeleteMsgsFrom,
}: {
  msgs: ChatMsg[];
  approving: string | null;
  onApprove: (planId: string) => void;
  onReject: (planId: string) => void;
  onDeleteMsg: (msgId: string) => void;
  onDeleteMsgsFrom: (msgId: string) => void;
}) {
  const t = useT();
  const [ctx, setCtx] = useState<{ x: number; y: number; text: string; sel: string; msgId: string } | null>(null);
  return (
    <>
      {msgs.map((m) => (
        <div
          key={m.id}
          className="agent-msg-bubble"
          style={{
            display: "flex",
            justifyContent: m.role === "user" ? "flex-end" : "flex-start",
            marginBottom: 12,
          }}
        >
          <div
            style={{
              maxWidth: "78%",
              background: m.role === "user" ? "var(--panel-3)" : "var(--panel-2)",
              border: `1px solid ${m.role === "system" ? "rgba(255,181,71,.4)" : "var(--border)"}`,
              borderRadius: 10,
              padding: "10px 14px",
              whiteSpace: m.role === "assistant" ? "normal" : "pre-wrap",
              fontSize: 12.5,
              userSelect: "text",
              cursor: "text",
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              // 选区必须在右键瞬间捕获——菜单渲染/点击过程会清掉它
              const sel = (window.getSelection()?.toString() ?? "").trim();
              setCtx({ x: e.clientX, y: e.clientY, text: m.text, sel, msgId: m.id });
            }}
          >
            <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
              <span>{m.role === "user" ? t("我") : m.role === "system" ? t("系统") : "Agent"} · {fmtChatTime(m.time)}</span>
              {m.role === "assistant" && m.text && (
                <button
                  className="agent-msg-copy"
                  title={t("复制原文")}
                  onClick={() => void navigator.clipboard.writeText(m.text)}
                >
                  {t("复制")}
                </button>
              )}
            </div>
            {m.role === "assistant" ? <MdBlock text={m.text} /> : m.text}
            {/* v2.26.29：产物卡片（LibTV 式，图片/视频/音频内嵌 + 加入画布） */}
            {m.role === "assistant" && <AssetCards assets={m.assets ?? []} />}
            {m.plan && (
              <PlanCard plan={m.plan} approving={approving} onApprove={onApprove} onReject={onReject} />
            )}
          </div>
        </div>
      ))}
      {ctx && (
        <MsgContextMenu
          x={ctx.x} y={ctx.y} text={ctx.text} sel={ctx.sel} msgId={ctx.msgId}
          onDelete={onDeleteMsg} onDeleteFrom={onDeleteMsgsFrom}
          onClose={() => setCtx(null)}
        />
      )}
    </>
  );
});

export function MessageList({ msgs, streamingText, approving, onApprove, onReject, scrollRef, jobRuns = [], onDeleteMsg, onDeleteMsgsFrom }: MessageListProps) {
  const t = useT();
  return (
    <div ref={scrollRef} className="agent-chat-select" style={{ flex: 1, overflowY: "auto", padding: "14px 22px", minHeight: 0 }}>
      {msgs.length === 0 && (
        <div className="card hint" style={{ maxWidth: 640 }}>
          {t("和 Agent 聊聊你的短剧想法。它会先给出")}<b>{t("结构化执行计划")}</b>
          {t("（做什么、调多少次远程 API、风险等级），你批准后才会真正执行 —— 全程可审计。对话类问题直接回答；生图/生视频任务会进入任务队列。")}
        </div>
      )}
      <BubbleList msgs={msgs} approving={approving} onApprove={onApprove} onReject={onReject} onDeleteMsg={onDeleteMsg} onDeleteMsgsFrom={onDeleteMsgsFrom} />
      {/* 执行过程卡（v2.26.29）：进行中任务 + 3s 内的终态，codex 式实时进度 */}
      <JobRunCards runs={jobRuns} />
      {/* 流式进行中的回复（打字机气泡；完整回复到达后由事件桥收尾替换） */}
      {streamingText !== undefined && (
        <div className="agent-msg-bubble" style={{ display: "flex", justifyContent: "flex-start", marginBottom: 12 }}>
          <div
            style={{
              maxWidth: "78%",
              background: "var(--panel-2)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "10px 14px",
              fontSize: 12.5,
            }}
          >
            <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4 }}>
              {t("Agent · 正在输入…")}
            </div>
            <div className="agent-md agent-streaming">
              {streamingText || "…"}
              <span className="agent-stream-cursor">▍</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* 消息右键菜单样式（v2.26.19） */
const msgCtxCss = `
.msg-ctx-menu {
  background: var(--panel-2); border: 1px solid var(--border-strong); border-radius: 10px;
  box-shadow: 0 8px 30px rgba(0,0,0,.25); padding: 4px; min-width: 180px;
  display: flex; flex-direction: column;
}
.msg-ctx-menu button {
  background: none; border: none; cursor: pointer; text-align: left;
  color: var(--text); font-family: var(--font); font-size: 12.5px;
  padding: 7px 12px; border-radius: 6px;
}
.msg-ctx-menu button:hover:not(:disabled) { background: rgba(255,255,255,.08); }
.msg-ctx-menu button:disabled { color: var(--muted); cursor: default; }
.msg-ctx-sep { height: 1px; background: var(--border); margin: 3px 8px; }
.msg-ctx-menu button.danger { color: #ff6b6b; }
/* 执行过程卡（v2.26.29） */
.agent-job-spin { display: inline-block; animation: agent-job-rotate 1.4s linear infinite; }
@keyframes agent-job-rotate { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
.agent-job-bar { background: linear-gradient(90deg, var(--accent, #7c8cff), #b48cff); animation: agent-job-pulse 1.6s ease-in-out infinite; }
@keyframes agent-job-pulse { 0%, 100% { opacity: .75; } 50% { opacity: 1; } }
`;
const styleTag = typeof document !== "undefined" && !document.getElementById("msg-ctx-css");
if (styleTag) {
  const el = document.createElement("style");
  el.id = "msg-ctx-css";
  el.textContent = msgCtxCss;
  document.head.appendChild(el);
}
