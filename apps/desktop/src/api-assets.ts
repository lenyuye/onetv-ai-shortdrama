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

/** 用系统默认程序打开文件（Rust 侧带存在性校验，缺失时返回可读错误） */
export const assetOpen = (path: string) => invoke<void>("asset_open", { path });

/** 下载（导出）资产：targetDir 为用户自选目录（目录选择器）；缺省落到系统「下载」文件夹/OneTV */
export const assetExport = (path: string, targetDir?: string) =>
  invoke<string>("asset_export", { path, targetDir: targetDir ?? null });

/** 弹出系统目录选择器挑选下载位置；用户取消返回 null */
export const pickExportDir = (): Promise<string | null> =>
  invoke<string | null>("pick_directory", { title: "选择下载位置" });

/**
 * 下载到自选目录（v2.26.158）：先弹系统目录选择器，取消则不导出（返回 null），
 * 选中后导出并返回最终落盘路径。
 */
export async function exportAssetWithPicker(path: string): Promise<string | null> {
  const dir = await pickExportDir();
  if (!dir) return null;
  return assetExport(path, dir);
}

/**
 * 归一化资产路径（v2.26.157 防御）：历史脏数据可能残留 URL 查询串
 * （如 "xxx.mp4?e=签名"），渲染 URL / 打开 / 定位前统一剥离。
 */
export const cleanAssetPath = (path: string): string => {
  if (!path) return "";
  return path.split(/[?#]/, 1)[0] ?? path;
};

export const assetUrl = (path: string) => `onetv-asset://localhost/${encodeURIComponent(cleanAssetPath(path))}`;
