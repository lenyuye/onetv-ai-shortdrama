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

/** 从 Git 仓库安装 Skill（可选 tag/branch；v2.13） */
export const skillInstallGit = (url: string, tag?: string) =>
  invoke<SkillInstallResult>("skill_install_git", { url, tag });

/** Provider 配置导入导出（v2.13，不含密钥） */
export const providerExport = () => invoke<{ ok: boolean; path: string; count: number }>("provider_export");
export const providerImport = () => invoke<{ ok: boolean; imported: number }>("provider_import");

/** 从视频理解结果重建画布（v2.13） */
export const recreateCanvas = (episodeId: string) =>
  invoke<{ ok: boolean; created: number }>("recreate_canvas", { episodeId });

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

/* ---------------- Story Bible（v2.8.0） ---------------- */

export interface BibleCharacter {
  name: string;
  desc?: string;
  appearance?: string;
  refAssetId?: string;
}
export interface BibleNamedItem {
  name: string;
  desc?: string;
}
export interface BibleDoc {
  story: {
    title?: string;
    genre?: string;
    era?: string;
    location?: string;
    theme?: string;
    targetDurationSec?: number;
    targetPlatform?: string;
    aspectRatio?: string;
    visualStyle?: string;
  };
  characters: BibleCharacter[];
  locations: BibleNamedItem[];
  props: BibleNamedItem[];
  continuity: string[];
}

const EMPTY_BIBLE: BibleDoc = {
  story: { title: "", genre: "", era: "", location: "", theme: "", targetDurationSec: 120, targetPlatform: "抖音", aspectRatio: "9:16", visualStyle: "" },
  characters: [],
  locations: [],
  props: [],
  continuity: [],
};

export const bibleGet = () => invoke<Partial<BibleDoc>>("bible_get");
export const bibleSave = (doc: BibleDoc) => invoke<void>("bible_save", { doc });
/** AI 生成 Story Bible（brief：一句话需求） */
export const bibleGenerate = (brief: string) => invoke<Partial<BibleDoc>>("bible_generate", { brief });

/** 当前项目远程生成用量（预算守卫看板；未打开项目时 invoke 报错，由调用方兜底） */
export const costsGet = () =>
  invoke<{ today: number; total: number; todayCost: number; totalCost: number; date: string }>("costs_get");

/** 记忆语义搜索（v2.14：字符二元组余弦相似度，纯本地） */
export const memorySearch = (query: string, limit?: number) =>
  invoke<{ record: { id: string; text: string; scope: string; createdAt?: string; created_at?: string }; score: number }[]>(
    "memory_search",
    { query, limit },
  );

/** 归一化：补齐缺失字段，保证编辑器四张表可用 */
export function normalizeBible(raw: Partial<BibleDoc> | null | undefined): BibleDoc {
  const story = { ...EMPTY_BIBLE.story, ...(raw?.story ?? {}) };
  return {
    story,
    characters: Array.isArray(raw?.characters) ? raw!.characters : [],
    locations: Array.isArray(raw?.locations) ? raw!.locations : [],
    props: Array.isArray(raw?.props) ? raw!.props : [],
    continuity: Array.isArray(raw?.continuity) ? raw!.continuity : [],
  };
}
