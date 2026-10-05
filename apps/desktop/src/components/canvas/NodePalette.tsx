/**
 * 左侧节点面板 —— 按 NODE_PALETTE_ORDER 列出节点类型，点击创建、拖拽到画布创建。
 */
import { NODE_PALETTE_ORDER, NODE_TYPE_DEFS } from "@onetv/node-sdk";
import type { NodeType } from "@onetv/shared-types";
import { useT } from "../../i18n";
import { NODE_ICONS } from "./canvas-model";

export const NODE_DND_MIME = "application/onetv-node";

interface NodePaletteProps {
  onAdd: (type: NodeType, screenPos?: { x: number; y: number }) => void;
}

export default function NodePalette({ onAdd }: NodePaletteProps) {
  const t = useT();
  return (
    <aside className="cv-palette">
      <div className="cv-palette-title">{t("节点面板")}</div>
      <div className="hint">{t("点击创建，或拖拽到画布")}</div>
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
                ? t("{title}\n输入: {inputs}\n输出: {outputs}", {
                    title: t(def.title),
                    inputs: inputs || t("无"),
                    outputs: outputs || t("无"),
                  })
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
              <div className="name">{def ? t(def.title) : type}</div>
              <div className="sub">{type}</div>
            </div>
          </div>
        );
      })}
    </aside>
  );
}
