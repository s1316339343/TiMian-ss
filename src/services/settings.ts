import { AI_PRESETS, DEFAULT_AI_CONFIG, STORAGE_KEYS } from '../config';
import type { AIConfig, PublishConfig } from '../types';
import { getLocalStorage, readJSON, writeJSON } from '../utils/storage';

export function loadAIConfig(): AIConfig {
  const stored = readJSON<Partial<AIConfig> | null>(getLocalStorage(), STORAGE_KEYS.aiConfig, null);
  if (!stored) return { ...DEFAULT_AI_CONFIG };
  return {
    baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : DEFAULT_AI_CONFIG.baseUrl,
    apiKey: typeof stored.apiKey === 'string' ? stored.apiKey : '',
    model: typeof stored.model === 'string' ? stored.model : DEFAULT_AI_CONFIG.model,
    jsonMode: typeof stored.jsonMode === 'boolean' ? stored.jsonMode : true,
  };
}

export function saveAIConfig(config: AIConfig): boolean {
  return writeJSON(getLocalStorage(), STORAGE_KEYS.aiConfig, config);
}

export function presetById(id: string) {
  return AI_PRESETS.find((preset) => preset.id === id);
}

/** 从 GitHub Pages 地址推断 owner / repo */
export function guessRepo(): { owner: string; repo: string } {
  try {
    const host = location.hostname;
    if (host.endsWith('.github.io')) {
      const owner = host.slice(0, -'.github.io'.length);
      const segment = location.pathname.split('/').filter(Boolean)[0] ?? '';
      return { owner, repo: segment };
    }
  } catch {
    /* ignore */
  }
  return { owner: '', repo: '' };
}

export function defaultPublishConfig(): PublishConfig {
  const { owner, repo } = guessRepo();
  return {
    owner,
    repo,
    branch: 'main',
    token: '',
    dir: 'public/data/banks',
  };
}

export function loadPublishConfig(): PublishConfig {
  const stored = readJSON<Partial<PublishConfig> | null>(
    getLocalStorage(),
    STORAGE_KEYS.publishConfig,
    null,
  );
  const defaults = defaultPublishConfig();
  if (!stored) return defaults;
  return {
    owner: typeof stored.owner === 'string' && stored.owner ? stored.owner : defaults.owner,
    repo: typeof stored.repo === 'string' && stored.repo ? stored.repo : defaults.repo,
    branch: typeof stored.branch === 'string' && stored.branch ? stored.branch : defaults.branch,
    token: typeof stored.token === 'string' ? stored.token : '',
    dir: typeof stored.dir === 'string' && stored.dir ? stored.dir : defaults.dir,
  };
}

export function savePublishConfig(config: PublishConfig): boolean {
  return writeJSON(getLocalStorage(), STORAGE_KEYS.publishConfig, config);
}

export function isPublishConfigured(config: PublishConfig): boolean {
  return Boolean(config.owner.trim() && config.repo.trim() && config.token.trim());
}
