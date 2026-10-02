/**
 * 全局 UI 状态（zustand）——只存 UI 态与轻量数据；业务数据走 TanStack Query / Rust。
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

export const useApp = create<AppState>((set, get) => ({
  view: "home",
  setView: (v) => set({ view: v }),

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

  rightbarCollapsed: false,
  toggleRightbar: () => set((s) => ({ rightbarCollapsed: !s.rightbarCollapsed })),

  toasts: [],
  toast: (text, kind = "info") => {
    const id = toastSeq++;
    set((s) => ({ toasts: [...s.toasts, { id, kind, text }] }));
    window.setTimeout(() => get().dismissToast(id), 5000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
