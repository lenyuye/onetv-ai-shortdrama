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
import { PlanPanel } from "./ScriptView";

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
  const [plan, setPlan] = useState<AgentPlanView | null>(null);
  const [autoExecuted, setAutoExecuted] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [approveBusy, setApproveBusy] = useState(false);
  const [aiErr, setAiErr] = useState("");

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
          toast(`加载分镜失败：${story.errMsg(e)}`, "err");
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
        toast(`保存分镜表失败：${story.errMsg(e)}`, "err");
      } finally {
        setSaving(false);
      }
    },
    [episodeId, toast]
  );

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
      toast("请先勾选要批准的镜头", "warn");
      return;
    }
    if (!doc) return;
    const next: StoryboardDocument = {
      ...doc,
      shots: doc.shots.map((s) => (selectedIds.has(s.shotId) ? { ...s, status: "approved" } : s)),
    };
    await saveDoc(next, `已批准 ${selectedIds.size} 个镜头（人工 QC）`);
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
    await saveDoc(next, "镜头已更新并保存分镜表");
  };

  /* ---------- Agent：拆分镜头 / 批量生成分镜图 ---------- */

  const openAi = (ctx: "split" | "batch" | "compose" | "export") => {
    if ((ctx === "batch" || ctx === "compose" || ctx === "export") && shots.length === 0) {
      toast("分镜表为空，请先「从剧本拆分镜头」", "warn");
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
      // 生成任务由后端异步执行，稍后自动刷新；也可手动刷新
      const ep = episodeId;
      window.setTimeout(() => {
        if (ep === episodeId) void refresh(ep);
      }, 1500);
    } catch (e) {
      toast(`批准失败：${story.errMsg(e)}`, "err");
    } finally {
      setApproveBusy(false);
    }
  };

  /** 分镜图 URL：status=ready 且 outputAssetId 能映射到资产路径 */
  const shotImage = (shot: Shot): string | null => {
    if (shot.status !== "ready" || !shot.outputAssetId) return null;
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

  const readyCount = useMemo(() => shots.filter((s) => s.status === "ready").length, [shots]);
  const approvedCount = useMemo(() => shots.filter((s) => s.status === "approved").length, [shots]);
  const editShot = shots.find((s) => s.shotId === editShotId) ?? null;

  /* ---------- 守卫空状态 ---------- */

  if (!project) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🖼️</div>
        <h2>尚未打开项目</h2>
        <p>分镜按分集组织，请先在「工作区」创建或打开一个项目</p>
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
        <p>分镜挂在分集下，请先在「项目」页新增一集</p>
        <button className="btn primary" onClick={() => setView("projects")}>前往项目页</button>
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
          <h1>🖼️ 分镜</h1>
          <div className="desc">
            {project.project.title}
            {epTitle ? ` · 第 ${epNo} 集 · ${epTitle}` : ""}
            {shots.length > 0
              ? ` · ${shots.length} 个镜头 · 已出图 ${readyCount} · 已批准 ${approvedCount}`
              : ""}
          </div>
        </div>
        <div className="sb-toolbar">
          <select value={episodeId} onChange={(e) => setEpisodeId(e.target.value)} aria-label="选择分集">
            {episodes.map((ep) => (
              <option key={ep.id} value={ep.id}>
                第 {ep.number} 集 · {ep.title}
              </option>
            ))}
          </select>
          <button className="btn" onClick={() => openAi("split")}>🎬 从剧本拆分镜头</button>
          <button className="btn primary" onClick={() => openAi("batch")}>✨ 批量生成分镜图</button>
          <button className="btn blue" onClick={() => openAi("compose")}>🎞️ 合成成片</button>
          <button className="btn" onClick={() => openAi("export")}>📤 导出竖版</button>
          <button className="btn ghost" disabled={loading} onClick={() => refresh(episodeId)}>⟳ 刷新</button>
        </div>
      </div>

      {loading ? (
        <div className="empty-state" style={{ padding: "80px 20px" }}>
          <div className="big">⏳</div>
          <p>分镜加载中…</p>
        </div>
      ) : shots.length === 0 ? (
        !hasScript ? (
          /* ---------- 无剧本：引导去剧本页 ---------- */
          <div className="empty-state" style={{ padding: "90px 20px" }}>
            <div className="big">📝</div>
            <h2>这一集还没有剧本</h2>
            <p>分镜由剧本拆分而来，请先到「剧本」页完成本集剧本</p>
            <button className="btn primary" onClick={() => setView("script")}>前往剧本页</button>
          </div>
        ) : (
          /* ---------- 有剧本无分镜：引导拆分 ---------- */
          <div className="empty-state" style={{ padding: "90px 20px" }}>
            <div className="big">🎬</div>
            <h2>还没有分镜</h2>
            <p>点击「从剧本拆分镜头」，Agent 会按场景与台词生成分镜表</p>
            <button className="btn primary" onClick={() => openAi("split")}>🎬 从剧本拆分镜头</button>
          </div>
        )
      ) : (
        <>
          {/* ---------- 批量操作条 ---------- */}
          <div className="sb-selectbar">
            <label className="checkbox-row">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              全选（{shots.length}）
            </label>
            <span className="sb-select-hint">已选 {selectedIds.size} 个</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm green-btn" disabled={selectedIds.size === 0 || saving} onClick={() => void approveSelected()}>
              ✓ 批准选中镜头（{selectedIds.size}）
            </button>
            <button className="btn sm blue" disabled={saving} onClick={() => doc && void saveDoc(doc, "分镜表已保存")}>
              💾 保存分镜表
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
                  title="点击编辑 prompt / 景别 / 时长 / 台词"
                >
                  <div className="sb-shot-head">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(shot.shotId)}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => toggleShot(shot.shotId)}
                      aria-label={`选择 ${shot.shotId}`}
                    />
                    <span className="sb-shot-id">{shot.shotId}</span>
                    <span className="tag blue">{shot.shotSize}</span>
                    <span style={{ flex: 1 }} />
                    <span className={`tag ${status.cls}`}>{status.label}</span>
                  </div>

                  {img && (
                    <img
                      className="sb-shot-img"
                      src={img}
                      alt={`${shot.shotId} 分镜图`}
                      loading="lazy"
                      onError={() => markImgBroken(shot)}
                    />
                  )}

                  <div className="sb-shot-body">
                    <div className="sb-shot-scene">
                      <span className="sb-k">场景</span>
                      <span className="sb-v">{shot.scene || "—"}</span>
                    </div>
                    <div className="sb-shot-tags">
                      <span className="tag">🎥 {shot.camera.movement || "固定机位"}</span>
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
            <span>分镜图由图像 Provider 生成；Mock Provider 可离线演示 · 点击镜头卡编辑 prompt / 景别 / 时长 / 台词</span>
          </div>
        </>
      )}

      {/* ---------- Agent 计划弹窗（拆分 / 批量生成共用） ---------- */}
      {aiOpen && (
        <div className="modal-overlay" onClick={closeAi}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>
                {aiContext === "split" ? "🎬 从剧本拆分镜头" : "✨ 批量生成分镜图"}
                {epTitle ? ` · ${epTitle}` : ""}
              </span>
              <button className="btn sm ghost" onClick={closeAi}>×</button>
            </div>
            <div className="modal-body">
              {!plan ? (
                <>
                  <div className="field">
                    {aiContext === "split" ? (
                      <>
                        <div className="sb-plan-desc">
                          Agent 将读取当前集剧本，按场景与台词拆分为镜头表（本地工具，不出站）。
                        </div>
                      </>
                    ) : (
                      <div className="sb-plan-desc">
                        将为 {shots.length} 个镜头逐个生成分镜图并写回分镜表（status → ready）。
                      </div>
                    )}
                  </div>
                  {aiErr && <div className="sb-err">⚠️ {aiErr}</div>}
                </>
              ) : autoExecuted ? (
                <div className="sb-plan-done">
                  <div className="big">✅</div>
                  <p>低风险任务已自动执行，无需批准。稍后刷新即可查看结果。</p>
                  <p className="hint">{plan.summary}</p>
                </div>
              ) : (
                <>
                  {/* 批量生成分镜图：Egress 预览确认框（规格 §5.4 / §14） */}
                  {aiContext === "batch" && (
                    <div className="egress-box">
                      <div className="egress-title">🛡️ 出站预览（Egress Preview）</div>
                      <div className="kv"><span className="k">目标</span><span className="v">图像 Provider</span></div>
                      <div className="kv"><span className="k">数据</span><span className="v">每镜 prompt（逐镜发送，不含项目源码 / 密钥）</span></div>
                      <div className="kv"><span className="k">模型</span><span className="v">由路由选择（Provider Map 中 image_generation 能力最高优先）</span></div>
                    </div>
                  )}
                  <PlanPanel plan={plan} />
                </>
              )}
            </div>
            <div className="modal-foot">
              {!plan ? (
                <button className="btn primary" disabled={chatBusy} onClick={() => void runChat()}>
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

      {/* ---------- 镜头详情编辑抽屉 ---------- */}
      {editShot && (
        <div className="modal-overlay" onClick={() => setEditShotId(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>
                🎞️ 镜头 {editShot.shotId}
                {editShot.scene ? ` · ${editShot.scene}` : ""}
              </span>
              <button className="btn sm ghost" onClick={() => setEditShotId(null)}>×</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>画面 prompt（图像 / 视频生成输入）</label>
                <textarea
                  value={editForm.prompt}
                  rows={5}
                  placeholder="描述画面主体、构图、光线、风格…"
                  onChange={(e) => setEditForm((f) => ({ ...f, prompt: e.target.value }))}
                />
              </div>
              <div className="sb-edit-row">
                <div className="field">
                  <label>景别 shotSize</label>
                  <select
                    value={SHOT_SIZE_OPTIONS.includes(editForm.shotSize) ? editForm.shotSize : "custom"}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEditForm((f) => ({ ...f, shotSize: v === "custom" ? "自定义" : v }));
                    }}
                  >
                    {SHOT_SIZE_OPTIONS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                    {!SHOT_SIZE_OPTIONS.includes(editForm.shotSize) && (
                      <option value="custom">{editForm.shotSize}（自定义）</option>
                    )}
                  </select>
                </div>
                <div className="field">
                  <label>时长（秒）</label>
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
                <label>台词（可选）</label>
                <textarea
                  value={editForm.dialogue}
                  rows={2}
                  placeholder="该镜头中的角色台词"
                  onChange={(e) => setEditForm((f) => ({ ...f, dialogue: e.target.value }))}
                />
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn primary" disabled={saving} onClick={() => void applyDetail()}>
                {saving ? "保存中…" : "💾 保存到分镜表"}
              </button>
              <button className="btn" disabled={saving} onClick={() => setEditShotId(null)}>取消</button>
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
