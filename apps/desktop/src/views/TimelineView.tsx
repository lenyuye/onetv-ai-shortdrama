/**
 * 时间线视图(项19)—— 多轨时间线编辑器组合根。
 * 顶栏:分集选择 / 从分镜生成 / 清空 / 保存 / 渲染成片 / 缩放;主体:标尺 + 三泳道 + 右侧检查器。
 * 编辑走纯鼠标事件(拖拽移动 0.1s 吸附、左右缘裁剪、Delete 删除);编辑后 800ms 防抖 timeline_save,
 * 分集切换竞态用 loadedEpRef 守卫(同 useCanvasDoc)。渲染:timeline_render → toast 带 jobId + 轮询 jobList 至终态。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EpisodeInfo } from "@onetv/shared-types";
import * as api from "../api";
import { assetList, type AssetRecord } from "../api-assets";
import {
  emptyTimelineDoc,
  normalizeTimeline,
  timelineGet,
  timelineRender,
  timelineSave,
  timelineFromShots,
  type TimelineClip,
  type TimelineDoc,
  type TimelineTrackType,
} from "../api-timeline";
import { docGet, errMsg, normalizeStoryboard } from "../api-story";
import { jobList } from "../api-providers";
import { useApp } from "../store";
import { useT } from "../i18n";
import ConfirmDialog from "../components/ConfirmDialog";
import Ruler from "../components/timeline/Ruler";
import TrackLane from "../components/timeline/TrackLane";
import SubtitleForm from "../components/timeline/SubtitleForm";
import ClipInspector from "../components/timeline/ClipInspector";
import AssetPickerModal from "../components/timeline/AssetPickerModal";
import ExportDialog from "../components/export/ExportDialog";
import { TL_CSS } from "../components/timeline/timeline-css";
import {
  MIN_CLIP_DURATION,
  TRAIL_SECONDS,
  docClipCount,
  docTotalSec,
  findClip,
  fmtTime,
  snap01,
  trackEndSec,
} from "../components/timeline/timeline-model";

/** 泳道展示元信息(顺序即 TRACK_ORDER;label 走 i18n,不参与持久化比较) */
const TRACK_META: { type: TimelineTrackType; icon: string; label: string }[] = [
  { type: "video", icon: "🎬", label: "视频" },
  { type: "audio", icon: "🎵", label: "音频" },
  { type: "subtitle", icon: "💬", label: "字幕" },
];

/** 渲染任务轮询间隔(ms) */
const RENDER_POLL_MS = 1500;

export default function TimelineView() {
  const t = useT();
  const { project, setView, toast } = useApp();

  /* ---------- 分集状态(与 StoryboardView 同模式) ---------- */
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [episodesLoaded, setEpisodesLoaded] = useState(false);
  const [episodeId, setEpisodeId] = useState("");

  /* ---------- 时间线文档与编辑态 ---------- */
  const [doc, setDoc] = useState<TimelineDoc | null>(null);
  const [loading, setLoading] = useState(false);
  const [pxPerSec, setPxPerSec] = useState(60);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [subFormOpen, setSubFormOpen] = useState(false);
  const [picker, setPicker] = useState<null | "media" | "audio">(null);
  // 多版本导出弹窗
  const [exportOpen, setExportOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | { title: string; message: string; onConfirm: () => void }>(null);
  const [generating, setGenerating] = useState(false);
  const [savingNow, setSavingNow] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [renderJob, setRenderJob] = useState<null | { jobId: string; progress: number }>(null);

  /* ---------- 非渲染路径镜像 refs ---------- */
  const docRef = useRef(doc);
  docRef.current = doc;
  const epRef = useRef(episodeId);
  epRef.current = episodeId;
  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  /** 当前 doc 实际对应的分集(空串 = 数据不可信,禁止保存,防串写) */
  const loadedEpRef = useRef("");
  const saveTimerRef = useRef<number | null>(null);
  const pollRef = useRef<number | null>(null);

  /* ---------- 资产列表(clip → 缩略图/试听/文件名) ---------- */
  const [assets, setAssets] = useState<AssetRecord[]>([]);
  const assetMap = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    assetList()
      .then((list) => {
        if (!cancelled) setAssets(list);
      })
      .catch(() => {}); // 拉取失败仅影响缩略图/文件名展示,不阻塞时间线
    return () => {
      cancelled = true;
    };
  }, [project]);

  /* ---------- 分集列表(与 StoryboardView 同模式) ---------- */

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

  /* ---------- 保存(手动 + 800ms 防抖自动) ---------- */

  const saveNow = useCallback(
    async (manual: boolean) => {
      const ep = epRef.current;
      const d = docRef.current;
      if (!ep || !d) return;
      // 竞态守卫:分集切换期间(refs 里还是旧分集数据)禁止保存,防止串写
      if (loadedEpRef.current !== ep) return;
      if (manual) setSavingNow(true);
      try {
        await timelineSave(ep, d);
        if (manual) toast(t("时间线已保存"), "ok"); // 自动保存静默
      } catch (e) {
        toast(t("保存时间线失败：{msg}", { msg: errMsg(e) }), "err");
      } finally {
        if (manual) setSavingNow(false);
      }
    },
    [toast]
  );

  const scheduleSave = useCallback(() => {
    if (!epRef.current) return;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      void saveNow(false);
    }, 800);
  }, [saveNow]);

  /** 立即落盘指定文档(从分镜生成 / 清空 / 新建空白用,保存动作本身静默) */
  const persistDoc = useCallback(
    async (next: TimelineDoc) => {
      setDoc(next);
      setSelectedId(null);
      setSubFormOpen(false);
      const ep = epRef.current;
      if (!ep) return;
      try {
        await timelineSave(ep, next);
      } catch (e) {
        toast(t("保存时间线失败：{msg}", { msg: errMsg(e) }), "err");
      }
    },
    [toast]
  );

  /* ---------- 渲染任务轮询(参考 NodeChatPanel) ---------- */

  const stopRenderPolling = useCallback(() => {
    if (pollRef.current) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const startRenderPolling = useCallback(
    (jobId: string) => {
      stopRenderPolling();
      setRenderJob({ jobId, progress: 0 });
      pollRef.current = window.setInterval(async () => {
        try {
          const jobs = await jobList(200);
          const j = jobs.find((x) => x.id === jobId);
          if (!j) return;
          if (j.state === "SUCCEEDED") {
            stopRenderPolling();
            setRenderJob(null);
            toast(t("时间线渲染完成"), "ok");
          } else if (j.state === "FAILED" || j.state === "CANCELED") {
            stopRenderPolling();
            setRenderJob(null);
            toast(t("时间线渲染失败：{msg}", { msg: j.error || t("任务失败") }), "err");
          } else {
            setRenderJob({ jobId, progress: Math.round((j.progress ?? 0) * 100) });
          }
        } catch {
          /* 轮询失败下轮重试 */
        }
      }, RENDER_POLL_MS);
    },
    [stopRenderPolling, toast]
  );

  /* ---------- 分集加载(timeline_get;切换时冲刷未落盘改动) ---------- */

  useEffect(() => {
    if (!episodeId) return;
    const ep = episodeId;
    let cancelled = false;
    setLoading(true);
    setDoc(null);
    setSelectedId(null);
    setSubFormOpen(false);
    stopRenderPolling();
    loadedEpRef.current = ""; // 旧分集数据即将失效,保存守卫进入拦截状态
    timelineGet(ep)
      .then((res) => {
        if (cancelled) return;
        // exists=false 或 schemaVersion ≠ 2.0 → null(空态引导卡)
        setDoc(res?.exists ? normalizeTimeline(res.timeline) : null);
        loadedEpRef.current = ep;
      })
      .catch((e) => {
        if (cancelled) return;
        setDoc(null);
        loadedEpRef.current = ep;
        toast(t("加载时间线失败：{msg}", { msg: errMsg(e) }), "err");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      stopRenderPolling();
      loadedEpRef.current = "";
      // 冲刷未落盘的防抖保存(pending doc 属于旧分集 ep,显式指定目标防串写)
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        const pending = docRef.current;
        if (pending) void timelineSave(ep, pending).catch(() => {});
      }
    };
  }, [episodeId, stopRenderPolling, toast]);

  /* ---------- 编辑操作 ---------- */

  const updateClip = useCallback(
    (clipId: string, patch: Partial<TimelineClip>, opts?: { dragging?: boolean }) => {
      setDoc((prev) =>
        prev
          ? {
              ...prev,
              tracks: prev.tracks.map((tr) => ({
                ...tr,
                clips: tr.clips.map((c) => (c.id === clipId ? { ...c, ...patch } : c)),
              })),
            }
          : prev
      );
      if (!opts?.dragging) scheduleSave(); // 拖拽中不保存,松手后统一防抖保存
    },
    [scheduleSave]
  );

  const deleteClip = useCallback(
    (clipId: string) => {
      setDoc((prev) =>
        prev
          ? {
              ...prev,
              tracks: prev.tracks.map((tr) => ({ ...tr, clips: tr.clips.filter((c) => c.id !== clipId) })),
            }
          : prev
      );
      setSelectedId((sel) => (sel === clipId ? null : sel));
      scheduleSave();
    },
    [scheduleSave]
  );

  const addClipToTrack = useCallback(
    (type: TimelineTrackType, clip: TimelineClip) => {
      setDoc((prev) =>
        prev
          ? {
              ...prev,
              tracks: prev.tracks.map((tr) => (tr.type === type ? { ...tr, clips: [...tr.clips, clip] } : tr)),
            }
          : prev
      );
      setSelectedId(clip.id);
      scheduleSave();
    },
    [scheduleSave]
  );

  /** 资产选择器回调:video 轨列 images/videos(探测时长),audio 轨列 audio */
  const handlePickAsset = (asset: AssetRecord, durationSec: number) => {
    setPicker(null);
    if (!doc) return;
    const type: TimelineTrackType = asset.kind === "audio" ? "audio" : "video";
    const track = doc.tracks.find((tr) => tr.type === type);
    if (!track) return;
    addClipToTrack(type, {
      id: crypto.randomUUID(),
      assetId: asset.id,
      start: snap01(trackEndSec(track)),
      duration: Math.max(MIN_CLIP_DURATION, snap01(durationSec)),
      volume: 1,
    });
  };

  const handleAddSubtitle = (text: string, start: number, duration: number) => {
    if (!doc) return;
    addClipToTrack("subtitle", { id: crypto.randomUUID(), text, start, duration });
    setSubFormOpen(false);
  };

  /* ---------- Delete 键删除选中片段(输入控件聚焦时豁免) ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tgt = e.target as HTMLElement | null;
      const editing =
        !!tgt &&
        (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.tagName === "SELECT" || tgt.isContentEditable);
      if (editing) return;
      if ((e.key === "Delete" || e.key === "Backspace") && selectedRef.current) {
        e.preventDefault();
        deleteClip(selectedRef.current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteClip]);

  /* ---------- 顶栏动作 ---------- */

  /** 从分镜生成时间线:已有内容时先确认覆盖;生成后立即落盘 */
  const generateFromShots = async (force = false) => {
    if (!episodeId || generating) return;
    if (!force && doc && docClipCount(doc) > 0) {
      setConfirm({
        title: t("覆盖当前时间线？"),
        message: t("当前时间线已有 {n} 个片段，从分镜重新生成将替换全部内容。", { n: docClipCount(doc) }),
        onConfirm: () => void generateFromShots(true),
      });
      return;
    }
    setGenerating(true);
    try {
      const raw = await docGet(episodeId, "storyboard");
      const sb = normalizeStoryboard(raw, episodeId);
      if (!sb.shots.some((s) => !!s.outputAssetId)) {
        toast(t("分镜表里还没有已出图镜头，请先到「分镜」页生成分镜图"), "warn");
        return;
      }
      const next = timelineFromShots(sb.shots);
      await persistDoc(next);
      toast(t("已从分镜生成时间线（{n} 个片段）", { n: docClipCount(next) }), "ok");
    } catch (e) {
      toast(t("生成时间线失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setGenerating(false);
    }
  };

  const createBlank = async () => {
    await persistDoc(emptyTimelineDoc());
    toast(t("已新建空白时间线"), "ok");
  };

  const clearTimeline = () => {
    if (!doc) return;
    const n = docClipCount(doc);
    setConfirm({
      title: t("清空时间线？"),
      message: t("将删除当前分集时间线上的全部 {n} 个片段，且不可撤销。", { n }),
      onConfirm: () => void persistDoc(emptyTimelineDoc()),
    });
  };

  const saveManual = async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    await saveNow(true);
  };

  const renderFilm = async () => {
    if (!episodeId || rendering || !doc) return;
    if (docClipCount(doc) === 0) {
      toast(t("时间线为空，请先添加片段"), "warn");
      return;
    }
    // 冲刷未落盘的防抖保存,保证渲染读到最新时间线
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
      await saveNow(false);
    }
    setRendering(true);
    try {
      const r = await timelineRender(episodeId);
      toast(t("渲染任务已创建：{jobId}，请到「任务」页查看进度", { jobId: r.jobId }), "ok");
      startRenderPolling(r.jobId);
    } catch (e) {
      toast(t("创建渲染任务失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setRendering(false);
    }
  };

  /* ---------- 派生 ---------- */

  const totalSec = doc ? docTotalSec(doc) : 0;
  const contentWidth = Math.max(600, Math.ceil((totalSec + TRAIL_SECONDS) * pxPerSec));
  const sel = doc ? findClip(doc, selectedId) : null;
  const selClip = sel?.clip ?? null;
  const selKind = sel?.track.type ?? null;
  const selAsset = selClip?.assetId ? (assetMap.get(selClip.assetId) ?? null) : null;
  const subtitleTrack = doc?.tracks.find((tr) => tr.type === "subtitle") ?? null;
  const epNo = episodes.find((ep) => ep.id === episodeId)?.number ?? "";
  const epTitle = episodes.find((ep) => ep.id === episodeId)?.title ?? "";

  /* ---------- 无项目 / 无分集守卫(与其他创作页一致) ---------- */

  const guard = (icon: string, h2: string | null, p: string, action?: { label: string; go: "home" | "projects" }) => (
    <div className="empty-state" style={{ height: "100%" }}>
      <div className="big">{icon}</div>
      {h2 && <h2>{h2}</h2>}
      <p>{p}</p>
      {action && (
        <button className="btn primary" onClick={() => setView(action.go)}>{t(action.label)}</button>
      )}
    </div>
  );

  if (!project) {
    return guard("🎞️", t("尚未打开项目"), t("时间线按分集组织，请先在「工作区」创建或打开一个项目"), { label: "前往工作区", go: "home" });
  }

  if (!episodesLoaded) {
    return guard("⏳", null, t("分集加载中…"));
  }

  if (episodes.length === 0) {
    return guard("🎞️", t("还没有分集"), t("时间线挂在分集下，请先在「项目」页新增一集"), { label: "前往项目页", go: "projects" });
  }

  const trackAddHandler = (type: TimelineTrackType) => {
    if (type === "video") setPicker("media");
    else if (type === "audio") setPicker("audio");
    else setSubFormOpen((v) => !v);
  };

  return (
    <div className="page tl-root">
      <style>{TL_CSS}</style>

      {/* ---------- 顶栏 ---------- */}
      <div className="page-header">
        <div>
          <h1>{t("🎞️ 时间线")}</h1>
          <div className="desc">
            {project.project.title}
            {epTitle ? ` · ${t("第 {n} 集 · {title}", { n: epNo, title: epTitle })}` : ""}
            {doc
              ? ` · ${t("{n} 个片段", { n: docClipCount(doc) })} · ${t("总时长 {dur}", { dur: fmtTime(totalSec) })}`
              : ""}
          </div>
        </div>
        <div className="tl-toolbar">
          <select value={episodeId} onChange={(e) => setEpisodeId(e.target.value)} aria-label={t("选择分集")}>
            {episodes.map((ep) => (
              <option key={ep.id} value={ep.id}>
                {t("第 {n} 集 · {title}", { n: ep.number, title: ep.title })}
              </option>
            ))}
          </select>
          <button className="btn" disabled={generating || !episodeId} onClick={() => void generateFromShots()}>
            {generating ? t("生成中…") : t("🎬 从分镜生成时间线")}
          </button>
          <button className="btn" disabled={!doc || docClipCount(doc) === 0} onClick={clearTimeline}>
            {t("🧹 清空")}
          </button>
          <button className="btn" disabled={!doc || savingNow} onClick={() => void saveManual()}>
            {t("💾 保存")}
          </button>
          <button className="btn primary" disabled={rendering || !doc || docClipCount(doc) === 0} onClick={() => void renderFilm()}>
            {rendering ? t("创建中…") : t("🎬 渲染成片")}
          </button>
          <button className="btn" disabled={!episodeId} onClick={() => setExportOpen(true)}>
            {t("📦 多版本导出")}
          </button>
          {renderJob && <span className="tag blue">{t("渲染中 {p}%", { p: renderJob.progress })}</span>}
          <div className="tl-zoom">
            <span>{t("缩放")}</span>
            <input
              type="range" min={20} max={200} step={1} value={pxPerSec}
              onChange={(e) => setPxPerSec(Number(e.target.value))}
              aria-label={t("缩放")}
            />
          </div>
        </div>
      </div>

      {/* ---------- 主体 ---------- */}
      {loading ? (
        <div className="empty-state" style={{ padding: "80px 20px" }}>
          <div className="big">⏳</div>
          <p>{t("时间线加载中…")}</p>
        </div>
      ) : doc === null ? (
        /* 空态引导卡:exists=false 或 schemaVersion 非 2.0 */
        <div className="empty-state" style={{ padding: "80px 20px" }}>
          <div className="big">🎞️</div>
          <h2>{t("这一集还没有时间线")}</h2>
          <p style={{ maxWidth: 480, textAlign: "center" }}>
            {t("从分镜生成会按镜头顺序排列已出图画面并自动带上字幕；也可以新建空白时间线后在各轨道「+ 添加」片段。")}
          </p>
          <div className="tl-empty-actions">
            <button className="btn primary" disabled={generating} onClick={() => void generateFromShots()}>
              {generating ? t("生成中…") : t("🎬 从分镜生成时间线")}
            </button>
            <button className="btn" disabled={generating} onClick={() => void createBlank()}>
              {t("🧱 新建空白时间线")}
            </button>
          </div>
        </div>
      ) : (
        <div className="tl-body">
          <div className="tl-main">
            <div className="tl-scroll">
              <Ruler pxPerSec={pxPerSec} totalSec={totalSec} contentWidth={contentWidth} />
              {TRACK_META.map(({ type, icon, label }) => {
                const track = doc.tracks.find((tr) => tr.type === type);
                if (!track) return null;
                return (
                  <TrackLane
                    key={type}
                    track={track}
                    icon={icon}
                    label={t(label)}
                    pxPerSec={pxPerSec}
                    contentWidth={contentWidth}
                    assetOf={(clip) => (clip.assetId ? (assetMap.get(clip.assetId) ?? null) : null)}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onChangeClip={updateClip}
                    onDragEnd={scheduleSave}
                    onAdd={() => trackAddHandler(type)}
                  />
                );
              })}
              {subFormOpen && subtitleTrack && (
                <SubtitleForm
                  defaultStart={trackEndSec(subtitleTrack)}
                  onAdd={handleAddSubtitle}
                  onCancel={() => setSubFormOpen(false)}
                />
              )}
            </div>
          </div>

          {/* 右侧检查器 */}
          <div className="tl-inspector">
            <ClipInspector
              clip={selClip}
              kind={selKind}
              asset={selAsset}
              onChange={(patch) => selClip && updateClip(selClip.id, patch)}
              onDelete={() => selClip && deleteClip(selClip.id)}
            />
          </div>
        </div>
      )}

      {/* ---------- 弹窗 ---------- */}
      {picker && <AssetPickerModal mode={picker} onPick={handlePickAsset} onClose={() => setPicker(null)} />}
      {exportOpen && episodeId && (
        <ExportDialog episode={episodeId} onClose={() => setExportOpen(false)} />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          message={confirm.message}
          danger
          onConfirm={() => { const fn = confirm.onConfirm; setConfirm(null); fn(); }}
          onCancel={() => setConfirm(null)}
        />
      )}
    </div>
  );
}
