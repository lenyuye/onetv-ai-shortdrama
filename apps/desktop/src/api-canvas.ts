/**
 * 画布 IPC 封装层 —— CanvasDocument 读写（与 api.ts 同风格，UI 不直接接触 invoke）。
 *
 * 后端命令契约（集成时由 Rust 侧提供）：
 * - canvas_get(episode_id: String) -> CanvasDocument
 * - canvas_save(episode_id: String, doc: CanvasDocument) -> ()
 */
import { invoke } from "@tauri-apps/api/core";
import { SCHEMA_VERSION, type CanvasDocument } from "@onetv/shared-types";

/** 读取某分集的画布文档；后端尚未建立文档时可返回默认空文档或抛错（前端均能处理）。 */
export const canvasGet = (episodeId: string) =>
  invoke<CanvasDocument>("canvas_get", { episodeId });

/** 保存某分集的画布文档（全量覆盖）。 */
export const canvasSave = (episodeId: string, doc: CanvasDocument) =>
  invoke<void>("canvas_save", { episodeId, doc });

/** 前端兜底用的空白画布文档。 */
export function emptyCanvasDocument(episodeId: string): CanvasDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    episodeId,
    nodes: [],
    edges: [],
    updatedAt: new Date().toISOString(),
  };
}
