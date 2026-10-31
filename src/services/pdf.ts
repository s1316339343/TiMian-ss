import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PAGE_SIZE_LIMITS } from '../config';

type PdfjsModule = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** 懒加载 pdf.js（首屏访客不需要下载 400KB+ 的解析器） */
async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const [pdfjs, worker] = await Promise.all([
        import('pdfjs-dist'),
        import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
      ]);
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    })().catch((error: unknown) => {
      pdfjsPromise = null;
      throw error;
    });
  }
  return pdfjsPromise;
}

export type PdfErrorCode = 'encrypted' | 'invalid' | 'aborted' | 'empty' | 'unknown';

export class PdfError extends Error {
  code: PdfErrorCode;

  constructor(message: string, code: PdfErrorCode) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
  }
}

export interface PdfExtractProgress {
  page: number;
  total: number;
}

export interface PdfExtractResult {
  text: string;
  pageCount: number;
  parsedPages: number;
  charCount: number;
  /** 平均每页字符数过低，通常是扫描件 */
  lowText: boolean;
}

interface RawTextItem {
  str: string;
  transform: number[];
  width?: number;
  height?: number;
  hasEOL?: boolean;
}

function isTextItem(item: unknown): item is RawTextItem {
  if (!item || typeof item !== 'object') return false;
  const candidate = item as Partial<RawTextItem>;
  return typeof candidate.str === 'string' && Array.isArray(candidate.transform);
}

/** 按坐标把文本片段还原成带换行的纯文本 */
function pageToText(items: unknown[]): string {
  const lines: string[] = [];
  let line = '';
  let lastY: number | null = null;
  let lastEndX = 0;

  const pushLine = (): void => {
    const text = line.replace(/[ \t]+$/g, '').trim();
    if (text) lines.push(text);
    line = '';
  };

  for (const raw of items) {
    if (!isTextItem(raw)) continue;
    const x = Number(raw.transform[4] ?? 0);
    const y = Number(raw.transform[5] ?? 0);
    const width = Number(raw.width ?? 0);

    if (lastY !== null && Math.abs(y - lastY) > 2.5) {
      pushLine();
      lastEndX = 0;
    }
    // 片段之间只有明显间距才补空格，避免中文被拆成一字一空格
    if (line && x - lastEndX > 5 && !/\s$/.test(line) && !/^\s/.test(raw.str)) {
      line += ' ';
    }
    line += raw.str;
    lastEndX = x + width;
    lastY = y;

    if (raw.hasEOL) {
      pushLine();
      lastEndX = 0;
    }
  }
  pushLine();
  return lines.join('\n');
}

function mapPdfError(error: unknown): PdfError {
  const name = (error as { name?: string } | null)?.name ?? '';
  if (name === 'PasswordException') {
    return new PdfError('这个 PDF 已加密，请先在本地去掉密码后再上传。', 'encrypted');
  }
  if (name === 'InvalidPDFException') {
    return new PdfError('文件不是有效的 PDF，或者已经损坏。', 'invalid');
  }
  if (name === 'AbortException') {
    return new PdfError('已取消解析', 'aborted');
  }
  const message = error instanceof Error ? error.message : '未知错误';
  return new PdfError(`PDF 解析失败：${message}`, 'unknown');
}

export async function extractPdfText(
  file: File,
  options: { signal?: AbortSignal; onProgress?: (progress: PdfExtractProgress) => void } = {},
): Promise<PdfExtractResult> {
  if (!file.size) throw new PdfError('文件是空的。', 'invalid');

  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({
    data,
    useSystemFonts: true,
  });

  try {
    const doc: PDFDocumentProxy = await task.promise;
    const pageCount = doc.numPages;
    const pageLimit = Math.min(pageCount, PAGE_SIZE_LIMITS.maxPdfPages);
    const pages: string[] = [];

    for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
      if (options.signal?.aborted) throw new PdfError('已取消解析', 'aborted');
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(pageToText(content.items));
      page.cleanup();
      options.onProgress?.({ page: pageNumber, total: pageLimit });
      // 每 3 页让出主线程，保证进度条能刷新
      if (pageNumber % 3 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    const text = pages
      .join('\n\n')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();

    const charCount = text.replace(/\s/g, '').length;
    const parsedPages = Math.max(1, pages.length);
    return {
      text,
      pageCount,
      parsedPages,
      charCount,
      lowText: charCount / parsedPages < 80,
    };
  } catch (error) {
    if (error instanceof PdfError) throw error;
    throw mapPdfError(error);
  } finally {
    await task.destroy().catch(() => undefined);
  }
}
