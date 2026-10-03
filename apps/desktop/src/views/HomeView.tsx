/**
 * 工作区视图 —— 无云端账号：选择本地文件夹 → 新建/打开 .ytv 项目。
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import { useApp } from "../store";

export default function HomeView() {
  const { project, loadProject, setView, toast, settings } = useApp();
  const [recent, setRecent] = useState<api.RecentWorkspace[]>([]);
  const [title, setTitle] = useState("");
  const [ratio, setRatio] = useState("9:16");
  const [busy, setBusy] = useState(false);

  const refreshRecent = () => api.listRecentWorkspaces().then(setRecent).catch(() => {});
  useEffect(() => {
    refreshRecent();
  }, []);

  const createProject = async () => {
    if (!title.trim()) {
      toast("请先填写短剧名称", "warn");
      return;
    }
    setBusy(true);
    try {
      // 设置了默认项目文件夹则直接使用，否则每次弹窗选择
      let dir: string | null = settings?.defaultProjectFolder ?? null;
      if (!dir) {
        dir = await api.projectPickDirectory("选择工作区文件夹（项目将创建在这里）");
        if (!dir) return;
      }
      const manifest = await api.projectCreate({
        workspacePath: dir,
        projectTitle: title.trim(),
        aspectRatio: ratio,
      });
      await api.addRecentWorkspace(dir, title.trim());
      await loadProject();
      refreshRecent();
      toast(`项目已创建：${manifest.project.title}`, "ok");
      setView("projects");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(`创建失败：${msg}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const openProject = async () => {
    setBusy(true);
    try {
      const dir = await api.projectPickDirectory("选择 .ytv 项目文件夹");
      if (!dir) return;
      try {
        await api.projectOpen(dir);
      } catch (e) {
        // 普通文件夹（不是 .ytv 工程）：提供就地新建，避免用户混淆「新建/打开」
        const msg = api.errMsg(e);
        if (msg.includes("缺少 project.json") || msg.includes("不是 OneTV 工程")) {
          const name = dir.split("/").filter(Boolean).pop() ?? "";
          const ok = window.confirm(
            `「${name || dir}」不是 OneTV 工程（缺少 project.json）。\n\n要在这个文件夹里直接新建工程「${name}」吗？\n（确认后将创建 ${dir}/${name}.ytv）`
          );
          if (!ok) return;
          const manifest = await api.projectCreate({
            workspacePath: dir,
            projectTitle: name,
            aspectRatio: "9:16",
          });
          await api.addRecentWorkspace(dir, manifest.project.title);
          await loadProject();
          refreshRecent();
          toast(`项目已创建：${manifest.project.title}`, "ok");
          setView("projects");
          return;
        }
        throw e;
      }
      await loadProject();
      await api.addRecentWorkspace(dir, "");
      toast("项目已打开", "ok");
      setView("projects");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(`打开失败：${msg}`, "err");
    } finally {
      setBusy(false);
    }
  };

  // 仅从「最近打开」列表移除记录，不碰磁盘工程文件
  const removeRecent = async (r: api.RecentWorkspace) => {
    const name = r.name || r.path.split("/").filter(Boolean).pop() || r.path;
    if (!window.confirm(`仅移除打开记录，不删除工程文件？\n\n「${name}」将不再出现在最近列表，但磁盘上的工程文件夹保持不变。`)) return;
    try {
      await api.workspaceRecentRemove(r.path);
      refreshRecent();
      toast("已移除打开记录", "ok");
    } catch (e) {
      toast(`移除记录失败：${api.errMsg(e)}`, "err");
    }
  };

  // 高危：连磁盘工程文件夹一起删除，不可恢复
  const deleteProject = async (r: api.RecentWorkspace) => {
    const name = r.name || r.path.split("/").filter(Boolean).pop() || r.path;
    if (!window.confirm(`将把磁盘上的工程文件夹一并删除，全部剧本/分镜/素材不可恢复！\n\n确定删除「${name}」吗？\n\n路径：${r.path}`)) return;
    try {
      await api.projectDelete(r.path);
      // 若删的是当前打开项目，loadProject 后 UI 回到「未打开项目」态
      await useApp.getState().loadProject();
      refreshRecent();
      toast(`已删除工程「${name}」`, "ok");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(`删除工程失败：${msg}`, "err");
    }
  };

  const openRecent = async (path: string) => {
    setBusy(true);
    try {
      await api.projectOpen(path);
      await loadProject();
      toast("项目已打开", "ok");
      setView("projects");
    } catch (e) {
      toast(`打开失败：${String(e)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{project ? `当前项目：${project.project.title}` : "欢迎使用 OneTV"}</h1>
          <div className="desc">
            本地优先的短剧创作工作台 —— 项目、剧本、素材、生成历史全部保存在你自己的电脑上，
            默认零遥测，只有调用你配置的模型 API 时数据才会发往对应服务商。
          </div>
        </div>
      </div>

      {project && (
        <div className="card" style={{ marginBottom: 16, borderColor: "rgba(53,208,127,.35)" }}>
          <h3>✅ 已打开项目</h3>
          <div className="kv"><span className="k">标题</span><span className="v">{project.project.title}</span></div>
          <div className="kv"><span className="k">画幅</span><span className="v">{project.project.aspectRatio}</span></div>
          <div className="kv"><span className="k">集数</span><span className="v">{project.episodes.length}</span></div>
          <div className="kv"><span className="k">项目路径</span><span className="v">{useApp.getState().projectRoot}</span></div>
          <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
            <button className="btn primary" onClick={() => setView("projects")}>进入项目</button>
            <button className="btn" onClick={openProject}>打开其他项目</button>
          </div>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <h3>🎬 新建短剧项目</h3>
          <div className="field">
            <label>短剧名称</label>
            <input
              type="text"
              placeholder="例如：《霓虹夜行》"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createProject()}
            />
            <span className="sub">项目将以 .ytv 工程文件夹保存，可随时整体拷贝迁移</span>
          </div>
          <div className="field">
            <label>默认画幅</label>
            <select value={ratio} onChange={(e) => setRatio(e.target.value)}>
              <option value="9:16">9:16 竖版（抖音/快手/小红书）</option>
              <option value="16:9">16:9 横版（B站/YouTube）</option>
              <option value="1:1">1:1 方形</option>
            </select>
          </div>
          <div className="field">
            <label>保存位置</label>
            <span className="sub">
              {settings?.defaultProjectFolder
                ? `默认保存到 ${settings.defaultProjectFolder}（可在「设置 → 存储位置」修改）`
                : "未设置默认位置：点击「创建」后选择文件夹，或在「设置 → 存储位置」预设"}
            </span>
          </div>
          <button className="btn primary" disabled={busy || !title.trim()} title={!title.trim() ? "请先填写短剧名称" : ""} onClick={createProject}>
            创建项目
          </button>
          <button className="btn" style={{ marginLeft: 10 }} disabled={busy} onClick={openProject}>
            打开已有项目…
          </button>
        </div>

        <div className="card">
          <h3>🕘 最近打开</h3>
          {recent.length === 0 ? (
            <div className="hint">还没有打开过项目。OneTV 不需要注册账号，也不会把项目上传到任何服务器。</div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>项目</th><th>路径</th><th></th></tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.path}>
                    <td>{r.name || r.path.split("/").pop()}</td>
                    <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{r.path}</td>
                    <td>
                      <button className="btn sm" disabled={busy} onClick={() => openRecent(r.path)}>打开</button>
                      <button className="btn sm" disabled={busy} title="仅从最近列表移除，不删除工程文件" onClick={() => void removeRecent(r)}>移除记录</button>
                      <button className="btn sm danger" disabled={busy} title="删除磁盘上的工程文件夹，不可恢复" onClick={() => void deleteProject(r)}>删除工程</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>🛡️ 数据边界（如实告知）</h3>
        <div className="hint">
          OneTV 本身没有中央服务器：项目文件只保存在本机，API Key 存入 macOS 钥匙串，默认关闭全部遥测。
          当你调用云端模型（生图/生视频/LLM）时，相应输入必然发给该服务商 —— 每次出站前 OneTV 都会展示
          「数据出站预览」，由你确认。开启 Local-only 后仅本机服务（Ollama / ComfyUI）可用。
        </div>
      </div>
    </div>
  );
}
