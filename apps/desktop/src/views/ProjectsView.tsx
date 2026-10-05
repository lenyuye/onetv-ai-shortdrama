/**
 * 项目视图 —— 项目总览 / 集数管理 / 每集剧本·分镜·画布内容统计。
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import { docGet } from "../api-story";
import { canvasGet } from "../api-canvas";
import { project_export_pkg, project_import_pkg, recreateCanvas } from "../api-extras";
import BibleEditor from "../components/BibleEditor";
import { useApp } from "../store";
import { useT } from "../i18n";
import { errMsg as _errMsg } from "../api-story";

/* ---------------- 每集内容统计 ---------------- */

/** 每集内容统计（undefined = 无文件 / 读取失败，展示为「—」） */
interface EpStats {
  scenes?: number;
  shots?: number;
  ready?: number;
  nodes?: number;
}

/** doc_get 对缺文件返回 {"schemaVersion":"1.0"}：以目标数组键是否存在判断有无文件 */
function countKey(raw: unknown, key: string): number | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const v = (raw as Record<string, unknown>)[key];
  return Array.isArray(v) ? v.length : undefined;
}

/** 已出图镜头数 = 有 outputAssetId 的镜头数 */
function countReady(shots: unknown): number {
  if (!Array.isArray(shots)) return 0;
  return shots.filter(
    (s) => !!s && typeof s === "object" && !!(s as Record<string, unknown>).outputAssetId
  ).length;
}

export default function ProjectsView() {
  const { project, loadProject, setView, toast } = useApp();
  const t = useT();
  const [episodes, setEpisodes] = useState<api.EpisodeInfoDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [pkgBusy, setPkgBusy] = useState(false);
  const [epStats, setEpStats] = useState<Record<string, EpStats>>({});
  const [bibleOpen, setBibleOpen] = useState(false);
  const [recreateBusy, setRecreateBusy] = useState(false);
  const doRecreate = async () => {
    const ep = episodes[0];
    if (!ep) return;
    setRecreateBusy(true);
    try {
      const r = await recreateCanvas(ep.id);
      toast(t("画布已重建：{n} 个镜头节点（旧画布已备份）", { n: r.created }), "ok");
    } catch (e) {
      toast(t("重建失败：{msg}", { msg: api.errMsg(e) }), "err");
    } finally {
      setRecreateBusy(false);
    }
  };

  const refresh = () => api.episodeList().then(setEpisodes).catch(() => {});
  useEffect(() => {
    if (project) refresh();
  }, [project?.episodes.length]);

  /* 每集剧本/分镜/画布统计：仅几次小 JSON 读取，分集列表变化时重算 */
  useEffect(() => {
    if (episodes.length === 0) return;
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        episodes.map(async (ep): Promise<readonly [string, EpStats]> => {
          const stat: EpStats = {};
          const [scriptRaw, sbRaw, canvasRaw] = await Promise.all([
            docGet(ep.id, "script").catch(() => null),
            docGet(ep.id, "storyboard").catch(() => null),
            canvasGet(ep.id).catch(() => null),
          ]);
          stat.scenes = countKey(scriptRaw, "scenes");
          stat.shots = countKey(sbRaw, "shots");
          stat.ready = stat.shots != null ? countReady((sbRaw as Record<string, unknown> | null)?.shots) : undefined;
          stat.nodes = countKey(canvasRaw, "nodes");
          return [ep.id, stat] as const;
        })
      );
      if (!cancelled) setEpStats(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [episodes]);

  if (!project) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🎬</div>
        <h2>{t("尚未打开项目")}</h2>
        <button className="btn primary" onClick={() => setView("home")}>{t("前往工作区")}</button>
      </div>
    );
  }

  const addEpisode = async () => {
    setBusy(true);
    try {
      await api.episodeCreate();
      await loadProject();
      refresh();
      toast(t("已新增一集"), "ok");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("新增失败：{msg}", { msg }), "err");
    } finally {
      setBusy(false);
    }
  };

  // 高危：删除分集目录与其全部记录，不可恢复
  const deleteEpisode = async (ep: api.EpisodeInfoDto) => {
    if (!window.confirm(t("将删除「第 {n} 集 {title}」及其全部剧本/分镜/画布/素材记录，不可恢复！\n\n确定删除吗？", { n: ep.number, title: ep.title }))) return;
    setBusy(true);
    try {
      await api.episodeDelete(ep.id);
      await loadProject();
      refresh();
      toast(t("已删除第 {n} 集", { n: ep.number }), "ok");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("删除分集失败：{msg}", { msg }), "err");
    } finally {
      setBusy(false);
    }
  };

  const exportPkg = async () => {
    setPkgBusy(true);
    try {
      const r = await project_export_pkg();
      if (r.ok) {
        toast(r.path ? t("工程包已导出: {path}", { path: r.path }) : t("工程包已导出"), "ok");
      } else if ((r.message ?? "").includes("已取消")) {
        /* 用户取消保存对话框，静默 */
      } else {
        toast(t("导出失败：{msg}", { msg: r.message ?? t("未知错误") }), "err");
      }
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("导出失败：{msg}", { msg }), "err");
    } finally {
      setPkgBusy(false);
    }
  };

  const importPkg = async () => {
    setPkgBusy(true);
    try {
      const r = await project_import_pkg();
      if (r.ok) {
        // 工程包可能替换/更新当前项目，刷新全局项目态与分集列表
        await useApp.getState().loadProject();
        refresh();
        toast(r.path ? t("工程包已导入: {path}", { path: r.path }) : t("工程包已导入"), "ok");
      } else if ((r.message ?? "").includes("已取消")) {
        /* 用户取消文件选择，静默 */
      } else {
        toast(t("导入失败：{msg}", { msg: r.message ?? t("未知错误") }), "err");
      }
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("导入失败：{msg}", { msg }), "err");
    } finally {
      setPkgBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{project.project.title}</h1>
          <div className="desc">
            {project.project.logline || t("一部短剧一个项目 · 分集管理 · Story Bible · 生成历史")}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" disabled={pkgBusy} title={t("把当前项目打包导出为一个工程包文件")} onClick={() => void exportPkg()}>
            📦 {t("导出工程包")}
          </button>
          <button className="btn" disabled={pkgBusy} title={t("从工程包文件导入项目（成功后刷新当前项目）")} onClick={() => void importPkg()}>
            📂 {t("导入工程包")}
          </button>
          <button className="btn primary" disabled={busy} onClick={addEpisode}>+ {t("新增一集")}</button>
        </div>
      </div>

      <div className="grid-3">
        <div className="card">
          <h3>📖 Story Bible</h3>
          <div className="hint">{t("剧集设定与世界观：角色/场景/道具/连续性规则，剧本与分镜生成时自动引用；支持 AI 一键生成。")}</div>
          <div style={{ marginTop: 10 }}>
            <button className="btn primary sm" onClick={() => setBibleOpen(true)}>
              ✏️ {t("编辑设定 / AI 生成")}
            </button>
          </div>
        </div>
        <div className="card">
          <h3>🗂️ {t("资产库")}</h3>
          <div className="hint">{t("项目素材统一管理，导入时自动 SHA-256 去重。")}</div>
        </div>
        <div className="card">
          <h3>🔁 {t("从视频重建画布")}</h3>
          <div className="hint">{t("对视频执行「视频理解」后，可一键把检测到的镜头重建为画布节点（旧画布自动备份）。")}</div>
          <div style={{ marginTop: 10 }}>
            <button
              className="btn sm"
              disabled={recreateBusy || episodes.length === 0}
              title={t("使用第一集的视频理解结果重建画布")}
              onClick={() => void doRecreate()}
            >
              {recreateBusy ? t("重建中…") : t("🔁 重建「{title}」画布", { title: episodes[0]?.title ?? t("第一集") })}
            </button>
          </div>
        </div>
      </div>

      <h3 style={{ margin: "18px 0 10px", fontSize: 14 }}>{t("分集")}</h3>
      {episodes.length === 0 ? (
        <div className="card hint">{t("还没有分集。点击右上角「新增一集」开始。")}</div>
      ) : (
        <table className="table">
          <thead>
            <tr><th>#</th><th>{t("标题")}</th><th>{t("状态")}</th><th>{t("剧本")}</th><th>{t("分镜")}</th><th>{t("画布")}</th><th></th></tr>
          </thead>
          <tbody>
            {episodes.map((ep) => {
              const s = epStats[ep.id];
              const scriptCell = s?.scenes != null ? t("{n} 个场景", { n: s.scenes }) : "—";
              const sbCell =
                s?.shots != null ? t("{n} 个镜头（已出图 {m}）", { n: s.shots, m: s.ready ?? 0 }) : "—";
              const canvasCell = s?.nodes != null ? t("{n} 个节点", { n: s.nodes }) : "—";
              return (
                <tr key={ep.id}>
                  <td>{t("第 {n} 集", { n: ep.number })}</td>
                  <td>{ep.title}</td>
                  <td><span className="tag">{ep.status}</span></td>
                  <td>{scriptCell}</td>
                  <td>{sbCell}</td>
                  <td>{canvasCell}</td>
                  <td>
                    <button className="btn sm" onClick={() => setView("script")}>{t("打开")}</button>
                    <button className="btn sm danger" disabled={busy} title={t("删除该分集及其全部剧本/分镜/画布/素材记录，不可恢复")} onClick={() => void deleteEpisode(ep)}>{t("删除")}</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {bibleOpen && <BibleEditor onClose={() => setBibleOpen(false)} />}
    </div>
  );
}
