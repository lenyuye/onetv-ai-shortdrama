/**
 * 左侧节点面板 —— 按 NODE_PALETTE_ORDER 列出节点类型，点击创建、拖拽到画布创建。
 * v2.23 拖拽改指针式自绘实现：WKWebView 对 HTML5 DnD（draggable div → 自定义 drop 目标）
 * 不可靠（dragstart 经常不触发），改为 mousedown→move(>6px)→mouseup 全程鼠标事件，
 * 松手落在画布内即在该位置建节点；普通点击（无位移）仍走 onClick 建在画布中心。
 */
import { useRef, useState } from "react";
import { NODE_PALETTE_ORDER, NODE_TYPE_DEFS } from "@onetv/node-sdk";
import type { NodeType } from "@onetv/shared-types";
import { useT } from "../../i18n";
import { NODE_ICONS } from "./canvas-model";

export const NODE_DND_MIME = "application/onetv-node";

interface NodePaletteProps {
  onAdd: (type: NodeType, screenPos?: { x: number; y: number }) => void;
  /** 画布包装层 ref：松手位置在其内才算拖拽落点 */
  canvasRef: React.RefObject<HTMLDivElement | null>;
}

const DRAG_THRESHOLD = 6;

export default function NodePalette({ onAdd, canvasRef }: NodePaletteProps) {
  const t = useT();
  const [ghost, setGhost] = useState<{ type: NodeType; x: number; y: number } | null>(null);
  const dragRef = useRef<{ type: NodeType; startX: number; startY: number; active: boolean } | null>(null);

  const beginDrag = (type: NodeType) => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { type, startX: e.clientX, startY: e.clientY, active: false };

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = ev.clientX - d.startX;
      const dy = ev.clientY - d.startY;
      if (!d.active && Math.hypot(dx, dy) > DRAG_THRESHOLD) d.active = true;
      if (d.active) setGhost({ type: d.type, x: ev.clientX, y: ev.clientY });
    };
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const d = dragRef.current;
      dragRef.current = null;
      setGhost(null);
      if (!d || !d.active) return; // 普通点击：交给 onClick
      const rect = canvasRef.current?.getBoundingClientRect();
      if (rect && ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
        onAdd(d.type, { x: ev.clientX, y: ev.clientY });
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

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
            style={{ userSelect: "none", WebkitUserSelect: "none" }}
            title={
              def
                ? t("{title}\n输入: {inputs}\n输出: {outputs}", {
                    title: t(def.title),
                    inputs: inputs || t("无"),
                    outputs: outputs || t("无"),
                  })
                : type
            }
            onMouseDown={beginDrag(type)}
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
      {ghost && (
        <div
          style={{
            position: "fixed", left: ghost.x + 14, top: ghost.y + 10, zIndex: 1300,
            pointerEvents: "none", padding: "6px 10px", borderRadius: 8,
            background: "var(--panel-3)", border: "1px solid var(--border-strong)",
            fontSize: 12.5, boxShadow: "var(--shadow)", display: "flex", gap: 6, alignItems: "center",
          }}
        >
          <span>{NODE_ICONS[ghost.type] ?? "⬜"}</span>
          <span>{NODE_TYPE_DEFS[ghost.type] ? t(NODE_TYPE_DEFS[ghost.type].title) : ghost.type}</span>
        </div>
      )}
    </aside>
  );
}
