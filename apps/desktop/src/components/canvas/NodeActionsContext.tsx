/**
 * NodeActionsContext（v2.26.31，LibTV 式"节点即生成器"）：
 * 把画布级操作注入 ReactFlow 自定义节点卡，让生成直接发生在节点上：
 * - patchConfig：按 nodeId 更新节点 config（内嵌生成条产物回填/文本节点卡内编辑）；
 * - uploadNodeFile：节点内嵌「＋上传」→ agentAttach 入资产库并写入 config；
 * - spawnGenerateNode：素材/文本节点一键「生图/生视频」→ 旁建生成节点并自动连线
 *   （上游素材/文本即参考，与连线即参考语义一致）。
 */
import { createContext, useContext } from "react";

export interface NodeActions {
  patchConfig: (nodeId: string, patch: Record<string, unknown>) => void;
  uploadNodeFile: (nodeId: string) => Promise<void>;
  spawnGenerateNode: (sourceId: string, type: "image" | "video") => void;
  /** v2.26.102：生成完成后产物自动落为新的独立内容节点（占满显示，视口跟随） */
  spawnOutputNode: (sourceId: string, assetId: string, path: string) => void;
}

const noop = () => {};

export const NodeActionsContext = createContext<NodeActions>({
  patchConfig: noop,
  uploadNodeFile: async () => {},
  spawnGenerateNode: noop,
  spawnOutputNode: noop,
});

export const useNodeActions = () => useContext(NodeActionsContext);
