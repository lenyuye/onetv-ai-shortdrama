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
      const dir = await api.projectPickDirectory("选择工作区文件夹（项目将创建在这里）");
      if (!dir) return;
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
      toast(`创建失败：${String(e)}`, "err");
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
        const msg = String(e);
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
      toast(`打开失败：${String(e)}`, "err");
    } finally {
      setBusy(false);
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
              点击「创建」后选择文件夹。默认建议放在
              {settings?.defaultProjectFolder ? ` ${settings.defaultProjectFolder}` : " 文稿/OneTV 下"}
            </span>
          </div>
          <button className="btn primary" disabled={busy} onClick={createProject}>
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
