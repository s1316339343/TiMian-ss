/** 题目类型：单选 / 多选 / 判断 / 填空 / 简答 */
export type QuestionType = 'single' | 'multiple' | 'judge' | 'fill' | 'short';

export interface QuestionOption {
  /** 选项标识，A / B / C ... */
  key: string;
  text: string;
}

export interface Question {
  id: string;
  type: QuestionType;
  stem: string;
  options: QuestionOption[];
  /**
   * 答案的字符串表示：
   * - single / judge：单个选项 key（A / B）
   * - multiple：逗号分隔的选项 key（如 "A,C"）
   * - fill：标准答案原文（参与自动判分）
   * - short：参考答案原文（不参与判分，可以为空）
   */
  answer: string;
  analysis?: string;
  knowledge?: string;
  /** AI 解析置信度，原文没有答案时标记为 low */
  confidence?: 'high' | 'low';
}

/** 首页卡片所需的题库摘要（存放在 index.json 中） */
export interface BankMeta {
  id: string;
  title: string;
  description?: string;
  category?: string;
  emoji?: string;
  color?: string;
  source?: string;
  /** 题库 JSON 文件名，相对于 data/banks/ */
  file: string;
  questionCount: number;
  singleCount: number;
  /** 旧题库可能没有这些字段，读取时按 0 处理 */
  multipleCount?: number;
  judgeCount: number;
  fillCount?: number;
  shortCount?: number;
  createdAt: string;
  updatedAt: string;
}

/** 完整题库（bank JSON 文件内容） */
export interface Bank extends Omit<BankMeta, 'file'> {
  file?: string;
  questions: Question[];
  meta?: {
    sourceFile?: string;
    model?: string;
    generator?: string;
  };
}

export interface BankIndex {
  version: number;
  updatedAt: string;
  banks: BankMeta[];
}

/** 首页展示用：远程题库 + 本地草稿合并后的摘要 */
export interface BankSummary extends BankMeta {
  local?: boolean;
  remote?: boolean;
  /** 已提交到 GitHub，等待 Pages 重建 */
  pendingPublish?: boolean;
}

export interface LocalBankRecord {
  bank: Bank;
  savedAt: string;
  pendingPublish?: boolean;
}

export interface AIConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 是否请求 response_format: json_object */
  jsonMode: boolean;
}

export interface PublishConfig {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  /** 题库 JSON 在仓库中的目录，例如 public/data/banks */
  dir: string;
}

export interface AIPreset {
  id: string;
  label: string;
  baseUrl: string;
  model: string;
  note: string;
}
