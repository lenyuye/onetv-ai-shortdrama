/**
 * 自定义画布节点卡片 —— 显示类型图标、标题（NODE_TYPE_DEFS）、参数摘要（config 前 2 个键值）
 * 以及输入/输出端口手柄（accept 类型从 NODE_TYPE_DEFS 取）。
 */
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { NODE_TYPE_DEFS } from "@onetv/node-sdk";
import type { CanvasNode } from "@onetv/shared-types";
import { NODE_ICONS, configSummary, portCn } from "./canvas-model";

/** 与 canvas.css 中 .cv-node-head 高度保持一致。 */
const HEAD_H = 40;
const ROW_H = 22;
const SUMMARY_H = 30;

export default function CanvasNodeCard(props: NodeProps) {
  const cn = (props.data as { cn?: CanvasNode }).cn;
  if (!cn) {
    return (
      <div className="cv-node">
        <div className="cv-node-head">
          <span className="cv-node-icon">❓</span>
          <span className="cv-node-title">未知节点</span>
        </div>
      </div>
    );
  }

  const def = NODE_TYPE_DEFS[cn.type];
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
        <span className="cv-node-title">{def?.title ?? cn.title}</span>
        <span className="cv-node-type" title={cn.type}>{def?.title ?? "节点"}</span>
      </div>

      {inputs.map((p, i) => (
        <Handle
          key={p.port}
          type="target"
          position={Position.Left}
          id={p.port}
          className="cv-handle"
          style={{ top: HEAD_H + i * ROW_H + ROW_H / 2 }}
          title={`输入连接点${portCn(p.port) !== p.port ? `（${portCn(p.port)}）` : ""}`}
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
          title={`输出连接点${portCn(p.port) !== p.port ? `（${portCn(p.port)}）` : ""}`}
        />
      ))}
      <div className="cv-node-summary" title={JSON.stringify(cn.config ?? {})}>
        {configSummary(cn.config)}
      </div>
    </div>
  );
}
