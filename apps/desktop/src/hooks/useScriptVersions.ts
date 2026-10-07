/**
 * 剧本库多版本：模型（types/纯函数）+ 操作 hook（自 views/ScriptView.tsx 原样迁出）。
 *
 * versions / activeVersionId 内嵌在 script.json 文档内部（normalizeScript 会剥离未知字段，
 * 加载后需 attachVersions 手动挂回；保存前由 withVersionBookkeeping 簿记，严禁丢字段）。
 * 操作 hook 的落盘统一走调用方（ScriptView）注入的 persistScript，与手动保存同一条 docSave 路径。
 */
import { useState } from "react";
import type { SceneBlock, ScriptDocument } from "@onetv/shared-types";
import * as api from "../api";
import * as story from "../api-story";
import { useApp } from "../store";
import { useT } from "../i18n";

/* ---------------- 剧本库多版本（存储在 script.json 文档内部） ---------------- */

export type ScriptVersionSource = "ai" | "upload" | "paste" | "copy";

export interface ScriptVersion {
  id: string;
  title: string;
  source: ScriptVersionSource;
  copyOf?: string;
  createdAt: string;
  scenes: SceneBlock[];
}

/** ScriptDocument + 版本库扩展字段（normalizeScript 会剥离未知字段，需手动挂回） */
export type ScriptDocWithVersions = ScriptDocument & {
  versions?: ScriptVersion[];
  activeVersionId?: string | null;
};

export const COPY_LIMIT_PER_ROOT = 3;

export const newVersionId = () => `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

export function cloneScenes(scenes: SceneBlock[]): SceneBlock[] {
  return scenes.map((s) => ({ ...s, dialogues: s.dialogues.map((d) => ({ ...d })) }));
}

/** 把一段纯文本包装成一个场景（上传 / 粘贴新建共用） */
export function wrapTextScene(text: string, index: number): SceneBlock {
  return {
    id: `sc${String(index + 1).padStart(2, "0")}-${Date.now().toString(36)}`,
    heading: `第 ${index + 1} 场`,
    synopsis: text,
    dialogues: [],
  };
}

/** doc_get 原始 JSON 里的 versions / activeVersionId 挂回归一化后的文档（整体保留，不丢字段） */
export function attachVersions(norm: ScriptDocument, raw: unknown): ScriptDocWithVersions {
  const o =
    raw !== null && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  if (!o || !Array.isArray(o.versions) || o.versions.length === 0) return norm;
  const versions: ScriptVersion[] = [];
  for (const v of o.versions) {
    const vo =
      v !== null && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : null;
    if (!vo || typeof vo.id !== "string" || !vo.id) continue;
    const source = (["ai", "upload", "paste", "copy"] as readonly string[]).includes(
      typeof vo.source === "string" ? vo.source : ""
    )
      ? (vo.source as ScriptVersionSource)
      : "ai";
    versions.push({
      id: vo.id,
      title: typeof vo.title === "string" && vo.title ? vo.title : "未命名版本",
      source,
      copyOf: typeof vo.copyOf === "string" && vo.copyOf ? vo.copyOf : undefined,
      createdAt: typeof vo.createdAt === "string" ? vo.createdAt : new Date().toISOString(),
      scenes: Array.isArray(vo.scenes) ? (vo.scenes as SceneBlock[]) : [],
    });
  }
  if (versions.length === 0) return norm;
  const activeRaw = o.activeVersionId ?? o.active_version_id;
  return {
    ...norm,
    versions,
    activeVersionId: typeof activeRaw === "string" && activeRaw ? activeRaw : null,
  };
}

/** 保存前的版本簿记：无 versions 时初始化默认版本；保证 activeVersionId 有效；
 *  激活版本的 scenes 始终与编辑器当前 scenes 同步（编辑的就是激活版本）。 */
export function withVersionBookkeeping(d: ScriptDocWithVersions): ScriptDocWithVersions {
  let versions = Array.isArray(d.versions) ? d.versions.filter((v) => !!v && !!v.id) : [];
  let active = d.activeVersionId ?? null;
  if (versions.length === 0) {
    versions = [
      { id: "v-default", title: "默认剧本", source: "ai", createdAt: new Date().toISOString(), scenes: d.scenes },
    ];
    active = "v-default";
  }
  if (!active || !versions.some((v) => v.id === active)) active = versions[0].id;
  versions = versions.map((v) => (v.id === active ? { ...v, scenes: d.scenes } : v));
  return { ...d, versions, activeVersionId: active };
}

/* ---------------- 版本操作 hook（均走 persistScript 持久化） ---------------- */

interface UseScriptVersionsOpts {
  doc: ScriptDocWithVersions | null;
  setDoc: React.Dispatch<React.SetStateAction<ScriptDocWithVersions | null>>;
  episodeId: string;
  persistScript: (next: ScriptDocWithVersions, okText: string) => Promise<void>;
}

export function useScriptVersions({ doc, setDoc, episodeId, persistScript }: UseScriptVersionsOpts) {
  const { toast } = useApp();
  const t = useT();

  // 新建剧本弹窗（粘贴内容）
  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newText, setNewText] = useState("");

  /* ---------- 剧本库派生：版本列表（无 versions 字段时视为只有默认版本）与激活 id ---------- */
  const libVersions: ScriptVersion[] =
    doc?.versions && doc.versions.length > 0
      ? doc.versions
      : doc
        ? [{ id: "v-default", title: "默认剧本", source: "ai", createdAt: doc.updatedAt, scenes: doc.scenes }]
        : [];
  const libActiveId =
    doc?.activeVersionId && libVersions.some((v) => v.id === doc.activeVersionId)
      ? doc.activeVersionId
      : libVersions[0]?.id ?? null;

  /** ⬆️ 上传剧本文件 → 登记为新版本（文本包装为单场景；JSON 剧本直接解析） */
  const uploadScriptVersion = async () => {
    try {
      const att = await api.agentAttach();
      const preview = att.textPreview?.trim() ?? "";
      if (!preview) {
        toast(t("仅支持文本格式文件（txt/md/…），该文件已存入资产库"), "warn");
        return;
      }
      if (!doc) return;
      const baseName = att.name.replace(/\.[^.]+$/, "") || "导入的剧本";
      // 预览是合法 JSON 且含非空 scenes → 按剧本 JSON 解析；否则整段包装为第 1 场
      let scenes: SceneBlock[] | null = null;
      try {
        const parsed: unknown = JSON.parse(preview);
        if (
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          Array.isArray((parsed as { scenes?: unknown }).scenes) &&
          (parsed as { scenes: unknown[] }).scenes.length > 0
        ) {
          scenes = story.normalizeScript(parsed, episodeId).scenes;
        }
      } catch {
        /* 非 JSON，按纯文本处理 */
      }
      if (!scenes) scenes = [wrapTextScene(preview, 0)];
      const version: ScriptVersion = {
        id: newVersionId(),
        title: baseName,
        source: "upload",
        createdAt: new Date().toISOString(),
        scenes,
      };
      await persistScript(
        {
          ...doc,
          scenes,
          versions: [...(doc.versions ?? []), version],
          activeVersionId: version.id,
        },
        t("已导入剧本文件为新版本《{title}》", { title: baseName })
      );
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("上传剧本文件失败：{msg}", { msg }), "err");
    }
  };

  const openNewScript = () => {
    setNewTitle("");
    setNewText("");
    setNewOpen(true);
  };

  const closeNewScript = () => {
    setNewOpen(false);
    setNewTitle("");
    setNewText("");
  };

  /** 🆕 新建剧本（粘贴内容）→ 登记为新版本并切换为激活 */
  const submitNewScript = async () => {
    const text = newText.trim();
    if (!text) return;
    if (!doc) return;
    const title = newTitle.trim() || "未命名剧本";
    const scenes = [wrapTextScene(text, 0)];
    const version: ScriptVersion = {
      id: newVersionId(),
      title,
      source: "paste",
      createdAt: new Date().toISOString(),
      scenes,
    };
    closeNewScript();
    await persistScript(
      { ...doc, scenes, versions: [...(doc.versions ?? []), version], activeVersionId: version.id },
      t("已新建剧本《{title}》", { title })
    );
  };

  /** 使用版本：设为激活并把该版本 scenes 载入编辑器 */
  const useVersion = async (id: string) => {
    if (!doc) return;
    const v = libVersions.find((x) => x.id === id);
    if (!v) return;
    await persistScript(
      { ...doc, scenes: cloneScenes(v.scenes), activeVersionId: v.id },
      t("已切换到《{title}》", { title: v.title })
    );
  };

  /** ⧉ 复制副本：同一根剧本最多 3 个副本（副本的副本计入同一根的名额） */
  /** 重命名版本（v2.26.22）：改 versions[i].title（与 doc.title 联动）并落盘 */
  const renameVersion = async (id: string, title: string) => {
    if (!doc) return;
    const t2 = title.trim();
    if (!t2) return;
    const next: ScriptDocWithVersions = {
      ...doc,
      title: (doc.activeVersionId ?? "") === id ? t2 : doc.title,
      versions: (doc.versions ?? []).map((v) => (v.id === id ? { ...v, title: t2 } : v)),
    };
    setDoc(next);
    await persistScript(next, t("已重命名为《{title}》", { title: t2 }));
  };

  const duplicateVersion = async (id: string) => {
    if (!doc) return;
    const src = libVersions.find((v) => v.id === id);
    if (!src) return;
    const root = src.copyOf ?? src.id; // 副本的根 id：源是副本则继承其 copyOf
    const copies = libVersions.filter((v) => v.source === "copy" && v.copyOf === root).length;
    if (copies >= COPY_LIMIT_PER_ROOT) {
      toast(t("该剧本最多只能创建 3 个副本"), "warn");
      return;
    }
    const clone: ScriptVersion = {
      id: newVersionId(),
      title: `${src.title} 副本${copies + 1}`,
      source: "copy",
      copyOf: root,
      createdAt: new Date().toISOString(),
      scenes: cloneScenes(src.scenes),
    };
    await persistScript(
      { ...doc, versions: [...libVersions, clone] },
      t("已创建副本《{title}》", { title: clone.title })
    );
  };

  /** 🗑 删除版本：激活版本删除前 confirm；删空后自动新建空的默认版本（至少保留一个） */
  const deleteVersion = async (id: string) => {
    if (!doc) return;
    const v = libVersions.find((x) => x.id === id);
    if (!v) return;
    const isActive = id === libActiveId;
    const confirmText = isActive
      ? t("删除当前使用中的版本《{title}》？该版本的剧本内容将一并删除。", { title: v.title })
      : t("删除版本《{title}》？该版本的剧本内容将一并删除。", { title: v.title });
    if (!window.confirm(confirmText)) return;
    let rest = libVersions.filter((x) => x.id !== id);
    if (rest.length === 0) {
      rest = [
        { id: "v-default", title: "默认剧本", source: "ai", createdAt: new Date().toISOString(), scenes: [] },
      ];
    }
    const nextActive = rest.some((x) => x.id === libActiveId) ? (libActiveId as string) : rest[0].id;
    const nextScenes = cloneScenes(rest.find((x) => x.id === nextActive)?.scenes ?? []);
    await persistScript(
      { ...doc, scenes: nextScenes, versions: rest, activeVersionId: nextActive },
      t("已删除版本《{title}》", { title: v.title })
    );
  };

  return {
    libVersions,
    libActiveId,
    uploadScriptVersion,
    newOpen,
    newTitle,
    setNewTitle,
    newText,
    setNewText,
    openNewScript,
    closeNewScript,
    submitNewScript,
    useVersion,
    duplicateVersion,
    renameVersion,
    deleteVersion,
  };
}
