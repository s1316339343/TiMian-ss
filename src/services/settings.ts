import { AI_PRESETS, DEFAULT_AI_CONFIG, STORAGE_KEYS } from '../config';
import type { AIConfig } from '../types';
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
