import {
  AI_PRESETS,
  APP,
  BANK_COLORS,
  BANK_EMOJIS,
  PAGE_SIZE_LIMITS,
} from '../config';
import type { AIConfig, Bank, BankSummary, Question, QuestionType } from '../types';
import { AIError, parseQuestionsWithAI, testAIConfig, validateAIConfig } from '../services/ai';
import { isAdmin, logout } from '../services/auth';
import {
  bankFilePayload,
  countByType,
  getLocalBank,
  listBankSummaries,
  loadBankById,
  nowISO,
  removeLocalBank,
  saveLocalBank,
} from '../services/bankRepo';
import { PdfError, extractPdfText } from '../services/pdf';
import { loadAIConfig, saveAIConfig } from '../services/settings';
import { siteHeader } from '../ui/layout';
import { uid } from '../utils/crypto';
import { confirmDialog, copyText, downloadText, esc, icon, qs, qsa, toast } from '../utils/dom';
import {
  clamp,
  formatDate,
  formatDateTime,
  formatFileSize,
  formatNumber,
} from '../utils/format';
import { go } from '../utils/nav';
import { answerKeys, answerSummary, splitAnswerKeys, TYPE_LABELS } from '../utils/question';

interface AdminMeta {
  id: string;
  title: string;
  category: string;
  description: string;
  emoji: string;
  color: string;
  source: string;
  createdAt: string;
}

interface AdminState {
  mode: 'pdf' | 'text';
  file: File | null;
  pdfInfo: { pageCount: number; charCount: number; lowText: boolean } | null;
  questions: Question[];
  reviewFilter: 'all' | 'single' | 'multiple' | 'judge' | 'fill' | 'short' | 'low';
  meta: AdminMeta;
  sourceFile: string;
  parsing: boolean;
  abort: AbortController | null;
  dirty: boolean;
  aiConfig: AIConfig;
}

const AI_HINTS: Record<string, string> = {
  cors: '浏览器可能被目标接口的跨域策略拦截。可以改用支持跨域的接口（OpenRouter / Gemini），或按 README 部署代理。',
  auth: '请检查 API Key 是否正确、账户是否还有额度。',
  rate: '请求过于频繁或额度不足，请稍后再试。',
  format: '模型输出不是合法 JSON，可以再试一次，或换一个更强的模型。',
  network: '请检查网络连接后重试。',
  timeout: 'AI 接口长时间没有返回。请先点「测试连接」确认接口可用；也可以换一个更快的模型，或减少 PDF 页数。',
  model: '请检查 Base URL 与模型名称是否匹配。',
};

export function renderAdmin(root: HTMLElement): () => void {
  if (!isAdmin()) {
    location.replace('#/login?next=%2Fadmin');
    return () => undefined;
  }

  const state: AdminState = {
    mode: 'pdf',
    file: null,
    pdfInfo: null,
    questions: [],
    reviewFilter: 'all',
    meta: {
      id: uid('bank-'),
      title: '',
      category: '',
      description: '',
      emoji: '📘',
      color: 'blue',
      source: '',
      createdAt: nowISO(),
    },
    sourceFile: '',
    parsing: false,
    abort: null,
    dirty: false,
    aiConfig: loadAIConfig(),
  };

  document.title = `管理后台 · ${APP.name}`;
  root.innerHTML = adminShell();

  let statsTimer: number | null = null;
  const scheduleStats = (): void => {
    if (statsTimer !== null) window.clearTimeout(statsTimer);
    statsTimer = window.setTimeout(() => {
      refreshStats(root, state);
      statsTimer = null;
    }, 220);
  };

  /* ------------------------------------------------------------ 渲染 */

  const renderPickers = (): void => {
    qs<HTMLElement>('#emoji-picker', root)!.innerHTML = BANK_EMOJIS.map(
      (emoji) =>
        `<button type="button" class="emoji-btn${state.meta.emoji === emoji ? ' is-active' : ''}" data-act="pick-emoji" data-emoji="${esc(emoji)}" aria-label="选择图标 ${esc(emoji)}">${esc(emoji)}</button>`,
    ).join('');

    qs<HTMLElement>('#color-picker', root)!.innerHTML = BANK_COLORS.map(
      (color) =>
        `<button type="button" class="color-btn color-${color}${state.meta.color === color ? ' is-active' : ''}" data-act="pick-color" data-color="${color}" aria-label="选择配色 ${color}"><i></i></button>`,
    ).join('');
  };

  const syncBankForm = (): void => {
    qs<HTMLInputElement>('#bank-title', root)!.value = state.meta.title;
    qs<HTMLInputElement>('#bank-category', root)!.value = state.meta.category;
    qs<HTMLInputElement>('#bank-source', root)!.value = state.meta.source;
    qs<HTMLTextAreaElement>('#bank-desc', root)!.value = state.meta.description;
    renderPickers();
    renderPreview(root, state);
  };

  const renderReview = (): void => {
    const list = qs<HTMLElement>('#review-edit-list', root)!;
    const entries = state.questions
      .map((question, index) => ({ question, index }))
      .filter(({ question }) => {
        if (state.reviewFilter === 'all') return true;
        if (state.reviewFilter === 'single') return question.type === 'single';
        if (state.reviewFilter === 'multiple') return question.type === 'multiple';
        if (state.reviewFilter === 'judge') return question.type === 'judge';
        if (state.reviewFilter === 'fill') return question.type === 'fill';
        if (state.reviewFilter === 'short') return question.type === 'short';
        return question.confidence === 'low' || !question.answer;
      });

    list.innerHTML =
      entries.map(({ question, index }) => questionEditor(question, index)).join('') ||
      '<p class="empty-hint">当前筛选下没有题目。</p>';
    refreshStats(root, state);
  };

  const showPanels = (): void => {
    qs<HTMLElement>('#review-panel', root)!.hidden = false;
    qs<HTMLElement>('#bank-panel', root)!.hidden = false;
    setStep(3);
  };

  const setStep = (step: number): void => {
    qsa<HTMLElement>('.admin-step', root).forEach((element) => {
      const value = Number(element.dataset.step);
      element.classList.toggle('is-active', value <= step);
      element.classList.toggle('is-current', value === step);
    });
  };

  const setStatus = (selector: string, message: string, tone: 'ok' | 'error' | 'idle'): void => {
    const element = qs<HTMLElement>(selector, root);
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
  };

  const setMode = (mode: 'pdf' | 'text'): void => {
    state.mode = mode;
    qsa<HTMLElement>('[data-act="mode"]', root).forEach((button) => {
      button.classList.toggle('is-active', button.dataset.mode === mode);
    });
    qsa<HTMLElement>('[data-mode-body]', root).forEach((body) => {
      body.hidden = body.dataset.modeBody !== mode;
    });
    updateParseHint(root, state);
  };

  const renderFileChip = (): void => {
    const chip = qs<HTMLElement>('#file-chip', root)!;
    if (!state.file) {
      chip.hidden = true;
      chip.innerHTML = '';
      return;
    }
    chip.hidden = false;
    chip.innerHTML = `
      <span class="file-icon">${icon('file', 18)}</span>
      <span class="file-main">
        <b>${esc(state.file.name)}</b>
        <span>${formatFileSize(state.file.size)}</span>
      </span>
      <button type="button" class="icon-btn icon-btn-sm" data-act="remove-file" aria-label="移除文件">${icon('x', 16)}</button>`;
  };

  const acceptFile = (file: File): void => {
    if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
      toast('请选择 PDF 文件', 'error');
      return;
    }
    if (file.size > 30 * 1024 * 1024) {
      toast('文件超过 30 MB，请拆分后再上传', 'error');
      return;
    }
    state.file = file;
    state.sourceFile = file.name;
    state.pdfInfo = null;
    if (!state.meta.title.trim()) state.meta.title = guessTitle(file.name);
    if (!state.meta.source.trim()) state.meta.source = file.name;
    syncBankForm();
    renderFileChip();
    updateParseHint(root, state);
  };

  /* ------------------------------------------------------------ 解析 */

  const startParse = async (): Promise<void> => {
    if (state.parsing) return;

    if (state.questions.length) {
      const overwrite = await confirmDialog({
        title: '重新解析？',
        message: '当前已解析 / 校对的题目会被新的解析结果覆盖，建议先保存为本地草稿。',
        confirmText: '重新解析',
        cancelText: '取消',
        danger: true,
      });
      if (!overwrite) return;
    }

    const configError = validateAIConfig(state.aiConfig);
    if (configError) {
      toast(configError, 'error');
      qs<HTMLElement>('#ai-panel', root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    const controller = new AbortController();
    state.abort = controller;
    state.parsing = true;
    updateParseButton(root, state, true);
    setStep(1);

    let aiElapsedTimer: number | null = null;
    let aiStartedAt = 0;
    const stopElapsedTimer = (): void => {
      if (aiElapsedTimer !== null) {
        window.clearInterval(aiElapsedTimer);
        aiElapsedTimer = null;
      }
    };

    try {
      let text = '';
      let sourceName = '';

      if (state.mode === 'pdf') {
        if (!state.file) {
          toast('请先选择一个 PDF 文件', 'error');
          return;
        }
        sourceName = state.file.name;
        showStatus(root, {
          title: '正在提取 PDF 文字',
          detail: '准备解析文件…',
          progress: 2,
          tone: 'running',
          cancel: true,
        });
        const result = await extractPdfText(state.file, {
          signal: controller.signal,
          onProgress: ({ page, total }) => {
            showStatus(root, {
              title: '正在提取 PDF 文字',
              detail: `第 ${page} / ${total} 页`,
              progress: 2 + (page / total) * 48,
              tone: 'running',
              cancel: true,
            });
          },
        });
        text = result.text;
        state.pdfInfo = {
          pageCount: result.pageCount,
          charCount: result.charCount,
          lowText: result.lowText,
        };
        if (result.charCount < 20) {
          throw new Error('没有从 PDF 中提取到文字。它可能是扫描件，请先 OCR，或改用「粘贴文本」模式。');
        }
        if (result.lowText) {
          toast('提取到的文字较少，可能是扫描件，解析结果可能不完整', 'info', 5000);
        }
        showStatus(root, {
          title: 'PDF 文字提取完成',
          detail: `${result.pageCount} 页 · ${formatNumber(result.charCount)} 字符`,
          progress: 50,
          tone: 'running',
          cancel: true,
        });
      } else {
        text = qs<HTMLTextAreaElement>('#paste-text', root)!.value.trim();
        if (text.length < 30) {
          throw new Error('粘贴的文本太短，至少需要 30 个字符。');
        }
        sourceName = '粘贴文本';
      }

      if (text.length > PAGE_SIZE_LIMITS.maxTextChars) {
        text = text.slice(0, PAGE_SIZE_LIMITS.maxTextChars);
        toast('文本过长，已截断到 40 万字符', 'info');
      }

      state.sourceFile = sourceName;
      aiStartedAt = Date.now();
      stopElapsedTimer();
      aiElapsedTimer = window.setInterval(() => {
        if (!state.parsing) return;
        const detail = qs<HTMLElement>('#status-detail', root);
        if (!detail) return;
        const base = (detail.textContent ?? '').replace(/（已等待 \d+ 秒）$/, '');
        detail.textContent = `${base}（已等待 ${Math.floor((Date.now() - aiStartedAt) / 1000)} 秒）`;
      }, 1000);
      showStatus(root, {
        title: 'AI 正在解析题目',
        detail: '正在等待第一段结果…（超过 120 秒会自动中止）',
        progress: 52,
        tone: 'running',
        cancel: true,
      });

      const result = await parseQuestionsWithAI(text, state.aiConfig, {
        signal: controller.signal,
        onProgress: (progress) => {
          showStatus(root, {
            title: 'AI 正在解析题目',
            detail: `第 ${progress.chunkIndex} / ${progress.chunkTotal} 段 · 已识别 ${progress.found} 题 · 等待模型返回`,
            progress: 52 + (progress.chunkIndex / progress.chunkTotal) * 45,
            tone: 'running',
            cancel: true,
          });
        },
      });
      stopElapsedTimer();

      if (!result.questions.length) {
        throw new Error('AI 没有识别到单选题、多选题、判断题、填空题或简答题。请检查文本内容，或更换模型后重试。');
      }

      state.questions = result.questions;
      state.dirty = true;
      if (!state.meta.title.trim()) state.meta.title = guessTitle(sourceName);
      if (!state.meta.source.trim()) state.meta.source = sourceName;
      state.meta.createdAt = nowISO();

      const counts = countByType(result.questions);
      showStatus(root, {
        title: '解析完成',
        detail: `共 ${result.questions.length} 题 · 单选 ${counts.singleCount} · 多选 ${counts.multipleCount} · 判断 ${counts.judgeCount} · 填空 ${counts.fillCount} · 简答 ${counts.shortCount}${
          result.skipped ? ` · 跳过 ${result.skipped} 个非目标题` : ''
        }${result.duplicates ? ` · 去重 ${result.duplicates} 题` : ''}`,
        progress: 100,
        tone: 'success',
        cancel: false,
      });

      showPanels();
      syncBankForm();
      renderReview();
      renderPreview(root, state);
      toast(`解析完成，共识别 ${result.questions.length} 道题`, 'success');
      qs<HTMLElement>('#review-panel', root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      stopElapsedTimer();
      handleParseError(root, error);
    } finally {
      stopElapsedTimer();
      state.parsing = false;
      state.abort = null;
      updateParseButton(root, state, false);
    }
  };

  /* ------------------------------------------------------------ 保存 */

  const ensureValid = (): boolean => {
    const issues = collectIssues(state);
    if (!issues.length) return true;
    const warn = qs<HTMLElement>('#review-warn', root);
    if (warn) {
      warn.hidden = false;
      warn.textContent = `${issues[0]}${issues.length > 1 ? `（共 ${issues.length} 项待处理）` : ''}`;
      warn.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    toast(issues[0], 'error', 3600);
    return false;
  };

  const handleSaveLocal = (): void => {
    if (!ensureValid()) return;
    const bank = buildBank(state);
    if (!saveLocalBank(bank)) {
      toast('保存失败：浏览器存储空间不足或被禁用', 'error');
      return;
    }
    state.dirty = false;
    setStatus('#save-status', `已保存到本地草稿 · ${formatDateTime(nowISO())}`, 'ok');
    void renderLibrary(root, state);
    toast('已保存到本地草稿（仅当前浏览器可见）', 'success');
  };

  const handleDownloadBank = (): void => {
    if (!ensureValid()) return;
    const bank = buildBank(state);
    downloadText(`${bank.id}.json`, bankFilePayload(bank));
    toast('已下载题库 JSON，请用 npm run add-bank 写入项目后手动 push', 'info', 4600);
  };

  /* ------------------------------------------------------------ 事件 */

  const onClick = (event: Event): void => {
    void handleClick(event);
  };

  const handleClick = async (event: Event): Promise<void> => {
    const target = event.target as HTMLElement;
    const actionEl = target.closest<HTMLElement>('[data-act]');
    if (!actionEl) return;
    const action = actionEl.dataset.act;
    const qi = Number(actionEl.dataset.qi);

    switch (action) {
      case 'logout': {
        if (state.dirty && state.questions.length) {
          const confirmed = await confirmDialog({
            title: '退出登录？',
            message: '当前解析 / 校对结果还没有保存，退出后会丢失。',
            confirmText: '退出',
            cancelText: '继续编辑',
            danger: true,
          });
          if (!confirmed) return;
        }
        logout();
        toast('已退出管理员登录', 'success');
        go('/');
        return;
      }

      case 'mode':
        setMode(actionEl.dataset.mode === 'text' ? 'text' : 'pdf');
        return;

      case 'parse':
        await startParse();
        return;

      case 'cancel-parse':
        state.abort?.abort();
        showStatus(root, {
          title: '正在取消…',
          detail: '请稍候',
          progress: 0,
          tone: 'running',
          cancel: false,
        });
        return;

      case 'remove-file':
        state.file = null;
        state.pdfInfo = null;
        renderFileChip();
        updateParseHint(root, state);
        return;

      case 'toggle-key': {
        const input = qs<HTMLInputElement>('#ai-key', root);
        if (!input) return;
        const visible = input.type === 'password';
        input.type = visible ? 'text' : 'password';
        actionEl.innerHTML = icon(visible ? 'eye-off' : 'eye', 18);
        return;
      }

      case 'save-ai': {
        const config = readAIConfig(root);
        const error = validateAIConfig(config);
        if (error) {
          setStatus('#ai-status', error, 'error');
          return;
        }
        if (!saveAIConfig(config)) {
          setStatus('#ai-status', '保存失败，浏览器可能禁用了本地存储', 'error');
          return;
        }
        state.aiConfig = config;
        setStatus('#ai-status', '已保存到本机浏览器', 'ok');
        updateParseHint(root, state);
        toast('AI 设置已保存', 'success');
        return;
      }

      case 'test-ai': {
        const config = readAIConfig(root);
        const error = validateAIConfig(config);
        if (error) {
          setStatus('#ai-status', error, 'error');
          return;
        }
        const button = actionEl as HTMLButtonElement;
        button.disabled = true;
        setStatus('#ai-status', '测试中…', 'idle');
        const result = await testAIConfig(config);
        setStatus('#ai-status', result.message, result.ok ? 'ok' : 'error');
        button.disabled = false;
        return;
      }

      case 'clear-questions': {
        const confirmed = await confirmDialog({
          title: '清空全部题目？',
          message: '当前解析结果会被丢弃，此操作无法撤销。',
          confirmText: '清空',
          danger: true,
        });
        if (!confirmed) return;
        state.questions = [];
        state.dirty = false;
        qs<HTMLElement>('#review-panel', root)!.hidden = true;
        qs<HTMLElement>('#bank-panel', root)!.hidden = true;
        qs<HTMLElement>('#status-panel', root)!.hidden = true;
        setStep(1);
        toast('已清空', 'success');
        return;
      }

      case 'filter-review': {
        const allowed = ['single', 'multiple', 'judge', 'fill', 'short', 'low'] as const;
        state.reviewFilter = allowed.find((item) => item === actionEl.dataset.filter) ?? 'all';
        renderReview();
        return;
      }

      case 'add-option': {
        const question = state.questions[qi];
        if (!question || question.options.length >= 6) return;
        question.options.push({ key: String.fromCharCode(65 + question.options.length), text: '' });
        state.dirty = true;
        renderReview();
        return;
      }

      case 'del-option': {
        const question = state.questions[qi];
        const optionIndex = Number(actionEl.dataset.oi);
        if (!question || question.options.length <= 2) return;
        reindexAfterRemoval(question, optionIndex);
        state.dirty = true;
        renderReview();
        return;
      }

      case 'del-question': {
        if (!Number.isFinite(qi)) return;
        state.questions.splice(qi, 1);
        state.dirty = true;
        renderReview();
        toast('已删除该题', 'info');
        return;
      }

      case 'pick-emoji':
        state.meta.emoji = actionEl.dataset.emoji ?? '📘';
        renderPickers();
        renderPreview(root, state);
        return;

      case 'pick-color':
        state.meta.color = actionEl.dataset.color ?? 'blue';
        renderPickers();
        renderPreview(root, state);
        return;

      case 'save-local':
        handleSaveLocal();
        return;

      case 'download-bank':
        handleDownloadBank();
        return;

      case 'load-draft': {
        const bank = getLocalBank(actionEl.dataset.id ?? '');
        if (!bank) {
          toast('草稿不存在或已被删除', 'error');
          return;
        }
        state.questions = bank.questions.map((question) => ({
          ...question,
          options: question.options.map((option) => ({ ...option })),
        }));
        state.meta = {
          id: bank.id,
          title: bank.title,
          category: bank.category ?? '',
          description: bank.description ?? '',
          emoji: bank.emoji ?? '📘',
          color: bank.color ?? 'blue',
          source: bank.source ?? '',
          createdAt: bank.createdAt,
        };
        state.sourceFile = bank.meta?.sourceFile ?? bank.source ?? '';
        state.dirty = false;
        syncBankForm();
        renderReview();
        showPanels();
        qs<HTMLElement>('#review-panel', root)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('已载入本地草稿', 'success');
        return;
      }

      case 'download-library': {
        const bank = await loadBankById(actionEl.dataset.id ?? '');
        if (!bank) {
          toast('题库不存在，或线上题库加载失败', 'error');
          return;
        }
        downloadText(`${bank.id}.json`, bankFilePayload(bank));
        toast('已下载题库 JSON', 'success');
        return;
      }

      case 'delete-library': {
        const id = actionEl.dataset.id ?? '';
        const title = actionEl.dataset.title || id;
        const isLocal = actionEl.dataset.local === '1';
        const isRemote = actionEl.dataset.remote === '1';

        if (isLocal) {
          const confirmed = await confirmDialog({
            title: '删除本机草稿？',
            message: isRemote
              ? '只会删除当前浏览器里的草稿；线上版本仍然存在，需要再执行 remove-bank 命令删除。'
              : '只会删除当前浏览器里的副本，不影响仓库里的其他题库。',
            confirmText: '删除草稿',
            danger: true,
          });
          if (!confirmed) return;
          removeLocalBank(id);
          await renderLibrary(root, state);
          toast(isRemote ? '已删除本机草稿；线上版本请用 remove-bank 删除' : '已删除本地草稿', 'success');
          return;
        }

        if (!isRemote) return;
        const commitTitle = title.replace(/"/g, "'");
        const command = `npm run remove-bank -- ${id}\n\ngit add -A public/data/banks\ngit commit -m "remove bank: ${commitTitle}"\ngit push`;
        const confirmed = await confirmDialog({
          title: '删除线上题库？',
          message: `这是静态站点，网页不能直接删除仓库文件。点「复制命令」后，在项目根目录执行：\n\n${command}`,
          confirmText: '复制命令',
          cancelText: '关闭',
          danger: true,
        });
        if (!confirmed) return;
        const copied = await copyText(command);
        toast(
          copied ? '删除命令已复制，请到项目根目录执行' : '复制失败，请手动执行 remove-bank 命令',
          copied ? 'success' : 'error',
          4600,
        );
        return;
      }

      default:
        return;
    }
  };

  /* ---------------------------------------------------- 动态区域事件 */

  const reviewList = qs<HTMLElement>('#review-edit-list', root)!;

  reviewList.addEventListener('input', (event) => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    const qi = Number(target.dataset.qi);
    if (!Number.isFinite(qi)) return;
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
    }
    state.dirty = true;
    scheduleStats();
  });

  reviewList.addEventListener('change', (event) => {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const qi = Number(target.dataset.qi);
    if (!Number.isFinite(qi)) return;
    const question = state.questions[qi];
    if (!question) return;

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
        renderReview();
      }
      return;
    }

    if (target instanceof HTMLInputElement && target.type === 'radio' && target.name.startsWith('ans-')) {
      question.answer = target.value;
      question.confidence = 'high';
      updateAnswerLabel(root, question, qi);
      clearQuestionFlags(target);
      state.dirty = true;
      refreshStats(root, state);
      return;
    }

    if (target instanceof HTMLInputElement && target.type === 'checkbox' && target.name.startsWith('ans-')) {
      const card = target.closest('.q-edit');
      const keys = card
        ? Array.from(card.querySelectorAll<HTMLInputElement>('input[type="checkbox"][name^="ans-"]:checked')).map(
            (input) => input.value,
          )
        : [];
      question.answer = Array.from(new Set(keys)).sort().join(',');
      question.confidence = 'high';
      updateAnswerLabel(root, question, qi);
      clearQuestionFlags(target);
      state.dirty = true;
      refreshStats(root, state);
    }
  });

  /* -------------------------------------------------------- 静态表单 */

  const onBankInput = (event: Event): void => {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    switch (target.id) {
      case 'bank-title':
        state.meta.title = target.value;
        break;
      case 'bank-category':
        state.meta.category = target.value;
        break;
      case 'bank-desc':
        state.meta.description = target.value;
        break;
      case 'bank-source':
        state.meta.source = target.value;
        break;
      default:
        return;
    }
    state.dirty = true;
    renderPreview(root, state);
    scheduleStats();
  };
  root.addEventListener('input', onBankInput);

  const pasteArea = qs<HTMLTextAreaElement>('#paste-text', root)!;
  pasteArea.addEventListener('input', () => {
    qs<HTMLElement>('#paste-count', root)!.textContent = `${formatNumber(pasteArea.value.length)} 字`;
  });

  const dropzone = qs<HTMLElement>('#dropzone', root)!;
  const fileInput = qs<HTMLInputElement>('#pdf-input', root)!;
  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });
  ['dragenter', 'dragover'].forEach((name) => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.add('is-over');
    });
  });
  ['dragleave', 'drop'].forEach((name) => {
    dropzone.addEventListener(name, (event) => {
      event.preventDefault();
      dropzone.classList.remove('is-over');
    });
  });
  dropzone.addEventListener('drop', (event) => {
    const file = (event as DragEvent).dataTransfer?.files?.[0];
    if (file) acceptFile(file);
  });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) acceptFile(file);
    fileInput.value = '';
  });

  const presetSelect = qs<HTMLSelectElement>('#ai-preset', root)!;
  presetSelect.addEventListener('change', () => {
    const preset = AI_PRESETS.find((item) => item.id === presetSelect.value);
    if (!preset) return;
    if (preset.baseUrl) qs<HTMLInputElement>('#ai-base', root)!.value = preset.baseUrl;
    if (preset.model) qs<HTMLInputElement>('#ai-model', root)!.value = preset.model;
    qs<HTMLElement>('#ai-preset-note', root)!.textContent = preset.note;
  });

  /* ------------------------------------------------------------ 初始化 */

  (qs<HTMLInputElement>('#ai-base', root)!).value = state.aiConfig.baseUrl;
  (qs<HTMLInputElement>('#ai-model', root)!).value = state.aiConfig.model;
  (qs<HTMLInputElement>('#ai-key', root)!).value = state.aiConfig.apiKey;
  (qs<HTMLInputElement>('#ai-json', root)!).checked = state.aiConfig.jsonMode;

  const activePreset =
    AI_PRESETS.find((preset) => preset.baseUrl && preset.baseUrl === state.aiConfig.baseUrl)?.id ??
    'custom';
  presetSelect.value = activePreset;
  qs<HTMLElement>('#ai-preset-note', root)!.textContent =
    AI_PRESETS.find((preset) => preset.id === activePreset)?.note ?? '';

  renderPickers();
  renderPreview(root, state);
  void renderLibrary(root, state);
  updateParseHint(root, state);
  updateParseButton(root, state, false);
  refreshStats(root, state);

  root.addEventListener('click', onClick);

  const onHomeLinkClick = (event: MouseEvent): void => {
    if (!state.dirty || !state.questions.length) return;
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest<HTMLAnchorElement>('a[href="#/"]');
    if (!anchor) return;
    event.preventDefault();
    event.stopPropagation();
    void confirmDialog({
      title: '离开管理后台？',
      message: '当前解析 / 校对结果还没有保存，离开后会丢失。',
      confirmText: '离开',
      cancelText: '继续编辑',
      danger: true,
    }).then((confirmed) => {
      if (!confirmed) return;
      state.dirty = false;
      go('/');
    });
  };
  root.addEventListener('click', onHomeLinkClick, true);

  const onBeforeUnload = (event: BeforeUnloadEvent): void => {
    if (state.dirty && state.questions.length) {
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  return () => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    root.removeEventListener('click', onClick);
    root.removeEventListener('click', onHomeLinkClick, true);
    root.removeEventListener('input', onBankInput);
    if (statsTimer !== null) window.clearTimeout(statsTimer);
    state.abort?.abort();
  };
}

/* ===================================================================== */
/*                                 HTML                                  */
/* ===================================================================== */

function adminShell(): string {
  return `
    <div class="page admin-page">
      ${siteHeader()}
      <main class="container admin-main">
        <div class="admin-hero">
          <div class="admin-hero-copy">
            <span class="eyebrow">${icon('settings', 14)} ADMIN CONSOLE</span>
            <h1>题库管理</h1>
            <p>上传 PDF → AI 解析 → 校对答案 → 保存为静态 JSON。所有密钥都只保存在你的浏览器里。</p>
          </div>
          <div class="admin-steps">
            <div class="admin-step is-active is-current" data-step="1"><i>1</i><span>上传与解析</span></div>
            <em></em>
            <div class="admin-step" data-step="2"><i>2</i><span>校对题目</span></div>
            <em></em>
            <div class="admin-step" data-step="3"><i>3</i><span>导出与发布</span></div>
          </div>
        </div>

        <div class="admin-grid">
          <section class="panel" id="import-panel">
            <div class="panel-head">
              <span class="step-badge">1</span>
              <div class="panel-title">
                <h2>上传资料</h2>
                <p>文字版 PDF 效果最好，也可以直接粘贴文本</p>
              </div>
            </div>

            <div class="segmented" role="tablist" aria-label="资料来源">
              <button type="button" class="is-active" data-act="mode" data-mode="pdf" role="tab">上传 PDF</button>
              <button type="button" data-act="mode" data-mode="text" role="tab">粘贴文本</button>
            </div>

            <div class="mode-body" data-mode-body="pdf">
              <div class="dropzone" id="dropzone" tabindex="0" role="button" aria-label="选择 PDF 文件">
                <span class="dropzone-icon">${icon('upload', 26)}</span>
                <b>点击选择 PDF，或把文件拖到这里</b>
                <span class="dropzone-sub">文字版 PDF 最佳；扫描件请先 OCR · 单个文件 ≤ 30 MB</span>
                <input type="file" id="pdf-input" accept="application/pdf,.pdf" hidden />
              </div>
              <div class="file-chip" id="file-chip" hidden></div>
            </div>

            <div class="mode-body" data-mode-body="text" hidden>
              <textarea id="paste-text" class="textarea" rows="9" placeholder="粘贴题目文本，例如：&#10;1. 机动车在高速公路上行驶，车速超过 100 km/h 时，应当与同车道前车保持多少米以上的距离？&#10;A. 50 米   B. 100 米   C. 80 米   D. 120 米&#10;答案：B&#10;&#10;2. 雨天路面湿滑，制动距离会变长。（ ）&#10;答案：正确"></textarea>
              <div class="field-hint">
                <span id="paste-count">0 字</span>
                <span>支持「题目 + 选项 + 答案」的常见排版</span>
              </div>
            </div>

            <div class="import-foot">
              <button type="button" class="btn btn-primary btn-lg" data-act="parse">
                ${icon('sparkles', 18)} 开始 AI 解析
              </button>
              <span class="muted" id="parse-hint" data-tone="warn">解析前请先在右侧配置 AI 接口</span>
            </div>
          </section>

          <section class="panel" id="ai-panel">
            <div class="panel-head">
              <span class="step-badge is-alt">AI</span>
              <div class="panel-title">
                <h2>AI 接口</h2>
                <p>Key 只存在本机浏览器，不会写进仓库</p>
              </div>
            </div>

            <label class="field">
              <span class="field-label">服务预设</span>
              <select id="ai-preset" class="select">
                ${AI_PRESETS.map(
                  (preset) => `<option value="${preset.id}">${esc(preset.label)}</option>`,
                ).join('')}
              </select>
            </label>
            <p class="field-note" id="ai-preset-note"></p>

            <label class="field">
              <span class="field-label">接口地址（Base URL）</span>
              <input id="ai-base" class="input" placeholder="https://openrouter.ai/api/v1" spellcheck="false" autocomplete="off" />
            </label>

            <label class="field">
              <span class="field-label">模型</span>
              <input id="ai-model" class="input" placeholder="google/gemini-2.5-flash" spellcheck="false" autocomplete="off" />
            </label>

            <label class="field">
              <span class="field-label">API Key</span>
              <div class="input-wrap">
                ${icon('key', 18)}
                <input id="ai-key" type="password" class="input" placeholder="sk-..." autocomplete="off" spellcheck="false" />
                <button type="button" class="input-action" data-act="toggle-key" aria-label="显示 Key">${icon('eye', 18)}</button>
              </div>
            </label>

            <label class="check">
              <input type="checkbox" id="ai-json" />
              <span>使用 JSON 模式（推荐，失败会自动回退）</span>
            </label>

            <div class="panel-actions">
              <button type="button" class="btn btn-primary btn-sm" data-act="save-ai">保存设置</button>
              <button type="button" class="btn btn-outline btn-sm" data-act="test-ai">测试连接</button>
              <span class="status-text" id="ai-status"></span>
            </div>

            <details class="inline-details">
              <summary>${icon('info', 15)} 浏览器直连失败怎么办？</summary>
              <div>
                <p>多数官方接口禁止网页直接调用（CORS 拦截），可以：</p>
                <ol>
                  <li>使用支持跨域的服务，例如 OpenRouter、Gemini；</li>
                  <li>按 README 部署一个免费的 Cloudflare Worker 代理，把接口地址填成代理地址。</li>
                </ol>
                <p>任何情况下都不要把 API Key 写进代码仓库。</p>
              </div>
            </details>
          </section>
        </div>

        <section class="panel panel-status" id="status-panel" hidden data-tone="running">
          <div class="status-main">
            <span class="status-icon" id="status-icon">${icon('sparkles', 18)}</span>
            <div class="status-copy">
              <b id="status-title">准备解析</b>
              <p id="status-detail">等待开始…</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" data-act="cancel-parse" id="cancel-parse" hidden>取消</button>
          </div>
          <div class="progress"><span id="status-bar" style="width: 0%"></span></div>
          <div class="status-log" id="status-log"></div>
        </section>

        <section class="panel" id="review-panel" hidden>
          <div class="panel-head">
            <span class="step-badge">2</span>
            <div class="panel-title">
              <h2>校对题目</h2>
              <p id="review-summary">已识别 0 道题</p>
            </div>
            <button type="button" class="btn btn-ghost btn-sm" data-act="clear-questions">清空全部</button>
          </div>

          <div class="review-toolbar">
            <div class="chips" id="review-filter">
              <button type="button" class="chip is-active" data-act="filter-review" data-filter="all">全部 <i>0</i></button>
              <button type="button" class="chip" data-act="filter-review" data-filter="single">单选 <i>0</i></button>
              <button type="button" class="chip" data-act="filter-review" data-filter="multiple">多选 <i>0</i></button>
              <button type="button" class="chip" data-act="filter-review" data-filter="judge">判断 <i>0</i></button>
              <button type="button" class="chip" data-act="filter-review" data-filter="fill">填空 <i>0</i></button>
              <button type="button" class="chip" data-act="filter-review" data-filter="short">简答 <i>0</i></button>
              <button type="button" class="chip" data-act="filter-review" data-filter="low">待确认 <i>0</i></button>
            </div>
            <span class="review-tip">单选/判断点圆点，多选勾选所有正确项，简答填写参考答案</span>
          </div>

          <div class="review-edit-list" id="review-edit-list"></div>

          <div class="review-footer">
            <span class="warn" id="review-warn" hidden></span>
          </div>
        </section>

        <section class="panel" id="bank-panel" hidden>
          <div class="panel-head">
            <span class="step-badge">3</span>
            <div class="panel-title">
              <h2>题库信息</h2>
              <p>这些信息会显示在首页卡片上</p>
            </div>
          </div>

          <div class="bank-form-grid">
            <div class="bank-form">
              <label class="field">
                <span class="field-label">题库标题 <em>*</em></span>
                <input id="bank-title" class="input" maxlength="60" placeholder="例如：科目一 · 交通法规精选" />
              </label>
              <div class="field-row">
                <label class="field">
                  <span class="field-label">分类</span>
                  <input id="bank-category" class="input" maxlength="20" placeholder="例如：科目一" />
                </label>
                <label class="field">
                  <span class="field-label">来源</span>
                  <input id="bank-source" class="input" maxlength="60" placeholder="例如：2024 题库.pdf" />
                </label>
              </div>
              <label class="field">
                <span class="field-label">简介</span>
                <textarea id="bank-desc" class="textarea" rows="2" maxlength="120" placeholder="一句话介绍这套题库"></textarea>
              </label>
              <div class="field">
                <span class="field-label">封面图标</span>
                <div class="emoji-picker" id="emoji-picker"></div>
              </div>
              <div class="field">
                <span class="field-label">封面配色</span>
                <div class="color-picker" id="color-picker"></div>
              </div>
            </div>

            <aside class="bank-preview">
              <span class="field-label">首页卡片预览</span>
              <div id="bank-preview"></div>
              <p class="preview-stats" id="preview-stats"></p>
            </aside>
          </div>

          <div class="save-bar">
            <div class="save-actions">
              <button type="button" class="btn btn-outline" data-act="save-local">${icon('download', 16)} 保存为本地草稿</button>
              <button type="button" class="btn btn-primary" data-act="download-bank">${icon('file', 16)} 下载题库 JSON</button>
            </div>
            <span class="status-text" id="save-status"></span>
          </div>
          <p class="save-note">
            ${icon('info', 15)} 下载题库 JSON 后，在项目根目录运行 <code>npm run add-bank -- "文件路径"</code>，再手动 <code>git push</code>；GitHub Actions 会自动构建站点。
          </p>
        </section>

        <section class="panel" id="manual-publish">
          <div class="panel-head">
            <span class="step-badge is-alt">${icon('file', 16)}</span>
            <div class="panel-title">
              <h2>手动发布</h2>
              <p>下载 JSON → 本地写入 → 手动 git push</p>
            </div>
          </div>
          <div class="manual-publish">
            <ol>
              <li>点上方 <b>下载题库 JSON</b>，保存到电脑。</li>
              <li>
                在项目根目录执行
                <code>npm run add-bank -- "下载的 JSON 路径"</code>
                ，脚本会写入 <code>public/data/banks/</code> 并更新 <code>index.json</code>。
              </li>
              <li>
                提交并推送：
                <pre>git add public/data/banks
git commit -m "add question bank"
git push</pre>
              </li>
              <li>GitHub Actions 会自动重新构建，约 1–2 分钟后刷新线上首页。</li>
            </ol>
            <p class="warn-block">${icon('info', 15)} 项目不再在网页中保存 GitHub Token；所有题库更新都由你在本地 push 触发。</p>
          </div>
        </section>

        <section class="panel" id="library-panel">
          <div class="panel-head">
            <span class="step-badge is-alt">${icon('layers', 16)}</span>
            <div class="panel-title">
              <h2>题库管理</h2>
              <p>线上题库 + 本机草稿；删除线上题库需本地执行 remove-bank 后 push</p>
            </div>
          </div>
          <div id="library-list"><p class="empty-hint">正在加载题库…</p></div>
        </section>
      </main>
    </div>`;
}

/* ===================================================================== */
/*                              工具函数                                 */
/* ===================================================================== */

function questionEditor(question: Question, index: number): string {
  const isJudge = question.type === 'judge';
  const isShort = question.type === 'short';
  const isFill = question.type === 'fill';
  const isMultiple = question.type === 'multiple';
  const selectedKeys = isMultiple ? splitAnswerKeys(question.answer) : [];

  const options = question.options
    .map((option, optionIndex) => {
      const keyText = isJudge ? (option.key === 'A' ? '对' : '错') : option.key;
      const checked = isMultiple ? selectedKeys.includes(option.key) : question.answer === option.key;
      return `
        <div class="opt-edit">
          <label class="opt-radio${isMultiple ? ' is-multiple' : ''}" title="${
            isMultiple ? '勾选所有正确答案' : '设为正确答案'
          }">
            <input
              type="${isMultiple ? 'checkbox' : 'radio'}"
              name="ans-${index}"
              value="${esc(option.key)}"
              data-qi="${index}"
              ${checked ? 'checked' : ''}
            />
            <span class="opt-key">${keyText}</span>
          </label>
          <input
            type="text"
            class="input opt-input"
            data-field="option"
            data-qi="${index}"
            data-oi="${optionIndex}"
            value="${esc(option.text)}"
            placeholder="选项内容"
            ${isJudge ? 'readonly' : ''}
          />
          ${
            !isJudge && question.options.length > 2
              ? `<button type="button" class="icon-btn icon-btn-sm" data-act="del-option" data-qi="${index}" data-oi="${optionIndex}" aria-label="删除选项">${icon('x', 15)}</button>`
              : ''
          }
        </div>`;
    })
    .join('');

  const typeOptions = (Object.keys(TYPE_LABELS) as QuestionType[])
    .map(
      (type) =>
        `<option value="${type}"${question.type === type ? ' selected' : ''}>${TYPE_LABELS[type]}</option>`,
    )
    .join('');

  const answerBlock = isFill
    ? `<div class="q-edit-fill">
        <span class="field-label">正确答案</span>
        <input class="input q-edit-fill-answer" data-field="fill-answer" data-qi="${index}" value="${esc(question.answer)}" placeholder="填写标准答案，用户答对即判对" />
        <p class="field-note">按文本比对：忽略空格、大小写和首尾标点。</p>
      </div>`
    : isShort
      ? `<div class="q-edit-short">
          <span class="field-label">参考答案</span>
          <textarea class="textarea q-edit-reference" data-field="reference" data-qi="${index}" rows="3" placeholder="参考答案（可选）；答题页会展示给用户自测">${esc(question.answer)}</textarea>
          <p class="field-note">简答题不参与自动判分，答题页会展示参考答案供自测。</p>
        </div>`
      : `<div class="opt-edits">
          ${options}
          ${
            question.options.length < 6
              ? `<button type="button" class="btn btn-ghost btn-xs add-option" data-act="add-option" data-qi="${index}">${icon('plus', 14)} 添加选项</button>`
              : ''
          }
        </div>`;

  return `
    <article class="q-edit" data-qi="${index}">
      <div class="q-edit-head">
        <span class="q-edit-no">${String(index + 1).padStart(2, '0')}</span>
        <select class="select select-sm" data-field="type" data-qi="${index}" aria-label="题型">
          ${typeOptions}
        </select>
        ${
          isShort
            ? question.answer.trim()
              ? ''
              : `<span class="q-edit-flag is-warn">无参考答案</span>`
            : question.answer
              ? ''
              : `<span class="q-edit-flag is-missing">未设置答案</span>`
        }
        ${
          question.confidence === 'low'
            ? `<span class="q-edit-flag is-warn" title="原文可能没有提供答案">AI 待确认</span>`
            : ''
        }
        <button type="button" class="icon-btn icon-btn-sm q-edit-del" data-act="del-question" data-qi="${index}" aria-label="删除这道题">
          ${icon('trash', 15)}
        </button>
      </div>

      <textarea class="textarea q-edit-stem" data-field="stem" data-qi="${index}" rows="2" placeholder="题干">${esc(question.stem)}</textarea>

      ${answerBlock}

      <div class="q-edit-bottom">
        <span class="answer-label" data-answer-label="${index}">${answerLabel(question)}</span>
        <details class="q-edit-analysis">
          <summary>${icon('sparkles', 14)} 解析与知识点</summary>
          <textarea class="textarea" data-field="analysis" data-qi="${index}" rows="2" placeholder="解析（可选）">${esc(question.analysis ?? '')}</textarea>
          <input class="input" data-field="knowledge" data-qi="${index}" value="${esc(question.knowledge ?? '')}" placeholder="知识点标签（可选）" />
        </details>
      </div>
    </article>`;
}

function answerLabel(question: Question): string {
  if (question.type === 'short') {
    return `参考答案：${question.answer.trim() ? '已填写' : '暂无'}`;
  }
  if (question.type === 'fill') {
    return `答案：${question.answer.trim() || '未设置'}`;
  }
  if (!question.answer) return '答案：未设置';
  if (question.type === 'multiple') return `答案：${answerSummary(question)}`;
  if (question.type === 'judge') return `答案：${question.answer === 'A' ? '正确' : '错误'}`;
  const option = question.options.find((item) => item.key === question.answer);
  return `答案：${question.answer}${option ? ` · ${option.text.slice(0, 18)}` : ''}`;
}

function updateAnswerLabel(root: HTMLElement, question: Question, index: number): void {
  const label = qs<HTMLElement>(`[data-answer-label="${index}"]`, root);
  if (label) label.textContent = answerLabel(question);
}

function convertType(question: Question, type: QuestionType): void {
  if (question.type === type) return;
  const previousType = question.type;
  const previousKeys = answerKeys(question);
  question.type = type;

  if (type === 'fill') {
    question.options = [];
    question.answer = previousType === 'short' || previousType === 'fill' ? question.answer : '';
    question.confidence = 'high';
    return;
  }

  if (type === 'short') {
    question.options = [];
    question.answer = previousType === 'fill' || previousType === 'short' ? question.answer : '';
    question.confidence = 'high';
    return;
  }

  if (type === 'judge') {
    question.options = [
      { key: 'A', text: '正确' },
      { key: 'B', text: '错误' },
    ];
    question.answer = previousKeys.includes('B') ? 'B' : 'A';
    question.confidence = 'high';
    return;
  }

  if (
    previousType === 'judge' ||
    previousType === 'short' ||
    previousType === 'fill' ||
    question.options.length < 2
  ) {
    question.options = ['A', 'B', 'C', 'D'].map((key) => ({ key, text: '' }));
    question.answer = '';
  } else {
    const keys = previousKeys.filter((key) => question.options.some((option) => option.key === key));
    question.answer = type === 'multiple' ? keys.join(',') : (keys[0] ?? '');
  }
  question.confidence = 'high';
}

function reindexAfterRemoval(question: Question, optionIndex: number): void {
  const oldIndexes = answerKeys(question)
    .map((key) => question.options.findIndex((option) => option.key === key))
    .filter((index) => index >= 0);
  question.options.splice(optionIndex, 1);
  question.options = question.options.map((option, index) => ({
    key: String.fromCharCode(65 + index),
    text: option.text,
  }));
  question.answer = oldIndexes
    .filter((index) => index !== optionIndex)
    .map((index) => (index > optionIndex ? index - 1 : index))
    .map((index) => question.options[index]?.key)
    .filter((key): key is string => Boolean(key))
    .join(',');
}

function clearQuestionFlags(target: HTMLElement): void {
  const card = target.closest('.q-edit');
  if (!card) return;
  card.querySelector('.q-edit-flag.is-missing')?.remove();
  card.querySelectorAll('.q-edit-flag.is-warn').forEach((flag) => flag.remove());
}

function collectIssues(state: AdminState): string[] {
  const issues: string[] = [];
  if (!state.questions.length) issues.push('还没有解析出任何题目');
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

function buildBank(state: AdminState): Bank {
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
      confidence: question.confidence ?? 'high',
    };
  });
  const counts = countByType(questions);

  return {
    id: state.meta.id,
    title: state.meta.title.trim(),
    description: state.meta.description.trim(),
    category: state.meta.category.trim(),
    emoji: state.meta.emoji,
    color: state.meta.color,
    source: state.meta.source.trim() || state.sourceFile,
    file: `${state.meta.id}.json`,
    createdAt: state.meta.createdAt,
    updatedAt: nowISO(),
    questions,
    ...counts,
    meta: {
      sourceFile: state.sourceFile,
      model: state.aiConfig.model,
      generator: `TiMian v${APP.version} · AI`,
    },
  };
}

function guessTitle(name: string): string {
  const base = name
    .replace(/\.pdf$/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return (base || `AI 题库 · ${formatDate(nowISO())}`).slice(0, 40);
}

function readAIConfig(root: HTMLElement): AIConfig {
  return {
    baseUrl: (qs<HTMLInputElement>('#ai-base', root)?.value ?? '').trim(),
    model: (qs<HTMLInputElement>('#ai-model', root)?.value ?? '').trim(),
    apiKey: (qs<HTMLInputElement>('#ai-key', root)?.value ?? '').trim(),
    jsonMode: qs<HTMLInputElement>('#ai-json', root)?.checked ?? true,
  };
}

function renderPreview(root: HTMLElement, state: AdminState): void {
  const container = qs<HTMLElement>('#bank-preview', root);
  if (!container) return;
  const counts = countByType(state.questions);
  container.innerHTML = `
    <div class="bank-card is-preview" data-color="${esc(state.meta.color)}">
      <div class="bank-cover">
        <span class="bank-emoji">${esc(state.meta.emoji)}</span>
        <span class="bank-cat">${esc(state.meta.category || '综合')}</span>
      </div>
      <div class="bank-body">
        <h3 class="bank-title">${esc(state.meta.title || '未命名题库')}</h3>
        <p class="bank-desc">${esc(state.meta.description || '一句话介绍这套题库')}</p>
        <div class="bank-meta">
          <span>${icon('book', 14)} ${counts.questionCount} 题</span>
          <span>单选 ${counts.singleCount}</span>
          ${counts.multipleCount ? `<span>多选 ${counts.multipleCount}</span>` : ''}
          <span>判断 ${counts.judgeCount}</span>
          ${counts.fillCount ? `<span>填空 ${counts.fillCount}</span>` : ''}
          ${counts.shortCount ? `<span>简答 ${counts.shortCount}</span>` : ''}
        </div>
      </div>
      <div class="bank-foot"><span class="bank-time">刚刚更新</span><span class="bank-go">开始刷题 ${icon('arrow-right', 15)}</span></div>
    </div>`;
  const stats = qs<HTMLElement>('#preview-stats', root);
  if (stats) {
    stats.textContent = `${counts.questionCount} 题 · 单选 ${counts.singleCount}${
      counts.multipleCount ? ` · 多选 ${counts.multipleCount}` : ''
    } · 判断 ${counts.judgeCount}${counts.fillCount ? ` · 填空 ${counts.fillCount}` : ''}${
      counts.shortCount ? ` · 简答 ${counts.shortCount}` : ''
    }`;
  }
}

function refreshStats(root: HTMLElement, state: AdminState): void {
  const counts = countByType(state.questions);
  const lowCount = state.questions.filter(
    (question) => question.confidence === 'low' || !question.answer.trim(),
  ).length;

  const summary = qs<HTMLElement>('#review-summary', root);
  if (summary) {
    summary.textContent = state.questions.length
      ? `已识别 ${counts.questionCount} 道题 · 单选 ${counts.singleCount} · 多选 ${counts.multipleCount} · 判断 ${counts.judgeCount} · 填空 ${counts.fillCount} · 简答 ${counts.shortCount} · 待确认 ${lowCount}`
      : '还没有解析结果';
  }

  const countMap: Record<string, number> = {
    all: counts.questionCount,
    single: counts.singleCount,
    multiple: counts.multipleCount,
    judge: counts.judgeCount,
    fill: counts.fillCount,
    short: counts.shortCount,
    low: lowCount,
  };

  qsa<HTMLElement>('[data-act="filter-review"]', root).forEach((button) => {
    const filter = button.dataset.filter ?? 'all';
    const badge = button.querySelector('i');
    if (badge) badge.textContent = String(countMap[filter] ?? 0);
    button.classList.toggle('is-active', filter === state.reviewFilter);
  });

  const issues = collectIssues(state);
  const warn = qs<HTMLElement>('#review-warn', root);
  if (warn) {
    warn.hidden = issues.length === 0;
    warn.textContent = issues.length
      ? `${issues[0]}${issues.length > 1 ? `（共 ${issues.length} 项待处理）` : ''}`
      : '';
  }

  qsa<HTMLButtonElement>('[data-act="save-local"], [data-act="download-bank"]', root).forEach(
    (button) => {
      button.disabled = issues.length > 0;
    },
  );

  renderPreview(root, state);
}

function updateParseButton(root: HTMLElement, state: AdminState, parsing: boolean): void {
  const button = qs<HTMLButtonElement>('[data-act="parse"]', root);
  if (!button) return;
  button.disabled = parsing;
  button.innerHTML = parsing
    ? '<span class="spinner"></span> AI 解析中…'
    : `${icon('sparkles', 18)} 开始 AI 解析`;
  const cancel = qs<HTMLElement>('#cancel-parse', root);
  if (cancel) cancel.hidden = !parsing;
  updateParseHint(root, state);
}

function updateParseHint(root: HTMLElement, state: AdminState): void {
  const hint = qs<HTMLElement>('#parse-hint', root);
  if (!hint) return;
  if (!state.aiConfig.apiKey) {
    hint.textContent = '解析前请先在右侧配置 AI 接口';
    hint.dataset.tone = 'warn';
    return;
  }
  if (state.mode === 'pdf' && !state.file) {
    hint.textContent = '已配置 AI，请选择 PDF 文件';
    hint.dataset.tone = 'idle';
    return;
  }
  hint.textContent = `将调用 ${state.aiConfig.model || 'AI 模型'} 解析，题目较多时请耐心等待`;
  hint.dataset.tone = 'idle';
}

function showStatus(
  root: HTMLElement,
  options: {
    title: string;
    detail: string;
    progress: number;
    tone: 'running' | 'success' | 'error';
    cancel: boolean;
  },
): void {
  const panel = qs<HTMLElement>('#status-panel', root);
  if (!panel) return;
  panel.hidden = false;
  panel.dataset.tone = options.tone;

  const iconBox = qs<HTMLElement>('#status-icon', root);
  if (iconBox) {
    iconBox.innerHTML =
      options.tone === 'success'
        ? icon('check-circle', 18)
        : options.tone === 'error'
          ? icon('alert', 18)
          : '<span class="spinner"></span>';
  }

  qs<HTMLElement>('#status-title', root)!.textContent = options.title;
  qs<HTMLElement>('#status-detail', root)!.textContent = options.detail;
  qs<HTMLElement>('#status-bar', root)!.style.width = `${clamp(options.progress, 0, 100)}%`;
  qs<HTMLElement>('#cancel-parse', root)!.hidden = !options.cancel;
}

function handleParseError(root: HTMLElement, error: unknown): void {
  const aborted =
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof AIError && error.kind === 'aborted') ||
    (error instanceof PdfError && error.code === 'aborted');

  if (aborted) {
    showStatus(root, {
      title: '已取消解析',
      detail: '可以调整设置后重新开始',
      progress: 0,
      tone: 'error',
      cancel: false,
    });
    return;
  }

  let message = error instanceof Error ? error.message : '未知错误';
  if (error instanceof AIError && AI_HINTS[error.kind]) {
    message = `${message} ${AI_HINTS[error.kind]}`;
  }
  if (error instanceof PdfError && error.code === 'encrypted') {
    message = `${message} 可以先用其他工具去掉 PDF 密码。`;
  }

  showStatus(root, {
    title: '解析失败',
    detail: message,
    progress: 0,
    tone: 'error',
    cancel: false,
  });
  toast('解析失败，请查看提示', 'error', 4200);
}

let libraryRequest = 0;

async function renderLibrary(root: HTMLElement, state: AdminState): Promise<void> {
  const container = qs<HTMLElement>('#library-list', root);
  if (!container) return;
  const request = ++libraryRequest;

  try {
    const { banks } = await listBankSummaries();
    if (request !== libraryRequest || !container.isConnected) return;
    if (!banks.length) {
      container.innerHTML =
        '<p class="empty-hint">还没有题库。解析并保存后，可以在这里继续编辑；线上题库会从 public/data/banks/index.json 加载。</p>';
      return;
    }
    container.innerHTML = banks.map(libraryRow).join('');
  } catch {
    if (request !== libraryRequest || !container.isConnected) return;
    container.innerHTML =
      '<p class="empty-hint">题库列表加载失败，请刷新页面重试。</p>';
  }
  void state;
}

function libraryRow(bank: BankSummary): string {
  const title = bank.title || '未命名题库';
  const badges = [
    bank.remote ? '<em class="lib-badge is-remote">线上</em>' : '',
    bank.local ? '<em class="lib-badge is-local">本机草稿</em>' : '',
  ].join('');
  const counts = `${formatNumber(bank.questionCount)} 题 · 单选 ${bank.singleCount}${
    bank.multipleCount ? ` · 多选 ${bank.multipleCount}` : ''
  } · 判断 ${bank.judgeCount}${bank.fillCount ? ` · 填空 ${bank.fillCount}` : ''}${
    bank.shortCount ? ` · 简答 ${bank.shortCount}` : ''
  }`;

  return `
    <div class="draft-row">
      <span class="draft-emoji">${esc(bank.emoji || '📘')}</span>
      <div class="draft-main">
        <b>${esc(title)} ${badges}</b>
        <span>${counts} · 更新于 ${formatDate(bank.updatedAt)}</span>
      </div>
      <div class="draft-actions">
        ${
          bank.local
            ? `<button type="button" class="btn btn-ghost btn-sm" data-act="load-draft" data-id="${esc(bank.id)}">继续编辑</button>`
            : ''
        }
        <button type="button" class="btn btn-ghost btn-sm" data-act="download-library" data-id="${esc(bank.id)}">下载 JSON</button>
        <button type="button" class="icon-btn icon-btn-sm" data-act="delete-library" data-id="${esc(bank.id)}" data-title="${esc(title)}" data-local="${bank.local ? '1' : '0'}" data-remote="${bank.remote ? '1' : '0'}" aria-label="删除题库">${icon('trash', 15)}</button>
      </div>
    </div>`;
}

