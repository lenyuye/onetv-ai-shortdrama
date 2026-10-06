/**
 * api-timeline 归一化测试:timeline_get 加载路径防御与「从分镜生成时间线」纯函数。
 */
import { describe, expect, it } from "vitest";
import type { Shot } from "@onetv/shared-types";
import {
  emptyTimelineDoc,
  normalizeTimeline,
  timelineFromShots,
  type TimelineDoc,
} from "./api-timeline";

const shot = (over: Partial<Shot>): Shot => ({
  shotId: "S001",
  scene: "",
  durationSec: 3,
  shotSize: "中景",
  camera: { movement: "", angle: "" },
  characters: [],
  action: "",
  prompt: "",
  referenceAssets: [],
  generation: { type: "text_to_video", duration: 3, aspectRatio: "9:16" },
  status: "draft",
  ...over,
});

describe("normalizeTimeline(加载路径防御)", () => {
  it("exists 响应为空 / schemaVersion 非 2.0 时返回 null", () => {
    expect(normalizeTimeline(null)).toBeNull();
    expect(normalizeTimeline(undefined)).toBeNull();
    expect(normalizeTimeline("nope")).toBeNull();
    expect(normalizeTimeline({ schemaVersion: "1.0", tracks: [] })).toBeNull();
  });

  it("丢弃缺 id / 非法数值的片段并夹紧数值域", () => {
    const doc = normalizeTimeline({
      schemaVersion: "2.0",
      fps: 30,
      width: 1080,
      height: 1920,
      tracks: [
        {
          id: "t1",
          type: "video",
          clips: [
            { id: "c1", assetId: "a1", start: -2, duration: 3, volume: 5, trimIn: -1 },
            { id: "", start: 0, duration: 2 },
            { id: "c3", start: 0, duration: -1 },
            "junk",
            null,
          ],
        },
        { id: "t2", type: "unknown", clips: [] },
        { id: "t3" },
      ],
    });
    expect(doc).not.toBeNull();
    const d = doc as TimelineDoc;
    expect(d.schemaVersion).toBe("2.0");
    // 未知类型轨道被跳过,三条标准轨道恒定重建
    expect(d.tracks.map((tr) => tr.type)).toEqual(["video", "audio", "subtitle"]);
    expect(d.tracks[0].clips).toHaveLength(1);
    expect(d.tracks[0].clips[0]).toMatchObject({ id: "c1", assetId: "a1", start: 0, duration: 3, volume: 2 });
    expect(d.tracks[0].clips[0].trimIn).toBe(0);
  });

  it("camelCase 容错:接受合法 fade 转场,拒绝未知值", () => {
    const doc = normalizeTimeline({
      schemaVersion: "2.0",
      tracks: [
        {
          type: "video",
          clips: [{ id: "c1", start: 0, duration: 2, transitionIn: "fade", transitionOut: "wipe" }],
        },
      ],
    });
    const clip = (doc as TimelineDoc).tracks[0].clips[0];
    expect(clip.transitionIn).toBe("fade");
    expect(clip.transitionOut).toBeUndefined();
  });
});

describe("timelineFromShots(从分镜生成时间线)", () => {
  it("只为 outputAssetId 非空的镜头生成 clip,duration ≥1,start 递增,字幕同区间", () => {
    const doc = timelineFromShots([
      shot({ shotId: "S001", outputAssetId: "a1", durationSec: 2.5, subtitle: "你好" }),
      shot({ shotId: "S002", durationSec: 3 }), // 未出图 → 跳过
      shot({ shotId: "S003", outputAssetId: "a2", durationSec: 0.5, subtitle: "  " }), // 空白字幕 → 不生成字幕 clip
    ]);
    const video = doc.tracks.find((tr) => tr.type === "video")!.clips;
    const subtitle = doc.tracks.find((tr) => tr.type === "subtitle")!.clips;
    const audio = doc.tracks.find((tr) => tr.type === "audio")!.clips;
    expect(video).toHaveLength(2);
    expect(video[0]).toMatchObject({ assetId: "a1", start: 0, duration: 2.5, volume: 1 });
    expect(video[1]).toMatchObject({ assetId: "a2", start: 2.5, duration: 1 }); // 0.5s → 保底 1s
    expect(subtitle).toHaveLength(1);
    expect(subtitle[0]).toMatchObject({ text: "你好", start: 0, duration: 2.5 });
    expect(audio).toHaveLength(0);
    // clip id 为前端生成的 uuid,互不相同
    expect(video[0].id).not.toBe(video[1].id);
  });

  it("空分镜 → 三条空轨的 2.0 文档", () => {
    const doc = timelineFromShots([]);
    expect(doc.schemaVersion).toBe("2.0");
    expect(doc.tracks).toHaveLength(3);
    expect(doc.tracks.every((tr) => tr.clips.length === 0)).toBe(true);
    expect(emptyTimelineDoc().schemaVersion).toBe("2.0");
  });
});
