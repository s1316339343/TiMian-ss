#!/usr/bin/env node
/**
 * 重新生成管理员账号配置。
 *
 * 用法：
 *   npm run hash-password -- "你的新密码"
 *   npm run hash-password -- "你的新密码" admin
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [password, usernameArg] = process.argv.slice(2);
const username = (usernameArg || 'admin').trim();

if (!password || password.length < 8) {
  console.error('用法：npm run hash-password -- "新密码" [账号名]');
  console.error('密码至少需要 8 位。');
  process.exit(1);
}

if (password.length > 200) {
  console.error('密码过长，请控制在 200 个字符以内。');
  process.exit(1);
}

const iterations = 150000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, iterations, 32, 'sha256');

const content = `/**
 * 管理员账号（仅前端校验）
 * ------------------------------------------------------------------
 * 这是纯静态站点，没有后端。此校验只用于控制「上传 PDF / 调用 AI」
 * 入口，无法真正防止懂技术的人直接调用接口，请务必配合以下边界：
 *   1. AI Key 与 GitHub Token 只保存在管理员本机的浏览器里，绝不入库；
 *   2. 不要把带 Token 的浏览器借给别人；
 *   3. 部署前用 \`npm run hash-password -- "你的新密码"\` 重新生成下面的值。
 *
 * 修改密码后需要重新构建并部署，旧会话会在 12 小时后过期。
 */
export const ADMIN = {
  username: ${JSON.stringify(username)},
  /** base64 编码的 16 字节随机盐 */
  salt: '${salt.toString('base64')}',
  /** PBKDF2-HMAC-SHA256 迭代次数 */
  iterations: ${iterations},
  /** base64 编码的 32 字节派生密钥 */
  hash: '${hash.toString('base64')}',
  /** 登录态有效期（小时），仅存于 sessionStorage */
  sessionHours: 12,
};
`;

writeFileSync(resolve(root, 'src/admin.config.ts'), content, 'utf8');
console.log('已更新 src/admin.config.ts');
console.log(`  账号：${username}`);
console.log('  下一步：重新构建并部署（npm run build）');
console.log('  提示：已登录的浏览器不会被强制下线，会话会在 12 小时后自动过期。');
