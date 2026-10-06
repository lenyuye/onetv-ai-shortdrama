/**
 * 多版本导出弹窗 —— 一次把当前成片按多个画幅预设导出。
 *
 * - 预设多选（5 个 checkbox，至少选一个才能确认）
 * - 烧录字幕（默认开）/ SRT 字幕侧车（默认开）
 * - 确认后调 exportRender（每个预设一个 Export 任务），toast 提示去「任务」页
 * - 样式复用 global.css（modal / field / checkbox-row / btn），布局细节用 ex- 前缀 scoped <style>
 */
import { useState } from "react";
import { EXPORT_PRESETS, exportRender } from "../../api-export";
import { errMsg } from "../../api";
import { useApp } from "../../store";
import { useT } from "../../i18n";

/** 预设展示文案（键 = 预设 id，label 走 i18n；id 为持久化耦合字符串不包 t()） */
const PRESET_LABELS: Record<string, string> = {
  douyin_vertical: "抖音竖版 1080×1920",
  xhs_vertical: "小红书竖版 1080×1440",
  horizontal_1080p: "横版 1080p 1920×1080",
  square: "方形 1080×1080",
  master: "母版（保持源画幅）",
};

interface ExportDialogProps {
  /** 当前分集 id */
  episode: string;
  onClose: () => void;
}

export default function ExportDialog({ episode, onClose }: ExportDialogProps) {
  const t = useT();
  const { toast } = useApp();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [burnSubtitle, setBurnSubtitle] = useState(true);
  const [includeSrt, setIncludeSrt] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const togglePreset = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const confirm = async () => {
    if (selected.size === 0 || submitting) return;
    setSubmitting(true);
    try {
      const r = await exportRender(episode, [...selected], burnSubtitle, includeSrt);
      toast(t("已创建 {n} 个导出任务，请到「任务」页查看进度", { n: r?.jobs?.length ?? 0 }), "ok");
      onClose();
    } catch (e) {
      toast(t("创建导出任务失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <style>{EX_DIALOG_CSS}</style>
      <div className="modal" style={{ width: "min(460px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t("📦 多版本导出")}</span>
          <button className="btn sm ghost" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>{t("导出预设（可多选）")}</label>
            <div className="ex-preset-list">
              {EXPORT_PRESETS.map((key) => (
                <label key={key} className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={selected.has(key)}
                    onChange={() => togglePreset(key)}
                  />
                  {t(PRESET_LABELS[key])}
                </label>
              ))}
            </div>
            {selected.size === 0 && <div className="sub ex-hint">{t("请至少选择一个画幅预设")}</div>}
          </div>
          <div className="field">
            <label>{t("选项")}</label>
            <label className="checkbox-row">
              <input type="checkbox" checked={burnSubtitle} onChange={(e) => setBurnSubtitle(e.target.checked)} />
              {t("烧录字幕（硬字幕压入画面）")}
            </label>
            <label className="checkbox-row">
              <input type="checkbox" checked={includeSrt} onChange={(e) => setIncludeSrt(e.target.checked)} />
              {t("导出 SRT 字幕侧车")}
            </label>
          </div>
          <div className="ex-note">{t("将把最近合成的成片转码为选定画幅并导出（本地转码，不出网）。")}</div>
        </div>
        <div className="modal-foot">
          <button className="btn primary" disabled={selected.size === 0 || submitting} onClick={() => void confirm()}>
            {submitting ? t("创建中…") : t("确认导出")}
          </button>
          <button className="btn" disabled={submitting} onClick={onClose}>{t("取消")}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 弹窗局部样式（补充 global.css，ex- 前缀防冲突） ---------------- */

const EX_DIALOG_CSS = `
.ex-preset-list { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; background: var(--bg-deep); border: 1px solid var(--border); border-radius: var(--radius-sm); }
.ex-hint { margin-top: 6px; color: var(--amber); }
.ex-note { color: var(--muted); font-size: 11.5px; line-height: 1.5; }
`;
