/**
 * 自定义画布节点卡片 —— 显示类型图标、标题（NODE_TYPE_DEFS）、参数摘要（config 前 2 个键值）
 * 以及输入/输出端口手柄（accept 类型从 NODE_TYPE_DEFS 取）。
 */
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { NODE_TYPE_DEFS } from "@onetv/node-sdk";
import type { CanvasNode } from "@onetv/shared-types";
import { useT } from "../../i18n";
import { NODE_ICONS, configSummary, portCn } from "./canvas-model";

/** 与 canvas.css 中 .cv-node-head 高度保持一致。 */
const HEAD_H = 40;
const ROW_H = 22;
const SUMMARY_H = 30;

export default function CanvasNodeCard(props: NodeProps) {
  const t = useT();
  const cn = (props.data as { cn?: CanvasNode }).cn;
  if (!cn) {
    return (
      <div className="cv-node">
      <div className="cv-node-head">
        <span className="cv-node-icon">❓</span>
          <span className="cv-node-title">{t("未知节点")}</span>
        </div>
      </div>
    );
  }

  const def = NODE_TYPE_DEFS[cn.type];
  // v2.14：禁用/锁定徽标
  const badge = cn.config?.locked === true ? "🔒" : cn.config?.disabled === true ? "⏸" : null;
  const badgeTitle = cn.config?.locked === true ? t("已锁定") : t("已禁用（批量运行跳过）");
  const inputs = def?.inputs ?? [];
  const outputs = def?.outputs ?? [];
  const rows = Math.max(inputs.length, outputs.length, 1);

  return (
    <div
      className={`cv-node${props.selected ? " selected" : ""}`}
      style={{ height: HEAD_H + rows * ROW_H + SUMMARY_H }}
    >
      <div className="cv-node-head">
        <span className="cv-node-icon">{NODE_ICONS[cn.type] ?? "⬜"}</span>
        <span className="cv-node-title">{def ? t(def.title) : cn.title}</span>
        {badge && (
          <span style={{ marginLeft: "auto", fontSize: 11, flexShrink: 0 }} title={badgeTitle}>
            {badge}
          </span>
        )}
        <span className="cv-node-type" title={cn.type}>{def ? t(def.title) : t("节点")}</span>
      </div>

      {inputs.map((p, i) => (
        <Handle
          key={p.port}
          type="target"
          position={Position.Left}
          id={p.port}
          className="cv-handle"
          style={{ top: HEAD_H + i * ROW_H + ROW_H / 2 }}
          title={portCn(p.port) !== p.port ? t("输入连接点（{port}）", { port: portCn(p.port) }) : t("输入连接点")}
        />
      ))}
      {outputs.map((p, i) => (
        <Handle
          key={p.port}
          type="source"
          position={Position.Right}
          id={p.port}
          className="cv-handle"
          style={{ top: HEAD_H + i * ROW_H + ROW_H / 2 }}
          title={portCn(p.port) !== p.port ? t("输出连接点（{port}）", { port: portCn(p.port) }) : t("输出连接点")}
        />
      ))}
      <div className="cv-node-summary" title={JSON.stringify(cn.config ?? {})}>
        {configSummary(cn.config)}
      </div>
    </div>
  );
}
