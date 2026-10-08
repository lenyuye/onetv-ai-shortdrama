/**
 * 自定义画布节点卡片 —— 显示类型图标、标题（NODE_TYPE_DEFS）、参数摘要（config 前 2 个键值）
 * 以及输入/输出端口手柄（accept 类型从 NODE_TYPE_DEFS 取）。
 * v2.26.27（即梦式）：运行状态徽标（批量 ✓/⏭/⏸）+ 生成产物缩略图直接上卡片。
 * v2.26.31（LibTV 式"节点即生成器"重构）：
 * - 生成节点（图/视频/片段合成/配音）卡内嵌「prompt 输入 + 画幅 + ▶ 生成」条，直接在节点上生成；
 * - 文本节点卡内嵌 textarea 直接编辑文案；
 * - 素材节点卡内嵌「＋上传」与「🖼 生图 / 🎬 生视频」快捷按钮（一键旁建生成节点并连线）；
 * - 生成任务 jobId 写入 config.generateJobId——卡片轮询到终态回填产物，滚出视口/重开应用后断线续查。
 */
import { useEffect, useRef, useState } from "react";
import { Handle, Position, useReactFlow } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { NODE_TYPE_DEFS } from "@onetv/node-sdk";
import type { CanvasNode } from "@onetv/shared-types";
import { useT } from "../../i18n";
import { assetList, assetUrl } from "../../api-assets";
import { canvasOutputNodeId } from "../../canvasSend";
import * as api from "../../api";
import { jobList } from "../../api-providers";
import { useApp } from "../../store";
import { NODE_ICONS, configSummary, isVideoMediaPath } from "./canvas-model";
import { useNodeActions } from "./NodeActionsContext";

/** 与 canvas.css 中 .cv-node-head 高度保持一致。 */
const HEAD_H = 40;
const ROW_H = 22;
const SUMMARY_H = 30;
/** 素材节点缩略图条高度（v2.26.26） */
const THUMB_H = 46;
/** v2.26.31 内嵌生成条 / 文本编辑区 / 素材快捷行高度 */
const GEN_H = 56;
const TEXT_H = 74;
const QUICK_H = 30;

/** 素材节点 config.files 元数据（上传时写入） */
interface AssetFileMeta {
  id: string;
  name: string;
  path: string;
  kind: string;
}

/* ---------------- 资产 id→路径 模块级缓存（v2.26.27 产物缩略图用） ---------------- */

let assetPathCache: Map<string, string> | null = null;
let assetPathPromise: Promise<Map<string, string>> | null = null;

function resolveAssetPaths(): Promise<Map<string, string>> {
  if (assetPathCache) return Promise.resolve(assetPathCache);
  if (!assetPathPromise) {
    assetPathPromise = assetList()
      .then((list) => {
        assetPathCache = new Map(list.map((a) => [a.id, a.path]));
        return assetPathCache;
      })
      .catch(() => new Map<string, string>());
  }
  return assetPathPromise;
}

const isImagePath = (p: string) => /\.(png|jpe?g|webp|gif)$/i.test(p);

/** 支持卡内直发生成的节点类型 */
const INLINE_GEN_TYPES = ["image", "video", "video-clip", "audio"];

/**
 * 聚合上游连线节点的参考（产物/参考资产/素材内容）与文字约束（v2.26.26/31/101 语义）：
 * v2.26.101 起素材节点上传的 files 是"节点内容"（非参考），但下游连线引用时仍作为参考参与生成。
 * v2.26.112 修复：改用 ReactFlow 内存实时状态——此前读 canvasGet（服务器文档），刚连的线还在
 * 800ms 自动保存 debounce 内，点生成时参考丢失（"连线了却不按参考生成"的主因）。
 */
function collectUpstreamLive(
  flowNodes: { id: string; data?: { cn?: CanvasNode } }[],
  flowEdges: { source: string; target: string }[],
  nodeId: string
): { refIds: string[]; texts: string[] } {
  const incoming = flowEdges.filter((e) => e.target === nodeId).map((e) => e.source);
  const wanted = new Set<string>();
  const texts: string[] = [];
  for (const n of flowNodes) {
    if (!incoming.includes(n.id)) continue;
    const cfg = (n.data?.cn?.config ?? {}) as Record<string, unknown>;
    if (typeof cfg.outputAssetId === "string" && cfg.outputAssetId) wanted.add(cfg.outputAssetId);
    for (const rid of (Array.isArray(cfg.referenceAssetIds) ? cfg.referenceAssetIds : []) as string[]) {
      if (rid) wanted.add(rid);
    }
    // v2.26.101：素材节点内容（files）被下游连线引用时作为参考
    for (const f of (Array.isArray(cfg.files) ? cfg.files : []) as { id?: string }[]) {
      if (f?.id) wanted.add(f.id);
    }
    if (n.data?.cn?.type === "text") {
      const ut = typeof cfg.text === "string" ? cfg.text.trim() : "";
      if (ut) texts.push(ut);
    }
  }
  return { refIds: [...wanted], texts };
}

export default function CanvasNodeCard(props: NodeProps) {
  const t = useT();
  const { toast } = useApp();
  const actions = useNodeActions();
  const rf = useReactFlow();
  const cn = (props.data as { cn?: CanvasNode }).cn;
  // v2.26.27 产物缩略图（即梦式）：image/video 节点有 outputAssetId 时显示小图
  const outId = typeof cn?.config?.outputAssetId === "string" ? (cn.config.outputAssetId as string) : "";
  const cfgOutPath = typeof cn?.config?.outputAssetPath === "string" ? (cn.config.outputAssetPath as string) : "";
  const isMedia = cn?.type === "image" || cn?.type === "video";
  const [resolvedPath, setResolvedPath] = useState<string>(cfgOutPath);
  useEffect(() => {
    if (cfgOutPath) {
      // 面板成功时已写入路径，直接采用
      if (resolvedPath !== cfgOutPath) setResolvedPath(cfgOutPath);
      return;
    }
    if (!outId) return;
    let alive = true;
    resolveAssetPaths().then((m) => {
      const p = m.get(outId);
      if (alive && p) setResolvedPath(p);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outId, cfgOutPath]);

  /* ---------- v2.26.31 卡内直发（LibTV 式） ---------- */

  const episodeId = cn?.episodeId ?? "";
  const isInlineGen = !!cn && INLINE_GEN_TYPES.includes(cn.type);
  const isAsset = cn?.type === "asset";
  const isText = cn?.type === "text";
  const [genPrompt, setGenPrompt] = useState(() =>
    cn && typeof cn.config?.prompt === "string" ? (cn.config.prompt as string) : ""
  );
  const [genAspect, setGenAspect] = useState(() =>
    cn && typeof cn.config?.aspect === "string" && cn.config.aspect ? (cn.config.aspect as string) : "9:16"
  );
  const [genBusy, setGenBusy] = useState(false);
  const [genNote, setGenNote] = useState<string>("");
  const pollRef = useRef<number | null>(null);

  const genJobId = typeof cn?.config?.generateJobId === "string" ? (cn.config.generateJobId as string) : "";
  const genError = typeof cn?.config?.generateError === "string" ? (cn.config.generateError as string) : "";
  // v2.26.157：产物节点幂等键——doc 级回填（job:succeeded）可能已落好产物节点，
  // 卡内轮询随后到达时不得再落第二个（此前会出现两个同内容节点）。
  const outNodeIdFor = (jid: string) => canvasOutputNodeId(jid);

  /** 轮询生成任务到终态并回填产物（jobId 持久在 config，重开应用/滚出视口后自动续查）。
   * v2.26.110 修复：守卫移除 genBusy——卡内发起生成后 genBusy 保持 true 且 genJobId
   * 写入触发本 effect，若守卫含 genBusy 则 interval 永不启动（按钮永久「生成中…」死锁）。
   * 防重复点击由 runInlineGenerate 的 genBusy 守卫负责，二者职责分离。 */
  useEffect(() => {
    if (!cn || !genJobId) return;
    if (pollRef.current) window.clearInterval(pollRef.current);
    let alive = true;
    let miss = 0; // v2.26.110：任务跌出最近列表窗口的连续计数，防无限空转
    const tick = async () => {
      try {
        const jobs = await jobList(200);
        const j = jobs.find((x) => x.id === genJobId);
        if (!alive) return;
        if (!j) {
          // 连续约 30s 查不到任务（已被清理/异常丢失）则按失败收场，停止轮询
          if (++miss >= 20) {
            window.clearInterval(pollRef.current!);
            pollRef.current = null;
            actions.patchConfig(cn.id, {
              generateJobId: null,
              generateError: t("任务查询超时（任务可能已丢失），请重新生成"),
              batchStatus: null,
            });
            setGenBusy(false);
            setGenNote("");
          }
          return;
        }
        miss = 0;
        if (j.state === "SUCCEEDED") {
          window.clearInterval(pollRef.current!);
          pollRef.current = null;
          if (cn.type === "audio" && (j.reply ?? "") !== "") {
            // 配音任务无文件产物输出时回退：audio handler 现已入库，走 outputs
          }
          const outId2 = (j.outputs ?? [])[0];
          if (outId2) {
            const list = await assetList().catch(() => []);
            if (!alive) return; // v2.26.110：第二个 await 后复查，防止卸载后写状态
            const hit = list.find((a) => a.id === outId2);
            actions.patchConfig(cn.id, {
              outputAssetId: outId2,
              outputAssetPath: hit?.path ?? "",
              status: "ready",
              generateJobId: null,
              generateError: null,
              batchStatus: "done",
              batchNote: t("卡内生成完成"),
            });
            // v2.26.102（LibTV 式）：产物自动落为新的独立内容节点（占满显示）
            // v2.26.157：若 doc 级回填已落（genout-<jobId>）则跳过，避免重复节点
            const alreadyDropped = rf.getNodes().some((n) => n.id === outNodeIdFor(genJobId));
            if (hit?.path && !alreadyDropped) actions.spawnOutputNode(cn.id, outId2, hit.path);
          } else {
            actions.patchConfig(cn.id, { generateJobId: null, batchStatus: null });
          }
          setGenBusy(false);
          setGenNote("");
        } else if (j.state === "FAILED" || j.state === "CANCELED") {
          window.clearInterval(pollRef.current!);
          pollRef.current = null;
          actions.patchConfig(cn.id, {
            generateJobId: null,
            generateError: j.error || t("任务失败"),
            batchStatus: null,
          });
          setGenBusy(false);
          setGenNote("");
        } else {
          setGenNote(`${j.state === "RUNNING" ? t("生成中") : j.state} ${Math.round((j.progress ?? 0) * 100)}%`);
        }
      } catch { /* 轮询失败下轮重试 */ }
    };
    void tick();
    pollRef.current = window.setInterval(tick, 1500);
    return () => {
      alive = false;
      if (pollRef.current) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [genJobId, cn?.id]);

  /** 卡内 ▶ 生成：聚合上游参考/文字约束 → canvasNodeRun → jobId 写入 config 触发轮询 */
  const runInlineGenerate = async () => {
    if (!cn || genBusy) return;
    const prompt = genPrompt.trim();
    if (!prompt && cn.type !== "video-clip") {
      toast(t("先输入提示词再生成"), "warn");
      return;
    }
    setGenBusy(true);
    setGenNote(t("任务入队…"));
    try {
      // v2.26.112：参考聚合走 ReactFlow 实时状态（连线即时生效，不等落盘）
      const { refIds, texts } = collectUpstreamLive(rf.getNodes(), rf.getEdges(), cn.id);
      const ownRefs = (Array.isArray(cn.config?.referenceAssetIds) ? cn.config.referenceAssetIds : []) as string[];
      const allRefs = [...new Set([...ownRefs, ...refIds])];
      const fullPrompt = texts.length > 0 ? [prompt, ...texts].join("\n") : prompt;
      const r = await api.canvasNodeRun({
        episodeId,
        nodeId: cn.id,
        prompt: fullPrompt || t("（按参考生成）"),
        aspect: cn.type === "image" || cn.type === "video" || cn.type === "video-clip" ? genAspect : undefined,
        referenceAssetIds: allRefs,
      });
      // prompt/画幅留痕到 config（检查器可查看），jobId 触发轮询 effect
      actions.patchConfig(cn.id, {
        prompt: fullPrompt,
        aspect: genAspect,
        generateJobId: r.jobId,
        generateError: null,
        referenceAssetIds: allRefs,
      });
    } catch (e) {
      setGenBusy(false);
      setGenNote("");
      actions.patchConfig(cn.id, { generateError: api.errMsg(e) });
    }
  };

  /** 素材节点卡内「＋上传」 */
  const uploadHere = async () => {
    if (!cn) return;
    await actions.uploadNodeFile(cn.id);
  };

  if (!cn) {
    return (
      <div className="cv-node">
      <div className="cv-node-head">
        <span className="cv-node-icon">❓</span>
          <span className="cv-node-title">{t("未知节点")}</span>
        </div>
      </div>
    );
  }

  const def = NODE_TYPE_DEFS[cn.type];
  const inputs = def?.inputs ?? [];
  const outputs = def?.outputs ?? [];
  const rows = Math.max(inputs.length, outputs.length, 1);

  // v2.26.26 素材节点：缩略图条（最多 3 张图片缩略 + 计数）
  const files = Array.isArray(cn.config?.files)
    ? ((cn.config?.files as unknown) as AssetFileMeta[])
    : [];
  const imgFiles = files.filter((f) => f.kind === "images" || isImagePath(f.path));

  const hasOutThumb = isMedia && !!resolvedPath;

  // 媒体类型判断（产物/素材预览共用；v2.26.156 剥离 ?/# 查询串，兼容历史脏数据 *.mp4?e）
  const isVideoPath = (p: string) => isVideoMediaPath(p);
  const isAudioPath = (p: string) => /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test((p || "").split(/[?#]/, 1)[0] ?? "");

  // v2.26.102 素材内容占满显示（LibTV 式）：素材节点的图片/视频内容直接大图/播放器占满卡主体
  const firstImg = files.find((f) => f.kind === "images" || isImagePath(f.path));
  const firstVideo = files.find((f) => f.kind === "videos" || isVideoPath(f.path));
  const assetPreview: { path: string; h: number; video: boolean } | null =
    isAsset && (firstImg || firstVideo)
      ? firstImg
        ? { path: firstImg.path, h: 230, video: false }
        : { path: firstVideo!.path, h: 170, video: true }
      : null;

  // v2.26.101 产物大预览（LibTV 式）：生成节点有产物后，卡片主体直接显示生成结果——
  // 图片全宽大图 / 视频内嵌播放器 / 配音音频条，这才是"生成的产物在画布上显示"。
  const outPreviewH =
    resolvedPath && isMedia
      ? isAudioPath(resolvedPath)
        ? 44
        : isVideoPath(resolvedPath)
          ? 170
          : 230
      : 0;
  const hasOutPreview = isMedia && !!resolvedPath && outPreviewH > 0;

  // v2.26.27 运行状态徽标（批量运行写入 batchStatus；面板直发成功写 status=ready）
  const batchStatus = typeof cn.config?.batchStatus === "string" ? (cn.config.batchStatus as string) : "";
  const batchNote = typeof cn.config?.batchNote === "string" ? (cn.config.batchNote as string) : "";
  const runBadge =
    batchStatus === "done" ? { icon: "✅", title: batchNote || t("已执行完成") }
    : batchStatus === "skipped" ? { icon: "⏭️", title: batchNote || t("已跳过") }
    : batchStatus === "awaiting_review" ? { icon: "⏸️", title: batchNote || t("等待人工审核") }
    : null;

  const badge = cn.config?.locked === true ? "🔒" : cn.config?.disabled === true ? "⏸" : runBadge?.icon ?? null;
  const badgeTitle =
    cn.config?.locked === true ? t("已锁定")
    : cn.config?.disabled === true ? t("已禁用（批量运行跳过）")
    : runBadge?.title ?? "";

  const showGenBar = (isInlineGen || isText || isAsset) && cn.config?.locked !== true;
  const extraH = showGenBar
    ? isInlineGen ? GEN_H : isText ? TEXT_H : isAsset ? QUICK_H : 0
    : 0;
  const locked = cn.config?.locked === true;

  return (
    <div
      className={`cv-node${props.selected ? " selected" : ""}`}
      style={{
        height:
          HEAD_H + rows * ROW_H + SUMMARY_H
          + (assetPreview ? assetPreview.h : isAsset && files.length > 0 ? THUMB_H : 0)
          + (hasOutPreview ? outPreviewH : hasOutThumb ? THUMB_H : 0)
          + extraH,
      }}
    >
      <div className="cv-node-head">
        <span className="cv-node-icon">{NODE_ICONS[cn.type] ?? "⬜"}</span>
        <span className="cv-node-title">{def ? t(def.title) : cn.title}</span>
        {badge && (
          <span style={{ marginLeft: "auto", fontSize: 11, flexShrink: 0 }} title={badgeTitle}>
            {badge}
          </span>
        )}
        <span className="cv-node-type" title={cn.type}>{def ? t(def.title) : t("节点")}</span>
      </div>

      {/* v2.26.19 单连接点（LibTV/即梦式）：每节点 1 输入点 + 1 输出点，可多连；逻辑端口由类型自动匹配 */}
      {inputs.length > 0 && (
        <Handle
          type="target"
          position={Position.Left}
          id={inputs[0].port}
          className="cv-handle"
          style={{ top: HEAD_H + (rows * ROW_H) / 2 }}
          title={t("输入连接点（可接入多条连线，类型自动匹配）")}
        />
      )}
      {outputs.length > 0 && (
        <Handle
          type="source"
          position={Position.Right}
          id={outputs[0].port}
          className="cv-handle"
          style={{ top: HEAD_H + (rows * ROW_H) / 2 }}
          title={t("输出连接点（可接出多条连线，类型自动匹配）")}
        />
      )}
      {hasOutPreview ? (
        /* v2.26.101 产物大预览：生成的图片/视频直接显示在节点内（LibTV 式） */
        <div
          className="cv-node-out-preview"
          style={{ top: HEAD_H + rows * ROW_H, height: outPreviewH }}
          title={t("生成产物（双击节点打开面板重新生成）")}
        >
          {isVideoPath(resolvedPath) ? (
            <video src={assetUrl(resolvedPath)} controls preload="metadata" />
          ) : isAudioPath(resolvedPath) ? (
            <div className="cv-out-audio">
              <span>🎧</span>
              <audio src={assetUrl(resolvedPath)} controls preload="metadata" style={{ flex: 1, height: 30 }} />
            </div>
          ) : (
            <img src={assetUrl(resolvedPath)} alt={t("生成产物")} />
          )}
        </div>
      ) : hasOutThumb && (
        <div className="cv-node-thumbs cv-node-out" title={t("生成产物（双击节点打开面板查看/重生成）")}>
          {isImagePath(resolvedPath) ? (
            <img src={assetUrl(resolvedPath)} alt={t("生成产物")} />
          ) : (
            <span className="cv-node-thumb-more">🎬</span>
          )}
          <span className="cv-node-thumb-count">{t("产物")}</span>
        </div>
      )}
      {assetPreview ? (
        /* v2.26.102 素材内容占满显示（LibTV 式）：上传的图片/视频就是本节点的全部内容 */
        <div
          className="cv-node-out-preview"
          style={{ top: HEAD_H + rows * ROW_H, height: assetPreview.h }}
          title={files.map((f) => f.name).join("\n")}
        >
          {assetPreview.video ? (
            <video src={assetUrl(assetPreview.path)} controls preload="metadata" />
          ) : (
            <img src={assetUrl(assetPreview.path)} alt={files[0]?.name ?? t("素材")} />
          )}
          {files.length > 1 && (
            <span className="cv-node-thumb-count" style={{ position: "absolute", right: 6, bottom: 4 }}>
              {files.length} 个素材
            </span>
          )}
        </div>
      ) : isAsset && files.length > 0 && (
        <div className="cv-node-thumbs" title={files.map((f) => f.name).join("\n")}>
          {imgFiles.slice(0, 3).map((f) => (
            <img key={f.id} src={assetUrl(f.path)} alt={f.name} />
          ))}
          {imgFiles.length < files.length && (
            <span className="cv-node-thumb-more">📎{files.length - imgFiles.length}</span>
          )}
          <span className="cv-node-thumb-count">{files.length} 个素材</span>
        </div>
      )}
      <div
        className="cv-node-summary"
        style={{ bottom: 7 + extraH }}
        title={JSON.stringify(cn.config ?? {})}
      >
        {isAsset
          ? files.length > 0
            ? t("{n} 个素材文件（连线给生成节点作参考）", { n: files.length })
            : t("点下方「＋上传」或拖文件进画布")
          : configSummary(cn.config)}
      </div>

      {/* ---------- v2.26.31 LibTV 式卡内操作区 ---------- */}
      {isInlineGen && (
        <div className="cv-node-gen" onDoubleClick={(e) => e.stopPropagation()}>
          <textarea
            className="cv-node-gen-input"
            rows={2}
            placeholder={t("输入提示词，直接生成…")}
            value={genPrompt}
            disabled={locked || genBusy}
            onChange={(e) => setGenPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void runInlineGenerate();
              }
            }}
          />
          <div className="cv-node-gen-row">
            {(cn.type === "image" || cn.type === "video" || cn.type === "video-clip") && (
              <select
                className="cv-node-gen-aspect"
                value={genAspect}
                disabled={locked || genBusy}
                onChange={(e) => setGenAspect(e.target.value)}
                title={t("画幅")}
              >
                <option value="9:16">9:16</option>
                <option value="16:9">16:9</option>
                <option value="1:1">1:1</option>
              </select>
            )}
            <button
              className="cv-node-gen-btn"
              disabled={locked || genBusy}
              title={t("直接在节点上生成（上游连线自动作为参考/文字约束）")}
              onClick={() => void runInlineGenerate()}
            >
              {genBusy ? `⏳ ${genNote || t("生成中…")}` : t("▶ 生成")}
            </button>
          </div>
          {genError && (
            <div className="cv-node-gen-err" title={genError}>
              {genError.length > 40 ? `${genError.slice(0, 40)}…` : genError}
            </div>
          )}
        </div>
      )}
      {isText && (
        <textarea
          className="cv-node-gen-input cv-node-text-edit"
          placeholder={t("输入文案…（连线给生成节点即作为文字约束）")}
          value={String(cn.config?.text ?? "")}
          disabled={locked}
          onChange={(e) => actions.patchConfig(cn.id, { text: e.target.value })}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      )}
      {isAsset && (
        <div className="cv-node-quick" onDoubleClick={(e) => e.stopPropagation()}>
          <button className="cv-node-quick-btn" disabled={locked} title={t("上传本地素材入资产库")} onClick={() => void uploadHere()}>
            ＋{t("上传")}
          </button>
          <button
            className="cv-node-quick-btn"
            disabled={locked || files.length === 0}
            title={t("在旁边创建生图节点并自动连线（本节点素材作参考）")}
            onClick={() => actions.spawnGenerateNode(cn.id, "image")}
          >
            🖼 {t("生图")}
          </button>
          <button
            className="cv-node-quick-btn"
            disabled={locked || files.length === 0}
            title={t("在旁边创建生视频节点并自动连线（本节点素材作参考）")}
            onClick={() => actions.spawnGenerateNode(cn.id, "video")}
          >
            🎬 {t("生视频")}
          </button>
        </div>
      )}
    </div>
  );
}
