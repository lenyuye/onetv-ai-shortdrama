/**
 * 自定义画布节点卡片 —— 显示类型图标、标题（NODE_TYPE_DEFS）、参数摘要（config 前 2 个键值）
 * 以及输入/输出端口手柄（accept 类型从 NODE_TYPE_DEFS 取）。
 */
import { Handle, Position } from "@xyflow/react";
import type { NodeProps } from "@xyflow/react";
import { NODE_TYPE_DEFS } from "@onetv/node-sdk";
import type { CanvasNode } from "@onetv/shared-types";
import { useT } from "../../i18n";
import { assetUrl } from "../../api-assets";
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

export default function CanvasNodeCard(props: NodeProps) {
  const t = useT();
  const cn = (props.data as { cn?: CanvasNode }).cn;
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
  // v2.14：禁用/锁定徽标
  const badge = cn.config?.locked === true ? "🔒" : cn.config?.disabled === true ? "⏸" : null;
  const badgeTitle = cn.config?.locked === true ? t("已锁定") : t("已禁用（批量运行跳过）");
  const inputs = def?.inputs ?? [];
  const outputs = def?.outputs ?? [];
  const rows = Math.max(inputs.length, outputs.length, 1);

  // v2.26.26 素材节点：缩略图条（最多 3 张图片缩略 + 计数）
  const files = Array.isArray(cn.config?.files)
    ? ((cn.config?.files as unknown) as AssetFileMeta[])
    : [];
  const isAsset = cn.type === "asset";
  const imgFiles = files.filter((f) => f.kind === "images" || /\.(png|jpe?g|webp|gif)$/i.test(f.path));

  return (
    <div
      className={`cv-node${props.selected ? " selected" : ""}`}
      style={{ height: HEAD_H + rows * ROW_H + SUMMARY_H + (isAsset && files.length > 0 ? THUMB_H : 0) }}
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
