/** 轻量跳转：修改 hash 触发路由 */
export function go(path: string): void {
  const target = path.startsWith('#') ? path.slice(1) : path;
  if (location.hash === `#${target}`) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    return;
  }
  location.hash = target;
}

/** 只允许站内路径，避免被 next 参数带到奇怪的地方 */
export function safeInternalPath(value: string | null, fallback = '/'): string {
  if (!value) return fallback;
  if (!value.startsWith('/') || value.startsWith('//')) return fallback;
  if (value.startsWith('/login')) return fallback;
  return value;
}
