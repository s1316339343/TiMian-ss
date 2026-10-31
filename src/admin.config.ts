/**
 * 管理员账号（仅前端校验）
 * ------------------------------------------------------------------
 * 这是纯静态站点，没有后端。此校验只用于控制「上传 PDF / 调用 AI」
 * 入口，无法真正防止懂技术的人直接调用接口，请务必配合以下边界：
 *   1. AI Key 与 GitHub Token 只保存在管理员本机的浏览器里，绝不入库；
 *   2. 不要把带 Token 的浏览器借给别人；
 *   3. 部署前用 `npm run hash-password -- "你的新密码"` 重新生成下面的值。
 *
 * 修改密码后需要重新构建并部署，旧会话会在 12 小时后过期。
 */
export const ADMIN = {
  username: "admin",
  /** base64 编码的 16 字节随机盐 */
  salt: 'XzK7R4lbUOUJgYbjMeBwbw==',
  /** PBKDF2-HMAC-SHA256 迭代次数 */
  iterations: 150000,
  /** base64 编码的 32 字节派生密钥 */
  hash: 'r/roFdbYkm3tbbkeERxzOb9UB1HL2uRGzXr/4V/vokk=',
  /** 登录态有效期（小时），仅存于 sessionStorage */
  sessionHours: 12,
};
