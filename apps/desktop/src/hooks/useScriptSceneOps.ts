/**
 * 剧本编辑操作 hook（自 views/ScriptView.tsx 原样迁出）：
 * - 纯前端编辑（patch / add / remove）：只改本地 doc，点「保存剧本」时统一落盘；
 * - 场景实体操作（addSceneNow / copy / paste / duplicate / removeSceneNow）：立即持久化，
 *   走调用方（ScriptView）注入的 persistScript（与手动保存同一条 docSave 路径）；
 * - 本页场景剪贴板 + 场景卡片右键菜单状态（含点击外部 / Escape 关闭监听）。
 */
import { useEffect, useState } from "react";
import type { SceneBlock, ScriptDocument } from "@onetv/shared-types";
import { useApp } from "../store";
import { useT } from "../i18n";
import type { ScriptDocWithVersions } from "./useScriptVersions";

interface UseScriptSceneOpsOpts {
  doc: ScriptDocWithVersions | null;
  setDoc: React.Dispatch<React.SetStateAction<ScriptDocWithVersions | null>>;
  persistScript: (next: ScriptDocWithVersions, okText: string) => Promise<void>;
}

export function useScriptSceneOps({ doc, setDoc, persistScript }: UseScriptSceneOpsOpts) {
  const { toast } = useApp();
  const t = useT();

  // 本页场景剪贴板 + 场景卡片右键菜单
  const [sceneClipboard, setSceneClipboard] = useState<SceneBlock | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sceneIndex: number } | null>(null);

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

  return {
    sceneClipboard,
    setSceneClipboard,
    ctxMenu,
    setCtxMenu,
    patchDoc,
    patchScene,
    patchDialogue,
    addDialogue,
    removeDialogue,
    addScene,
    removeScene,
    addSceneNow,
    copyScene,
    pasteScene,
    duplicateScene,
    removeSceneNow,
  };
}
