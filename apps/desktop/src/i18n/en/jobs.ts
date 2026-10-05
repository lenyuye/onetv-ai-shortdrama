/**
 * 任务队列视图英文翻译片段（JobsView）。
 * 键 = 中文原文（与替换处逐字一致），值 = 英文翻译。
 */
export default {
  /* ---------- 任务状态显示名（STATE_META.label） ---------- */
  '排队中': 'Queued',
  '校验中': 'Validating',
  '等待确认': 'Awaiting Approval',
  '提交中': 'Submitting',
  '运行中': 'Running',
  '下载中': 'Downloading',
  '后处理中': 'Post-processing',
  '已完成': 'Completed',
  '失败': 'Failed',
  '重试等待': 'Retry Waiting',
  '已取消': 'Canceled',

  /* ---------- 任务类型显示名（KIND_META） ---------- */
  '对话': 'Chat',
  '剧本生成': 'Script Generation',
  '视觉理解': 'Vision',
  '结构化输出': 'Structured Output',
  '图片生成': 'Image Generation',
  '改图': 'Image Edit',
  '视频生成': 'Video Generation',
  '剪视频': 'Video Editing',
  '视频延展': 'Video Extend',
  '配音': 'Voiceover',
  '音乐': 'Music',
  '向量': 'Embedding',
  '本地合成': 'Local Render',
  '导出成片': 'Export Final Cut',
  '导入': 'Import',
  '视频理解': 'Video Understanding',

  /* ---------- Egress 预览 ---------- */
  '目标': 'Target',
  ' · 模型 {model}': ' · Model {model}',
  '数据': 'Data',
  '文本字段：{fields}': 'Text fields: {fields}',
  '无文本字段': 'No text fields',
  '；资产 {count} 项': '; {count} assets',
  '敏感项': 'Sensitive Items',
  '{count} 项内容将发送至远程 Provider（{detail}）':
    '{count} items will be sent to a remote Provider ({detail})',

  /* ---------- 页头 / 工具栏 / 空态 ---------- */
  '⏳ 任务队列': '⏳ Job Queue',
  '全局并发上限 {max}（可在「设置 → 任务引擎」调整），每个 Provider 另有独立并发上限 · 共 {total} 条 · 进行中 {running}':
    'Global concurrency limit {max} (adjustable in "Settings → Job Engine"); each Provider also has its own concurrency limit · {total} jobs in total · {running} in progress',
  ' · 待确认 {count}': ' · {count} awaiting approval',
  '自动刷新（15s 兜底）': 'Auto refresh (15s fallback)',
  '⟳ 刷新': '⟳ Refresh',
  '加载中…': 'Loading…',
  '暂无任务': 'No jobs yet',
  '在创作视图发起生成 / 渲染后，任务会出现在这里':
    'Jobs will appear here after you start a generation / render from the creation views',

  /* ---------- 任务表 ---------- */
  '标题': 'Title',
  '类型': 'Type',
  '状态': 'State',
  '进度': 'Progress',
  'Provider / 模型': 'Provider / Model',
  '错误': 'Error',
  '创建时间': 'Created At',
  '操作': 'Actions',
  '（等待确认，请批准后执行）': '(Awaiting approval, will run after you approve)',
  '🔍 QC 通过': '🔍 QC Passed',
  '⚠️ QC：{detail}': '⚠️ QC: {detail}',
  ' ·第 {n} 次': ' ·Attempt {n}',
  '点击收起': 'Click to collapse',
  '{error}\n（点击展开）': '{error}\n(Click to expand)',
  '批准': 'Approve',
  '取消': 'Cancel',
  '重试': 'Retry',
  '事件': 'Events',
  'Egress 预览 · 批准后将向以下目标发送数据':
    'Egress Preview · Data will be sent to the following targets after approval',

  /* ---------- QC 摘要（qcSummary） ---------- */
  '黑帧 {dur}s': 'Black frames {dur}s',
  '静音 {dur}s': 'Silence {dur}s',
  '无音轨': 'No audio track',
  '黑帧/静音/音轨检测未见异常': 'No anomalies found in black-frame / silence / audio-track checks',

  /* ---------- 行操作 toast ---------- */
  '已请求取消：{title}': 'Cancellation requested: {title}',
  '取消失败：{msg}': 'Failed to cancel: {msg}',
  '已重新入队：{title}': 'Re-enqueued: {title}',
  '重试失败：{msg}': 'Failed to retry: {msg}',
  '已批准：{title}': 'Approved: {title}',
  '批准失败：{msg}': 'Failed to approve: {msg}',
  '读取事件失败：{msg}': 'Failed to load events: {msg}',

  /* ---------- 页脚 / 事件时间线 modal ---------- */
  '任务状态机：QUEUED → VALIDATING →（AWAITING_APPROVAL，需人工批准）→ SUBMITTING → RUNNING → DOWNLOADING → POST_PROCESSING → SUCCEEDED / FAILED；失败自动重试进入 RETRY_WAIT':
    'Job state machine: QUEUED → VALIDATING → (AWAITING_APPROVAL, manual approval required) → SUBMITTING → RUNNING → DOWNLOADING → POST_PROCESSING → SUCCEEDED / FAILED; failed jobs retry automatically via RETRY_WAIT',
  '事件时间线 · {title}': 'Event Timeline · {title}',
  '暂无事件': 'No events',
  '关闭': 'Close',
} as Record<string, string>;
