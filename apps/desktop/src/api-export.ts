/**
 * 导出 IPC 封装(多版本导出 v2.13)—— export_render 命令与任务契约。
 *
 * 独立成文件避免触碰既有 api-*.ts:UI 不直接接触 invoke。
 * 对应 Rust 侧命令(出站 DTO 为 camelCase):
 * - export_render(episode, presets, burnSubtitle, includeSrt) -> { jobs: string[] }
 *   每个画幅预设各建一个 JobKind::Export 任务;presets 为空 / 含未知键由后端报中文错误。
 */
import { invoke } from "@tauri-apps/api/core";

/** 已知画幅预设(与 Rust EXPORT_PRESETS 一致;展示文案走 i18n,键为持久化耦合字符串) */
export const EXPORT_PRESETS = [
  "douyin_vertical",
  "xhs_vertical",
  "horizontal_1080p",
  "square",
  "master",
] as const;

export type ExportPreset = (typeof EXPORT_PRESETS)[number];

export const exportRender = (
  episode: string,
  presets: string[],
  burnSubtitle: boolean,
  includeSrt: boolean
) =>
  invoke<{ jobs: string[] }>("export_render", {
    episode,
    presets,
    burnSubtitle,
    includeSrt,
  });
