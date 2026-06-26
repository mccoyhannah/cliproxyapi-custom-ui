/**
 * AI 提供商相关 API
 */

import { apiClient } from './client';
import { apiCallApi, getApiCallErrorMessage } from './apiCall';
import {
  normalizeGeminiKeyConfig,
  normalizeOpenAIProvider,
  normalizeProviderKeyConfig
} from './transformers';
import { normalizeApiBase } from '@/utils/connection';
import { normalizeModelList, type ModelInfo } from '@/utils/models';
import type {
  GeminiKeyConfig,
  OpenAIProviderConfig,
  ProviderKeyConfig,
  ApiKeyEntry,
  ModelAlias,
  ProviderConnectivityRequest,
  ProviderModelDiscoveryRequest
} from '@/types';

const serializeHeaders = (headers?: Record<string, string>) => (headers && Object.keys(headers).length ? headers : undefined);
const DEFAULT_CLAUDE_BASE_URL = 'https://api.anthropic.com';
const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com';
const DEFAULT_ANTHROPIC_VERSION = '2023-06-01';
const DEFAULT_TIMEOUT_MS = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const extractArrayPayload = (data: unknown, key: string): unknown[] => {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return [];
  const candidate = data[key] ?? data.items ?? data.data ?? data;
  return Array.isArray(candidate) ? candidate : [];
};

const normalizeBoolean = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  }
  return undefined;
};

const applyProviderExtras = <T extends { disableCooling?: boolean }>(
  raw: unknown,
  config: T | null
): T | null => {
  if (!config || !isRecord(raw)) return config;
  const disableCooling = normalizeBoolean(raw['disable-cooling'] ?? raw.disableCooling);
  if (disableCooling !== undefined) {
    config.disableCooling = disableCooling;
  }
  return config;
};

const buildProviderDeleteQuery = (apiKey: string, baseUrl?: string) => {
  const params = new URLSearchParams();
  params.set('api-key', apiKey.trim());
  params.set('base-url', (baseUrl ?? '').trim());
  return `?${params.toString()}`;
};

const serializeModelAliases = (models?: ModelAlias[], includeOpenAIFields = false) =>
  Array.isArray(models)
    ? models
        .map((model) => {
          if (!model?.name) return null;
          const payload: Record<string, unknown> = { name: model.name };
          if (model.alias && model.alias !== model.name) {
            payload.alias = model.alias;
          }
          if (model.priority !== undefined) {
            payload.priority = model.priority;
          }
          if (model.testModel) {
            payload['test-model'] = model.testModel;
          }
          if (includeOpenAIFields) {
            if (model.image) {
              payload.image = true;
            }
            if (model.thinking) {
              payload.thinking = model.thinking;
            }
          }
          return payload;
        })
        .filter(Boolean)
    : undefined;

const serializeApiKeyEntry = (entry: ApiKeyEntry) => {
  const payload: Record<string, unknown> = { 'api-key': entry.apiKey };
  if (entry.proxyUrl) payload['proxy-url'] = entry.proxyUrl;
  if (entry.authIndex) payload['auth-index'] = entry.authIndex;
  const headers = serializeHeaders(entry.headers);
  if (headers) payload.headers = headers;
  return payload;
};

const serializeProviderKey = (config: ProviderKeyConfig) => {
  const payload: Record<string, unknown> = { 'api-key': config.apiKey };
  if (config.priority !== undefined) payload.priority = config.priority;
  if (config.prefix?.trim()) payload.prefix = config.prefix.trim();
  if (config.baseUrl) payload['base-url'] = config.baseUrl;
  if (config.websockets !== undefined) payload.websockets = config.websockets;
  if (config.proxyUrl) payload['proxy-url'] = config.proxyUrl;
  if (config.disableCooling) payload['disable-cooling'] = true;
  const headers = serializeHeaders(config.headers);
  if (headers) payload.headers = headers;
  const models = serializeModelAliases(config.models);
  if (models && models.length) payload.models = models;
  if (config.excludedModels && config.excludedModels.length) {
    payload['excluded-models'] = config.excludedModels;
  }
  if (config.cloak) {
    const cloakPayload: Record<string, unknown> = {};
    const mode = config.cloak.mode?.trim();
    if (mode) cloakPayload.mode = mode;
    if (config.cloak.strictMode !== undefined) cloakPayload['strict-mode'] = config.cloak.strictMode;
    if (config.cloak.sensitiveWords && config.cloak.sensitiveWords.length) {
      cloakPayload['sensitive-words'] = config.cloak.sensitiveWords;
    }
    if (config.cloak.cacheUserId) {
      cloakPayload['cache-user-id'] = true;
    }
    if (Object.keys(cloakPayload).length) {
      payload.cloak = cloakPayload;
    }
  }
  if (config.experimentalCchSigning) {
    payload['experimental-cch-signing'] = true;
  }
  return payload;
};

const serializeVertexModelAliases = (models?: ModelAlias[]) =>
  Array.isArray(models)
    ? models
        .map((model) => {
          const name = typeof model?.name === 'string' ? model.name.trim() : '';
          const alias = typeof model?.alias === 'string' ? model.alias.trim() : '';
          if (!name || !alias) return null;
          return { name, alias };
        })
        .filter(Boolean)
    : undefined;

const serializeVertexKey = (config: ProviderKeyConfig) => {
  const payload: Record<string, unknown> = { 'api-key': config.apiKey };
  if (config.priority !== undefined) payload.priority = config.priority;
  if (config.prefix?.trim()) payload.prefix = config.prefix.trim();
  if (config.baseUrl) payload['base-url'] = config.baseUrl;
  if (config.proxyUrl) payload['proxy-url'] = config.proxyUrl;
  if (config.disableCooling) payload['disable-cooling'] = true;
  const headers = serializeHeaders(config.headers);
  if (headers) payload.headers = headers;
  const models = serializeVertexModelAliases(config.models);
  if (models && models.length) payload.models = models;
  if (config.excludedModels && config.excludedModels.length) {
    payload['excluded-models'] = config.excludedModels;
  }
  return payload;
};

const serializeGeminiKey = (config: GeminiKeyConfig) => {
  const payload: Record<string, unknown> = { 'api-key': config.apiKey };
  if (config.priority !== undefined) payload.priority = config.priority;
  if (config.prefix?.trim()) payload.prefix = config.prefix.trim();
  if (config.baseUrl) payload['base-url'] = config.baseUrl;
  if (config.proxyUrl) payload['proxy-url'] = config.proxyUrl;
  const headers = serializeHeaders(config.headers);
  if (headers) payload.headers = headers;
  const models = serializeModelAliases(config.models);
  if (models && models.length) payload.models = models;
  if (config.excludedModels && config.excludedModels.length) {
    payload['excluded-models'] = config.excludedModels;
  }
  return payload;
};

const serializeOpenAIProvider = (provider: OpenAIProviderConfig) => {
  const payload: Record<string, unknown> = {
    name: provider.name,
    'base-url': provider.baseUrl,
    'api-key-entries': Array.isArray(provider.apiKeyEntries)
      ? provider.apiKeyEntries.map((entry) => serializeApiKeyEntry(entry))
      : []
  };
  if (provider.prefix?.trim()) payload.prefix = provider.prefix.trim();
  if (provider.disabled !== undefined) payload.disabled = provider.disabled;
  const headers = serializeHeaders(provider.headers);
  if (headers) payload.headers = headers;
  const models = serializeModelAliases(provider.models, true);
  if (models && models.length) payload.models = models;
  if (provider.priority !== undefined) payload.priority = provider.priority;
  if (provider.testModel) payload['test-model'] = provider.testModel;
  if (provider.disableCooling) payload['disable-cooling'] = true;
  return payload;
};

const trimBase = (baseUrl?: string): string => normalizeApiBase(baseUrl ?? '').replace(/\/+$/g, '');

const buildOpenAIModelsEndpoint = (baseUrl?: string): string => {
  const base = trimBase(baseUrl);
  if (!base) return '';
  if (/\/models$/i.test(base)) return base;
  return `${base}/models`;
};

const buildV1ModelsEndpoint = (baseUrl?: string): string => {
  const base = trimBase(baseUrl);
  if (!base) return '';
  if (/\/v1\/models$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
};

const buildClaudeModelsEndpoint = (baseUrl?: string): string => {
  let base = trimBase(baseUrl) || DEFAULT_CLAUDE_BASE_URL;
  base = base.replace(/\/v1\/models$/i, '').replace(/\/v1$/i, '');
  return `${base}/v1/models`;
};

const buildGeminiModelsEndpoint = (baseUrl?: string): string => {
  let base = trimBase(baseUrl) || DEFAULT_GEMINI_BASE_URL;
  base = base.replace(/\/v1beta\/models$/i, '').replace(/\/v1beta$/i, '');
  return `${base}/v1beta/models`;
};

const buildCodexResponsesEndpoint = (baseUrl?: string): string => {
  const base = trimBase(baseUrl);
  if (!base) return '';
  if (/\/v1\/responses$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/responses`;
  return `${base}/v1/responses`;
};

const buildOpenAIChatCompletionsEndpoint = (baseUrl?: string): string => {
  const base = trimBase(baseUrl);
  if (!base) return '';
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
};

const buildClaudeMessagesEndpoint = (baseUrl?: string): string => {
  const base = trimBase(baseUrl) || DEFAULT_CLAUDE_BASE_URL;
  if (/\/v1\/messages$/i.test(base)) return base;
  if (/\/v1$/i.test(base)) return `${base}/messages`;
  return `${base}/v1/messages`;
};

const buildGeminiGenerateContentEndpoint = (baseUrl: string | undefined, model: string): string => {
  const cleanModel = model.replace(/^models\//i, '').trim();
  if (!cleanModel) return '';
  const base = (trimBase(baseUrl) || DEFAULT_GEMINI_BASE_URL)
    .replace(/\/v1beta\/models.*$/i, '')
    .replace(/\/v1beta$/i, '');
  return `${base}/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`;
};

const hasHeader = (headers: Record<string, string>, name: string): boolean => {
  const target = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === target);
};

const withBearerHeader = (
  headers: Record<string, string>,
  apiKey?: string,
  authIndex?: string
): Record<string, string> => {
  const next = { ...headers };
  if (!hasHeader(next, 'authorization')) {
    const key = String(apiKey ?? '').trim();
    const index = String(authIndex ?? '').trim();
    if (key) {
      next.Authorization = `Bearer ${key}`;
    } else if (index) {
      next.Authorization = 'Bearer $TOKEN$';
    }
  }
  return next;
};

const withApiKeyHeader = (
  headers: Record<string, string>,
  name: string,
  apiKey?: string,
  authIndex?: string
): Record<string, string> => {
  const next = { ...headers };
  if (!hasHeader(next, name)) {
    const key = String(apiKey ?? '').trim();
    const index = String(authIndex ?? '').trim();
    if (key) {
      next[name] = key;
    } else if (index) {
      next[name] = '$TOKEN$';
    }
  }
  return next;
};

const runApiCall = async (
  payload: {
    method: string;
    url: string;
    header?: Record<string, string>;
    data?: string;
    authIndex?: string;
  }
) => {
  const result = await apiCallApi.request(payload, { timeout: DEFAULT_TIMEOUT_MS });
  if (result.statusCode < 200 || result.statusCode >= 300) {
    throw new Error(getApiCallErrorMessage(result));
  }
  return result;
};

export const providersApi = {
  async getGeminiKeys(): Promise<GeminiKeyConfig[]> {
    const data = await apiClient.get('/gemini-api-key');
    const list = extractArrayPayload(data, 'gemini-api-key');
    return list
      .map((item) => applyProviderExtras(item, normalizeGeminiKeyConfig(item)))
      .filter(Boolean) as GeminiKeyConfig[];
  },

  saveGeminiKeys: (configs: GeminiKeyConfig[]) =>
    apiClient.put('/gemini-api-key', configs.map((item) => serializeGeminiKey(item))),

  updateGeminiKey: (index: number, value: GeminiKeyConfig) =>
    apiClient.patch('/gemini-api-key', { index, value: serializeGeminiKey(value) }),

  deleteGeminiKey: (apiKey: string, baseUrl?: string) =>
    apiClient.delete(`/gemini-api-key${buildProviderDeleteQuery(apiKey, baseUrl)}`),

  async getCodexConfigs(): Promise<ProviderKeyConfig[]> {
    const data = await apiClient.get('/codex-api-key');
    const list = extractArrayPayload(data, 'codex-api-key');
    return list
      .map((item) => applyProviderExtras(item, normalizeProviderKeyConfig(item)))
      .filter(Boolean) as ProviderKeyConfig[];
  },

  saveCodexConfigs: (configs: ProviderKeyConfig[]) =>
    apiClient.put('/codex-api-key', configs.map((item) => serializeProviderKey(item))),

  updateCodexConfig: (index: number, value: ProviderKeyConfig) =>
    apiClient.patch('/codex-api-key', { index, value: serializeProviderKey(value) }),

  deleteCodexConfig: (apiKey: string, baseUrl?: string) =>
    apiClient.delete(`/codex-api-key${buildProviderDeleteQuery(apiKey, baseUrl)}`),

  async getClaudeConfigs(): Promise<ProviderKeyConfig[]> {
    const data = await apiClient.get('/claude-api-key');
    const list = extractArrayPayload(data, 'claude-api-key');
    return list
      .map((item) => applyProviderExtras(item, normalizeProviderKeyConfig(item)))
      .filter(Boolean) as ProviderKeyConfig[];
  },

  saveClaudeConfigs: (configs: ProviderKeyConfig[]) =>
    apiClient.put('/claude-api-key', configs.map((item) => serializeProviderKey(item))),

  updateClaudeConfig: (index: number, value: ProviderKeyConfig) =>
    apiClient.patch('/claude-api-key', { index, value: serializeProviderKey(value) }),

  deleteClaudeConfig: (apiKey: string, baseUrl?: string) =>
    apiClient.delete(`/claude-api-key${buildProviderDeleteQuery(apiKey, baseUrl)}`),

  async getVertexConfigs(): Promise<ProviderKeyConfig[]> {
    const data = await apiClient.get('/vertex-api-key');
    const list = extractArrayPayload(data, 'vertex-api-key');
    return list.map((item) => normalizeProviderKeyConfig(item)).filter(Boolean) as ProviderKeyConfig[];
  },

  saveVertexConfigs: (configs: ProviderKeyConfig[]) =>
    apiClient.put('/vertex-api-key', configs.map((item) => serializeVertexKey(item))),

  updateVertexConfig: (index: number, value: ProviderKeyConfig) =>
    apiClient.patch('/vertex-api-key', { index, value: serializeVertexKey(value) }),

  deleteVertexConfig: (apiKey: string, baseUrl?: string) =>
    apiClient.delete(`/vertex-api-key${buildProviderDeleteQuery(apiKey, baseUrl)}`),

  async getOpenAIProviders(): Promise<OpenAIProviderConfig[]> {
    const data = await apiClient.get('/openai-compatibility');
    const list = extractArrayPayload(data, 'openai-compatibility');
    return list
      .map((item) => applyProviderExtras(item, normalizeOpenAIProvider(item)))
      .filter(Boolean) as OpenAIProviderConfig[];
  },

  saveOpenAIProviders: (providers: OpenAIProviderConfig[]) =>
    apiClient.put('/openai-compatibility', providers.map((item) => serializeOpenAIProvider(item))),

  updateOpenAIProvider: (index: number, value: OpenAIProviderConfig) =>
    apiClient.patch('/openai-compatibility', { index, value: serializeOpenAIProvider(value) }),

  updateOpenAIProviderDisabled: (index: number, disabled: boolean) =>
    apiClient.patch('/openai-compatibility', { index, value: { disabled } }),

  deleteOpenAIProvider: (name: string) =>
    apiClient.delete(`/openai-compatibility?name=${encodeURIComponent(name)}`),

  async discoverModels(request: ProviderModelDiscoveryRequest): Promise<ModelInfo[]> {
    const headers = request.headers ?? {};
    const authIndex = request.authIndex?.trim() || undefined;
    let endpoint = '';
    let resolvedHeaders: Record<string, string> = {};

    if (request.brand === 'gemini') {
      endpoint = buildGeminiModelsEndpoint(request.baseUrl);
      resolvedHeaders = withApiKeyHeader(headers, 'x-goog-api-key', request.apiKey, authIndex);
    } else if (request.brand === 'codex') {
      endpoint = buildV1ModelsEndpoint(request.baseUrl);
      resolvedHeaders = withBearerHeader(headers, request.apiKey, authIndex);
    } else if (request.brand === 'claude') {
      endpoint = buildClaudeModelsEndpoint(request.baseUrl);
      resolvedHeaders = withApiKeyHeader(headers, 'x-api-key', request.apiKey, authIndex);
      if (!hasHeader(resolvedHeaders, 'anthropic-version')) {
        resolvedHeaders['anthropic-version'] = DEFAULT_ANTHROPIC_VERSION;
      }
    } else if (request.brand === 'openaiCompatibility') {
      endpoint = buildOpenAIModelsEndpoint(request.baseUrl);
      resolvedHeaders = withBearerHeader(headers, request.apiKey, authIndex);
    } else {
      throw new Error('Model discovery is not supported for this provider');
    }

    if (!endpoint) {
      throw new Error('Base URL is required for model discovery');
    }

    const result = await runApiCall({
      authIndex,
      method: 'GET',
      url: endpoint,
      header: Object.keys(resolvedHeaders).length ? resolvedHeaders : undefined,
    });

    return normalizeModelList(result.body ?? result.bodyText, { dedupe: true });
  },

  async testConnectivity(request: ProviderConnectivityRequest): Promise<void> {
    const headers = { 'Content-Type': 'application/json', ...(request.headers ?? {}) };
    const authIndex = request.authIndex?.trim() || undefined;
    const model = request.model.trim();
    if (!model) {
      throw new Error('A test model is required');
    }

    if (request.brand === 'codex') {
      const endpoint = buildCodexResponsesEndpoint(request.baseUrl);
      if (!endpoint) throw new Error('Codex Base URL is required');
      await runApiCall({
        authIndex,
        method: 'POST',
        url: endpoint,
        header: withBearerHeader(headers, request.apiKey, authIndex),
        data: JSON.stringify({ model, input: 'Hi', stream: false }),
      });
      return;
    }

    if (request.brand === 'openaiCompatibility') {
      const endpoint = buildOpenAIChatCompletionsEndpoint(request.baseUrl);
      if (!endpoint) throw new Error('OpenAI-compatible Base URL is required');
      await runApiCall({
        authIndex,
        method: 'POST',
        url: endpoint,
        header: withBearerHeader(headers, request.apiKey, authIndex),
        data: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Hi' }],
          stream: false,
          max_tokens: 5,
        }),
      });
      return;
    }

    if (request.brand === 'gemini') {
      const endpoint = buildGeminiGenerateContentEndpoint(request.baseUrl, model);
      if (!endpoint) throw new Error('Gemini model endpoint is required');
      await runApiCall({
        authIndex,
        method: 'POST',
        url: endpoint,
        header: withApiKeyHeader(headers, 'x-goog-api-key', request.apiKey, authIndex),
        data: JSON.stringify({
          contents: [{ parts: [{ text: 'Hi' }] }],
          generationConfig: { maxOutputTokens: 8 },
        }),
      });
      return;
    }

    if (request.brand === 'claude') {
      const endpoint = buildClaudeMessagesEndpoint(request.baseUrl);
      if (!endpoint) throw new Error('Claude endpoint is required');
      const resolvedHeaders = withApiKeyHeader(headers, 'x-api-key', request.apiKey, authIndex);
      if (!hasHeader(resolvedHeaders, 'anthropic-version')) {
        resolvedHeaders['anthropic-version'] = DEFAULT_ANTHROPIC_VERSION;
      }
      await runApiCall({
        authIndex,
        method: 'POST',
        url: endpoint,
        header: resolvedHeaders,
        data: JSON.stringify({
          model,
          max_tokens: 8,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
      });
      return;
    }

    throw new Error('Connectivity test is not supported for this provider');
  }
};
