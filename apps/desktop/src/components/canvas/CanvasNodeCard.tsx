/**
 * 自定义画布节点卡片 —— 显示类型图标、标题（NODE_TYPE_DEFS）、参数摘要（config 前 2 个键值）
 * 以及输入/输出端口手柄（accept 类型从 NODE_TYPE_DEFS 取）。
 * v2.26.27（即梦式）：运行状态徽标（批量 ✓/⏭/⏸）+ 生成产物缩略图直接上卡片。
 */
import { useEffect, useState } from "react";
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { NODE_TYPE_DEFS } from "@onetv/node-sdk";
import type { CanvasNode } from "@onetv/shared-types";
import { useT } from "../../i18n";
import { assetList, assetUrl } from "../../api-assets";
import { NODE_ICONS, configSummary, portCn } from "./canvas-model";

/** 与 canvas.css 中 .cv-node-head 高度保持一致。 */
const HEAD_H = 40;
const ROW_H = 22;
const SUMMARY_H = 30;
/** 素材节点缩略图条高度（v2.26.26） */
const THUMB_H = 46;

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

export default function CanvasNodeCard(props: NodeProps) {
  const t = useT();
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
  }, [outId, cfgOutPath]);

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
  const isAsset = cn.type === "asset";
  const imgFiles = files.filter((f) => f.kind === "images" || isImagePath(f.path));

  const hasOutThumb = isMedia && !!resolvedPath;

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

  return (
    <div
      className={`cv-node${props.selected ? " selected" : ""}`}
      style={{
        height:
          HEAD_H + rows * ROW_H + SUMMARY_H
          + (isAsset && files.length > 0 ? THUMB_H : 0)
          + (hasOutThumb ? THUMB_H : 0),
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
      {hasOutThumb && (
        <div className="cv-node-thumbs cv-node-out" title={t("生成产物（双击节点打开面板查看/重生成）")}>
          {isImagePath(resolvedPath) ? (
            <img src={assetUrl(resolvedPath)} alt={t("生成产物")} />
          ) : (
            <span className="cv-node-thumb-more">🎬</span>
          )}
          <span className="cv-node-thumb-count">{t("产物")}</span>
        </div>
      )}
      {isAsset && files.length > 0 && (
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
      <div className="cv-node-summary" title={JSON.stringify(cn.config ?? {})}>
        {isAsset
          ? files.length > 0
            ? t("{n} 个素材文件（连线给生成节点作参考）", { n: files.length })
            : t("点击「上传素材」选择本地文件")
          : configSummary(cn.config)}
      </div>
    </div>
  );
}
