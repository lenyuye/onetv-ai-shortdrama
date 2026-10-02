/**
 * OneTV Agent 引擎（前端侧）—— Planner 输出的结构化协议与纯函数工具。
 * Planner 在 Rust 端运行；本包只承载展示与校验逻辑。
 */
import type { AgentPlan, IntentType, PlanStep } from "@onetv/shared-types";

export const INTENT_LABELS: Record<IntentType, string> = {
  chat: "对话",
  "project.create": "创建项目",
  "script.generate": "生成剧本",
  "storyboard.generate": "生成分镜",
  "image.generate": "生成图片",
  "video.generate": "生成视频",
  "video.edit": "视频编辑",
  "video.extend": "视频续写",
  "timeline.compose": "时间线合成",
  "asset.link": "资产绑定",
  "memory.update": "更新记忆",
  export: "导出",
  "video.understand": "视频理解",
};

export const RISK_LABELS: Record<AgentPlan["estimated"]["risk"], string> = {
  low: "低风险（本地）",
  medium: "中风险（会调用远程 API）",
  high: "高风险（批量/高成本）",
};

export function countRemoteCalls(plan: AgentPlan): number {
  const remoteTools = new Set([
    "script.generate",
    "storyboard.build",
    "image.generate",
    "video.generate",
    "video.extend",
    "video.edit",
    "audio.tts",
    "audio.music",
  ]);
  return plan.steps.filter((s: PlanStep) => remoteTools.has(s.tool)).length;
}

export function needsApproval(plan: AgentPlan): boolean {
  return (
    plan.steps.some((s) => s.approval === "required") || countRemoteCalls(plan) > 0
  );
}

export function topologicalOrder(steps: PlanStep[]): PlanStep[] {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const done = new Set<string>();
  const out: PlanStep[] = [];
  let guard = 0;
  while (out.length < steps.length && guard++ < steps.length + 10) {
    for (const s of steps) {
      if (done.has(s.id)) continue;
      if (s.dependsOn.every((d) => !byId.has(d) || done.has(d))) {
        out.push(s);
        done.add(s.id);
      }
    }
  }
  return out;
}
