/**
 * 通用确认对话框 —— 替代 window.confirm（WKWebView 原生 confirm 为英文、样式不可控且阻塞渲染）。
 * modal-overlay/modal 结构与 LoginView、JobsView 事件时间线等现有 modal 保持一致。
 * danger=true 时确认按钮用红色（删除工程等高危操作）。
 */
import { useT } from "../i18n";

interface ConfirmDialogProps {
  title: string;
  message: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ title, message, danger, onConfirm, onCancel }: ConfirmDialogProps) {
  const t = useT();
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" style={{ width: "min(480px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{title}</span>
          <button className="btn sm ghost" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body">
          <div className="hint" style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>{message}</div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onCancel}>{t("取消")}</button>
          <button className={danger ? "btn danger" : "btn primary"} onClick={onConfirm}>{t("确定")}</button>
        </div>
      </div>
    </div>
  );
}
