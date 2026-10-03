/**
 * 项目视图 —— 项目总览 / 集数管理 / 每集剧本·分镜·画布内容统计。
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import { docGet } from "../api-story";
import { canvasGet } from "../api-canvas";
import { project_export_pkg, project_import_pkg } from "../api-extras";
import { useApp } from "../store";

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
  const [episodes, setEpisodes] = useState<api.EpisodeInfoDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [pkgBusy, setPkgBusy] = useState(false);
  const [epStats, setEpStats] = useState<Record<string, EpStats>>({});

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
        <h2>尚未打开项目</h2>
        <button className="btn primary" onClick={() => setView("home")}>前往工作区</button>
      </div>
    );
  }

  const addEpisode = async () => {
    setBusy(true);
    try {
      await api.episodeCreate();
      await loadProject();
      refresh();
      toast("已新增一集", "ok");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(`新增失败：${msg}`, "err");
    } finally {
      setBusy(false);
    }
  };

  // 高危：删除分集目录与其全部记录，不可恢复
  const deleteEpisode = async (ep: api.EpisodeInfoDto) => {
    if (!window.confirm(`将删除「第 ${ep.number} 集 ${ep.title}」及其全部剧本/分镜/画布/素材记录，不可恢复！\n\n确定删除吗？`)) return;
    setBusy(true);
    try {
      await api.episodeDelete(ep.id);
      await loadProject();
      refresh();
      toast(`已删除第 ${ep.number} 集`, "ok");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(`删除分集失败：${msg}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const exportPkg = async () => {
    setPkgBusy(true);
    try {
      const r = await project_export_pkg();
      if (r.ok) {
        toast(r.path ? `工程包已导出: ${r.path}` : "工程包已导出", "ok");
      } else if ((r.message ?? "").includes("已取消")) {
        /* 用户取消保存对话框，静默 */
      } else {
        toast(`导出失败：${r.message ?? "未知错误"}`, "err");
      }
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(`导出失败：${msg}`, "err");
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
        toast(r.path ? `工程包已导入: ${r.path}` : "工程包已导入", "ok");
      } else if ((r.message ?? "").includes("已取消")) {
        /* 用户取消文件选择，静默 */
      } else {
        toast(`导入失败：${r.message ?? "未知错误"}`, "err");
      }
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(`导入失败：${msg}`, "err");
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
            {project.project.logline || "一部短剧一个项目 · 分集管理 · Story Bible · 生成历史"}
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button className="btn" disabled={pkgBusy} title="把当前项目打包导出为一个工程包文件" onClick={() => void exportPkg()}>
            📦 导出工程包
          </button>
          <button className="btn" disabled={pkgBusy} title="从工程包文件导入项目（成功后刷新当前项目）" onClick={() => void importPkg()}>
            📂 导入工程包
          </button>
          <button className="btn primary" disabled={busy} onClick={addEpisode}>+ 新增一集</button>
        </div>
      </div>

      <div className="grid-3">
        <div className="card">
          <h3>📖 Story Bible</h3>
          <div className="hint">编辑剧集设定与世界观，供生成时引用。</div>
        </div>
        <div className="card">
          <h3>🗂️ 资产库</h3>
          <div className="hint">项目素材统一管理，导入时自动 SHA-256 去重。</div>
        </div>
        <div className="card">
          <h3>🧠 Provider Map</h3>
          <div className="hint">各集生成所用的模型映射。</div>
        </div>
      </div>

      <h3 style={{ margin: "18px 0 10px", fontSize: 14 }}>分集</h3>
      {episodes.length === 0 ? (
        <div className="card hint">还没有分集。点击右上角「新增一集」开始。</div>
      ) : (
        <table className="table">
          <thead>
            <tr><th>#</th><th>标题</th><th>状态</th><th>剧本</th><th>分镜</th><th>画布</th><th></th></tr>
          </thead>
          <tbody>
            {episodes.map((ep) => {
              const s = epStats[ep.id];
              const scriptCell = s?.scenes != null ? `${s.scenes} 个场景` : "—";
              const sbCell =
                s?.shots != null ? `${s.shots} 个镜头（已出图 ${s.ready ?? 0}）` : "—";
              const canvasCell = s?.nodes != null ? `${s.nodes} 个节点` : "—";
              return (
                <tr key={ep.id}>
                  <td>第 {ep.number} 集</td>
                  <td>{ep.title}</td>
                  <td><span className="tag">{ep.status}</span></td>
                  <td>{scriptCell}</td>
                  <td>{sbCell}</td>
                  <td>{canvasCell}</td>
                  <td>
                    <button className="btn sm" onClick={() => setView("script")}>打开</button>
                    <button className="btn sm danger" disabled={busy} title="删除该分集及其全部剧本/分镜/画布/素材记录，不可恢复" onClick={() => void deleteEpisode(ep)}>删除</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
