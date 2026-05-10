import type { CodexSubscriptionStatus } from '@/types';
import { parseIdTokenPayload } from './parsers';

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';
const CODEX_SUBSCRIPTION_ACTIVE_UNTIL_KEYS = [
  'chatgpt_subscription_active_until',
  'chatgptSubscriptionActiveUntil',
  'subscription_active_until',
  'subscriptionActiveUntil',
  'active_until',
  'activeUntil',
] as const;
const CODEX_SUBSCRIPTION_LAST_CHECKED_KEYS = [
  'chatgpt_subscription_last_checked',
  'chatgptSubscriptionLastChecked',
  'subscription_last_checked',
  'subscriptionLastChecked',
  'last_checked',
  'lastChecked',
] as const;

export type CodexSubscriptionSnapshot = {
  subscriptionActiveUntil: string | null;
  subscriptionActiveUntilMs: number | null;
  subscriptionLastChecked: string | null;
  subscriptionStatus: CodexSubscriptionStatus;
  subscriptionStatusMessage: string | null;
};

export const EMPTY_CODEX_SUBSCRIPTION_SNAPSHOT: CodexSubscriptionSnapshot = {
  subscriptionActiveUntil: null,
  subscriptionActiveUntilMs: null,
  subscriptionLastChecked: null,
  subscriptionStatus: 'missing',
  subscriptionStatusMessage: null,
};

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const formatDateValue = (value: unknown): string | null => {
  if (value === undefined || value === null || typeof value === 'boolean') return null;

  let date: Date | null = null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const milliseconds = value > 1e12 ? value : value * 1000;
    date = new Date(milliseconds);
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(trimmed)) {
      const milliseconds = numeric > 1e12 ? numeric : numeric * 1000;
      date = new Date(milliseconds);
    } else {
      date = new Date(trimmed);
      if (Number.isNaN(date.getTime())) return trimmed;
    }
  }

  if (!date || Number.isNaN(date.getTime())) return null;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

const parseDateMilliseconds = (value: unknown): number | null => {
  if (value === undefined || value === null || typeof value === 'boolean') return null;

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric) && /^\d+(\.\d+)?$/.test(trimmed)) {
    return numeric > 1e12 ? numeric : numeric * 1000;
  }

  const parsed = new Date(trimmed).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

const readFirstDateMeta = (
  record: Record<string, unknown> | null,
  keys: readonly string[]
): { label: string | null; ms: number | null } => {
  if (!record) return { label: null, ms: null };
  for (const key of keys) {
    const label = formatDateValue(record[key]);
    if (!label) continue;
    return { label, ms: parseDateMilliseconds(record[key]) };
  }
  return { label: null, ms: null };
};

export const readCodexSubscriptionSnapshotFromRecord = (
  input: unknown
): CodexSubscriptionSnapshot | null => {
  const record = toRecord(input);
  if (!record) return null;
  const metadata = toRecord(record.metadata);
  const attributes = toRecord(record.attributes);
  const candidates = [
    record.id_token,
    record.idToken,
    record['id_token'],
    metadata?.id_token,
    metadata?.idToken,
    attributes?.id_token,
    attributes?.idToken,
  ];
  let foundTokenPayload = false;
  let fallbackLastChecked: string | null = null;

  for (const candidate of candidates) {
    const payload = parseIdTokenPayload(candidate);
    if (!payload) continue;
    foundTokenPayload = true;
    const openAiAuth = toRecord(payload[OPENAI_AUTH_CLAIM]);
    const source = openAiAuth ?? payload;
    const activeUntil = readFirstDateMeta(source, CODEX_SUBSCRIPTION_ACTIVE_UNTIL_KEYS);
    const lastChecked = readFirstDateMeta(source, CODEX_SUBSCRIPTION_LAST_CHECKED_KEYS);
    fallbackLastChecked ??= lastChecked.label;
    if (!activeUntil.label) continue;

    return {
      subscriptionActiveUntil: activeUntil.label,
      subscriptionActiveUntilMs: activeUntil.ms,
      subscriptionLastChecked: lastChecked.label,
      subscriptionStatus: 'found',
      subscriptionStatusMessage: null,
    };
  }

  return foundTokenPayload
    ? {
        ...EMPTY_CODEX_SUBSCRIPTION_SNAPSHOT,
        subscriptionLastChecked: fallbackLastChecked,
      }
    : null;
};
