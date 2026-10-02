/**
 * Agent 对话视图 —— 自然语言驱动创作：对话流 + 结构化计划卡 + 批准/拒绝。
 * chat 意图低风险自动执行并回显模型回复；创作意图先出计划，批准后入任务队列。
 */
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import * as story from "../api-story";
import { useApp } from "../store";

interface ChatMsg {
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
  };
  time: string;
}

const INTENT_CN: Record<string, string> = {
  chat: "对话",
  "script.generate": "生成剧本",
  "storyboard.generate": "生成分镜",
  "image.generate": "生成图片",
  "video.generate": "生成视频",
  "timeline.compose": "合成成片",
  export: "导出",
  "video.understand": "视频理解",
};

const RISK_TAG: Record<string, string> = { low: "green", medium: "amber", high: "red" };

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default function AgentChatView() {
  const { project, toast } = useApp();
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const unlisteners: Promise<unknown>[] = [
      api.onAppEvent<{ text: string }>("agent.message", (p) => {
        if (p?.text) {
          setMsgs((m) => [
            ...m,
            { id: uid(), role: "assistant", text: p.text, time: new Date().toLocaleTimeString() },
          ]);
        }
      }),
    ];
    return () => {
      unlisteners.forEach((u) => u.then((f) => (f as () => void)()).catch(() => {}));
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs.length]);

  if (!project) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🤖</div>
        <h2>Agent 对话</h2>
        <p>请先在「工作区」创建或打开一个项目</p>
        <button className="btn primary" onClick={() => useApp.getState().setView("home")}>
          前往工作区
        </button>
      </div>
    );
  }

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMsgs((m) => [...m, { id: uid(), role: "user", text, time: new Date().toLocaleTimeString() }]);
    setBusy(true);
    try {
      const r = await story.agentChat(text);
      setMsgs((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          text: r.autoExecuted
            ? `已执行：${r.plan.summary}（低风险任务自动运行，回复见下方）`
            : r.plan.summary,
          plan: {
            planId: r.plan.planId,
            intent: r.plan.intent,
            summary: r.plan.summary,
            risk: String(r.plan.estimated?.risk ?? "low"),
            remoteCalls: Number(r.plan.estimated?.remoteCalls ?? 0),
            steps: r.plan.steps ?? [],
          },
          time: new Date().toLocaleTimeString(),
        },
      ]);
      if (r.autoExecuted) {
        toast("对话任务已自动执行（Mock/本地模型不出公网）", "ok");
      }
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { id: uid(), role: "system", text: `⚠️ ${story.errMsg(e)}`, time: new Date().toLocaleTimeString() },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (planId: string) => {
    setApproving(planId);
    try {
      const ids = await story.agentApprove(planId);
      toast(`已批准，创建了 ${ids.length} 个任务（可在「任务」页查看进度）`, "ok");
      setMsgs((m) =>
        m.map((msg) => {
          if (msg.plan?.planId !== planId) return msg;
          const plan = msg.plan;
          return { ...msg, plan, text: `${msg.text}\n\n✅ 已批准执行 → 任务 ${ids.length} 个已进入队列` };
        })
      );
    } catch (e) {
      toast(`批准失败：${story.errMsg(e)}`, "err");
    } finally {
      setApproving(null);
    }
  };

  const reject = (planId: string) => {
    setMsgs((m) =>
      m.map((msg) => {
        if (msg.plan?.planId !== planId) return msg;
        const plan = msg.plan;
        return { ...msg, plan, text: `${msg.text}\n\n❌ 已拒绝（未创建任何任务）` };
      })
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header" style={{ padding: "14px 22px 0", marginBottom: 0 }}>
        <div>
          <h1 style={{ fontSize: 16 }}>🤖 Agent 对话</h1>
          <div className="desc">
            例如：「写第一集剧本」「把剧本拆成分镜」「按分镜顺序合成成片」—— 高风险操作会先出计划由你批准
          </div>
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "14px 22px", minHeight: 0 }}>
        {msgs.length === 0 && (
          <div className="card hint" style={{ maxWidth: 640 }}>
            和 Agent 聊聊你的短剧想法。它会先给出<b>结构化执行计划</b>（做什么、调多少次远程 API、风险等级），
            你批准后才会真正执行 —— 全程可审计。对话类问题直接回答；生图/生视频任务会进入任务队列。
          </div>
        )}
        {msgs.map((m) => (
          <div
            key={m.id}
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
                whiteSpace: "pre-wrap",
                fontSize: 12.5,
              }}
            >
              <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4 }}>
                {m.role === "user" ? "我" : m.role === "system" ? "系统" : "Agent"} · {m.time}
              </div>
              {m.text}
              {m.plan && (
                <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    <span className="tag blue">{INTENT_CN[m.plan.intent] ?? m.plan.intent}</span>
                    <span className={`tag ${RISK_TAG[m.plan.risk] ?? ""}`}>
                      {m.plan.risk === "low" ? "低风险" : m.plan.risk === "medium" ? "中风险" : "高风险"}
                    </span>
                    <span className="tag">远程调用 {m.plan.remoteCalls}</span>
                  </div>
                  {m.plan.steps.map((s, i) => (
                    <div key={s.id} style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 3 }}>
                      {i + 1}. <span className="tag" style={{ marginRight: 4 }}>{s.tool}</span>
                      {s.description}
                      {s.approval === "required" && <span className="tag red" style={{ marginLeft: 6 }}>需批准</span>}
                    </div>
                  ))}
                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    <button
                      className="btn primary sm"
                      disabled={approving === m.plan?.planId}
                      onClick={() => m.plan && approve(m.plan.planId)}
                    >
                      {approving === m.plan?.planId ? "批准中…" : "✓ 批准执行"}
                    </button>
                    <button className="btn sm" onClick={() => m.plan && reject(m.plan.planId)}>✕ 拒绝</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={{ padding: "10px 22px 14px", borderTop: "1px solid var(--border)" }}>
        <div style={{ display: "flex", gap: 10 }}>
          <textarea
            style={{ flex: 1, minHeight: 52 }}
            placeholder="输入消息：例如「写一集都市情感短剧」或「把当前剧本拆成分镜」…"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="btn primary" style={{ alignSelf: "flex-end" }} disabled={busy || !input.trim()} onClick={send}>
            {busy ? "思考中…" : "发送"}
          </button>
        </div>
      </div>
    </div>
  );
}
