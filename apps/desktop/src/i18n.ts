/**
 * i18n 字典层(项35)。
 * 约定:以中文原文为键——zh 直接返回原文,en 查字典、缺译回退原文。
 * 翻译按视图分片存放在 src/i18n/en/*.ts(与视图一一对应,避免合并冲突)。
 * 语言偏好存 localStorage('onetv-lang'),useT() 订阅切换触发重渲染。
 */
import { useSyncExternalStore } from 'react';
import enAgentChat from './i18n/en/agentChat';
import enApi from './i18n/en/api';
import enCanvas from './i18n/en/canvas';
import enExport from './i18n/en/export';
import enJobs from './i18n/en/jobs';
import enMisc from './i18n/en/misc';
import enModels from './i18n/en/models';
import enScript from './i18n/en/script';
import enSettings from './i18n/en/settings';
import enStoryboard from './i18n/en/storyboard';
import enTimeline from './i18n/en/timeline';

export type Lang = 'zh' | 'en';

const LANG_KEY = 'onetv-lang';

function loadLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

let lang: Lang = loadLang();
const listeners = new Set<() => void>();

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang): void {
  if (l === lang) return;
  lang = l;
  try {
    localStorage.setItem(LANG_KEY, l);
  } catch {
    /* 存储不可用时仅会话内生效 */
  }
  for (const fn of listeners) fn();
}

/**
 * 跨分片同键不同译的统一裁决(样式级差异,以更通用者为准)。
 * 字典完整性测试会强制:未来片段出现新冲突时必须裁决并登记到这里。
 */
export const OVERRIDES: Record<string, string> = {
  '读取中…': 'Loading…',
  '高风险': 'High risk',
  '中风险': 'Medium risk',
  '低风险': 'Low risk',
  '生图': 'Image Gen',
  '生视频': 'Video Gen',
  '视觉理解': 'Visual understanding',
  '结构化输出': 'Structured output',
  '图片生成': 'Image generation',
  '视频生成': 'Video generation',
  '视频延展': 'Video extension',
  '模型': 'Model',
  '画幅': 'Aspect Ratio',
  '图片': 'Image',
  '视频': 'Video',
  '尚未打开项目': 'No project open',
  '新增失败：{msg}': 'Failed to add episode: {msg}',
  '状态': 'Status',
  '连接失败': 'Connection failed',
  '数据': 'Data',
  '批准失败：{msg}': 'Approval failed: {msg}',
  '任务 {n}': 'Jobs {n}',
  '绑定邮箱': 'Linked email',
};

const en: Record<string, string> = Object.assign(
  {},
  enApi,
  enAgentChat,
  enCanvas,
  enExport,
  enJobs,
  enMisc,
  enModels,
  enScript,
  enSettings,
  enStoryboard,
  enTimeline,
  OVERRIDES,
);

export function t(text: string, vars?: Record<string, string | number>): string {
  let out = lang === 'en' ? en[text] ?? text : text;
  if (vars) {
    // 仅替换 vars 中存在的占位符——字典键里可能含字面 {xx}(如模板提示 ${jobId}),不可误伤
    out = out.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  }
  return out;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 组件内取翻译函数;语言切换时触发所在组件重渲染。 */
export function useT(): typeof t {
  useSyncExternalStore(subscribe, () => lang, () => lang);
  return t;
}
