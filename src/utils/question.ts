import type { Question, QuestionType } from '../types';

/** 会把选项按字母 key 拆开、去重、排序；用于多选答案 */
export function splitAnswerKeys(value: string | null | undefined): string[] {
  if (!value) return [];
  const keys: string[] = [];
  for (const part of value.split(/[,，、;；\s]+/)) {
    const clean = part.trim();
    if (!clean) continue;
    if (/^[A-Fa-f]{2,}$/.test(clean)) {
      for (const char of clean) keys.push(char.toUpperCase());
      continue;
    }
    const match = clean.match(/^[（(]?\s*([A-Fa-f])\s*[)）]?\s*[.、．:：]?$/);
    if (match) keys.push(match[1].toUpperCase());
  }
  return Array.from(new Set(keys))
    .filter((key) => /^[A-F]$/.test(key))
    .sort();
}

/** 填空题比对：忽略首尾标点、大小写和所有空白 */
export function normalizeFillText(value: string | null | undefined): string {
  if (!value) return '';
  return value
    .trim()
    .replace(/^[\s,，。.；;、:：!！?？]+|[\s,，。.；;、:：!！?？]+$/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

export function answerKeys(question: Question): string[] {
  if (question.type === 'short' || question.type === 'fill') return [];
  if (question.type === 'multiple') return splitAnswerKeys(question.answer);
  const answer = question.answer.trim().toUpperCase();
  return answer ? [answer] : [];
}

export function chosenKeys(question: Question, chosen: string | undefined): string[] {
  if (question.type === 'fill') return [];
  if (question.type === 'multiple') return splitAnswerKeys(chosen);
  return chosen ? [chosen.toUpperCase()] : [];
}

/**
 * 单选 / 判断：答案完全一致；
 * 多选：必须全选对，少选、多选、错选都算错（与常见考试规则一致）；
 * 填空：忽略空格、大小写和首尾标点后，文本一致即得分。
 */
export function isCorrectChoice(question: Question, chosen: string | undefined): boolean {
  if (question.type === 'short') return false;
  if (question.type === 'fill') {
    const expected = normalizeFillText(question.answer);
    const actual = normalizeFillText(chosen);
    return Boolean(expected) && expected === actual;
  }
  const expected = answerKeys(question);
  const actual = chosenKeys(question, chosen);
  if (!expected.length || !actual.length) return false;
  if (question.type === 'multiple') {
    return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
  }
  return actual[0] === expected[0];
}

export function hasChoice(question: Question, chosen: string | undefined): boolean {
  if (question.type === 'short' || question.type === 'fill') return false;
  return chosenKeys(question, chosen).length > 0;
}

/** 判断题显示“正确 / 错误”，其他类型显示字母 */
export function optionKeyLabel(question: Question, key: string): string {
  if (question.type === 'judge') return key === 'A' ? '正确' : '错误';
  return key;
}

/** 答案的简短文本，例如 "A、C" / "正确" / "参考答案原文" */
export function answerSummary(question: Question): string {
  if (question.type === 'short') return question.answer.trim() || '未提供参考答案';
  if (question.type === 'fill') return question.answer.trim() || '未设置';
  const keys = answerKeys(question);
  if (!keys.length) return '未设置';
  return keys.map((key) => optionKeyLabel(question, key)).join('、');
}

export function isShortQuestion(question: Question): boolean {
  return question.type === 'short';
}

export function isChoiceType(type: QuestionType): boolean {
  return type === 'single' || type === 'multiple' || type === 'judge';
}

export const TYPE_LABELS: Record<QuestionType, string> = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  fill: '填空题',
  short: '简答题',
};
