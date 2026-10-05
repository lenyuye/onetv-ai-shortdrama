/**
 * 新建剧本弹窗（粘贴完整剧本文本 → 登记为新版本并切换为激活；自 views/ScriptView.tsx 原样迁出）。
 */
import { useT } from "../../i18n";

interface ScriptNewModalProps {
  epLabel: string;
  title: string;
  text: string;
  saving: boolean;
  onTitleChange: (v: string) => void;
  onTextChange: (v: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}

export function ScriptNewModal({
  epLabel,
  title,
  text,
  saving,
  onTitleChange,
  onTextChange,
  onSubmit,
  onClose,
}: ScriptNewModalProps) {
  const t = useT();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t("🆕 新建剧本")}{epLabel ? ` · ${epLabel}` : ""}</span>
          <button className="btn sm ghost" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>{t("剧本标题")}</label>
            <input
              type="text"
              value={title}
              autoFocus
              placeholder={t("例如：雨夜重逢")}
              onChange={(e) => onTitleChange(e.target.value)}
            />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>{t("剧本内容（必填，粘贴完整剧本文本）")}</label>
            <textarea
              value={text}
              rows={10}
              placeholder={t("粘贴剧本文本，将作为新版本的第 1 场保存…")}
              onChange={(e) => onTextChange(e.target.value)}
            />
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn primary" disabled={!text.trim() || saving} onClick={onSubmit}>
            {t("创建版本")}
          </button>
          <button className="btn" disabled={saving} onClick={onClose}>
            {t("取消")}
          </button>
        </div>
      </div>
    </div>
  );
}
