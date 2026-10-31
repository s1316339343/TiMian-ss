import { APP, BANK_COLORS } from '../config';
import type { BankSummary } from '../types';
import { isAdmin, logout } from '../services/auth';
import { listBankSummaries } from '../services/bankRepo';
import { esc, icon, qs, qsa, toast } from '../utils/dom';
import { formatNumber, formatRelative } from '../utils/format';
import { go } from '../utils/nav';
import { siteFooter, siteHeader } from '../ui/layout';

interface HomeState {
  banks: BankSummary[];
  keyword: string;
  category: string;
}

export async function renderHome(root: HTMLElement): Promise<() => void> {
  document.title = `${APP.name} · ${APP.tagline}`;
  const admin = isAdmin();
  const state: HomeState = { banks: [], keyword: '', category: '全部' };

  root.innerHTML = `
    <div class="page page-home">
      ${siteHeader()}

      <section class="hero">
        <div class="hero-glow" aria-hidden="true"></div>
        <div class="container hero-inner">
          <div class="hero-copy">
            <span class="eyebrow">${icon('sparkles', 14)} AI 解析 · 纯静态部署</span>
            <h1>把 PDF 变成<br /><em>可以随时开刷</em>的题库</h1>
            <p class="hero-sub">
              上传 PDF，AI 自动提取单选、多选、判断、填空与简答，生成结构化题库。<br />
              选择一套，立刻开练。无需注册，不记录任何答题数据。
            </p>
            <div class="hero-actions">
              <button type="button" class="btn btn-primary btn-lg" data-act="scroll-banks">
                开始刷题 ${icon('arrow-right', 18)}
              </button>
              <a class="btn btn-outline btn-lg" href="${admin ? '#/admin' : '#/login'}">
                ${admin ? `${icon('upload', 18)} 上传 PDF` : `${icon('lock', 18)} 管理员入口`}
              </a>
            </div>
            <div class="hero-stats" id="hero-stats">
              <span><b>—</b> 套题库</span>
              <span><b>—</b> 道题</span>
              <span><b>—</b> 单选</span>
              <span><b>—</b> 判断</span>
            </div>
          </div>

          <div class="hero-art" aria-hidden="true">
            <div class="mock-card">
              <div class="mock-head">
                <span class="mock-chip">单选题</span>
                <span class="mock-count">03 / 25</span>
              </div>
              <p class="mock-stem">机动车在高速公路上行驶，车速超过 100 km/h 时，应当与同车道前车保持多少米以上的距离？</p>
              <div class="mock-options">
                <div class="mock-option"><span>A</span>50 米</div>
                <div class="mock-option is-picked"><span>B</span>100 米<i>${icon('check', 12)}</i></div>
                <div class="mock-option"><span>C</span>80 米</div>
                <div class="mock-option"><span>D</span>120 米</div>
              </div>
              <div class="mock-bar"><i style="width: 64%"></i></div>
            </div>
            <div class="mock-float mock-float-a">${icon('sparkles', 14)} AI 已生成 25 题</div>
            <div class="mock-float mock-float-b">${icon('check-circle', 14)} 答对 21 题</div>
          </div>
        </div>
      </section>

      <section class="container feature-strip">
        <div class="feature">
          <span class="feature-num">01</span>
          <div><b>选择题库</b><p>首页任意题库，点开即练</p></div>
        </div>
        <div class="feature">
          <span class="feature-num">02</span>
          <div><b>逐题作答</b><p>圆形选项、答题卡、随时跳题</p></div>
        </div>
        <div class="feature">
          <span class="feature-num">03</span>
          <div><b>交卷复盘</b><p>得分、错题解析、只练错题</p></div>
        </div>
      </section>

      <section class="container section" id="bank-list">
        <div class="section-head">
          <div>
            <h2>题库列表</h2>
            <p id="bank-summary">正在加载题库…</p>
          </div>
          ${admin ? `<a class="btn btn-primary" href="#/admin">${icon('plus', 18)} 新建题库</a>` : ''}
        </div>

        <p class="local-notice" id="local-notice" hidden></p>

        <div class="toolbar" id="bank-toolbar" hidden>
          <label class="search-box">
            ${icon('search', 18)}
            <input
              type="search"
              id="bank-search"
              placeholder="搜索题库名称、分类或描述…"
              autocomplete="off"
              aria-label="搜索题库"
            />
          </label>
          <div class="chips" id="category-chips"></div>
        </div>

        <div class="bank-grid" id="bank-grid">${skeletonCards()}</div>

        <div class="empty-state" id="bank-empty" hidden></div>
      </section>

      ${siteFooter()}
    </div>`;

  const grid = qs<HTMLElement>('#bank-grid', root)!;
  const toolbar = qs<HTMLElement>('#bank-toolbar', root)!;
  const searchInput = qs<HTMLInputElement>('#bank-search', root)!;
  const chips = qs<HTMLElement>('#category-chips', root)!;
  const empty = qs<HTMLElement>('#bank-empty', root)!;

  /* ------------------------------------------------------------ 筛选渲染 */

  function paintGrid(): void {
    const keyword = state.keyword.trim().toLowerCase();
    const filtered = state.banks.filter((bank) => {
      if (state.category !== '全部' && (bank.category || '') !== state.category) return false;
      if (!keyword) return true;
      const haystack = `${bank.title} ${bank.description ?? ''} ${bank.category ?? ''}`.toLowerCase();
      return haystack.includes(keyword);
    });

    if (!state.banks.length) {
      grid.hidden = true;
      grid.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = admin
        ? `<div class="empty-icon">${icon('layers', 30)}</div>
           <h3>还没有题库</h3>
           <p>上传第一份 PDF，AI 会帮你提取题目并生成题库。</p>
           <a class="btn btn-primary" href="#/admin">${icon('upload', 18)} 上传 PDF 生成题库</a>`
        : `<div class="empty-icon">${icon('layers', 30)}</div>
           <h3>还没有题库</h3>
           <p>管理员上传 PDF 并发布后，题库会出现在这里。</p>
           <a class="btn btn-outline" href="#/login">${icon('lock', 18)} 管理员登录</a>`;
      return;
    }

    empty.hidden = true;
    grid.hidden = false;

    if (!filtered.length) {
      grid.innerHTML = `
        <div class="no-result">
          ${icon('search', 26)}
          <h3>没有找到匹配的题库</h3>
          <p>换个关键词，或者清空筛选条件再试试。</p>
          <button type="button" class="btn btn-outline btn-sm" data-act="reset-filter">清空筛选</button>
        </div>`;
      return;
    }

    grid.innerHTML = filtered.map(bankCard).join('');
  }

  function paintChips(): void {
    const categories = Array.from(
      new Set(state.banks.map((bank) => bank.category).filter((value): value is string => Boolean(value))),
    );
    if (categories.length <= 1) {
      chips.innerHTML = '';
      return;
    }
    const all = ['全部', ...categories];
    chips.innerHTML = all
      .map(
        (category) => `
        <button type="button" class="chip${category === state.category ? ' is-active' : ''}"
          data-act="filter" data-category="${esc(category)}">
          ${esc(category)}
          <i>${category === '全部' ? state.banks.length : state.banks.filter((bank) => bank.category === category).length}</i>
        </button>`,
      )
      .join('');
  }

  function paintStats(): void {
    const total = state.banks.reduce((sum, bank) => sum + bank.questionCount, 0);
    const single = state.banks.reduce((sum, bank) => sum + bank.singleCount, 0);
    const multiple = state.banks.reduce((sum, bank) => sum + (bank.multipleCount ?? 0), 0);
    const judge = state.banks.reduce((sum, bank) => sum + bank.judgeCount, 0);
    const fill = state.banks.reduce((sum, bank) => sum + (bank.fillCount ?? 0), 0);
    const short = state.banks.reduce((sum, bank) => sum + (bank.shortCount ?? 0), 0);
    qs<HTMLElement>('#hero-stats', root)!.innerHTML = `
      <span><b>${state.banks.length}</b> 套题库</span>
      <span><b>${formatNumber(total)}</b> 道题</span>
      <span><b>${formatNumber(single)}</b> 单选</span>
      ${multiple ? `<span><b>${formatNumber(multiple)}</b> 多选</span>` : ''}
      <span><b>${formatNumber(judge)}</b> 判断</span>
      ${fill ? `<span><b>${formatNumber(fill)}</b> 填空</span>` : ''}
      ${short ? `<span><b>${formatNumber(short)}</b> 简答</span>` : ''}`;
    qs<HTMLElement>('#bank-summary', root)!.textContent = state.banks.length
      ? `${state.banks.length} 套题库 · 共 ${formatNumber(total)} 道题 · 点开任意一套开始练习`
      : '题库还是空的';

    const localNotice = qs<HTMLElement>('#local-notice', root);
    if (localNotice) {
      const locals = state.banks.filter((bank) => bank.local).length;
      localNotice.hidden = locals === 0;
      if (locals) {
        localNotice.innerHTML = `${icon('info', 16)} 本机有 <b>${locals}</b> 套未发布的题库，只有你自己能看到；到 <a href="#/admin">管理后台</a> 下载题库 JSON，按「手动发布」步骤提交到仓库后，线上首页才会出现。`;
      }
    }
  }

  /* -------------------------------------------------------------- 事件 */

  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement;
    const actionEl = target.closest<HTMLElement>('[data-act]');
    if (!actionEl) return;
    const action = actionEl.dataset.act;

    if (action === 'scroll-banks') {
      qs<HTMLElement>('#bank-list', root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    if (action === 'logout') {
      logout();
      toast('已退出管理员登录', 'success');
      go('/');
      return;
    }
    if (action === 'reset-filter') {
      state.keyword = '';
      state.category = '全部';
      searchInput.value = '';
      paintChips();
      paintGrid();
      return;
    }
    if (action === 'filter') {
      state.category = actionEl.dataset.category ?? '全部';
      qsa<HTMLElement>('.chip', chips).forEach((chip) => {
        chip.classList.toggle('is-active', chip === actionEl);
      });
      paintGrid();
    }
  };
  root.addEventListener('click', onClick);

  searchInput.addEventListener('input', () => {
    state.keyword = searchInput.value;
    paintGrid();
  });

  /* -------------------------------------------------------------- 数据 */

  const token = root.dataset.routeToken;
  const { banks } = await listBankSummaries();
  if (root.dataset.routeToken === token) {
    state.banks = banks;
    toolbar.hidden = banks.length === 0;
    paintStats();
    paintChips();
    paintGrid();
  }

  return () => root.removeEventListener('click', onClick);
}

function skeletonCards(): string {
  return Array.from({ length: 3 })
    .map(
      () => `
      <div class="bank-card is-skeleton" aria-hidden="true">
        <div class="bank-cover sk-block"></div>
        <div class="bank-body">
          <div class="sk-line sk-line-lg"></div>
          <div class="sk-line"></div>
          <div class="sk-line sk-line-sm"></div>
        </div>
      </div>`,
    )
    .join('');
}

function bankCard(bank: BankSummary): string {
  const color = (BANK_COLORS as readonly string[]).includes(bank.color ?? '') ? bank.color : 'blue';
  const badges = [
    bank.local ? '<span class="bank-badge is-local">仅本机</span>' : '',
  ].join('');

  return `
    <a class="bank-card" href="#/quiz/${encodeURIComponent(bank.id)}" data-color="${esc(color)}">
      <div class="bank-cover">
        <span class="bank-emoji" aria-hidden="true">${esc(bank.emoji || '📘')}</span>
        <span class="bank-cat">${esc(bank.category || '综合')}</span>
        <span class="bank-badges">${badges}</span>
        <span class="bank-cover-pattern" aria-hidden="true"></span>
      </div>
      <div class="bank-body">
        <h3 class="bank-title">${esc(bank.title)}</h3>
        <p class="bank-desc">${esc(bank.description?.trim() || '暂无简介')}</p>
        <div class="bank-meta">
          <span>${icon('book', 14)} ${formatNumber(bank.questionCount)} 题</span>
          <span>单选 ${bank.singleCount}</span>
          ${bank.multipleCount ? `<span>多选 ${bank.multipleCount}</span>` : ''}
          <span>判断 ${bank.judgeCount}</span>
          ${bank.fillCount ? `<span>填空 ${bank.fillCount}</span>` : ''}
          ${bank.shortCount ? `<span>简答 ${bank.shortCount}</span>` : ''}
        </div>
      </div>
      <div class="bank-foot">
        <span class="bank-time">${icon('clock', 13)} ${formatRelative(bank.updatedAt)}</span>
        <span class="bank-go">开始刷题 ${icon('arrow-right', 15)}</span>
      </div>
    </a>`;
}
