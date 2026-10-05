/**
 * 计划面板（summary + 步骤 + 风险 tag）。
 * 自 views/ScriptView.tsx 原样迁出；views/ScriptView.tsx 仍 re-export 本组件
 * （StoryboardView 依赖从那里 import，导入路径不可破坏）。
 * 样式（.plan-*）由宿主视图注入的 SCRIPT_CSS 提供。
 */
import type { AgentPlanView } from "../../api-story";
import { useT } from "../../i18n";

export function PlanPanel({ plan }: { plan: AgentPlanView }) {
  const t = useT();
  const riskClass = plan.estimated.risk === "high" ? "red" : plan.estimated.risk === "medium" ? "amber" : "green";
  const riskLabel =
    plan.estimated.risk === "high" ? t("高风险") : plan.estimated.risk === "medium" ? t("中风险") : t("低风险");
  return (
    <div className="plan-panel">
      <div className="plan-summary">{plan.summary || t("（无摘要）")}</div>
      <div className="plan-tags">
        <span className="tag blue">{plan.intent}</span>
        <span className={`tag ${riskClass}`}>{riskLabel}</span>
        <span className="tag">{t("任务 {n}", { n: plan.estimated.jobs })}</span>
        <span className="tag">{t("远程调用 {n}", { n: plan.estimated.remoteCalls })}</span>
      </div>
      <div className="plan-steps">
        {plan.steps.map((s, i) => (
          <div className="plan-step" key={s.id || i}>
            <span className="plan-step-idx">{i + 1}</span>
            <span className="tag mono plan-tool">{s.tool}</span>
            <span className="plan-desc">{s.description}</span>
            <span className={`tag ${s.approval === "required" ? "pink" : ""}`}>
              {s.approval === "required" ? t("需批准") : t("自动")}
            </span>
          </div>
        ))}
      </div>
      <div className="plan-note">{t("批准后将创建任务并在后台执行，可在「任务」页查看进度。")}</div>
    </div>
  );
}
