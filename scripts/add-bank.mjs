import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const banksDir = path.join(root, 'public', 'data', 'banks');
const indexPath = path.join(banksDir, 'index.json');

const input = process.argv[2];
if (!input) {
  console.error('用法：npm run add-bank -- "下载的题库 JSON 路径"');
  process.exit(1);
}

const source = path.resolve(process.cwd(), input);
if (!fs.existsSync(source)) {
  console.error(`找不到文件：${source}`);
  process.exit(1);
}

let raw;
try {
  raw = JSON.parse(fs.readFileSync(source, 'utf8'));
} catch (error) {
  console.error(`JSON 解析失败：${error.message}`);
  process.exit(1);
}

if (!raw || typeof raw !== 'object' || !Array.isArray(raw.questions) || !raw.questions.length) {
  console.error('这个 JSON 不是题库文件：缺少 questions 数组，或题目为空。');
  process.exit(1);
}

const id = typeof raw.id === 'string' ? raw.id.trim() : '';
if (!id) {
  console.error('题库缺少 id，无法写入索引。');
  process.exit(1);
}

const questions = raw.questions;
const counts = {
  questionCount: questions.length,
  singleCount: 0,
  multipleCount: 0,
  judgeCount: 0,
  fillCount: 0,
  shortCount: 0,
};
for (const question of questions) {
  if (question?.type === 'multiple') counts.multipleCount++;
  else if (question?.type === 'judge') counts.judgeCount++;
  else if (question?.type === 'fill') counts.fillCount++;
  else if (question?.type === 'short') counts.shortCount++;
  else counts.singleCount++;
}

const rawFile =
  typeof raw.file === 'string' && raw.file.trim() ? raw.file.trim() : `${id}.json`;
const baseFile = path.basename(rawFile);
const file = baseFile.toLowerCase().endsWith('.json') ? baseFile : `${baseFile}.json`;
const title = (typeof raw.title === 'string' && raw.title.trim()) || id;
const now = new Date().toISOString();
const createdAt = typeof raw.createdAt === 'string' && raw.createdAt ? raw.createdAt : now;
const updatedAt = typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : now;

const bank = {
  id,
  title,
  description: typeof raw.description === 'string' ? raw.description : '',
  category: typeof raw.category === 'string' ? raw.category : '',
  emoji: typeof raw.emoji === 'string' && raw.emoji ? raw.emoji : '📘',
  color: typeof raw.color === 'string' && raw.color ? raw.color : 'blue',
  source: typeof raw.source === 'string' ? raw.source : '',
  file,
  createdAt,
  updatedAt,
  questions,
  ...counts,
  ...(raw.meta && typeof raw.meta === 'object' ? { meta: raw.meta } : {}),
};

const meta = {
  id,
  title,
  description: bank.description,
  category: bank.category,
  emoji: bank.emoji,
  color: bank.color,
  source: bank.source,
  file,
  questionCount: counts.questionCount,
  singleCount: counts.singleCount,
  multipleCount: counts.multipleCount,
  judgeCount: counts.judgeCount,
  fillCount: counts.fillCount,
  shortCount: counts.shortCount,
  createdAt,
  updatedAt,
};

fs.mkdirSync(banksDir, { recursive: true });
fs.writeFileSync(path.join(banksDir, file), `${JSON.stringify(bank, null, 2)}\n`, 'utf8');

let index = { version: 1, updatedAt: now, banks: [] };
if (fs.existsSync(indexPath)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (parsed && Array.isArray(parsed.banks)) {
      index = {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        updatedAt: now,
        banks: parsed.banks.filter((item) => item && item.id !== id),
      };
    }
  } catch (error) {
    console.error(`现有 index.json 解析失败：${error.message}`);
    process.exit(1);
  }
}
index.banks = [meta, ...index.banks];
fs.writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, 'utf8');

console.log('');
console.log('已写入：');
console.log(`  public/data/banks/${file}`);
console.log('  public/data/banks/index.json');
console.log('');
console.log(`题库：${title}`);
console.log(
  `题目：${counts.questionCount} 道（单选 ${counts.singleCount} / 多选 ${counts.multipleCount} / 判断 ${counts.judgeCount} / 填空 ${counts.fillCount} / 简答 ${counts.shortCount}）`,
);
console.log('');
console.log('下一步手动提交并推送：');
console.log('  git add public/data/banks');
console.log(`  git commit -m "add bank: ${title.replace(/"/g, "'")}"`);
console.log('  git push');
