/**
 * 计划卡：计划步骤 / 风险与远程调用标签 / 🔎reviewNotes / 批准·拒绝按钮（含自动执行态）。
 * 自 views/AgentChatView.tsx 原样迁出；批准/拒绝动作由主视图回调。
 */
import type { ChatMsg } from "../../agentChatStore";
import { useT } from "../../i18n";
import { INTENT_CN, RISK_TAG } from "./constants";

type PlanData = NonNullable<ChatMsg["plan"]>;

interface PlanCardProps {
  plan: PlanData;
  /** 正在批准中的 planId（按钮转圈文案） */
  approving: string | null;
  onApprove: (planId: string) => void;
  onReject: (planId: string) => void;
}

export function PlanCard({ plan, approving, onApprove, onReject }: PlanCardProps) {
  const t = useT();
  return (
    <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
        <span className="tag blue">{t(INTENT_CN[plan.intent] ?? plan.intent)}</span>
        <span className={`tag ${RISK_TAG[plan.risk] ?? ""}`}>
          {plan.risk === "low" ? t("低风险") : plan.risk === "medium" ? t("中风险") : t("高风险")}
        </span>
        <span className="tag">{t("远程调用 {n}", { n: plan.remoteCalls })}</span>
      </div>
      {plan.steps.map((s, i) => (
        <div key={s.id} style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 3 }}>
          {i + 1}. <span className="tag" style={{ marginRight: 4 }}>{s.tool}</span>
          {s.description}
          {s.approval === "required" && <span className="tag red" style={{ marginLeft: 6 }}>{t("需批准")}</span>}
        </div>
      ))}
      {(plan.reviewNotes ?? []).map((n, i) => (
        <div key={`rn-${i}`} style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>
          🔎 {n}
        </div>
      ))}
      <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
        {plan.auto ? (
          <span className="tag blue">{t("低风险 · 已自动执行")}</span>
        ) : plan.decided === "approved" ? (
          <span className="tag" style={{ color: "#35d07f" }}>{t("✅ 已批准执行")}</span>
        ) : plan.decided === "rejected" ? (
          <span className="tag red">{t("已拒绝")}</span>
        ) : (
          <>
            <button className="btn primary sm" disabled={approving === plan.planId} onClick={() => onApprove(plan.planId)}>
              {approving === plan.planId ? t("批准中…") : t("✓ 批准执行")}
            </button>
            <button className="btn sm" onClick={() => onReject(plan.planId)}>{t("✕ 拒绝")}</button>
          </>
        )}
      </div>
    </div>
  );
}
