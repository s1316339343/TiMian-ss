import { DATA_DIR, STORAGE_KEYS } from '../config';
import type {
  Bank,
  BankIndex,
  BankMeta,
  BankSummary,
  LocalBankRecord,
  Question,
  QuestionOption,
  QuestionType,
} from '../types';
import { uid } from '../utils/crypto';
import { splitAnswerKeys } from '../utils/question';
import { getLocalStorage, readJSON, writeJSON } from '../utils/storage';

const LOCAL_KEY = STORAGE_KEYS.localBanks;
const MAX_LOCAL_BANKS = 30;

export function nowISO(): string {
  return new Date().toISOString();
}

/** 静态数据目录（相对当前页面），兼容 GitHub Pages 子路径 */
export function dataUrl(path: string): string {
  return new URL(`${DATA_DIR}${path.replace(/^\/+/, '')}`, document.baseURI).href;
}

export function countByType(questions: Question[]): {
  questionCount: number;
  singleCount: number;
  multipleCount: number;
  judgeCount: number;
  fillCount: number;
  shortCount: number;
} {
  let singleCount = 0;
  let multipleCount = 0;
  let judgeCount = 0;
  let fillCount = 0;
  let shortCount = 0;
  for (const question of questions) {
    if (question.type === 'multiple') multipleCount++;
    else if (question.type === 'judge') judgeCount++;
    else if (question.type === 'fill') fillCount++;
    else if (question.type === 'short') shortCount++;
    else singleCount++;
  }
  return {
    questionCount: questions.length,
    singleCount,
    multipleCount,
    judgeCount,
    fillCount,
    shortCount,
  };
}

export function toMeta(bank: Bank): BankMeta {
  const counts = countByType(bank.questions);
  return {
    id: bank.id,
    title: bank.title,
    description: bank.description ?? '',
    category: bank.category ?? '',
    emoji: bank.emoji ?? '📘',
    color: bank.color ?? 'blue',
    source: bank.source ?? '',
    file: bank.file ?? `${bank.id}.json`,
    ...counts,
    createdAt: bank.createdAt,
    updatedAt: bank.updatedAt,
  };
}

function answerText(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => String(item)).join(',');
  return typeof value === 'string' ? value.trim() : '';
}

function cleanAnswerText(value: string): string {
  return value
    .replace(/^\s*(参考答案|正确答案|答案|答)\s*[:：]\s*/, '')
    .trim();
}

export function normalizeQuestion(raw: unknown, index: number): Question | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  const stem = typeof obj.stem === 'string' ? obj.stem.trim() : '';
  if (!stem) return null;

  const type: QuestionType =
    obj.type === 'multiple'
      ? 'multiple'
      : obj.type === 'judge'
        ? 'judge'
        : obj.type === 'fill'
          ? 'fill'
          : obj.type === 'short'
            ? 'short'
            : 'single';

  const rawAnswer = answerText(obj.answer ?? obj.referenceAnswer ?? obj.reference);

  if (type === 'fill') {
    const answer = cleanAnswerText(rawAnswer);
    if (!answer) return null;
    return {
      id: typeof obj.id === 'string' && obj.id ? obj.id : `q${index + 1}`,
      type,
      stem,
      options: [],
      answer,
      analysis: typeof obj.analysis === 'string' ? obj.analysis : '',
      knowledge: typeof obj.knowledge === 'string' ? obj.knowledge : '',
      scored: obj.scored !== false,
      confidence: obj.confidence === 'low' ? 'low' : 'high',
    };
  }

  if (type === 'short') {
    return {
      id: typeof obj.id === 'string' && obj.id ? obj.id : `q${index + 1}`,
      type,
      stem,
      options: [],
      answer: cleanAnswerText(rawAnswer),
      analysis: typeof obj.analysis === 'string' ? obj.analysis : '',
      knowledge: typeof obj.knowledge === 'string' ? obj.knowledge : '',
      scored: false,
      confidence: obj.confidence === 'low' || !rawAnswer ? 'low' : 'high',
    };
  }

  let options: QuestionOption[] = [];

  if (type === 'judge') {
    options = [
      { key: 'A', text: '正确' },
      { key: 'B', text: '错误' },
    ];
  } else if (Array.isArray(obj.options)) {
    options = obj.options
      .filter((item): item is { text: string } => Boolean(item) && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string')
      .map((item, optionIndex) => ({
        key: String.fromCharCode(65 + optionIndex),
        text: item.text.trim(),
      }))
      .filter((option) => option.text.length > 0)
      .slice(0, 6);
  }

  if (options.length < 2) return null;

  let answer = '';
  if (type === 'multiple') {
    const keys = splitAnswerKeys(rawAnswer).filter((key) => options.some((option) => option.key === key));
    if (!keys.length) return null;
    answer = keys.join(',');
  } else {
    const upper = rawAnswer.toUpperCase();
    answer = options.some((option) => option.key === upper) ? upper : '';
    if (!answer) return null;
  }

  return {
    id: typeof obj.id === 'string' && obj.id ? obj.id : `q${index + 1}`,
    type,
    stem,
    options,
    answer,
    analysis: typeof obj.analysis === 'string' ? obj.analysis : '',
    knowledge: typeof obj.knowledge === 'string' ? obj.knowledge : '',
    scored: obj.scored !== false,
    confidence: obj.confidence === 'low' ? 'low' : 'high',
  };
}

export function normalizeBank(raw: unknown, fallbackId?: string): Bank | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.questions)) return null;

  const questions: Question[] = [];
  for (const item of obj.questions) {
    const question = normalizeQuestion(item, questions.length);
    if (question) questions.push(question);
  }
  if (!questions.length) return null;
  // 统一重新编号，避免手写 JSON 里的重复 id 影响作答记录
  questions.forEach((question, index) => {
    question.id = `q${index + 1}`;
  });

  const createdAt = typeof obj.createdAt === 'string' ? obj.createdAt : nowISO();
  const updatedAt = typeof obj.updatedAt === 'string' ? obj.updatedAt : createdAt;
  const counts = countByType(questions);
  const meta = obj.meta && typeof obj.meta === 'object' ? (obj.meta as Bank['meta']) : undefined;

  return {
    id: typeof obj.id === 'string' && obj.id ? obj.id : (fallbackId ?? uid('bank-')),
    title: typeof obj.title === 'string' && obj.title.trim() ? obj.title.trim() : '未命名题库',
    description: typeof obj.description === 'string' ? obj.description : '',
    category: typeof obj.category === 'string' ? obj.category : '',
    emoji: typeof obj.emoji === 'string' && obj.emoji ? obj.emoji : '📘',
    color: typeof obj.color === 'string' && obj.color ? obj.color : 'blue',
    source: typeof obj.source === 'string' ? obj.source : '',
    file: typeof obj.file === 'string' && obj.file ? obj.file : fallbackId ? `${fallbackId}.json` : '',
    ...counts,
    createdAt,
    updatedAt,
    questions,
    meta,
  };
}

/* ------------------------------------------------------------ 本地草稿 */

function readLocalRecords(): LocalBankRecord[] {
  const list = readJSON<LocalBankRecord[]>(getLocalStorage(), LOCAL_KEY, []);
  if (!Array.isArray(list)) return [];
  return list.filter((record) => record && record.bank && typeof record.bank.id === 'string');
}

function writeLocalRecords(records: LocalBankRecord[]): boolean {
  return writeJSON(getLocalStorage(), LOCAL_KEY, records.slice(0, MAX_LOCAL_BANKS));
}

export function listLocalBanks(): LocalBankRecord[] {
  return readLocalRecords();
}

export function getLocalBank(id: string): Bank | null {
  const record = readLocalRecords().find((item) => item.bank.id === id);
  return record ? record.bank : null;
}

export function saveLocalBank(bank: Bank): boolean {
  const records = readLocalRecords();
  const counts = countByType(bank.questions);
  const stored: Bank = {
    ...bank,
    ...counts,
    file: bank.file ?? `${bank.id}.json`,
    updatedAt: bank.updatedAt || nowISO(),
  };
  const next: LocalBankRecord[] = [
    { bank: stored, savedAt: nowISO() },
    ...records.filter((record) => record.bank.id !== bank.id),
  ];
  return writeLocalRecords(next);
}

export function removeLocalBank(id: string): boolean {
  return writeLocalRecords(readLocalRecords().filter((record) => record.bank.id !== id));
}

/* -------------------------------------------------------------- 远程数据 */

function isValidMeta(value: unknown): value is BankMeta {
  if (!value || typeof value !== 'object') return false;
  const meta = value as Partial<BankMeta>;
  return typeof meta.id === 'string' && meta.id.length > 0 && typeof meta.file === 'string';
}

export async function fetchRemoteIndex(): Promise<BankIndex | null> {
  try {
    const response = await fetch(`${dataUrl('index.json')}?v=${Date.now()}`, { cache: 'no-cache' });
    if (!response.ok) return null;
    const json = (await response.json()) as Partial<BankIndex>;
    if (!json || !Array.isArray(json.banks)) return null;
    return {
      version: typeof json.version === 'number' ? json.version : 1,
      updatedAt: typeof json.updatedAt === 'string' ? json.updatedAt : '',
      banks: json.banks.filter(isValidMeta),
    };
  } catch {
    return null;
  }
}

export async function fetchRemoteBank(meta: BankMeta): Promise<Bank | null> {
  try {
    const response = await fetch(dataUrl(meta.file), { cache: 'no-cache' });
    if (!response.ok) return null;
    const bank = normalizeBank(await response.json(), meta.id);
    if (!bank) return null;
    return { ...bank, file: meta.file };
  } catch {
    return null;
  }
}

export interface BankListResult {
  banks: BankSummary[];
  remoteReachable: boolean;
}

/** 合并「静态仓库里的题库」与「管理员浏览器里的草稿」 */
export async function listBankSummaries(): Promise<BankListResult> {
  const [index, records] = await Promise.all([fetchRemoteIndex(), Promise.resolve(readLocalRecords())]);
  const remoteBanks = index?.banks ?? [];
  const byId = new Map<string, BankSummary>();

  for (const meta of remoteBanks) {
    byId.set(meta.id, { ...meta, remote: true });
  }

  const keptRecords: LocalBankRecord[] = [];
  let changed = false;

  for (const record of records) {
    const remote = byId.get(record.bank.id);
    if (remote) {
      const remoteTime = new Date(remote.updatedAt).getTime();
      const localTime = new Date(record.bank.updatedAt).getTime();
      // 远程已经是同一版本或更新 → 说明发布已生效，清掉本地副本
      if (Number.isFinite(remoteTime) && remoteTime >= localTime) {
        changed = true;
        continue;
      }
    }
    byId.set(record.bank.id, {
      ...toMeta(record.bank),
      local: true,
      remote: Boolean(remote),
    });
    keptRecords.push(record);
  }

  if (changed) writeLocalRecords(keptRecords);

  const banks = Array.from(byId.values()).sort((a, b) =>
    String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')),
  );
  return { banks, remoteReachable: index !== null };
}

export async function loadBankById(id: string): Promise<Bank | null> {
  const local = getLocalBank(id);
  if (local) return local;

  const index = await fetchRemoteIndex();
  const meta = index?.banks.find((item) => item.id === id);
  if (!meta) return null;
  return fetchRemoteBank(meta);
}

/** 用于「下载 JSON，手动提交」的备份路径 */
export function bankFilePayload(bank: Bank): string {
  return JSON.stringify(
    {
      id: bank.id,
      title: bank.title,
      description: bank.description ?? '',
      category: bank.category ?? '',
      emoji: bank.emoji ?? '📘',
      color: bank.color ?? 'blue',
      source: bank.source ?? '',
      createdAt: bank.createdAt,
      updatedAt: bank.updatedAt,
      meta: bank.meta,
      questions: bank.questions,
    },
    null,
    2,
  );
}
