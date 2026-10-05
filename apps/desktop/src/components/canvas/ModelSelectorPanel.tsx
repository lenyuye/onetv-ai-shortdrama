/**
 * 生成模型选择器（展示型子组件，从 CanvasView 拆出，DOM/文案/派生逻辑不变）：
 * 选中生成类节点时显示 Provider / 模型两级下拉（写入 config.providerId / config.modelId），
 * 按节点类型的模型能力过滤可选列表；历史值已不可用时兜底显示原值。
 */
import type { Capability, CanvasNode, NodeType } from "@onetv/shared-types";
import type { ProviderDto } from "../../api-providers";
import { useT } from "../../i18n";

/**
 * 生成类节点 → 模型选择器按此能力过滤 Provider 模型列表。
 * text/condition/review/export 为本地/人工节点，不涉及模型生成，不显示选择器。
 */
export const MODEL_CAPS_BY_NODE: Partial<Record<NodeType, Capability[]>> = {
  script: ["chat"],
  storyboard: ["chat"],
  image: ["image_generation"],
  video: ["video_generation"],
  audio: ["tts"],
  "video-clip": ["video_edit", "video_generation"],
};

/** 节点类型对应的模型能力（非生成类节点为 undefined → 不显示选择器）。 */
export const modelCapsOf = (type: NodeType): Capability[] | undefined => MODEL_CAPS_BY_NODE[type];

export interface ModelSelectorPanelProps {
  node: CanvasNode;
  providers: ProviderDto[];
  onConfigChange: (patch: Record<string, unknown>) => void;
  onEditStart: () => void;
  onEditEnd: () => void;
}

export default function ModelSelectorPanel({
  node,
  providers,
  onConfigChange,
  onEditStart,
  onEditEnd,
}: ModelSelectorPanelProps) {
  const t = useT();

  // 选中节点的模型能力过滤（非生成类节点 modelCaps 为 undefined → 不显示选择器）
  const modelCaps = MODEL_CAPS_BY_NODE[node.type];
  if (!modelCaps) return null;
  const eligibleProviders = providers.filter((p) =>
    p.models.some((m) => modelCaps.some((c) => m.capabilities.includes(c)))
  );
  const rawProviderId = node.config?.providerId;
  const selProviderId = typeof rawProviderId === "string" ? rawProviderId : "";
  const selProvider = eligibleProviders.find((p) => p.id === selProviderId) ?? null;
  const eligibleModels = selProvider
    ? selProvider.models.filter((m) => modelCaps.some((c) => m.capabilities.includes(c)))
    : [];
  const rawModelId = node.config?.modelId;
  const selModelId = typeof rawModelId === "string" ? rawModelId : "";

  const handleProviderChange = (v: string) => {
    // 切换 / 清空 Provider 时，原模型引用不再可靠，一并清空（换厂商需重选模型）
    onConfigChange({ providerId: v, modelId: "" });
  };
  const handleModelChange = (v: string) => {
    onConfigChange({ modelId: v });
  };

  return (
    <div
      style={{
        background: "var(--panel)",
        borderLeft: "1px solid var(--border)",
        borderBottom: "1px solid var(--border)",
        padding: "12px",
        flexShrink: 0,
      }}
    >
      <div className="cv-inspector-title">{t("生成模型")}</div>
      <div className="field">
        <label>Provider</label>
        <select
          value={selProviderId}
          onFocus={onEditStart}
          onBlur={onEditEnd}
          onChange={(e) => handleProviderChange(e.target.value)}
        >
          <option value="">{t("跟随生成模型设置 / 自动路由")}</option>
          {eligibleProviders.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
          {selProviderId && !selProvider && (
            <option value={selProviderId}>{t("{id}（已不可用）", { id: selProviderId })}</option>
          )}
        </select>
      </div>
      <div className="field">
        <label>{t("模型")}</label>
        <select
          value={selModelId}
          disabled={!selProviderId}
          onFocus={onEditStart}
          onBlur={onEditEnd}
          onChange={(e) => handleModelChange(e.target.value)}
        >
          <option value="">
            {selProviderId ? t("自动（Provider 默认模型）") : t("跟随生成模型设置 / 自动路由")}
          </option>
          {eligibleModels.map((m) => (
            <option key={m.modelId} value={m.modelId}>
              {m.displayName && m.displayName !== m.modelId
                ? `${m.displayName} · ${m.modelId}`
                : m.modelId}
            </option>
          ))}
          {selModelId && !eligibleModels.some((m) => m.modelId === selModelId) && (
            <option value={selModelId}>{t("{id}（已不可用）", { id: selModelId })}</option>
          )}
        </select>
      </div>
      <div className="hint">{t("留空 = 使用模型页「生成模型设置」的默认模型")}</div>
    </div>
  );
}
