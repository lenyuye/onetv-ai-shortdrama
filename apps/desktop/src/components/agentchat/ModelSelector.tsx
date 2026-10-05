/**
 * AI 模型选择器：输入区上方一行；null=「自动（默认模型/自动路由）」。
 * 自 views/AgentChatView.tsx 原样迁出；Provider 数据源由 useChatProviders 提供。
 */
import { useT } from "../../i18n";
import { type AiModelRef, type ChatProviderOption, encodeModelOption, parseModelOption } from "./constants";

interface ModelSelectorProps {
  aiModel: AiModelRef | null;
  onModelChange: (m: AiModelRef | null) => void;
  providers: ChatProviderOption[];
  busy: boolean;
}

export function ModelSelector({ aiModel, onModelChange, providers, busy }: ModelSelectorProps) {
  const t = useT();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "flex-end",
        gap: 8,
        flexWrap: "wrap",
        marginBottom: 8,
      }}
    >
      <label style={{ fontSize: 12, color: "var(--muted)" }}>{t("AI 模型")}</label>
      <select
        value={aiModel ? encodeModelOption(aiModel) : ""}
        disabled={busy}
        aria-label={t("选择 AI 模型")}
        style={{ minWidth: 220 }}
        onChange={(e) => onModelChange(parseModelOption(e.target.value))}
      >
        <option value="">{t("自动（默认模型/自动路由）")}</option>
        {providers.map((p) => (
          <optgroup key={p.id} label={p.name}>
            {p.models.map((m, i) => (
              <option key={`${m.modelId}-${i}`} value={encodeModelOption({ providerId: p.id, modelId: m.modelId })}>
                {p.name} · {m.modelId}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      {providers.length === 0 && (
        <span style={{ fontSize: 11, color: "var(--muted)" }}>{t("未配置可用对话模型，将使用离线 Mock")}</span>
      )}
    </div>
  );
}
