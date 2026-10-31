import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const banksDir = path.join(root, 'public', 'data', 'banks');
const indexPath = path.join(banksDir, 'index.json');

const id = (process.argv[2] ?? '').trim();
if (!id) {
  console.error('用法：npm run remove-bank -- <题库 id>');
  process.exit(1);
}

if (!fs.existsSync(indexPath)) {
  console.error(`找不到 ${indexPath}`);
  process.exit(1);
}

let index;
try {
  index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
} catch (error) {
  console.error(`index.json 解析失败：${error.message}`);
  process.exit(1);
}

if (!index || !Array.isArray(index.banks)) {
  console.error('index.json 格式不正确：缺少 banks 数组。');
  process.exit(1);
}

const meta = index.banks.find((item) => item && item.id === id);
if (!meta) {
  console.error(`没有找到 id 为 ${id} 的题库。`);
  console.error(`现有 id：${index.banks.map((item) => item?.id).filter(Boolean).join(', ')}`);
  process.exit(1);
}

const title = typeof meta.title === 'string' && meta.title ? meta.title : id;
const rawFile = typeof meta.file === 'string' && meta.file ? meta.file : `${id}.json`;
const file = path.basename(rawFile);
if (file === 'index.json') {
  console.error('拒绝删除 index.json，请检查题库 meta.file。');
  process.exit(1);
}
const bankPath = path.join(banksDir, file);

console.log('');
console.log(`准备删除题库：${title}`);
console.log(`   id：${id}`);
console.log(`   文件：public/data/banks/${file}`);
console.log('');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('确认删除？输入 yes 继续：');
rl.close();

if (answer.trim().toLowerCase() !== 'yes') {
  console.log('已取消，没有修改任何文件。');
  process.exit(0);
}

if (fs.existsSync(bankPath)) {
  fs.rmSync(bankPath);
  console.log(`已删除 public/data/banks/${file}`);
} else {
  console.log(`文件不存在，只清理索引：public/data/banks/${file}`);
}

const next = {
  version: typeof index.version === 'number' ? index.version : 1,
  updatedAt: new Date().toISOString(),
  banks: index.banks.filter((item) => item && item.id !== id),
};
fs.writeFileSync(indexPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
console.log('已更新 public/data/banks/index.json');
console.log('');
console.log('下一步手动提交并推送：');
console.log('  git add -A public/data/banks');
console.log(`  git commit -m "remove bank: ${title.replace(/"/g, "'")}"`);
console.log('  git push');
