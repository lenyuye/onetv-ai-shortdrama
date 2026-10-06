/**
 * 片段块 —— 泳道内绝对定位的可拖拽 clip(纯鼠标事件实现,不新增依赖):
 * - 块体拖拽移动改 start(0.1s 吸附、不允许 < 0);
 * - 左缘拖拽:video/audio 右端固定 → 改 trimIn/duration(start 随动,trimIn≥0、duration≥0.2);
 *   subtitle 无 trimIn 概念,左缘只改 start;
 * - 右缘拖拽:改 duration(≥0.2s)。
 * 拖拽过程中通过 onChange(patch, dragging=true) 实时回写文档(不触发保存),
 * 松开鼠标 onDragEnd() 由父级统一做防抖保存。
 */
import { useRef, useState } from "react";
import { assetUrl, type AssetRecord } from "../../api-assets";
import type { TimelineClip } from "../../api-timeline";
import { useT } from "../../i18n";
import { MIN_CLIP_DURATION, baseName, snap01 } from "./timeline-model";

interface ClipBlockProps {
  clip: TimelineClip;
  kind: "video" | "audio" | "subtitle";
  pxPerSec: number;
  asset: AssetRecord | null;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<TimelineClip>, opts?: { dragging?: boolean }) => void;
  onDragEnd: () => void;
}

type DragMode = "move" | "left" | "right";

interface DragState {
  mode: DragMode;
  x0: number;
  start: number;
  duration: number;
  trimIn: number;
}

export default function ClipBlock({
  clip,
  kind,
  pxPerSec,
  asset,
  selected,
  onSelect,
  onChange,
  onDragEnd,
}: ClipBlockProps) {
  const t = useT();
  const dragRef = useRef<DragState | null>(null);
  const [thumbFailed, setThumbFailed] = useState(false);

  const beginDrag = (mode: DragMode) => (e: React.MouseEvent) => {
    // 拖拽期间阻止文本选择与泳道空白点的取消选中
    e.preventDefault();
    e.stopPropagation();
    if (e.button !== 0) return;
    onSelect();
    dragRef.current = {
      mode,
      x0: e.clientX,
      start: clip.start,
      duration: clip.duration,
      trimIn: clip.trimIn ?? 0,
    };
    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const delta = snap01((ev.clientX - d.x0) / pxPerSec);
      if (d.mode === "move") {
        onChange({ start: Math.max(0, snap01(d.start + delta)) }, { dragging: true });
      } else if (d.mode === "right") {
        onChange({ duration: Math.max(MIN_CLIP_DURATION, snap01(d.duration + delta)) }, { dragging: true });
      } else if (kind === "subtitle") {
        // 字幕左缘只改 start(无 trimIn 概念)
        onChange({ start: Math.max(0, snap01(d.start + delta)) }, { dragging: true });
      } else {
        // video/audio 左缘:右端固定,start/trimIn/duration 联动
        let dd = delta;
        dd = Math.max(dd, -(d.trimIn), -(d.start));
        dd = Math.min(dd, d.duration - MIN_CLIP_DURATION);
        onChange(
          {
            start: snap01(d.start + dd),
            trimIn: snap01(d.trimIn + dd),
            duration: snap01(d.duration - dd),
          },
          { dragging: true }
        );
      }
    };
    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      onDragEnd();
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const label =
    kind === "subtitle"
      ? clip.text || t("（空字幕）")
      : asset
        ? baseName(asset.path)
        : clip.assetId || "?";

  const showThumb = kind === "video" && asset?.kind === "images" && !thumbFailed;

  return (
    <div
      className={`tl-clip kind-${kind}${selected ? " selected" : ""}`}
      style={{ left: clip.start * pxPerSec, width: Math.max(8, clip.duration * pxPerSec) }}
      title={`${label} · ${clip.duration.toFixed(1)}s`}
      onMouseDown={beginDrag("move")}
      onClick={(e) => e.stopPropagation()}
    >
      {showThumb && (
        <img
          className="tl-clip-thumb"
          src={assetUrl(asset!.path)}
          alt={label}
          draggable={false}
          onError={() => setThumbFailed(true)}
        />
      )}
      {!showThumb && (
        <span className="tl-clip-icon" aria-hidden>
          {kind === "video" ? "🎬" : kind === "audio" ? "🎵" : "💬"}
        </span>
      )}
      <span className="tl-clip-badge">{clip.duration.toFixed(1)}s</span>
      <span className="tl-clip-label">{label}</span>
      <div className="tl-clip-handle left" onMouseDown={beginDrag("left")} onClick={(e) => e.stopPropagation()} />
      <div className="tl-clip-handle right" onMouseDown={beginDrag("right")} onClick={(e) => e.stopPropagation()} />
    </div>
  );
}
