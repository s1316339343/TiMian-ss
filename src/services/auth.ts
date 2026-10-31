import { ADMIN } from '../admin.config';
import { getSessionStorage, readJSON, removeKey, writeJSON } from '../utils/storage';
import { pbkdf2Base64, timingSafeEqual } from '../utils/crypto';

const SESSION_KEY = 'timian.admin.session.v1';

interface AdminSession {
  user: string;
  exp: number;
}

export interface LoginResult {
  ok: boolean;
  error?: string;
}

/**
 * 本地登录校验。
 * 即便账号不存在也会完整跑一次 PBKDF2，避免通过响应时间探测用户名。
 */
export async function login(username: string, password: string): Promise<LoginResult> {
  const name = username.trim();
  if (!name || !password) return { ok: false, error: '请输入账号和密码' };

  let hash = '';
  try {
    hash = await pbkdf2Base64(password, ADMIN.salt, ADMIN.iterations);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '当前环境无法完成登录校验' };
  }

  const userOk = timingSafeEqual(name.toLowerCase(), ADMIN.username.toLowerCase());
  const passOk = timingSafeEqual(hash, ADMIN.hash);

  if (!userOk || !passOk) {
    // 轻微延迟，增加连续试错的成本（前端校验本身无法构成真正的安全边界）
    await new Promise((resolve) => setTimeout(resolve, 420));
    return { ok: false, error: '账号或密码不正确' };
  }

  const session: AdminSession = {
    user: ADMIN.username,
    exp: Date.now() + ADMIN.sessionHours * 3600_000,
  };
  writeJSON(getSessionStorage(), SESSION_KEY, session);
  return { ok: true };
}

export function getAdminSession(): AdminSession | null {
  const storage = getSessionStorage();
  const session = readJSON<AdminSession | null>(storage, SESSION_KEY, null);
  if (!session || typeof session.exp !== 'number' || session.user !== ADMIN.username) {
    return null;
  }
  if (session.exp <= Date.now()) {
    removeKey(storage, SESSION_KEY);
    return null;
  }
  return session;
}

export function isAdmin(): boolean {
  return getAdminSession() !== null;
}

export function logout(): void {
  removeKey(getSessionStorage(), SESSION_KEY);
}

export function sessionExpiresAt(): number | null {
  return getAdminSession()?.exp ?? null;
}
