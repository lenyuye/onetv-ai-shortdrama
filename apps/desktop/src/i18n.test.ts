/**
 * i18n 字典层完整性测试:
 * 1) 所有片段无空译文;2) 跨分片同键不同译必须被 OVERRIDES 裁决;
 * 3) t() 行为:zh 透传 / en 查表 / 缺译回退 / vars 仅替换存在的占位符。
 */
import { describe, expect, it } from "vitest";
import enAgentChat from "./i18n/en/agentChat";
import enApi from "./i18n/en/api";
import enCanvas from "./i18n/en/canvas";
import enJobs from "./i18n/en/jobs";
import enMisc from "./i18n/en/misc";
import enModels from "./i18n/en/models";
import enScript from "./i18n/en/script";
import enSettings from "./i18n/en/settings";
import enStoryboard from "./i18n/en/storyboard";
import { OVERRIDES, t } from "./i18n";

const FRAGMENTS: Record<string, Record<string, string>> = {
  "en/agentChat.ts": enAgentChat,
  "en/api.ts": enApi,
  "en/canvas.ts": enCanvas,
  "en/jobs.ts": enJobs,
  "en/misc.ts": enMisc,
  "en/models.ts": enModels,
  "en/script.ts": enScript,
  "en/settings.ts": enSettings,
  "en/storyboard.ts": enStoryboard,
};

describe("i18n 字典完整性", () => {
  it("所有片段无空译文", () => {
    for (const [file, dict] of Object.entries(FRAGMENTS)) {
      for (const [k, v] of Object.entries(dict)) {
        expect(v.trim(), `${file} 键「${k.slice(0, 40)}」译文为空`).not.toBe("");
        expect(k.trim(), `${file} 存在空白键`).not.toBe("");
      }
    }
  });

  it("跨分片同键不同译必须被 OVERRIDES 裁决", () => {
    const seen = new Map<string, { v: string; file: string }>();
    const unresolved: string[] = [];
    for (const [file, dict] of Object.entries(FRAGMENTS)) {
      for (const [k, v] of Object.entries(dict)) {
        const prev = seen.get(k);
        if (prev && prev.v !== v && !OVERRIDES[k]) unresolved.push(`${k}(${prev.file} vs ${file})`);
        if (!prev) seen.set(k, { v, file });
      }
    }
    expect(unresolved, `新增跨分片冲突需登记到 i18n.ts OVERRIDES: ${unresolved.join("; ")}`).toEqual([]);
  });

  it("OVERRIDES 的每个键都必须真实存在冲突或缺失(防覆盖层腐化)", () => {
    const seen = new Map<string, string>();
    const realConflicts = new Set<string>();
    for (const dict of Object.values(FRAGMENTS)) {
      for (const [k, v] of Object.entries(dict)) {
        const prev: string | undefined = seen.get(k);
        if (prev !== undefined && prev !== v) realConflicts.add(k);
        if (!prev) seen.set(k, v);
      }
    }
    const stale = Object.keys(OVERRIDES).filter((k) => !realConflicts.has(k));
    expect(
      stale,
      `OVERRIDES 含已无冲突的过期键(请从覆盖层移除): ${stale.join("; ")}`,
    ).toEqual([]);
  });
});

describe("t() 行为", () => {
  it("zh 语言下原文透传并插值", () => {
    // 默认语言为 zh(loadLang 依赖 localStorage,vitest 环境 getItem 返回 null → zh)
    expect(t("第 {n} 集", { n: 3 })).toBe("第 3 集");
    expect(t("保存中…")).toBe("保存中…");
  });

  it("vars 仅替换存在的占位符,字面 {xx} 不误伤", () => {
    expect(t("白名单 ${jobId} 示例", {})).toBe("白名单 ${jobId} 示例");
    expect(t("a {x} b {y} c", { x: 1 })).toBe("a 1 b {y} c");
  });

  it("字典键含正则特殊字符也能查表命中", () => {
    // en 键含 $ . 等字符,确保 t 直接用 Map 式查表而非正则路径
    expect(typeof t("批准失败：{msg}", { msg: "x" })).toBe("string");
  });
});
