/**
 * AssetCard —— 对话气泡内嵌产物卡片（v2.26.29，LibTV 式）：
 * 图片缩略图 / 视频内嵌播放 / 音频试听；操作：加入画布 / 打开 / Finder 显示。
 * path 走 onetv-asset:// 协议（与资产库预览同链路）。
 */
import * as api from "../../api";
import { assetUrl, cleanAssetPath, exportAssetWithPicker } from "../../api-assets";
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
  // v2.26.157：路径归一（历史脏数据可能带 "?e=签名" 查询串）+ 统一的打开失败归因
  const path = cleanAssetPath(asset.path ?? "");
  const openFile = () =>
    void api.assetOpen(path).catch((e) => toast(t("打开失败：{msg}", { msg: api.errMsg(e) }), "err"));
  const revealFile = () =>
    void api.assetReveal(path).catch((e) => toast(t("打开失败：{msg}", { msg: api.errMsg(e) }), "err"));
  // v2.26.158：下载改为先弹系统目录选择器（自选保存位置），取消则不导出
  const downloadFile = () =>
    void exportAssetWithPicker(path)
      .then((dest) => {
        if (dest) toast(t("已下载到：{path}", { path: dest }), "ok");
      })
      .catch((e) => toast(t("下载失败：{msg}", { msg: api.errMsg(e) }), "err"));
  // v2.26.110：path 缺省防御——事件漏发 path 时不再生成 .../undefined 的坏 src（裂图 + 打开必失败）
  if (!asset.path) {
    return (
      <div className="agent-asset-card" style={{ maxWidth: 260 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 0", fontSize: 12.5, color: "var(--muted)" }}>
          <span>{KIND_ICON[asset.kind] ?? "📄"}</span>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {asset.name || asset.assetId}（{t("文件路径缺失")}）
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="agent-asset-card" style={{ maxWidth: 260 }}>
      {isImage(asset) ? (
        <img
          src={assetUrl(path)}
          alt={asset.name ?? asset.assetId}
          loading="lazy"
          style={{ width: "100%", maxHeight: 200, objectFit: "cover", borderRadius: 8, border: "1px solid var(--border)", cursor: "zoom-in", display: "block" }}
          onClick={openFile}
        />
      ) : isVideo(asset) ? (
        <video
          src={assetUrl(path)}
          controls
          preload="metadata"
          style={{ width: "100%", maxHeight: 220, borderRadius: 8, border: "1px solid var(--border)", display: "block" }}
        />
      ) : isAudio(asset) ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
          <span style={{ fontSize: 20 }}>🎧</span>
          <audio src={assetUrl(path)} controls preload="metadata" style={{ flex: 1, height: 32 }} />
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
          onClick={openFile}
        >
          {t("打开")}
        </button>
        <button
          className="btn sm"
          title={t("选择文件夹保存（同名自动加序号）")}
          onClick={downloadFile}
        >
          ⬇ {t("下载")}
        </button>
        <button
          className="btn sm"
          title={t("在 Finder 中显示")}
          onClick={revealFile}
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
