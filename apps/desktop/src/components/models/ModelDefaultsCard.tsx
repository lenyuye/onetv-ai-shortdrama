/**
 * ModelDefaultsCard —— 🎯 生成模型设置卡片（settings.modelDefaults，规格 §22.1）。
 *
 * 对话/图片/视频/配音四个能力的默认模型，即选即存；选「自动路由」即清除该 key
 * （IPC 传 null，undefined 会被 JSON 序列化丢弃）。选项 = 已启用 Provider 中具备
 * 该能力的模型按 Provider 分组；当前值不可用（停用/删除）时保留展示并提示回退。
 * 纯展示：保存经 onChange 上抛给 ModelsView 主组件。
 */
import type {
  ModelDefaultCapability,
  ModelDefaults,
  ModelRef,
} from "@onetv/shared-types";
import type { ProviderDto } from "../../api-providers";
import * as api from "../../api-providers";
import { useT } from "../../i18n";

function providerNameOf(id: string, providers: ProviderDto[]): string {
  return providers.find((p) => p.id === id)?.name ?? id;
}

export function ModelDefaultsCard({
  providers,
  defaults,
  busy,
  onChange,
}: {
  providers: ProviderDto[];
  defaults: ModelDefaults | undefined;
  busy: boolean;
  onChange: (cap: ModelDefaultCapability, ref: ModelRef | null) => void;
}) {
  const t = useT();
  return (
    <div className="card md-card">
      <h3>{t("🎯 生成模型设置")}</h3>
      <div className="hint" style={{ marginBottom: 10 }}>
        {t("用于所有生成入口的默认模型；在对话/剧本/画布中也可临时选择其他模型，临时选择优先于这里")}
      </div>
      <div className="md-rows">
        {api.MODEL_DEFAULT_ROWS.map((row) => {
          const cap = api.MODEL_DEFAULT_CAP[row.key];
          const cur = defaults?.[row.key] ?? null;
          const curVal = cur ? api.modelOptionValue(cur) : "";
          // 选项 = 所有已启用 Provider 中具备该能力的模型，按 Provider 分组
          const usable = providers.filter(
            (p) => p.enabled && p.models.some((m) => m.capabilities.includes(cap)),
          );
          const curUsable =
            !!cur &&
            usable.some(
              (p) =>
                p.id === cur.providerId &&
                p.models.some((m) => m.modelId === cur.modelId && m.capabilities.includes(cap)),
            );
          return (
            <div className="md-row" key={row.key}>
              <label>{row.label}</label>
              <select
                value={curVal}
                disabled={busy}
                onChange={(e) => onChange(row.key, api.parseModelOptionValue(e.target.value))}
              >
                <option value="">{t("自动路由（默认）")}</option>
                {usable.map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    {p.models
                      .filter((m) => m.capabilities.includes(cap))
                      .map((m, i) => (
                        <option
                          key={`${m.modelId}-${i}`}
                          value={api.modelOptionValue({ providerId: p.id, modelId: m.modelId })}
                        >
                          {p.name} · {m.modelId}
                        </option>
                      ))}
                  </optgroup>
                ))}
                {cur && !curUsable && <option value={curVal}>{t("{name} · {model}（当前不可用）", { name: providerNameOf(cur.providerId, providers), model: cur.modelId })}</option>}
              </select>
              {cur && !curUsable && (
                <span className="md-stale">{t("⚠️ 所选模型已停用/删除，任务将回退自动路由")}</span>
              )}
            </div>
          );
        })}
      </div>
      {providers.filter((p) => p.enabled).length === 0 && (
        <div className="hint" style={{ marginTop: 8 }}>
          {t("暂无已启用的 Provider —— 先在下方添加 / 启用，再回到这里选择默认模型")}
        </div>
      )}
    </div>
  );
}
