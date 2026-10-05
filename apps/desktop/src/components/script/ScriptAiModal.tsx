/**
 * AI 生成剧本弹窗（一句话需求 → 执行计划 → 批准执行 / 低风险自动执行；含对话模型选择器）。
 * 自 views/ScriptView.tsx 原样迁出；生成状态与请求逻辑（runChat / approvePlan）留在 ScriptView。
 */
import type { AgentPlanView } from "../../api-story";
import { useT } from "../../i18n";
import type { ChatProviderOption } from "../agentchat/constants";
import { PlanPanel } from "./PlanPanel";

/** 所选 AI 对话模型（null = 自动：模型页「生成模型设置」的默认模型或自动路由） */
export type AiModelRef = { providerId: string; modelId: string };

/** 下拉选项值编码：providerId 与 modelId 用 "::" 分隔（与模型页 modelOptionValue 一致） */
const encodeModelOption = (m: AiModelRef) => `${m.providerId}::${m.modelId}`;
const parseModelOption = (v: string): AiModelRef | null => {
  if (!v) return null;
  const i = v.indexOf("::");
  return i > 0 && i < v.length - 2 ? { providerId: v.slice(0, i), modelId: v.slice(i + 2) } : null;
};

interface ScriptAiModalProps {
  epLabel: string;
  prompt: string;
  onPromptChange: (v: string) => void;
  plan: AgentPlanView | null;
  autoExecuted: boolean;
  chatBusy: boolean;
  approveBusy: boolean;
  aiErr: string;
  aiModel: AiModelRef | null;
  onAiModelChange: (m: AiModelRef | null) => void;
  chatProviders: ChatProviderOption[];
  onClose: () => void;
  onRun: () => void;
  onApprove: () => void;
}

export function ScriptAiModal({
  epLabel,
  prompt,
  onPromptChange,
  plan,
  autoExecuted,
  chatBusy,
  approveBusy,
  aiErr,
  aiModel,
  onAiModelChange,
  chatProviders,
  onClose,
  onRun,
  onApprove,
}: ScriptAiModalProps) {
  const t = useT();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t("✨ AI 生成剧本")}{epLabel ? ` · ${epLabel}` : ""}</span>
          <button className="btn sm ghost" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {!plan ? (
            <>
              <div className="field">
                <label>{t("一句话需求")}</label>
                <textarea
                  value={prompt}
                  rows={4}
                  autoFocus
                  placeholder={t("一句话需求：都市情感短剧，女主是咖啡店老板…")}
                  onChange={(e) => onPromptChange(e.target.value)}
                />
                <div className="sub">
                  {t("Agent 会先给出执行计划；剧本生成将调用 Chat Provider（可能联网出站）")}
                </div>
              </div>
              {aiErr && <div className="script-err">⚠️ {aiErr}</div>}
              {/* 模型选择器：生成按钮上方 */}
              <div className="field" style={{ marginBottom: 0 }}>
                <label>{t("AI 模型")}</label>
                <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                  <select
                    value={aiModel ? encodeModelOption(aiModel) : ""}
                    disabled={chatBusy || approveBusy}
                    aria-label={t("选择 AI 模型")}
                    style={{ minWidth: 220 }}
                    onChange={(e) => onAiModelChange(parseModelOption(e.target.value))}
                  >
                    <option value="">{t("自动（默认模型/自动路由）")}</option>
                    {chatProviders.map((p) => (
                      <optgroup key={p.id} label={p.name}>
                        {p.models.map((m, i) => (
                          <option
                            key={`${m.modelId}-${i}`}
                            value={encodeModelOption({ providerId: p.id, modelId: m.modelId })}
                          >
                            {p.name} · {m.modelId}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {chatProviders.length === 0 && (
                    <span style={{ fontSize: 11, color: "var(--muted)" }}>
                      {t("未配置可用对话模型，将使用离线 Mock")}
                    </span>
                  )}
                </div>
              </div>
            </>
          ) : autoExecuted ? (
            <div className="plan-done">
              <div className="big">✅</div>
              <p>{t("低风险任务已自动执行，无需批准。稍后刷新即可查看结果。")}</p>
              <p className="hint">{plan.summary}</p>
            </div>
          ) : (
            <PlanPanel plan={plan} />
          )}
        </div>
        <div className="modal-foot">
          {!plan ? (
            <button
              className="btn primary"
              disabled={!prompt.trim() || chatBusy}
              onClick={onRun}
            >
              {chatBusy ? t("规划中…") : t("生成执行计划")}
            </button>
          ) : autoExecuted ? (
            <button className="btn primary" onClick={onClose}>{t("好的")}</button>
          ) : (
            <button className="btn primary" disabled={approveBusy} onClick={onApprove}>
              {approveBusy ? t("执行中…") : t("批准执行")}
            </button>
          )}
          <button className="btn" disabled={chatBusy || approveBusy} onClick={onClose}>
            {plan && !autoExecuted ? t("拒绝") : t("取消")}
          </button>
        </div>
      </div>
    </div>
  );
}
