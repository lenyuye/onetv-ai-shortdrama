/**
 * Agent 对话视图 —— 自然语言驱动创作：对话流 + 结构化计划卡 + 批准/拒绝。
 * chat 意图低风险自动执行并回显模型回复；创作意图先出计划，批准后入任务队列。
 * 输入框为 Codex 式整体容器：参考 chip 行 + textarea + 工具行（＋添加参考 / 发送），
 * 支持拖拽导入与粘贴文件导入（FileReader → base64 → agent_attach_data）。
 * v2.6.1：消息/忙碌态提升到 agentChatStore（切视图/重启不丢，事件按 jobId 归档），
 * 支持停止生成与助手消息 Markdown 渲染。
 * v2.16：拆分为 components/agentchat/ 子组件与 hooks/ 逻辑 hook（组合根，行为零变化）。
 */
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import * as story from "../api-story";
import { jobCancel } from "../api-providers";
import { useApp } from "../store";
import {
  useAgentChat,
  rememberJobSession,
  uid,
  type ChatSession,
} from "../agentChatStore";
import { useT } from "../i18n";
import { AttachmentChips } from "../components/agentchat/AttachmentChips";
import { AttachmentPreviewModal } from "../components/agentchat/AttachmentPreviewModal";
import {
  MAX_ATTACHMENTS,
  kindCn,
  type AiModelRef,
  type PendingExtra,
} from "../components/agentchat/constants";
import ConfirmDialog from "../components/ConfirmDialog";
import { MessageList } from "../components/agentchat/MessageList";
import { ModelSelector } from "../components/agentchat/ModelSelector";
import { MdBlock } from "../components/agentchat/MdBlock";
import { PlusMenu } from "../components/agentchat/PlusMenu";
import { SessionSidebar } from "../components/agentchat/SessionSidebar";
import { AGENT_CSS } from "../components/agentchat/styles";
import { useAgentAttachments } from "../hooks/useAgentAttachments";
import { useAgentPlanActions } from "../hooks/useAgentPlanActions";
import { useAgentPlusMenu } from "../hooks/useAgentPlusMenu";
import { useChatProviders } from "../hooks/useChatProviders";

// 内部实现已迁至 components/agentchat/；MdBlock 此前即为本文件对外可复用的渲染组件，保持可导入
export { MdBlock };

/** zustand v5 选择器的稳定空值：缺失键时必须返回同一引用，否则无限重渲染（白屏） */
const EMPTY_SESSIONS: ChatSession[] = [];
const EMPTY_JOBS: string[] = [];

export default function AgentChatView() {
  const t = useT();
  const { project, projectRoot, toast } = useApp();
  /** 对话键 = 项目 root 路径：消息/忙碌态按项目隔离 */
  const chatKey = projectRoot;
  const sessions = useAgentChat((s) => (chatKey ? s.sessionsByProject[chatKey] ?? EMPTY_SESSIONS : EMPTY_SESSIONS));
  const currentSession = useAgentChat((s) => {
    if (!chatKey) return null;
    const list = s.sessionsByProject[chatKey] ?? EMPTY_SESSIONS;
    return list.find((x) => x.id === s.currentByProject[chatKey]) ?? list[0] ?? null;
  });
  const msgs = currentSession?.msgs ?? [];
  const busy = useAgentChat((s) => (chatKey ? s.busyByProject[chatKey] ?? false : false));
  const activeJobs = useAgentChat((s) => (chatKey ? s.activeJobsByProject[chatKey] ?? EMPTY_JOBS : EMPTY_JOBS));
  /** 当前项目+当前会话的流式打字内容（可能多个 jobId 并发，这里只展示一个聊天流） */
  const streamingText = useAgentChat((s) => {
    if (!chatKey || !currentSession) return undefined;
    const hit = Object.values(s.streamingByJob).find(
      (v) => v.root === chatKey && v.sessionId === currentSession.id
    );
    return hit?.text;
  });

  /* ---------- 会话侧栏状态 ---------- */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameText, setRenameText] = useState("");
  /** 待删除会话：走 ConfirmDialog 二次确认后再真正删除 */
  const [sessionToDelete, setSessionToDelete] = useState<ChatSession | null>(null);

  /* ---------- 输入与附件 ---------- */
  const [input, setInput] = useState("");
  const {
    attachments,
    setAttachments,
    dragOver,
    addAttachment: importAttachment,
    openAsset,
    revealAsset,
    handlePaste,
    removeAttachment,
  } = useAgentAttachments({ hasProject: !!project, toast });
  /** 大＋的通用条目：链接 / @画布节点 / 技能 / 工具（与文件参考共同计入上限） */
  const [extras, setExtras] = useState<PendingExtra[]>([]);
  const [preview, setPreview] = useState<api.AgentAttachment | null>(null);
  const totalPending = attachments.length + extras.length;
  const addExtra = (it: PendingExtra) => {
    if (totalPending >= MAX_ATTACHMENTS) { toast(t("参考最多 {max} 个，请先移除部分条目", { max: MAX_ATTACHMENTS }), "err"); return false; }
    setExtras((x) => [...x, it]);
    return true;
  };

  /* ---------- 大＋菜单 ---------- */
  const {
    plusMenu,
    setPlusMenu,
    linkInput,
    setLinkInput,
    canvasNodes,
    skillNames,
    loadCanvasNodes,
    loadSkills,
    plusRef,
  } = useAgentPlusMenu({ toast });

  /* ---------- 模型选择 ---------- */
  const [aiModel, setAiModel] = useState<AiModelRef | null>(null);
  const { chatProviders } = useChatProviders();

  /* ---------- 计划批准/拒绝 ---------- */
  const { approving, approve, reject } = useAgentPlanActions({ chatKey: chatKey ?? "", currentSession, toast });

  const scrollRef = useRef<HTMLDivElement>(null);

  // agent.message 由 agentChatStore 的全局事件桥统一接收归档（App.tsx 初始化），
  // 视图只负责渲染——切视图期间到达的回复也会落入 store，不再丢失。

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs.length, streamingText?.length]);

  if (!project) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🤖</div>
        <h2>{t("Agent 对话")}</h2>
        <p>{t("请先在「工作区」创建或打开一个项目")}</p>
        <button className="btn primary" onClick={() => useApp.getState().setView("home")}>
          {t("前往工作区")}
        </button>
      </div>
    );
  }

  /** 🔗 添加参考：先查忙碌与条目上限，再走附件导入链路 */
  const addAttachment = async () => {
    if (busy) return;
    if (totalPending >= MAX_ATTACHMENTS) {
      toast(t("参考最多 {max} 个，请先移除部分条目", { max: MAX_ATTACHMENTS }), "err");
      return;
    }
    void importAttachment();
  };

  const send = async () => {
    const text = input.trim();
    if (busy || !chatKey || (!text && attachments.length === 0 && extras.length === 0)) return;
    // 气泡显示：原文 + 每个条目一行标记（不塞入 4000 字预览正文）
    const bubbleParts: string[] = [];
    if (text) bubbleParts.push(text);
    attachments.forEach((a) => bubbleParts.push(t("[参考：{name}（{kind}）]", { name: a.name, kind: t(kindCn(a.kind)) })));
    extras.forEach((x) => {
      if (x.kind === "link") bubbleParts.push(t("🔗 链接：{url}", { url: x.url }));
      else if (x.kind === "node") bubbleParts.push(`@${x.title}`);
      else if (x.kind === "skill") bubbleParts.push(t("🧩 技能：{name}", { name: x.name }));
      else bubbleParts.push(t("🛠️ 工具：{name}", { name: x.name }));
    });
    // 发给 LLM 的完整文本：原文在前，每个条目追加说明，文本类再追加内容预览
    const sendParts: string[] = [];
    if (text) sendParts.push(text);
    attachments.forEach((a) => {
      let part = `[参考：${a.name}（${kindCn(a.kind)}，已存入项目资产库 assetId=${a.assetId}）]`;
      if (a.textPreview) part += `\n--- 文件内容（预览）---\n${a.textPreview}\n--- 预览结束 ---`;
      sendParts.push(part);
    });
    extras.forEach((x) => {
      if (x.kind === "link") sendParts.push(`[链接：${x.url}]`);
      else if (x.kind === "node") sendParts.push(`[绑定画布节点：${x.title}（类型：${x.nodeType}，id=${x.id}${x.summary ? `；配置：${x.summary}` : ""}）]`);
      else if (x.kind === "skill") sendParts.push(`[调用技能：${x.name}]`);
      else sendParts.push(`[调用工具：${x.name}]`);
    });
    setInput("");
    setAttachments([]);
    setExtras([]);
    const session = currentSession ?? (() => {
      const id = useAgentChat.getState().newSession(chatKey);
      return useAgentChat.getState().sessionsOf(chatKey).find((x) => x.id === id)!;
    })();
    useAgentChat.getState().appendTo(chatKey, session.id, {
      id: uid(),
      role: "user",
      text: bubbleParts.join("\n"),
      time: new Date().toLocaleTimeString(),
    });
    useAgentChat.getState().setBusy(chatKey, true);
    try {
      // 会话上下文：取本会话最近 8 条 user/assistant 文本（排除计划卡与系统提示）
      const history = session.msgs
        .filter((m) => m.role === "user" || (m.role === "assistant" && !m.plan))
        .slice(-8)
        .map((m) => ({ role: m.role, content: m.text }));
      const r = await story.agentChat(sendParts.join("\n\n"), aiModel, history);
      // jobId → 项目+会话归档：切项目/切会话期间到达的回复仍归入本会话
      if (r.jobIds.length > 0) {
        rememberJobSession(r.jobIds, chatKey, session.id);
        useAgentChat.getState().setActiveJobs(chatKey, r.jobIds);
      }
      useAgentChat.getState().appendTo(chatKey, session.id, {
        id: uid(),
        role: "assistant",
        text: r.autoExecuted
          ? t("已自动执行：{summary}（低风险任务自动运行，回复稍后显示在下方）", { summary: r.plan.summary })
          : r.plan.summary,
        plan: {
          planId: r.plan.planId,
          intent: r.plan.intent,
          summary: r.plan.summary,
          risk: String(r.plan.estimated?.risk ?? "low"),
          remoteCalls: Number(r.plan.estimated?.remoteCalls ?? 0),
          steps: r.plan.steps ?? [],
          reviewNotes: r.plan.reviewNotes,
          auto: !!r.autoExecuted,
        },
        time: new Date().toLocaleTimeString(),
      });
      if (r.autoExecuted) {
        toast(t("对话任务已自动执行（Mock/本地模型不出公网）"), "ok");
      }
    } catch (e) {
      useAgentChat.getState().appendTo(chatKey, session.id, {
        id: uid(),
        role: "system",
        text: t("⚠️ {msg}", { msg: story.errMsg(e) }),
        time: new Date().toLocaleTimeString(),
      });
    } finally {
      useAgentChat.getState().setBusy(chatKey, false);
    }
  };

  /** 停止生成：取消当前对话创建的任务（远程已提交的由后端幂等/取消标志兜底） */
  const stopGenerating = async () => {
    if (!chatKey || activeJobs.length === 0) return;
    const ids = [...activeJobs];
    let ok = 0;
    for (const id of ids) {
      try {
        await jobCancel(id);
        ok++;
      } catch {
        /* 单个取消失败继续（可能已终态） */
      }
    }
    useAgentChat.getState().setActiveJobs(chatKey, []);
    useAgentChat.getState().setBusy(chatKey, false);
    for (const id of ids) useAgentChat.getState().finishStreaming(id);
    if (chatKey) {
      const cur = useAgentChat.getState().currentSessionOf(chatKey);
      if (cur) {
        useAgentChat.getState().appendTo(chatKey, cur.id, {
          id: uid(),
          role: "system",
          text: t("⛔ 已停止生成（取消任务 {ok}/{total} 个）", { ok, total: ids.length }),
          time: new Date().toLocaleTimeString(),
        });
      }
    }
  };

  /** 清空当前会话消息（localStorage 同步清理） */
  const clearChat = () => {
    if (!chatKey) return;
    useAgentChat.getState().clearCurrent(chatKey);
    toast(t("当前会话已清空"), "ok");
  };

  /* ---------- 会话管理 ---------- */
  const startNewSession = () => {
    if (!chatKey) return;
    useAgentChat.getState().newSession(chatKey);
  };
  const startRename = (s: ChatSession) => {
    setRenamingId(s.id);
    setRenameText(s.title);
  };
  const commitRename = () => {
    if (renamingId && chatKey) useAgentChat.getState().renameSession(chatKey, renamingId, renameText);
    setRenamingId(null);
  };
  const removeSession = (s: ChatSession) => {
    setSessionToDelete(s);
  };
  const confirmRemoveSession = () => {
    const s = sessionToDelete;
    setSessionToDelete(null);
    if (!s || !chatKey) return;
    useAgentChat.getState().deleteSession(chatKey, s.id);
    toast(t("已删除会话「{title}」", { title: s.title }), "ok");
  };

  /** 工具模板选择：插入输入框（Codex 式，空格分隔） */
  const selectToolTemplate = (tpl: string) => {
    setInput((v) => (v && !v.endsWith(" ") ? `${v} ${tpl}` : v + tpl));
  };

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0 }}>
      {/* 会话侧栏（v2.6.3）：多会话新建/切换/重命名/删除，各会话独立上下文 */}
      <SessionSidebar
        sessions={sessions}
        currentSessionId={currentSession?.id ?? null}
        renamingId={renamingId}
        renameText={renameText}
        onRenameTextChange={setRenameText}
        onSwitch={(s) => {
          if (chatKey) useAgentChat.getState().switchSession(chatKey, s.id);
        }}
        onStartRename={startRename}
        onCommitRename={commitRename}
        onCancelRename={() => setRenamingId(null)}
        onNew={startNewSession}
        onRemove={removeSession}
      />
      <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0, height: "100%" }}>
      <div className="page-header" style={{ padding: "14px 22px 0", marginBottom: 0, display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 16 }}>{t("🤖 Agent 对话")}</h1>
          <div className="desc">
            {t("例如：「写第一集剧本」「把剧本拆成分镜」「按分镜顺序合成成片」—— 高风险操作会先出计划由你批准")}
          </div>
        </div>
        <div style={{ marginLeft: "auto", flexShrink: 0, display: "flex", gap: 8 }}>
          <button className="btn sm" disabled={msgs.length === 0} title={t("清空当前项目的对话记录（本机保存的也会清除）")} onClick={clearChat}>
            {t("🗑 清空对话")}
          </button>
        </div>
      </div>

      <MessageList
        msgs={msgs}
        streamingText={streamingText}
        approving={approving}
        onApprove={approve}
        onReject={reject}
        scrollRef={scrollRef}
      />

      <div style={{ padding: "10px 22px 14px", borderTop: "1px solid var(--border)" }}>
        {/* 模型选择器：输入区上方一行，与参考/发送按钮同一区域 */}
        <ModelSelector aiModel={aiModel} onModelChange={setAiModel} providers={chatProviders} busy={busy} />
        <style>{AGENT_CSS}</style>
        {/* Codex 式输入容器：参考 chip 行 + textarea + 工具行（＋添加参考 / 发送） */}
        <div className={`agent-input-shell${dragOver ? " drag" : ""}`}>
          {totalPending > 0 && (
            <AttachmentChips
              attachments={attachments}
              extras={extras}
              onPreview={setPreview}
              onOpen={openAsset}
              onReveal={revealAsset}
              onRemoveAttachment={removeAttachment}
              onRemoveExtra={(i) => setExtras((xs) => xs.filter((_, j) => j !== i))}
            />
          )}
          <textarea
            placeholder={t("输入消息：例如「写一集都市情感短剧」或「把当前剧本拆成分镜」…（Enter 发送 / Shift+Enter 换行，支持拖入或粘贴文件作为参考）")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="agent-input-toolbar" style={{ position: "relative" }} ref={plusRef}>
            <span className="agent-attach-count" style={{ marginRight: "auto" }}>
              {totalPending > 0 && t("参考 {n}/{max}", { n: totalPending, max: MAX_ATTACHMENTS })}
            </span>
            {/* 大＋（右下独立）：通用功能菜单（Codex 式）——任意格式上传 / 链接 / @画布节点 / 技能 / 工具 / 插件 */}
            <button
              className={`agent-plus-plain${plusMenu ? " active" : ""}`}
              disabled={busy}
              title={t("通用上传与调用：文件 / 链接 / @画布节点 / 技能 / 工具 / 插件")}
              onClick={() => setPlusMenu((v) => (v ? null : "root"))}
            >
              ＋
            </button>
            {/* 分隔线：大＋（功能菜单）与 🔗（添加参考）分属两组 */}
            <span className="agent-toolbar-sep" />
            {/* 🔗 添加参考：全格式资料，严格参考规则 → 项目资产库供生成引用 */}
            <button
              className="agent-link-ic"
              disabled={busy}
              title={t("添加参考：图片/视频/音频/文本/文件等全格式资料（严格参考规则，自动存入项目资产库供生成引用）")}
              onClick={addAttachment}
            >
              🔗
            </button>
            {plusMenu && (
              <PlusMenu
                menu={plusMenu}
                onSetMenu={setPlusMenu}
                linkInput={linkInput}
                onLinkInputChange={setLinkInput}
                canvasNodes={canvasNodes}
                skillNames={skillNames}
                onAddExtra={addExtra}
                onLoadCanvasNodes={() => { void loadCanvasNodes(); }}
                onLoadSkills={() => { void loadSkills(); }}
                onSelectTool={selectToolTemplate}
                onPickFile={() => { void importAttachment(); }}
              />
            )}
            {busy && activeJobs.length > 0 && (
              <button className="btn" onClick={() => void stopGenerating()} title={t("取消当前对话任务（远程已提交的由后端取消标志兜底）")}>
                {t("⏹ 停止")}
              </button>
            )}
            <button
              className="btn primary"
              disabled={busy || (!input.trim() && attachments.length === 0 && extras.length === 0)}
              onClick={send}
            >
              {busy ? t("思考中…") : t("发送")}
            </button>
          </div>
        </div>
      </div>

      {/* 附件预览弹窗：文本显示内容预览，图片走 onetv-asset 协议，其他显示元信息卡 */}
      {preview && <AttachmentPreviewModal preview={preview} onClose={() => setPreview(null)} />}

      {/* 删除会话二次确认（替代直接删除，防误触） */}
      {sessionToDelete && (
        <ConfirmDialog
          danger
          title={t("删除会话")}
          message={t("确认删除会话「{title}」？", { title: sessionToDelete.title })}
          onConfirm={confirmRemoveSession}
          onCancel={() => setSessionToDelete(null)}
        />
      )}
      </div>
    </div>
  );
}
