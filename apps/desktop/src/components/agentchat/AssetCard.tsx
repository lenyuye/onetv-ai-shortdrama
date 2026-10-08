/**
 * AssetCard —— 对话气泡内嵌产物卡片（v2.26.29，LibTV 式）：
 * 图片缩略图 / 视频内嵌播放 / 音频试听；操作：加入画布 / 打开 / Finder 显示。
 * path 走 onetv-asset:// 协议（与资产库预览同链路）。
 */
import * as api from "../../api";
import { assetUrl } from "../../api-assets";
import { sendAssetsToCanvas } from "../../canvasSend";
import { useApp } from "../../store";
import { useT } from "../../i18n";
import type { ChatMsgAsset } from "../../agentChatStore";

function isImage(a: ChatMsgAsset) {
  return a.kind === "images" || !!a.mime?.startsWith("image/");
}
function isVideo(a: ChatMsgAsset) {
  return a.kind === "videos" || !!a.mime?.startsWith("video/");
}
function isAudio(a: ChatMsgAsset) {
  return a.kind === "audio" || !!a.mime?.startsWith("audio/");
}

const KIND_ICON: Record<string, string> = { images: "🖼", videos: "🎬", audio: "🎧", documents: "📄" };

function AssetCardItem({ asset }: { asset: ChatMsgAsset }) {
  const t = useT();
  const { toast } = useApp();
  return (
    <div className="agent-asset-card" style={{ maxWidth: 260 }}>
      {isImage(asset) ? (
        <img
          src={assetUrl(asset.path)}
          alt={asset.name ?? asset.assetId}
          loading="lazy"
          style={{ width: "100%", maxHeight: 200, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)", cursor: "zoom-in", display: "block" }}
          onClick={() => void api.assetOpen(asset.path).catch(() => toast(t("打开失败"), "err"))}
        />
      ) : isVideo(asset) ? (
        <video
          src={assetUrl(asset.path)}
          controls
          preload="metadata"
          style={{ width: "100%", maxHeight: 220, borderRadius: 8, border: "1px solid var(--border)", display: "block" }}
        />
      ) : isAudio(asset) ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
          <span style={{ fontSize: 20 }}>🎧</span>
          <audio src={assetUrl(asset.path)} controls preload="metadata" style={{ flex: 1, height: 32 }} />
        </div>
      ) : (
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 0", fontSize: 12.5 }}>
          <span>{KIND_ICON[asset.kind] ?? "📄"}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{asset.name || asset.assetId}</span>
        </div>
      )}
      <div className="agent-asset-actions" style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
        <button
          className="btn sm"
          title={t("把该产物作为生成节点加入画布（连线即可继续生成）")}
          onClick={() => void sendAssetsToCanvas([asset], { toast })}
        >
          📍 {t("加入画布")}
        </button>
        <button
          className="btn sm"
          title={t("用系统默认程序打开")}
          onClick={() => void api.assetOpen(asset.path).catch(() => toast(t("打开失败"), "err"))}
        >
          {t("打开")}
        </button>
        <button
          className="btn sm"
          title={t("在 Finder 中显示")}
          onClick={() => void api.assetReveal(asset.path).catch(() => toast(t("打开失败"), "err"))}
        >
          {t("文件夹")}
        </button>
      </div>
    </div>
  );
}

export function AssetCards({ assets }: { assets: ChatMsgAsset[] }) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  return (
    <div className="agent-asset-list" style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 8 }}>
      {assets.map((a, i) => (
        <AssetCardItem key={a.assetId || i} asset={a} />
      ))}
    </div>
  );
}
