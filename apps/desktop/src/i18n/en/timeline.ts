/**
 * 时间线相关英文翻译片段(TimelineView / components/timeline/*)。
 * 键 = 中文原文(与替换处逐字一致),值 = 英文翻译。
 * 术语:时间线=Timeline、轨道=Track、片段=Clip、渲染=Render、
 *       淡入=Fade in、淡出=Fade out、音量=Volume、入点=Trim in。
 * 已在其他片段存在的键(生成中… / 创建中… / 💾 保存 / 取消 / 无 / 时长（秒）/
 * 前往工作区 / 前往项目页 / 视频 / 音频 / 字幕 / 文本 等)不重复登记,走全局合并。
 */
export default {
  /* ---------- 顶栏 / 描述 ---------- */
  '🎞️ 时间线': '🎞️ Timeline',
  '{n} 个片段': '{n} clips',
  '总时长 {dur}': 'Total {dur}',
  '缩放': 'Zoom',
  '🧹 清空': '🧹 Clear',
  '🎬 渲染成片': '🎬 Render Film',
  '渲染中 {p}%': 'Rendering {p}%',
  '🎬 从分镜生成时间线': '🎬 Generate from Storyboard',

  /* ---------- 守卫与空态 ---------- */
  '时间线按分集组织，请先在「工作区」创建或打开一个项目':
    'Timelines are organized by episode. Create or open a project in the Workspace first.',
  '时间线挂在分集下，请先在「项目」页新增一集':
    'Timelines hang under episodes. Add an episode on the Projects page first.',
  '时间线加载中…': 'Loading timeline…',
  '这一集还没有时间线': 'No timeline for this episode yet',
  '从分镜生成会按镜头顺序排列已出图画面并自动带上字幕；也可以新建空白时间线后在各轨道「+ 添加」片段。':
    'Generating from the storyboard lines up rendered shots in order with subtitles attached; you can also start a blank timeline and add clips to each track via “+ Add”.',

  /* ---------- 保存 / 加载 ---------- */
  '时间线已保存': 'Timeline saved',
  '保存时间线失败：{msg}': 'Failed to save timeline: {msg}',
  '加载时间线失败：{msg}': 'Failed to load timeline: {msg}',

  /* ---------- 从分镜生成 / 清空 / 空白时间线 ---------- */
  '分镜表里还没有已出图镜头，请先到「分镜」页生成分镜图':
    'No rendered shot images in the storyboard yet. Generate storyboard images on the Storyboard page first.',
  '覆盖当前时间线？': 'Overwrite the current timeline?',
  '当前时间线已有 {n} 个片段，从分镜重新生成将替换全部内容。':
    'The current timeline has {n} clips. Regenerating from the storyboard will replace all of them.',
  '已从分镜生成时间线（{n} 个片段）': 'Timeline generated from storyboard ({n} clips)',
  '生成时间线失败：{msg}': 'Failed to generate timeline: {msg}',
  '已新建空白时间线': 'Blank timeline created',
  '🧱 新建空白时间线': '🧱 New Blank Timeline',
  '清空时间线？': 'Clear the timeline?',
  '将删除当前分集时间线上的全部 {n} 个片段，且不可撤销。':
    'This will remove all {n} clips from this episode’s timeline. This cannot be undone.',

  /* ---------- 渲染成片 ---------- */
  '时间线为空，请先添加片段': 'The timeline is empty. Add clips first.',
  '渲染任务已创建：{jobId}，请到「任务」页查看进度':
    'Render job created: {jobId}. Check progress on the Jobs page.',
  '创建渲染任务失败：{msg}': 'Failed to create render job: {msg}',
  '时间线渲染完成': 'Timeline rendering finished',
  '时间线渲染失败：{msg}': 'Timeline rendering failed: {msg}',
  '任务失败': 'Job failed',

  /* ---------- 泳道 / 标尺 ---------- */
  '时间': 'Time',
  '添加': 'Add',

  /* ---------- 字幕内联表单 ---------- */
  '新增字幕': 'New Subtitle',
  '字幕内容…': 'Subtitle text…',
  '开始（秒）': 'Start (seconds)',

  /* ---------- 片段块 ---------- */
  '（空字幕）': '(empty subtitle)',

  /* ---------- 检查器 ---------- */
  '片段属性': 'Clip Properties',
  '点击片段查看与编辑属性': 'Select a clip to view and edit its properties',
  '拖拽块体移动位置，拖拽左右边缘裁剪；Delete 键删除选中片段':
    'Drag the block to move it, drag its edges to trim; press Delete to remove the selected clip.',
  '入点（秒）': 'Trim in (seconds)',
  '音量': 'Volume',
  '淡入（转场入）': 'Fade in (transition in)',
  '淡出（转场出）': 'Fade out (transition out)',
  '淡入': 'Fade in',
  '淡出': 'Fade out',
  '字幕文本': 'Subtitle text',
  '🗑 删除片段': '🗑 Delete Clip',

  /* ---------- 资产选择弹窗 ---------- */
  '🎵 选择音频资产': '🎵 Select an Audio Asset',
  '🎬 选择视频 / 图片资产': '🎬 Select a Video / Image Asset',
  '资产加载中…': 'Loading assets…',
  '资产库为空，请先到「资产」页导入': 'The asset library is empty. Import assets on the Assets page first.',
  '探测资产时长失败，已使用默认 3 秒：{msg}':
    'Failed to probe asset duration, falling back to 3 seconds: {msg}',
  '探测中…': 'Probing…',
} as Record<string, string>;
