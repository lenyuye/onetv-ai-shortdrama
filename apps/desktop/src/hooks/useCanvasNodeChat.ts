/**
 * useCanvasNodeChat —— 节点生成面板状态 hook（从 CanvasView 拆出，逻辑不变）：
 * - 双击节点 / 右键菜单打开 LibTV 式聊天框（锚点为节点相对画布容器的坐标）；
 * - 面板生成成功后回填节点 config（outputAssetId/status），走自动保存；
 * - 全局兜底：job.succeeded 事件携带 nodeId 时直接回填节点
 *   （面板已关闭/切走也能收到产物；handler 经 ref 镜像调用，effect 只订阅一次）。
 */
import { useEffect, useRef, useState } from "react";
import type { Dispatch, MutableRefObject, SetStateAction } from "react";
import { useReactFlow } from "@xyflow/react";
import * as api from "../api";
import type { CtxMenuState } from "./useCanvasContextMenu";
import type { FlowNode } from "../components/canvas/canvas-model";

/** 节点生成面板打开状态：目标节点 id + 节点左上角的容器内像素坐标。 */
export interface NodeChatState {
  nodeId: string;
  anchor: { x: number; y: number };
}

export function useCanvasNodeChat(opts: {
  wrapperRef: MutableRefObject<HTMLDivElement | null>;
  nodesRef: { current: FlowNode[] };
  setNodes: Dispatch<SetStateAction<FlowNode[]>>;
  scheduleSave: () => void;
  setCtxMenu: Dispatch<SetStateAction<CtxMenuState | null>>;
}) {
  const { wrapperRef, nodesRef, setNodes, scheduleSave, setCtxMenu } = opts;
  const rf = useReactFlow();
  const [nodeChat, setNodeChat] = useState<NodeChatState | null>(null);

  const openNodeChat = (node: FlowNode) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const p = rf.flowToScreenPosition({ x: node.position.x, y: node.position.y });
    const ax = rect ? p.x - rect.left : p.x;
    const ay = rect ? p.y - rect.top : p.y;
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === node.id })));
    setNodeChat({ nodeId: node.id, anchor: { x: ax, y: ay } });
    setCtxMenu(null);
  };

  /** 面板生成成功后回填节点 config（outputAssetId/status），走自动保存 */
  const handleChatConfig = (nodeId: string, patch: Record<string, unknown>) => {
    setNodes((ns) =>
      ns.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, cn: { ...n.data.cn, config: { ...n.data.cn.config, ...patch } } } }
          : n
      )
    );
    scheduleSave();
  };

  // handler 经 ref 镜像调用（与 useCanvasDoc 里镜像 refs 同一模式）：effect 保持空依赖只订阅一次，
  // 每次渲染仅更新 ref 指向的最新 handler，消除对首帧闭包的过期依赖。
  const onJobSucceeded = (job: { nodeId?: string | null; outputs?: string[]; reply?: string | null }) => {
    const nid = job?.nodeId;
    if (!nid) return;
    const fn = nodesRef.current.find((n) => n.id === nid);
    if (!fn) return; // 已切换分集或节点已删除
    const out = job.outputs?.[0];
    if (out) {
      handleChatConfig(nid, { outputAssetId: out, status: "ready" });
    } else if (job.reply && fn.data.cn.type === "text") {
      handleChatConfig(nid, { text: job.reply, status: "ready" });
    }
  };
  const onJobSucceededRef = useRef(onJobSucceeded);
  onJobSucceededRef.current = onJobSucceeded;
  useEffect(() => {
    const un = api.onAppEvent<{ nodeId?: string | null; outputs?: string[]; reply?: string | null }>(
      "job.succeeded",
      (job) => onJobSucceededRef.current(job)
    );
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  return { nodeChat, setNodeChat, openNodeChat, handleChatConfig };
}
