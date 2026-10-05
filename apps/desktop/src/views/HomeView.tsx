/**
 * 工作区视图 —— 无云端账号：选择本地文件夹 → 新建/打开 .ytv 项目。
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import { useApp } from "../store";
import ConfirmDialog from "../components/ConfirmDialog";
import { useT } from "../i18n";

/** 确认对话框待确认的操作（替代 window.confirm：异步对话框无法同步等待用户选择，改为 state 驱动） */
type ConfirmState =
  | { kind: "create-in-folder"; dir: string; name: string }
  | { kind: "remove-recent"; target: api.RecentWorkspace }
  | { kind: "delete-project"; target: api.RecentWorkspace };

/** 最近列表条目的显示名（名称为空时取路径末段兜底） */
const displayName = (r: api.RecentWorkspace) => r.name || r.path.split("/").filter(Boolean).pop() || r.path;

export default function HomeView() {
  const { project, loadProject, setView, toast, settings } = useApp();
  const t = useT();
  const [recent, setRecent] = useState<api.RecentWorkspace[]>([]);
  const [title, setTitle] = useState("");
  const [ratio, setRatio] = useState("9:16");
  const [busy, setBusy] = useState(false);
  const [confirmState, setConfirmState] = useState<ConfirmState | null>(null);

  const refreshRecent = () => api.listRecentWorkspaces().then(setRecent).catch(() => {});
  useEffect(() => {
    refreshRecent();
  }, []);

  const createProject = async () => {
    if (!title.trim()) {
      toast(t("请先填写短剧名称"), "warn");
      return;
    }
    setBusy(true);
    try {
      // 设置了默认项目文件夹则直接使用，否则每次弹窗选择
      let dir: string | null = settings?.defaultProjectFolder ?? null;
      if (!dir) {
        dir = await api.projectPickDirectory(t("选择工作区文件夹（项目将创建在这里）"));
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
      toast(t("项目已创建：{title}", { title: manifest.project.title }), "ok");
      setView("projects");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("创建失败：{msg}", { msg }), "err");
    } finally {
      setBusy(false);
    }
  };

  const openProject = async () => {
    setBusy(true);
    try {
      const dir = await api.projectPickDirectory(t("选择 .ytv 项目文件夹"));
      if (!dir) return;
      try {
        await api.projectOpen(dir);
      } catch (e) {
        // 普通文件夹（不是 .ytv 工程）：提供就地新建，避免用户混淆「新建/打开」；
        // 确认走 ConfirmDialog（见底部），确认后的动作在 createInFolder
        const msg = api.errMsg(e);
        if (msg.includes("缺少 project.json") || msg.includes("不是 OneTV 工程")) {
          const name = dir.split("/").filter(Boolean).pop() ?? "";
          setConfirmState({ kind: "create-in-folder", dir, name });
          return;
        }
        throw e;
      }
      await loadProject();
      await api.addRecentWorkspace(dir, "");
      toast(t("项目已打开"), "ok");
      setView("projects");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("打开失败：{msg}", { msg }), "err");
    } finally {
      setBusy(false);
    }
  };

  // 「在普通文件夹就地新建工程」：用户在 ConfirmDialog 确认后的实际动作
  const createInFolder = async (dir: string, name: string) => {
    try {
      const manifest = await api.projectCreate({
        workspacePath: dir,
        projectTitle: name,
        aspectRatio: "9:16",
      });
      await api.addRecentWorkspace(dir, manifest.project.title);
      await loadProject();
      refreshRecent();
      toast(t("项目已创建：{title}", { title: manifest.project.title }), "ok");
      setView("projects");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("创建失败：{msg}", { msg }), "err");
    }
  };

  // 仅从「最近打开」列表移除记录，不碰磁盘工程文件（确认后执行 doRemoveRecent）
  const removeRecent = (r: api.RecentWorkspace) => setConfirmState({ kind: "remove-recent", target: r });
  const doRemoveRecent = async (r: api.RecentWorkspace) => {
    try {
      await api.workspaceRecentRemove(r.path);
      refreshRecent();
      toast(t("已移除打开记录"), "ok");
    } catch (e) {
      toast(t("移除记录失败：{msg}", { msg: api.errMsg(e) }), "err");
    }
  };

  // 高危：连磁盘工程文件夹一起删除，不可恢复（确认后执行 doDeleteProject，确认按钮为红色）
  const deleteProject = (r: api.RecentWorkspace) => setConfirmState({ kind: "delete-project", target: r });
  const doDeleteProject = async (r: api.RecentWorkspace) => {
    try {
      await api.projectDelete(r.path);
      // 若删的是当前打开项目，loadProject 后 UI 回到「未打开项目」态
      await useApp.getState().loadProject();
      refreshRecent();
      toast(t("已删除工程「{name}」", { name: displayName(r) }), "ok");
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) toast(t("删除工程失败：{msg}", { msg }), "err");
    }
  };

  const openRecent = async (path: string) => {
    setBusy(true);
    try {
      await api.projectOpen(path);
      await loadProject();
      toast(t("项目已打开"), "ok");
      setView("projects");
    } catch (e) {
      toast(t("打开失败：{msg}", { msg: String(e) }), "err");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>{project ? t("当前项目：{title}", { title: project.project.title }) : t("欢迎使用 OneTV")}</h1>
          <div className="desc">
            {t("本地优先的短剧创作工作台 —— 项目、剧本、素材、生成历史全部保存在你自己的电脑上，默认零遥测，只有调用你配置的模型 API 时数据才会发往对应服务商。")}
          </div>
        </div>
      </div>

      {project && (
        <div className="card" style={{ marginBottom: 16, borderColor: "rgba(53,208,127,.35)" }}>
          <h3>✅ {t("已打开项目")}</h3>
          <div className="kv"><span className="k">{t("标题")}</span><span className="v">{project.project.title}</span></div>
          <div className="kv"><span className="k">{t("画幅")}</span><span className="v">{project.project.aspectRatio}</span></div>
          <div className="kv"><span className="k">{t("集数")}</span><span className="v">{project.episodes.length}</span></div>
          <div className="kv"><span className="k">{t("项目路径")}</span><span className="v">{useApp.getState().projectRoot}</span></div>
          <div style={{ marginTop: 10, display: "flex", gap: 10 }}>
            <button className="btn primary" onClick={() => setView("projects")}>{t("进入项目")}</button>
            <button className="btn" onClick={openProject}>{t("打开其他项目")}</button>
          </div>
        </div>
      )}

      <div className="grid-2">
        <div className="card">
          <h3>🎬 {t("新建短剧项目")}</h3>
          <div className="field">
            <label>{t("短剧名称")}</label>
            <input
              type="text"
              placeholder={t("例如：《霓虹夜行》")}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createProject()}
            />
            <span className="sub">{t("项目将以 .ytv 工程文件夹保存，可随时整体拷贝迁移")}</span>
          </div>
          <div className="field">
            <label>{t("默认画幅")}</label>
            <select value={ratio} onChange={(e) => setRatio(e.target.value)}>
              <option value="9:16">{t("9:16 竖版（抖音/快手/小红书）")}</option>
              <option value="16:9">{t("16:9 横版（B站/YouTube）")}</option>
              <option value="1:1">{t("1:1 方形")}</option>
            </select>
          </div>
          <div className="field">
            <label>{t("保存位置")}</label>
            <span className="sub">
              {settings?.defaultProjectFolder
                ? t("默认保存到 {folder}（可在「设置 → 存储位置」修改）", { folder: settings.defaultProjectFolder })
                : t("未设置默认位置：点击「创建」后选择文件夹，或在「设置 → 存储位置」预设")}
            </span>
          </div>
          <button className="btn primary" disabled={busy || !title.trim()} title={!title.trim() ? t("请先填写短剧名称") : ""} onClick={createProject}>
            {t("创建项目")}
          </button>
          <button className="btn" style={{ marginLeft: 10 }} disabled={busy} onClick={openProject}>
            {t("打开已有项目…")}
          </button>
        </div>

        <div className="card">
          <h3>🕘 {t("最近打开")}</h3>
          {recent.length === 0 ? (
            <div className="hint">{t("还没有打开过项目。OneTV 不需要注册账号，也不会把项目上传到任何服务器。")}</div>
          ) : (
            <table className="table">
              <thead>
                <tr><th>{t("项目")}</th><th>{t("路径")}</th><th></th></tr>
              </thead>
              <tbody>
                {recent.map((r) => (
                  <tr key={r.path}>
                    <td>{r.name || r.path.split("/").pop()}</td>
                    <td style={{ maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>{r.path}</td>
                    <td>
                      <button className="btn sm" disabled={busy} onClick={() => openRecent(r.path)}>{t("打开")}</button>
                      <button className="btn sm" disabled={busy} title={t("仅从最近列表移除，不删除工程文件")} onClick={() => void removeRecent(r)}>{t("移除记录")}</button>
                      <button className="btn sm danger" disabled={busy} title={t("删除磁盘上的工程文件夹，不可恢复")} onClick={() => void deleteProject(r)}>{t("删除工程")}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h3>🛡️ {t("数据边界（如实告知）")}</h3>
        <div className="hint">
          {t("OneTV 本身没有中央服务器：项目文件只保存在本机，API Key 存入 macOS 钥匙串，默认关闭全部遥测。当你调用云端模型（生图/生视频/LLM）时，相应输入必然发给该服务商 —— 每次出站前 OneTV 都会展示「数据出站预览」，由你确认。开启 Local-only 后仅本机服务（Ollama / ComfyUI）可用。")}
        </div>
      </div>

      {/* 确认对话框（替代 window.confirm） */}
      {confirmState?.kind === "create-in-folder" && (
        <ConfirmDialog
          title={t("新建工程")}
          message={t("「{target}」不是 OneTV 工程（缺少 project.json）。\n\n要在这个文件夹里直接新建工程「{name}」吗？\n（确认后将创建 {dir}/{name}.ytv）", {
            target: confirmState.name || confirmState.dir,
            name: confirmState.name,
            dir: confirmState.dir,
          })}
          onConfirm={() => {
            const { dir, name } = confirmState;
            setConfirmState(null);
            void createInFolder(dir, name);
          }}
          onCancel={() => setConfirmState(null)}
        />
      )}
      {confirmState?.kind === "remove-recent" && (
        <ConfirmDialog
          title={t("移除打开记录")}
          message={t("仅移除打开记录，不删除工程文件？\n\n「{name}」将不再出现在最近列表，但磁盘上的工程文件夹保持不变。", { name: displayName(confirmState.target) })}
          onConfirm={() => {
            const target = confirmState.target;
            setConfirmState(null);
            void doRemoveRecent(target);
          }}
          onCancel={() => setConfirmState(null)}
        />
      )}
      {confirmState?.kind === "delete-project" && (
        <ConfirmDialog
          title={t("删除工程")}
          danger
          message={t("将把磁盘上的工程文件夹一并删除，全部剧本/分镜/素材不可恢复！\n\n确定删除「{name}」吗？\n\n路径：{path}", {
            name: displayName(confirmState.target),
            path: confirmState.target.path,
          })}
          onConfirm={() => {
            const target = confirmState.target;
            setConfirmState(null);
            void doDeleteProject(target);
          }}
          onCancel={() => setConfirmState(null)}
        />
      )}
    </div>
  );
}
