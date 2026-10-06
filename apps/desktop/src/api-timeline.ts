/**
 * 时间线 IPC 封装(项19)—— timeline_* 命令与 TimelineDoc 线上契约。
 *
 * 独立于 api.ts:时间线相关 invoke 集中在这里,UI 不直接接触 invoke。
 * 对应 Rust 侧命令(后端并行开发中,出站 DTO 均为 camelCase):
 * - timeline_get(episode) -> { exists, timeline }
 * - timeline_save(episode, timeline) -> ()   // 原子落盘
 * - timeline_render(episode) -> { jobId }    // 创建 TimelineRender 任务
 * - timeline_probe_asset(assetId) -> { durationSec, width, height, hasAudio }
 */
import { invoke } from "@tauri-apps/api/core";
import type { Shot } from "@onetv/shared-types";

/** 时间线 schema 版本(持久化耦合字符串,严禁包 t()) */
export const TIMELINE_SCHEMA_VERSION = "2.0";

/** 轨道类型(持久化耦合字符串,严禁包 t()) */
export type TimelineTrackType = "video" | "audio" | "subtitle";

/** 转场类型:fade = 0.5s 淡入/淡出(Rust 侧固定时长) */
export type TimelineTransition = "none" | "fade";

export interface TimelineClip {
  /** 前端生成 crypto.randomUUID() */
  id: string;
  /** video/audio 轨必填 */
  assetId?: string;
  /** subtitle 轨必填 */
  text?: string;
  start: number;
  duration: number;
  trimIn?: number;
  /** 0~2,默认 1 */
  volume?: number;
  transitionIn?: TimelineTransition;
  transitionOut?: TimelineTransition;
}

export interface TimelineTrack {
  id: string;
  type: TimelineTrackType;
  clips: TimelineClip[];
}

export interface TimelineDoc {
  schemaVersion: typeof TIMELINE_SCHEMA_VERSION;
  fps: number;
  width: number;
  height: number;
  tracks: TimelineTrack[];
}

export interface TimelineAssetProbe {
  durationSec: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/* ---------------- 基础 invoke ---------------- */

export const timelineGet = (episode: string) =>
  invoke<{ exists: boolean; timeline: TimelineDoc | null }>("timeline_get", { episode });

export const timelineSave = (episode: string, timeline: TimelineDoc) =>
  invoke<void>("timeline_save", { episode, timeline });

export const timelineRender = (episode: string) =>
  invoke<{ jobId: string }>("timeline_render", { episode });

export const timelineProbeAsset = (assetId: string) =>
  invoke<TimelineAssetProbe>("timeline_probe_asset", { assetId });

/* ---------------- 常量与纯函数(归一化/生成,供视图与测试复用) ---------------- */

/** 竖版短剧默认画布(9:16) */
export const TIMELINE_FPS = 30;
export const TIMELINE_WIDTH = 1080;
export const TIMELINE_HEIGHT = 1920;

/** 轨道类型顺序固定:视频 / 音频 / 字幕(展示顺序,不参与持久化比较) */
export const TRACK_ORDER: readonly TimelineTrackType[] = ["video", "audio", "subtitle"];

/** 空时间线:三条轨道预置(避免视图端再判轨道缺失) */
export function emptyTimelineDoc(): TimelineDoc {
  return {
    schemaVersion: TIMELINE_SCHEMA_VERSION,
    fps: TIMELINE_FPS,
    width: TIMELINE_WIDTH,
    height: TIMELINE_HEIGHT,
    tracks: TRACK_ORDER.map((type) => ({ id: `${type}-track`, type, clips: [] })),
  };
}

const TRACK_TYPES: readonly string[] = TRACK_ORDER;

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** clip 级容错:缺 id / start / duration 非法的片段直接丢弃,数值域夹紧 */
function normalizeClip(raw: unknown): TimelineClip | null {
  const o = asObj(raw);
  if (!o) return null;
  const id = str(o.id);
  const start = num(o.start, NaN);
  const duration = num(o.duration, NaN);
  if (!id || !Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0) return null;
  const transitionIn = o.transitionIn === "fade" ? "fade" : o.transitionIn === "none" ? "none" : undefined;
  const transitionOut = o.transitionOut === "fade" ? "fade" : o.transitionOut === "none" ? "none" : undefined;
  return {
    id,
    ...(typeof o.assetId === "string" && o.assetId ? { assetId: o.assetId } : {}),
    ...(typeof o.text === "string" && o.text ? { text: o.text } : {}),
    start: Math.max(0, start),
    duration,
    ...(typeof o.trimIn === "number" && Number.isFinite(o.trimIn) ? { trimIn: Math.max(0, o.trimIn) } : {}),
    ...(typeof o.volume === "number" && Number.isFinite(o.volume)
      ? { volume: Math.min(2, Math.max(0, o.volume)) }
      : {}),
    ...(transitionIn ? { transitionIn } : {}),
    ...(transitionOut ? { transitionOut } : {}),
  };
}

/**
 * timeline_get 返回的 JSON → TimelineDoc(加载路径防御):
 * - timeline 缺失 / schemaVersion ≠ "2.0" / 非对象 → null(视图层据此展示空态引导卡);
 * - 轨道类型非法或缺 clips 的轨道跳过;非法 clip 丢弃,数值域夹紧。
 */
export function normalizeTimeline(raw: unknown): TimelineDoc | null {
  const o = asObj(raw);
  if (!o || str(o.schemaVersion) !== TIMELINE_SCHEMA_VERSION) return null;
  const byType = new Map<TimelineTrackType, TimelineClip[]>();
  for (const rawTrack of arr(o.tracks)) {
    const tr = asObj(rawTrack);
    if (!tr) continue;
    const type = str(tr.type);
    if (!(TRACK_TYPES as readonly string[]).includes(type)) continue;
    const clips = arr(tr.clips)
      .map(normalizeClip)
      .filter((c): c is TimelineClip => c !== null);
    const bucket = byType.get(type as TimelineTrackType) ?? [];
    byType.set(type as TimelineTrackType, bucket.concat(clips));
  }
  const doc = emptyTimelineDoc();
  doc.fps = Math.max(1, Math.round(num(o.fps, TIMELINE_FPS)));
  doc.width = Math.max(2, Math.round(num(o.width, TIMELINE_WIDTH)));
  doc.height = Math.max(2, Math.round(num(o.height, TIMELINE_HEIGHT)));
  doc.tracks = TRACK_ORDER.map((type) => ({
    id: `${type}-track`,
    type,
    clips: byType.get(type) ?? [],
  }));
  return doc;
}

/**
 * 「从分镜生成时间线」:每个 outputAssetId 非空的 shot 依次生成 video clip
 * (start 递增、duration = shot.durationSec 且 ≥1、volume = 1);
 * shot.subtitle 非空再生成同区间 subtitle clip。音频轨恒为空。
 */
export function timelineFromShots(shots: Shot[]): TimelineDoc {
  const doc = emptyTimelineDoc();
  const video: TimelineClip[] = [];
  const subtitle: TimelineClip[] = [];
  let cursor = 0;
  for (const shot of shots) {
    if (!shot.outputAssetId) continue;
    const duration = Math.max(1, Number(shot.durationSec) || 0);
    video.push({
      id: crypto.randomUUID(),
      assetId: shot.outputAssetId,
      start: cursor,
      duration,
      volume: 1,
    });
    if (shot.subtitle && shot.subtitle.trim()) {
      subtitle.push({
        id: crypto.randomUUID(),
        text: shot.subtitle,
        start: cursor,
        duration,
      });
    }
    cursor += duration;
  }
  doc.tracks = doc.tracks.map((tr) =>
    tr.type === "video" ? { ...tr, clips: video } : tr.type === "subtitle" ? { ...tr, clips: subtitle } : tr
  );
  return doc;
}
