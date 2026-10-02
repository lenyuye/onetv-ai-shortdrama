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
