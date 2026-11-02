import { APP, BANK_COLORS, BANK_EMOJIS } from '../config';
import type { Bank, BankSummary, Question, QuestionType } from '../types';
import { isAdmin, logout } from '../services/auth';
import {
  bankFilePayload,
  countByType,
  getLocalBank,
  listBankSummaries,
  loadBankById,
  nowISO,
  saveLocalBank,
} from '../services/bankRepo';
import { siteHeader } from '../ui/layout';
import { uid } from '../utils/crypto';
import { answerKeys, TYPE_LABELS } from '../utils/question';
import { confirmDialog, downloadText, esc, icon, qs, qsa, toast } from '../utils/dom';
import { go } from '../utils/nav';
import {
  clearQuestionFlags,
  convertType,
  questionEditor,
  reindexAfterRemoval,
  updateAnswerLabel,
} from './admin';

interface EditorMeta {
  id: string;
  title: string;
  category: string;
  description: string;
  emoji: string;
  color: string;
  source: string;
  createdAt: string;
}

interface EditorState {
  meta: EditorMeta;
  questions: Question[];
  remote: boolean;
  dirty: boolean;
}

const ADD_TYPES: QuestionType[] = ['single', 'multiple', 'judge', 'fill', 'short'];

function newMeta(): EditorMeta {
  return {
    id: uid('bank-'),
    title: '',
    category: '',
    description: '',
    emoji: '📘',
    color: 'blue',
    source: '手动创建',
    createdAt: nowISO(),
  };
}

function defaultQuestion(type: QuestionType): Question {
  const options =
    type === 'judge'
      ? [
          { key: 'A', text: '正确' },
          { key: 'B', text: '错误' },
        ]
      : type === 'single' || type === 'multiple'
        ? ['A', 'B', 'C', 'D'].map((key) => ({ key, text: '' }))
        : [];
  return {
    id: uid('q-'),
    type,
    stem: '',
    options,
    answer: type === 'judge' ? 'A' : '',
    analysis: '',
    knowledge: '',
    scored: type !== 'short',
    confidence: 'high',
  };
}

function normalizeLoadedQuestion(question: Question): Question {
  return {
    ...question,
    options: question.options.map((option) => ({ ...option })),
    scored: question.type === 'short' ? false : question.scored !== false,
  };
}

export async function renderEditor(
  root: HTMLElement,
  ctx: { params: Record<string, string> },
): Promise<void | (() => void)> {
  if (!isAdmin()) {
    location.replace(`#/login?next=${encodeURIComponent(`/editor${ctx.params.id ? `/${ctx.params.id}` : ''}`)}`);
    return;
  }

  let id = ctx.params.id ?? '';
  try {
    id = decodeURIComponent(id);
  } catch {
    /* 保持原样 */
  }

  const bank = id ? await loadBankById(id) : null;
  if (id && !bank) {
    document.title = `题库不存在 · ${APP.name}`;
    root.innerHTML = `
      <div class="page simple-page">
        <div class="simple-card">
          <span class="simple-mark is-error">${icon('alert', 28)}</span>
          <h1>题库不存在</h1>
          <p>这套题库可能已经被删除，或者链接不完整。</p>
          <a class="btn btn-primary" href="#/editor">${icon('plus', 18)} 新建题库</a>
        </div>
      </div>`;
    return;
  }

  const local = id ? getLocalBank(id) : null;
  const state: EditorState = {
    meta: bank
      ? {
          id: bank.id,
          title: bank.title,
          category: bank.category ?? '',
          description: bank.description ?? '',
          emoji: bank.emoji ?? '📘',
          color: bank.color ?? 'blue',
          source: bank.source ?? '',
          createdAt: bank.createdAt,
        }
      : newMeta(),
    questions: bank ? bank.questions.map(normalizeLoadedQuestion) : [],
    remote: Boolean(bank && !local),
    dirty: false,
  };

  document.title = `题目编辑器 · ${APP.name}`;
  root.innerHTML = editorShell(state);
  qs<HTMLElement>('#editor-title', root)?.focus();

  const questionList = qs<HTMLElement>('#editor-questions', root)!;
  const bankSelect = qs<HTMLSelectElement>('#editor-bank-select', root)!;

  const syncFields = (): void => {
    qs<HTMLInputElement>('#editor-title', root)!.value = state.meta.title;
    qs<HTMLInputElement>('#editor-category', root)!.value = state.meta.category;
    qs<HTMLInputElement>('#editor-source', root)!.value = state.meta.source;
    qs<HTMLTextAreaElement>('#editor-desc', root)!.value = state.meta.description;
    qs<HTMLSelectElement>('#editor-emoji', root)!.value = state.meta.emoji;
    qs<HTMLSelectElement>('#editor-color', root)!.value = state.meta.color;
    const remoteNote = qs<HTMLElement>('#editor-remote-note', root);
    if (remoteNote) remoteNote.hidden = !state.remote;
  };

  const renderQuestions = (): void => {
    questionList.innerHTML =
      state.questions.map((question, index) => questionEditor(question, index)).join('') ||
      '<p class="empty-hint">还没有题目。点上方按钮添加第一道题。</p>';
    refreshIssues();
  };

  const refreshIssues = (): void => {
    const issues = collectIssues(state);
    const box = qs<HTMLElement>('#editor-issues', root);
    if (!box) return;
    box.hidden = issues.length === 0;
    box.textContent = issues.length
      ? `还有 ${issues.length} 项待完善：${issues.slice(0, 3).join('；')}${issues.length > 3 ? '…' : ''}`
      : '';
  };

  const renderBankSelect = async (): Promise<void> => {
    let banks: BankSummary[] = [];
    try {
      ({ banks } = await listBankSummaries());
    } catch {
      /* 离线时仍可编辑当前题库 */
    }
    if (!banks.some((item) => item.id === state.meta.id)) {
      banks = [
        {
          id: state.meta.id,
          title: state.meta.title || '当前题库',
          file: `${state.meta.id}.json`,
          questionCount: state.questions.length,
          singleCount: 0,
          judgeCount: 0,
          createdAt: state.meta.createdAt,
          updatedAt: nowISO(),
          local: !state.remote,
          remote: state.remote,
        },
        ...banks,
      ];
    }
    bankSelect.innerHTML = [
      '<option value="">＋ 新建题库</option>',
      ...banks.map(
        (item) =>
          `<option value="${esc(item.id)}">${esc(item.title || '未命名题库')}${
            item.local ? '（本机）' : item.remote ? '（线上）' : ''
          } · ${item.questionCount} 题</option>`,
      ),
    ].join('');
    bankSelect.value = state.meta.id;
  };

  const buildBank = (): Bank => {
    const questions: Question[] = state.questions.map((question, index) => {
      const isText = question.type === 'short' || question.type === 'fill';
      const options = isText
        ? []
        : question.options.map((option, optionIndex) => ({
            key: String.fromCharCode(65 + optionIndex),
            text: option.text.trim(),
          }));
      let answer = '';
      if (isText) {
        answer = question.answer.trim();
      } else {
        const indexes = answerKeys(question)
          .map((key) => question.options.findIndex((option) => option.key === key))
          .filter((optionIndex) => optionIndex >= 0);
        answer = indexes.map((optionIndex) => String.fromCharCode(65 + optionIndex)).join(',');
      }
      return {
        id: `q${index + 1}`,
        type: question.type,
        stem: question.stem.trim(),
        options,
        answer,
        analysis: (question.analysis ?? '').trim(),
        knowledge: (question.knowledge ?? '').trim(),
        scored: question.type === 'short' ? false : question.scored !== false,
        confidence: question.confidence ?? 'high',
      };
    });
    const counts = countByType(questions);
    return {
      id: state.meta.id,
      title: state.meta.title.trim() || '未命名题库',
      description: state.meta.description.trim(),
      category: state.meta.category.trim(),
      emoji: state.meta.emoji,
      color: state.meta.color,
      source: state.meta.source.trim() || '手动创建',
      file: `${state.meta.id}.json`,
      createdAt: state.meta.createdAt,
      updatedAt: nowISO(),
      questions,
      ...counts,
    };
  };

  const saveLocal = (): void => {
    const bankData = buildBank();
    if (!saveLocalBank(bankData)) {
      toast('保存失败：浏览器存储空间不足或被禁用', 'error');
      return;
    }
    state.dirty = false;
    state.meta.title = bankData.title;
    state.meta.source = bankData.source ?? '';
    syncFields();
    history.replaceState(null, '', `#/editor/${encodeURIComponent(state.meta.id)}`);
    void renderBankSelect();
    toast('已保存到本地草稿；下载 JSON 后用 add-bank + git push 上线', 'success', 4200);
  };

  const download = (): void => {
    const issues = collectIssues(state);
    if (issues.length) {
      refreshIssues();
      toast(issues[0], 'error', 4200);
      return;
    }
    const bankData = buildBank();
    downloadText(`${bankData.id}.json`, bankFilePayload(bankData));
    toast('已下载题库 JSON；再运行 npm run add-bank -- "文件路径"', 'success', 4600);
  };

  const addQuestion = (type: QuestionType): void => {
    state.questions.push(defaultQuestion(type));
    state.dirty = true;
    renderQuestions();
    const cards = qsa<HTMLElement>('.q-edit', questionList);
    cards[cards.length - 1]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const input = cards[cards.length - 1]?.querySelector<HTMLTextAreaElement>('[data-field="stem"]');
    input?.focus();
  };

  const onClick = (event: Event): void => {
    const target = event.target as HTMLElement;
    const actionEl = target.closest<HTMLElement>('[data-act]');
    if (!actionEl) return;
    const action = actionEl.dataset.act;
    const qi = Number(actionEl.dataset.qi);
    const question = state.questions[qi];

    if (action === 'add-question') {
      addQuestion((actionEl.dataset.type as QuestionType) || 'single');
      return;
    }
    if (action === 'save-editor') {
      saveLocal();
      return;
    }
    if (action === 'download-editor') {
      download();
      return;
    }
    if (action === 'logout') {
      const doLogout = (): void => {
        logout();
        toast('已退出管理员登录', 'success');
        go('/');
      };
      if (state.dirty) {
        void confirmDialog({
          title: '退出并放弃修改？',
          message: '当前题库有未保存的修改，退出后会丢失。',
          confirmText: '退出',
          cancelText: '继续编辑',
          danger: true,
        }).then((confirmed) => {
          if (!confirmed) return;
          state.dirty = false;
          doLogout();
        });
        return;
      }
      doLogout();
      return;
    }
    if (!question) return;
    if (action === 'add-option') {
      if (question.options.length >= 6) return;
      question.options.push({ key: String.fromCharCode(65 + question.options.length), text: '' });
      state.dirty = true;
      renderQuestions();
      return;
    }
    if (action === 'del-option') {
      if (question.options.length <= 2) return;
      const optionIndex = Number(actionEl.dataset.oi);
      reindexAfterRemoval(question, optionIndex);
      state.dirty = true;
      renderQuestions();
      return;
    }
    if (action === 'del-question') {
      void confirmDialog({
        title: '删除这道题？',
        message: '只影响当前编辑中的题库，保存后才会写入草稿。',
        confirmText: '删除',
        danger: true,
      }).then((confirmed) => {
        if (!confirmed) return;
        state.questions.splice(qi, 1);
        state.dirty = true;
        renderQuestions();
      });
    }
  };

  const onInput = (event: Event): void => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    const idName = target.id;
    if (idName === 'editor-title') {
      state.meta.title = target.value;
      state.dirty = true;
      return;
    }
    if (idName === 'editor-category') {
      state.meta.category = target.value;
      state.dirty = true;
      return;
    }
    if (idName === 'editor-source') {
      state.meta.source = target.value;
      state.dirty = true;
      return;
    }
    if (idName === 'editor-desc') {
      state.meta.description = target.value;
      state.dirty = true;
      return;
    }

    const qi = Number(target.dataset.qi);
    const question = state.questions[qi];
    if (!question) return;
    const field = target.dataset.field;
    if (field === 'stem') question.stem = target.value;
    else if (field === 'analysis') question.analysis = target.value;
    else if (field === 'knowledge') question.knowledge = target.value;
    else if (field === 'option') {
      const optionIndex = Number(target.dataset.oi);
      if (question.options[optionIndex]) question.options[optionIndex].text = target.value;
    } else if (field === 'reference' || field === 'fill-answer') {
      question.answer = target.value;
      if (target.value.trim()) {
        question.confidence = 'high';
        clearQuestionFlags(target);
      }
      updateAnswerLabel(root, question, qi);
    } else {
      return;
    }
    state.dirty = true;
    refreshIssues();
  };

  const onChange = async (event: Event): Promise<void> => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    if (target instanceof HTMLSelectElement && target.id === 'editor-bank-select') {
      const nextId = target.value;
      if (state.dirty) {
        const confirmed = await confirmDialog({
          title: '切换题库？',
          message: '当前题库有未保存的修改，切换后会丢失。',
          confirmText: '切换',
          cancelText: '继续编辑',
          danger: true,
        });
        if (!confirmed) {
          target.value = state.meta.id;
          return;
        }
        state.dirty = false;
      }
      go(nextId ? `/editor/${encodeURIComponent(nextId)}` : '/editor');
      return;
    }
    if (target instanceof HTMLSelectElement && target.id === 'editor-emoji') {
      state.meta.emoji = target.value;
      state.dirty = true;
      return;
    }
    if (target instanceof HTMLSelectElement && target.id === 'editor-color') {
      state.meta.color = target.value;
      state.dirty = true;
      return;
    }

    const qi = Number(target.dataset.qi);
    const question = state.questions[qi];
    if (!question) return;

    if (target instanceof HTMLInputElement && target.dataset.field === 'scored') {
      question.scored = question.type === 'short' ? false : target.checked;
      state.dirty = true;
      return;
    }

    if (target.dataset.field === 'type' && target instanceof HTMLSelectElement) {
      const nextType = target.value;
      if (
        nextType === 'single' ||
        nextType === 'multiple' ||
        nextType === 'judge' ||
        nextType === 'fill' ||
        nextType === 'short'
      ) {
        convertType(question, nextType);
        state.dirty = true;
        renderQuestions();
      }
      return;
    }

    if (target instanceof HTMLInputElement && target.type === 'radio' && target.name.startsWith('ans-')) {
      question.answer = target.value;
      question.confidence = 'high';
      updateAnswerLabel(root, question, qi);
      clearQuestionFlags(target);
      state.dirty = true;
      return;
    }

    if (
      target instanceof HTMLInputElement &&
      target.type === 'checkbox' &&
      target.name.startsWith('ans-')
    ) {
      const card = target.closest('.q-edit');
      const keys = card
        ? Array.from(
            card.querySelectorAll<HTMLInputElement>(
              'input[type="checkbox"][name^="ans-"]:checked',
            ),
          ).map((input) => input.value)
        : [];
      question.answer = Array.from(new Set(keys)).sort().join(',');
      question.confidence = 'high';
      updateAnswerLabel(root, question, qi);
      clearQuestionFlags(target);
      state.dirty = true;
    }
  };

  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  };

  const onLinkClick = (event: MouseEvent): void => {
    if (!state.dirty) return;
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest<HTMLAnchorElement>('a[href^="#/"]');
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    void confirmDialog({
      title: '离开编辑器？',
      message: '当前题库有未保存的修改，离开后会丢失。',
      confirmText: '离开',
      cancelText: '继续编辑',
      danger: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      state.dirty = false;
      go(anchor.getAttribute('href')!.slice(1));
    });
  };

  root.addEventListener('click', onClick);
  root.addEventListener('click', onLinkClick, true);
  root.addEventListener('input', onInput);
  root.addEventListener('change', onChange);
  window.addEventListener('beforeunload', onBeforeUnload);

  syncFields();
  renderQuestions();
  void renderBankSelect();

  return () => {
    root.removeEventListener('click', onClick);
    root.removeEventListener('click', onLinkClick, true);
    root.removeEventListener('input', onInput);
    root.removeEventListener('change', onChange);
    window.removeEventListener('beforeunload', onBeforeUnload);
  };
}

function editorShell(state: EditorState): string {
  const emojis = BANK_EMOJIS.includes(state.meta.emoji)
    ? BANK_EMOJIS
    : [state.meta.emoji, ...BANK_EMOJIS];
  const colors = BANK_COLORS.includes(state.meta.color as (typeof BANK_COLORS)[number])
    ? BANK_COLORS
    : ([state.meta.color, ...BANK_COLORS] as string[]);

  return `
    <div class="page admin-page editor-page">
      ${siteHeader()}
      <main class="container admin-main">
        <div class="editor-head">
          <div>
            <a class="editor-back" href="#/admin">${icon('arrow-left', 16)} 返回管理后台</a>
            <h1>题目编辑器</h1>
            <p>手动创建或编辑题库；保存为本地草稿后，下载 JSON 并用 <code>npm run add-bank</code> + <code>git push</code> 上线。</p>
          </div>
          <button type="button" class="btn btn-primary" data-act="save-editor">${icon('check', 17)} 保存本地草稿</button>
        </div>

        <section class="panel">
          <div class="panel-head">
            <span class="step-badge is-alt">${icon('layers', 16)}</span>
            <div class="panel-title">
              <h2>题库信息</h2>
              <p>选择已有题库继续编辑，或新建一套</p>
            </div>
          </div>
          <label class="field">
            <span class="field-label">当前题库</span>
            <select id="editor-bank-select" class="select"><option value="">＋ 新建题库</option></select>
          </label>
          <p class="editor-remote-note" id="editor-remote-note" hidden>
            ${icon('info', 15)} 这是线上题库的编辑副本。保存会生成本机草稿；下载 JSON 后运行 <code>npm run add-bank</code> 覆盖线上文件，再 push 才会更新线上。
          </p>
          <div class="editor-bank-grid">
            <label class="field">
              <span class="field-label">题库标题</span>
              <input id="editor-title" class="input" placeholder="例如：物联网架构与技术考试题" />
            </label>
            <label class="field">
              <span class="field-label">分类</span>
              <input id="editor-category" class="input" placeholder="例如：物联网" />
            </label>
            <label class="field">
              <span class="field-label">来源</span>
              <input id="editor-source" class="input" placeholder="例如：手动整理" />
            </label>
            <label class="field">
              <span class="field-label">图标</span>
              <select id="editor-emoji" class="select">
                ${emojis.map((emoji) => `<option value="${esc(emoji)}"${emoji === state.meta.emoji ? ' selected' : ''}>${esc(emoji)}</option>`).join('')}
              </select>
            </label>
            <label class="field">
              <span class="field-label">配色</span>
              <select id="editor-color" class="select">
                ${colors.map((color) => `<option value="${esc(color)}"${color === state.meta.color ? ' selected' : ''}>${esc(color)}</option>`).join('')}
              </select>
            </label>
            <label class="field field-wide">
              <span class="field-label">简介</span>
              <textarea id="editor-desc" class="textarea" rows="2" maxlength="120" placeholder="一句话介绍这道题库"></textarea>
            </label>
          </div>
          <p class="editor-id">题库 id：<code>${esc(state.meta.id)}</code></p>
        </section>

        <section class="panel">
          <div class="panel-head">
            <span class="step-badge is-alt">${icon('file', 16)}</span>
            <div class="panel-title">
              <h2>题目</h2>
              <p>可以添加单选、多选、判断、填空、简答；每题都能单独设置是否计分</p>
            </div>
          </div>
          <div class="editor-addbar">
            ${ADD_TYPES.map(
              (type) =>
                `<button type="button" class="btn btn-outline btn-sm" data-act="add-question" data-type="${type}">${icon('plus', 14)} ${TYPE_LABELS[type]}</button>`,
            ).join('')}
          </div>
          <p class="editor-issues" id="editor-issues" hidden></p>
          <div id="editor-questions" class="q-edit-list"></div>
        </section>

        <div class="editor-savebar">
          <div class="save-actions">
            <button type="button" class="btn btn-primary" data-act="save-editor">${icon('check', 17)} 保存本地草稿</button>
            <button type="button" class="btn btn-outline" data-act="download-editor">${icon('download', 17)} 下载题库 JSON</button>
            <a class="btn btn-ghost" href="#/admin">${icon('arrow-left', 16)} 返回管理后台</a>
          </div>
          <span class="status-text" id="editor-status"></span>
        </div>
      </main>
    </div>`;
}

function collectIssues(state: EditorState): string[] {
  const issues: string[] = [];
  if (!state.questions.length) issues.push('还没有添加题目');
  if (!state.meta.title.trim()) issues.push('请填写题库标题');

  const objective = state.questions.filter((question) => question.type !== 'short');
  const missingAnswer = objective.filter((question) =>
    question.type === 'fill' ? !question.answer.trim() : answerKeys(question).length === 0,
  ).length;
  if (missingAnswer) issues.push(`${missingAnswer} 道题还没有设置正确答案`);

  const emptyStem = state.questions.filter((question) => !question.stem.trim()).length;
  if (emptyStem) issues.push(`${emptyStem} 道题的题干为空`);

  const emptyOption = objective.filter((question) =>
    question.options.some((option) => !option.text.trim()),
  ).length;
  if (emptyOption) issues.push(`${emptyOption} 道题存在空选项`);

  return issues;
}

