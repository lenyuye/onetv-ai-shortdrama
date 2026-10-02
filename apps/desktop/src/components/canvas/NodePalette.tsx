/**
 * 左侧节点面板 —— 按 NODE_PALETTE_ORDER 列出节点类型，点击创建、拖拽到画布创建。
 */
import { NODE_PALETTE_ORDER, NODE_TYPE_DEFS } from "@onetv/node-sdk";
import type { NodeType } from "@onetv/shared-types";
import { NODE_ICONS } from "./canvas-model";

export const NODE_DND_MIME = "application/onetv-node";

interface NodePaletteProps {
  onAdd: (type: NodeType, screenPos?: { x: number; y: number }) => void;
}

export default function NodePalette({ onAdd }: NodePaletteProps) {
  return (
    <aside className="cv-palette">
      <div className="cv-palette-title">节点面板</div>
      <div className="hint">点击创建，或拖拽到画布</div>
      {NODE_PALETTE_ORDER.map((type) => {
        const def = NODE_TYPE_DEFS[type];
        const inputs = (def?.inputs ?? []).map((p) => p.port).join("/");
        const outputs = (def?.outputs ?? []).map((p) => p.port).join("/");
        return (
          <div
            key={type}
            className="cv-palette-item"
            draggable
            title={
              def
                ? `${def.title}\n输入: ${inputs || "无"}\n输出: ${outputs || "无"}`
                : type
            }
            onDragStart={(e) => {
              e.dataTransfer.setData(NODE_DND_MIME, type);
              e.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => onAdd(type)}
          >
            <span className="icon">{NODE_ICONS[type] ?? "⬜"}</span>
            <div className="meta">
              <div className="name">{def?.title ?? type}</div>
              <div className="sub">{type}</div>
            </div>
          </div>
        );
      })}
    </aside>
  );
}
