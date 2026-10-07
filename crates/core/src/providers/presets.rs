//! 生成平台预设模板库（v2.6.4；v2.25.0 增加通用对话类）—— 通用 LLM + 图片 + 视频。
//!
//! 通用对话预设填充「自定义 / OpenAI 兼容」Provider（driver=base_url+默认模型，无模板）；
//! 图片/视频预设填充 Custom HTTP Provider（提交/轮询模板、默认模型），
//! 目标是「选平台 → 填 Key → 即用」。custom_http 模板 URL 一律为绝对地址（不做 base_url 拼接）。
//!
//! 模板变量白名单（与 custom_http.rs 一致）：`${input.*}`、`${model.id}`、
//! `${secret.apiKey}`、`${jobId}`；视频 input 含 prompt / aspectRatio /
//! durationSec / firstFrameBase64（首帧参考图 data URI，可空）/ references；
//! 图片 input 含 prompt / aspectRatio。
//!
//! ⚠️ 各平台 API 会演进：预设是「可用基线」，字段以平台最新文档为准，套用后可任意修改。

use serde_json::{json, Value};

pub struct GenPreset {
    /// "chat" | "image" | "video"
    pub category: &'static str,
    /// "custom-http"（图片/视频，带模板）| "openai-compatible"（通用对话，填 base_url）
    pub driver: &'static str,
    /// openai-compatible 预设的 Base URL（custom-http 时为空串，地址取模板 URL origin）
    pub base_url: &'static str,
    pub id: &'static str,
    pub name: &'static str,
    pub vendor: &'static str,
    pub docs_url: &'static str,
    pub auth_type: &'static str,
    /// custom-header 时使用的鉴权头名
    pub header_name: Option<&'static str>,
    pub default_model: (&'static str, &'static str),
    pub notes: &'static str,
    /// 提交+轮询模板（HttpTemplate JSON，URL 为绝对地址）
    pub template: Value,
}

/// 全部内置预设（顺序即 UI 展示顺序）。
pub fn gen_presets() -> Vec<GenPreset> {
    vec![
        /* ==================== 通用（对话 / 文本，OpenAI 兼容） ====================
         * 填充「自定义 / OpenAI 兼容」Provider：驱动 + Base URL + 默认模型 + 对话能力。
         * 适合剧本/拆分/结构化输出等一切文本生成用途；各平台模型 ID 会持续更新，套用后可改。 */
        // ---------------- DeepSeek ----------------
        GenPreset {
            category: "chat",
            driver: "openai-compatible",
            base_url: "https://api.deepseek.com/v1",
            id: "deepseek",
            name: "DeepSeek（官方 API）",
            vendor: "深度求索",
            docs_url: "https://api-docs.deepseek.com",
            auth_type: "bearer",
            header_name: None,
            default_model: ("deepseek-chat", "DeepSeek V3.2（对话/剧本）"),
            notes: "在 platform.deepseek.com 创建 API Key，计价便宜适合批量文本。深度思考把模型 ID 换成 deepseek-reasoner（R1 系列）。Base URL 按官方文档为 https://api.deepseek.com（/v1 与不带均可，OpenAI 兼容）。",
            template: json!({}),
        },
        // ---------------- Kimi（月之暗面）----------------
        GenPreset {
            category: "chat",
            driver: "openai-compatible",
            base_url: "https://api.moonshot.cn/v1",
            id: "kimi",
            name: "Kimi（月之暗面 Moonshot）",
            vendor: "月之暗面",
            docs_url: "https://platform.moonshot.cn/docs",
            auth_type: "bearer",
            header_name: None,
            default_model: ("kimi-k2-0905-preview", "Kimi K2（长文本/剧本）"),
            notes: "在 platform.moonshot.cn 创建 API Key；长上下文与中文创作擅长。模型 ID 可换 kimi-k2-turbo-preview（更快）等，以平台「模型列表」页为准；国际版用户把 Base URL 改为 https://api.moonshot.ai/v1。",
            template: json!({}),
        },
        // ---------------- 通义千问 Qwen ----------------
        GenPreset {
            category: "chat",
            driver: "openai-compatible",
            base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            id: "qwen",
            name: "通义千问 Qwen（阿里百炼）",
            vendor: "阿里巴巴",
            docs_url: "https://help.aliyun.com/zh/model-studio/getting-started/models",
            auth_type: "bearer",
            header_name: None,
            default_model: ("qwen3-max", "Qwen3 Max（对话/剧本）"),
            notes: "在阿里云百炼创建 API Key（注意是百炼 DashScope 的 Key）。模型 ID 可换 qwen-plus / qwen-flash（更快更便宜）；qwen3-vl-* 系列支持图片理解（可作 Vision 能力模型用）。以百炼「模型广场」为准。",
            template: json!({}),
        },
        // ---------------- 豆包（火山方舟）----------------
        GenPreset {
            category: "chat",
            driver: "openai-compatible",
            base_url: "https://ark.cn-beijing.volces.com/api/v3",
            id: "doubao",
            name: "豆包（火山方舟）",
            vendor: "字节跳动",
            docs_url: "https://www.volcengine.com/docs/82379/1330310",
            auth_type: "bearer",
            header_name: None,
            default_model: ("doubao-seed-1-6-250615", "豆包 Seed 1.6（对话/视觉）"),
            notes: "与 Seedream/Seedance 共用同一个方舟 API Key。模型 ID 以方舟「开通管理」页为准（先开通才能调用）；也支持直接填 ep-xxxx 推理接入点 ID。Doubao-Seed-1.6 自带视觉理解，可当 Vision 模型用。",
            template: json!({}),
        },
        // ---------------- ChatGPT（OpenAI）----------------
        GenPreset {
            category: "chat",
            driver: "openai-compatible",
            base_url: "https://api.openai.com/v1",
            id: "chatgpt",
            name: "ChatGPT（OpenAI 官方 API）",
            vendor: "OpenAI",
            docs_url: "https://platform.openai.com/docs/models",
            auth_type: "bearer",
            header_name: None,
            default_model: ("gpt-4o", "GPT-4o（对话/视觉）"),
            notes: "在 platform.openai.com 创建 API Key（需绑定支付方式）；国内直连需自备网络或改用中转站（选「自定义 / OpenAI 兼容」驱动填中转地址即可）。模型 ID 可换 gpt-4o-mini / gpt-4.1 等，以官方模型页为准。",
            template: json!({}),
        },
        /* ==================== 图片生成 ==================== */
        // ---------------- Nano Banana（Google）----------------
        GenPreset {
            category: "image",
            driver: "custom-http",
            base_url: "",
            id: "nano-banana",
            name: "Nano Banana（Google Gemini 图像）",
            vendor: "Google",
            docs_url: "https://ai.google.dev/gemini-api/docs/image-generation",
            auth_type: "bearer",
            header_name: None,
            default_model: ("gemini-2.5-flash-image", "Gemini 2.5 Flash Image"),
            notes: "人物立绘/分镜常用。在 aistudio.google.com 创建 API Key；响应为内联 base64（OneTV 自动解码入库）。Url 中 models/ 后为模型 ID，可按需改为其他支持图像输出的 Gemini 模型。",
            template: json!({
                "method": "POST",
                "url": "https://generativelanguage.googleapis.com/v1beta/models/${model.id}:generateContent",
                "headers": { "Content-Type": "application/json" },
                "body": {
                    "contents": [{ "parts": [{ "text": "${input.prompt}" }] }],
                    "generationConfig": { "responseModalities": ["IMAGE"] }
                },
                "response": { "result_b64": "$.candidates[0].content.parts[0].inlineData.data" }
            }),
        },
        // ---------------- Seedream（字节）----------------
        GenPreset {
            category: "image",
            driver: "custom-http",
            base_url: "",
            id: "seedream",
            name: "Seedream（火山方舟）",
            vendor: "字节跳动",
            docs_url: "https://www.volcengine.com/docs/82379/1541523",
            auth_type: "bearer",
            header_name: None,
            default_model: ("doubao-seedream-3-0-t2i-250415", "Seedream 3.0 T2I"),
            notes: "国内短剧团队大量使用、人物一致性好。在火山方舟开通模型并创建 API Key；同步接口返回 data[0].url（OneTV 自动下载入库）。模型 ID 以方舟「开通管理」页为准（如 doubao-seedream-4-0-250828 为 4.0 版，画质更好按量计价）。",
            template: json!({
                "method": "POST",
                "url": "https://ark.cn-beijing.volces.com/api/v3/images/generations",
                "headers": { "Content-Type": "application/json" },
                "body": {
                    "model": "${model.id}",
                    "prompt": "${input.prompt}",
                    "response_format": "url",
                    "size": "864x1152"
                },
                "response": { "result_url": "$.data[0].url" }
            }),
        },
        // ---------------- FLUX（Black Forest Labs）----------------
        GenPreset {
            category: "image",
            driver: "custom-http",
            base_url: "",
            id: "flux",
            name: "FLUX（BFL 官方 API）",
            vendor: "Black Forest Labs",
            docs_url: "https://docs.bfl.ai",
            auth_type: "custom-header",
            header_name: Some("x-key"),
            default_model: ("flux-pro-1.1", "FLUX Pro 1.1"),
            notes: "写实人像常用。在 api.bfl.ai 创建 Key（鉴权走 x-key 头，OneTV 已按预设自动挂）。异步队列：提交返回 id，轮询 get_result，status=Ready 时 result.sample 为图 URL。模型 ID 可换 flux-kontext-pro（图生图）等。",
            template: json!({
                "method": "POST",
                "url": "https://api.bfl.ai/v1/${model.id}",
                "headers": { "Content-Type": "application/json" },
                "body": {
                    "prompt": "${input.prompt}",
                    "width": 864,
                    "height": 1152
                },
                "response": { "job_id": "$.id" },
                "poll": {
                    "method": "GET",
                    "url": "https://api.bfl.ai/v1/get_result?id=${jobId}",
                    "success_when": "$.status == \"Ready\"",
                    "failure_when": "$.status == \"Error\"",
                    "interval_ms": 4000,
                    "timeout_ms": 600000
                }
            }),
        },
        // ---------------- Midjourney（经 midjourney-proxy）----------------
        GenPreset {
            category: "image",
            driver: "custom-http",
            base_url: "",
            id: "midjourney-proxy",
            name: "Midjourney（经 midjourney-proxy）",
            vendor: "MJ 社区",
            docs_url: "https://github.com/novicezk/midjourney-proxy",
            auth_type: "bearer",
            header_name: None,
            default_model: ("midjourney", "MJ V7"),
            notes: "封面/海报常用。MJ 无官方 API：此预设面向自建或第三方的 midjourney-proxy 兼容服务（Base 地址按你的部署改模板 URL），提交 imagine 返回任务 id，轮询 fetch，status=SUCCESS 时 imageUrl 为结果。",
            template: json!({
                "method": "POST",
                "url": "https://your-mj-proxy.example.com/mj/submit/imagine",
                "headers": { "Content-Type": "application/json" },
                "body": { "prompt": "${input.prompt}" },
                "response": { "job_id": "$.result" },
                "poll": {
                    "method": "GET",
                    "url": "https://your-mj-proxy.example.com/mj/task/${jobId}/fetch",
                    "success_when": "$.status == \"SUCCESS\"",
                    "failure_when": "$.status == \"FAILURE\"",
                    "interval_ms": 6000,
                    "timeout_ms": 900000
                }
            }),
        },
        // ---------------- MiniMax 图片（image-01）----------------
        GenPreset {
            category: "image",
            driver: "custom-http",
            base_url: "",
            id: "minimax-image",
            name: "MiniMax 图片（image-01）",
            vendor: "MiniMax",
            docs_url: "https://www.minimax.cn/document/image_generation",
            auth_type: "bearer",
            header_name: None,
            default_model: ("image-01", "MiniMax image-01"),
            notes: "与海螺/对话共用 MiniMax API Key。同步接口直接返回 data.image_urls（OneTV 自动下载入库）；画幅取节点/任务传入的 aspectRatio。",
            template: json!({
                "method": "POST",
                "url": "https://api.minimax.cn/v1/image_generation",
                "headers": { "Content-Type": "application/json" },
                "body": {
                    "model": "${model.id}",
                    "prompt": "${input.prompt}",
                    "aspect_ratio": "${input.aspectRatio}",
                    "response_format": "url"
                },
                "response": { "result_url": "$.data.image_urls" }
            }),
        },
        /* ==================== 视频生成 ==================== */
        // ---------------- 海螺 H3（MiniMax）----------------
        GenPreset {
            category: "video",
            driver: "custom-http",
            base_url: "",
            id: "minimax-h3",
            name: "海螺 H3（MiniMax 视频）",
            vendor: "MiniMax",
            docs_url: "https://www.minimax.cn/document/video_generation",
            auth_type: "bearer",
            header_name: None,
            default_model: ("MiniMax-H3", "MiniMax H3（文生/图生视频）"),
            notes: "在 MiniMax 开放平台创建 API Key。v2 接口（api.minimax.cn，2026-10 真机验证）：提交返回 task_id，轮询 items[0].status=succeeded 时取 content.url（OneTV 自动下载入库）。⚠️ H3 等视频模型不在 /models 目录，需在模型行手动填写 modelId。分辨率 resolution 可改 720p/1080p/2K；图生视频按官方文档在 content 里加 image_url 项。",
            template: json!({
                "method": "POST",
                "url": "https://api.minimax.cn/v2/video_generation",
                "headers": { "Content-Type": "application/json" },
                "body": {
                    "model": "${model.id}",
                    "content": [{ "type": "text", "text": "${input.prompt}" }],
                    "resolution": "768P",
                    "duration": 5,
                    "ratio": "${input.aspectRatio}"
                },
                "response": { "job_id": "$.task_id", "result_url": "$.items[0].content.url" },
                "poll": {
                    "method": "GET",
                    "url": "https://api.minimax.cn/v2/query/video_generation?task_id=${jobId}",
                    "success_when": "$.items[0].status == \"succeeded\"",
                    "failure_when": "$.items[0].status == \"failed\"",
                    "interval_ms": 10000,
                    "timeout_ms": 1800000
                }
            }),
        },
        // ---------------- 可灵（快手）----------------
        GenPreset {
            category: "video",
            driver: "custom-http",
            base_url: "",
            id: "kling",
            name: "可灵 Kling（快手）",
            vendor: "快手",
            docs_url: "https://app.klingai.com/cn/dev/document-api",
            auth_type: "kling-jwt",
            header_name: None,
            default_model: ("kling-v1", "Kling V1（图生视频）"),
            notes: "动作自然、口型强，竖屏短剧常用。在可灵开放平台获取 API Key（AK）与 Secret Key（SK），填入 API Key 框时用「AK:SK」格式（冒号拼接）——OneTV 为每次请求自动签发 30 分钟有效 JWT（v2.7.2 已内置签名，无须代理）。认证域（新加坡/北京）不同时改模板 URL 即可。",
            template: json!({
                "method": "POST",
                "url": "https://api-singapore.klingai.com/v1/videos/image2video",
                "headers": { "Content-Type": "application/json" },
                "body": {
                    "model_name": "${model.id}",
                    "image": "${input.firstFrameBase64?}",
                    "prompt": "${input.prompt}",
                    "mode": "std",
                    "duration": "5"
                },
                "response": { "job_id": "$.data.task_id" },
                "poll": {
                    "method": "GET",
                    "url": "https://api-singapore.klingai.com/v1/videos/image2video/${jobId}",
                    "success_when": "$.data.task_status == \"succeed\"",
                    "failure_when": "$.data.task_status == \"failed\"",
                    "interval_ms": 8000,
                    "timeout_ms": 1800000
                }
            }),
        },
        // ---------------- 即梦 Seedance（火山引擎方舟）----------------
        GenPreset {
            category: "video",
            driver: "custom-http",
            base_url: "",
            id: "seedance",
            name: "即梦 Seedance（火山方舟）",
            vendor: "字节跳动",
            docs_url: "https://www.volcengine.com/docs/82379/1520757",
            auth_type: "bearer",
            header_name: None,
            default_model: ("doubao-seedance-1-0-lite-t2v-250428", "Seedance 1.0 Lite"),
            notes: "国内短剧圈最主流，图生视频锁人物。在火山方舟开通模型并创建 API Key。提交返回 id，轮询同路径 /{id}，status=succeeded 时取 content.video_url。模型 ID 以方舟「开通管理」页为准（需先开通才能调用；pro 版画质更高，lite 版更快更便宜）。",
            template: json!({
                "method": "POST",
                "url": "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks",
                "headers": { "Content-Type": "application/json" },
                "body": {
                    "model": "${model.id}",
                    "content": [
                        { "type": "text", "text": "${input.prompt} --resolution 720p --duration 5" },
                        { "type": "image_url", "image_url": { "url": "${input.firstFrameBase64?}" } }
                    ]
                },
                "response": { "job_id": "$.id" },
                "poll": {
                    "method": "GET",
                    "url": "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/${jobId}",
                    "success_when": "$.status == \"succeeded\"",
                    "failure_when": "$.status == \"failed\"",
                    "interval_ms": 8000,
                    "timeout_ms": 1800000
                }
            }),
        },
        // ---------------- 通义万相 Wan（阿里百炼）----------------
        GenPreset {
            category: "video",
            driver: "custom-http",
            base_url: "",
            id: "dashscope-wan",
            name: "通义万相 Wan（阿里百炼）",
            vendor: "阿里巴巴",
            docs_url: "https://help.aliyun.com/zh/model-studio/video-generation",
            auth_type: "bearer",
            header_name: None,
            default_model: ("wan2.2-t2v-plus", "Wan2.2 T2V Plus"),
            notes: "国内团队批量生产、分镜连贯。在阿里云百炼开通并创建 API Key。异步接口：提交带 X-DashScope-Async: enable（已内置），返回 output.task_id；轮询 /api/v1/tasks/{task_id}，SUCCEEDED 时 output.video_url 为结果。⚠️ 万相图生视频 img_url 只接受公网 URL（不接受 data URI），首帧请先转存 OSS 后改模板。本地开源权重（Wan2.x / 混元）可走 ComfyUI 驱动（视频工作流在后续版本）。",
            template: json!({
                "method": "POST",
                "url": "https://dashscope.aliyuncs.com/api/v1/services/aigc/video-generation/video-synthesis",
                "headers": {
                    "Content-Type": "application/json",
                    "X-DashScope-Async": "enable"
                },
                "body": {
                    "model": "${model.id}",
                    "input": { "prompt": "${input.prompt}" },
                    "parameters": { "size": "1280*720", "duration": 5 }
                },
                "response": { "job_id": "$.output.task_id" },
                "poll": {
                    "method": "GET",
                    "url": "https://dashscope.aliyuncs.com/api/v1/tasks/${jobId}",
                    "success_when": "$.output.task_status == \"SUCCEEDED\"",
                    "failure_when": "$.output.task_status == \"FAILED\"",
                    "interval_ms": 8000,
                    "timeout_ms": 1800000
                }
            }),
        },
        // ---------------- Pika（经 fal.ai 队列）----------------
        GenPreset {
            category: "video",
            driver: "custom-http",
            base_url: "",
            id: "pika-fal",
            name: "Pika（经 fal.ai 队列）",
            vendor: "Pika Labs / fal",
            docs_url: "https://docs.fal.ai/model-endpoints/queue",
            auth_type: "bearer",
            header_name: None,
            default_model: ("fal-ai/pika/v2.2/t2v", "Pika v2.2 T2V"),
            notes: "海外短剧/漫改短剧，镜头氛围感好。Pika 官方 API 未开放稳定公版，此预设走 fal.ai 的 Pika 模型（在 fal.ai 创建 Key，模型 ID 可换 fal-ai/pika/v2.2/i2v 等图生视频变体）。fal 队列：提交返回 request_id，轮询 status=COMPLETED 后 response.videos[0].url 为结果。",
            template: json!({
                "method": "POST",
                "url": "https://queue.fal.run/${model.id}",
                "headers": { "Content-Type": "application/json" },
                "body": {
                    "prompt": "${input.prompt}",
                    "image_url": "${input.firstFrameBase64?}"
                },
                "response": { "job_id": "$.request_id" },
                "poll": {
                    "method": "GET",
                    "url": "https://queue.fal.run/requests/${jobId}/status",
                    "success_when": "$.status == \"COMPLETED\"",
                    "failure_when": "$.status == \"FAILED\"",
                    "interval_ms": 6000,
                    "timeout_ms": 1800000
                }
            }),
        },
        // ---------------- Runway ----------------
        GenPreset {
            category: "video",
            driver: "custom-http",
            base_url: "",
            id: "runway",
            name: "Runway（Gen-4 / Gen-3）",
            vendor: "Runway",
            docs_url: "https://docs.dev.runwayml.com",
            auth_type: "bearer",
            header_name: None,
            default_model: ("gen4_turbo", "Gen-4 Turbo（图生视频）"),
            notes: "在 dev.runwayml.com 创建 API Key（需先开通 API 权限）。POST image_to_video 返回 id，轮询 /v1/tasks/{id}，status=SUCCEEDED 后 output[0] 为视频直链（约 10 分钟有效，OneTV 会自动下载入库）。X-Runway-Version 头已内置。",
            template: json!({
                "method": "POST",
                "url": "https://api.dev.runwayml.com/v1/image_to_video",
                "headers": {
                    "Content-Type": "application/json",
                    "X-Runway-Version": "2024-11-06"
                },
                "body": {
                    "model": "${model.id}",
                    "promptImage": "${input.firstFrameBase64?}",
                    "promptText": "${input.prompt}",
                    "ratio": "720:1280",
                    "duration": 5
                },
                "response": { "job_id": "$.id" },
                "poll": {
                    "method": "GET",
                    "url": "https://api.dev.runwayml.com/v1/tasks/${jobId}",
                    "success_when": "$.status == \"SUCCEEDED\"",
                    "failure_when": "$.status == \"FAILED\"",
                    "interval_ms": 8000,
                    "timeout_ms": 1200000
                }
            }),
        },
    ]
}

/// 预设序列化为前端可用的 JSON（按 通用 → 图片 → 视频 排序）。
pub fn gen_presets_json() -> Vec<Value> {
    let mut all = gen_presets();
    all.sort_by_key(|p| match p.category {
        "chat" => 0,
        "image" => 1,
        _ => 2,
    });
    all.into_iter()
        .map(|p| {
            json!({
                "category": p.category,
                "driver": p.driver,
                "baseUrl": p.base_url,
                "id": p.id,
                "name": p.name,
                "vendor": p.vendor,
                "docsUrl": p.docs_url,
                "authType": p.auth_type,
                "headerName": p.header_name,
                "template": p.template,
                "defaultModelId": p.default_model.0,
                "defaultModelName": p.default_model.1,
                "notes": p.notes,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::providers::custom_http::HttpTemplate;

    #[test]
    fn presets_have_valid_templates() {
        let presets = gen_presets();
        assert!(presets.iter().filter(|p| p.category == "chat").count() >= 5, "通用对话预设：DeepSeek/Kimi/千问/豆包/ChatGPT");
        assert!(presets.iter().filter(|p| p.category == "image").count() >= 4, "图片预设：Nano Banana/Seedream/FLUX/MJ");
        assert!(presets.iter().filter(|p| p.category == "video").count() >= 6, "视频预设：海螺/可灵/即梦/万相/Pika/Runway");
        for p in &presets {
            match p.driver {
                // 通用对话预设：base_url 必须是合法 https 地址，无模板
                "openai-compatible" => {
                    assert!(p.base_url.starts_with("https://"), "{} Base URL 必须为绝对地址", p.id);
                    assert!(!p.default_model.0.is_empty(), "{} 必须有默认模型", p.id);
                    assert!(p.auth_type == "bearer", "{} 对话预设走 bearer", p.id);
                }
                // custom-http 预设：模板必须可解析且 URL 为绝对地址
                _ => {
                    let tmpl: HttpTemplate = serde_json::from_value(p.template.clone())
                        .unwrap_or_else(|e| panic!("预设 {} 模板解析失败: {e}", p.id));
                    assert!(tmpl.url.starts_with("https://"), "{} 提交 URL 必须为绝对地址", p.id);
                    if let Some(poll) = &tmpl.poll {
                        assert!(poll.url.contains("${jobId}"), "{} 轮询 URL 应引用 ${{jobId}}", p.id);
                        assert!(poll.url.starts_with("https://"), "{} 轮询 URL 必须为绝对地址", p.id);
                        assert!(!poll.success_when.is_empty());
                    }
                }
            }
        }
    }

    #[test]
    fn chat_presets_are_openai_compatible_shape() {
        // 通用对话预设走 openai-compatible 驱动：JSON 必须带 driver/baseUrl 字段（前端 applyPreset 依赖）
        for p in gen_presets_json() {
            if p["category"] == "chat" {
                assert_eq!(p["driver"], "openai-compatible");
                assert!(p["baseUrl"].as_str().unwrap_or("").starts_with("https://"));
            }
        }
    }

    #[test]
    fn preset_ids_are_unique() {
        let mut ids: Vec<_> = gen_presets().into_iter().map(|p| p.id).collect();
        let n = ids.len();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), n);
    }

    #[test]
    fn custom_http_supports_result_b64_mapping() {
        // Gemini 式 base64 响应 → resultB64 映射可在 HttpTemplate 中表达
        let tmpl: HttpTemplate = serde_json::from_value(json!({
            "method": "POST",
            "url": "https://example.com/gen",
            "response": { "result_b64": "$.data[0].b64" }
        }))
        .expect("result_b64 映射解析");
        assert_eq!(tmpl.response.unwrap().result_b64.as_deref(), Some("$.data[0].b64"));
    }

    #[test]
    fn polled_presets_map_remote_job_id() {
        // ResponseMapping 是 snake_case serde 字段：job_id 键名写错会被静默忽略 → 轮询失效。
        // 这里守住：所有带 poll 的预设必须真实解析出 job_id 映射
        for p in gen_presets() {
            if p.driver != "custom-http" {
                continue; // 通用对话预设无模板
            }
            let tmpl: HttpTemplate = serde_json::from_value(p.template.clone()).unwrap();
            if tmpl.poll.is_some() {
                assert!(
                    tmpl.response.as_ref().and_then(|r| r.job_id.as_deref()).is_some(),
                    "预设 {} 缺少 job_id 映射",
                    p.id
                );
            }
        }
    }
}
