/**
 * 📜 自定义指令（v2.26.16）—— Codex「自定义指令/AGENTS.md」式：
 * 用户写一段持久指令，保存到设置（customInstructions），Agent 对话时注入系统提示。
 * 布局对标 Codex：标题 + 说明 + 大 textarea + 保存（⌘S）。
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import { errMsg } from "../hooks/useProviderEditor";
import { useApp } from "../store";
import { t, useT } from "../i18n";

export function InstructionsView() {
  const { settings, patchSettings, toast } = useApp();
  const t = useT();
  const [text, setText] = useState(settings?.customInstructions ?? "");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setText(settings?.customInstructions ?? "");
    setDirty(false);
  }, [settings?.customInstructions]);

  const save = async () => {
    setSaving(true);
    try {
      await patchSettings({ customInstructions: text });
      setDirty(false);
      toast(t("自定义指令已保存，立即对 Agent 对话生效"), "ok");
    } catch (e) {
      toast(t("保存失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ padding: "18px 22px", height: "100%", display: "flex", flexDirection: "column", gap: 10, overflow: "auto" }}>
      <h3 style={{ margin: 0 }}>{t("📜 自定义指令")}</h3>
      <div className="hint">
        {t("写给 Agent 的持久指令：风格约定、人物口癖、剧本格式、禁用词等。保存后对全部 Agent 对话生效（数据仅存本机设置）。")}
      </div>
      <textarea
        value={text}
        onChange={(e) => { setText(e.target.value); setDirty(true); }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            void save();
          }
        }}
        placeholder={t(
          "例如：\n· 剧本一律竖屏 9:16，单集 2 分钟，台词口语化\n· 主角林晚，27 岁刑警，冷静少言，口头禅「证据说话」\n· 禁用词：\'就是这么简单\'、\'你值得拥有\'",
        )}
        style={{
          flex: 1, minHeight: 300, resize: "none",
          background: "var(--bg-deep)", border: "1px solid var(--border-strong)", borderRadius: 12,
          padding: "14px 16px", color: "var(--text)", fontSize: 13, lineHeight: 1.7,
          fontFamily: "var(--font)",
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = "var(--blue)"; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = "var(--border-strong)"; }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span className="hint" style={{ marginRight: "auto" }}>
          {t("{n} 字 · ⌘S 保存", { n: text.trim().length })}
        </span>
        <button className="btn primary" disabled={saving || !dirty} onClick={() => void save()}>
          {saving ? t("保存中…") : t("保存")}
        </button>
      </div>
    </div>
  );
}
