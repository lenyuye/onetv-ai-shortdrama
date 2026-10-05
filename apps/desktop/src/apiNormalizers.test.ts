/**
 * api-story 归一化纯函数测试 + api-extras normalizeBible 测试（v2.9.0）。
 * 前后端字段容错（camelCase/snake_case）是历史事故高发区（v2.3.0 事故），
 * 这里守住归一化行为。
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import { errMsg, normalizeScript, emptyScriptDocument } from "./api-story";
import { normalizeBible } from "./api-extras";

describe("normalizeScript", () => {
  it("空输入返回带 episodeId 的空文档", () => {
    const doc = normalizeScript(null, "ep01");
    expect(doc.episodeId).toBe("ep01");
    const empty = emptyScriptDocument("ep02");
    expect(empty.episodeId).toBe("ep02");
  });

  it("容忍 snake_case 后端字段", () => {
    const doc = normalizeScript(
      {
        episode_id: "ep01",
        title: "第一集",
        logline: "雨夜的重逢",
        scenes: [
          {
            scene_heading: "夜 / 天台",
            action: "两人对峙",
            dialogues: [{ character: "阿雅", line: "你终于来了" }],
          },
        ],
      },
      "ep01",
    );
    expect(doc.title).toBe("第一集");
    expect(doc.scenes).toHaveLength(1);
  });

  it("容忍 camelCase 前端字段与缺失字段", () => {
    const doc = normalizeScript(
      { episodeId: "ep01", title: "T", scenes: [{}, null, undefined] },
      "ep01",
    );
    expect(doc.title).toBe("T");
    expect(doc.scenes.length).toBeGreaterThanOrEqual(1);
  });
});

describe("normalizeBible", () => {
  it("补齐全部缺失结构", () => {
    const doc = normalizeBible(null);
    expect(doc.story.targetDurationSec).toBe(120);
    expect(doc.characters).toEqual([]);
    expect(doc.continuity).toEqual([]);
  });

  it("保留已填内容并合并默认值", () => {
    const doc = normalizeBible({
      story: { title: "测试剧", visualStyle: "cinematic" },
      characters: [{ name: "阿雅", desc: "女主" }],
    });
    expect(doc.story.title).toBe("测试剧");
    expect(doc.story.genre).toBe("");
    expect(doc.characters[0].name).toBe("阿雅");
  });
});

describe("buildAssetPathMap", () => {
  it("按 id 建立路径映射", async () => {
    const { buildAssetPathMap } = await import("./api-story");
    const map = buildAssetPathMap([
      { id: "a1", path: "/p/one.png" },
      { id: "a2", path: "/p/two.mp4" },
    ] as never);
    expect(map.get("a1")).toBe("/p/one.png");
    expect(map.get("a2")).toBe("/p/two.mp4");
    expect(map.size).toBe(2);
  });
});

describe("errMsg", () => {
  it("从 Tauri Err 对象中提取 message", () => {
    expect(errMsg({ message: "出错了" })).toBe("出错了");
    expect(errMsg("字符串错误")).toBe("字符串错误");
  });
});
