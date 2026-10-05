/**
 * 输入区附件 chip 行：文件参考 chips（查看/打开/Finder/移除）与大＋条目 chips（链接/@节点/技能/工具，仅移除）。
 * 自 views/AgentChatView.tsx 原样迁出；增删/预览动作由主视图回调。
 */
import type * as api from "../../api";
import { useT } from "../../i18n";
import { type PendingExtra, fmtSize, kindCn, kindIcon } from "./constants";

interface AttachmentChipsProps {
  attachments: api.AgentAttachment[];
  extras: PendingExtra[];
  onPreview: (a: api.AgentAttachment) => void;
  onOpen: (a: api.AgentAttachment) => void;
  onReveal: (a: api.AgentAttachment) => void;
  onRemoveAttachment: (index: number) => void;
  onRemoveExtra: (index: number) => void;
}

export function AttachmentChips({
  attachments,
  extras,
  onPreview,
  onOpen,
  onReveal,
  onRemoveAttachment,
  onRemoveExtra,
}: AttachmentChipsProps) {
  const t = useT();
  return (
    <div className="agent-chip-row">
      {attachments.map((a, i) => (
        <span
          key={`${a.assetId}-${i}`}
          className="agent-chip"
          title={`${t(kindCn(a.kind))} · ${fmtSize(a.sizeBytes)}\n${a.path}`}
        >
          <span className="agent-chip-icon">{kindIcon(a.kind)}</span>
          <span className="agent-chip-name">{a.name}</span>
          <span className="agent-chip-actions">
            <button title={t("查看")} onClick={() => onPreview(a)}>
              {t("查看")}
            </button>
            <button title={t("用系统默认应用打开（可编辑）")} onClick={() => void onOpen(a)}>
              {t("打开")}
            </button>
            <button title={t("在 Finder 中显示")} onClick={() => void onReveal(a)}>
              Finder
            </button>
            <button
              className="agent-chip-remove"
              title={t("移除参考（不影响已导入的资产）")}
              onClick={() => onRemoveAttachment(i)}
            >
              ×
            </button>
          </span>
        </span>
      ))}
      {extras.map((x, i) => (
        <span key={`x-${i}`} className="agent-chip" title={x.kind === "link" ? x.url : x.kind === "node" ? t("画布节点 {id}", { id: x.id }) : x.kind === "skill" ? t("调用技能") : t("调用工具")}>
          <span className="agent-chip-icon">{x.kind === "link" ? "🔗" : x.kind === "node" ? "⚓" : x.kind === "skill" ? "🧩" : "🛠️"}</span>
          <span className="agent-chip-name">
            {x.kind === "link" ? x.url : x.kind === "node" ? `@${x.title}` : x.kind === "skill" ? t("技能：{name}", { name: x.name }) : t("工具：{name}", { name: x.name })}
          </span>
          <span className="agent-chip-actions">
            <button
              className="agent-chip-remove"
              title={t("移除")}
              onClick={() => onRemoveExtra(i)}
            >
              ×
            </button>
          </span>
        </span>
      ))}
    </div>
  );
}
