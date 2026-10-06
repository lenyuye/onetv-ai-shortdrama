/**
 * 多版本导出相关英文翻译片段(ExportDialog / StoryboardView / TimelineView 导出入口)。
 * 键 = 中文原文(与替换处逐字一致),值 = 英文翻译。
 * 术语:导出=Export、预设=Preset、烧录字幕=Burn subtitles、
 *       竖版=Vertical、横版=Horizontal、母版=Master。
 * 已在其他片段存在的键(取消 / 创建中… / 将把最近合成的成片转码为选定画幅并导出
 * （本地转码，不出网）。等)不重复登记,走全局合并。
 */
export default {
  /* ---------- 入口按钮 / 弹窗标题 ---------- */
  '📦 多版本导出': '📦 Multi-Preset Export',

  /* ---------- 预设多选 ---------- */
  '导出预设（可多选）': 'Presets (multi-select)',
  '抖音竖版 1080×1920': 'Douyin Vertical 1080×1920',
  '小红书竖版 1080×1440': 'XHS Vertical 1080×1440',
  '横版 1080p 1920×1080': 'Horizontal 1080p 1920×1080',
  '方形 1080×1080': 'Square 1080×1080',
  '母版（保持源画幅）': 'Master (keep source resolution)',
  '请至少选择一个画幅预设': 'Select at least one preset',

  /* ---------- 选项 / 确认 ---------- */
  '选项': 'Options',
  '烧录字幕（硬字幕压入画面）': 'Burn subtitles (hardcode into picture)',
  '导出 SRT 字幕侧车': 'Export SRT subtitle sidecar',
  '确认导出': 'Export',

  /* ---------- 结果反馈 ---------- */
  '已创建 {n} 个导出任务，请到「任务」页查看进度': 'Created {n} export jobs. Track progress on the Tasks page',
  '创建导出任务失败：{msg}': 'Failed to create export jobs: {msg}',
};
