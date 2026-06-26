import type { GeminiKeyConfig, OpenAIProviderConfig, ProviderKeyConfig } from '@/types';
import { hasDisableAllModelsRule } from '@/components/providers/utils';
import { maskApiKey } from '@/utils/format';
import type { ProviderBrand, ProviderResource } from './types';

const collectModelNames = (models?: Array<{ name?: string }>): string[] => {
  const seen = new Set<string>();
  (models ?? []).forEach((model) => {
    const name = String(model?.name ?? '').trim();
    if (name) seen.add(name);
  });
  return Array.from(seen).sort((a, b) => a.localeCompare(b));
};

const normalizePriority = (priority?: number): number =>
  typeof priority === 'number' && Number.isFinite(priority) ? priority : 0;

const buildId = (brand: ProviderBrand, index: number, fragment: string) =>
  `${brand}:${index}:${fragment || 'provider'}`;

function providerKeyToResource(
  brand: 'gemini' | 'codex' | 'claude' | 'vertex',
  config: GeminiKeyConfig | ProviderKeyConfig,
  index: number
): ProviderResource {
  const apiKey = String(config.apiKey ?? '');
  const apiKeyPreview = apiKey ? maskApiKey(apiKey) : '';
  const baseLabel = config.authIndex || apiKeyPreview || `#${index + 1}`;

  return {
    id: buildId(brand, index, `${config.authIndex ?? ''}:${apiKey.slice(0, 8)}`),
    brand,
    originalIndex: index,
    name: baseLabel,
    identifier: baseLabel,
    apiKeyPreview,
    apiKey,
    authIndex: config.authIndex ?? '',
    baseUrl: config.baseUrl ?? '',
    proxyUrl: config.proxyUrl ?? '',
    prefix: config.prefix ?? '',
    models: collectModelNames(config.models),
    priority: normalizePriority(config.priority),
    disabled: hasDisableAllModelsRule(config.excludedModels),
    disableCooling: config.disableCooling === true,
    headerCount: config.headers ? Object.keys(config.headers).length : 0,
    apiKeyEntryCount: 0,
    raw: config,
  };
}

export function geminiToResource(config: GeminiKeyConfig, index: number): ProviderResource {
  return providerKeyToResource('gemini', config, index);
}

export function codexToResource(config: ProviderKeyConfig, index: number): ProviderResource {
  return providerKeyToResource('codex', config, index);
}

export function claudeToResource(config: ProviderKeyConfig, index: number): ProviderResource {
  return providerKeyToResource('claude', config, index);
}

export function vertexToResource(config: ProviderKeyConfig, index: number): ProviderResource {
  return providerKeyToResource('vertex', config, index);
}

export function openaiToResource(
  config: OpenAIProviderConfig,
  index: number
): ProviderResource {
  const name = String(config.name ?? '').trim() || `#${index + 1}`;
  const firstEntry = config.apiKeyEntries?.[0];
  const firstKey = firstEntry?.apiKey ?? '';

  return {
    id: buildId('openaiCompatibility', index, name),
    brand: 'openaiCompatibility',
    originalIndex: index,
    name,
    identifier: name,
    apiKeyPreview: firstKey ? maskApiKey(firstKey) : '',
    apiKey: firstKey,
    authIndex: firstEntry?.authIndex ?? config.authIndex ?? '',
    baseUrl: config.baseUrl ?? '',
    proxyUrl: firstEntry?.proxyUrl ?? '',
    prefix: config.prefix ?? '',
    models: collectModelNames(config.models),
    priority: normalizePriority(config.priority),
    disabled: config.disabled === true,
    disableCooling: config.disableCooling === true,
    headerCount: config.headers ? Object.keys(config.headers).length : 0,
    apiKeyEntryCount: config.apiKeyEntries?.length ?? 0,
    raw: config,
  };
}
