import type { AIConfig, AIPreset } from './types';

export const APP = {
  name: '题面',
  en: 'TiMian',
  tagline: '把 PDF 变成可刷的题库',
  version: '1.0.0',
};

/** 静态题库索引与文件所在目录（相对于站点根路径） */
export const DATA_DIR = 'data/banks/';

/** 及格线（百分制） */
export const PASS_SCORE = 90;

export const STORAGE_KEYS = {
  localBanks: 'timian.localBanks.v1',
  aiConfig: 'timian.ai.v1',
  publishConfig: 'timian.publish.v1',
} as const;

/** 常见 OpenAI 兼容接口预设；模型名可随时手动修改 */
export const AI_PRESETS: AIPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter（推荐 · 支持浏览器直连）',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: 'google/gemini-2.5-flash',
    note: '接口支持跨域，浏览器可直接调用。模型名可到 OpenRouter 控制台复制最新名称。',
  },
  {
    id: 'gemini',
    label: 'Google Gemini（OpenAI 兼容）',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    model: 'gemini-2.5-flash',
    note: '在 Google AI Studio 申请 Key，有免费额度；国内网络环境需自行解决访问问题。',
  },
  {
    id: 'bailian',
    label: '阿里云百炼 DashScope（Qwen）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    note: '百炼控制台创建 API Key；北京地域可直接用此地址，其他地域请换成对应 Base URL（见 README）。',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    note: '模型名以控制台为准。若提示跨域失败，请改用代理地址（见 README）。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    note: '官方接口通常不允许浏览器跨域，建议配合 README 里的 Cloudflare Worker 代理。',
  },
  {
    id: 'openai',
    label: 'OpenAI 官方',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    note: '官方接口会拦截浏览器直连（CORS），必须填写代理地址。',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容接口 / 代理）',
    baseUrl: '',
    model: '',
    note: '填写任意兼容 /chat/completions 的服务地址；结尾的 /v1 由你自己决定。',
  },
];

export const DEFAULT_AI_CONFIG: AIConfig = {
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: '',
  model: 'google/gemini-2.5-flash',
  jsonMode: true,
};

/** 题库卡片配色 */
export const BANK_COLORS = [
  'blue',
  'violet',
  'emerald',
  'amber',
  'rose',
  'cyan',
  'indigo',
  'slate',
] as const;

export type BankColor = (typeof BANK_COLORS)[number];

export const BANK_EMOJIS = [
  '📘',
  '📗',
  '📙',
  '🚦',
  '🧠',
  '💡',
  '⚖️',
  '🩺',
  '🔬',
  '💻',
  '🌍',
  '📐',
  '🏛️',
  '🎯',
  '🧪',
  '🚀',
];

export const PAGE_SIZE_LIMITS = {
  maxPdfPages: 300,
  maxTextChars: 400_000,
  // 每段越小，单次输出越不容易被 max_tokens 截断；150 题的 PDF 会分成更多段
  chunkSize: 2800,
};
