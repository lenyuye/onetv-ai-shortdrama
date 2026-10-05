/**
 * 剧本视图 —— 分集选择 / AI 生成剧本（Agent 计划 → 批准执行）/ 场景卡片渲染 / 友好表单编辑 / 保存。
 *
 * 复用 global.css 设计系统（.card / .btn / .tag / .modal 系列 / .empty-state），
 * 布局细节用本组件内 scoped <style> 补充（无法修改 global.css）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EpisodeInfo, SceneBlock, ScriptDocument } from "@onetv/shared-types";
import * as api from "../api";
import * as story from "../api-story";
import type { AgentPlanView } from "../api-story";
import { useApp } from "../store";
import { useT } from "../i18n";

/* ---------------- 剧本库多版本（存储在 script.json 文档内部） ---------------- */

type ScriptVersionSource = "ai" | "upload" | "paste" | "copy";

interface ScriptVersion {
  id: string;
  title: string;
  source: ScriptVersionSource;
  copyOf?: string;
  createdAt: string;
  scenes: SceneBlock[];
}

/** ScriptDocument + 版本库扩展字段（normalizeScript 会剥离未知字段，需手动挂回） */
type ScriptDocWithVersions = ScriptDocument & {
  versions?: ScriptVersion[];
  activeVersionId?: string | null;
};

const VERSION_SOURCE_META: Record<ScriptVersionSource, { label: string; cls: string }> = {
  ai: { label: "AI生成", cls: "blue" },
  upload: { label: "上传", cls: "green" },
  paste: { label: "粘贴", cls: "amber" },
  copy: { label: "副本", cls: "pink" },
};

const COPY_LIMIT_PER_ROOT = 3;

/** 所选 AI 对话模型（null = 自动：模型页「生成模型设置」的默认模型或自动路由） */
type AiModelRef = { providerId: string; modelId: string };

/** 下拉选项值编码：providerId 与 modelId 用 "::" 分隔（与模型页 modelOptionValue 一致） */
const encodeModelOption = (m: AiModelRef) => `${m.providerId}::${m.modelId}`;
const parseModelOption = (v: string): AiModelRef | null => {
  if (!v) return null;
  const i = v.indexOf("::");
  return i > 0 && i < v.length - 2 ? { providerId: v.slice(0, i), modelId: v.slice(i + 2) } : null;
};

/** 模型选择器数据源：已启用且具备 chat 能力的 Provider（含其 chat 模型） */
interface ChatProviderOption {
  id: string;
  name: string;
  models: { modelId: string; displayName: string; capabilities: string[] }[];
}

const newVersionId = () => `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

function cloneScenes(scenes: SceneBlock[]): SceneBlock[] {
  return scenes.map((s) => ({ ...s, dialogues: s.dialogues.map((d) => ({ ...d })) }));
}

/** 把一段纯文本包装成一个场景（上传 / 粘贴新建共用） */
function wrapTextScene(text: string, index: number): SceneBlock {
  return {
    id: `sc${String(index + 1).padStart(2, "0")}-${Date.now().toString(36)}`,
    heading: `第 ${index + 1} 场`,
    synopsis: text,
    dialogues: [],
  };
}

/** doc_get 原始 JSON 里的 versions / activeVersionId 挂回归一化后的文档（整体保留，不丢字段） */
function attachVersions(norm: ScriptDocument, raw: unknown): ScriptDocWithVersions {
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
function withVersionBookkeeping(d: ScriptDocWithVersions): ScriptDocWithVersions {
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

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

export default function ScriptView() {
  const { project, setView, toast } = useApp();
  const t = useT();
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [episodesLoaded, setEpisodesLoaded] = useState(false);
  const [episodeId, setEpisodeId] = useState("");

  const [doc, setDoc] = useState<ScriptDocWithVersions | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  // AI 生成：输入 → 计划 → 批准
  const [aiOpen, setAiOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [plan, setPlan] = useState<AgentPlanView | null>(null);
  const [autoExecuted, setAutoExecuted] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [approveBusy, setApproveBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");
  const [aiModel, setAiModel] = useState<AiModelRef | null>(null);
  const [chatProviders, setChatProviders] = useState<ChatProviderOption[]>([]);

  // 本页场景剪贴板 + 场景卡片右键菜单
  const [sceneClipboard, setSceneClipboard] = useState<SceneBlock | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sceneIndex: number } | null>(null);

  // 剧本库多版本：新建剧本弹窗 + AI 生成结果登记（pending 快照用于判断生成结果是否已落盘）
  const [newOpen, setNewOpen] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newText, setNewText] = useState("");
  const pendingAiRef = useRef<{ snapshot: string } | null>(null);
  const aiRetryRef = useRef(0);
  const episodeIdRef = useRef("");

  /* ---------- 分集列表：跟随项目 / 集数变化刷新 ---------- */
  useEffect(() => {
    if (!project) return;
    setEpisodesLoaded(false);
    api
      .episodeList()
      .then(setEpisodes)
      .catch(() => {})
      .finally(() => setEpisodesLoaded(true));
  }, [project?.episodes.length]);

  // 自动选中第一个分集；当前分集被移除时回退
  useEffect(() => {
    if (episodes.length === 0) {
      if (episodeId) setEpisodeId("");
      return;
    }
    if (!episodeId || !episodes.some((ep) => ep.id === episodeId)) {
      setEpisodeId(episodes[0].id);
    }
  }, [episodeId, episodes]);

  /* ---------- 剧本文档加载 ---------- */
  const refreshDoc = useCallback(
    (ep: string) => {
      if (!ep) return;
      let cancelled = false;
      setLoading(true);
      /** AI 生成结果登记：与批准时的快照不同（生成已落盘）→ 登记为新版本 */
      const registerPendingAiVersion = async (merged: ScriptDocWithVersions) => {
        const pending = pendingAiRef.current;
        if (!pending) return true;
        if (JSON.stringify(merged.scenes) === pending.snapshot) return false; // 尚未变化，生成未落盘
        const version: ScriptVersion = {
          id: newVersionId(),
          title:
            merged.title && merged.title !== "未命名剧本" ? merged.title : "AI 生成剧本",
          source: "ai",
          createdAt: new Date().toISOString(),
          scenes: merged.scenes,
        };
        setSaving(true);
        try {
          const next = withVersionBookkeeping({
            ...merged,
            versions: [...(merged.versions ?? []), version],
            activeVersionId: version.id,
            updatedAt: new Date().toISOString(),
          });
          await story.docSave(ep, "script", next);
          setDoc(next);
          toast(t("已登记 AI 生成剧本为新版本《{title}》", { title: version.title }), "ok");
          return true;
        } catch (e) {
          const msg = api.errMsg(e);
          if (!msg.includes("已取消")) toast(t("登记 AI 剧本版本失败：{msg}", { msg }), "err");
          return true;
        } finally {
          setSaving(false);
        }
      };
      story
        .docGet(ep, "script")
        .then(async (raw) => {
          if (cancelled) return;
          // normalizeScript 会剥离未知字段，这里把 versions / activeVersionId 原样挂回
          const merged = attachVersions(story.normalizeScript(raw, ep), raw);
          setDoc(merged);
          if (pendingAiRef.current && merged.scenes.length > 0) {
            const done = await registerPendingAiVersion(merged);
            if (done) {
              pendingAiRef.current = null;
              aiRetryRef.current = 0;
            } else if (aiRetryRef.current < 6) {
              // 生成任务尚未落盘，稍后自动重试刷新
              aiRetryRef.current += 1;
              window.setTimeout(() => {
                if (!cancelled && episodeIdRef.current === ep) void refreshDoc(ep);
              }, 3000);
            } else {
              pendingAiRef.current = null;
              aiRetryRef.current = 0;
            }
          }
        })
        .catch((e) => {
          if (cancelled) return;
          setDoc(story.emptyScriptDocument(ep));
          const msg = api.errMsg(e);
          if (!msg.includes("已取消")) toast(t("加载剧本失败：{msg}", { msg }), "err");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => {
        cancelled = true;
      };
    },
    [toast]
  );

  useEffect(() => {
    setEditing(false);
    pendingAiRef.current = null;
    aiRetryRef.current = 0;
    episodeIdRef.current = episodeId;
    return refreshDoc(episodeId);
  }, [episodeId, refreshDoc]);

  /* ---------- 模型选择器数据源：一次拉取 Provider 列表并缓存（只留已启用 + 含 chat 能力模型的 Provider） ---------- */
  useEffect(() => {
    let cancelled = false;
    api
      .providerList()
      .then((list) => {
        if (cancelled) return;
        setChatProviders(
          list
            .filter((p) => p.enabled && p.models.some((m) => m.capabilities.includes("chat")))
            .map((p) => ({
              id: p.id,
              name: p.name,
              models: p.models.filter((m) => m.capabilities.includes("chat")),
            }))
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- 右键菜单：点击外部 / Escape 关闭 ---------- */
  useEffect(() => {
    if (!ctxMenu) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && typeof el.closest === "function" && el.closest("[data-ctxmenu]")) return;
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  if (!project) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">📝</div>
        <h2>{t("尚未打开项目")}</h2>
        <p>{t("剧本按分集组织，请先在「工作区」创建或打开一个项目")}</p>
        <button className="btn primary" onClick={() => setView("home")}>{t("前往工作区")}</button>
      </div>
    );
  }

  if (!episodesLoaded) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">⏳</div>
        <p>{t("分集加载中…")}</p>
      </div>
    );
  }

  if (episodes.length === 0) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🎞️</div>
        <h2>{t("还没有分集")}</h2>
        <p>{t("剧本挂在分集下，请先在「项目」页新增一集")}</p>
        <button className="btn primary" onClick={() => setView("projects")}>{t("前往项目页")}</button>
      </div>
    );
  }

  /* ---------- 编辑操作（纯前端，保存时统一落盘） ---------- */

  const patchDoc = (patch: Partial<ScriptDocument>) => {
    setDoc((d) => (d ? { ...d, ...patch } : d));
  };

  const patchScene = (si: number, patch: Partial<ScriptDocument["scenes"][number]>) => {
    setDoc((d) =>
      d ? { ...d, scenes: d.scenes.map((sc, i) => (i === si ? { ...sc, ...patch } : sc)) } : d
    );
  };

  const patchDialogue = (si: number, di: number, patch: Partial<ScriptDocument["scenes"][number]["dialogues"][number]>) => {
    setDoc((d) =>
      d
        ? {
            ...d,
            scenes: d.scenes.map((sc, i) =>
              i === si
                ? { ...sc, dialogues: sc.dialogues.map((dl, j) => (j === di ? { ...dl, ...patch } : dl)) }
                : sc
            ),
          }
        : d
    );
  };

  const addDialogue = (si: number) => {
    setDoc((d) =>
      d
        ? {
            ...d,
            scenes: d.scenes.map((sc, i) =>
              i === si
                ? { ...sc, dialogues: [...sc.dialogues, { characterName: "新角色", line: "" }] }
                : sc
            ),
          }
        : d
    );
  };

  const removeDialogue = (si: number, di: number) => {
    setDoc((d) =>
      d
        ? {
            ...d,
            scenes: d.scenes.map((sc, i) =>
              i === si ? { ...sc, dialogues: sc.dialogues.filter((_, j) => j !== di) } : sc
            ),
          }
        : d
    );
  };

  const addScene = () => {
    setDoc((d) =>
      d
        ? {
            ...d,
            scenes: [
              ...d.scenes,
              {
                id: `sc${String(d.scenes.length + 1).padStart(2, "0")}-${Date.now().toString(36)}`,
                heading: `场景 ${d.scenes.length + 1}`,
                synopsis: "",
                dialogues: [],
              },
            ],
          }
        : d
    );
  };

  const removeScene = (si: number) => {
    if (!window.confirm(t("删除该场景（含全部台词）？保存后生效。"))) return;
    setDoc((d) => (d ? { ...d, scenes: d.scenes.filter((_, i) => i !== si) } : d));
  };

  /* ---------- 场景实体操作（立即持久化，走既有 docSave 路径） ---------- */

  /** 新场景 id：沿用现有「sc+序号-时间戳」规则，避免克隆/粘贴时 id 冲突 */
  const newSceneId = (count: number) =>
    `sc${String(count + 1).padStart(2, "0")}-${Date.now().toString(36)}`;

  /** 实体操作的统一落盘入口：与 saveDoc 相同的 docSave 路径，成功后同步本地状态 */
  const persistScript = async (next: ScriptDocWithVersions, okText: string) => {
    if (!episodeId) return;
    setSaving(true);
    try {
      // 写回前做版本簿记：初始化/同步 versions 与 activeVersionId，严禁丢失版本库字段
      const stamped = withVersionBookkeeping({ ...next, updatedAt: new Date().toISOString() });
      await story.docSave(episodeId, "script", stamped);
      setDoc(stamped);
      toast(okText, "ok");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("保存剧本失败：{msg}", { msg }), "err");
    } finally {
      setSaving(false);
    }
  };

  /** ➕ 追加一个空场景（工具栏 / 右键菜单） */
  const addSceneNow = async () => {
    if (!doc) return;
    await persistScript(
      {
        ...doc,
        scenes: [
          ...doc.scenes,
          {
            id: newSceneId(doc.scenes.length),
            heading: `场景 ${doc.scenes.length + 1}`,
            synopsis: "",
            dialogues: [],
          },
        ],
      },
      t("已新建场景")
    );
  };

  /** 📄 复制场景到本页剪贴板 */
  const copyScene = (si: number) => {
    if (!doc) return;
    const sc = doc.scenes[si];
    if (!sc) return;
    setSceneClipboard({ ...sc, dialogues: sc.dialogues.map((d) => ({ ...d })) });
    toast(t("已复制场景「{name}」到剪贴板", { name: sc.heading }), "ok");
  };

  /** 📋 粘贴到末尾（新 id） */
  const pasteScene = async () => {
    if (!doc) return;
    if (!sceneClipboard) {
      toast(t("剪贴板为空，请先复制一个场景"), "warn");
      return;
    }
    await persistScript(
      {
        ...doc,
        scenes: [
          ...doc.scenes,
          {
            ...sceneClipboard,
            id: newSceneId(doc.scenes.length),
            dialogues: sceneClipboard.dialogues.map((d) => ({ ...d })),
          },
        ],
      },
      t("已粘贴场景")
    );
  };

  /** ⧉ 原地克隆副本，插入其后（标题加「副本」后缀） */
  const duplicateScene = async (si: number) => {
    if (!doc) return;
    const src = doc.scenes[si];
    if (!src) return;
    const clone: SceneBlock = {
      ...src,
      id: newSceneId(doc.scenes.length),
      heading: `${src.heading} 副本`,
      dialogues: src.dialogues.map((d) => ({ ...d })),
    };
    const scenes = [...doc.scenes];
    scenes.splice(si + 1, 0, clone);
    await persistScript({ ...doc, scenes }, t("已新建场景副本「{name}」", { name: clone.heading }));
  };

  /** 🗑 删除场景（至少保留一个） */
  const removeSceneNow = async (si: number) => {
    if (!doc) return;
    if (doc.scenes.length <= 1) {
      toast(t("至少保留一个场景"), "warn");
      return;
    }
    await persistScript(
      { ...doc, scenes: doc.scenes.filter((_, i) => i !== si) },
      t("已删除第 {n} 场", { n: si + 1 })
    );
  };

  /* ---------- 剧本库：版本操作（均走 persistScript 持久化） ---------- */

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

  /* ---------- 保存 ---------- */

  const saveDoc = async () => {
    if (!episodeId || !doc) return;
    setSaving(true);
    try {
      const stamped = withVersionBookkeeping({ ...doc, updatedAt: new Date().toISOString() });
      await story.docSave(episodeId, "script", stamped);
      setDoc(stamped);
      toast(t("剧本已保存"), "ok");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("保存剧本失败：{msg}", { msg }), "err");
    } finally {
      setSaving(false);
    }
  };

  /* ---------- AI 生成 ---------- */

  const openAi = () => {
    setPrompt("");
    setPlan(null);
    setAutoExecuted(false);
    setAiErr("");
    setAiOpen(true);
  };

  const closeAi = () => {
    if (chatBusy || approveBusy) return;
    setAiOpen(false);
    setPlan(null);
    setAiErr("");
  };

  const runChat = async () => {
    const text = prompt.trim();
    if (!text) return;
    setChatBusy(true);
    setAiErr("");
    try {
      // 前缀「生成剧本：」保证后端意图路由命中 ScriptGenerate（用户自由描述可能不含关键词）
      const res = await story.agentChat(`生成剧本：${text}`, aiModel);
      setPlan(res.plan);
      setAutoExecuted(res.autoExecuted);
      // 低风险任务被后端自动执行：登记待登记版本（快照用于判断生成结果何时落盘），并安排刷新
      if (res.autoExecuted) {
        pendingAiRef.current = { snapshot: JSON.stringify(doc?.scenes ?? []) };
        aiRetryRef.current = 0;
        const ep = episodeId;
        window.setTimeout(() => {
          if (episodeIdRef.current === ep) void refreshDoc(ep);
        }, 1500);
      }
    } catch (e) {
      setAiErr(api.errMsg(e));
    } finally {
      setChatBusy(false);
    }
  };

  const approvePlan = async () => {
    if (!plan?.planId) return;
    setApproveBusy(true);
    try {
      await story.agentApprove(plan.planId);
      toast(t("任务已创建，可在任务页查看"), "ok");
      setAiOpen(false);
      setPlan(null);
      // 生成结果落盘后要登记为新版本：记录当前场景快照，刷新时对比
      pendingAiRef.current = { snapshot: JSON.stringify(doc?.scenes ?? []) };
      aiRetryRef.current = 0;
      // 生成任务由后端异步执行，稍后自动刷新一次；也可手动刷新
      const ep = episodeId;
      window.setTimeout(() => {
        if (ep === episodeId) void refreshDoc(ep);
      }, 1500);
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("批准失败：{msg}", { msg }), "err");
    } finally {
      setApproveBusy(false);
    }
  };

  const epNo = episodes.find((ep) => ep.id === episodeId)?.number;
  const rawEpTitle = episodes.find((ep) => ep.id === episodeId)?.title ?? "";
  // 集号与标题重复时去重：默认标题就是「第 N 集」，避免拼出「第 1 集 · 第 1 集」
  const strippedTitle =
    epNo != null && new RegExp(`^第\\s*${epNo}\\s*集`).test(rawEpTitle)
      ? rawEpTitle.replace(new RegExp(`^第\\s*${epNo}\\s*集[\\s·:：\\-—]*`), "")
      : rawEpTitle;
  const epLabel =
    epNo != null
      ? strippedTitle
        ? t("第 {n} 集 · {title}", { n: epNo, title: strippedTitle })
        : t("第 {n} 集", { n: epNo })
      : rawEpTitle;
  const hasScript = !!doc && doc.scenes.length > 0;

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

  return (
    <div className="page">
      <style>{SCRIPT_CSS}</style>

      <div className="page-header">
        <div>
          <h1>{t("📝 剧本")}</h1>
          <div className="desc">
            {project.project.title}
            {epLabel ? ` · ${epLabel}` : ""}
            {hasScript ? ` · ${t("{n} 个场景", { n: doc?.scenes.length ?? 0 })}` : ""}
          </div>
        </div>
        <div className="script-toolbar">
          <select
            value={episodeId}
            onChange={(e) => setEpisodeId(e.target.value)}
            aria-label={t("选择分集")}
          >
            {episodes.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {t("第 {n} 集 · {title}", { n: ep.number, title: ep.title })}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={openAi}>{t("✨ AI 生成剧本")}</button>
          {hasScript && (
            <button className={`btn ${editing ? "" : "ghost"}`} onClick={() => setEditing((v) => !v)}>
              {editing ? t("✓ 完成编辑") : t("✏️ 编辑")}
            </button>
          )}
          <button className="btn blue" disabled={!hasScript || saving || loading} onClick={() => void saveDoc()}>
            {saving ? t("保存中…") : t("💾 保存剧本")}
          </button>
        </div>
      </div>

      {/* ---------- 剧本库：多版本管理（副标题下方、场景列表上方） ---------- */}
      {!loading && doc && (
        <div className="card script-lib">
          <div className="script-lib-head">
            <span className="script-lib-name">{t("📚 剧本库")}</span>
            <span className="script-lib-hint">{t("编辑内容仅作用于「使用中」的版本")}</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm" disabled={saving} onClick={() => void uploadScriptVersion()}>
              {t("⬆️ 上传剧本")}
            </button>
            <button className="btn sm" disabled={saving} onClick={openNewScript}>
              {t("🆕 新建剧本")}
            </button>
          </div>
          <div className="script-lib-list">
            {libVersions.map((v) => {
              const meta = VERSION_SOURCE_META[v.source] ?? VERSION_SOURCE_META.ai;
              const isActive = v.id === libActiveId;
              return (
                <div key={v.id} className={`script-lib-row${isActive ? " active" : ""}`}>
                  <span className="script-lib-title" title={v.title}>{v.title}</span>
                  <span className={`tag ${meta.cls}`}>{t(meta.label)}</span>
                  <span className="script-lib-time">{fmtTime(v.createdAt)}</span>
                  <span className="tag">{t("{n} 场", { n: v.scenes.length })}</span>
                  <span style={{ flex: 1 }} />
                  {isActive ? (
                    <span className="tag green">{t("使用中")}</span>
                  ) : (
                    <button className="btn sm" disabled={saving} onClick={() => void useVersion(v.id)}>
                      {t("使用")}
                    </button>
                  )}
                  <button className="btn sm" disabled={saving} onClick={() => void duplicateVersion(v.id)}>
                    {t("复制副本")}
                  </button>
                  <button className="btn sm danger" disabled={saving} onClick={() => void deleteVersion(v.id)}>
                    {t("删除")}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="empty-state" style={{ padding: "80px 20px" }}>
          <div className="big">⏳</div>
          <p>{t("剧本加载中…")}</p>
        </div>
      ) : !hasScript ? (
        /* ---------- 空状态：引导 AI 生成 ---------- */
        <div className="empty-state" style={{ padding: "90px 20px" }}>
          <div className="big">📝</div>
          <h2>{t("这一集还没有剧本")}</h2>
          <p>{t("用一句话描述你的想法，AI 会先生成执行计划，批准后再开始创作")}</p>
          <button className="btn primary" onClick={openAi}>{t("✨ AI 生成剧本")}</button>
        </div>
      ) : (
        /* ---------- 剧本正文 ---------- */
        <div className="script-body">
          <div className="card script-head-card">
            {editing ? (
              <>
                <div className="field">
                  <label>{t("剧名")}</label>
                  <input type="text" value={doc?.title ?? ""} onChange={(e) => patchDoc({ title: e.target.value })} />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>{t("一句话简介（Logline）")}</label>
                  <textarea
                    value={doc?.logline ?? ""}
                    rows={2}
                    placeholder={t("一句话概括这一集的故事")}
                    onChange={(e) => patchDoc({ logline: e.target.value })}
                  />
                </div>
              </>
            ) : (
              <>
                <h2 className="script-title">{doc?.title || t("未命名剧本")}</h2>
                {doc?.logline && <p className="script-logline">{doc.logline}</p>}
              </>
            )}
          </div>

          {(doc?.scenes ?? []).map((scene, si) => (
            <div className="card scene-card" key={scene.id || si}>
              <div className="scene-head">
                {editing ? (
                  <input
                    type="text"
                    className="scene-heading-input"
                    value={scene.heading}
                    onChange={(e) => patchScene(si, { heading: e.target.value })}
                  />
                ) : (
                  <h3 className="scene-heading">{scene.heading}</h3>
                )}
                <span className="tag">{t("{n} 句台词", { n: scene.dialogues.length })}</span>
                {editing && (
                  <button className="btn sm danger" onClick={() => removeScene(si)}>{t("🗑 删除场景")}</button>
                )}
              </div>

              {editing ? (
                <div className="field">
                  <label>{t("场景梗概")}</label>
                  <textarea
                    value={scene.synopsis}
                    rows={2}
                    onChange={(e) => patchScene(si, { synopsis: e.target.value })}
                  />
                </div>
              ) : (
                scene.synopsis && <p className="scene-synopsis">{scene.synopsis}</p>
              )}

              {scene.dialogues.length > 0 && (
                <div className="dialogue-list">
                  {scene.dialogues.map((dl, di) => (
                    <div className="dialogue-row" key={di}>
                      {editing ? (
                        <>
                          <input
                            type="text"
                            className="dlg-char-input"
                            value={dl.characterName}
                            placeholder={t("角色名")}
                            onChange={(e) => patchDialogue(si, di, { characterName: e.target.value })}
                          />
                          <input
                            type="text"
                            className="dlg-paren-input"
                            value={dl.parenthetical ?? ""}
                            placeholder={t("语气提示（可选）")}
                            onChange={(e) => patchDialogue(si, di, { parenthetical: e.target.value || undefined })}
                          />
                          <textarea
                            className="dlg-line-input"
                            value={dl.line}
                            rows={2}
                            placeholder={t("台词内容")}
                            onChange={(e) => patchDialogue(si, di, { line: e.target.value })}
                          />
                          <button className="btn sm danger" onClick={() => removeDialogue(si, di)}>{t("删除")}</button>
                        </>
                      ) : (
                        <>
                          <span className="tag pink dlg-char">{dl.characterName}</span>
                          <div className="dlg-body">
                            {dl.parenthetical && <span className="dlg-paren">({dl.parenthetical})</span>}
                            <span className="dlg-line">{dl.line}</span>
                          </div>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {editing && (
                <button className="btn sm" onClick={() => addDialogue(si)}>{t("+ 添加台词")}</button>
              )}
            </div>
          ))}

          {editing && (
            <button className="btn scene-add" onClick={addScene}>{t("+ 新增场景")}</button>
          )}

          <div className="script-foot">
            <span>🔒</span>
            <span>{t("剧本保存在项目 episodes/ 内 · 编辑后记得「保存剧本」")}</span>
          </div>
        </div>
      )}

      {/* ---------- AI 生成弹窗 ---------- */}
      {aiOpen && (
        <div className="modal-overlay" onClick={closeAi}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{t("✨ AI 生成剧本")}{epLabel ? ` · ${epLabel}` : ""}</span>
              <button className="btn sm ghost" onClick={closeAi}>×</button>
            </div>
            <div className="modal-body">
              {!plan ? (
                <>
                  <div className="field">
                    <label>{t("一句话需求")}</label>
                    <textarea
                      value={prompt}
                      rows={4}
                      autoFocus
                      placeholder={t("一句话需求：都市情感短剧，女主是咖啡店老板…")}
                      onChange={(e) => setPrompt(e.target.value)}
                    />
                    <div className="sub">
                      {t("Agent 会先给出执行计划；剧本生成将调用 Chat Provider（可能联网出站）")}
                    </div>
                  </div>
                  {aiErr && <div className="script-err">⚠️ {aiErr}</div>}
                  {/* 模型选择器：生成按钮上方 */}
                  <div className="field" style={{ marginBottom: 0 }}>
                    <label>{t("AI 模型")}</label>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                      <select
                        value={aiModel ? encodeModelOption(aiModel) : ""}
                        disabled={chatBusy || approveBusy}
                        aria-label={t("选择 AI 模型")}
                        style={{ minWidth: 220 }}
                        onChange={(e) => setAiModel(parseModelOption(e.target.value))}
                      >
                        <option value="">{t("自动（默认模型/自动路由）")}</option>
                        {chatProviders.map((p) => (
                          <optgroup key={p.id} label={p.name}>
                            {p.models.map((m, i) => (
                              <option
                                key={`${m.modelId}-${i}`}
                                value={encodeModelOption({ providerId: p.id, modelId: m.modelId })}
                              >
                                {p.name} · {m.modelId}
                              </option>
                            ))}
                          </optgroup>
                        ))}
                      </select>
                      {chatProviders.length === 0 && (
                        <span style={{ fontSize: 11, color: "var(--muted)" }}>
                          {t("未配置可用对话模型，将使用离线 Mock")}
                        </span>
                      )}
                    </div>
                  </div>
                </>
              ) : autoExecuted ? (
                <div className="plan-done">
                  <div className="big">✅</div>
                  <p>{t("低风险任务已自动执行，无需批准。稍后刷新即可查看结果。")}</p>
                  <p className="hint">{plan.summary}</p>
                </div>
              ) : (
                <PlanPanel plan={plan} />
              )}
            </div>
            <div className="modal-foot">
              {!plan ? (
                <button
                  className="btn primary"
                  disabled={!prompt.trim() || chatBusy}
                  onClick={() => void runChat()}
                >
                  {chatBusy ? t("规划中…") : t("生成执行计划")}
                </button>
              ) : autoExecuted ? (
                <button className="btn primary" onClick={closeAi}>{t("好的")}</button>
              ) : (
                <button className="btn primary" disabled={approveBusy} onClick={() => void approvePlan()}>
                  {approveBusy ? t("执行中…") : t("批准执行")}
                </button>
              )}
              <button className="btn" disabled={chatBusy || approveBusy} onClick={closeAi}>
                {plan && !autoExecuted ? t("拒绝") : t("取消")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ---------- 新建剧本弹窗（粘贴内容） ---------- */}
      {newOpen && (
        <div className="modal-overlay" onClick={closeNewScript}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{t("🆕 新建剧本")}{epLabel ? ` · ${epLabel}` : ""}</span>
              <button className="btn sm ghost" onClick={closeNewScript}>×</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>{t("剧本标题")}</label>
                <input
                  type="text"
                  value={newTitle}
                  autoFocus
                  placeholder={t("例如：雨夜重逢")}
                  onChange={(e) => setNewTitle(e.target.value)}
                />
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>{t("剧本内容（必填，粘贴完整剧本文本）")}</label>
                <textarea
                  value={newText}
                  rows={10}
                  placeholder={t("粘贴剧本文本，将作为新版本的第 1 场保存…")}
                  onChange={(e) => setNewText(e.target.value)}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn primary" disabled={!newText.trim() || saving} onClick={() => void submitNewScript()}>
                {t("创建版本")}
              </button>
              <button className="btn" disabled={saving} onClick={closeNewScript}>
                {t("取消")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- 计划面板（summary + 步骤 + 风险 tag） ---------------- */

export function PlanPanel({ plan }: { plan: AgentPlanView }) {
  const t = useT();
  const riskClass = plan.estimated.risk === "high" ? "red" : plan.estimated.risk === "medium" ? "amber" : "green";
  const riskLabel =
    plan.estimated.risk === "high" ? t("高风险") : plan.estimated.risk === "medium" ? t("中风险") : t("低风险");
  return (
    <div className="plan-panel">
      <div className="plan-summary">{plan.summary || t("（无摘要）")}</div>
      <div className="plan-tags">
        <span className="tag blue">{plan.intent}</span>
        <span className={`tag ${riskClass}`}>{riskLabel}</span>
        <span className="tag">{t("任务 {n}", { n: plan.estimated.jobs })}</span>
        <span className="tag">{t("远程调用 {n}", { n: plan.estimated.remoteCalls })}</span>
      </div>
      <div className="plan-steps">
        {plan.steps.map((s, i) => (
          <div className="plan-step" key={s.id || i}>
            <span className="plan-step-idx">{i + 1}</span>
            <span className="tag mono plan-tool">{s.tool}</span>
            <span className="plan-desc">{s.description}</span>
            <span className={`tag ${s.approval === "required" ? "pink" : ""}`}>
              {s.approval === "required" ? t("需批准") : t("自动")}
            </span>
          </div>
        ))}
      </div>
      <div className="plan-note">{t("批准后将创建任务并在后台执行，可在「任务」页查看进度。")}</div>
    </div>
  );
}

/* ---------------- 视图局部样式（补充 global.css，深色一致） ---------------- */

const SCRIPT_CSS = `
.script-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.script-toolbar select { min-width: 170px; }
.script-body { display: flex; flex-direction: column; gap: 12px; }
.script-head-card { border-left: 3px solid var(--pink); }
.script-title { font-size: 17px; font-weight: 700; margin: 0; }
.script-logline { color: var(--muted); font-size: 12.5px; margin-top: 6px; }
.scene-card { border-left: 3px solid var(--blue); display: flex; flex-direction: column; gap: 10px; }
.scene-head { display: flex; align-items: center; gap: 10px; }
.scene-heading { font-size: 14px; font-weight: 700; color: var(--text); margin: 0; flex: 1; min-width: 0; }
.scene-heading-input { flex: 1; font-weight: 600; }
.scene-synopsis { color: var(--muted); font-size: 12.5px; }
.scene-add { align-self: flex-start; }
.dialogue-list { display: flex; flex-direction: column; gap: 8px; }
.dialogue-row { display: flex; align-items: flex-start; gap: 10px; }
.dlg-char { flex-shrink: 0; min-width: 56px; justify-content: center; margin-top: 2px; }
.dlg-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dlg-paren { color: var(--muted); font-size: 11.5px; font-style: italic; }
.dlg-line { color: var(--text); font-size: 13px; white-space: pre-wrap; word-break: break-word; }
.dialogue-row .dlg-char-input { width: 110px; flex-shrink: 0; }
.dialogue-row .dlg-paren-input { width: 160px; flex-shrink: 0; }
.dialogue-row .dlg-line-input { flex: 1; min-height: 0; }
.dialogue-row .btn { flex-shrink: 0; margin-top: 2px; }
.script-err { color: var(--red); font-size: 12.5px; margin-top: 8px; }
.script-lib { border-left: 3px solid var(--cyan, #4cc9f0); display: flex; flex-direction: column; gap: 8px; padding: 12px 14px; }
.script-lib-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.script-lib-name { font-size: 13.5px; font-weight: 700; color: var(--text); }
.script-lib-hint { color: var(--muted); font-size: 11.5px; }
.script-lib-list { display: flex; flex-direction: column; gap: 6px; }
.script-lib-row {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 7px 10px; border-radius: var(--radius-sm);
  background: var(--panel-2); border: 1px solid var(--border);
}
.script-lib-row.active { border-color: rgba(53, 208, 127, 0.5); background: linear-gradient(90deg, rgba(53, 208, 127, 0.08), transparent 70%), var(--panel-2); }
.script-lib-title { font-size: 13px; font-weight: 600; color: var(--text); max-width: 260px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.script-lib-time { color: var(--muted); font-size: 11.5px; font-family: var(--mono); }
.plan-panel { display: flex; flex-direction: column; gap: 12px; }
.plan-summary { font-size: 13px; color: var(--text); line-height: 1.6; }
.plan-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.tag.mono { font-family: var(--mono); font-size: 10px; letter-spacing: 0.3px; }
.plan-steps { display: flex; flex-direction: column; gap: 6px; border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px; background: var(--bg-deep); }
.plan-step { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.plan-step-idx {
  width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--panel-3); border: 1px solid var(--border-strong);
  color: var(--text-dim); font-size: 10.5px;
}
.plan-tool { flex-shrink: 0; }
.plan-desc { color: var(--text-dim); flex: 1; min-width: 0; }
.plan-note { color: var(--muted); font-size: 11.5px; }
.plan-done { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 20px 0; text-align: center; color: var(--text-dim); }
.plan-done .big { font-size: 34px; }
.script-foot {
  display: flex; align-items: center; gap: 8px;
  margin: 4px 0 -4px; padding: 9px 0;
  border-top: 1px solid var(--border);
  font-size: 11.5px; color: var(--muted);
}
`;
