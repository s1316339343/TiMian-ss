import { APP } from '../config';
import { isAdmin, login } from '../services/auth';
import { icon, qs, toast } from '../utils/dom';
import { go, safeInternalPath } from '../utils/nav';

export function renderLogin(root: HTMLElement, ctx: { query: URLSearchParams }): void {
  const next = safeInternalPath(ctx.query.get('next'), '/admin');
  if (isAdmin()) {
    go(next);
    return;
  }

  document.title = `管理员登录 · ${APP.name}`;
  root.innerHTML = `
    <div class="page login-page">
      <div class="login-glow" aria-hidden="true"></div>
      <a class="login-back" href="#/">${icon('arrow-left', 18)} 返回首页</a>

      <div class="login-shell">
        <aside class="login-brand">
          <div class="login-brand-top">
            <span class="brand-mark brand-mark-lg" aria-hidden="true">题</span>
            <div><b>${APP.name}</b><small>${APP.en}</small></div>
          </div>
          <h1>上传 PDF<br />AI 生成你的<br /><em>专属题库</em></h1>
          <ul class="login-points">
            <li>${icon('sparkles', 18)}<div><b>AI 结构化解析</b><span>自动提取单选、多选、判断、填空、简答</span></div></li>
            <li>${icon('layers', 18)}<div><b>静态 JSON 题库</b><span>题库直接托管在 GitHub Pages</span></div></li>
            <li>${icon('shield', 18)}<div><b>零记录</b><span>不收集账号，不存储答题数据</span></div></li>
          </ul>
          <p class="login-brand-foot">ADMIN CONSOLE · GITHUB PAGES</p>
        </aside>

        <section class="login-panel">
          <div class="login-head">
            <span class="eyebrow">${icon('lock', 14)} 仅限管理员</span>
            <h2>登录后台</h2>
            <p>登录后可以上传 PDF、调用 AI 解析并发布题库。</p>
          </div>

          <form id="login-form" novalidate>
            <label class="field">
              <span class="field-label">账号</span>
              <div class="input-wrap">
                ${icon('user', 18)}
                <input name="username" class="input" value="admin" autocomplete="username" placeholder="请输入管理员账号" spellcheck="false" />
              </div>
            </label>
            <label class="field">
              <span class="field-label">密码</span>
              <div class="input-wrap">
                ${icon('lock', 18)}
                <input name="password" class="input" type="password" autocomplete="current-password" placeholder="请输入密码" />
                <button type="button" class="input-action" data-act="toggle-password" aria-label="显示密码">${icon('eye', 18)}</button>
              </div>
            </label>
            <p class="form-error" id="login-error" role="alert" hidden></p>
            <button class="btn btn-primary btn-block btn-lg" type="submit" id="login-submit">登录</button>
          </form>

          <p class="login-note">
            ${icon('info', 15)} 账号校验在浏览器本地完成，仅用于限制上传与 AI 解析入口，不会上传或保存你的密码。
          </p>
        </section>
      </div>
    </div>`;

  const form = qs<HTMLFormElement>('#login-form', root)!;
  const submit = qs<HTMLButtonElement>('#login-submit', root)!;
  const errorEl = qs<HTMLElement>('#login-error', root)!;
  const passwordInput = qs<HTMLInputElement>('input[name="password"]', root)!;

  const setLoading = (loading: boolean): void => {
    submit.disabled = loading;
    submit.innerHTML = loading ? '<span class="spinner"></span> 正在校验…' : '登录';
  };

  const showError = (message: string): void => {
    errorEl.textContent = message;
    errorEl.hidden = false;
    form.classList.remove('is-shake');
    void form.offsetWidth;
    form.classList.add('is-shake');
    passwordInput.focus();
    passwordInput.select();
  };

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    const data = new FormData(form);
    const username = String(data.get('username') ?? '').trim();
    const password = String(data.get('password') ?? '');

    if (!username || !password) {
      showError('请输入账号和密码');
      return;
    }

    setLoading(true);
    try {
      const result = await login(username, password);
      if (!result.ok) {
        showError(result.error ?? '登录失败');
        return;
      }
      toast('登录成功，欢迎回来', 'success');
      go(next);
    } finally {
      setLoading(false);
    }
  });

  root.querySelector('[data-act="toggle-password"]')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    const visible = passwordInput.type === 'text';
    passwordInput.type = visible ? 'password' : 'text';
    button.innerHTML = icon(visible ? 'eye' : 'eye-off', 18);
    button.setAttribute('aria-label', visible ? '显示密码' : '隐藏密码');
    passwordInput.focus();
  });
}
