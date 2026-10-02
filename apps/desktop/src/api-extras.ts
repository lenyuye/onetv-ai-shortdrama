/**
 * 扩展 IPC 封装 —— Skills 管理 / 视频理解 / 工程包导出导入。
 *
 * 独立于 api.ts（同 api-assets.ts / api-story.ts 风格）：这些命令属于
 * Skill Hub（规格 §10）与工程包扩展，集中在这里，UI 不直接接触 invoke。
 * 对应 Rust 侧命令：
 * - skill_list / skill_install / skill_uninstall
 * - video_understand
 * - project_export_pkg / project_import_pkg
 */
import { invoke } from "@tauri-apps/api/core";

/* ---------------- Skills（规格 §10） ---------------- */

/** skill_list 返回行 —— Skill 清单（manifest 摘要）+ 安装来源 */
export interface SkillInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 信任级别 0-3；未声明时缺省（展示层用 skill-sdk 的 SKILL_TRUST_LABELS 渲染） */
  trustLevel?: number;
  permissions: { network: string[]; filesystem: string[] };
  /** 安装来源：如 "builtin"（内置）/ "user"（本地安装） */
  source: string;
}

/** skill_install 结果 —— ok=false 时 message 携带 manifest 校验错误 */
export interface SkillInstallResult {
  ok: boolean;
  message: string;
  skill?: SkillInfo;
}

/** 列出已安装 Skill（内置 + 用户安装） */
export const skill_list = () => invoke<SkillInfo[]>("skill_list");

/** 安装本地 Skill：弹出文件夹选择框，读取并校验 manifest 后落盘 */
export const skill_install = () => invoke<SkillInstallResult>("skill_install");

/** 卸载 Skill（内置 Skill 是否可卸载由 Rust 侧裁决） */
export const skill_uninstall = (id: string) => invoke<void>("skill_uninstall", { id });

/* ---------------- 视频理解 ---------------- */

export interface VideoUnderstandResult {
  ok: boolean;
  jobId?: string;
  message?: string;
}

/**
 * 对视频资产发起理解任务（异步 job，assetId 缺省时由后端选择目标）。
 * 完成后结果写入 episodes/ep01/understanding.json。
 */
export const video_understand = (assetId?: string) =>
  invoke<VideoUnderstandResult>("video_understand", { assetId });

/* ---------------- 工程包导出 / 导入 ---------------- */

export interface ProjectPkgResult {
  ok: boolean;
  path?: string;
  message?: string;
}

/** 导出当前项目为工程包（弹出保存位置选择框） */
export const project_export_pkg = () => invoke<ProjectPkgResult>("project_export_pkg");

/** 导入工程包（弹出文件选择框）；成功后需要 loadProject() 刷新全局项目态 */
export const project_import_pkg = () => invoke<ProjectPkgResult>("project_import_pkg");
