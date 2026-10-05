/**
 * 附件预览弹窗：文本显示内容预览，图片走 onetv-asset 协议，其他显示元信息卡。
 * 自 views/AgentChatView.tsx 原样迁出；关闭即主视图清空 preview 状态。
 */
import type * as api from "../../api";
import { assetUrl } from "../../api-assets";
import { useT } from "../../i18n";
import { fmtSize, kindCn, kindIcon } from "./constants";

interface AttachmentPreviewModalProps {
  preview: api.AgentAttachment;
  onClose: () => void;
}

export function AttachmentPreviewModal({ preview, onClose }: AttachmentPreviewModalProps) {
  const t = useT();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal"
        style={{ width: "min(680px, 92vw)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span>
            {t("{icon} 参考预览 · {name}", { icon: kindIcon(preview.kind), name: preview.name })}
          </span>
          <button className="btn sm" onClick={onClose}>
            {t("关闭")}
          </button>
        </div>
        <div className="modal-body">
          {preview.textPreview ? (
            <pre className="agent-preview-text">{preview.textPreview}</pre>
          ) : preview.kind === "images" ? (
            <img className="agent-preview-img" src={assetUrl(preview.path)} alt={preview.name} />
          ) : (
            <div className="agent-preview-meta">
              <div>
                <span>{t("名称")}</span>
                <span>{preview.name}</span>
              </div>
              <div>
                <span>{t("类型")}</span>
                <span>
                  {t(kindCn(preview.kind))}（{preview.mime || t("未知 MIME")}）
                </span>
              </div>
              <div>
                <span>{t("大小")}</span>
                <span>{fmtSize(preview.sizeBytes)}</span>
              </div>
              <div>
                <span>{t("路径")}</span>
                <span>{preview.path}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
