/**
 * ⌘K 命令面板（v2.11.0）—— Codex 式快速跳转：
 * 输入过滤页面名，↑↓ 选择、Enter 跳转、Esc 关闭。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp, type ViewKey } from "../store";
import { useT } from "../i18n";

const ITEMS: { key: ViewKey; icon: string; label: string; hint: string }[] = [
  { key: "home", icon: "🏠", label: "工作区", hint: "创建 / 打开项目" },
  { key: "projects", icon: "🎬", label: "项目", hint: "分集与 Story Bible" },
  { key: "agent", icon: "🤖", label: "Agent 对话", hint: "自然语言驱动创作" },
  { key: "script", icon: "📝", label: "剧本", hint: "剧本编辑与版本" },
  { key: "storyboard", icon: "🖼️", label: "分镜", hint: "分镜网格与批量出图" },
  { key: "canvas", icon: "🕸️", label: "画布", hint: "节点工作流" },
  { key: "assets", icon: "🗂️", label: "资产", hint: "素材库" },
  { key: "models", icon: "🧠", label: "模型", hint: "Provider 与生成模型设置" },
  { key: "skills", icon: "🧩", label: "Skills", hint: "技能管理" },
  { key: "hermes", icon: "🛰️", label: "Hermes 连接", hint: "双向桥配置" },
  { key: "jobs", icon: "⏳", label: "任务", hint: "队列与批准" },
  { key: "settings", icon: "⚙️", label: "设置", hint: "隐私 / 预算 / 账户" },
];

const CSS = `
.cmdk-overlay { position: fixed; inset: 0; z-index: 200; background: rgba(10, 12, 20, 0.45);
  display: flex; justify-content: center; align-items: flex-start; padding-top: 12vh; }
.cmdk-box { width: min(520px, 92vw); background: var(--panel); border: 1px solid var(--border-strong);
  border-radius: 12px; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45); overflow: hidden; }
.cmdk-input { width: 100%; border: none; outline: none; background: transparent; color: var(--text);
  font-size: 14px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
.cmdk-list { max-height: 46vh; overflow-y: auto; padding: 6px; }
.cmdk-item { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left;
  background: none; border: none; cursor: pointer; color: var(--text);
  padding: 9px 10px; border-radius: 8px; font-size: 13px; font-family: var(--font); }
.cmdk-item.sel { background: var(--panel-3, rgba(120, 140, 255, 0.14)); }
.cmdk-item em { margin-left: auto; font-style: normal; font-size: 11px; color: var(--muted); }
.cmdk-empty { padding: 18px; text-align: center; color: var(--muted); font-size: 12.5px; }
.cmdk-foot { border-top: 1px solid var(--border); padding: 7px 12px; font-size: 10.5px; color: var(--muted);
  display: flex; gap: 14px; }
`;

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const setView = useApp((s) => s.setView);
  const t = useT();
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return ITEMS;
    // 中英文均可过滤:同时匹配原文与译文
    return ITEMS.filter((it) => {
      const label = t(it.label).toLowerCase();
      const hint = t(it.hint).toLowerCase();
      return label.includes(q) || hint.includes(q) || it.label.toLowerCase().includes(q) || it.hint.toLowerCase().includes(q);
    });
  }, [query, t]);

  useEffect(() => {
    setSel(0);
  }, [query]);

  const commit = (key: ViewKey) => {
    setView(key);
    onClose();
  };

  return (
    <div className="cmdk-overlay" onClick={onClose}>
      <div className="cmdk-box" onClick={(e) => e.stopPropagation()}>
        <style>{CSS}</style>
        <input
          className="cmdk-input"
          autoFocus
          placeholder={t("跳转到…（输入页面名过滤）")}
          aria-label={t("命令面板：输入页面名过滤")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((v) => Math.min(items.length - 1, v + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((v) => Math.max(0, v - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              const it = items[sel];
              if (it) commit(it.key);
            }
          }}
        />
        <div className="cmdk-list" ref={listRef}>
          {items.length === 0 ? (
            <div className="cmdk-empty">{t("没有匹配的页面")}</div>
          ) : (
            items.map((it, i) => (
              <button
                key={it.key}
                type="button"
                className={`cmdk-item${i === sel ? " sel" : ""}`}
                onMouseEnter={() => setSel(i)}
                onClick={() => commit(it.key)}
              >
                <span aria-hidden>{it.icon}</span>
                {t(it.label)}
                <em>{t(it.hint)}</em>
              </button>
            ))
          )}
        </div>
        <div className="cmdk-foot">
          <span>{t("↑↓ 选择")}</span>
          <span>{t("Enter 跳转")}</span>
          <span>{t("Esc 关闭")}</span>
          <span style={{ marginLeft: "auto" }}>{t("⌘K 呼出")}</span>
        </div>
      </div>
    </div>
  );
}
