/**
 * 节点生成面板（v2.5 · LibTV 式节点聊天框）：
 * 挂在节点下方 —— 预览区（已生成产物 / 尝试快捷项）+ 风格 chips + 参考上传 +
 * 提示词输入 + 模型/画幅/发送；发送即创建对应生成任务，成功后回填节点 outputAssetId。
 * 参考来源两种（可混用、按资产 id 去重）：
 * 1. ＋ 参考：本地上传任意格式，自动入项目资产库；
 * 2. ⚓ 节点参考：直接绑定同画布其他节点的产物（outputAssetId）与节点已挂参考（referenceAssetIds）。
 */
import { useEffect, useRef, useState } from "react";
import * as api from "../../api";
import { jobList, type JobDto } from "../../api-providers";
import { useApp } from "../../store";
import { assetList, assetUrl, type AssetRecord } from "../../api-assets";
import { canvasGet } from "../../api-canvas";
import type { CanvasNode, NodeType } from "@onetv/shared-types";
import { useT } from "../../i18n";

const TYPE_CN: Record<string, string> = {
  asset: "素材", text: "文本", script: "剧本", image: "生图", video: "生视频", audio: "配音",
  storyboard: "分镜", "video-clip": "片段合成", condition: "条件", review: "审核", export: "导出",
};

const STYLE_PRESETS = ["赛博朋克霓虹", "写实电影感", "水墨国风", "日系动漫", "复古胶片"];

/** 已绑定参考条目：id=资产 id，kind 用于图标/缩略图，from 标注来源（本地上传 / 节点绑定） */
interface RefItem {
  id: string;
  name: string;
  path: string;
  kind: string;
  from: string;
}

/** 资产路径 → 文件名（AssetRecord 无 name 字段） */
const baseName = (p: string) => p.split("/").pop() || p;

/** 资产类别 → 图标（覆盖资产库 kind 与 agent_attach 分类：images/videos/audio/references…） */
const REF_ICON: Record<string, string> = {
  images: "🖼️", videos: "🎬", audio: "🎵", subtitles: "📄", documents: "📄", references: "📄",
};
const refIcon = (k: string) => REF_ICON[k] ?? "📄";

/** 尝试快捷项：按节点类型给一组提示词模板（点击插入输入框） */
function quickActions(type: NodeType): { icon: string; label: string; tpl: string }[] {
  switch (type) {
    case "image":
      return [
        { icon: "🔁", label: "图生图", tpl: "以上传的参考图为基础重绘：" },
        { icon: "HD", label: "图片高清", tpl: "增强细节重绘这张图：" },
      ];
    case "video":
    case "video-clip":
      return [
        { icon: "🎬", label: "图生视频", tpl: "让参考图动起来：" },
        { icon: "⏩", label: "视频续写", tpl: "延续参考视频的镜头继续生成：" },
      ];
    case "audio":
      return [{ icon: "🎙️", label: "台词配音", tpl: "为下面的台词配音：" }];
    case "text":
      return [
        { icon: "✍️", label: "润色改写", tpl: "润色这段文本：" },
        { icon: "📖", label: "续写", tpl: "续写这段文本：" },
      ];
    default:
      return [];
  }
}

/** 支持面板直发生成的节点类型（其余类型后端明确报错，前端直接禁用避免空跑） */
const RUNNABLE_TYPES: NodeType[] = ["image", "video", "video-clip", "audio", "text"];

export default function NodeChatPanel({
  node,
  episodeId,
  anchor,
  providers,
  onConfig,
  onClose,
}: {
  node: CanvasNode;
  episodeId: string;
  /** 相对画布容器的像素坐标（节点左上角） */
  anchor: { x: number; y: number };
  providers: { id: string; name: string; models: { modelId: string; capabilities: string[] }[] }[];
  onConfig: (nodeId: string, patch: Record<string, unknown>) => void;
  onClose: () => void;
}) {
  const t = useT();
  const cap =
    node.type === "image" ? "image_generation"
    : node.type === "video" || node.type === "video-clip" ? "video_generation"
    : node.type === "audio" ? "tts"
    : node.type === "text" ? "chat"
    : "";
  const capableProviders = providers.filter((p) =>
    cap ? p.models.some((m) => m.capabilities.includes(cap)) : false
  );
  /** 当前节点类型是否支持面板直发生成 */
  const runnable =
    RUNNABLE_TYPES.includes(node.type) &&
    node.config?.disabled !== true; // v2.14：禁用节点不可面板直发

  const [prompt, setPrompt] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [aspect, setAspect] = useState("9:16");
  const [refs_, setRefs] = useState<RefItem[]>([]);
  /** 节点参考选择器：null=关闭；列表项为同画布其他节点可调用的参考图/视频/音频 */
  const [refPicker, setRefPicker] = useState<null | { items: RefItem[]; loading: boolean }>(null);
  const [sending, setSending] = useState(false);
  const [jobState, setJobState] = useState<string | null>(null);
  const [jobError, setJobError] = useState("");
  const [resultPath, setResultPath] = useState<string | null>(null);
  /** 文本节点的生成结果（Chat 任务回复，回填 config.text 的同时在面板展示） */
  const [resultText, setResultText] = useState<string | null>(null);
  /** v2.26.26 文本节点行内编辑 */
  const [editingText, setEditingText] = useState(false);
  const [textDraft, setTextDraft] = useState("");
  /** v2.26.26 上游连线文本节点的文字约束（发送时并入提示词） */
  const [edgeTexts, setEdgeTexts] = useState<{ from: string; text: string }[]>([]);
  const pollRef = useRef<number | null>(null);
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  /** 绑定参考（本地上传与节点绑定共用）：按资产 id 去重 */
  const bindRef = (it: RefItem) =>
    setRefs((rs) => (rs.some((x) => x.id === it.id) ? rs : [...rs, it]));

  /** 读取同画布其他节点可调用的参考资产：节点产物 outputAssetId + 节点已挂参考 referenceAssetIds */
  const loadNodeRefs = async () => {
    setRefPicker({ items: [], loading: true });
    try {
      const doc = await canvasGet(episodeId);
      const wanted = new Map<string, string>(); // assetId → 来源节点标题
      for (const n of doc.nodes ?? []) {
        if (n.id === node.id) continue; // 不绑定自身
        const cfg = (n.config ?? {}) as Record<string, unknown>;
        const out = typeof cfg.outputAssetId === "string" ? cfg.outputAssetId : "";
        if (out && !wanted.has(out)) wanted.set(out, n.title || n.id);
        const refIds = Array.isArray(cfg.referenceAssetIds) ? cfg.referenceAssetIds : [];
        for (const rid of refIds) {
          if (typeof rid === "string" && rid && !wanted.has(rid)) wanted.set(rid, n.title || n.id);
        }
      }
      const assets: AssetRecord[] = wanted.size > 0 ? await assetList().catch(() => []) : [];
      const items: RefItem[] = assets
        .filter((a) => wanted.has(a.id))
        .map((a) => ({ id: a.id, name: baseName(a.path), path: a.path, kind: a.kind, from: wanted.get(a.id)! }));
      setRefPicker({ items, loading: false });
    } catch (e) {
      setRefPicker(null);
      useApp.getState().toast(t("读取节点参考失败：{msg}", { msg: api.errMsg(e) }), "err");
    }
  };

  // 节点参考选择器：点击外部 / Esc 关闭
  useEffect(() => {
    if (!refPicker) return;
    const onDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setRefPicker(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setRefPicker(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [refPicker]);

  /** 提示词框随内容自适应增高（无字数限制，超高后内部滚动） */
  const autoGrowPrompt = () => {
    const el = promptRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  };

  // 输入变化（含发送后清空）时重算高度
  useEffect(() => {
    autoGrowPrompt();
  }, [prompt]);

  // 打开时：若节点已有产物，尝试解析出路径用于预览
  useEffect(() => {
    const outId = (node.config as { outputAssetId?: string }).outputAssetId;
    if (!outId) return;
    assetList()
      .then((list) => {
        const hit = list.find((a) => a.id === outId);
        if (hit) setResultPath(hit.path);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // v2.26.26 连线即参考（LibTV/即梦式）：打开面板时自动把上游连线节点的
  // 产物（outputAssetId）与已挂参考（referenceAssetIds / 素材节点 files）绑定为参考；
  // 上游文本节点内容作为文字约束在发送时自动并入提示词。
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const doc = await canvasGet(episodeId);
        if (!alive) return;
        const edges = (doc.edges ?? []) as { source: string; target: string }[];
        const incoming = edges.filter((e) => e.target === node.id).map((e) => e.source);
        if (incoming.length === 0) return;
        const wanted = new Map<string, string>(); // assetId → 来源节点标题
        const texts: { from: string; text: string }[] = [];
        for (const n of doc.nodes ?? []) {
          if (!incoming.includes(n.id)) continue;
          const cfg = (n.config ?? {}) as Record<string, unknown>;
          const from = `${n.title || n.id}`;
          const out = typeof cfg.outputAssetId === "string" ? cfg.outputAssetId : "";
          if (out) wanted.set(out, from);
          for (const rid of (Array.isArray(cfg.referenceAssetIds) ? cfg.referenceAssetIds : []) as string[]) {
            if (rid) wanted.set(rid, from);
          }
          if (n.type === "text") {
            const ut = typeof cfg.text === "string" ? cfg.text.trim() : "";
            if (ut) texts.push({ from, text: ut });
          }
        }
        if (wanted.size > 0) {
          const list = await assetList().catch(() => []);
          if (!alive) return;
          for (const a of list) {
            const from = wanted.get(a.id);
            if (!from) continue;
            bindRef({ id: a.id, name: baseName(a.path), path: a.path, kind: a.kind, from: `@${from}` });
          }
        }
        if (alive && texts.length > 0) setEdgeTexts(texts);
      } catch { /* 画布读取失败不阻塞面板 */ }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.id, episodeId]);

  // 卸载时停止轮询
  useEffect(() => {
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, []);

  const send = async () => {
    const text = prompt.trim();
    if (!text || sending || !runnable) return;
    setSending(true);
    setJobError("");
    setJobState(t("排队中…"));
    try {
      // v2.26.26 上游文本节点的文字约束自动并入提示词（节点输入在前，约束在后）
      const fullPrompt = edgeTexts.length > 0 ? [text, ...edgeTexts.map((x) => x.text)].join("\n") : text;
      const r = await api.canvasNodeRun({
        episodeId,
        nodeId: node.id,
        prompt: fullPrompt,
        aspect: node.type === "image" || node.type === "video" || node.type === "video-clip" ? aspect : undefined,
        providerId: providerId || undefined,
        modelId: modelId || undefined,
        referenceAssetIds: refs_.map((x) => x.id),
      });
      setJobState(t("任务已入队"));
      pollRef.current = window.setInterval(async () => {
        try {
          const jobs: JobDto[] = await jobList(200);
          const j = jobs.find((x) => x.id === r.jobId);
          if (!j) return;
          if (j.state === "SUCCEEDED") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            setJobState(null);
            setSending(false);
            if (node.type === "text") {
              // 文本节点：Chat 任务回复 → 回填节点 text 并在面板展示
              const reply = j.reply ?? "";
              onConfig(node.id, { text: reply, status: "ready" });
              setResultText(reply);
            } else {
              const outId = (j.outputs ?? [])[0];
              if (outId) {
                const list = await assetList().catch(() => []);
                const hit = list.find((a) => a.id === outId);
                // v2.26.27：路径一并写入 config，节点卡片可直接显示产物缩略图
                onConfig(node.id, { outputAssetId: outId, outputAssetPath: hit?.path ?? "", status: "ready" });
                setResultPath(hit?.path ?? null);
              }
            }
            setPrompt("");
          } else if (j.state === "FAILED" || j.state === "CANCELED") {
            if (pollRef.current) window.clearInterval(pollRef.current);
            setJobState(null);
            setSending(false);
            setJobError(j.error || t("任务失败"));
          } else {
            setJobState(`${j.state === "RUNNING" ? t("生成中") : j.state} ${Math.round((j.progress ?? 0) * 100)}%`);
          }
        } catch { /* 轮询失败下轮重试 */ }
      }, 1500);
    } catch (e) {
      setSending(false);
      setJobState(null);
      setJobError(api.errMsg(e));
    }
  };

  const uploadRef = async () => {
    try {
      const att = await api.agentAttach();
      bindRef({ id: att.assetId, name: att.name, path: att.path, kind: att.kind, from: t("本地上传") });
      // v2.26.26 素材节点：上传同时写入节点 config（files/referenceAssetIds），供卡片缩略图与下游连线调用
      if (node.type === "asset") {
        const cfg = (node.config ?? {}) as Record<string, unknown>;
        const files = (Array.isArray(cfg.files) ? cfg.files : []) as { id: string; name: string; path: string; kind: string }[];
        const refIds = (Array.isArray(cfg.referenceAssetIds) ? cfg.referenceAssetIds : []) as string[];
        onConfig(node.id, {
          files: [...files, { id: att.assetId, name: att.name, path: att.path, kind: att.kind }],
          referenceAssetIds: [...refIds, att.assetId],
          status: "ready",
        });
      }
    } catch (e) {
      const msg = api.errMsg(e);
      if (!msg.includes("已取消")) useApp.getState().toast(t("参考上传失败：{msg}", { msg }), "err");
    }
  };

  const actions = quickActions(node.type);
  const showImage = resultPath && /\.(png|jpe?g|webp|gif)$/i.test(resultPath);
  const showVideo = resultPath && /\.(mp4|mov|webm|m4v)$/i.test(resultPath);
  const showAudio = resultPath && /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(resultPath);

  return (
    <div
      className="node-chat"
      style={{ left: Math.max(8, anchor.x), top: anchor.y + 150 }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="node-chat-head">
        <span>{t("{type}节点", { type: t(TYPE_CN[node.type] ?? node.type) })}</span>
        <span className="node-chat-sub">{node.title || node.id}</span>
        <button className="node-chat-close" title={t("关闭")} onClick={onClose}>×</button>
      </div>

      {/* 预览区：文本节点显示文本产物（可行内编辑）；素材节点显示已传文件；媒体节点显示已有产物；否则给出尝试快捷项 */}
      <div className="node-chat-preview">
        {node.type === "asset" ? (
          // v2.26.26 素材节点：展示已上传文件，提示连线用法
          <div className="node-chat-text">
            {((node.config as { files?: { id: string; name: string; path: string; kind: string }[] }).files ?? []).length > 0 ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {((node.config as { files: { id: string; name: string; path: string; kind: string }[] }).files).map((f) =>
                  f.kind === "images" || /\.(png|jpe?g|webp|gif)$/i.test(f.path) ? (
                    <img key={f.id} className="node-chat-refthumb" src={assetUrl(f.path)} alt={f.name} title={f.name} />
                  ) : (
                    <span key={f.id} className="node-chat-chip has-ref" title={f.name}>
                      <span>{refIcon(f.kind)}</span>
                      {f.name.length > 12 ? `${f.name.slice(0, 12)}…` : f.name}
                    </span>
                  ),
                )}
              </div>
            ) : (
              <div className="node-chat-placeholder">
                <span className="node-chat-try">{t("选中节点后在右侧「参数」面板点「📤 上传素材」，或用下方「＋ 参考」上传")}</span>
              </div>
            )}
            <div className="node-chat-try" style={{ marginTop: 6 }}>
              {t("💡 把本节点的输出连线到 生图/生视频 等节点，打开对方面板时会自动绑定为参考。")}
            </div>
          </div>
        ) : node.type === "text" ? (
          <div className="node-chat-text">
            {editingText ? (
              <>
                <textarea
                  className="node-chat-prompt"
                  style={{ minHeight: 90, maxHeight: 220 }}
                  value={textDraft}
                  placeholder={t("输入文本内容，保存后连线给生成节点即可作为提示词/文字约束")}
                  onChange={(e) => setTextDraft(e.target.value)}
                />
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <button
                    className="node-chat-try-item"
                    onClick={() => {
                      onConfig(node.id, { text: textDraft });
                      setResultText(textDraft);
                      setEditingText(false);
                    }}
                  >
                    💾 {t("保存")}
                  </button>
                  <button className="node-chat-try-item" onClick={() => setEditingText(false)}>{t("取消")}</button>
                </div>
              </>
            ) : (resultText ?? ((node.config as { text?: string }).text || "")) ? (
              <>
                <pre className="node-chat-text-body">
                  {resultText ?? (node.config as { text?: string }).text}
                </pre>
                <button
                  className="node-chat-try-item"
                  style={{ marginTop: 6 }}
                  onClick={() => {
                    setTextDraft((node.config as { text?: string }).text ?? "");
                    setEditingText(true);
                  }}
                >
                  ✏️ {t("编辑内容（作为下游节点的文字约束）")}
                </button>
              </>
            ) : (
              <div className="node-chat-placeholder">
                <div className="node-chat-try">{t("尝试：")}</div>
                {actions.map((a) => (
                  <button key={a.label} className="node-chat-try-item" onClick={() => setPrompt((v) => (v ? v + " " : "") + a.tpl)}>
                    <span className="node-chat-try-ic">{a.icon}</span>
                    {t(a.label)}
                  </button>
                ))}
                <button
                  className="node-chat-try-item"
                  onClick={() => { setTextDraft(""); setEditingText(true); }}
                >
                  <span className="node-chat-try-ic">✏️</span>
                  {t("手动输入内容（连线给生成节点作文字约束）")}
                </button>
              </div>
            )}
          </div>
        ) : showImage ? (
          <img src={assetUrl(resultPath!)} alt={t("生成结果")} />
        ) : showVideo ? (
          <video src={assetUrl(resultPath!)} controls />
        ) : showAudio ? (
          <audio src={assetUrl(resultPath!)} controls style={{ width: "90%" }} />
        ) : (
          <div className="node-chat-placeholder">
            {actions.length > 0 ? (
              <>
                <div className="node-chat-try">{t("尝试：")}</div>
                {actions.map((a) => (
                  <button key={a.label} className="node-chat-try-item" onClick={() => setPrompt((v) => (v ? v + " " : "") + a.tpl)}>
                    <span className="node-chat-try-ic">{a.icon}</span>
                    {t(a.label)}
                  </button>
                ))}
              </>
            ) : (
              <span className="node-chat-try">{t("该节点类型暂不支持面板直发生成")}</span>
            )}
          </div>
        )}
      </div>

      {/* 参考上传 + 节点参考绑定 + 风格 chips */}
      <div className="node-chat-chips">
        <button className="node-chat-chip" onClick={() => void uploadRef()} title={t("上传参考（任意格式，自动存入项目资产库）")}>{t("＋ 参考")}</button>
        <div className="node-chat-refpick" ref={pickerRef}>
          <button
            className={`node-chat-chip${refPicker ? " has-ref" : ""}`}
            onClick={() => (refPicker ? setRefPicker(null) : void loadNodeRefs())}
            title={t("绑定画布节点中的参考图/视频（其他节点的产物或已挂参考）")}
          >
            {t("⚓ 节点参考")}
          </button>
          {refPicker && (
            <div className="node-chat-refmenu">
              <div className="node-chat-refmenu-head">{t("绑定节点中的参考（点击添加）")}</div>
              {refPicker.loading ? (
                <div className="node-chat-refmenu-empty">{t("读取中…")}</div>
              ) : refPicker.items.length === 0 ? (
                <div className="node-chat-refmenu-empty">
                  {t("画布中暂无可绑定的参考——其他节点生成产物或挂接参考后即可在此调用")}
                </div>
              ) : (
                refPicker.items.map((it) => (
                  <button
                    key={it.id}
                    className="node-chat-refmenu-item"
                    title={t("{path}\n来自节点：{from}", { path: it.path, from: it.from })}
                    onClick={() => {
                      bindRef(it);
                      setRefPicker(null);
                    }}
                  >
                    {it.kind === "images" ? (
                      <img className="node-chat-refmenu-thumb" src={assetUrl(it.path)} alt="" />
                    ) : (
                      <span className="node-chat-refmenu-ic">{refIcon(it.kind)}</span>
                    )}
                    <span className="node-chat-refmenu-name">{it.name}</span>
                    <em>@{it.from}</em>
                  </button>
                ))
              )}
            </div>
          )}
        </div>
        {refs_.map((r, i) => (
          <span key={r.id} className="node-chat-chip has-ref" title={t("{path}\n来源：{from}", { path: r.path, from: r.from })}>
            {r.kind === "images" ? (
              <img className="node-chat-refthumb" src={assetUrl(r.path)} alt="" />
            ) : (
              <span>{refIcon(r.kind)}</span>
            )}
            {r.name.length > 12 ? `${r.name.slice(0, 12)}…` : r.name}
            <button title={t("移除参考")} onClick={() => setRefs((rs) => rs.filter((_, j) => j !== i))}>×</button>
          </span>
        ))}
        {edgeTexts.map((et, i) => (
          <span key={`et${i}`} className="node-chat-chip has-ref" title={et.text}>
            📝 {t("文字约束")} @{et.from}
            <button title={t("移除该文字约束（本轮发送）")} onClick={() => setEdgeTexts((ts) => ts.filter((_, j) => j !== i))}>×</button>
          </span>
        ))}
        {STYLE_PRESETS.map((st) => (
          <button key={st} className="node-chat-chip" onClick={() => setPrompt((v) => (v ? `${v}，风格：${st}` : `风格：${st}，`))}>
            🎨 {t(st)}
          </button>
        ))}
      </div>

      {/* 提示词（无字数限制，随内容自适应增高） */}
      <textarea
        ref={promptRef}
        className="node-chat-prompt"
        value={prompt}
        placeholder={
          !runnable
            ? t("该节点类型暂不支持面板直发生成（文本/图片/视频/音频节点可直接生成）")
            : node.type === "image"
            ? t("可直接文字生图，或绑定参考后输入指令，如：将背景改为雪夜")
            : node.type === "video" || node.type === "video-clip"
            ? t("描述要生成的视频镜头，如：雨夜霓虹街头，主角撑伞走过")
            : node.type === "audio"
            ? t("输入要配音的台词文本")
            : node.type === "text"
            ? t("输入要生成的文本内容或指令，如：写一段女主雨夜的内心独白")
            : t("输入提示词")
        }
        disabled={!runnable}
        onChange={(e) => {
          setPrompt(e.target.value);
          // 自适应增高(v2.23):随内容长高,CSS max-height 280px 封顶
          const el = e.target as HTMLTextAreaElement;
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void send(); }
        }}
      />

      {/* 底栏：模型 / 画幅 / 发送 */}
      <div className="node-chat-bar">
        <select
          className="node-chat-model"
          value={providerId ? `${providerId}::${modelId}` : ""}
          onChange={(e) => {
            const v = e.target.value;
            if (!v) { setProviderId(""); setModelId(""); return; }
            const [pid, mid] = v.split("::");
            setProviderId(pid);
            setModelId(mid);
          }}
          title={t("生成模型（留空 = 使用模型页「生成模型设置」的默认）")}
        >
          <option value="">{t("自动模型")}</option>
          {capableProviders.map((p) =>
            p.models
              .filter((m) => m.capabilities.includes(cap))
              .map((m) => (
                <optgroup key={`${p.id}-${m.modelId}`} label={p.name}>
                  <option value={`${p.id}::${m.modelId}`}>{p.name} · {m.modelId}</option>
                </optgroup>
              ))
          )}
        </select>
        {(node.type === "image" || node.type === "video" || node.type === "video-clip") && (
          <select className="node-chat-aspect" value={aspect} onChange={(e) => setAspect(e.target.value)} title={t("画幅")}>
            <option value="9:16">9:16</option>
            <option value="16:9">16:9</option>
            <option value="1:1">1:1</option>
          </select>
        )}
        <span style={{ flex: 1 }} />
        <button className="node-chat-send" disabled={sending || !prompt.trim() || !runnable} onClick={() => void send()} title={t("⌘+Enter 发送")}>
          {sending ? "…" : "↑"}
        </button>
      </div>

      {(jobState || jobError) && (
        <div className={`node-chat-status ${jobError ? "err" : ""}`}>
          {jobError ? t("⚠️ {msg}", { msg: jobError }) : t("⏳ {msg}", { msg: jobState ?? "" })}
        </div>
      )}
    </div>
  );
}
