/**
 * Tauri IPC 封装层 —— 所有 invoke 调用集中在这里，UI 不直接接触 invoke。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  EpisodeInfo,
  ProjectManifest,
  ProviderProfile,
} from "@onetv/shared-types";

import type { AppSettings } from "@onetv/shared-types";
export type { AppSettings } from "@onetv/shared-types";

/* ---------------- 设置 ---------------- */

export const getSettings = () => invoke<AppSettings>("settings_get");
export const updateSettings = (patch: Partial<AppSettings>) =>
  invoke<AppSettings>("settings_update", { patch });

export interface AppInfo {
  version: string;
  dataDir: string;
}
export const appInfo = () => invoke<AppInfo>("app_info");

export interface FfmpegStatus {
  ffmpegPath: string | null;
  ffprobePath: string | null;
  ffmpegVersion: string | null;
  ok: boolean;
  message: string;
}
export const ffmpegStatus = () => invoke<FfmpegStatus>("ffmpeg_status");

/* ---------------- 工作区/项目 ---------------- */

export interface RecentWorkspace {
  path: string;
  name: string;
  lastOpenedAt: string;
}
export const listRecentWorkspaces = () => invoke<RecentWorkspace[]>("workspace_recent_list");
export const addRecentWorkspace = (path: string, name: string) =>
  invoke<void>("workspace_recent_add", { path, name });

export interface CreateProjectInput {
  workspacePath: string;
  projectTitle: string;
  aspectRatio?: string;
}
export const projectCreate = (input: CreateProjectInput) =>
  invoke<ProjectManifest>("project_create", { input });
export const projectOpen = (projectDir: string) =>
  invoke<ProjectManifest>("project_open", { projectDir });
export const projectClose = () => invoke<void>("project_close");
export const projectInfo = () =>
  invoke<{ manifest: ProjectManifest | null; rootPath: string | null }>("project_info");
export const projectPickDirectory = (title: string) =>
  invoke<string | null>("pick_directory", { title });

export interface EpisodeInfoDto {
  id: string;
  number: number;
  title: string;
  status: string;
}
export const episodeList = () => invoke<EpisodeInfo[]>("episode_list");
export const episodeCreate = (title?: string) => invoke<EpisodeInfo>("episode_create", { title });

/* ---------------- Keychain ---------------- */

export const secureKeySet = (providerId: string, key: string) =>
  invoke<void>("secure_key_set", { providerId, key });
export const secureKeyDelete = (providerId: string) => invoke<void>("secure_key_delete", { providerId });
export const secureKeyExists = (providerId: string) => invoke<boolean>("secure_key_exists", { providerId });
export const secureKeyList = () => invoke<string[]>("secure_key_list");

/* ---------------- Providers ---------------- */

export const providerList = () => invoke<ProviderProfile[]>("provider_list");
export const providerSave = (profile: ProviderProfile) => invoke<ProviderProfile>("provider_save", { profile });
export const providerDelete = (id: string) => invoke<void>("provider_delete", { id });
export const providerTest = (id: string) =>
  invoke<{ ok: boolean; message: string; latencyMs?: number; layers?: Record<string, string> }>(
    "provider_test",
    { id }
  );
export const providerModels = (id: string) =>
  invoke<{ ok: boolean; models: string[]; message?: string }>("provider_models", { id });

/* ---------------- 事件 ---------------- */

export function onAppEvent<T>(name: string, cb: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(name, (e) => cb(e.payload));
}

/* ---------------- 本地账户（v2.1） ---------------- */

export interface AuthStatus {
  loggedIn: boolean;
  username: string | null;
  email: string | null;
  hasDefaultPassword: boolean;
}
export const authStatus = () => invoke<AuthStatus>("auth_status");
export const authLogin = (username: string, password: string) =>
  invoke<{ ok: boolean }>("auth_login", { username, password });
export const authLogout = () => invoke<void>("auth_logout");
export const authChangeCredentials = (input: {
  currentPassword: string;
  newUsername?: string;
  newPassword?: string;
  email?: string;
  emailCode?: string;
}) => invoke<{ username: string; email: string | null }>("auth_change_credentials", input);
export const authResetWithEmail = (email: string, newPassword: string, emailCode?: string) =>
  invoke<{ ok: boolean }>("auth_reset_with_email", { email, newPassword, emailCode });

export const authSendCode = (purpose: "change" | "reset", email: string, currentPassword?: string) =>
  invoke<{ sent: boolean; message?: string; reason?: string }>("auth_send_code", {
    purpose,
    email,
    currentPassword,
  });

export interface MailConfigInfo {
  configured: boolean;
  host?: string;
  port?: number;
  useTls?: boolean;
  preset?: [string, number, boolean] | null;
}
export const mailConfigGet = (email: string) => invoke<MailConfigInfo>("mail_config_get", { email });
export const mailConfigSave = (input: {
  email: string;
  smtpHost: string;
  smtpPort: number;
  useTls: boolean;
  authCode: string;
}) => invoke<{ ok: boolean }>("mail_config_save", input);
export const mailTestSend = (email: string) =>
  invoke<{ ok: boolean; message: string }>("mail_test_send", { email });

/* ---------------- 外观/皮肤（v2.1） ---------------- */

export const themeSetSkin = () =>
  invoke<{ ok: boolean; skin: string }>("theme_set_skin");
export const themeClearSkin = () => invoke<AppSettings>("theme_clear_skin");

/* ---------------- 错误工具 ---------------- */

/** 统一提取 Tauri/JS 错误的可读文本（CommandError 是 {message} 对象，String(e) 会变成 [object Object]） */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  try { return JSON.stringify(e); } catch { return String(e); }
}

/* ---------------- Agent 附件（v2.3.5 全格式上传） ---------------- */

export interface AgentAttachment {
  assetId: string;
  name: string;
  kind: string;
  mime: string;
  sizeBytes: number;
  path: string;
  /** 文本类附件（txt/md/json/srt 等）的内容预览；二进制为 null */
  textPreview: string | null;
}
export const agentAttach = () => invoke<AgentAttachment>("agent_attach");

/* ---------------- 测试时钟钩子（v2.3.5，时间边界测试用） ---------------- */

export const debugSetTimeOffset = (seconds: number) =>
  invoke<{ ok: boolean; offsetSecs: number }>("debug_set_time_offset", { seconds });
export const debugSessionStatus = () =>
  invoke<{ offsetSecs: number; remainingSecs: number | null }>("debug_session_status");

/* ---------------- 删除能力（v2.3.5） ---------------- */

/** 删除 .ytv 工程（磁盘文件夹一并删除，不可恢复；UI 必须先 confirm） */
export const projectRename = (newTitle: string) =>
  invoke<{ ok: boolean; title: string }>("project_rename", { newTitle });

export const projectDelete = (projectDir: string) => invoke<void>("project_delete", { projectDir });
/** 从最近打开列表移除记录（不删文件） */
export const workspaceRecentRemove = (path: string) =>
  invoke<void>("workspace_recent_remove", { path });
/** 删除分集（episodes/<id>/ 目录与 manifest/DB 记录一并移除，不可恢复；UI 必须先 confirm） */
export const episodeDelete = (episodeId: string) => invoke<void>("episode_delete", { episodeId });

/* ---------------- 意识模块：记忆（v2.3.5+，按项目存储，需先打开项目） ---------------- */

export interface MemoryRecord {
  id: string;
  scope: string;
  text: string;
  /** 后端 serde 未统一命名，两种键都兼容 */
  createdAt?: string;
  created_at?: string;
}
export const memoryList = () => invoke<MemoryRecord[]>("memory_list");
export const memoryAdd = (text: string, scope?: string) =>
  invoke<MemoryRecord>("memory_add", { text, scope });
export const memoryUpdate = (id: string, text: string) =>
  invoke<void>("memory_update", { id, text });
export const memoryDelete = (id: string) => invoke<void>("memory_delete", { id });

/* ---------------- Hermes 桥接（v2.3.5+，双向：出向指令 + 入向反向控制监听） ---------------- */

export interface HermesConfig {
  url: string | null;
  listenPort: number;
  enabled: boolean;
  hasToken: boolean;
}
export const hermesConfigGet = () => invoke<HermesConfig>("hermes_config_get");
/** token：undefined = 保持不变；"" = 清除；url 仅允许本机/局域网地址 */
export const hermesConfigSave = (input: {
  url: string;
  listenPort: number;
  enabled: boolean;
  token?: string;
}) => invoke<HermesConfig>("hermes_config_save", input);
export const hermesTest = () =>
  invoke<{ ok: boolean; latencyMs?: number; body?: string; message?: string }>("hermes_test");
export const hermesSend = (text: string) =>
  invoke<{ ok: boolean; reply?: string; message?: string }>("hermes_send", { text });

export interface HermesLogEntry {
  time: string;
  kind: "outbound" | "inbound" | "outbound_error";
  payload: Record<string, unknown>;
}
export const hermesLogRecent = (limit?: number) =>
  invoke<HermesLogEntry[]>("hermes_log_recent", { limit });

/* ---------------- Agent 附件扩展（Codex 式输入框：拖拽/粘贴导入 + 打开/显示） ---------------- */

/** 按绝对路径导入附件（拖拽用），返回与 agentAttach 相同结构 */
export const agentAttachPath = (path: string) =>
  invoke<AgentAttachment>("agent_attach_path", { path });

/** 粘贴二进制内容落盘导入（WKWebView 拿不到粘贴文件路径），单文件上限 50MB */
export const agentAttachData = (input: { name: string; dataB64: string }) =>
  invoke<AgentAttachment>("agent_attach_data", input);

/** 用系统默认应用打开文件（附件"打开/编辑"入口） */
export const assetOpen = (path: string) => invoke<void>("asset_open", { path });

/** 在 Finder 中显示文件 */
export const assetReveal = (path: string) => invoke<void>("asset_reveal", { path });

/* ---------------- 画布节点生成面板（v2.5） ---------------- */

export const canvasNodeRun = (input: {
  episodeId: string;
  nodeId: string;
  prompt: string;
  aspect?: string;
  providerId?: string;
  modelId?: string;
  referenceAssetIds?: string[];
}) =>
  invoke<{ jobId: string; state: string }>("canvas_node_run", {
    episodeId: input.episodeId,
    nodeId: input.nodeId,
    prompt: input.prompt,
    aspect: input.aspect,
    providerId: input.providerId,
    modelId: input.modelId,
    referenceAssetIds: input.referenceAssetIds,
  });
