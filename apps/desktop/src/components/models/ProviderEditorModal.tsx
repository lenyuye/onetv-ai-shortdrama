/**
 * ProviderEditorModal —— 新增 / 编辑 Provider modal（ModelsView 子组件）。
 *
 * - 驱动下拉（PROVIDER_DRIVERS，切换自动填默认 Base URL / 超时并净化能力勾选）
 * - 平台预设一键填充（新增时可选：选平台 → 填 API Key → 保存即用）
 * - 模型区域为多模型列表编辑（modelId + 显示名 + 单价 ¥/次 + 能力多选 + 删除）；
 *   「读取模型并合并」结果按 modelId 去重并入；SD / ComfyUI 驱动仅允许勾选生图
 * - custom-http 驱动提供 httpTemplate JSON 模板（白名单变量 ${input.*} / ${model.id} /
 *   ${secret.apiKey} / ${jobId}）；comfyui 驱动提供工作流 JSON（含 Wan2.1 图生视频示例）
 * - 纯展示：草稿状态与保存编排分别留在 useProviderEditor / ModelsView 主组件
 */
import { PROVIDER_DRIVERS } from "@onetv/provider-sdk";
import type { ProviderDriver } from "@onetv/shared-types";
import type { GenPresetDto } from "../../api-providers";
import * as api from "../../api-providers";
import { t, useT } from "../../i18n";
import type { EditorDraft } from "../../hooks/useProviderEditor";

/** Wan2.1 图生视频示例工作流（ComfyUI API 格式，原生节点）。
 *  权重文件名按本机 ComfyUI models 目录实际下载的为准；
 *  __prompt__/__negative__ 为提示词占位，seed=0 每次随机，
 *  __width__/__height__/__frames__ 由画幅与时长自动推导。 */
const WAN_I2V_EXAMPLE = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.1_i2v_b_480p_fp8_e4m3fn.safetensors" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
  "4": { class_type: "CLIPVisionLoader", inputs: { clip_name: "clip_vision_h.safetensors" } },
  "5": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["4", 0], image: ["12", 0], crop: "center" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "__prompt__", clip: ["2", 0] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "__negative__", clip: ["2", 0] } },
  "8": { class_type: "LoadImage", inputs: { image: "__IMAGE__" } },
  "9": { class_type: "WanImageToVideo", inputs: { positive: ["6", 0], negative: ["7", 0], vae: ["3", 0], width: "__width__", height: "__height__", length: "__frames__", batch_size: 1, clip_vision_output: ["5", 0], start_image: ["8", 0] } },
  "10": { class_type: "KSampler", inputs: { seed: 0, steps: 25, cfg: 6.0, sampler_name: "uni_pc", scheduler: "simple", denoise: 1.0, model: ["1", 0], positive: ["9", 0], negative: ["9", 1], latent_image: ["9", 2] } },
  "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["3", 0] } },
  "12": { class_type: "SaveWEBM", inputs: { images: ["11", 0], filename_prefix: "onetv_wan", codec: "vp9", fps: 16, quality: 85 } },
};

/** HTTP 模板提示（UI 文案，渲染期经 i18n；注意：${jobId} 等为模板变量原文，非 t() 占位符） */
const httpTemplateHint = () =>
  t("模板变量白名单：${input.*}、${model.id}、${secret.apiKey}、${jobId}；禁止任意脚本执行。") +
  t('示例：{"method":"POST","url":"https://api.example.com/v1/generate","headers":{"Authorization":"Bearer ${secret.apiKey}"},"body":{"prompt":"${input.prompt}","jobId":"${jobId}"}}');

export function ProviderEditorModal({
  editor,
  presets,
  presetSel,
  setPresetSel,
  applyPreset,
  patchDraft,
  changeDriver,
  toggleCap,
  patchModel,
  addModelRow,
  removeModelRow,
  readModelsIntoEditor,
  editorReading,
  saving,
  onClose,
  onSave,
}: {
  editor: EditorDraft;
  presets: GenPresetDto[];
  presetSel: string;
  setPresetSel: (id: string) => void;
  applyPreset: (id: string) => void;
  patchDraft: (patch: Partial<EditorDraft>) => void;
  changeDriver: (driver: ProviderDriver) => void;
  toggleCap: (idx: number, cap: EditorDraft["models"][number]["capabilities"][number]) => void;
  patchModel: (idx: number, patch: Partial<EditorDraft["models"][number]>) => void;
  addModelRow: () => void;
  removeModelRow: (idx: number) => void;
  readModelsIntoEditor: () => Promise<void>;
  editorReading: boolean;
  saving: boolean;
  onClose: () => void;
  onSave: () => void;
}) {
  const t = useT();
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: "min(780px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{editor.id ? t("编辑 Provider · {name}", { name: editor.name }) : t("新增 Provider")}</span>
          <button className="btn sm ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>{t("名称 *")}</label>
            <input
              type="text"
              value={editor.name}
              placeholder={t("例如：OpenAI 中转 / 本机 Ollama")}
              onChange={(e) => patchDraft({ name: e.target.value })}
            />
          </div>

          <div className="field">
            <label>{t("驱动")}</label>
            <select value={editor.driver} onChange={(e) => changeDriver(e.target.value as ProviderDriver)}>
              {PROVIDER_DRIVERS.map((d) => (
                <option key={d.driver} value={d.driver}>{d.label} — {d.description}</option>
              ))}
            </select>
          </div>

          {!editor.id && presets.length > 0 && (
            <div className="field" style={{ background: "var(--panel-2)", borderRadius: 8, padding: 12, border: "1px dashed var(--border-strong)" }}>
              <label>{t("⚡ 平台预设一键填充（选平台 → 填 API Key → 保存即用）")}</label>
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  value={presetSel}
                  onChange={(e) => setPresetSel(e.target.value)}
                  aria-label={t("选择平台预设")}
                  style={{ flex: 1 }}
                >
                  <option value="">{t("选择平台预设（通用 / 图片 / 视频生成）…")}</option>
                  <optgroup label={t("通用功能")}>
                    {presets.filter((x) => x.category === "chat").map((x) => (
                      <option key={x.id} value={x.id}>{x.name}</option>
                    ))}
                  </optgroup>
                  <optgroup label={t("🖼️ 图片生成")}>
                    {presets.filter((x) => x.category === "image").map((x) => (
                      <option key={x.id} value={x.id}>{x.name}</option>
                    ))}
                  </optgroup>
                  <optgroup label={t("🎬 视频生成")}>
                    {presets.filter((x) => x.category === "video").map((x) => (
                      <option key={x.id} value={x.id}>{x.name}</option>
                    ))}
                  </optgroup>
                </select>
                <button className="btn blue" disabled={!presetSel} onClick={() => applyPreset(presetSel)}>
                  {t("套用")}
                </button>
              </div>
              {(() => {
                const p = presets.find((x) => x.id === presetSel);
                if (!p) return null;
                return (
                  <span className="sub" style={{ display: "block", marginTop: 6 }}>
                    {p.notes}
                    {"  "}
                    <a href={p.docsUrl} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>{t("官方文档 ↗")}</a>
                  </span>
                );
              })()}
            </div>
          )}

          <div className="field">
            <label>{t("Base URL *")}</label>
            <input
              type="text"
              value={editor.baseUrl}
              placeholder="https://api.example.com/v1"
              onChange={(e) => patchDraft({ baseUrl: e.target.value })}
            />
            <span className="sub">{t("切换驱动时自动填入该驱动的默认地址；Ollama 默认 http://127.0.0.1:11434")}</span>
          </div>

          <div className="mv-2col">
            <div className="field">
              <label>{t("超时（毫秒）")}</label>
              <input
                type="number"
                min={1000}
                value={editor.timeoutMs}
                onChange={(e) => patchDraft({ timeoutMs: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="field">
              <label>{t("最大并发数")}</label>
              <input
                type="number"
                min={1}
                max={16}
                value={editor.concurrency}
                onChange={(e) => patchDraft({ concurrency: Number(e.target.value) || 1 })}
              />
            </div>
          </div>

          <div className="field">
            <label>{t("API Key")} {editor.id && t("（留空保持不变）")}</label>
            <input
              type="password"
              value={editor.apiKey}
              placeholder={editor.id ? "••••••••" : "sk-…"}
              autoComplete="off"
              onChange={(e) => patchDraft({ apiKey: e.target.value })}
            />
            <span className="sub">{t("🔒 Key 只存入 macOS 钥匙串（Keychain），不落 SQLite / 项目文件 / 日志")}</span>
          </div>

          <div className="field">
            <div className="mv-model-head">
              <label>{t("模型管理（可配置多个：modelId + 显示名 + 能力）")}</label>
              {editor.id ? (
                <button
                  className="btn sm"
                  disabled={editorReading}
                  title={t("拉取该 Provider 远端模型列表，按 modelId 去重后合并进下方列表（不覆盖已填内容）")}
                  onClick={() => void readModelsIntoEditor()}
                >
                  {editorReading ? t("读取中…") : t("⟳ 读取模型并合并")}
                </button>
              ) : (
                <span className="sub">{t("创建后将自动拉取远端模型列表并合并；也可保存后在「编辑」里手动读取")}</span>
              )}
            </div>
            {editor.driver === "stable-diffusion" ? (
              <span className="sub">
                {t("⚠️ 该驱动仅支持「生图」能力（后端会拒绝其他组合），已自动限制可勾选项")}
              </span>
            ) : null}
            {editor.driver === "comfyui" ? (
              <span className="sub">
                {t("生图恒可用；勾选「生视频」需在下方填写工作流模板（Wan 等本地工作流），保存时会校验")}
              </span>
            ) : null}
            {editor.models.length === 0 && (
              <span className="sub">{t("尚无模型：点击「➕ 添加模型」手工填写，或用「读取模型并合并」拉取")}</span>
            )}
            {editor.models.map((m, i) => {
              const allowed = api.driverAllowedCaps(editor.driver);
              // 表单外既有能力（vision / embedding 等）不在 checkbox 中展示，保存时原样保留
              const extra = m.capabilities.filter(
                (c) => !api.EDITOR_CAPABILITY_OPTIONS.some((o) => o.value === c),
              );
              return (
                <div className="mv-model-row" key={i}>
                  <div className="mv-model-grid">
                    <input
                      type="text"
                      value={m.modelId}
                      placeholder={t("modelId，例如 gpt-4o / qwen2.5:7b")}
                      onChange={(e) => patchModel(i, { modelId: e.target.value })}
                    />
                    <input
                      type="text"
                      value={m.displayName}
                      placeholder={t("显示名（可留空）")}
                      onChange={(e) => patchModel(i, { displayName: e.target.value })}
                    />
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      style={{ maxWidth: 120 }}
                      title={t("单价（元/次）：预算守卫金额化的计价依据；不填则该模型不计金额")}
                      value={m.pricePerCall ?? ""}
                      placeholder={t("单价 ¥/次")}
                      onChange={(e) => patchModel(i, { pricePerCall: e.target.value === "" ? null : Number(e.target.value) })}
                    />
                    <button className="btn sm danger" onClick={() => removeModelRow(i)}>{t("删除")}</button>
                  </div>
                  <div className="mv-cap-checks">
                    {api.EDITOR_CAPABILITY_OPTIONS.map((c) => {
                      const blocked = !!allowed && !allowed.includes(c.value);
                      return (
                        <label
                          key={c.value}
                          className={`mv-cap-check ${blocked ? "off" : ""}`}
                          title={blocked ? t("该驱动不支持此能力（后端会拒绝非法组合）") : undefined}
                        >
                          <input
                            type="checkbox"
                            checked={m.capabilities.includes(c.value)}
                            disabled={blocked}
                            onChange={() => toggleCap(i, c.value)}
                          />
                          {c.label}
                        </label>
                      );
                    })}
                    {extra.length > 0 && (
                      <span className="mv-extra-caps" title={t("既有能力，保存时原样保留")}>
                        {extra.map((c) => (
                          <span key={c} className="tag pink">{api.capabilityLabel(c)}</span>
                        ))}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
            <div>
              <button className="btn sm" onClick={addModelRow}>{t("➕ 添加模型")}</button>
            </div>
          </div>

          {editor.driver === "comfyui" && (
            <div className="field">
              <label>{t("ComfyUI 工作流模板（API 格式 JSON；FLUX 出图 / Wan 生视频）")}</label>
              <textarea
                value={editor.workflowTemplateText}
                style={{ minHeight: 140, fontFamily: "var(--mono)" }}
                placeholder={t('在 ComfyUI 排好工作流 → 设置里开启「启用 Dev 模式 / API 格式」→ Save (API Format) 导出 JSON 粘贴到这里。\n占位符：文本节点写 __prompt__（正面）与 __negative__（负面）；seed / noise_seed 填 0 = 每次随机。\n图生视频/图生图：首帧参考图会自动上传并填入所有 LoadImage 类节点。')}
                onChange={(e) => patchDraft({ workflowTemplateText: e.target.value })}
              />
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <button
                  className="btn sm"
                  title={t("填入 Wan2.1 图生视频的示例工作流（原生节点），权重文件名按你本机实际下载的改")}
                  onClick={() => patchDraft({ workflowTemplateText: JSON.stringify(WAN_I2V_EXAMPLE, null, 2) })}
                >
                  {t("📥 载入 Wan 图生视频示例")}
                </button>
              </div>
              <span className="sub">
                {t("留空 = 内置 SD 工作流（仅生图）；填写后按工作流执行，产物（图片/视频）自动入库。本地直连不出公网。__width__/__height__/__frames__ 由画幅与时长自动推导，无须手填。")}
              </span>
            </div>
          )}

          {editor.driver === "custom-http" && (
            <div className="field">
              <label>{t("HTTP 请求模板（JSON）")}</label>
              <textarea
                value={editor.httpTemplateText}
                style={{ minHeight: 120, fontFamily: "var(--mono)" }}
                placeholder={httpTemplateHint()}
                onChange={(e) => patchDraft({ httpTemplateText: e.target.value })}
              />
              <span className="sub">{httpTemplateHint()}</span>
            </div>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t("取消")}</button>
          <button className="btn primary" disabled={saving} onClick={onSave}>
            {saving ? t("保存中…") : editor.id ? t("保存修改") : t("创建")}
          </button>
        </div>
      </div>
    </div>
  );
}
