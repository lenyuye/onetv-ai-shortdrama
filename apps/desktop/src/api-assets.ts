/**
 * 资产库 IPC 封装 —— asset_* 命令与 onetv-asset:// 自定义协议 URL。
 *
 * 独立于 api.ts：资产相关 invoke 集中在这里，UI 不直接接触 invoke。
 * 对应 Rust 侧命令：asset_import / asset_list / asset_delete。
 */
import { invoke } from "@tauri-apps/api/core";

/** Rust 侧 project::ops::AssetRecord（serde 线上字段为 snake_case） */
export interface AssetRecord {
  id: string;
  sha256: string;
  path: string;
  kind: string;
  mime: string;
  size_bytes: number;
}

/** 导入类别 —— 与 Rust 侧 import_asset(root, src, kind) 的 kind 存储值一致 */
export type AssetImportKind = "images" | "videos" | "audio" | "subtitles" | "documents";

/**
 * 弹出系统文件选择框（Rust 侧）并导入一个文件。
 * 相同 SHA-256 自动去重：命中已有资产时直接返回既有记录，不重复落盘。
 */
export const assetImport = (kind: AssetImportKind) => invoke<AssetRecord>("asset_import", { kind });

export const assetList = () => invoke<AssetRecord[]>("asset_list");

export const assetDelete = (id: string) => invoke<void>("asset_delete", { id });

/** 资产绝对路径 → 自定义协议 URL（用于 <img>/<video> 的 src） */
export const assetReveal = (path: string) => invoke<void>("asset_reveal", { path });

export const assetUrl = (path: string) => `onetv-asset://localhost/${encodeURIComponent(path)}`;
