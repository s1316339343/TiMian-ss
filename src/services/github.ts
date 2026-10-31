import type { PublishConfig } from '../types';
import { base64DecodeUtf8, base64EncodeUtf8 } from '../utils/crypto';

const API_BASE = 'https://api.github.com';

export class GitHubError extends Error {
  status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export interface GitHubRepoInfo {
  fullName: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
  htmlUrl: string;
}

export interface RemoteFile {
  sha: string;
  text: string;
  htmlUrl: string;
}

export interface PutFileResult {
  htmlUrl: string;
  commitUrl: string;
}

interface RepoResponse {
  full_name?: string;
  private?: boolean;
  default_branch?: string;
  html_url?: string;
  permissions?: { push?: boolean; admin?: boolean };
}

interface FileResponse {
  type?: string;
  sha?: string;
  content?: string;
  encoding?: string;
  html_url?: string;
  download_url?: string;
}

function fullName(config: PublishConfig): string {
  return `${config.owner.trim()}/${config.repo.trim()}`;
}

function contentsPath(config: PublishConfig, path: string): string {
  const encoded = path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return `/repos/${fullName(config)}/contents/${encoded}`;
}

async function ghFetch(config: PublishConfig, path: string, init: RequestInit = {}): Promise<Response> {
  if (!config.token.trim()) throw new GitHubError('尚未填写 GitHub Token。', 0);

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.token.trim()}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (init.body) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers,
      cache: 'no-store',
    });
  } catch {
    throw new GitHubError('无法连接 GitHub API，请检查网络连接后重试。', 0);
  }

  if (!response.ok) {
    const raw = await response.text().catch(() => '');
    let detail = raw.slice(0, 300);
    try {
      const parsed = JSON.parse(raw) as { message?: string };
      detail = parsed.message ?? detail;
    } catch {
      /* 保留原始文本 */
    }

    if (response.status === 401) {
      throw new GitHubError('Token 无效或已过期，请重新生成（需要该仓库的 Contents 读写权限）。', 401);
    }
    if (response.status === 403) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      if (remaining === '0') {
        throw new GitHubError('GitHub API 请求次数已达上限，请稍后再试。', 403);
      }
      throw new GitHubError(`Token 权限不足：${detail}。请确认对目标仓库有 Contents 写入权限。`, 403);
    }
    if (response.status === 404) {
      throw new GitHubError(
        `找不到仓库或文件（404）：${detail}。请检查仓库名、分支以及 Token 是否有该仓库的访问权限。`,
        404,
      );
    }
    if (response.status === 409) {
      throw new GitHubError('文件刚刚被改动，产生冲突，请重试一次。', 409);
    }
    if (response.status === 422) {
      throw new GitHubError(`提交被拒绝（422）：${detail}`, 422);
    }
    throw new GitHubError(`GitHub API 错误（${response.status}）：${detail}`, response.status);
  }

  return response;
}

export async function testGitHubConnection(config: PublishConfig): Promise<GitHubRepoInfo> {
  if (!config.owner.trim() || !config.repo.trim()) {
    throw new GitHubError('请填写仓库所有者（owner）和仓库名（repo）。', 0);
  }
  const response = await ghFetch(config, `/repos/${fullName(config)}`);
  const data = (await response.json()) as RepoResponse;
  return {
    fullName: data.full_name ?? fullName(config),
    private: Boolean(data.private),
    defaultBranch: data.default_branch ?? 'main',
    canPush: Boolean(data.permissions?.push || data.permissions?.admin),
    htmlUrl: data.html_url ?? '',
  };
}

export async function getFileContent(
  config: PublishConfig,
  path: string,
): Promise<RemoteFile | null> {
  try {
    const branch = encodeURIComponent(config.branch.trim() || 'main');
    const response = await ghFetch(config, `${contentsPath(config, path)}?ref=${branch}`);
    const data = (await response.json()) as FileResponse;
    if (!data || data.type !== 'file' || typeof data.sha !== 'string') return null;

    let text = '';
    if (typeof data.content === 'string' && data.content) {
      text = base64DecodeUtf8(data.content);
    } else if (typeof data.download_url === 'string') {
      // 大于 1MB 的文件不会内联返回 content
      const raw = await fetch(data.download_url, { cache: 'no-store' });
      if (raw.ok) text = await raw.text();
    }

    return {
      sha: data.sha,
      text,
      htmlUrl: data.html_url ?? '',
    };
  } catch (error) {
    if (error instanceof GitHubError && error.status === 404) return null;
    throw error;
  }
}

export async function putFile(
  config: PublishConfig,
  path: string,
  content: string,
  message: string,
): Promise<PutFileResult> {
  const existing = await getFileContent(config, path);
  const body: Record<string, unknown> = {
    message,
    content: base64EncodeUtf8(content),
    branch: config.branch.trim() || 'main',
  };
  if (existing) body.sha = existing.sha;

  const response = await ghFetch(config, contentsPath(config, path), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
  const data = (await response.json()) as {
    content?: { html_url?: string };
    commit?: { html_url?: string };
  };
  return {
    htmlUrl: data.content?.html_url ?? '',
    commitUrl: data.commit?.html_url ?? '',
  };
}

export async function deleteFile(
  config: PublishConfig,
  path: string,
  message: string,
): Promise<void> {
  const existing = await getFileContent(config, path);
  if (!existing) return;
  await ghFetch(config, contentsPath(config, path), {
    method: 'DELETE',
    body: JSON.stringify({
      message,
      sha: existing.sha,
      branch: config.branch.trim() || 'main',
    }),
  });
}
