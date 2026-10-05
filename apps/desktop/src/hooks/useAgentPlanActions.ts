/**
 * Agent 计划批准/拒绝 hook：approving 状态 + agentApprove 编排 + 消息就地更新。
 * 自 views/AgentChatView.tsx 原样迁出；依赖主视图提供的 chatKey 与当前会话。
 */
import { useState } from "react";
import * as story from "../api-story";
import { useAgentChat, rememberJobSession, type ChatSession } from "../agentChatStore";
import { useT } from "../i18n";

interface UseAgentPlanActionsParams {
  chatKey: string;
  currentSession: ChatSession | null;
  toast: (text: string, kind?: "ok" | "err") => void;
}

export function useAgentPlanActions({ chatKey, currentSession, toast }: UseAgentPlanActionsParams) {
  const t = useT();
  /** 正在批准中的 planId（按钮转圈文案） */
  const [approving, setApproving] = useState<string | null>(null);

  const approve = async (planId: string) => {
    setApproving(planId);
    try {
      const ids = await story.agentApprove(planId);
      toast(t("已批准，创建了 {n} 个任务（可在「任务」页查看进度）", { n: ids.length }), "ok");
      if (chatKey && currentSession && ids.length > 0) {
        rememberJobSession(ids, chatKey, currentSession.id);
      }
      if (chatKey && currentSession) {
        useAgentChat.getState().updateByPlanId(chatKey, currentSession.id, planId, (msg) => {
          if (!msg.plan) return msg;
          const plan = { ...msg.plan, decided: "approved" as const };
          return { ...msg, plan, text: `${msg.text}\n\n${t("✅ 已批准执行 → 任务 {n} 个已进入队列", { n: ids.length })}` };
        });
      }
    } catch (e) {
      toast(t("批准失败：{msg}", { msg: story.errMsg(e) }), "err");
    } finally {
      setApproving(null);
    }
  };

  const reject = (planId: string) => {
    if (!chatKey || !currentSession) return;
    useAgentChat.getState().updateByPlanId(chatKey, currentSession.id, planId, (msg) => {
      if (!msg.plan) return msg;
      const plan = { ...msg.plan, decided: "rejected" as const };
      return { ...msg, plan, text: `${msg.text}\n\n${t("❌ 已拒绝（未创建任何任务）")}` };
    });
  };

  return { approving, approve, reject };
}
