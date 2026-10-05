/**
 * 英文翻译片段 —— api* 层与 store（当前仅 api-providers.ts 的能力/默认模型行标签为
 * 用户可见文案，渲染期经 t() 取值）。
 * 其余 api*.ts / store.ts 中没有用户可见字符串（invoke 命令名、payload 值、
 * console 标签等均为数据，不参与 i18n）。
 */
export default {
  /* ---------- CAPABILITY_OPTIONS / EDITOR_CAPABILITY_OPTIONS / MODEL_DEFAULT_ROWS ---------- */
  '对话': 'Chat',
  '视觉理解': 'Visual understanding',
  '结构化输出': 'Structured output',
  '图像生成': 'Image generation',
  '图像编辑': 'Image editing',
  '视频生成': 'Video generation',
  '视频编辑': 'Video editing',
  '视频延展': 'Video extension',
  '语音合成': 'Speech synthesis',
  '音乐生成': 'Music generation',
  '向量嵌入': 'Embedding',
  '生图': 'Image gen',
  '生视频': 'Video gen',
  '配音': 'Voiceover',
  '对话 / 推理': 'Chat / Reasoning',
  '图片生成': 'Image generation',
  '图片': 'Image',
  '音频配音': 'Audio voiceover',
} as Record<string, string>;
