/**
 * 时间线纯函数与常量(TrackLane/ClipBlock/TimelineView 共用):
 * 吸附、夹紧、轨道末尾时间、文档总时长、片段查找。不含 React 与 invoke。
 */
import type { TimelineClip, TimelineDoc, TimelineTrack } from "../../api-timeline";

/** 拖拽/数值吸附步长(0.1s) */
export const SNAP_STEP = 0.1;
/** 片段最小时长(右缘拖拽 ≥0.2s,左缘拖拽同样保底,避免出现零长片段) */
export const MIN_CLIP_DURATION = 0.2;
/** 片段最小 start / trimIn */
export const MIN_CLIP_START = 0;
/** 音量上限(契约 0~2,默认 1) */
export const MAX_VOLUME = 2;
/** 图片 clip 默认时长(s) */
export const DEFAULT_IMAGE_DURATION = 3;
/** 内容区尾部预留空白(s) */
export const TRAIL_SECONDS = 10;
/** 轨道头部宽度(与 TL_CSS 中 .tl-rowhead 保持一致) */
export const TRACK_HEADER_WIDTH = 128;

/** 0.1s 吸附 */
export const snap01 = (v: number): number => Math.round(v * 10) / 10;

/** 数值夹紧到 [min, max] */
export const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, v));

/** 资产路径 → 文件名(兼容 / 与 \) */
export const baseName = (p: string): string => p.split(/[\\/]/).pop() || p;

/** 轨道最右端(最后一个 clip 的出点),空轨为 0 */
export function trackEndSec(track: TimelineTrack): number {
  let end = 0;
  for (const c of track.clips) end = Math.max(end, c.start + c.duration);
  return end;
}

/** 文档总时长(所有轨最右出点) */
export function docTotalSec(doc: TimelineDoc): number {
  let end = 0;
  for (const tr of doc.tracks) end = Math.max(end, trackEndSec(tr));
  return end;
}

/** 文档内片段总数 */
export function docClipCount(doc: TimelineDoc): number {
  return doc.tracks.reduce((n, tr) => n + tr.clips.length, 0);
}

/** 按 id 查找片段(跨轨唯一),返回所在轨道便于判断类型 */
export function findClip(
  doc: TimelineDoc,
  clipId: string | null
): { track: TimelineTrack; clip: TimelineClip } | null {
  if (!clipId) return null;
  for (const track of doc.tracks) {
    const clip = track.clips.find((c) => c.id === clipId);
    if (clip) return { track, clip };
  }
  return null;
}

/** 秒 → m:ss(标尺与描述行共用) */
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
