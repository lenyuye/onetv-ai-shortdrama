import { describe, expect, it } from "vitest";
import { summarizeBatch } from "./BatchRunPanel";
import type { CanvasNode } from "@onetv/shared-types";

const node = (id: string, batchStatus?: string, note?: string): CanvasNode =>
  ({ id, episodeId: "e1", type: "image", title: `节点${id}`,
     config: { ...(batchStatus ? { batchStatus } : {}), ...(note ? { batchNote: note } : {}) },
     position: { x: 0, y: 0 } }) as CanvasNode;

describe("summarizeBatch", () => {
  it("按 batchStatus 分组计数并收集失败原因", () => {
    const s = summarizeBatch([node("a", "done"), node("b", "failed", "生成失败"), node("c", "skipped"), node("d"), node("e", "failed", "已取消")]);
    expect(s).toMatchObject({ done: 1, failed: 2, skipped: 1, pending: 1, total: 5 });
    expect(s.failedNodes.map((f) => f.note)).toEqual(["生成失败", "已取消"]);
  });
  it("空画布与无标记全算 pending", () => {
    expect(summarizeBatch([]).total).toBe(0);
    const s = summarizeBatch([node("x"), node("y")]);
    expect(s.pending).toBe(2);
    expect(s.done + s.failed + s.skipped).toBe(0);
  });
});
