/**
 * 分镜视图 —— 分集选择 / 从剧本拆分镜头 / 批量生成分镜图（Egress 预览确认）/
 * 镜头卡片网格（含生成图预览）/ 镜头详情编辑抽屉 / 选中镜头人工批准（规格 §14.2）。
 *
 * 复用 global.css 设计系统（.card / .btn / .tag / .modal 系列 / .empty-state），
 * 布局细节用本组件内 scoped <style> 补充（无法修改 global.css）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import type { EpisodeInfo, Shot, StoryboardDocument } from "@onetv/shared-types";
import * as api from "../api";
import * as story from "../api-story";
import type { AgentPlanView } from "../api-story";
import { useApp } from "../store";
import { useT } from "../i18n";
import { PlanPanel } from "./ScriptView";
import ExportDialog from "../components/export/ExportDialog";

/* ---------------- 常量 ---------------- */

const SHOT_SIZE_OPTIONS = ["远景", "全景", "中景", "近景", "特写", "大特写"];

const STATUS_META: Record<string, { label: string; cls: string }> = {
  draft: { label: "草稿", cls: "" },
  approved: { label: "已批准", cls: "green" },
  generating: { label: "生成中", cls: "amber" },
  ready: { label: "已出图", cls: "blue" },
  failed: { label: "失败", cls: "red" },
};

export default function StoryboardView() {
  const { project, setView, toast } = useApp();
  const t = useT();
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [episodesLoaded, setEpisodesLoaded] = useState(false);
  const [episodeId, setEpisodeId] = useState("");

  const [doc, setDoc] = useState<StoryboardDocument | null>(null);
  const [hasScript, setHasScript] = useState(false);
  const [loading, setLoading] = useState(false);

  // 资产 id → 路径（分镜图 outputAssetId 解析）
  const [assetPathMap, setAssetPathMap] = useState<Map<string, string>>(new Map());
  const [brokenImgs, setBrokenImgs] = useState<Set<string>>(new Set());

  // 选中镜头
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // 镜头详情编辑抽屉（受控副本）
  const [editShotId, setEditShotId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ prompt: "", shotSize: "中景", durationSec: "3", dialogue: "" });

  // Agent 计划弹窗
  const [aiOpen, setAiOpen] = useState(false);
  const [aiContext, setAiContext] = useState<"split" | "batch" | "compose" | "export">("split");
  // 多版本导出弹窗
  const [exportOpen, setExportOpen] = useState(false);
  const [plan, setPlan] = useState<AgentPlanView | null>(null);
  const [autoExecuted, setAutoExecuted] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [approveBusy, setApproveBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");

  // 本页镜头剪贴板 + 镜头卡片右键菜单
  const [shotClipboard, setShotClipboard] = useState<Shot | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; shotId: string } | null>(null);

  /* ---------- 分集列表 ---------- */
  useEffect(() => {
    if (!project) return;
    setEpisodesLoaded(false);
    api
      .episodeList()
      .then(setEpisodes)
      .catch(() => {})
      .finally(() => setEpisodesLoaded(true));
  }, [project?.episodes.length]);

  useEffect(() => {
    if (episodes.length === 0) {
      if (episodeId) setEpisodeId("");
      return;
    }
    if (!episodeId || !episodes.some((ep) => ep.id === episodeId)) {
      setEpisodeId(episodes[0].id);
    }
  }, [episodeId, episodes]);

  /* ---------- 数据加载：分镜 + 剧本（判断有无剧本） + 资产映射 ---------- */
  const refresh = useCallback(
    (ep: string) => {
      if (!ep) return;
      let cancelled = false;
      setLoading(true);
      // 分镜表为主数据源；剧本用于判断「无剧本」引导，资产用于 outputAssetId → 图片 URL
      void story
        .docGet(ep, "storyboard")
        .then((raw) => {
          if (!cancelled) setDoc(story.normalizeStoryboard(raw, ep));
        })
        .catch((e) => {
          if (cancelled) return;
          setDoc(story.emptyStoryboardDocument(ep));
          const msg = api.errMsg(e);
          if (!msg.includes("已取消")) toast(t("加载分镜失败：{msg}", { msg }), "err");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      void story
        .docGet(ep, "script")
        .then((raw) => {
          if (!cancelled) setHasScript(story.normalizeScript(raw, ep).scenes.length > 0);
        })
        .catch(() => {
          if (!cancelled) setHasScript(false);
        });
      void story
        .assetList()
        .then((records) => {
          if (!cancelled) {
            setAssetPathMap(story.buildAssetPathMap(records));
            setBrokenImgs(new Set());
          }
        })
        .catch(() => {});
      return () => {
        cancelled = true;
      };
    },
    [toast]
  );

  useEffect(() => {
    setSelectedIds(new Set());
    setEditShotId(null);
    return refresh(episodeId);
  }, [episodeId, refresh]);

  const shots = doc?.shots ?? [];

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

  /* ---------- 保存 ---------- */

  const saveDoc = useCallback(
    async (next: StoryboardDocument, okText: string) => {
      if (!episodeId) return;
      setSaving(true);
      try {
        await story.docSave(episodeId, "storyboard", { ...next, updatedAt: new Date().toISOString() });
        setDoc({ ...next, updatedAt: new Date().toISOString() });
        toast(okText, "ok");
      } catch (e) {
        const msg = api.errMsg(e);
        if (!msg.includes("已取消")) toast(t("保存分镜表失败：{msg}", { msg }), "err");
      } finally {
        setSaving(false);
      }
    },
    [episodeId, toast]
  );

  /* ---------- 镜头实体操作（均走 saveDoc 持久化） ---------- */

  /** 现有编号规则顺延：S001 起，取现有最大序号 + 1 */
  const newShotId = (list: Shot[]) => {
    let max = 0;
    for (const s of list) {
      const m = /^S(\d+)$/i.exec(s.shotId);
      if (m) max = Math.max(max, Number(m[1]));
    }
    return `S${String(max + 1).padStart(3, "0")}`;
  };

  /** 深拷贝镜头（camera / characters / referenceAssets / generation 单独处理） */
  const deepCloneShot = (src: Shot): Shot => ({
    ...src,
    camera: { ...src.camera },
    characters: [...src.characters],
    referenceAssets: [...src.referenceAssets],
    generation: { ...src.generation },
  });

  /** 空镜头模板（与 normalizeStoryboard 缺省镜头一致） */
  const emptyShot = (list: Shot[]): Shot => ({
    shotId: newShotId(list),
    scene: "",
    durationSec: 3,
    shotSize: "中景",
    camera: { movement: "", angle: "" },
    characters: [],
    action: "",
    prompt: "",
    referenceAssets: [],
    generation: { type: "text_to_video", duration: 3, aspectRatio: "9:16" },
    status: "draft",
  });

  /** ➕ 追加一个空镜头（工具栏 / 右键菜单） */
  const addShotNow = async () => {
    if (!doc) return;
    const shot = emptyShot(doc.shots);
    await saveDoc({ ...doc, shots: [...doc.shots, shot] }, t("已新建镜头 {id}", { id: shot.shotId }));
  };

  /** 📄 复制镜头到本页剪贴板 */
  const copyShot = (shot: Shot) => {
    setShotClipboard(deepCloneShot(shot));
    toast(t("已复制镜头 {id} 到剪贴板", { id: shot.shotId }), "ok");
  };

  /** 📋 粘贴剪贴板镜头到末尾（新 id、清空分镜图、状态回草稿） */
  const pasteShot = async () => {
    if (!doc) return;
    if (!shotClipboard) {
      toast(t("剪贴板为空，请先复制一个镜头"), "warn");
      return;
    }
    const shot: Shot = {
      ...deepCloneShot(shotClipboard),
      shotId: newShotId(doc.shots),
      outputAssetId: undefined,
      status: "draft",
    };
    await saveDoc({ ...doc, shots: [...doc.shots, shot] }, t("已粘贴镜头 {id}", { id: shot.shotId }));
  };

  /** ⧉ 生成副本：原镜头之后克隆（新 shotId、outputAssetId 清空、status 回 draft） */
  const duplicateShot = async (shot: Shot) => {
    if (!doc) return;
    const clone: Shot = {
      ...deepCloneShot(shot),
      shotId: newShotId(doc.shots),
      outputAssetId: undefined,
      status: "draft",
    };
    const idx = doc.shots.findIndex((s) => s.shotId === shot.shotId);
    const list = [...doc.shots];
    list.splice(idx + 1, 0, clone);
    await saveDoc({ ...doc, shots: list }, t("已生成镜头副本 {id}", { id: clone.shotId }));
  };

  /** 🗑 删除镜头（仅剩一个时拒绝） */
  const deleteShotNow = async (shotId: string) => {
    if (!doc) return;
    if (doc.shots.length <= 1) {
      toast(t("至少保留一个镜头"), "warn");
      return;
    }
    await saveDoc(
      { ...doc, shots: doc.shots.filter((s) => s.shotId !== shotId) },
      t("已删除镜头 {id}", { id: shotId })
    );
  };

  /** ⬆️ 上传分镜图：shotId 为空时作用于第一个未出图镜头 */
  const uploadShotImage = async (shotId: string | null) => {
    let targetId = shotId;
    if (!targetId) {
      if (shots.length === 0) {
        toast(t("分镜表为空，请先新建或拆分镜头"), "warn");
        return;
      }
      const first = shots.find((s) => !s.outputAssetId);
      if (!first) {
        toast(t("所有镜头均已出图，无需再上传"), "warn");
        return;
      }
      targetId = first.shotId;
    }
    try {
      const att = await api.agentAttach();
      if (att.kind !== "images") {
        toast(t("请选择图片文件（已存入资产库）"), "warn");
        return;
      }
      if (!doc) return;
      const next: StoryboardDocument = {
        ...doc,
        shots: doc.shots.map((s) =>
          s.shotId === targetId ? { ...s, outputAssetId: att.assetId, status: "ready" } : s
        ),
      };
      await saveDoc(next, t("已为镜头 {id} 上传分镜图", { id: targetId }));
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("上传分镜图失败：{msg}", { msg }), "err");
    }
  };

  /* ---------- 选中 ---------- */

  const toggleShot = (shotId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(shotId)) next.delete(shotId);
      else next.add(shotId);
      return next;
    });
  };

  const allSelected = shots.length > 0 && shots.every((s) => selectedIds.has(s.shotId));

  const toggleAll = () => {
    setSelectedIds(allSelected ? new Set() : new Set(shots.map((s) => s.shotId)));
  };

  const approveSelected = async () => {
    if (selectedIds.size === 0) {
      toast(t("请先勾选要批准的镜头"), "warn");
      return;
    }
    if (!doc) return;
    const next: StoryboardDocument = {
      ...doc,
      shots: doc.shots.map((s) => (selectedIds.has(s.shotId) ? { ...s, status: "approved" } : s)),
    };
    await saveDoc(next, t("已批准 {n} 个镜头（人工 QC）", { n: selectedIds.size }));
    setSelectedIds(new Set());
  };

  /* ---------- 镜头详情编辑 ---------- */

  const openDetail = (shot: Shot) => {
    setEditShotId(shot.shotId);
    setEditForm({
      prompt: shot.prompt,
      shotSize: shot.shotSize,
      durationSec: String(shot.durationSec),
      dialogue: shot.dialogue ?? "",
    });
  };

  const applyDetail = async () => {
    if (!doc || !editShotId) return;
    const dur = Number(editForm.durationSec);
    const next: StoryboardDocument = {
      ...doc,
      shots: doc.shots.map((s) =>
        s.shotId === editShotId
          ? {
              ...s,
              prompt: editForm.prompt,
              shotSize: editForm.shotSize,
              durationSec: Number.isFinite(dur) && dur > 0 ? Math.round(dur * 10) / 10 : s.durationSec,
              dialogue: editForm.dialogue || undefined,
            }
          : s
      ),
    };
    setEditShotId(null);
    await saveDoc(next, t("镜头已更新并保存分镜表"));
  };

  /* ---------- Agent：拆分镜头 / 批量生成分镜图 ---------- */

  const openAi = (ctx: "split" | "batch" | "compose" | "export") => {
    if ((ctx === "batch" || ctx === "compose" || ctx === "export") && shots.length === 0) {
      toast(t("分镜表为空，请先「从剧本拆分镜头」"), "warn");
      return;
    }
    setAiContext(ctx);
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
    setChatBusy(true);
    setAiErr("");
    try {
      const text =
        aiContext === "split"
          ? "把当前集拆成分镜"
          : aiContext === "compose"
            ? "按分镜顺序合成成片"
            : aiContext === "export"
              ? "导出竖版成片"
              : "批量生成分镜图";
      const res = await story.agentChat(text);
      setPlan(res.plan);
      setAutoExecuted(res.autoExecuted);
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
      // 生成任务由后端异步执行，稍后自动刷新；也可手动刷新
      const ep = episodeId;
      window.setTimeout(() => {
        if (ep === episodeId) void refresh(ep);
      }, 1500);
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("批准失败：{msg}", { msg }), "err");
    } finally {
      setApproveBusy(false);
    }
  };

  /** 分镜图 URL：有 outputAssetId 且能映射到资产路径即展示（与批准状态无关） */
  const shotImage = (shot: Shot): string | null => {
    if (!shot.outputAssetId) return null;
    if (brokenImgs.has(`${shot.shotId}:${shot.outputAssetId}`)) return null;
    const path = assetPathMap.get(shot.outputAssetId);
    return path ? story.assetUrl(path) : null;
  };

  const markImgBroken = (shot: Shot) => {
    if (!shot.outputAssetId) return;
    const key = `${shot.shotId}:${shot.outputAssetId}`;
    setBrokenImgs((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  };

  /** 已出图 = 有 outputAssetId（已拿到分镜图）的镜头数，与批准状态无关 */
  const readyCount = useMemo(() => shots.filter((s) => !!s.outputAssetId).length, [shots]);
  const approvedCount = useMemo(() => shots.filter((s) => s.status === "approved").length, [shots]);
  const editShot = shots.find((s) => s.shotId === editShotId) ?? null;
  const ctxShot = ctxMenu ? (shots.find((s) => s.shotId === ctxMenu.shotId) ?? null) : null;

  /** 第一步确认弹窗正文 —— 四个入口语义不同，各有专属文案 */
  const aiIntro =
    aiContext === "split"
      ? t("Agent 将读取当前集剧本，按场景与台词拆分为镜头表（本地工具，不出站）。")
      : aiContext === "compose"
        ? t("将把已出图镜头用 FFmpeg 在本地合成为竖版成片（不出网），需要项目里已有分镜图。")
        : aiContext === "export"
          ? t("将把最近合成的成片转码为选定画幅并导出（本地转码，不出网）。")
          : t("将为 {n} 个镜头逐个生成分镜图并写回分镜表（status → ready）。", { n: shots.length });

  /* ---------- 守卫空状态 ---------- */

  if (!project) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🖼️</div>
        <h2>{t("尚未打开项目")}</h2>
        <p>{t("分镜按分集组织，请先在「工作区」创建或打开一个项目")}</p>
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
        <p>{t("分镜挂在分集下，请先在「项目」页新增一集")}</p>
        <button className="btn primary" onClick={() => setView("projects")}>{t("前往项目页")}</button>
      </div>
    );
  }

  const epNo = episodes.find((ep) => ep.id === episodeId)?.number ?? "";
  const epTitle = episodes.find((ep) => ep.id === episodeId)?.title ?? "";

  return (
    <div className="page">
      <style>{STORYBOARD_CSS}</style>

      <div className="page-header">
        <div>
          <h1>{t("🖼️ 分镜")}</h1>
          <div className="desc">
            {project.project.title}
            {epTitle ? ` · ${t("第 {n} 集 · {title}", { n: epNo, title: epTitle })}` : ""}
            {shots.length > 0
              ? ` · ${t("{n} 个镜头 · 已出图 {ready} · 已批准 {approved}", { n: shots.length, ready: readyCount, approved: approvedCount })}`
              : ""}
          </div>
        </div>
        <div className="sb-toolbar">
          <select value={episodeId} onChange={(e) => setEpisodeId(e.target.value)} aria-label={t("选择分集")}>
            {episodes.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {t("第 {n} 集 · {title}", { n: ep.number, title: ep.title })}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => openAi("split")}>{t("🎬 从剧本拆分镜头")}</button>
          <button className="btn primary" onClick={() => openAi("batch")}>{t("✨ 批量生成分镜图")}</button>
          <button className="btn blue" onClick={() => openAi("compose")}>{t("🎞️ 合成成片")}</button>
          <button className="btn" onClick={() => openAi("export")}>{t("📤 导出竖版")}</button>
          <button className="btn" disabled={!episodeId} onClick={() => setExportOpen(true)}>{t("📦 多版本导出")}</button>
          <button className="btn" disabled={saving} onClick={() => void addShotNow()}>{t("➕ 新建镜头")}</button>
          <button
            className="btn"
            disabled={!shotClipboard || saving}
            title={shotClipboard ? t("粘贴剪贴板镜头到末尾") : t("剪贴板为空，请先复制镜头")}
            onClick={() => void pasteShot()}
          >
            {t("📋 粘贴")}
          </button>
          <button className="btn" disabled={saving} onClick={() => void uploadShotImage(null)}>{t("⬆️ 上传分镜图")}</button>
          <button className="btn ghost" disabled={loading} onClick={() => refresh(episodeId)}>{t("⟳ 刷新")}</button>
        </div>
      </div>

      {loading ? (
        <div className="empty-state" style={{ padding: "80px 20px" }}>
          <div className="big">⏳</div>
          <p>{t("分镜加载中…")}</p>
        </div>
      ) : shots.length === 0 ? (
        !hasScript ? (
          /* ---------- 无剧本：引导去剧本页 ---------- */
          <div className="empty-state" style={{ padding: "90px 20px" }}>
            <div className="big">📝</div>
            <h2>{t("这一集还没有剧本")}</h2>
            <p>{t("分镜由剧本拆分而来，请先到「剧本」页完成本集剧本")}</p>
            <button className="btn primary" onClick={() => setView("script")}>{t("前往剧本页")}</button>
          </div>
        ) : (
          /* ---------- 有剧本无分镜：引导拆分 ---------- */
          <div className="empty-state" style={{ padding: "90px 20px" }}>
            <div className="big">🎬</div>
            <h2>{t("还没有分镜")}</h2>
            <p>{t("点击「从剧本拆分镜头」，Agent 会按场景与台词生成分镜表")}</p>
            <button className="btn primary" onClick={() => openAi("split")}>{t("🎬 从剧本拆分镜头")}</button>
          </div>
        )
      ) : (
        <>
          {/* ---------- 批量操作条 ---------- */}
          <div className="sb-selectbar">
            <label className="checkbox-row">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              {t("全选（{n}）", { n: shots.length })}
            </label>
            <span className="sb-select-hint">{t("已选 {n} 个", { n: selectedIds.size })}</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm green-btn" disabled={selectedIds.size === 0 || saving} onClick={() => void approveSelected()}>
              {t("✓ 批准选中镜头（{n}）", { n: selectedIds.size })}
            </button>
            <button className="btn sm blue" disabled={saving} onClick={() => doc && void saveDoc(doc, t("分镜表已保存"))}>
              {t("💾 保存分镜表")}
            </button>
          </div>

          {/* ---------- 镜头网格 ---------- */}
          <div className="sb-grid">
            {shots.map((shot) => {
              const status = STATUS_META[shot.status ?? "draft"] ?? STATUS_META.draft;
              const img = shotImage(shot);
              return (
                <div
                  key={shot.shotId}
                  className={`card sb-shot ${selectedIds.has(shot.shotId) ? "selected" : ""}`}
                  onClick={() => openDetail(shot)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setCtxMenu({ x: e.clientX, y: e.clientY, shotId: shot.shotId });
                  }}
                  title={t("点击编辑 prompt / 景别 / 时长 / 台词 · 右键更多操作")}
                >
                  <div className="sb-shot-head">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(shot.shotId)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleShot(shot.shotId)}
                      aria-label={t("选择 {id}", { id: shot.shotId })}
                    />
                    <span className="sb-shot-id">{shot.shotId}</span>
                    <span className="tag blue">{t(shot.shotSize)}</span>
                    <span style={{ flex: 1 }} />
                    <span className={`tag ${status.cls}`}>{t(status.label)}</span>
                  </div>

                  <div className="sb-shot-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="btn sm" onClick={() => openDetail(shot)}>{t("✏️ 编辑")}</button>
                    <button className="btn sm" onClick={() => copyShot(shot)}>{t("📄 复制")}</button>
                    <button className="btn sm" disabled={saving} onClick={() => void duplicateShot(shot)}>{t("⧉ 生成副本")}</button>
                    <button className="btn sm danger" disabled={saving} onClick={() => void deleteShotNow(shot.shotId)}>{t("🗑 删除")}</button>
                  </div>

                  {img && (
                    <img
                      className="sb-shot-img"
                      src={img}
                      alt={t("{id} 分镜图", { id: shot.shotId })}
                      loading="lazy"
                      onError={() => markImgBroken(shot)}
                    />
                  )}

                  <div className="sb-shot-body">
                    <div className="sb-shot-scene">
                      <span className="sb-k">{t("场景")}</span>
                      <span className="sb-v">{shot.scene || "—"}</span>
                    </div>
                    <div className="sb-shot-tags">
                      <span className="tag">🎥 {shot.camera.movement || t("固定机位")}</span>
                      <span className="tag">⏱ {(Number(shot.durationSec) || 0).toFixed(1)}s</span>
                    </div>
                    {shot.action && <p className="sb-shot-action">{shot.action}</p>}
                    {shot.dialogue && <div className="sb-shot-dialogue">“{shot.dialogue}”</div>}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="sb-foot">
            <span>🎨</span>
            <span>{t("分镜图由图像 Provider 生成；Mock Provider 可离线演示 · 点击镜头卡编辑 prompt / 景别 / 时长 / 台词")}</span>
          </div>
        </>
      )}

      {/* ---------- 镜头右键菜单 ---------- */}
      {ctxMenu && (
        <div
          className="sb-ctxmenu"
          data-ctxmenu
          style={{
            left: Math.max(4, Math.min(ctxMenu.x, window.innerWidth - 190)),
            top: Math.max(4, Math.min(ctxMenu.y, window.innerHeight - 200)),
          }}
        >
          <button onClick={() => { setCtxMenu(null); void addShotNow(); }}>{t("➕ 新建镜头")}</button>
          <button
            disabled={!ctxShot}
            onClick={() => { const s = ctxShot; setCtxMenu(null); if (s) copyShot(s); }}
          >
            {t("📄 复制")}
          </button>
          <button
            disabled={!shotClipboard}
            title={shotClipboard ? t("粘贴剪贴板镜头到末尾") : t("剪贴板为空，请先复制镜头")}
            onClick={() => { setCtxMenu(null); void pasteShot(); }}
          >
            {t("📋 粘贴")}
          </button>
          <button
            className="danger"
            disabled={!ctxShot}
            onClick={() => { const id = ctxMenu.shotId; setCtxMenu(null); void deleteShotNow(id); }}
          >
            {t("🗑 删除")}
          </button>
          <button
            disabled={!ctxShot}
            onClick={() => { const id = ctxMenu.shotId; setCtxMenu(null); void uploadShotImage(id); }}
          >
            {t("⬆️ 上传分镜图")}
          </button>
        </div>
      )}

      {/* ---------- Agent 计划弹窗（拆分 / 批量生成共用） ---------- */}
      {aiOpen && (
        <div className="modal-overlay" onClick={closeAi}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>
                {aiContext === "split"
                  ? t("🎬 从剧本拆分镜头")
                  : aiContext === "compose"
                    ? t("🎞️ 合成成片")
                    : aiContext === "export"
                      ? t("📤 导出竖版")
                      : t("✨ 批量生成分镜图")}
                {epTitle ? ` · ${epTitle}` : ""}
              </span>
              <button className="btn sm ghost" onClick={closeAi}>×</button>
            </div>
            <div className="modal-body">
              {!plan ? (
                <>
                  <div className="field">
                    <div className="sb-plan-desc">{aiIntro}</div>
                  </div>
                  {aiErr && <div className="sb-err">⚠️ {aiErr}</div>}
                </>
              ) : autoExecuted ? (
                <div className="sb-plan-done">
                  <div className="big">✅</div>
                  <p>{t("低风险任务已自动执行，无需批准。稍后刷新即可查看结果。")}</p>
                  <p className="hint">{plan.summary}</p>
                </div>
              ) : (
                <>
                  {/* 批量生成分镜图：Egress 预览确认框（规格 §5.4 / §14） */}
                  {aiContext === "batch" && (
                    <div className="egress-box">
                      <div className="egress-title">{t("🛡️ 出站预览（Egress Preview）")}</div>
                      <div className="kv"><span className="k">{t("目标")}</span><span className="v">{t("图像 Provider")}</span></div>
                      <div className="kv"><span className="k">{t("数据")}</span><span className="v">{t("每镜 prompt（逐镜发送，不含项目源码 / 密钥）")}</span></div>
                      <div className="kv"><span className="k">{t("模型")}</span><span className="v">{t("由路由选择（Provider Map 中 image_generation 能力最高优先）")}</span></div>
                    </div>
                  )}
                  <PlanPanel plan={plan} />
                </>
              )}
            </div>
            <div className="modal-foot">
              {!plan ? (
                <button className="btn primary" disabled={chatBusy} onClick={() => void runChat()}>
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

      {/* ---------- 多版本导出弹窗 ---------- */}
      {exportOpen && episodeId && (
        <ExportDialog episode={episodeId} onClose={() => setExportOpen(false)} />
      )}

      {/* ---------- 镜头详情编辑抽屉 ---------- */}
      {editShot && (
        <div className="modal-overlay" onClick={() => setEditShotId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>
                {t("🎞️ 镜头 {id}", { id: editShot.shotId })}
                {editShot.scene ? ` · ${editShot.scene}` : ""}
              </span>
              <button className="btn sm ghost" onClick={() => setEditShotId(null)}>×</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>{t("画面 prompt（图像 / 视频生成输入）")}</label>
                <textarea
                  value={editForm.prompt}
                  rows={5}
                  placeholder={t("描述画面主体、构图、光线、风格…")}
                  onChange={(e) => setEditForm((f) => ({ ...f, prompt: e.target.value }))}
                />
              </div>
              <div className="sb-edit-row">
                <div className="field">
                  <label>{t("景别 shotSize")}</label>
                  <select
                    value={SHOT_SIZE_OPTIONS.includes(editForm.shotSize) ? editForm.shotSize : "custom"}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEditForm((f) => ({ ...f, shotSize: v === "custom" ? "自定义" : v }));
                    }}
                  >
                    {SHOT_SIZE_OPTIONS.map((s) => (
                      <option key={s} value={s}>{t(s)}</option>
                    ))}
                    {!SHOT_SIZE_OPTIONS.includes(editForm.shotSize) && (
                      <option value="custom">{t("{size}（自定义）", { size: editForm.shotSize })}</option>
                    )}
                  </select>
                </div>
                <div className="field">
                  <label>{t("时长（秒）")}</label>
                  <input
                    type="number"
                    min={0.5}
                    step={0.5}
                    value={editForm.durationSec}
                    onChange={(e) => setEditForm((f) => ({ ...f, durationSec: e.target.value }))}
                  />
                </div>
              </div>
              <div className="field" style={{ marginBottom: 0 }}>
                <label>{t("台词（可选）")}</label>
                <textarea
                  value={editForm.dialogue}
                  rows={2}
                  placeholder={t("该镜头中的角色台词")}
                  onChange={(e) => setEditForm((f) => ({ ...f, dialogue: e.target.value }))}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn primary" disabled={saving} onClick={() => void applyDetail()}>
                {saving ? t("保存中…") : t("💾 保存到分镜表")}
              </button>
              <button className="btn" disabled={saving} onClick={() => setEditShotId(null)}>{t("取消")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- 视图局部样式（补充 global.css，深色一致） ---------------- */

const STORYBOARD_CSS = `
.sb-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.sb-toolbar select { min-width: 170px; }
.sb-selectbar {
  display: flex; align-items: center; gap: 12px;
  padding: 8px 12px; margin-bottom: 12px;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
}
.sb-select-hint { color: var(--muted); font-size: 12px; }
.btn.green-btn { color: var(--green); border-color: rgba(53, 208, 127, 0.45); }
.btn.green-btn:hover { background: rgba(53, 208, 127, 0.12); }
.sb-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; }
.sb-shot { padding: 10px; cursor: pointer; display: flex; flex-direction: column; gap: 8px; transition: border-color 0.12s ease; }
.sb-shot:hover { border-color: var(--blue); box-shadow: var(--glow-blue); }
.sb-shot.selected { border-color: rgba(255, 61, 154, 0.55); background: linear-gradient(180deg, var(--pink-soft), transparent 60%), var(--panel-2); }
.sb-shot-head { display: flex; align-items: center; gap: 7px; min-width: 0; }
.sb-shot-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.sb-shot-actions .btn { padding: 2px 8px; font-size: 11px; }
.sb-ctxmenu {
  position: fixed; z-index: 1000; min-width: 160px; padding: 4px;
  display: flex; flex-direction: column; gap: 2px;
  background: var(--panel-2); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.5);
}
.sb-ctxmenu button {
  text-align: left; background: none; border: none; cursor: pointer;
  color: var(--text-dim); font-size: 12.5px; padding: 7px 10px;
  border-radius: 4px; white-space: nowrap;
}
.sb-ctxmenu button:hover { background: rgba(255, 255, 255, 0.08); color: var(--text); }
.sb-ctxmenu button.danger { color: var(--red); }
.sb-ctxmenu button.danger:hover { background: rgba(255, 61, 90, 0.14); color: var(--red); }
.sb-ctxmenu button:disabled { opacity: 0.4; cursor: not-allowed; }
.sb-shot-id { font-family: var(--mono); font-size: 11.5px; font-weight: 600; color: var(--text); }
.sb-shot-img { width: 100%; aspect-ratio: 9 / 16; object-fit: cover; border-radius: var(--radius-sm); background: var(--bg-deep); display: block; max-height: 300px; }
.sb-shot-body { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.sb-shot-scene { display: flex; gap: 6px; font-size: 12px; min-width: 0; }
.sb-k { color: var(--muted); flex-shrink: 0; }
.sb-v { color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sb-shot-tags { display: flex; gap: 6px; flex-wrap: wrap; }
.sb-shot-action { color: var(--text-dim); font-size: 12px; margin: 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sb-shot-dialogue {
  font-size: 12px; color: var(--cyan);
  background: var(--bg-deep); border: 1px solid var(--border); border-left: 2px solid var(--cyan);
  border-radius: var(--radius-sm); padding: 5px 8px;
}
.sb-foot {
  display: flex; align-items: center; gap: 8px;
  margin: 16px 0 -4px; padding: 9px 0;
  border-top: 1px solid var(--border);
  font-size: 11.5px; color: var(--muted);
}
.sb-plan-desc { color: var(--text-dim); font-size: 12.5px; line-height: 1.6; }
.sb-err { color: var(--red); font-size: 12.5px; margin-top: 8px; }
.sb-plan-done { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 20px 0; text-align: center; color: var(--text-dim); }
.sb-plan-done .big { font-size: 34px; }
.egress-box {
  border: 1px solid rgba(255, 181, 71, 0.45);
  background: rgba(255, 181, 71, 0.08);
  border-radius: var(--radius-sm);
  padding: 10px 12px; margin-bottom: 12px;
}
.egress-title { font-size: 12px; font-weight: 600; color: var(--amber); margin-bottom: 6px; }
.egress-box .kv .k { min-width: 48px; }
.sb-edit-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
`;
