/**
 * 资产选择弹窗 —— video 轨列 images/videos 资产,audio 轨列 audio 资产。
 * 点选视频/音频资产时先 timeline_probe_asset 探测真实时长(失败回退 3s),
 * 图片固定 3s;探测完成后回调 onPick(asset, durationSec) 由父级追加 clip。
 */
import { useEffect, useState } from "react";
import { assetUrl, assetList, type AssetRecord } from "../../api-assets";
import { timelineProbeAsset } from "../../api-timeline";
import { useApp } from "../../store";
import { useT } from "../../i18n";
import { DEFAULT_IMAGE_DURATION, baseName } from "./timeline-model";

interface AssetPickerModalProps {
  /** "media" = images + videos(video 轨);"audio" = audio(audio 轨) */
  mode: "media" | "audio";
  onPick: (asset: AssetRecord, durationSec: number) => void;
  onClose: () => void;
}

export default function AssetPickerModal({ mode, onPick, onClose }: AssetPickerModalProps) {
  const t = useT();
  const { toast } = useApp();
  const [items, setItems] = useState<AssetRecord[] | null>(null);
  const [probingId, setProbingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    assetList()
      .then((list) => {
        if (cancelled) return;
        const kinds = mode === "audio" ? ["audio"] : ["images", "videos"];
        setItems(list.filter((a) => kinds.includes(a.kind)));
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  const pick = async (asset: AssetRecord) => {
    if (probingId) return;
    if (asset.kind === "images") {
      onPick(asset, DEFAULT_IMAGE_DURATION);
      return;
    }
    // 视频/音频资产:先探测真实时长(失败回退默认 3s,仍允许添加)
    setProbingId(asset.id);
    let duration = DEFAULT_IMAGE_DURATION;
    try {
      const probe = await timelineProbeAsset(asset.id);
      if (Number.isFinite(probe?.durationSec) && probe.durationSec > 0) duration = probe.durationSec;
    } catch (e) {
      toast(t("探测资产时长失败，已使用默认 3 秒：{msg}", { msg: String((e as Error)?.message ?? e) }), "warn");
    } finally {
      setProbingId(null);
    }
    onPick(asset, duration);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: "min(640px, 92vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{mode === "audio" ? t("🎵 选择音频资产") : t("🎬 选择视频 / 图片资产")}</span>
          <button className="btn sm ghost" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {items === null ? (
            <div className="hint">{t("资产加载中…")}</div>
          ) : items.length === 0 ? (
            <div className="hint">{t("资产库为空，请先到「资产」页导入")}</div>
          ) : (
            <div className="tl-picker-grid">
              {items.map((a) => (
                <button
                  key={a.id}
                  className="tl-picker-item"
                  disabled={probingId !== null}
                  title={a.path}
                  onClick={() => void pick(a)}
                >
                  {a.kind === "images" ? (
                    <img src={assetUrl(a.path)} alt={baseName(a.path)} loading="lazy" />
                  ) : (
                    <span className="tl-picker-icon" aria-hidden>{a.kind === "videos" ? "🎬" : "🎵"}</span>
                  )}
                  <span className="tl-picker-name">{baseName(a.path)}</span>
                  {probingId === a.id && <span className="tl-picker-probing">{t("探测中…")}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t("取消")}</button>
        </div>
      </div>
    </div>
  );
}
