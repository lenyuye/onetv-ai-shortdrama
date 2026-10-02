/**
 * 项目视图 —— 项目总览 / 集数管理（Phase 1 完整化，Phase 0 先提供集数 CRUD）。
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import { project_export_pkg, project_import_pkg } from "../api-extras";
import { useApp } from "../store";

export default function ProjectsView() {
  const { project, loadProject, setView, toast } = useApp();
  const [episodes, setEpisodes] = useState<api.EpisodeInfoDto[]>([]);
  const [busy, setBusy] = useState(false);
  const [pkgBusy, setPkgBusy] = useState(false);

  const refresh = () => api.episodeList().then(setEpisodes).catch(() => {});
  useEffect(() => {
    if (project) refresh();
  }, [project?.episodes.length]);

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
      toast(`新增失败：${String(e)}`, "err");
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
      } else {
        toast(`导出失败：${r.message ?? "未知错误"}`, "err");
      }
    } catch (e) {
      toast(`导出失败：${String(e)}`, "err");
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
      } else {
        toast(`导入失败：${r.message ?? "未知错误"}`, "err");
      }
    } catch (e) {
      toast(`导入失败：${String(e)}`, "err");
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
          <div className="hint">世界观 / 人物 / 场景 / 道具 / 连续性规则。Phase 4 实现编辑器与 Agent 生成。</div>
        </div>
        <div className="card">
          <h3>🗂️ 资产库</h3>
          <div className="hint">人物定妆 / 场景参考 / 素材，SHA-256 去重。Phase 1 实现。</div>
        </div>
        <div className="card">
          <h3>🧠 Provider Map</h3>
          <div className="hint">项目默认使用的模型集合。Phase 3 实现。</div>
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
            {episodes.map((ep) => (
              <tr key={ep.id}>
                <td>第 {ep.number} 集</td>
                <td>{ep.title}</td>
                <td><span className="tag">{ep.status}</span></td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td><button className="btn sm" onClick={() => setView("script")}>打开</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
