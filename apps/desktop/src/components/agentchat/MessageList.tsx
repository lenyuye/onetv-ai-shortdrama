/**
 * 消息列表：空态引导卡 / 用户·系统·助手气泡（助手走 MdBlock + 计划卡）/ 流式打字气泡。
 * 自 views/AgentChatView.tsx 原样迁出；滚动容器 ref 仍由主视图持有（自动滚动逻辑留在主视图）。
 */
import { type RefObject } from "react";
import type { ChatMsg } from "../../agentChatStore";
import { useT } from "../../i18n";
import { MdBlock } from "./MdBlock";
import { PlanCard } from "./PlanCard";

interface MessageListProps {
  msgs: ChatMsg[];
  /** 当前项目+会话的流式打字内容；undefined=无流式（由主视图选择器计算） */
  streamingText: string | undefined;
  approving: string | null;
  onApprove: (planId: string) => void;
  onReject: (planId: string) => void;
  scrollRef: RefObject<HTMLDivElement | null>;
}

export function MessageList({ msgs, streamingText, approving, onApprove, onReject, scrollRef }: MessageListProps) {
  const t = useT();
  return (
    <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "14px 22px", minHeight: 0 }}>
      {msgs.length === 0 && (
        <div className="card hint" style={{ maxWidth: 640 }}>
          {t("和 Agent 聊聊你的短剧想法。它会先给出")}<b>{t("结构化执行计划")}</b>
          {t("（做什么、调多少次远程 API、风险等级），你批准后才会真正执行 —— 全程可审计。对话类问题直接回答；生图/生视频任务会进入任务队列。")}
        </div>
      )}
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
            }}
          >
            <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
              <span>{m.role === "user" ? t("我") : m.role === "system" ? t("系统") : "Agent"} · {m.time}</span>
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
            {m.plan && (
              <PlanCard plan={m.plan} approving={approving} onApprove={onApprove} onReject={onReject} />
            )}
          </div>
        </div>
      ))}
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
