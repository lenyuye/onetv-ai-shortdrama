/**
 * 资产库视图 —— 类型化导入 / 筛选 / 网格浏览 / 复制路径 / 删除。
 *
 * 资产保存在项目 .ytv/assets/ 内（Local-first，永不外发），导入时按 SHA-256 去重。
 * 复用 global.css 设计系统（.card/.btn/.tag/.empty-state），布局细节用本组件内的
 * scoped <style> 补充（无法修改 global.css）。
 */
import { useCallback, useEffect, useState } from "react";
import * as assets from "../api-assets";
import { exportAssetWithPicker, type AssetImportKind, type AssetRecord } from "../api-assets";
import { video_understand } from "../api-extras";
import { errMsg } from "../api";
import { useApp } from "../store";
import { useT } from "../i18n";

/* ---------------- 常量 ---------------- */

/** 筛选 tab —— 除 all 外的 key 与 Rust 侧 kind 存储值对齐（documents 含 document/references 等） */
const KIND_TABS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "images", label: "图片" },
  { key: "videos", label: "视频" },
  { key: "audio", label: "音频" },
  { key: "subtitles", label: "字幕" },
  { key: "documents", label: "文档/参考" },
];

const IMPORT_BUTTONS: { kind: AssetImportKind; label: string; icon: string }[] = [
  { kind: "images", label: "图片", icon: "🖼️" },
  { kind: "videos", label: "视频", icon: "🎬" },
  { kind: "audio", label: "音频", icon: "🎵" },
  { kind: "subtitles", label: "字幕", icon: "📝" },
  { kind: "documents", label: "其他", icon: "📄" },
];

/* ---------------- 工具函数 ---------------- */

/** path 最后一段作为展示名（兼容 / 与 \ 分隔） */
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 人性化大小：B / KB / MB / GB */
function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

/** 将 kind/mime 归一为展示分组（兼容单复数 kind 与 mime 前缀） */
function kindGroup(a: AssetRecord): "image" | "video" | "audio" | "doc" {
  if (a.mime.startsWith("image/")) return "image";
  if (a.mime.startsWith("video/")) return "video";
  if (a.mime.startsWith("audio/")) return "audio";
  switch (a.kind) {
    case "images":
    case "image":
      return "image";
    case "videos":
    case "video":
      return "video";
    case "audio":
      return "audio";
    default:
      return "doc";
  }
}

/** 每条资产归入唯一分类 tab（保证各分类计数之和 === 总数） */
function tabOf(a: AssetRecord): string {
  // 字幕优先：kind 为 subtitle(s) 或 srt/vtt mime
  if (a.kind === "subtitles" || a.kind === "subtitle") return "subtitles";
  if (a.mime === "application/x-subrip" || a.mime === "text/vtt") return "subtitles";
  // 容错：单复数 kind 与 mime 归一
  const g = kindGroup(a);
  if (g === "image") return "images";
  if (g === "video") return "videos";
  if (g === "audio") return "audio";
  // 其余（document / references 等文本类）全部归入「文档/参考」兜底
  return "documents";
}

/** 筛选 tab 是否命中某条资产（每条资产仅命中一个分类 tab，all 除外） */
function matchTab(a: AssetRecord, tab: string): boolean {
  return tab === "all" || tabOf(a) === tab;
}

/* ---------------- 资产卡片 ---------------- */

function AssetCard({
  asset,
  onCopy,
  onDelete,
  onPreview,
  onUnderstand,
  understanding,
}: {
  asset: AssetRecord;
  onCopy: (a: AssetRecord) => void;
  onDelete: (a: AssetRecord) => void;
  onUnderstand: (a: AssetRecord) => void;
  onPreview: (a: AssetRecord) => void;
  understanding: boolean;
}) {
  const [imgFailed, setImgFailed] = useState(false);
  const t = useT();
  const name = basename(asset.path);
  const group = kindGroup(asset);
  const showImg = group === "image" && !imgFailed;

  return (
    <div className="card asset-card" title={`${asset.path}\nSHA-256: ${asset.sha256}`}>
      <div className="asset-thumb">
        {showImg ? (
          <img
            src={assets.assetUrl(asset.path)}
            alt={name}
            loading="lazy"
            onError={() => setImgFailed(true)}
          />
        ) : (
          <span className="asset-icon">
            {group === "video" ? "🎬" : group === "audio" ? "🎵" : "📄"}
          </span>
        )}
        {group === "video" && <span className="tag asset-dur">{t("时长 --:--")}</span>}
      </div>
      {/* 操作栏（v2.26.25）：常显于缩略图下方，flex-wrap 自动换行——不再悬浮裁切 */}
      <div className="asset-actions">
        <button className="btn sm" onClick={() => onCopy(asset)}>{t("复制路径")}</button>
        <button className="btn sm" onClick={() => onPreview(asset)} title={t("在 OneTV 内直接查看（视频/图片/音频/文本）")}>
          {t("👁 预览")}
        </button>
        <button
          className="btn sm"
          title={t("选择文件夹保存（同名自动加序号）")}
          onClick={() => {
            void exportAssetWithPicker(asset.path)
              .then((dest) => {
                if (dest) useApp.getState().toast(t("已下载到：{path}", { path: dest }), "ok");
              })
              .catch((e) => useApp.getState().toast(t("下载失败：{msg}", { msg: errMsg(e) }), "err"));
          }}
        >
          {t("⬇ 下载")}
        </button>
        <button
          className="btn sm"
          title={t("在 Finder 中打开所在文件夹并选中该文件")}
          onClick={() => {
            void assets.assetReveal(asset.path).then(
              () => useApp.getState().toast(t("已在 Finder 中定位"), "ok"),
              (e) => useApp.getState().toast(t("打开失败：{msg}", { msg: errMsg(e) }), "err"),
            );
          }}
        >
          {t("📁 文件夹")}
        </button>
        {group === "video" && (
          <button
            className="btn sm blue"
            disabled={understanding}
            title={t("发起视频理解任务，完成后结果写入 episodes/ep01/understanding.json")}
            onClick={() => onUnderstand(asset)}
          >
            {understanding ? t("创建中…") : t("🔍 视频理解")}
          </button>
        )}
        <button className="btn sm danger" onClick={() => onDelete(asset)}>{t("删除")}</button>
      </div>
      <div className="asset-meta">
        <div className="asset-name" title={name}>{name}</div>
        <div className="asset-sub">
          <span className="tag">{formatSize(asset.size_bytes)}</span>
          <span className="tag mono">{asset.sha256.slice(0, 12)}</span>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 预览弹窗（v2.26.19）：视频播放 / 图片查看 / 音频播放 / 文本显示 ---------------- */
function AssetPreviewModal({
  asset, onClose,
}: { asset: AssetRecord; onClose: () => void }) {
  const t = useT();
  const group = kindGroup(asset);
  const url = assets.assetUrl(asset.path);
  const name = basename(asset.path);
  const [textContent, setTextContent] = useState<string | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (group !== "doc") return;
    let alive = true;
    setTextContent(null);
    fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((txt) => { if (alive) setTextContent(txt.slice(0, 200000)); })
      .catch((e) => { if (alive) setErr(errMsg(e)); });
    return () => { alive = false; };
  }, [url, group]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: "min(900px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t("👁 预览 · {name}", { name })}</span>
          <button className="btn sm ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body" style={{ display: "flex", justifyContent: "center", minHeight: 120 }}>
          {err ? (
            <div className="hint mem-notice">{t("预览失败：{msg}", { msg: err })}</div>
          ) : group === "video" ? (
            <video src={url} controls autoPlay style={{ maxWidth: "100%", maxHeight: "68vh", borderRadius: 10 }} />
          ) : group === "audio" ? (
            <div style={{ width: "100%", textAlign: "center", padding: 20 }}>
              <div style={{ fontSize: 44, marginBottom: 14 }}>🎵</div>
              <audio src={url} controls autoPlay style={{ width: "100%" }} />
            </div>
          ) : group === "image" ? (
            <img src={url} alt={name} style={{ maxWidth: "100%", maxHeight: "68vh", borderRadius: 10 }} />
          ) : textContent !== null ? (
            <pre
              style={{
                width: "100%", whiteSpace: "pre-wrap", wordBreak: "break-word",
                background: "var(--bg-deep)", border: "1px solid var(--border)", borderRadius: 10,
                padding: 14, fontSize: 12.5, maxHeight: "66vh", overflow: "auto",
                userSelect: "text",
              }}
            >
              {textContent}
            </pre>
          ) : (
            <div className="hint">{t("加载中…")}</div>
          )}
        </div>
        <div className="modal-foot">
          <span className="hint" style={{ marginRight: "auto" }}>
            {formatSize(asset.size_bytes)} · SHA-256 {asset.sha256.slice(0, 12)}
          </span>
          {/* v2.26.157：预览弹窗内直接下载（用户反馈"无法点预览后直接下载"） */}
          <button
            className="btn"
            title={t("选择文件夹保存（同名自动加序号）")}
            onClick={() => {
              void exportAssetWithPicker(asset.path)
                .then((dest) => {
                  if (dest) useApp.getState().toast(t("已下载到：{path}", { path: dest }), "ok");
                })
                .catch((e) => useApp.getState().toast(t("下载失败：{msg}", { msg: errMsg(e) }), "err"));
            }}
          >
            ⬇ {t("下载")}
          </button>
          <button
            className="btn"
            title={t("在 Finder 中显示")}
            onClick={() => {
              void assets
                .assetReveal(asset.path)
                .then(() => useApp.getState().toast(t("已在 Finder 中定位"), "ok"))
                .catch((e) => useApp.getState().toast(t("打开失败：{msg}", { msg: errMsg(e) }), "err"));
            }}
          >
            📁 {t("文件夹")}
          </button>
          <button className="btn" onClick={onClose}>{t("关闭")}</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- 主视图 ---------------- */

export default function AssetsView() {
  const [previewAsset, setPreviewAsset] = useState<AssetRecord | null>(null);
  const { project, setView, toast } = useApp();
  const t = useT();
  const [items, setItems] = useState<AssetRecord[]>([]);
  const [tab, setTab] = useState("all");
  const [busyKind, setBusyKind] = useState<AssetImportKind | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [understandingId, setUnderstandingId] = useState<string | null>(null);

  const refresh = useCallback(() => {
    return assets
      .assetList()
      .then(setItems)
      .catch(() => setItems([]));
  }, []);

  /** v2.26.106：手动刷新带 loading + 结果反馈（此前点击无任何视觉反馈，像失灵） */
  const refreshWithFeedback = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
      toast(t("资产列表已刷新"), "ok");
    } finally {
      setRefreshing(false);
    }
  }, [refresh, toast, t]);

  useEffect(() => {
    if (project) void refresh();
  }, [project, refresh]);

  /* 无项目：空状态 + 前往工作区（同 ProjectsView 模式） */
  if (!project) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🗂️</div>
        <h2>{t("尚未打开项目")}</h2>
        <p>{t("资产库属于单个项目，请先创建或打开一个项目")}</p>
        <button className="btn primary" onClick={() => setView("home")}>{t("前往工作区")}</button>
      </div>
    );
  }

  const doImport = async (kind: AssetImportKind) => {
    setBusyKind(kind);
    try {
      const rec = await assets.assetImport(kind);
      if (!rec) return; // 用户在文件选择框点了取消
      const dedup = items.some((i) => i.id === rec.id);
      await refresh();
      toast(dedup ? t("内容已存在，SHA-256 去重：{name}", { name: basename(rec.path) }) : t("已导入：{name}", { name: basename(rec.path) }), "ok");
    } catch (e) {
      const msg = errMsg(e);
      if (msg.includes("已取消")) return; // 用户在文件选择框取消，静默
      toast(t("导入失败：{msg}", { msg }), "err");
    } finally {
      setBusyKind(null);
    }
  };

  const doCopy = async (a: AssetRecord) => {
    try {
      await navigator.clipboard.writeText(a.path);
      toast(t("路径已复制到剪贴板"), "ok");
    } catch (e) {
      const msg = errMsg(e);
      if (!msg.includes("已取消")) toast(t("复制失败：{msg}", { msg }), "err");
    }
  };

  const doDelete = async (a: AssetRecord) => {
    if (!window.confirm(t("删除资产「{name}」？\n文件将从项目 assets/ 中移除，此操作不可恢复。", { name: basename(a.path) }))) return;
    setDeletingId(a.id);
    try {
      await assets.assetDelete(a.id);
      await refresh();
      toast(t("已删除"), "ok");
    } catch (e) {
      const msg = errMsg(e);
      if (!msg.includes("已取消")) toast(t("删除失败：{msg}", { msg }), "err");
    } finally {
      setDeletingId(null);
    }
  };

  const doUnderstand = async (a: AssetRecord) => {
    setUnderstandingId(a.id);
    try {
      const r = await video_understand(a.id);
      if (r.ok) {
        toast(t("视频理解任务已创建，完成后结果写入 episodes/ep01/understanding.json"), "ok");
      } else {
        toast(t("视频理解任务创建失败：{msg}", { msg: r.message ?? t("未知错误") }), "err");
      }
    } catch (e) {
      const msg = errMsg(e);
      if (!msg.includes("已取消")) toast(t("视频理解任务创建失败：{msg}", { msg }), "err");
    } finally {
      setUnderstandingId(null);
    }
  };

  const shown = items.filter((a) => matchTab(a, tab));
  const countOf = (key: string) => items.filter((a) => matchTab(a, key)).length;

  return (
    <div className="page">
      <style>{ASSETS_CSS}</style>

      <div className="page-header">
        <div>
          <h1>🗂️ {t("资产库")}</h1>
          <div className="desc">
            {t("{title} · 共 {n} 个资产 · Local-first，永不外发", { title: project.project.title, n: items.length })}
          </div>
        </div>
        <div className="assets-toolbar">
          {IMPORT_BUTTONS.map((b) => (
            <button
              key={b.kind}
              className="btn"
              disabled={busyKind !== null}
              onClick={() => void doImport(b.kind)}
            >
              {busyKind === b.kind ? t("导入中…") : `${b.icon} ${t("导入{label}", { label: t(b.label) })}`}
            </button>
          ))}
          <button className="btn ghost" disabled={refreshing} onClick={() => void refreshWithFeedback()}>
            {refreshing ? t("刷新中…") : `⟳ ${t("刷新")}`}
          </button>
        </div>
      </div>

      {/* 类型筛选 tab */}
      <div className="assets-tabs">
        {KIND_TABS.map((k) => (
          <button
            key={k.key}
            className={`assets-tab ${tab === k.key ? "active" : ""}`}
            onClick={() => setTab(k.key)}
          >
            {t(k.label)}
            <span className="assets-tab-count">{countOf(k.key)}</span>
          </button>
        ))}
      </div>

      {/* 网格 */}
      {items.length === 0 ? (
        <div className="empty-state" style={{ padding: "80px 20px" }}>
          <div className="big">🗂️</div>
          <h2>{t("还没有资产")}</h2>
          <p>{t("导入人物定妆照 / 场景参考 / 任何素材。相同内容自动 SHA-256 去重")}</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-state" style={{ padding: "60px 20px" }}>
          <div className="big">🔍</div>
          <p>{t("该类型下暂无资产")}</p>
        </div>
      ) : (
        <div className="assets-grid">
          {shown.map((a) => (
            <AssetCard
              key={a.id}
              asset={a}
              onCopy={(x) => void doCopy(x)}
              onDelete={(x) => void doDelete(x)}
              onPreview={(x) => setPreviewAsset(x)}
              onUnderstand={(x) => void doUnderstand(x)}
              understanding={understandingId === a.id}
            />
          ))}
          {previewAsset && (
            <AssetPreviewModal asset={previewAsset} onClose={() => setPreviewAsset(null)} />
          )}
        </div>
      )}

      {deletingId && <div className="assets-busy">{t("正在删除…")}</div>}

      {/* 底部提示条 */}
      <div className="assets-foot">
        <span>🔒</span>
        <span>{t("资产保存在项目 .ytv/assets/ 内，永不外发；导入时自动计算 SHA-256 去重")}</span>
      </div>
    </div>
  );
}

/* ---------------- 视图局部样式（补充 global.css，深色一致） ---------------- */

const ASSETS_CSS = `
.assets-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.assets-tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.assets-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 4px 12px; border-radius: 99px; cursor: pointer;
  border: 1px solid var(--border-strong); background: var(--panel-2);
  color: var(--text-dim); font-size: 12px; transition: all 0.12s ease;
}
.assets-tab:hover { border-color: var(--blue); color: var(--text); }
.assets-tab.active {
  color: #fff; border-color: rgba(255, 61, 154, 0.45); background: var(--pink-soft);
}
.assets-tab-count {
  font-size: 10px; padding: 0 6px; border-radius: 99px;
  background: var(--panel-3); border: 1px solid var(--border); color: var(--muted);
}
.assets-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px;
}
.asset-card { padding: 0; overflow: hidden; }
.asset-card:hover { border-color: var(--blue); box-shadow: var(--glow-blue); }
.asset-thumb {
  position: relative; height: 120px; background: var(--bg-deep);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
.asset-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.asset-icon { font-size: 34px; opacity: 0.75; }
.asset-dur { position: absolute; top: 6px; left: 6px; background: rgba(4, 6, 14, 0.7); }
/* 操作栏：卡片内常显（v2.26.25）——flex-wrap 换行 + 居中，窄卡也不裁切 */
.asset-actions {
  display: flex; flex-wrap: wrap; gap: 4px; justify-content: center;
  padding: 7px 8px; border-top: 1px solid var(--border); background: var(--panel);
}
.asset-actions .btn { padding: 2px 8px; font-size: 10.5px; border-radius: 7px; }
.asset-meta { padding: 8px 10px 10px; display: flex; flex-direction: column; gap: 5px; min-width: 0; }
.asset-name {
  font-size: 12px; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.asset-sub { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-width: 0; }
.tag.mono { font-family: var(--mono); font-size: 10px; letter-spacing: 0.3px; }
.assets-busy { margin-top: 12px; font-size: 12px; color: var(--amber); }
.assets-foot {
  position: sticky; bottom: 0; z-index: 5;
  display: flex; align-items: center; gap: 8px;
  margin: 18px -22px -18px; padding: 9px 22px;
  background: var(--panel); border-top: 1px solid var(--border);
  font-size: 11.5px; color: var(--muted);
}
`;
