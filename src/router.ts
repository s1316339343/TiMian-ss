import { APP } from './config';
import { isAdmin } from './services/auth';
import { renderAdmin } from './pages/admin';
import { renderHome } from './pages/home';
import { renderLogin } from './pages/login';
import { renderQuiz } from './pages/quiz';
import { esc, icon } from './utils/dom';

export interface RouteContext {
  path: string;
  params: Record<string, string>;
  query: URLSearchParams;
}

type Page = (root: HTMLElement, ctx: RouteContext) => void | (() => void) | Promise<void | (() => void)>;

interface RouteDef {
  pattern: RegExp;
  keys: string[];
  page: Page;
  admin?: boolean;
}

const routes: RouteDef[] = [
  { pattern: /^\/$/, keys: [], page: renderHome },
  { pattern: /^\/login$/, keys: [], page: renderLogin },
  { pattern: /^\/quiz\/([^/]+)$/, keys: ['id'], page: renderQuiz },
  { pattern: /^\/admin$/, keys: [], page: renderAdmin, admin: true },
];

let cleanup: (() => void) | null = null;
let navigationId = 0;
let started = false;

export function parseHash(): { path: string; query: URLSearchParams } {
  const raw = location.hash.replace(/^#/, '') || '/';
  const queryIndex = raw.indexOf('?');
  const path = (queryIndex === -1 ? raw : raw.slice(0, queryIndex)) || '/';
  const query = new URLSearchParams(queryIndex === -1 ? '' : raw.slice(queryIndex + 1));
  return { path, query };
}

function matchRoute(path: string): { route: RouteDef; params: Record<string, string> } | null {
  for (const route of routes) {
    const matched = path.match(route.pattern);
    if (!matched) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = matched[index + 1] ?? '';
    });
    return { route, params };
  }
  return null;
}

export function navigate(path: string): void {
  const target = path.startsWith('#') ? path.slice(1) : path;
  if (location.hash === `#${target}`) {
    void render();
    return;
  }
  location.hash = target;
}

function notFoundView(): string {
  return `
    <div class="page simple-page">
      <div class="simple-card">
        <span class="simple-mark">404</span>
        <h1>页面不存在</h1>
        <p>链接可能已经失效，或者地址输入有误。</p>
        <a class="btn btn-primary" href="#/">${icon('arrow-left', 18)} 返回首页</a>
      </div>
    </div>`;
}

function errorView(error: unknown): string {
  const message = error instanceof Error ? error.message : '未知错误';
  return `
    <div class="page simple-page">
      <div class="simple-card">
        <span class="simple-mark is-error">${icon('alert', 28)}</span>
        <h1>页面加载失败</h1>
        <p>${esc(message)}</p>
        <div class="simple-actions">
          <a class="btn btn-primary" href="#/">返回首页</a>
          <button class="btn btn-outline" onclick="location.reload()">重新加载</button>
        </div>
      </div>
    </div>`;
}

async function render(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) return;

  const { path, query } = parseHash();
  const matched = matchRoute(path);

  if (!matched) {
    cleanup?.();
    cleanup = null;
    root.dataset.routeToken = String(++navigationId);
    root.innerHTML = notFoundView();
    document.title = `页面不存在 · ${APP.name}`;
    return;
  }

  if (matched.route.admin && !isAdmin()) {
    location.replace(`#/login?next=${encodeURIComponent(path)}`);
    return;
  }

  cleanup?.();
  cleanup = null;

  const navId = ++navigationId;
  root.dataset.routeToken = String(navId);
  root.innerHTML = '';

  try {
    const result = await matched.route.page(root, { path, params: matched.params, query });
    if (navId !== navigationId) {
      if (typeof result === 'function') result();
      return;
    }
    cleanup = typeof result === 'function' ? result : null;
  } catch (error) {
    console.error('[router]', error);
    if (navId !== navigationId) return;
    root.innerHTML = errorView(error);
    document.title = `加载失败 · ${APP.name}`;
  }

  window.scrollTo({ top: 0, behavior: 'auto' });
}

export function startRouter(): void {
  if (started) return;
  started = true;

  window.addEventListener('hashchange', () => {
    void render();
  });

  if (!location.hash) {
    history.replaceState(null, '', '#/');
  }
  void render();
}
