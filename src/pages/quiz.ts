import { APP, PASS_SCORE } from '../config';
import type { Bank, Question } from '../types';
import { loadBankById } from '../services/bankRepo';
import { brandMark } from '../ui/layout';
import { confirmDialog, esc, icon, qs, qsa, toast } from '../utils/dom';
import { formatDuration, percent } from '../utils/format';
import { go } from '../utils/nav';
import {
  answerKeys,
  chosenKeys,
  isCorrectChoice,
  isScoredQuestion,
  isUnscoredQuestion,
  optionKeyLabel,
  TYPE_LABELS,
} from '../utils/question';

interface ResultData {
  correct: number;
  wrong: number;
  blank: number;
  objectiveTotal: number;
  shortTotal: number;
  unscoredTotal: number;
  shortRevealed: number;
  total: number;
  score: number;
  elapsed: number;
}

type ReviewFilter = 'all' | 'wrong';

export async function renderQuiz(
  root: HTMLElement,
  ctx: { params: Record<string, string> },
): Promise<void | (() => void)> {
  document.title = `加载题库 · ${APP.name}`;
  root.innerHTML = `
    <div class="page quiz-loading">
      <span class="spinner spinner-lg"></span>
      <p>正在加载题库…</p>
    </div>`;

  let id = ctx.params.id ?? '';
  try {
    id = decodeURIComponent(id);
  } catch {
    /* 保持原样 */
  }

  const token = root.dataset.routeToken;
  const bank = await loadBankById(id);
  if (root.dataset.routeToken !== token) return;

  if (!bank) {
    document.title = `题库不存在 · ${APP.name}`;
    root.innerHTML = `
      <div class="page simple-page">
        <div class="simple-card">
          <span class="simple-mark is-error">${icon('alert', 28)}</span>
          <h1>题库不存在</h1>
          <p>这套题库可能已经被删除，或者链接不完整。</p>
          <a class="btn btn-primary" href="#/">${icon('arrow-left', 18)} 返回题库列表</a>
        </div>
      </div>`;
    return;
  }

  const app = new QuizApp(root, bank);
  return () => app.destroy();
}

class QuizApp {
  private readonly root: HTMLElement;
  private readonly bank: Bank;
  private questions: Question[];
  private answers = new Map<string, string>();
  private shortAnswers = new Map<string, string>();
  private revealed = new Set<string>();
  private index = 0;
  private startedAt = Date.now();
  private timerId: number | null = null;
  private submitted = false;
  private result: ResultData | null = null;
  private modeLabel = '';
  private reviewFilter: ReviewFilter = 'all';
  private destroyed = false;

  constructor(root: HTMLElement, bank: Bank) {
    this.root = root;
    this.bank = bank;
    this.questions = bank.questions;

    this.renderShell();
    this.root.addEventListener('click', this.onClickBound);
    this.root.addEventListener('input', this.onInputBound);
    document.addEventListener('keydown', this.onKeyDownBound);
    window.addEventListener('beforeunload', this.onBeforeUnloadBound);
    this.startTimer();
    this.paint();
  }

  /* ---------------------------------------------------------- 生命周期 */

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopTimer();
    this.root.removeEventListener('click', this.onClickBound);
    this.root.removeEventListener('input', this.onInputBound);
    document.removeEventListener('keydown', this.onKeyDownBound);
    window.removeEventListener('beforeunload', this.onBeforeUnloadBound);
    document.body.classList.remove('has-sheet');
  }

  private get current(): Question {
    return this.questions[this.index];
  }

  private get objectiveTotal(): number {
    return this.questions.filter(isScoredQuestion).length;
  }

  private get shortTotal(): number {
    return this.questions.filter((question) => question.type === 'short').length;
  }

  private get unscoredTotal(): number {
    return this.questions.filter(isUnscoredQuestion).length;
  }

  private startTimer(): void {
    this.stopTimer();
    this.updateTimer();
    this.timerId = window.setInterval(() => this.updateTimer(), 1000);
  }

  private stopTimer(): void {
    if (this.timerId !== null) {
      window.clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  private updateTimer(): void {
    const timer = qs<HTMLElement>('.js-timer', this.root);
    if (timer) timer.textContent = formatDuration(Date.now() - this.startedAt);
  }

  /* ------------------------------------------------------------ 渲染 */

  private renderShell(): void {
    const total = this.questions.length;
    const objectiveTotal = this.objectiveTotal;
    const unscoredTotal = this.unscoredTotal;
    const unscoredLegend = unscoredTotal
      ? '<span><i class="dot is-unscored"></i>不计分</span>'
      : '';
    const sheetNote = unscoredTotal
      ? `<p class="sheet-short-note">${unscoredTotal} 题 · 不计分</p>`
      : '';

    this.root.innerHTML = `
      <div class="page quiz-page">
        <header class="quiz-top">
          <div class="container quiz-top-inner">
            <button type="button" class="icon-btn" data-act="exit" aria-label="退出答题">${icon('arrow-left', 20)}</button>
            <div class="quiz-heading">
              <h1 class="quiz-title" title="${esc(this.bank.title)}">${esc(this.bank.title)}</h1>
              <p class="quiz-sub">
                ${this.modeLabel ? `<span class="quiz-mode">${esc(this.modeLabel)}</span>` : ''}
                <span>共 ${total} 题</span>
                ${
                  unscoredTotal
                    ? `<span class="quiz-sub-note">不计分 ${unscoredTotal}</span>`
                    : ''
                }
              </p>
            </div>
            <div class="quiz-top-actions">
              <span class="timer" title="已用时间">${icon('clock', 15)}<span class="js-timer">00:00</span></span>
              <button type="button" class="btn btn-ghost btn-sm only-desktop" data-act="open-sheet">
                ${icon('list', 16)} 答题卡
              </button>
            </div>
          </div>
          <div class="quiz-progress" aria-hidden="true"><span class="js-progress"></span></div>
        </header>

        <main class="container quiz-main">
          <section class="q-panel">
            <div id="q-body" class="q-body"></div>
            <div class="q-nav">
              <button type="button" class="btn btn-outline js-prev" data-act="prev">
                ${icon('arrow-left', 18)} 上一题
              </button>
              <button type="button" class="btn btn-ghost only-mobile" data-act="open-sheet">
                ${icon('list', 18)} 答题卡
              </button>
              <button type="button" class="btn btn-primary js-next" data-act="next"></button>
            </div>
          </section>

          <aside class="sheet-panel only-desktop">
            <div class="sheet-card">
              <div class="sheet-head">
                <b>答题卡</b>
                <span class="js-answered">0/${objectiveTotal}</span>
              </div>
              <div class="sheet-grid js-sheet-grid"></div>
              <div class="sheet-legend">
                <span><i class="dot is-answered"></i>已答</span>
                <span><i class="dot"></i>未答</span>
                <span><i class="dot is-current"></i>当前</span>
                ${unscoredLegend}
              </div>
              ${sheetNote}
              <button type="button" class="btn btn-primary btn-block" data-act="submit">交卷</button>
              <p class="sheet-tip">交卷后查看得分与逐题解析${unscoredTotal ? '（含不计分题）' : ''}</p>
            </div>
          </aside>
        </main>

        <div class="sheet-modal" id="sheet-modal">
          <div class="sheet-backdrop" data-act="close-sheet"></div>
          <div class="sheet-dialog" role="dialog" aria-modal="true" aria-label="答题卡">
            <span class="sheet-handle" aria-hidden="true"></span>
            <div class="sheet-head">
              <b>答题卡</b>
              <div class="sheet-head-right">
                <span class="js-answered">0/${objectiveTotal}</span>
                <button type="button" class="icon-btn icon-btn-sm" data-act="close-sheet" aria-label="关闭答题卡">${icon('x', 18)}</button>
              </div>
            </div>
            <div class="sheet-grid js-sheet-grid"></div>
            <div class="sheet-legend">
              <span><i class="dot is-answered"></i>已答</span>
              <span><i class="dot"></i>未答</span>
              <span><i class="dot is-current"></i>当前</span>
              ${unscoredLegend}
            </div>
            ${sheetNote}
            <button type="button" class="btn btn-primary btn-block" data-act="submit">交卷</button>
          </div>
        </div>
      </div>`;

    document.title = `${this.bank.title} · 答题 · ${APP.name}`;
    document.body.classList.remove('has-sheet');
  }

  private paint(): void {
    this.renderQuestion();
    this.paintMeta();
    this.paintSheet();
    this.updateTimer();
  }

  private renderQuestion(): void {
    const question = this.current;
    if (!question) return;
    const body = qs<HTMLElement>('#q-body', this.root);
    if (!body) return;

    const isShort = question.type === 'short';
    const isFill = question.type === 'fill';
    const isMultiple = question.type === 'multiple';
    const isUnscored = !isScoredQuestion(question);
    const isLast = this.index === this.questions.length - 1;
    const chosen = chosenKeys(question, this.answers.get(question.id));

    const options = question.options
      .map((option) => {
        const active = chosen.includes(option.key);
        const keyText = question.type === 'judge' ? (option.key === 'A' ? '对' : '错') : option.key;
        return `
          <button
            type="button"
            class="option${active ? ' is-selected' : ''}"
            data-act="option"
            data-key="${esc(option.key)}"
            role="${isMultiple ? 'checkbox' : 'radio'}"
            aria-checked="${active}"
          >
            <span class="option-key">${keyText}</span>
            <span class="option-text">${esc(option.text)}</span>
            <span class="option-mark" aria-hidden="true">${icon('check', 15)}</span>
          </button>`;
      })
      .join('');

    const shortBlock = isShort ? this.shortBlock(question) : '';
    const fillBlock = isFill ? this.fillBlock(question) : '';

    body.innerHTML = `
      <article class="question is-${question.type}">
        <div class="q-head">
          <span class="q-index">第 <b>${this.index + 1}</b> 题<i>/ ${this.questions.length}</i></span>
          <span class="q-type ${question.type}">${TYPE_LABELS[question.type]}</span>
          ${
            question.confidence === 'low'
              ? `<span class="q-flag" title="AI 未能确认这道题的答案，仅供参考">待确认</span>`
              : ''
          }
          ${
            isUnscored && !isShort
              ? '<span class="q-flag is-unscored-flag" title="本题不计入总分和错题">不计分</span>'
              : ''
          }
        </div>
        <h2 class="q-stem">${esc(question.stem)}</h2>
        ${
          isShort
            ? shortBlock
            : isFill
              ? fillBlock
              : `<div class="options" role="${isMultiple ? 'group' : 'radiogroup'}" aria-label="选项">${options}</div>`
        }
        ${
          isMultiple
            ? isUnscored
              ? '<p class="q-hint q-hint-multi">多选题：全部选对才显示为正确；本题不计分</p>'
              : '<p class="q-hint q-hint-multi">多选题：全部选对才得分，少选 / 错选均不得分</p>'
            : ''
        }
        ${
          isUnscored && !isShort
            ? '<p class="q-hint q-hint-unscored">本题不计分，仅作练习；不计入总分和错题</p>'
            : ''
        }
        ${
          isFill
            ? `<p class="q-hint only-desktop">按 Enter ${isLast ? '交卷' : '进入下一题'}</p>`
            : ''
        }
        ${
          isShort || isFill
            ? ''
            : `<p class="q-hint only-desktop">快捷键：A–D 或 1–4 ${
                isMultiple ? '切换选项' : '选择'
              } · ← → 切换 · Enter ${isLast ? '交卷' : '下一题'}</p>`
        }
        ${
          isLast
            ? '<p class="q-end">已经是最后一题，确认无误后可以交卷。</p>'
            : ''
        }
      </article>`;
  }

  private fillBlock(question: Question): string {
    const value = this.answers.get(question.id) ?? '';
    return `
      <div class="fill-answer">
        <label class="fill-label" for="fill-input">你的答案</label>
        <input
          id="fill-input"
          class="input fill-input"
          data-act="fill-input"
          value="${esc(value)}"
          placeholder="填写答案"
          autocomplete="off"
          spellcheck="false"
        />
        <p class="fill-hint">${icon('info', 14)} 按文本比对：忽略空格、大小写和首尾标点</p>
      </div>`;
  }

  private shortBlock(question: Question): string {
    const draft = this.shortAnswers.get(question.id) ?? '';
    const revealed = this.revealed.has(question.id);
    const reference = question.answer.trim();
    return `
      <div class="short-answer">
        <label class="short-label" for="short-input">你的作答（可选，不计分）</label>
        <textarea
          id="short-input"
          class="textarea short-input"
          data-act="short-input"
          rows="4"
          placeholder="可以先写下要点，再查看参考答案…"
        >${esc(draft)}</textarea>
        <div class="short-toolbar">
          <button type="button" class="btn btn-outline btn-sm" data-act="reveal-short">
            ${revealed ? '收起参考答案' : '查看参考答案'}
          </button>
          <span class="short-note">${icon('info', 14)} 简答题不计入得分，参考答案仅用于自测</span>
        </div>
        ${
          revealed
            ? `<div class="short-reference">
                 <span>参考答案</span>
                 <p>${reference ? esc(reference) : '本题暂未提供参考答案'}</p>
                 ${question.analysis ? `<p class="short-analysis">${esc(question.analysis)}</p>` : ''}
               </div>`
            : ''
        }
      </div>`;
  }

  private paintMeta(): void {
    const total = this.questions.length;
    const position = this.index + 1;
    const progress = qs<HTMLElement>('.js-progress', this.root);
    if (progress) progress.style.width = `${(position / total) * 100}%`;

    const prev = qs<HTMLButtonElement>('.js-prev', this.root);
    if (prev) prev.disabled = this.index === 0;

    const next = qs<HTMLButtonElement>('.js-next', this.root);
    if (next) {
      const last = this.index === total - 1;
      next.innerHTML = last ? `交卷 ${icon('check', 18)}` : `下一题 ${icon('arrow-right', 18)}`;
      next.classList.toggle('btn-primary', !last);
      next.classList.toggle('btn-success', last);
    }
  }

  private paintSheet(): void {
    const objective = this.questions.filter(isScoredQuestion);
    const objectiveAnswered = objective.filter((question) => this.answers.has(question.id)).length;

    const html = this.questions
      .map((question, index) => {
        const isShort = question.type === 'short';
        const isUnscored = isUnscoredQuestion(question);
        const answered = !isShort && this.answers.has(question.id);
        const revealed = isShort && this.revealed.has(question.id);
        const drafted = isShort && Boolean(this.shortAnswers.get(question.id)?.trim());
        const current = index === this.index;
        const classes = [
          'sheet-cell',
          answered ? 'is-answered' : '',
          isShort ? 'is-short' : '',
          isUnscored ? 'is-unscored' : '',
          revealed ? 'is-revealed' : '',
          drafted && !revealed ? 'is-drafted' : '',
          current ? 'is-current' : '',
        ]
          .filter(Boolean)
          .join(' ');
        return `<button type="button" class="${classes}" data-act="jump" data-index="${index}" aria-label="第 ${index + 1} 题${
          isShort ? '（简答题，不计分）' : isUnscored ? '（不计分）' : ''
        }" title="${isUnscored ? '不计分题' : `第 ${index + 1} 题`}">${index + 1}</button>`;
      })
      .join('');

    qsa<HTMLElement>('.js-sheet-grid', this.root).forEach((grid) => {
      grid.innerHTML = html;
    });
    const answeredLabel = objective.length
      ? `${objectiveAnswered}/${objective.length}`
      : `不计分 ${this.unscoredTotal}`;
    qsa<HTMLElement>('.js-answered', this.root).forEach((el) => {
      el.textContent = answeredLabel;
    });
  }

  private paintOptions(): void {
    const question = this.current;
    if (!question) return;
    const chosen = chosenKeys(question, this.answers.get(question.id));
    qsa<HTMLElement>('.option', this.root).forEach((option) => {
      const active = chosen.includes(option.dataset.key ?? '');
      option.classList.toggle('is-selected', active);
      option.setAttribute('aria-checked', String(active));
    });
  }

  /* ------------------------------------------------------------ 交互 */

  private select(key: string): void {
    if (this.submitted) return;
    const question = this.current;
    if (!question || question.type === 'short' || question.type === 'fill') return;
    if (!question.options.some((option) => option.key === key)) return;

    if (question.type === 'multiple') {
      const keys = chosenKeys(question, this.answers.get(question.id));
      const next = keys.includes(key) ? keys.filter((item) => item !== key) : [...keys, key].sort();
      if (next.length) this.answers.set(question.id, next.join(','));
      else this.answers.delete(question.id);
    } else {
      this.answers.set(question.id, key);
    }

    this.paintOptions();
    this.paintSheet();
  }

  private go(delta: number): void {
    const next = this.index + delta;
    if (next < 0 || next >= this.questions.length) return;
    this.index = next;
    this.renderQuestion();
    this.paintMeta();
    this.paintSheet();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  private jump(index: number): void {
    if (!Number.isFinite(index) || index < 0 || index >= this.questions.length) return;
    this.index = index;
    this.closeSheet();
    this.renderQuestion();
    this.paintMeta();
    this.paintSheet();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  private openSheet(): void {
    const modal = qs<HTMLElement>('#sheet-modal', this.root);
    if (!modal) return;
    modal.classList.add('is-open');
    document.body.classList.add('has-sheet');
  }

  private closeSheet(): void {
    const modal = qs<HTMLElement>('#sheet-modal', this.root);
    if (modal) modal.classList.remove('is-open');
    document.body.classList.remove('has-sheet');
  }

  private computeResult(): ResultData {
    const objective = this.questions.filter(isScoredQuestion);
    let correct = 0;
    let wrong = 0;
    for (const question of objective) {
      const chosen = this.answers.get(question.id);
      if (!chosen) continue;
      if (isCorrectChoice(question, chosen)) correct++;
      else wrong++;
    }
    const blank = objective.length - correct - wrong;
    const shortTotal = this.shortTotal;
    const shortRevealed = this.questions.filter(
      (question) => question.type === 'short' && this.revealed.has(question.id),
    ).length;

    return {
      correct,
      wrong,
      blank,
      objectiveTotal: objective.length,
      shortTotal,
      unscoredTotal: this.unscoredTotal,
      shortRevealed,
      total: this.questions.length,
      score: objective.length ? Math.round((correct / objective.length) * 100) : 0,
      elapsed: Date.now() - this.startedAt,
    };
  }

  private async submit(): Promise<void> {
    if (this.submitted) return;
    const scored = this.questions.filter(isScoredQuestion);
    const scoredAnswered = scored.filter((question) => this.answers.has(question.id)).length;
    const blank = scored.length - scoredAnswered;
    if (blank > 0) {
      const unscoredHint = this.unscoredTotal ? '不计分题可以留空。' : '';
      const confirmed = await confirmDialog({
        title: '还有题目没有作答',
        message: `还有 ${blank} 道计分题未作答，交卷后会按答错计算。${unscoredHint}`,
        confirmText: '交卷',
        cancelText: '继续答题',
      });
      if (!confirmed) return;
    }

    this.result = this.computeResult();
    this.submitted = true;
    this.stopTimer();
    this.closeSheet();
    document.removeEventListener('keydown', this.onKeyDownBound);
    window.removeEventListener('beforeunload', this.onBeforeUnloadBound);
    this.renderResult();

    document.title = this.result.objectiveTotal
      ? `${this.result.score} 分 · ${this.bank.title}`
      : `不计分 · ${this.bank.title}`;
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  private restart(questions: Question[], modeLabel: string): void {
    this.questions = questions;
    this.modeLabel = modeLabel;
    this.answers = new Map();
    this.shortAnswers = new Map();
    this.revealed = new Set();
    this.index = 0;
    this.startedAt = Date.now();
    this.submitted = false;
    this.result = null;
    this.reviewFilter = 'all';
    this.destroyed = false;

    document.addEventListener('keydown', this.onKeyDownBound);
    window.addEventListener('beforeunload', this.onBeforeUnloadBound);

    this.renderShell();
    this.startTimer();
    this.paint();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  /* ------------------------------------------------------------ 结果页 */

  private renderResult(): void {
    const result = this.result;
    if (!result) return;

    const hasObjective = result.objectiveTotal > 0;
    const wrongTotal = result.wrong + result.blank;
    const scoreClass = !hasObjective
      ? 'is-mid'
      : result.score >= PASS_SCORE
        ? 'is-good'
        : result.score >= 60
          ? 'is-mid'
          : 'is-low';
    const headline = !hasObjective
      ? '本套题没有计分题'
      : result.score >= PASS_SCORE
        ? '太棒了，顺利通过！'
        : result.score >= 60
          ? '再做几套就稳了'
          : '别灰心，重点看解析';
    const unscoredNote = result.unscoredTotal
      ? `<p class="result-short-note">${icon('info', 14)} ${result.unscoredTotal} 题不计分，仅展示答案/参考${
          result.shortTotal ? `（其中简答 ${result.shortTotal} 题）` : ''
        }${result.shortRevealed ? ` · 已查看 ${result.shortRevealed} 题参考答案` : ''}</p>`
      : '';

    this.root.innerHTML = `
      <div class="page result-page">
        <header class="result-top">
          <div class="container result-top-inner">
            <a class="brand" href="#/" aria-label="${APP.name}首页">
              ${brandMark()}
              <span class="brand-text"><strong>${APP.name}</strong><small>${APP.en}</small></span>
            </a>
            <a class="btn btn-soft btn-sm" href="#/">${icon('arrow-left', 16)} 返回首页</a>
          </div>
        </header>

        <main class="container result-main">
          <section class="result-card">
            <div class="score-ring ${scoreClass}" style="--pct: ${hasObjective ? result.score : 0}">
              <div class="score-inner${hasObjective ? '' : ' score-empty'}">
                <b>${hasObjective ? result.score : '—'}</b>
                <span>${hasObjective ? '分' : '不计分'}</span>
              </div>
            </div>
            <div class="result-body">
              <span class="result-mode">${esc(this.modeLabel || this.bank.title)}</span>
              <h1>${headline}</h1>
              <p class="result-sub">
                ${
                  hasObjective
                    ? `答对 <b class="ok">${result.correct}</b> 题 ·
                       答错 <b class="bad">${result.wrong}</b> 题
                       ${result.blank ? `· 未答 <b>${result.blank}</b> 题` : ''}
                       ${result.unscoredTotal ? `· ${result.unscoredTotal} 题不计分` : ''}`
                    : `共 <b>${result.unscoredTotal}</b> 道不计分题，请对照答案自测`
                }
              </p>
              ${unscoredNote}
              <div class="result-metrics">
                <div><span>正确率</span><b>${
                  hasObjective ? `${percent(result.correct, result.objectiveTotal)}%` : '—'
                }</b></div>
                <div><span>用时</span><b>${formatDuration(result.elapsed)}</b></div>
                <div><span>及格线</span><b>${hasObjective ? `${PASS_SCORE} 分` : '不计分'}</b></div>
              </div>
              <div class="result-actions">
                <button type="button" class="btn btn-primary" data-act="restart">
                  ${icon('refresh', 16)} 再做一遍
                </button>
                ${
                  wrongTotal > 0
                    ? `<button type="button" class="btn btn-outline" data-act="practice-wrong">
                         ${icon('target', 16)} 只练错题（${wrongTotal}）
                       </button>`
                    : ''
                }
                <a class="btn btn-ghost" href="#/">返回首页</a>
              </div>
              <p class="result-note">
                ${icon('shield', 14)} 本次作答只存在于当前页面，刷新或离开后不会保留。
              </p>
            </div>
          </section>

          <section class="review">
            <div class="review-head">
              <div>
                <h2>答题解析</h2>
                <p>${
                  hasObjective
                    ? `共 ${result.total} 题 · ${
                        wrongTotal > 0 ? `${wrongTotal} 题需要回顾` : '计分题全部答对'
                      }${result.unscoredTotal ? ` · ${result.unscoredTotal} 题不计分` : ''}`
                    : `共 ${result.unscoredTotal} 道不计分题`
                }</p>
              </div>
              <div class="review-tabs">
                <button type="button" class="is-active" data-act="filter-review" data-filter="all">
                  全部 ${result.total}
                </button>
                <button type="button" data-act="filter-review" data-filter="wrong">
                  错题 ${wrongTotal}
                </button>
              </div>
            </div>
            <div class="review-list" id="review-list"></div>
          </section>
        </main>
      </div>`;

    this.paintReview();
  }

  private paintReview(): void {
    const list = qs<HTMLElement>('#review-list', this.root);
    if (!list) return;

    qsa<HTMLElement>('[data-act="filter-review"]', this.root).forEach((button) => {
      button.classList.toggle('is-active', button.dataset.filter === this.reviewFilter);
    });

    let opened = 0;
    const items = this.questions
      .map((question, index) => ({ question, index }))
      .filter(({ question }) => {
        if (this.reviewFilter === 'all') return true;
        if (!isScoredQuestion(question)) return false;
        return !isCorrectChoice(question, this.answers.get(question.id));
      })
      .map(({ question, index }) => {
        if (question.type === 'short') return this.shortReviewItem(question, index);
        const scored = isScoredQuestion(question);

        if (question.type === 'fill') {
          const chosen = this.answers.get(question.id) ?? '';
          const correct = isCorrectChoice(question, chosen);
          const status = scored ? (chosen ? (correct ? 'correct' : 'wrong') : 'blank') : 'unscored';
          const statusLabel = scored
            ? chosen
              ? correct
                ? '答对'
                : '答错'
              : '未答'
            : '不计分';
          const open = scored && status !== 'correct' && opened++ < 1;
          return this.fillReviewItem(question, index, chosen, correct, status, statusLabel, open);
        }

        const chosen = this.answers.get(question.id) ?? '';
        const correct = isCorrectChoice(question, chosen);
        const status = scored ? (chosen ? (correct ? 'correct' : 'wrong') : 'blank') : 'unscored';
        const statusLabel = scored
          ? chosen
            ? correct
              ? '答对'
              : '答错'
            : '未答'
          : '不计分';
        const open = scored && status !== 'correct' && opened++ < 1;

        const expected = answerKeys(question);
        const chosenList = chosenKeys(question, chosen);
        const options = question.options
          .map((option) => {
            const isAnswer = expected.includes(option.key);
            const isChosen = chosenList.includes(option.key);
            const keyText = question.type === 'judge' ? (option.key === 'A' ? '对' : '错') : option.key;
            const tag = isAnswer
              ? question.type === 'multiple'
                ? isChosen
                  ? '正确答案'
                  : '漏选'
                : '正确答案'
              : isChosen
                ? '错选'
                : '';
            return `
              <div class="review-option${isAnswer ? ' is-correct' : ''}${
                isChosen && !isAnswer ? ' is-picked-wrong' : ''
              }">
                <span class="ro-key">${keyText}</span>
                <span class="ro-text">${esc(option.text)}</span>
                ${
                  tag
                    ? `<span class="ro-tag ${isAnswer ? 'is-ok' : 'is-bad'}">${tag}</span>`
                    : ''
                }
              </div>`;
          })
          .join('');

        const chosenText = chosenList.length
          ? chosenList.map((key) => optionKeyLabel(question, key)).join('、')
          : '未作答';
        const correctText = expected.map((key) => optionKeyLabel(question, key)).join('、') || '未设置';

        return `
          <details class="review-item is-${status}"${open ? ' open' : ''}>
            <summary>
              <span class="review-status ${status}">${statusLabel}</span>
              <span class="review-stem">${index + 1}. ${esc(question.stem)}</span>
              <span class="review-chev" aria-hidden="true">${icon('chevron-down', 18)}</span>
            </summary>
            <div class="review-body">
              <div class="review-options">${options}</div>
              <div class="review-summary">
                <span>你的答案：<b class="${correct ? 'ok' : 'bad'}">${chosenText}</b></span>
                <span>正确答案：<b class="ok">${correctText}</b></span>
              </div>
              ${
                question.analysis
                  ? `<div class="review-analysis"><span>解析</span><p>${esc(question.analysis)}</p></div>`
                  : ''
              }
              ${
                question.knowledge
                  ? `<p class="review-knowledge">${icon('target', 14)} 知识点：${esc(question.knowledge)}</p>`
                  : ''
              }
            </div>
          </details>`;
      })
      .join('');

    list.innerHTML = items || '<p class="review-empty">没有需要回顾的题目。</p>';
  }

  private fillReviewItem(
    question: Question,
    index: number,
    chosen: string,
    correct: boolean,
    status: string,
    statusLabel: string,
    open: boolean,
  ): string {
    return `
      <details class="review-item is-${status}"${open ? ' open' : ''}>
        <summary>
          <span class="review-status ${status}">${statusLabel}</span>
          <span class="review-stem">${index + 1}. ${esc(question.stem)}</span>
          <span class="review-chev" aria-hidden="true">${icon('chevron-down', 18)}</span>
        </summary>
        <div class="review-body">
          <div class="fill-review">
            <div class="fill-answer-row">
              <span>你的答案</span>
              <p class="${correct ? 'ok' : 'bad'}">${chosen ? esc(chosen) : '未作答'}</p>
            </div>
            <div class="fill-answer-row">
              <span>正确答案</span>
              <p class="ok">${esc(question.answer) || '未设置'}</p>
            </div>
          </div>
          ${
            question.analysis
              ? `<div class="review-analysis"><span>解析</span><p>${esc(question.analysis)}</p></div>`
              : ''
          }
          ${
            question.knowledge
              ? `<p class="review-knowledge">${icon('target', 14)} 知识点：${esc(question.knowledge)}</p>`
              : ''
          }
        </div>
      </details>`;
  }

  private shortReviewItem(question: Question, index: number): string {
    const draft = this.shortAnswers.get(question.id) ?? '';
    const reference = question.answer.trim();
    return `
      <details class="review-item is-short">
        <summary>
          <span class="review-status short">简答</span>
          <span class="review-stem">${index + 1}. ${esc(question.stem)}</span>
          <span class="review-chev" aria-hidden="true">${icon('chevron-down', 18)}</span>
        </summary>
        <div class="review-body">
          <p class="short-review-note">${icon('info', 14)} 简答题不计入得分，以下为参考答案。</p>
          ${
            draft
              ? `<div class="short-draft"><span>你的作答</span><p>${esc(draft)}</p></div>`
              : ''
          }
          <div class="short-reference">
            <span>参考答案</span>
            <p>${reference ? esc(reference) : '本题暂未提供参考答案'}</p>
          </div>
          ${
            question.analysis
              ? `<div class="review-analysis"><span>解析</span><p>${esc(question.analysis)}</p></div>`
              : ''
          }
          ${
            question.knowledge
              ? `<p class="review-knowledge">${icon('target', 14)} 知识点：${esc(question.knowledge)}</p>`
              : ''
          }
        </div>
      </details>`;
  }

  /* ------------------------------------------------------------ 事件 */

  private readonly onClickBound = (event: Event): void => {
    void this.handleClick(event);
  };

  private async handleClick(event: Event): Promise<void> {
    const target = event.target as HTMLElement;
    const actionEl = target.closest<HTMLElement>('[data-act]');
    if (!actionEl) return;
    const action = actionEl.dataset.act;

    switch (action) {
      case 'option':
        this.select(actionEl.dataset.key ?? '');
        break;
      case 'prev':
        this.go(-1);
        break;
      case 'next':
        if (this.index >= this.questions.length - 1) await this.submit();
        else this.go(1);
        break;
      case 'open-sheet':
        this.openSheet();
        break;
      case 'close-sheet':
        this.closeSheet();
        break;
      case 'jump':
        this.jump(Number(actionEl.dataset.index));
        break;
      case 'reveal-short': {
        const question = this.current;
        if (!question || question.type !== 'short') break;
        if (this.revealed.has(question.id)) this.revealed.delete(question.id);
        else this.revealed.add(question.id);
        this.renderQuestion();
        this.paintSheet();
        break;
      }
      case 'submit':
        await this.submit();
        break;
      case 'restart':
        this.restart(this.bank.questions, '');
        break;
      case 'practice-wrong': {
        const subset = this.questions.filter(
          (question) =>
            isScoredQuestion(question) && !isCorrectChoice(question, this.answers.get(question.id)),
        );
        if (!subset.length) {
          toast('这套题没有错题，太棒了', 'success');
          return;
        }
        this.restart(subset, '错题重练');
        break;
      }
      case 'filter-review':
        this.reviewFilter = actionEl.dataset.filter === 'wrong' ? 'wrong' : 'all';
        this.paintReview();
        break;
      case 'exit': {
        if (!this.submitted && (this.answers.size > 0 || this.shortAnswers.size > 0)) {
          const confirmed = await confirmDialog({
            title: '退出答题？',
            message: '本站不保存答题记录，退出后本次进度会丢失。',
            confirmText: '退出',
            cancelText: '继续答题',
            danger: true,
          });
          if (!confirmed) return;
        }
        go('/');
        break;
      }
      default:
        break;
    }
  }

  private readonly onInputBound = (event: Event): void => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    const action = target.dataset.act;

    if (action === 'fill-input') {
      const question = this.current;
      if (!question || question.type !== 'fill') return;
      if (target.value.trim()) this.answers.set(question.id, target.value);
      else this.answers.delete(question.id);
      this.paintSheet();
      return;
    }

    if (action !== 'short-input') return;
    const question = this.current;
    if (!question || question.type !== 'short') return;
    if (target.value.trim()) this.shortAnswers.set(question.id, target.value);
    else this.shortAnswers.delete(question.id);
    this.paintSheet();
  };

  private readonly onKeyDownBound = (event: KeyboardEvent): void => {
    if (this.submitted) return;
    if (document.body.classList.contains('has-modal')) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    const targetEl = event.target as HTMLElement | null;

    if (targetEl?.dataset.act === 'fill-input' && event.key === 'Enter') {
      event.preventDefault();
      if (this.index >= this.questions.length - 1) void this.submit();
      else this.go(1);
      return;
    }

    const tag = targetEl?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (event.key === 'Escape') {
      this.closeSheet();
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      this.go(-1);
      return;
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      if (this.index >= this.questions.length - 1) void this.submit();
      else this.go(1);
      return;
    }
    if (event.key === 'Enter') {
      if ((document.activeElement as HTMLElement | null)?.tagName === 'BUTTON') return;
      event.preventDefault();
      if (this.index >= this.questions.length - 1) void this.submit();
      else this.go(1);
      return;
    }

    const upper = event.key.toUpperCase();
    const letterIndex = 'ABCDEF'.indexOf(upper);
    const numberIndex = /^[1-6]$/.test(event.key) ? Number(event.key) - 1 : -1;
    const optionIndex = numberIndex >= 0 ? numberIndex : letterIndex;
    if (optionIndex < 0) return;
    const option = this.current?.options[optionIndex];
    if (!option) return;
    event.preventDefault();
    this.select(option.key);
  };

  private readonly onBeforeUnloadBound = (event: BeforeUnloadEvent): void => {
    if (this.submitted || (this.answers.size === 0 && this.shortAnswers.size === 0)) return;
    event.preventDefault();
    event.returnValue = '';
  };
}
