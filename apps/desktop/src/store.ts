/**
 * 全局 UI 状态（zustand）——只存 UI 态与轻量数据；业务数据由各视图经 api-* 层
 * 自行拉取（useEffect + cancelled 守卫模式），密钥/设置等敏感数据在 Rust 侧。"
 */
import { create } from "zustand";
import type { AppSettings, ProjectManifest } from "@onetv/shared-types";
import * as api from "./api";

export type ViewKey =
  | "home"
  | "projects"
  | "agent"
  | "script"
  | "storyboard"
  | "canvas"
  | "assets"
  | "models"
  | "skills"
  | "hermes"
  | "jobs"
  | "settings";

export interface Toast {
  id: number;
  kind: "info" | "ok" | "err" | "warn";
  text: string;
}

interface AppState {
  view: ViewKey;
  setView: (v: ViewKey) => void;

  authed: boolean;
  setAuthed: (v: boolean) => void;

  settings: AppSettings | null;
  loadSettings: () => Promise<void>;
  patchSettings: (patch: Partial<AppSettings>) => Promise<void>;

  ffmpeg: api.FfmpegStatus | null;
  loadFfmpeg: () => Promise<void>;

  appVersion: string | null;
  loadAppVersion: () => Promise<void>;

  project: ProjectManifest | null;
  projectRoot: string | null;
  loadProject: () => Promise<void>;

  rightbarCollapsed: boolean;
  toggleRightbar: () => void;

  toasts: Toast[];
  toast: (text: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;

/* ---------- 视图 / 右栏折叠状态持久化（localStorage，读写失败静默回退默认值） ---------- */

/** 视图白名单：localStorage 里读到非法值时回退 "home"（与 ViewKey 联合类型一一对应） */
const VIEW_KEYS: ViewKey[] = [
  "home",
  "projects",
  "agent",
  "script",
  "storyboard",
  "canvas",
  "assets",
  "models",
  "skills",
  "hermes",
  "jobs",
  "settings",
];
const VIEW_STORAGE_KEY = "onetv-view";
const RIGHTBAR_STORAGE_KEY = "onetv-rightbar-collapsed";

function loadStoredView(): ViewKey {
  try {
    const raw = window.localStorage.getItem(VIEW_STORAGE_KEY);
    return VIEW_KEYS.includes(raw as ViewKey) ? (raw as ViewKey) : "home";
  } catch {
    return "home"; // 隐私模式 / 存储不可用等异常时回退默认视图
  }
}

function loadStoredRightbar(): boolean {
  try {
    return window.localStorage.getItem(RIGHTBAR_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export const useApp = create<AppState>((set, get) => ({
  view: loadStoredView(), // 启动时恢复上次停留的视图
  setView: (v) => {
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      /* 存储不可用时忽略，仅切换内存态 */
    }
    set({ view: v });
  },

  authed: false,
  setAuthed: (v) => set({ authed: v }),

  settings: null,
  loadSettings: async () => {
    try {
      const s = await api.getSettings();
      set({ settings: s });
    } catch (e) {
      console.error("loadSettings", e);
    }
  },
  patchSettings: async (patch) => {
    const s = await api.updateSettings(patch);
    set({ settings: s });
  },

  ffmpeg: null,
  loadFfmpeg: async () => {
    try {
      const f = await api.ffmpegStatus();
      set({ ffmpeg: f });
    } catch {
      /* ignore */
    }
  },

  appVersion: null,
  loadAppVersion: async () => {
    try {
      const info = await api.appInfo();
      set({ appVersion: info.version });
    } catch {
      /* ignore */
    }
  },

  project: null,
  projectRoot: null,
  loadProject: async () => {
    try {
      const info = await api.projectInfo();
      set({ project: info.manifest, projectRoot: info.rootPath });
    } catch {
      /* ignore */
    }
  },

  rightbarCollapsed: loadStoredRightbar(), // 启动时恢复上次折叠状态
  toggleRightbar: () =>
    set((s) => {
      const next = !s.rightbarCollapsed;
      try {
        window.localStorage.setItem(RIGHTBAR_STORAGE_KEY, next ? "1" : "0");
      } catch {
        /* 存储不可用时忽略，仅切换内存态 */
      }
      return { rightbarCollapsed: next };
    }),

  toasts: [],
  toast: (text, kind = "info") => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    window.setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
