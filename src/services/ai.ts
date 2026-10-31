import { PAGE_SIZE_LIMITS } from '../config';
import type { AIConfig, Question } from '../types';
import { uid } from '../utils/crypto';

export type AIErrorKind =
  | 'config'
  | 'auth'
  | 'model'
  | 'rate'
  | 'network'
  | 'cors'
  | 'http'
  | 'format'
  | 'aborted';

export class AIError extends Error {
  kind: AIErrorKind;
  status?: number;

  constructor(message: string, kind: AIErrorKind, status?: number) {
    super(message);
    this.name = 'AIError';
    this.kind = kind;
    this.status = status;
  }
}

export interface ParseProgress {
  chunkIndex: number;
  chunkTotal: number;
  found: number;
  note?: string;
}

export interface ParseResult {
  questions: Question[];
  skipped: number;
  duplicates: number;
  lowConfidence: number;
}

export interface ParseOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ParseProgress) => void;
}

const SYSTEM_PROMPT = `你是「题面 TiMian」的题库结构化助手。用户会给你一段从考试 PDF 中提取出来的文本，请提取其中所有【单选题】【多选题】【判断题】【填空题】【简答题】，输出严格的 JSON。

输出格式（只输出 JSON 本身，不要 Markdown 代码块，不要任何解释文字）：
{"questions":[
  {"type":"single","stem":"单选题题干","options":["选项A文本","选项B文本","选项C文本","选项D文本"],"answer":"B","analysis":"简要解析","knowledge":"知识点","confidence":"high"},
  {"type":"multiple","stem":"多选题题干","options":["选项A文本","选项B文本","选项C文本","选项D文本"],"answer":["A","C"],"analysis":"简要解析","knowledge":"知识点","confidence":"high"},
  {"type":"judge","stem":"判断题题干","options":["正确","错误"],"answer":"正确","analysis":"简要解析","confidence":"high"},
  {"type":"fill","stem":"填空题题干，空格用 ____ 表示","answer":"标准答案","analysis":"简要解析","knowledge":"知识点","confidence":"high"},
  {"type":"short","stem":"简答题题干","answer":"参考答案原文","analysis":"评分要点","knowledge":"知识点","confidence":"high"}
]}

规则：
1. 只提取单选题、多选题、判断题、填空题、简答题。材料分析题、论述题、计算题一律跳过，不要输出。
2. 题干必须完整、通顺：去掉题号（如“1.”“（1）”）、分值、“单选题”“多选题”“判断题”“填空题”“简答题”等标记，保留必要的单位、数字、引号与括号，不要改写题意。
3. 单选题：type 固定为 "single"，options 为 2–6 个选项的纯文本数组，不要带“A.”“B、”这类前缀；answer 必须是单个选项字母（A/B/C/D…），且必须对应一个真实存在的选项。
4. 多选题：type 固定为 "multiple"，options 为 2–6 个选项的纯文本数组；answer 为正确选项字母组成的数组（例如 ["A","C"]），必须列出全部正确选项，不要漏选；多选题至少有两个正确选项。
5. 判断题：type 固定为 "judge"，options 固定为 ["正确","错误"]，answer 固定为 "正确" 或 "错误"。
6. 填空题：type 固定为 "fill"，不要输出 options；题干中的空格统一用 ____ 表示；answer 为标准答案原文（尽量简短，多个空格可用空格或顿号连接）。
7. 简答题：type 固定为 "short"，不要输出 options；answer 为参考答案原文，原文没有参考答案时填空字符串；analysis 可写评分要点。简答题不参与自动判分。
8. 若原文给出了答案，必须严格采用原文答案，confidence 设为 "high"；若原文没有答案，可以依据专业知识给出参考答案，confidence 设为 "low"。不要编造原文中不存在的题目。
9. analysis 用一句话说明依据，不超过 60 字；简答题可以写 2–3 条要点。knowledge 为可选的知识点标签。
10. 逐题输出，不要遗漏任何一道符合条件的题目，也不要重复。`;

/* ------------------------------------------------------------------ utils */

export function validateAIConfig(config: AIConfig): string | null {
  if (!config.baseUrl.trim()) return '请先填写接口地址（Base URL）';
  if (!config.model.trim()) return '请先填写模型名称';
  if (!config.apiKey.trim()) return '请先填写 API Key';
  if (!/^https?:\/\//i.test(config.baseUrl.trim())) return '接口地址需要以 http:// 或 https:// 开头';
  return null;
}

function buildUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  // 用户可能填了完整的 /chat/completions 地址，这里做一次兼容
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .join('');
  }
  return '';
}

async function callChat(
  config: AIConfig,
  messages: Array<{ role: string; content: string }>,
  signal: AbortSignal | undefined,
  maxTokens: number,
  allowJsonModeFallback = true,
  useJsonMode = config.jsonMode,
): Promise<string> {
  const url = buildUrl(config.baseUrl);
  const payload: Record<string, unknown> = {
    model: config.model.trim(),
    messages,
    temperature: 0.15,
    max_tokens: maxTokens,
    stream: false,
  };
  if (useJsonMode) payload.response_format = { type: 'json_object' };

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey.trim()}`,
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw new AIError('已取消解析', 'aborted');
    throw new AIError(
      '无法连接 AI 接口：可能是网络不通，或该接口不允许浏览器跨域访问（CORS）。可在「AI 设置」里改用支持跨域的接口，或按 README 部署一个代理。',
      'cors',
    );
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let detail = raw.slice(0, 400);
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: string }; message?: string };
      detail = parsed.error?.message ?? parsed.message ?? detail;
    } catch {
      /* 保留原始文本 */
    }

    if (response.status === 400 && useJsonMode && allowJsonModeFallback) {
      // 部分服务不支持 response_format，去掉后重试一次
      return callChat(config, messages, signal, maxTokens, false, false);
    }
    if (response.status === 401 || response.status === 403) {
      throw new AIError(
        `鉴权失败（${response.status}）：请检查 API Key 是否正确、是否有该模型的权限。${detail ? `接口返回：${detail}` : ''}`,
        'auth',
        response.status,
      );
    }
    if (response.status === 404) {
      throw new AIError(
        `接口或模型不存在（404）：请检查 Base URL 与模型名称。${detail ? `接口返回：${detail}` : ''}`,
        'model',
        404,
      );
    }
    if (response.status === 429) {
      throw new AIError('请求过于频繁或额度不足（429），请稍后再试，或更换 API Key。', 'rate', 429);
    }
    throw new AIError(
      `AI 接口返回错误（${response.status}）${detail ? `：${detail}` : ''}`,
      'http',
      response.status,
    );
  }

  const data = (await response.json().catch(() => null)) as {
    choices?: Array<{ message?: { content?: unknown } }>;
  } | null;
  const content = contentToText(data?.choices?.[0]?.message?.content);
  if (!content.trim()) {
    throw new AIError('AI 返回内容为空，请更换模型或稍后重试。', 'format');
  }
  return content;
}

/** 从可能带 Markdown 包裹的回复中取出 JSON 对象 */
function extractJson(raw: string): unknown {
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  let end = text.lastIndexOf('}');
  if (start === -1) {
    // 可能是直接返回数组
    const arrStart = text.indexOf('[');
    const arrEnd = text.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd > arrStart) {
      return JSON.parse(text.slice(arrStart, arrEnd + 1));
    }
    throw new AIError('AI 没有返回可解析的 JSON，请重试或更换模型。', 'format');
  }
  if (end <= start) end = text.length - 1;
  const slice = text.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    const repaired = slice
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
    try {
      return JSON.parse(repaired);
    } catch {
      throw new AIError('AI 返回的 JSON 格式有误（可能被截断），请重试。', 'format');
    }
  }
}

function pickText(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function cleanupStem(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .replace(/^\s*\d{1,4}\s*[.、．)）]\s*/, '')
    .replace(/^\s*[（(]\s*\d{1,3}\s*[)）]\s*/, '')
    .replace(/^\s*【[^】]{1,12}】\s*/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function cleanupOption(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .replace(/^\s*[A-Fa-f]\s*[.、．)）:：]\s*/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function normalizeOptions(raw: unknown): Array<{ key: string; text: string }> {
  if (!Array.isArray(raw)) return [];
  const collected: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      collected.push(item);
      continue;
    }
    if (item && typeof item === 'object') {
      const obj = item as Record<string, unknown>;
      const text = pickText(obj.text, obj.content, obj.value, obj.option, obj.label);
      if (text) collected.push(text);
    }
  }
  return collected
    .map((text, index) => ({ key: String.fromCharCode(65 + index), text: cleanupOption(text) }))
    .filter((option) => option.text.length > 0)
    .slice(0, 6);
}

const POSITIVE_WORDS = ['正确', '对', '是', '√', '✓', 'true', 't', 'yes', 'y', 'a', '1'];
const NEGATIVE_WORDS = ['错误', '错', '否', '×', '✗', 'false', 'f', 'no', 'n', 'b', '0'];

function answerValue(...values: unknown[]): string {
  for (const value of values) {
    if (Array.isArray(value)) {
      const joined = value.map((item) => String(item).trim()).filter(Boolean).join(',');
      if (joined) return joined;
    }
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function cleanAnswerText(value: string): string {
  return value
    .replace(/^\s*(参考答案|正确答案|答案|答)\s*[:：]\s*/, '')
    .trim();
}

function normalizeAnswer(raw: string, options: Question['options'], type: Question['type']): string {
  const answer = raw.trim();
  if (!answer) return '';

  if (type === 'judge') {
    const lower = answer.toLowerCase();
    if (POSITIVE_WORDS.includes(lower) || /^(正确|对|是|√|✓)/.test(answer)) return 'A';
    if (NEGATIVE_WORDS.includes(lower) || /^(错误|错|否|×|✗)/.test(answer)) return 'B';
    return '';
  }

  const letterOnly = answer.match(/^[（(]?\s*([A-Fa-f])\s*[)）]?\s*[.、．:：]?\s*$/);
  if (letterOnly) return letterOnly[1].toUpperCase();

  const compact = answer.replace(/\s+/g, '');
  const byText = options.find((option) => option.text.replace(/\s+/g, '') === compact);
  if (byText) return byText.key;

  const byKey = options.find((option) => option.key.toLowerCase() === answer.toLowerCase());
  if (byKey) return byKey.key;

  const embedded = answer.match(/[A-F]/);
  if (embedded) return embedded[0];
  return '';
}

function normalizeMultiAnswer(raw: string, options: Question['options']): string[] {
  if (!raw) return [];
  const keys: string[] = [];
  const push = (key: string): void => {
    const upper = key.toUpperCase();
    if (options.some((option) => option.key === upper)) keys.push(upper);
  };

  for (const part of raw.split(/[,，、;；\s]+/)) {
    const clean = part.trim();
    if (!clean) continue;
    // 兼容 "AC" / "ABD" 这种连写
    if (/^[A-Fa-f]{2,}$/.test(clean)) {
      for (const char of clean) push(char);
      continue;
    }
    const letter = clean.match(/^[（(]?\s*([A-Fa-f])\s*[)）]?\s*[.、．:：]?$/);
    if (letter) {
      push(letter[1]);
      continue;
    }
    const compact = clean.replace(/\s+/g, '');
    const byText = options.find((option) => option.text.replace(/\s+/g, '') === compact);
    if (byText) {
      push(byText.key);
      continue;
    }
    const embedded = clean.match(/[A-Fa-f]/);
    if (embedded) push(embedded[0]);
  }

  return Array.from(new Set(keys)).sort();
}

function detectType(
  raw: Record<string, unknown>,
  options: Question['options'],
): Question['type'] | 'skip' {
  const typeText = pickText(raw.type, raw.questionType, raw.kind, raw.category).toLowerCase();
  if (/多选|multiple|multi[_\s-]?choice|checkbox|multi-select/.test(typeText)) {
    return options.length >= 2 ? 'multiple' : 'skip';
  }
  if (/填空|fill|blank|cloze/.test(typeText)) return 'fill';
  if (/简答|问答|short|subjective|essay/.test(typeText)) return 'short';
  if (/材料|论述|计算|calculation/.test(typeText)) return 'skip';
  if (options.length === 2 && options[0].text === '正确' && options[1].text === '错误') return 'judge';
  if (/判断|judge|true[_\s-]?false|boolean|tf/.test(typeText)) {
    // 标成判断题却给出了 3 个以上选项，按单选题处理
    return options.length >= 3 ? 'single' : 'judge';
  }
  if (/单选|single|choice|radio/.test(typeText)) return 'single';
  if (options.length === 0) {
    // 没有选项、又没有明确题型时不做猜测，避免把残缺题误判成判断题
    return 'skip';
  }
  return 'single';
}

interface NormalizedChunk {
  questions: Question[];
  skipped: number;
}

function normalizeResponse(json: unknown): NormalizedChunk {
  let list: unknown[] = [];
  if (Array.isArray(json)) {
    list = json;
  } else if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>;
    const candidates = [obj.questions, obj.data, obj.items, obj.list, obj.result];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        list = candidate;
        break;
      }
      if (candidate && typeof candidate === 'object' && Array.isArray((candidate as Record<string, unknown>).questions)) {
        list = (candidate as Record<string, unknown>).questions as unknown[];
        break;
      }
    }
  }

  const questions: Question[] = [];
  let skipped = 0;

  for (const item of list) {
    if (!item || typeof item !== 'object') {
      skipped++;
      continue;
    }
    const raw = item as Record<string, unknown>;
    const stem = cleanupStem(pickText(raw.stem, raw.question, raw.title, raw.content, raw.body));
    const options = normalizeOptions(raw.options ?? raw.choices ?? raw.items);
    const type = detectType(raw, options);

    if (type === 'skip' || !stem || stem.length < 2) {
      skipped++;
      continue;
    }

    const rawAnswer = answerValue(raw.answer, raw.correctAnswer, raw.correct, raw.key, raw.result);
    const confidenceText = pickText(raw.confidence, raw.certainty).toLowerCase();
    const baseConfidence: 'high' | 'low' =
      confidenceText === 'low' || raw.uncertain === true || raw.confident === false ? 'low' : 'high';

    if (type === 'fill') {
      const answer = cleanAnswerText(rawAnswer);
      questions.push({
        id: uid('q-'),
        type: 'fill',
        stem,
        options: [],
        answer,
        analysis: pickText(raw.analysis, raw.explanation, raw.explain, raw.parse, raw.comment),
        knowledge: pickText(raw.knowledge, raw.knowledgePoint, raw.tag, raw.point),
        confidence: baseConfidence === 'high' && !answer ? 'low' : baseConfidence,
      });
      continue;
    }

    if (type === 'short') {
      questions.push({
        id: uid('q-'),
        type: 'short',
        stem,
        options: [],
        answer: cleanAnswerText(rawAnswer),
        analysis: pickText(raw.analysis, raw.explanation, raw.explain, raw.parse, raw.comment),
        knowledge: pickText(raw.knowledge, raw.knowledgePoint, raw.tag, raw.point),
        confidence: baseConfidence === 'high' && !rawAnswer ? 'low' : baseConfidence,
      });
      continue;
    }

    const finalOptions =
      type === 'judge'
        ? [
            { key: 'A', text: '正确' },
            { key: 'B', text: '错误' },
          ]
        : options;

    if (finalOptions.length < 2) {
      // 选择题至少要有两个选项，否则丢弃
      skipped++;
      continue;
    }

    let answer = '';
    let forceLow = false;
    if (type === 'multiple') {
      const keys = normalizeMultiAnswer(rawAnswer, finalOptions);
      answer = keys.join(',');
      if (keys.length < 2) forceLow = true;
    } else {
      answer = normalizeAnswer(rawAnswer, finalOptions, type);
    }

    questions.push({
      id: uid('q-'),
      type,
      stem,
      options: finalOptions,
      answer,
      analysis: pickText(raw.analysis, raw.explanation, raw.explain, raw.parse, raw.comment),
      knowledge: pickText(raw.knowledge, raw.knowledgePoint, raw.tag, raw.point),
      confidence: forceLow || (baseConfidence === 'high' && !answer) ? 'low' : baseConfidence,
    });
  }

  return { questions, skipped };
}

function stemKey(stem: string): string {
  return stem
    .replace(/[\s\u3000]/g, '')
    .replace(/[，。；：？！、,.!?;:'"“”‘’（）()\[\]【】《》<>]/g, '')
    .slice(0, 140);
}

/* ---------------------------------------------------------------- 分块 */

function softWrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= width) {
      lines.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += width) lines.push(line.slice(i, i + width));
  }
  return lines;
}

/** 按行切块，块之间保留少量重叠，避免题干恰好被切断（重叠造成的重复会在合并时去掉） */
export function splitIntoChunks(text: string, max: number, overlap = 260): string[] {
  const lines = softWrap(text, Math.max(400, Math.floor(max * 0.8)));
  const chunks: string[] = [];
  let buffer: string[] = [];
  let size = 0;

  const flush = (): void => {
    if (buffer.length) chunks.push(buffer.join('\n'));
  };

  for (const line of lines) {
    const add = line.length + 1;
    if (size + add > max && buffer.length) {
      flush();
      const tail: string[] = [];
      let tailSize = 0;
      for (let i = buffer.length - 1; i >= 0 && tailSize < overlap; i--) {
        tail.unshift(buffer[i]);
        tailSize += buffer[i].length + 1;
      }
      buffer = tail;
      size = tailSize;
    }
    buffer.push(line);
    size += add;
  }
  flush();
  return chunks.filter((chunk) => chunk.trim().length > 20);
}

/* ------------------------------------------------------------ 主流程 */

async function parseChunk(
  text: string,
  config: AIConfig,
  options: ParseOptions,
  depth = 0,
): Promise<NormalizedChunk> {
  try {
    const content = await callChat(
      config,
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `以下是从 PDF 中提取的文本，请提取其中的单选题和判断题：\n\n${text}` },
      ],
      options.signal,
      4096,
    );
    return normalizeResponse(extractJson(content));
  } catch (error) {
    if (error instanceof AIError && error.kind === 'format' && depth < 1 && text.length > 1200) {
      // 可能是输出被截断：把这一段再拆成两半重试
      const middle = Math.floor(text.length / 2);
      let cut = text.indexOf('\n', middle);
      if (cut === -1) cut = middle;
      const first = await parseChunk(text.slice(0, cut), config, options, depth + 1);
      const second = await parseChunk(text.slice(cut), config, options, depth + 1);
      return {
        questions: [...first.questions, ...second.questions],
        skipped: first.skipped + second.skipped,
      };
    }
    throw error;
  }
}

export async function parseQuestionsWithAI(
  text: string,
  config: AIConfig,
  options: ParseOptions = {},
): Promise<ParseResult> {
  const configError = validateAIConfig(config);
  if (configError) throw new AIError(configError, 'config');

  const chunks = splitIntoChunks(text, PAGE_SIZE_LIMITS.chunkSize);
  if (!chunks.length) throw new AIError('没有可解析的文本内容。', 'config');

  const all: Question[] = [];
  let skipped = 0;

  for (let i = 0; i < chunks.length; i++) {
    if (options.signal?.aborted) throw new AIError('已取消解析', 'aborted');
    options.onProgress?.({ chunkIndex: i + 1, chunkTotal: chunks.length, found: all.length });
    const result = await parseChunk(chunks[i], config, options);
    all.push(...result.questions);
    skipped += result.skipped;
  }

  // 去重（同一题可能因分块重叠出现两次）
  const seen = new Set<string>();
  const questions: Question[] = [];
  let duplicates = 0;
  for (const question of all) {
    const key = stemKey(question.stem);
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    questions.push(question);
  }

  questions.forEach((question, index) => {
    question.id = `q${index + 1}`;
  });

  options.onProgress?.({ chunkIndex: chunks.length, chunkTotal: chunks.length, found: questions.length });

  return {
    questions,
    skipped,
    duplicates,
    lowConfidence: questions.filter((question) => question.confidence === 'low').length,
  };
}

export async function testAIConfig(config: AIConfig): Promise<{ ok: boolean; message: string }> {
  const configError = validateAIConfig(config);
  if (configError) return { ok: false, message: configError };
  try {
    const content = await callChat(
      config,
      [
        { role: 'system', content: '你是一个连通性测试助手。' },
        { role: 'user', content: '请只回复 OK 两个字母，不要输出其他内容。' },
      ],
      undefined,
      512,
    );
    return { ok: true, message: `连接成功，模型返回：${content.trim().slice(0, 40) || '(空)'}` };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '连接失败' };
  }
}
