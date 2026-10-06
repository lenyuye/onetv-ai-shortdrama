/**
 * 会话侧栏（v2.6.3）：多会话新建/切换/双击重命名/删除，各会话独立上下文。
 * 自 views/AgentChatView.tsx 原样迁出；状态与动作由主视图以 props/回调提供。
 */
import { useEffect, useRef, useState } from "react";
import type { ChatSession } from "../../agentChatStore";
import { useT } from "../../i18n";

interface SessionSidebarProps {
  sessions: ChatSession[];
  /** 当前会话 id（用于高亮；主视图已判空） */
  currentSessionId: string | null;
  /** 重命名中的会话 id / 输入框文本（状态所有权在主视图） */
  renamingId: string | null;
  renameText: string;
  onRenameTextChange: (v: string) => void;
  onSwitch: (s: ChatSession) => void;
  onStartRename: (s: ChatSession) => void;
  onCommitRename: () => void;
  onCancelRename: () => void;
  onNew: () => void;
  onRemove: (s: ChatSession) => void;
}

export function SessionSidebar({
  sessions,
  currentSessionId,
  renamingId,
  renameText,
  onRenameTextChange,
  onSwitch,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onNew,
  onRemove,
}: SessionSidebarProps) {
  const t = useT();
  // v2.23 右键菜单:重命名 / 删除(与悬停 × 等效,连续删除更快)
  const [ctx, setCtx] = useState<{ x: number; y: number; session: ChatSession } | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ctx) return;
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setCtx(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtx(null);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctx]);

  const openCtx = (e: React.MouseEvent, session: ChatSession) => {
    e.preventDefault();
    e.stopPropagation();
    // 菜单出现防出屏:右/下边缘收拢
    const x = Math.min(e.clientX, window.innerWidth - 150);
    const y = Math.min(e.clientY, window.innerHeight - 96);
    setCtx({ x, y, session });
  };

  return (
    <aside className="sess-sidebar">
      <div className="sess-head">{t("会话")}</div>
      <button className="btn sm sess-new" onClick={onNew} title={t("新建一个独立上下文的对话")}>
        {t("＋ 新会话")}
      </button>
      <div className="sess-list">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`sess-item${currentSessionId === s.id ? " active" : ""}`}
            title={t("{title}（双击重命名）", { title: s.title })}
            onClick={() => { setCtx(null); onSwitch(s); }}
            onDoubleClick={() => onStartRename(s)}
            onContextMenu={(e) => openCtx(e, s)}
          >
            {renamingId === s.id ? (
              <input
                className="sess-rename"
                autoFocus
                value={renameText}
                onChange={(e) => onRenameTextChange(e.target.value)}
                onBlur={onCommitRename}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onCommitRename();
                  if (e.key === "Escape") onCancelRename();
                }}
              />
            ) : (
              <>
                <span className="sess-title">{s.title}</span>
                <button
                  className="sess-del"
                  title={t("删除会话")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRemove(s);
                  }}
                >
                  ×
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="sess-foot">{t("双击重命名 · 各会话独立上下文")}</div>
      {ctx && (
        <div
          ref={menuRef}
          className="sess-ctx"
          style={{ left: ctx.x, top: ctx.y }}
          role="menu"
        >
          <button
            className="sess-ctx-item"
            role="menuitem"
            onClick={() => { onStartRename(ctx.session); setCtx(null); }}
          >
            ✏️ {t("重命名")}
          </button>
          <button
            className="sess-ctx-item danger"
            role="menuitem"
            onClick={() => { const target = ctx.session; setCtx(null); onRemove(target); }}
          >
            🗑 {t("删除会话")}
          </button>
        </div>
      )}
      <style>{`
        .sess-ctx { position: fixed; z-index: 1300; min-width: 132px; padding: 4px;
          background: var(--panel-3); border: 1px solid var(--border-strong); border-radius: 10px;
          box-shadow: var(--shadow); display: flex; flex-direction: column; gap: 2px; }
        .sess-ctx-item { display: flex; align-items: center; gap: 6px; background: none; border: none;
          color: var(--text); font-size: 12.5px; padding: 7px 10px; border-radius: 7px; cursor: pointer;
          text-align: left; font-family: var(--font); }
        .sess-ctx-item:hover { background: var(--panel-2); }
        .sess-ctx-item.danger:hover { background: rgba(255, 84, 112, 0.14); color: var(--red); }
      `}</style>
    </aside>
  );
}
