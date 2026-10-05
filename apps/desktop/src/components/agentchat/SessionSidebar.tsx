/**
 * 会话侧栏（v2.6.3）：多会话新建/切换/双击重命名/删除，各会话独立上下文。
 * 自 views/AgentChatView.tsx 原样迁出；状态与动作由主视图以 props/回调提供。
 */
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
            onClick={() => onSwitch(s)}
            onDoubleClick={() => onStartRename(s)}
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
    </aside>
  );
}
