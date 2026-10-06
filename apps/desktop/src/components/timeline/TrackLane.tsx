/**
 * 单条泳道 —— 轨道头部(类型名 + 片段数 + 「+ 添加」)+ 片段画布区。
 * 头部粘性定位于横向滚动左缘;点击泳道空白处取消选中。
 */
import type { AssetRecord } from "../../api-assets";
import type { TimelineClip, TimelineTrack } from "../../api-timeline";
import { useT } from "../../i18n";
import ClipBlock from "./ClipBlock";

interface TrackLaneProps {
  track: TimelineTrack;
  icon: string;
  label: string;
  pxPerSec: number;
  contentWidth: number;
  assetOf: (clip: TimelineClip) => AssetRecord | null;
  selectedId: string | null;
  onSelect: (clipId: string | null) => void;
  onChangeClip: (clipId: string, patch: Partial<TimelineClip>, opts?: { dragging?: boolean }) => void;
  onDragEnd: () => void;
  onAdd: () => void;
}

export default function TrackLane({
  track,
  icon,
  label,
  pxPerSec,
  contentWidth,
  assetOf,
  selectedId,
  onSelect,
  onChangeClip,
  onDragEnd,
  onAdd,
}: TrackLaneProps) {
  const t = useT();
  return (
    <div className="tl-row">
      <div className="tl-rowhead">
        <div className="tl-trackmeta">
          <span className="tl-trackname">
            <span aria-hidden>{icon}</span> {label}
          </span>
          <span className="tl-trackcount">({track.clips.length})</span>
        </div>
        <button className="btn sm" onClick={onAdd}>
          + {t("添加")}
        </button>
      </div>
      <div
        className="tl-lane"
        style={{ width: contentWidth, ["--secw" as string]: `${pxPerSec}px` } as React.CSSProperties}
        onMouseDown={() => onSelect(null)}
      >
        <div className="tl-lane-grid" />
        {track.clips.map((clip) => (
          <ClipBlock
            key={clip.id}
            clip={clip}
            kind={track.type}
            pxPerSec={pxPerSec}
            asset={assetOf(clip)}
            selected={selectedId === clip.id}
            onSelect={() => onSelect(clip.id)}
            onChange={(patch, opts) => onChangeClip(clip.id, patch, opts)}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>
    </div>
  );
}
