import { APP } from '../config';
import { isAdmin } from '../services/auth';
import { icon } from '../utils/dom';

export function brandMark(size: 'sm' | 'md' = 'md'): string {
  return `<span class="brand-mark${size === 'sm' ? ' brand-mark-sm' : ''}" aria-hidden="true">题</span>`;
}

export function siteHeader(): string {
  const admin = isAdmin();
  return `
    <header class="site-header">
      <div class="container header-inner">
        <a class="brand" href="#/" aria-label="${APP.name}首页">
          ${brandMark()}
          <span class="brand-text"><strong>${APP.name}</strong><small>${APP.en}</small></span>
        </a>
        <nav class="header-actions" aria-label="站点导航">
          ${
            admin
              ? `<a class="btn btn-soft btn-sm" href="#/admin">${icon('upload', 16)}<span>管理后台</span></a>
                 <button type="button" class="btn btn-ghost btn-sm" data-act="logout" aria-label="退出登录">${icon('logout', 16)}<span class="hide-xs">退出</span></button>`
              : `<a class="btn btn-soft btn-sm" href="#/login">${icon('lock', 16)}<span>管理员登录</span></a>`
          }
        </nav>
      </div>
    </header>`;
}

export function siteFooter(): string {
  return `
    <footer class="site-footer">
      <div class="container footer-inner">
        <div class="footer-brand">
          ${brandMark('sm')}
          <div class="footer-brand-text">
            <b>${APP.name} <span>${APP.en}</span></b>
            <small>${APP.tagline}</small>
          </div>
        </div>
        <p class="footer-note">${icon('shield', 15)} 本站没有后端数据库，不收集、不存储任何答题记录；题库以 JSON 文件静态托管在 GitHub Pages。</p>
        <p class="footer-copy">© ${new Date().getFullYear()} ${APP.name} · Static Site powered by GitHub Pages</p>
      </div>
    </footer>`;
}
