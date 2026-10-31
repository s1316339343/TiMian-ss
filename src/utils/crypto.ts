/** 字节 → base64 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64.replace(/\s+/g, ''));
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** 字符串（UTF-8）→ base64，用于 GitHub Contents API */
export function base64EncodeUtf8(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

export function base64DecodeUtf8(base64: string): string {
  return new TextDecoder().decode(base64ToBytes(base64));
}

/** PBKDF2-HMAC-SHA256，返回 base64 */
export async function pbkdf2Base64(
  password: string,
  saltBase64: string,
  iterations: number,
  bits = 256,
): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new Error('当前环境不支持 WebCrypto，请通过 HTTPS 或 localhost 访问本站');
  }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const derived = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: base64ToBytes(saltBase64),
      iterations,
      hash: 'SHA-256',
    },
    key,
    bits,
  );
  return bytesToBase64(new Uint8Array(derived));
}

/** 尽量恒定的字符串比较，避免通过耗时差异猜测哈希 */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const len = Math.max(ab.length, bb.length);
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** 生成本地唯一 id */
export function uid(prefix = ''): string {
  const rand = crypto.getRandomValues(new Uint32Array(2));
  return `${prefix}${Date.now().toString(36)}${rand[0].toString(36)}${rand[1].toString(36)}`;
}
