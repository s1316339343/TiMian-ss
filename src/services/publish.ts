import type { Bank, BankIndex, PublishConfig } from '../types';
import { bankFilePayload, nowISO, toMeta } from './bankRepo';
import { GitHubError, getFileContent, putFile } from './github';

export interface PublishProgress {
  step: 'read' | 'bank' | 'index';
  message: string;
}

export interface PublishResult {
  bankPath: string;
  indexPath: string;
  bankHtmlUrl: string;
  commitUrl: string;
}

export function normalizeDir(dir: string): string {
  const clean = (dir || '').trim().replace(/^\/+|\/+$/g, '');
  return clean || 'public/data/banks';
}

function parseIndex(text: string): BankIndex | null {
  try {
    const parsed = JSON.parse(text) as Partial<BankIndex>;
    if (parsed && Array.isArray(parsed.banks)) {
      return {
        version: typeof parsed.version === 'number' ? parsed.version : 1,
        updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : nowISO(),
        banks: parsed.banks,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * 把题库写回 GitHub 仓库（静态 JSON + 索引），触发 GitHub Pages 重新构建。
 * 纯静态站点无法直接写文件，这是「上传即发布」的可行方案。
 */
export async function publishBankToGitHub(
  bank: Bank,
  config: PublishConfig,
  onProgress?: (progress: PublishProgress) => void,
): Promise<PublishResult> {
  const dir = normalizeDir(config.dir);
  const meta = toMeta(bank);
  const bankPath = `${dir}/${bank.id}.json`;
  const indexPath = `${dir}/index.json`;
  const bankContent = bankFilePayload(bank);

  let lastError: unknown = null;

  // 最多重试一次：处理「刚刚有人提交过同一个文件」的 409 冲突
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      onProgress?.({ step: 'read', message: '正在读取仓库中的题库索引…' });
      const indexFile = await getFileContent(config, indexPath);
      let index: BankIndex = { version: 1, updatedAt: nowISO(), banks: [] };
      if (indexFile && indexFile.text.trim()) {
        const parsed = parseIndex(indexFile.text);
        if (!parsed) {
          throw new Error('仓库中的 index.json 无法解析，请先手动检查该文件的内容。');
        }
        index = parsed;
      }

      const banks = index.banks.filter((item) => item.id !== meta.id);
      banks.unshift(meta);
      const nextIndex: BankIndex = {
        version: 1,
        updatedAt: nowISO(),
        banks,
      };

      onProgress?.({ step: 'bank', message: '正在写入题库 JSON…' });
      const bankResult = await putFile(config, bankPath, bankContent, `feat(题库): ${bank.title}`);

      onProgress?.({ step: 'index', message: '正在更新题库索引…' });
      const indexResult = await putFile(
        config,
        indexPath,
        JSON.stringify(nextIndex, null, 2),
        `chore(题库): 更新索引（${bank.title}）`,
      );

      return {
        bankPath,
        indexPath,
        bankHtmlUrl: bankResult.htmlUrl,
        commitUrl: indexResult.commitUrl || bankResult.commitUrl,
      };
    } catch (error) {
      lastError = error;
      if (error instanceof GitHubError && error.status === 409 && attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 900));
        continue;
      }
      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('发布失败，请重试');
}
