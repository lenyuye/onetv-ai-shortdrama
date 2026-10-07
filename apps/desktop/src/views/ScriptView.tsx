/**
 * 剧本视图 —— 分集选择 / AI 生成剧本（Agent 计划 → 批准执行）/ 场景卡片渲染 / 友好表单编辑 / 保存。
 *
 * 本文件是组合根：文档状态、加载/保存编排（persistScript / saveDoc）与 AI 生成流程留在主组件；
 * 子组件拆分在 components/script/（EpisodeBar / VersionBar / ScriptEditor / ScriptAiModal /
 * ScriptNewModal / PlanPanel），操作逻辑拆分在 hooks/（useScriptVersions / useScriptSceneOps）。
 * PlanPanel 仍从此处 re-export（StoryboardView 依赖该导入路径）。
 *
 * 复用 global.css 设计系统（.card / .btn / .tag / .modal 系列 / .empty-state），
 * 布局细节用本组件内 scoped <style> 补充（无法修改 global.css）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { EpisodeInfo } from "@onetv/shared-types";
import * as api from "../api";
import * as story from "../api-story";
import type { AgentPlanView } from "../api-story";
import { useApp } from "../store";
import { useT } from "../i18n";
import { useChatProviders } from "../hooks/useChatProviders";
import { useScriptSceneOps } from "../hooks/useScriptSceneOps";
import {
  attachVersions,
  newVersionId,
  useScriptVersions,
  withVersionBookkeeping,
  type ScriptDocWithVersions,
  type ScriptVersion,
} from "../hooks/useScriptVersions";
import { EpisodeBar } from "../components/script/EpisodeBar";
import { VersionBar } from "../components/script/VersionBar";
import { ScriptEditor } from "../components/script/ScriptEditor";
import { ScriptAiModal } from "../components/script/ScriptAiModal";
import type { AiModelRef } from "../components/script/ScriptAiModal";
import { ScriptNewModal } from "../components/script/ScriptNewModal";

/** 计划面板（summary + 步骤 + 风险 tag）：实现迁至 components/script/PlanPanel.tsx，此处保持原导入路径 */
export { PlanPanel } from "../components/script/PlanPanel";

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

  // 剧本库多版本：AI 生成结果登记（pending 快照用于判断生成结果是否已落盘）
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
    [toast, t]
  );

  useEffect(() => {
    setEditing(false);
    pendingAiRef.current = null;
    aiRetryRef.current = 0;
    episodeIdRef.current = episodeId;
    return refreshDoc(episodeId);
  }, [episodeId, refreshDoc]);

  // 模型选择器数据源：一次拉取 Provider 列表并缓存（只留已启用 + 含 chat 能力模型的 Provider）
  const { chatProviders } = useChatProviders();

  /* ---------- 保存编排（留在主组件；实体/版本操作复用同一条 docSave 路径） ---------- */

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

  /* ---------- 操作逻辑 hooks（编辑 / 场景实体 / 剧本库版本） ---------- */

  const {
    patchDoc,
    patchScene,
    patchDialogue,
    addDialogue,
    removeDialogue,
    addScene,
    removeScene,
    // v2.24.1 场景实体操作接线(右键菜单):复制/粘贴/克隆/立即删除
    copyScene,
    pasteScene,
    duplicateScene,
    removeSceneNow,
    sceneClipboard,
    ctxMenu,
    setCtxMenu,
  } = useScriptSceneOps({ doc, setDoc, persistScript });

  const {
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
  } = useScriptVersions({ doc, setDoc, episodeId, persistScript });

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
        <EpisodeBar
          episodes={episodes}
          episodeId={episodeId}
          onEpisodeChange={setEpisodeId}
          hasScript={hasScript}
          editing={editing}
          saving={saving}
          loading={loading}
          onOpenAi={openAi}
          onToggleEditing={() => setEditing((v) => !v)}
          onSave={() => void saveDoc()}
        />
      </div>

      {/* ---------- 剧本库：多版本管理（副标题下方、场景列表上方） ---------- */}
      {!loading && doc && (
        <VersionBar
          versions={libVersions}
          activeId={libActiveId}
          saving={saving}
          onUpload={() => void uploadScriptVersion()}
          onNew={openNewScript}
          onUse={(id) => void useVersion(id)}
          onDuplicate={(id) => void duplicateVersion(id)}
          onRename={(id, t2) => void renameVersion(id, t2)}
          onDelete={(id) => void deleteVersion(id)}
        />
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
        <ScriptEditor
          doc={doc}
          editing={editing}
          onPatchDoc={patchDoc}
          onPatchScene={patchScene}
          onPatchDialogue={patchDialogue}
          onAddDialogue={addDialogue}
          onRemoveDialogue={removeDialogue}
          onAddScene={addScene}
          onRemoveScene={removeScene}
          sceneOps={{
            copyScene,
            pasteScene,
            duplicateScene,
            removeSceneNow,
            hasClipboard: !!sceneClipboard,
            ctxMenu,
            setCtxMenu,
          }}
        />
      )}

      {/* ---------- AI 生成弹窗 ---------- */}
      {aiOpen && (
        <ScriptAiModal
          epLabel={epLabel}
          prompt={prompt}
          onPromptChange={setPrompt}
          plan={plan}
          autoExecuted={autoExecuted}
          chatBusy={chatBusy}
          approveBusy={approveBusy}
          aiErr={aiErr}
          aiModel={aiModel}
          onAiModelChange={setAiModel}
          chatProviders={chatProviders}
          onClose={closeAi}
          onRun={() => void runChat()}
          onApprove={() => void approvePlan()}
        />
      )}

      {/* ---------- 新建剧本弹窗（粘贴内容） ---------- */}
      {newOpen && (
        <ScriptNewModal
          epLabel={epLabel}
          title={newTitle}
          text={newText}
          saving={saving}
          onTitleChange={setNewTitle}
          onTextChange={setNewText}
          onSubmit={() => void submitNewScript()}
          onClose={closeNewScript}
        />
      )}
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
