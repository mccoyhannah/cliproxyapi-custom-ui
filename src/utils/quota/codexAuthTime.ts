import type { AuthFileItem } from '@/types';
import { normalizeNumberValue, parseIdTokenPayload } from './parsers';

export type CodexAuthTimeSource =
  | 'id_token_auth_time'
  | 'id_token_iat'
  | 'access_token_iat'
  | 'file_modified';

export type CodexAuthTimeStatus = 'found' | 'fallback' | 'missing';

export type CodexAuthTimeSnapshot = {
  authenticatedAt: string | null;
  authenticatedAtShort: string | null;
  authenticatedAtMs: number | null;
  authTimeSource: CodexAuthTimeSource | null;
  authTimeStatus: CodexAuthTimeStatus;
};

export const EMPTY_CODEX_AUTH_TIME_SNAPSHOT: CodexAuthTimeSnapshot = {
  authenticatedAt: null,
  authenticatedAtShort: null,
  authenticatedAtMs: null,
  authTimeSource: null,
  authTimeStatus: 'missing',
};

const TOKEN_CONTAINERS = ['metadata', 'attributes'] as const;
const ID_TOKEN_KEYS = ['id_token', 'idToken'] as const;
const ACCESS_TOKEN_KEYS = ['access_token', 'accessToken'] as const;
const FILE_MODIFIED_KEYS = ['modtime', 'modified', 'updated_at', 'last_refresh', 'lastRefresh'] as const;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const hasMeaningfulValue = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim().length > 0 : value != null;

const readTokenValue = (
  record: Record<string, unknown> | null,
  keys: readonly string[]
): unknown => {
  if (!record) return undefined;

  for (const key of keys) {
    if (hasMeaningfulValue(record[key])) return record[key];
  }

  for (const container of TOKEN_CONTAINERS) {
    const nested = toRecord(record[container]);
    for (const key of keys) {
      if (hasMeaningfulValue(nested?.[key])) return nested?.[key];
    }
  }

  return undefined;
};

const normalizeTimestampMs = (value: unknown): number | null => {
  const numeric = normalizeNumberValue(value);
  if (numeric !== null) {
    if (numeric <= 0) return null;
    return numeric > 1e12 ? numeric : numeric * 1000;
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = new Date(trimmed).getTime();
  return Number.isNaN(parsed) ? null : parsed;
};

const formatAuthTime = (valueMs: number): string =>
  new Date(valueMs).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

export const formatCodexAuthTimeShortDate = (valueMs: number | null | undefined): string => {
  if (valueMs === null || valueMs === undefined || !Number.isFinite(valueMs)) return '';
  return new Date(valueMs).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

const buildAuthTimeSnapshot = (
  valueMs: number,
  source: CodexAuthTimeSource
): CodexAuthTimeSnapshot => ({
  authenticatedAt: formatAuthTime(valueMs),
  authenticatedAtShort: formatCodexAuthTimeShortDate(valueMs),
  authenticatedAtMs: valueMs,
  authTimeSource: source,
  authTimeStatus: source === 'file_modified' ? 'fallback' : 'found',
});

const readFirstModifiedMs = (...records: Array<Record<string, unknown> | null>): number | null => {
  for (const record of records) {
    if (!record) continue;
    for (const key of FILE_MODIFIED_KEYS) {
      const valueMs = normalizeTimestampMs(record[key]);
      if (valueMs !== null) return valueMs;
    }
  }
  return null;
};

export const readCodexAuthTimeSnapshotFromRecord = (
  input: unknown,
  fallbackFile?: AuthFileItem | null
): CodexAuthTimeSnapshot => {
  const record = toRecord(input);
  const fallbackRecord = fallbackFile ? (fallbackFile as Record<string, unknown>) : null;
  const idTokenPayload = parseIdTokenPayload(readTokenValue(record, ID_TOKEN_KEYS));
  const accessTokenPayload = parseIdTokenPayload(readTokenValue(record, ACCESS_TOKEN_KEYS));

  const idTokenAuthTimeMs = normalizeTimestampMs(
    idTokenPayload?.auth_time ?? idTokenPayload?.authTime
  );
  if (idTokenAuthTimeMs !== null) {
    return buildAuthTimeSnapshot(idTokenAuthTimeMs, 'id_token_auth_time');
  }

  const idTokenIssuedAtMs = normalizeTimestampMs(idTokenPayload?.iat);
  if (idTokenIssuedAtMs !== null) {
    return buildAuthTimeSnapshot(idTokenIssuedAtMs, 'id_token_iat');
  }

  const accessTokenIssuedAtMs = normalizeTimestampMs(accessTokenPayload?.iat);
  if (accessTokenIssuedAtMs !== null) {
    return buildAuthTimeSnapshot(accessTokenIssuedAtMs, 'access_token_iat');
  }

  const modifiedMs = readFirstModifiedMs(record, fallbackRecord);
  if (modifiedMs !== null) {
    return buildAuthTimeSnapshot(modifiedMs, 'file_modified');
  }

  return EMPTY_CODEX_AUTH_TIME_SNAPSHOT;
};
