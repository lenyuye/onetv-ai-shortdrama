/**
 * Agent 对话模型选择器数据源 hook：一次拉取 Provider 列表并缓存
 * （只留已启用 + 含 chat 能力模型的 Provider）。自 views/AgentChatView.tsx 原样迁出。
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import type { ChatProviderOption } from "../components/agentchat/constants";

export function useChatProviders() {
  const [chatProviders, setChatProviders] = useState<ChatProviderOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .providerList()
      .then((list) => {
        if (cancelled) return;
        setChatProviders(
          list
            .filter((p) => p.enabled && p.models.some((m) => m.capabilities.includes("chat")))
            .map((p) => ({
              id: p.id,
              name: p.name,
              models: p.models.filter((m) => m.capabilities.includes("chat")),
            }))
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return { chatProviders };
}
