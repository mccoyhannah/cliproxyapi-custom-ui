import type { TFunction } from 'i18next';
import iconAntigravity from '@/assets/icons/antigravity.svg';
import iconClaude from '@/assets/icons/claude.svg';
import iconCodex from '@/assets/icons/codex.svg';
import iconGemini from '@/assets/icons/gemini.svg';
import iconIflow from '@/assets/icons/iflow.svg';
import iconKimiDark from '@/assets/icons/kimi-dark.svg';
import iconKimiLight from '@/assets/icons/kimi-light.svg';
import iconQwen from '@/assets/icons/qwen.svg';
import iconVertex from '@/assets/icons/vertex.svg';
import type { AuthFileItem } from '@/types';
import { parseTimestamp } from '@/utils/timestamp';

export type ThemeColors = { bg: string; text: string; border?: string };
export type TypeColorSet = { light: ThemeColors; dark?: ThemeColors };
export type ResolvedTheme = 'light' | 'dark';
export type AuthFileModelItem = {
  id: string;
  display_name?: string;
  type?: string;
  owned_by?: string;
};
export type AuthFileIconAsset = string | { light: string; dark: string };

export type QuotaProviderType = 'antigravity' | 'claude' | 'codex' | 'gemini-cli' | 'kimi';

export const QUOTA_PROVIDER_TYPES = new Set<QuotaProviderType>([
  'antigravity',
  'claude',
  'codex',
  'gemini-cli',
  'kimi',
]);

export const MIN_CARD_PAGE_SIZE = 3;
export const MAX_CARD_PAGE_SIZE = 30;
export const AUTH_FILE_REFRESH_WARNING_MS = 24 * 60 * 60 * 1000;

export const INTEGER_STRING_PATTERN = /^[+-]?\d+$/;
export const TRUTHY_TEXT_VALUES = new Set(['true', '1', 'yes', 'y', 'on']);
export const FALSY_TEXT_VALUES = new Set(['false', '0', 'no', 'n', 'off']);

// 标签类型颜色配置 — 基于各提供商 Logo 品牌色调配，确保彼此不重复
export const TYPE_COLORS: Record<string, TypeColorSet> = {
  // Qwen logo: 紫罗兰渐变 #6336E7 → #6F69F7
  qwen: {
    light: { bg: '#ede5fd', text: '#5530c7' },
    dark: { bg: '#36208a', text: '#b5a3f0' },
  },
  // Kimi logo: 亮蓝 #027AFF（K字 + 蓝色圆点）
  kimi: {
    light: { bg: '#dce8ff', text: '#0560cf' },
    dark: { bg: '#003880', text: '#70b5ff' },
  },
  // Gemini logo: 多色蓝 #3186FF（偏柔和的蓝）
  gemini: {
    light: { bg: '#e3f2fd', text: '#1565c0' },
    dark: { bg: '#0d47a1', text: '#64b5f6' },
  },
  // Gemini-CLI: 同 Gemini 图标，用更深的海军蓝区分
  'gemini-cli': {
    light: { bg: '#e0e8ff', text: '#1e4fa3' },
    dark: { bg: '#1c3f73', text: '#a8c7ff' },
  },
  // AI Studio: 使用 Gemini 图标，中性灰标签
  aistudio: {
    light: { bg: '#f0f2f5', text: '#2f343c' },
    dark: { bg: '#373c42', text: '#cfd3db' },
  },
  // Claude logo: 陶土橙 #D97757
  claude: {
    light: { bg: '#fbece4', text: '#c05621' },
    dark: { bg: '#5e2c14', text: '#e8a882' },
  },
  // Codex logo: 靛蓝渐变 #B1A7FF → #3941FF
  codex: {
    light: { bg: '#eae7ff', text: '#3538d4' },
    dark: { bg: '#262395', text: '#b5b0ff' },
  },
  // Antigravity logo: 多色（主色 #3789F9 蓝 + #53A89A 青绿），用青色区分
  antigravity: {
    light: { bg: '#e0f7fa', text: '#006064' },
    dark: { bg: '#004d40', text: '#80deea' },
  },
  // iFlow logo: 品红紫渐变 #5C5CFF → #AE5CFF，偏品红以区别于 Qwen 的紫罗兰
  iflow: {
    light: { bg: '#f5e3fc', text: '#9025c8' },
    dark: { bg: '#521490', text: '#d49cf5' },
  },
  // Vertex logo: Google 蓝 #4285F4
  vertex: {
    light: { bg: '#e4edfd', text: '#2b5fbc' },
    dark: { bg: '#1a3d80', text: '#89b3f7' },
  },
  empty: {
    light: { bg: '#f5f5f5', text: '#616161' },
    dark: { bg: '#424242', text: '#bdbdbd' },
  },
  unknown: {
    light: { bg: '#f0f0f0', text: '#666666', border: '1px dashed #999999' },
    dark: { bg: '#3a3a3a', text: '#aaaaaa', border: '1px dashed #666666' },
  },
};

export const AUTH_FILE_ICONS: Record<string, AuthFileIconAsset> = {
  antigravity: iconAntigravity,
  aistudio: iconGemini,
  claude: iconClaude,
  codex: iconCodex,
  gemini: iconGemini,
  'gemini-cli': iconGemini,
  iflow: iconIflow,
  kimi: { light: iconKimiLight, dark: iconKimiDark },
  qwen: iconQwen,
  vertex: iconVertex,
};

export const clampCardPageSize = (value: number) =>
  Math.min(MAX_CARD_PAGE_SIZE, Math.max(MIN_CARD_PAGE_SIZE, Math.round(value)));

export const resolveQuotaErrorMessage = (
  t: TFunction,
  status: number | undefined,
  fallback: string
): string => {
  if (status === 404) return t('common.quota_update_required');
  if (status === 403) return t('common.quota_check_credential');
  return fallback;
};

export const normalizeProviderKey = (value: string) => value.trim().toLowerCase();

export type AuthFileCredentialProblem = {
  message: string;
  rawMessage: string;
  signals: string[];
};

export type AuthFileStatusCategory =
  | 'credential_invalid'
  | 'local_proxy_unavailable'
  | 'connection_transient'
  | 'request_interrupted'
  | 'input_too_large'
  | 'content_policy'
  | 'rate_limited'
  | 'upstream_service_error';

export type AuthFileStatusProblem = AuthFileCredentialProblem & {
  category: AuthFileStatusCategory;
};

const AUTH_FILE_CREDENTIAL_STATUS_PATTERN =
  /\b(?:401|403|invalid_grant|invalid_token|invalid(?:ated)?\s+(?:oauth\s+)?token|oauth\s+token\s+invalidated|token\s+(?:is\s+)?(?:invalid|expired))\b/i;
const AUTH_FILE_LOCAL_PROXY_UNAVAILABLE_STATUS_PATTERN =
  /\b(?:local_proxy_unavailable|proxyconnect|connectex|target\s+machine\s+actively\s+refused|127\.0\.0\.1:\d+[^\n]*(?:refused|connectex|proxyconnect)|localhost:\d+[^\n]*(?:refused|connectex|proxyconnect))\b/i;
const AUTH_FILE_CONNECTION_TRANSIENT_STATUS_PATTERN =
  /\b(?:connection_transient|network_transient|unexpected\s+EOF|EOF|ECONNRESET|ETIMEDOUT|socket\s+hang\s+up|fetch\s+failed|wsarecv[^\n]*(?:forcibly\s+closed|reset)|forcibly\s+closed\s+by\s+the\s+remote\s+host)\b/i;
const AUTH_FILE_REQUEST_INTERRUPTED_STATUS_PATTERN =
  /\b(?:request_interrupted|context\s+cancell?ed|context\s+deadline\s+exceeded|stream\s+error:?[^\n]*(?:internal_error|received\s+from\s+peer)|internal_error;\s*received\s+from\s+peer)\b/i;
const AUTH_FILE_INPUT_TOO_LARGE_STATUS_PATTERN =
  /\b(?:context_too_large|context\s+window|input\s+too\s+large|exceeds?\s+(?:the\s+)?context)\b/i;
const AUTH_FILE_CONTENT_POLICY_STATUS_PATTERN =
  /\b(?:content[_\s-]?conceal(?:ed)?|content_filter|content_policy|safety)\b/i;
const AUTH_FILE_RATE_LIMITED_STATUS_PATTERN =
  /\b(?:429|rate[_\s-]?limit(?:ed)?|too[_\s-]?many[_\s-]?requests|insufficient[_\s-]?quota|quota[_\s-]?exceeded)\b/i;
const AUTH_FILE_UPSTREAM_SERVICE_ERROR_STATUS_PATTERN =
  /\b(?:upstream_service_error|status[:\s]+5\d\d|http[:\s]+5\d\d|server\s+error|service\s+unavailable|bad\s+gateway|gateway\s+timeout|\b5\d\d\b)\b/i;
const AUTH_FILE_STATUS_PARSE_DEPTH = 5;
const AUTH_FILE_STATUS_MESSAGE_KEYS = [
  'detail',
  'message',
  'error',
  'error_description',
  'code',
  'type',
  'status',
] as const;

const getRawAuthFileStatusMessage = (file: AuthFileItem): string => {
  const raw = file['status_message'] ?? file.statusMessage;
  if (typeof raw === 'string') return raw.trim();
  if (raw == null) return '';
  return String(raw).trim();
};

const tryParseStatusJson = (text: string): unknown => {
  const trimmed = text.trim();
  if (!trimmed || !/^[{["]/.test(trimmed)) return undefined;

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
};

const pushUniqueStatusPart = (parts: string[], value: unknown) => {
  const text = String(value ?? '').trim();
  if (!text || parts.includes(text)) return;
  parts.push(text);
};

const collectAuthFileStatusParts = (
  value: unknown,
  parts: string[],
  depth = 0
) => {
  if (depth > AUTH_FILE_STATUS_PARSE_DEPTH || value == null) return;

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return;

    const parsed = tryParseStatusJson(trimmed);
    if (parsed !== undefined) {
      collectAuthFileStatusParts(parsed, parts, depth + 1);
      return;
    }

    pushUniqueStatusPart(parts, trimmed);
    return;
  }

  if (typeof value !== 'object') {
    pushUniqueStatusPart(parts, value);
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectAuthFileStatusParts(item, parts, depth + 1));
    return;
  }

  const record = value as Record<string, unknown>;
  AUTH_FILE_STATUS_MESSAGE_KEYS.forEach((key) => {
    if (key in record) {
      collectAuthFileStatusParts(record[key], parts, depth + 1);
    }
  });

  Object.entries(record).forEach(([key, item]) => {
    if ((AUTH_FILE_STATUS_MESSAGE_KEYS as readonly string[]).includes(key)) return;
    collectAuthFileStatusParts(item, parts, depth + 1);
  });
};

export const getAuthFileStatusMessageParts = (file: AuthFileItem): string[] => {
  const raw = getRawAuthFileStatusMessage(file);
  const parts: string[] = [];
  collectAuthFileStatusParts(raw, parts);
  return parts;
};

export const getAuthFileStatusMessage = (file: AuthFileItem): string => {
  const parts = getAuthFileStatusMessageParts(file);
  return parts[0] ?? getRawAuthFileStatusMessage(file);
};

const AUTH_FILE_STATUS_PATTERNS: Array<{
  category: AuthFileStatusCategory;
  pattern: RegExp;
  signalOnlyPattern: RegExp;
}> = [
  {
    category: 'input_too_large',
    pattern: AUTH_FILE_INPUT_TOO_LARGE_STATUS_PATTERN,
    signalOnlyPattern: AUTH_FILE_INPUT_TOO_LARGE_STATUS_PATTERN,
  },
  {
    category: 'content_policy',
    pattern: AUTH_FILE_CONTENT_POLICY_STATUS_PATTERN,
    signalOnlyPattern: AUTH_FILE_CONTENT_POLICY_STATUS_PATTERN,
  },
  {
    category: 'request_interrupted',
    pattern: AUTH_FILE_REQUEST_INTERRUPTED_STATUS_PATTERN,
    signalOnlyPattern: AUTH_FILE_REQUEST_INTERRUPTED_STATUS_PATTERN,
  },
  {
    category: 'local_proxy_unavailable',
    pattern: AUTH_FILE_LOCAL_PROXY_UNAVAILABLE_STATUS_PATTERN,
    signalOnlyPattern: AUTH_FILE_LOCAL_PROXY_UNAVAILABLE_STATUS_PATTERN,
  },
  {
    category: 'connection_transient',
    pattern: AUTH_FILE_CONNECTION_TRANSIENT_STATUS_PATTERN,
    signalOnlyPattern: AUTH_FILE_CONNECTION_TRANSIENT_STATUS_PATTERN,
  },
  {
    category: 'rate_limited',
    pattern: AUTH_FILE_RATE_LIMITED_STATUS_PATTERN,
    signalOnlyPattern: AUTH_FILE_RATE_LIMITED_STATUS_PATTERN,
  },
  {
    category: 'credential_invalid',
    pattern: AUTH_FILE_CREDENTIAL_STATUS_PATTERN,
    signalOnlyPattern: /^(401|403|invalid_grant|invalid_token|authentication_error|auth_unavailable)$/i,
  },
  {
    category: 'upstream_service_error',
    pattern: AUTH_FILE_UPSTREAM_SERVICE_ERROR_STATUS_PATTERN,
    signalOnlyPattern: AUTH_FILE_UPSTREAM_SERVICE_ERROR_STATUS_PATTERN,
  },
];

export const getAuthFileStatusProblemFromText = (
  text: string,
  parts: string[] = []
): AuthFileStatusProblem | null => {
  const rawMessage = text.trim();
  if (!rawMessage && parts.length === 0) return null;

  const haystack = [rawMessage, ...parts].join(' ');
  const matched = AUTH_FILE_STATUS_PATTERNS.find(({ pattern }) => pattern.test(haystack));
  if (!matched) return null;

  const signals = parts.filter((part) => matched.pattern.test(part));
  const message =
    parts.find((part) => !matched.signalOnlyPattern.test(part)) ?? signals[0] ?? rawMessage;

  return {
    category: matched.category,
    message,
    rawMessage,
    signals,
  };
};

export const getAuthFileStatusProblem = (file: AuthFileItem): AuthFileStatusProblem | null => {
  const rawMessage = getRawAuthFileStatusMessage(file);
  if (!rawMessage) return null;

  const parts = getAuthFileStatusMessageParts(file);
  return getAuthFileStatusProblemFromText(rawMessage, parts);
};

export const getAuthFileCredentialProblem = (
  file: AuthFileItem
): AuthFileCredentialProblem | null => {
  const problem = getAuthFileStatusProblem(file);
  if (problem?.category !== 'credential_invalid') return null;
  return {
    message: problem.message,
    rawMessage: problem.rawMessage,
    signals: problem.signals,
  };
};

export const hasAuthFileStatusMessage = (file: AuthFileItem): boolean =>
  getAuthFileStatusMessage(file).length > 0;

export const getTypeLabel = (t: TFunction, type: string): string => {
  const key = `auth_files.filter_${type}`;
  const translated = t(key);
  if (translated !== key) return translated;
  if (type.toLowerCase() === 'iflow') return 'iFlow';
  return type.charAt(0).toUpperCase() + type.slice(1);
};

export const getTypeColor = (type: string, resolvedTheme: ResolvedTheme): ThemeColors => {
  const set = TYPE_COLORS[type] || TYPE_COLORS.unknown;
  return resolvedTheme === 'dark' && set.dark ? set.dark : set.light;
};

export const getAuthFileIcon = (type: string, resolvedTheme: ResolvedTheme): string | null => {
  const iconEntry = AUTH_FILE_ICONS[normalizeProviderKey(type)];
  if (!iconEntry) return null;
  return typeof iconEntry === 'string'
    ? iconEntry
    : resolvedTheme === 'dark'
      ? iconEntry.dark
      : iconEntry.light;
};

export const parsePriorityValue = (value: unknown): number | undefined => {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }

  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || !INTEGER_STRING_PATTERN.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export const normalizeExcludedModels = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];

  const seen = new Set<string>();
  const normalized: string[] = [];
  value.forEach((entry) => {
    const model = String(entry ?? '')
      .trim()
      .toLowerCase();
    if (!model || seen.has(model)) return;
    seen.add(model);
    normalized.push(model);
  });

  return normalized.sort((a, b) => a.localeCompare(b));
};

export const parseExcludedModelsText = (value: string): string[] =>
  normalizeExcludedModels(value.split(/[\n,]+/));

export const parseDisableCoolingValue = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (TRUTHY_TEXT_VALUES.has(normalized)) return true;
  if (FALSY_TEXT_VALUES.has(normalized)) return false;
  return undefined;
};

export const readCodexAuthFileWebsockets = (value: Record<string, unknown>): boolean =>
  parseDisableCoolingValue(value.websockets) ?? false;

export const applyCodexAuthFileWebsockets = (
  value: Record<string, unknown>,
  websockets: boolean
): Record<string, unknown> => {
  const next = { ...value };
  delete next.websocket;
  next.websockets = websockets;
  return next;
};

export function isRuntimeOnlyAuthFile(file: AuthFileItem): boolean {
  const raw = file['runtime_only'] ?? file.runtimeOnly;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

export const formatModified = (item: AuthFileItem): string => {
  const raw = item['modtime'] ?? item.modified;
  if (!raw) return '-';
  const asNumber = Number(raw);
  const date =
    Number.isFinite(asNumber) && !Number.isNaN(asNumber)
      ? new Date(asNumber < 1e12 ? asNumber * 1000 : asNumber)
      : parseTimestamp(raw) ?? new Date(String(raw));
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
};

// 检查模型是否被 OAuth 排除
export const isModelExcluded = (
  modelId: string,
  providerType: string,
  excluded: Record<string, string[]>
): boolean => {
  const providerKey = normalizeProviderKey(providerType);
  const excludedModels = excluded[providerKey] || excluded[providerType] || [];
  return excludedModels.some((pattern) => {
    if (pattern.includes('*')) {
      // 支持通配符匹配：先转义正则特殊字符，再将 * 视为通配符
      const regexSafePattern = pattern
        .split('*')
        .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*');
      const regex = new RegExp(`^${regexSafePattern}$`, 'i');
      return regex.test(modelId);
    }
    return pattern.toLowerCase() === modelId.toLowerCase();
  });
};
