/**
 * SlashMenu —— 输入框斜杠命令菜单（v2.26.29，LibTV 式快捷指令）：
 * 输入 "/" 触发，按输入前缀过滤；点击或 Tab 补全插入模板；Esc 关闭。
 * 立即执行型命令（/清空）通过 onImmediate 回调交给视图处理。
 */
import { SLASH_COMMANDS } from "./constants";
import { useT } from "../../i18n";

interface SlashMenuProps {
  /** 当前输入（以 "/" 开头时菜单显示） */
  input: string;
  onPick: (tpl: string) => void;
  onImmediate: (action: "clear") => void;
  onClose: () => void;
}

export function SlashMenu({ input, onPick, onImmediate, onClose }: SlashMenuProps) {
  const t = useT();
  const q = input.startsWith("/") ? input.slice(1).toLowerCase() : null;
  if (q === null) return null;
  const hits = SLASH_COMMANDS.filter(
    (c) => q === "" || c.cmd.slice(1).toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q)
  );
  if (hits.length === 0) return null;
  return (
    <div
      className="agent-slash-menu"
      style={{
        position: "absolute", left: 0, right: 0, bottom: "calc(100% + 6px)",
        background: "var(--panel-2)", border: "1px solid var(--border-strong)", borderRadius: 10,
        boxShadow: "0 10px 34px rgba(0,0,0,.28)", padding: 4, zIndex: 60,
        maxHeight: 260, overflowY: "auto",
      }}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div style={{ fontSize: 10, color: "var(--muted)", padding: "4px 10px" }}>
        {t("斜杠命令 —— Tab 或点击补全，Esc 关闭")}
      </div>
      {hits.map((c) => (
        <button
          key={c.cmd}
          style={{
            display: "flex", alignItems: "center", gap: 8, width: "100%", textAlign: "left",
            background: "none", border: "none", cursor: "pointer", borderRadius: 6,
            padding: "7px 10px", color: "var(--text)", fontFamily: "var(--font)", fontSize: 12.5,
          }}
          onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(255,255,255,.08)")}
          onMouseLeave={(e) => (e.currentTarget.style.background = "none")}
          onClick={() => {
            onClose();
            if (c.immediate === "clear") onImmediate("clear");
            else onPick(c.tpl);
          }}
        >
          <code style={{ color: "var(--accent, #7c8cff)", fontWeight: 700, minWidth: 52 }}>{c.cmd}</code>
          <span style={{ color: "var(--muted)", fontSize: 11.5 }}>{t(c.name)}</span>
        </button>
      ))}
    </div>
  );
}
