/**
 * agentChatStore 单元测试（v2.9.0 前端测试第一批）。
 * 覆盖：多会话 CRUD / 持久化（localStorage 读写与 v1 迁移）/ 流式增量收尾 /
 * 消息追加与自动标题 / jobId 归档表。
 * localStorage 与 Tauri IPC 在测试环境手工打桩。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

/* ---- 打桩：localStorage（带真实 Map 语义）与 Tauri IPC ---- */
const lsStore = new Map<string, string>();
const localStorageStub = {
  getItem: (k: string) => lsStore.get(k) ?? null,
  setItem: (k: string, v: string) => void lsStore.set(k, v),
  removeItem: (k: string) => void lsStore.delete(k),
  clear: () => void lsStore.clear(),
};
vi.stubGlobal("localStorage", localStorageStub);
vi.stubGlobal("window", { setTimeout, clearTimeout });

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({})) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

import {
  useAgentChat,
  rememberJobSession,
  uid,
  DEFAULT_SESSION_TITLE,
} from "./agentChatStore";

const KEY = "/tmp/proj-a";

const msg = (text: string, role: "user" | "assistant" | "system" = "user") => ({
  id: uid(),
  role,
  text,
  time: "00:00:00",
});

beforeEach(() => {
  lsStore.clear();
  // 重置 store（zustand 无内置 reset：用 setState 覆盖全部数据字段）
  useAgentChat.setState({
    sessionsByProject: {},
    currentByProject: {},
    busyByProject: {},
    activeJobsByProject: {},
    streamingByJob: {},
  });
});

describe("多会话 CRUD", () => {
  it("newSession 创建并设为当前会话", () => {
    const id = useAgentChat.getState().newSession(KEY);
    const st = useAgentChat.getState();
    expect(st.sessionsByProject[KEY]).toHaveLength(1);
    expect(st.currentByProject[KEY]).toBe(id);
    expect(st.currentSessionOf(KEY)?.title).toBe(DEFAULT_SESSION_TITLE);
  });

  it("renameSession 更新标题；空标题被忽略", () => {
    const st0 = useAgentChat.getState();
    const id = st0.newSession(KEY);
    st0.renameSession(KEY, id, "  雨夜追凶  ");
    expect(useAgentChat.getState().sessionsOf(KEY)[0].title).toBe("雨夜追凶");
    st0.renameSession(KEY, id, "   ");
    expect(useAgentChat.getState().sessionsOf(KEY)[0].title).toBe("雨夜追凶");
  });

  it("deleteSession 删除当前会话后落到最近一个；全部删光自动新建", () => {
    const st = useAgentChat.getState();
    const a = st.newSession(KEY);
    const b = st.newSession(KEY);
    st.deleteSession(KEY, b);
    expect(useAgentChat.getState().currentByProject[KEY]).toBe(a);
    st.deleteSession(KEY, a);
    const after = useAgentChat.getState();
    expect(after.sessionsOf(KEY)).toHaveLength(1);
    expect(after.currentSessionOf(KEY)).not.toBeNull();
  });

  it("appendTo 追加消息并自动用首条用户消息命名会话", () => {
    const st = useAgentChat.getState();
    const id = st.newSession(KEY);
    st.appendTo(KEY, id, msg("写一集都市甜宠短剧"));
    const session = useAgentChat.getState().currentSessionOf(KEY)!;
    expect(session.msgs).toHaveLength(1);
    expect(session.title).toBe("写一集都市甜宠短剧".slice(0, 20));
  });

  it("appendTo 到不存在的会话会兜底创建", () => {
    useAgentChat.getState().appendTo(KEY, "ghost-session", msg("hi"));
    const st = useAgentChat.getState();
    expect(st.sessionsOf(KEY).some((s) => s.id === "ghost-session")).toBe(true);
  });

  it("updateByPlanId 只更新匹配 planId 的消息", () => {
    const st = useAgentChat.getState();
    const id = st.newSession(KEY);
    const planId = "plan-1";
    st.appendTo(KEY, id, {
      ...msg("计划"),
      role: "assistant",
      plan: { planId, intent: "chat", summary: "s", risk: "low", remoteCalls: 0, steps: [] },
    });
    st.updateByPlanId(KEY, id, planId, (m) => ({
      ...m,
      text: `${m.text}\n\n✅ 已批准`,
    }));
    const updated = useAgentChat.getState().currentSessionOf(KEY)!.msgs[0];
    expect(updated.text).toContain("已批准");
  });

  it("clearCurrent 只清空当前会话消息", () => {
    const st = useAgentChat.getState();
    const a = st.newSession(KEY);
    st.appendTo(KEY, a, msg("one"));
    const b = st.newSession(KEY);
    st.appendTo(KEY, b, msg("two"));
    st.switchSession(KEY, a);
    st.clearCurrent(KEY);
    const sessions = useAgentChat.getState().sessionsOf(KEY);
    expect(sessions.find((s) => s.id === a)!.msgs).toHaveLength(0);
    expect(sessions.find((s) => s.id === b)!.msgs).toHaveLength(1);
  });
});

describe("持久化", () => {
  it("操作后写入 localStorage，重建 store 后恢复", async () => {
    const st = useAgentChat.getState();
    const id = st.newSession(KEY);
    st.appendTo(KEY, id, msg("持久化消息"));
    // debounce 300ms → 等一拍
    await new Promise((r) => setTimeout(r, 400));
    expect(lsStore.has("onetv-agent-chat-v2")).toBe(true);

    // 模拟重新加载：清理模块缓存后重新 import
    vi.resetModules();
    const mod = await import("./agentChatStore");
    const restored = mod.useAgentChat.getState().currentSessionOf(KEY);
    expect(restored?.msgs.map((m) => m.text)).toContain("持久化消息");
  });

  it("v1 旧格式迁移为默认会话", async () => {
    const v1 = { [KEY]: [{ id: "m1", role: "user", text: "旧消息", time: "t" }] };
    lsStore.set("onetv-agent-chat-v1", JSON.stringify(v1));
    vi.resetModules();
    const mod = await import("./agentChatStore");
    const sessions = mod.useAgentChat.getState().sessionsOf(KEY);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].title).toBe("默认会话");
    expect(sessions[0].msgs[0].text).toBe("旧消息");
  });
});

describe("流式增量", () => {
  it("appendDelta 按 jobId 累加，finishStreaming 清除", () => {
    const st = useAgentChat.getState();
    const id = st.newSession(KEY);
    rememberJobSession(["job-1"], KEY, id);
    st.appendDelta(KEY, id, "job-1", "你");
    st.appendDelta(KEY, id, "job-1", "好");
    expect(Object.values(useAgentChat.getState().streamingByJob)[0]?.text).toBe("你好");
    useAgentChat.getState().finishStreaming("job-1");
    expect(useAgentChat.getState().streamingByJob["job-1"]).toBeUndefined();
  });
});
