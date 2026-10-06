/**
 * 右侧片段检查器 —— 选中 clip 的精确编辑:start/duration/trimIn(数值)、
 * volume(0~2 滑杆+数值)、transitionIn/Out(无/淡入/淡出)、subtitle text、
 * video 资产缩略图 / audio 试听、删除按钮。未选中时展示占位引导。
 */
import { assetUrl, type AssetRecord } from "../../api-assets";
import type { TimelineClip, TimelineTrackType } from "../../api-timeline";
import { useT } from "../../i18n";
import { MAX_VOLUME, MIN_CLIP_DURATION, MIN_CLIP_START, baseName, clamp, snap01 } from "./timeline-model";

interface ClipInspectorProps {
  clip: TimelineClip | null;
  kind: TimelineTrackType | null;
  asset: AssetRecord | null;
  onChange: (patch: Partial<TimelineClip>) => void;
  onDelete: () => void;
}

const TRACK_LABELS: Record<TimelineTrackType, string> = {
  video: "视频",
  audio: "音频",
  subtitle: "字幕",
};

export default function ClipInspector({ clip, kind, asset, onChange, onDelete }: ClipInspectorProps) {
  const t = useT();

  if (!clip || !kind) {
    return (
      <div className="card">
        <div className="tl-ins-empty">
          <div className="big">🖱️</div>
          <p>{t("点击片段查看与编辑属性")}</p>
          <p className="hint">{t("拖拽块体移动位置，拖拽左右边缘裁剪；Delete 键删除选中片段")}</p>
        </div>
      </div>
    );
  }

  const isSub = kind === "subtitle";

  return (
    <div className="card">
      <div className="tl-ins-title">{t("片段属性")}</div>
      <div className="tl-ins-sub">
        {t(TRACK_LABELS[kind])}
        {asset ? ` · ${baseName(asset.path)}` : ""}
      </div>

      {/* video 轨:资产缩略图;audio 轨:试听控件 */}
      {kind === "video" && asset && (
        <div className="tl-ins-media">
          <img src={assetUrl(asset.path)} alt={baseName(asset.path)} loading="lazy" />
        </div>
      )}
      {kind === "audio" && asset && (
        <div className="tl-ins-media">
          <audio controls src={assetUrl(asset.path)} />
        </div>
      )}

      <div className="tl-ins-row">
        <div className="field">
          <label>{t("开始（秒）")}</label>
          <input
            type="number"
            min={MIN_CLIP_START}
            step={0.1}
            value={clip.start}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ start: Math.max(MIN_CLIP_START, snap01(v)) });
            }}
          />
        </div>
        <div className="field">
          <label>{t("时长（秒）")}</label>
          <input
            type="number"
            min={MIN_CLIP_DURATION}
            step={0.1}
            value={clip.duration}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ duration: Math.max(MIN_CLIP_DURATION, snap01(v)) });
            }}
          />
        </div>
      </div>

      {!isSub && (
        <div className="field">
          <label>{t("入点（秒）")}</label>
          <input
            type="number"
            min={MIN_CLIP_START}
            step={0.1}
            value={clip.trimIn ?? 0}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) onChange({ trimIn: Math.max(MIN_CLIP_START, snap01(v)) });
            }}
          />
        </div>
      )}

      {!isSub && (
        <div className="field">
          <label>{t("音量")}</label>
          <div className="tl-vol-row">
            <input
              type="range"
              min={0}
              max={MAX_VOLUME}
              step={0.05}
              value={clip.volume ?? 1}
              onChange={(e) => onChange({ volume: clamp(Number(e.target.value), 0, MAX_VOLUME) })}
            />
            <input
              type="number"
              min={0}
              max={MAX_VOLUME}
              step={0.1}
              value={clip.volume ?? 1}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v)) onChange({ volume: clamp(snap01(v), 0, MAX_VOLUME) });
              }}
            />
          </div>
        </div>
      )}

      {!isSub && (
        <div className="tl-ins-row">
          <div className="field">
            <label>{t("淡入（转场入）")}</label>
            <select
              value={clip.transitionIn ?? "none"}
              onChange={(e) => onChange({ transitionIn: e.target.value === "fade" ? "fade" : "none" })}
            >
              <option value="none">{t("无")}</option>
              <option value="fade">{t("淡入")}</option>
            </select>
          </div>
          <div className="field">
            <label>{t("淡出（转场出）")}</label>
            <select
              value={clip.transitionOut ?? "none"}
              onChange={(e) => onChange({ transitionOut: e.target.value === "fade" ? "fade" : "none" })}
            >
              <option value="none">{t("无")}</option>
              <option value="fade">{t("淡出")}</option>
            </select>
          </div>
        </div>
      )}

      {isSub && (
        <div className="field">
          <label>{t("字幕文本")}</label>
          <textarea
            rows={4}
            value={clip.text ?? ""}
            placeholder={t("字幕内容…")}
            onChange={(e) => onChange({ text: e.target.value })}
          />
        </div>
      )}

      <button className="btn danger" style={{ width: "100%" }} onClick={onDelete}>
        {t("🗑 删除片段")}
      </button>
    </div>
  );
}
