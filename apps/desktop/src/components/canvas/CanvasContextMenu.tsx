/**
 * 画布右键菜单浮层（展示型子组件，从 CanvasView 拆出，DOM/文案/样式不变）：
 * - 画布空白处：新建全部类型节点 / 粘贴 / 适应视图；
 * - 节点：生成对话 / 复制 / 粘贴 / 删除；
 * - 连线：删除。
 * <style> 注入保持与拆分前一致：无论菜单是否打开都渲染（fixed 定位浮层）。
 */
import type { MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import type { NodeType } from "@onetv/shared-types";
import { useT } from "../../i18n";
import { NODE_ICONS } from "./canvas-model";
import type { CtxMenuState } from "../../hooks/useCanvasContextMenu";

/** 新建节点菜单条目（11 种节点全部可建）。 */
const NODE_TYPE_ITEMS: { type: NodeType; label: string; icon: string }[] = [
  { type: "asset", label: "素材", icon: NODE_ICONS.asset },
  { type: "text", label: "文本", icon: NODE_ICONS.text },
  { type: "script", label: "剧本", icon: NODE_ICONS.script },
  { type: "image", label: "图片", icon: NODE_ICONS.image },
  { type: "video", label: "视频", icon: NODE_ICONS.video },
  { type: "audio", label: "音频", icon: NODE_ICONS.audio },
  { type: "storyboard", label: "分镜", icon: NODE_ICONS.storyboard },
  { type: "video-clip", label: "视频片段", icon: NODE_ICONS["video-clip"] },
  { type: "condition", label: "条件", icon: NODE_ICONS.condition },
  { type: "review", label: "审核", icon: NODE_ICONS.review },
  { type: "export", label: "导出", icon: NODE_ICONS.export },
];

/** 右键菜单浮层样式：复用 global.css 设计令牌的深色卡片风格。 */
const CTX_MENU_CSS = `
.cv-ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 176px;
  background: var(--panel-3);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  padding: 5px;
  user-select: none;
}
.cv-ctx-label {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  padding: 5px 10px 3px;
}
.cv-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-family: var(--font);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.cv-ctx-item:hover:not(:disabled) {
  background: var(--panel-2);
  color: var(--text);
}
.cv-ctx-item:disabled {
  opacity: 0.38;
  cursor: default;
}
.cv-ctx-item.danger { color: var(--red); }
.cv-ctx-item.danger:hover:not(:disabled) { background: rgba(255, 84, 112, 0.12); }
.cv-ctx-item .icon { width: 16px; text-align: center; }
.cv-ctx-sep { height: 1px; margin: 4px 6px; background: var(--border); }
`;

export interface CanvasContextMenuProps {
  menu: CtxMenuState | null;
  menuRef: MutableRefObject<HTMLDivElement | null>;
  clipboardHasData: boolean;
  /** 当前选中节点数（>1 时节点菜单删除项显示「删除选中节点」） */
  selNodeCount: number;
  onClose: () => void;
  onAddNode: (type: NodeType, screenPos?: { x: number; y: number }) => void;
  onPaste: (flowPos: { x: number; y: number }) => void;
  onFitAll: () => void;
  onOpenNodeChat: (nodeId: string) => void;
  onCopy: (nodeId?: string) => void;
  onDeleteNodes: (nodeId: string) => void;
  onDeleteEdge: (edgeId: string) => void;
}

export default function CanvasContextMenu({
  menu,
  menuRef,
  clipboardHasData,
  selNodeCount,
  onClose,
  onAddNode,
  onPaste,
  onFitAll,
  onOpenNodeChat,
  onCopy,
  onDeleteNodes,
  onDeleteEdge,
}: CanvasContextMenuProps) {
  const t = useT();

  return (
    <>
      <style>{CTX_MENU_CSS}</style>

      {/* 右键菜单浮层（fixed 定位，点击外部 / Escape / 滚动 / 平移关闭） */}
      {menu && (
        <div
          ref={menuRef}
          className="cv-ctx-menu"
          style={{ left: menu.x, top: menu.y }}
          onContextMenu={(e: ReactMouseEvent) => e.preventDefault()}
        >
          {menu.kind === "pane" && (
            <>
              <div className="cv-ctx-label">{t("新建节点")}</div>
              {NODE_TYPE_ITEMS.map((it) => (
                <button
                  key={it.type}
                  className="cv-ctx-item"
                  onClick={() => {
                    onAddNode(it.type, menu.screen);
                    onClose();
                  }}
                >
                  <span className="icon">{it.icon}</span>
                  {t(it.label)}
                </button>
              ))}
              <div className="cv-ctx-sep" />
              <button
                className="cv-ctx-item"
                disabled={!clipboardHasData}
                title={clipboardHasData ? t("粘贴复制的节点") : t("剪贴板为空")}
                onClick={() => {
                  onPaste(menu.flow);
                  onClose();
                }}
              >
                <span className="icon">📋</span>
                {t("粘贴")}
              </button>
              <button
                className="cv-ctx-item"
                onClick={() => {
                  onFitAll();
                  onClose();
                }}
              >
                <span className="icon">⤢</span>
                {t("适应视图")}
              </button>
            </>
          )}

          {menu.kind === "node" && menu.nodeId && (
            <>
              <button
                className="cv-ctx-item"
                onClick={() => {
                  onOpenNodeChat(menu.nodeId as string);
                }}
              >
                <span className="icon">⚡</span>
                {t("生成 / 对话…")}
              </button>
              <button
                className="cv-ctx-item"
                onClick={() => {
                  onCopy(menu.nodeId);
                  onClose();
                }}
              >
                <span className="icon">⧉</span>
                {t("复制")}
              </button>
              <button
                className="cv-ctx-item"
                disabled={!clipboardHasData}
                title={clipboardHasData ? t("粘贴复制的节点") : t("剪贴板为空")}
                onClick={() => {
                  onPaste(menu.flow);
                  onClose();
                }}
              >
                <span className="icon">📋</span>
                {t("粘贴")}
              </button>
              <div className="cv-ctx-sep" />
              <button
                className="cv-ctx-item danger"
                onClick={() => {
                  onDeleteNodes(menu.nodeId as string);
                  onClose();
                }}
              >
                <span className="icon">🗑</span>
                {selNodeCount > 1 ? t("删除选中节点") : t("删除该节点")}
              </button>
            </>
          )}

          {menu.kind === "edge" && menu.edgeId && (
            <button
              className="cv-ctx-item danger"
              onClick={() => {
                onDeleteEdge(menu.edgeId as string);
                onClose();
              }}
            >
              <span className="icon">🗑</span>
              {t("删除连线")}
            </button>
          )}
        </div>
      )}
    </>
  );
}
