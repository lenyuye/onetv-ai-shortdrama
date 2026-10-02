/**
 * 剧本视图 —— 分集选择 / AI 生成剧本（Agent 计划 → 批准执行）/ 场景卡片渲染 / 友好表单编辑 / 保存。
 *
 * 复用 global.css 设计系统（.card / .btn / .tag / .modal 系列 / .empty-state），
 * 布局细节用本组件内 scoped <style> 补充（无法修改 global.css）。
 */
import { useCallback, useEffect, useState } from "react";
import type { EpisodeInfo, ScriptDocument } from "@onetv/shared-types";
import * as api from "../api";
import * as story from "../api-story";
import type { AgentPlanView } from "../api-story";
import { useApp } from "../store";

export default function ScriptView() {
  const { project, setView, toast } = useApp();
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [episodesLoaded, setEpisodesLoaded] = useState(false);
  const [episodeId, setEpisodeId] = useState("");

  const [doc, setDoc] = useState<ScriptDocument | null>(null);
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
      story
        .docGet(ep, "script")
        .then((raw) => {
          if (!cancelled) setDoc(story.normalizeScript(raw, ep));
        })
        .catch((e) => {
          if (cancelled) return;
          setDoc(story.emptyScriptDocument(ep));
          toast(`加载剧本失败：${story.errMsg(e)}`, "err");
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
    return refreshDoc(episodeId);
  }, [episodeId, refreshDoc]);

  if (!project) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">📝</div>
        <h2>尚未打开项目</h2>
        <p>剧本按分集组织，请先在「工作区」创建或打开一个项目</p>
        <button className="btn primary" onClick={() => setView("home")}>前往工作区</button>
      </div>
    );
  }

  if (!episodesLoaded) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">⏳</div>
        <p>分集加载中…</p>
      </div>
    );
  }

  if (episodes.length === 0) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🎞️</div>
        <h2>还没有分集</h2>
        <p>剧本挂在分集下，请先在「项目」页新增一集</p>
        <button className="btn primary" onClick={() => setView("projects")}>前往项目页</button>
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
    if (!window.confirm("删除该场景（含全部台词）？保存后生效。")) return;
    setDoc((d) => (d ? { ...d, scenes: d.scenes.filter((_, i) => i !== si) } : d));
  };

  /* ---------- 保存 ---------- */

  const saveDoc = async () => {
    if (!episodeId || !doc) return;
    setSaving(true);
    try {
      await story.docSave(episodeId, "script", { ...doc, updatedAt: new Date().toISOString() });
      toast("剧本已保存", "ok");
    } catch (e) {
      toast(`保存剧本失败：${story.errMsg(e)}`, "err");
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
      const res = await story.agentChat(`生成剧本：${text}`);
      setPlan(res.plan);
      setAutoExecuted(res.autoExecuted);
    } catch (e) {
      setAiErr(story.errMsg(e));
    } finally {
      setChatBusy(false);
    }
  };

  const approvePlan = async () => {
    if (!plan?.planId) return;
    setApproveBusy(true);
    try {
      await story.agentApprove(plan.planId);
      toast("任务已创建，可在任务页查看", "ok");
      setAiOpen(false);
      setPlan(null);
      // 生成任务由后端异步执行，稍后自动刷新一次；也可手动刷新
      const ep = episodeId;
      window.setTimeout(() => {
        if (ep === episodeId) void refreshDoc(ep);
      }, 1500);
    } catch (e) {
      toast(`批准失败：${story.errMsg(e)}`, "err");
    } finally {
      setApproveBusy(false);
    }
  };

  const epTitle = episodes.find((ep) => ep.id === episodeId)?.title ?? "";
  const hasScript = !!doc && doc.scenes.length > 0;

  return (
    <div className="page">
      <style>{SCRIPT_CSS}</style>

      <div className="page-header">
        <div>
          <h1>📝 剧本</h1>
          <div className="desc">
            {project.project.title}
            {epTitle ? ` · 第 ${episodes.find((ep) => ep.id === episodeId)?.number ?? ""} 集 · ${epTitle}` : ""}
            {hasScript ? ` · ${doc?.scenes.length ?? 0} 个场景` : ""}
          </div>
        </div>
        <div className="script-toolbar">
          <select
            value={episodeId}
            onChange={(e) => setEpisodeId(e.target.value)}
            aria-label="选择分集"
          >
            {episodes.map((ep) => (
              <option key={ep.id} value={ep.id}>
                第 {ep.number} 集 · {ep.title}
              </option>
            ))}
          </select>
          <button className="btn primary" onClick={openAi}>✨ AI 生成剧本</button>
          {hasScript && (
            <button className={`btn ${editing ? "" : "ghost"}`} onClick={() => setEditing((v) => !v)}>
              {editing ? "✓ 完成编辑" : "✏️ 编辑"}
            </button>
          )}
          <button className="btn blue" disabled={!hasScript || saving || loading} onClick={() => void saveDoc()}>
            {saving ? "保存中…" : "💾 保存剧本"}
          </button>
        </div>
      </div>

      {loading ? (
        <div className="empty-state" style={{ padding: "80px 20px" }}>
          <div className="big">⏳</div>
          <p>剧本加载中…</p>
        </div>
      ) : !hasScript ? (
        /* ---------- 空状态：引导 AI 生成 ---------- */
        <div className="empty-state" style={{ padding: "90px 20px" }}>
          <div className="big">📝</div>
          <h2>这一集还没有剧本</h2>
          <p>用一句话描述你的想法，AI 会先生成执行计划，批准后再开始创作</p>
          <button className="btn primary" onClick={openAi}>✨ AI 生成剧本</button>
        </div>
      ) : (
        /* ---------- 剧本正文 ---------- */
        <div className="script-body">
          <div className="card script-head-card">
            {editing ? (
              <>
                <div className="field">
                  <label>剧名</label>
                  <input type="text" value={doc?.title ?? ""} onChange={(e) => patchDoc({ title: e.target.value })} />
                </div>
                <div className="field" style={{ marginBottom: 0 }}>
                  <label>一句话简介（Logline）</label>
                  <textarea
                    value={doc?.logline ?? ""}
                    rows={2}
                    placeholder="一句话概括这一集的故事"
                    onChange={(e) => patchDoc({ logline: e.target.value })}
                  />
                </div>
              </>
            ) : (
              <>
                <h2 className="script-title">{doc?.title || "未命名剧本"}</h2>
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
                <span className="tag">{scene.dialogues.length} 句台词</span>
                {editing && (
                  <button className="btn sm danger" onClick={() => removeScene(si)}>🗑 删除场景</button>
                )}
              </div>

              {editing ? (
                <div className="field">
                  <label>场景梗概</label>
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
                            placeholder="角色名"
                            onChange={(e) => patchDialogue(si, di, { characterName: e.target.value })}
                          />
                          <input
                            type="text"
                            className="dlg-paren-input"
                            value={dl.parenthetical ?? ""}
                            placeholder="语气提示（可选）"
                            onChange={(e) => patchDialogue(si, di, { parenthetical: e.target.value || undefined })}
                          />
                          <textarea
                            className="dlg-line-input"
                            value={dl.line}
                            rows={2}
                            placeholder="台词内容"
                            onChange={(e) => patchDialogue(si, di, { line: e.target.value })}
                          />
                          <button className="btn sm danger" onClick={() => removeDialogue(si, di)}>删除</button>
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
                <button className="btn sm" onClick={() => addDialogue(si)}>+ 添加台词</button>
              )}
            </div>
          ))}

          {editing && (
            <button className="btn scene-add" onClick={addScene}>+ 新增场景</button>
          )}

          <div className="script-foot">
            <span>🔒</span>
            <span>剧本保存在项目 episodes/ 内 · 编辑后记得「保存剧本」</span>
          </div>
        </div>
      )}

      {/* ---------- AI 生成弹窗 ---------- */}
      {aiOpen && (
        <div className="modal-overlay" onClick={closeAi}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>✨ AI 生成剧本{epTitle ? ` · ${epTitle}` : ""}</span>
              <button className="btn sm ghost" onClick={closeAi}>×</button>
            </div>
            <div className="modal-body">
              {!plan ? (
                <>
                  <div className="field">
                    <label>一句话需求</label>
                    <textarea
                      value={prompt}
                      rows={4}
                      autoFocus
                      placeholder="一句话需求：都市情感短剧，女主是咖啡店老板…"
                      onChange={(e) => setPrompt(e.target.value)}
                    />
                    <div className="sub">
                      Agent 会先给出执行计划；剧本生成将调用 Chat Provider（可能联网出站）
                    </div>
                  </div>
                  {aiErr && <div className="script-err">⚠️ {aiErr}</div>}
                </>
              ) : autoExecuted ? (
                <div className="plan-done">
                  <div className="big">✅</div>
                  <p>低风险任务已自动执行，无需批准。稍后刷新即可查看结果。</p>
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
                  {chatBusy ? "规划中…" : "生成执行计划"}
                </button>
              ) : autoExecuted ? (
                <button className="btn primary" onClick={closeAi}>好的</button>
              ) : (
                <button className="btn primary" disabled={approveBusy} onClick={() => void approvePlan()}>
                  {approveBusy ? "执行中…" : "批准执行"}
                </button>
              )}
              <button className="btn" disabled={chatBusy || approveBusy} onClick={closeAi}>
                {plan && !autoExecuted ? "拒绝" : "取消"}
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
  const riskClass = plan.estimated.risk === "high" ? "red" : plan.estimated.risk === "medium" ? "amber" : "green";
  const riskLabel =
    plan.estimated.risk === "high" ? "高风险" : plan.estimated.risk === "medium" ? "中风险" : "低风险";
  return (
    <div className="plan-panel">
      <div className="plan-summary">{plan.summary || "（无摘要）"}</div>
      <div className="plan-tags">
        <span className="tag blue">{plan.intent}</span>
        <span className={`tag ${riskClass}`}>{riskLabel}</span>
        <span className="tag">任务 {plan.estimated.jobs}</span>
        <span className="tag">远程调用 {plan.estimated.remoteCalls}</span>
      </div>
      <div className="plan-steps">
        {plan.steps.map((s, i) => (
          <div className="plan-step" key={s.id || i}>
            <span className="plan-step-idx">{i + 1}</span>
            <span className="tag mono plan-tool">{s.tool}</span>
            <span className="plan-desc">{s.description}</span>
            <span className={`tag ${s.approval === "required" ? "pink" : ""}`}>
              {s.approval === "required" ? "需批准" : "自动"}
            </span>
          </div>
        ))}
      </div>
      <div className="plan-note">批准后将创建任务并在后台执行，可在「任务」页查看进度。</div>
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
