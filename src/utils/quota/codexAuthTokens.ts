import { normalizeNumberValue, parseIdTokenPayload } from './parsers';

type SnapshotOptions = {
  assumeComplete?: boolean;
};

export type CodexAuthTokenSnapshot = {
  hasRefreshToken: boolean | null;
  hasAccessToken: boolean;
  accessTokenExpiresAt: string | null;
  accessTokenExpiresAtMs: number | null;
  accessTokenStatus: 'found' | 'missing' | 'invalid' | 'unknown';
};

export const EMPTY_CODEX_AUTH_TOKEN_SNAPSHOT: CodexAuthTokenSnapshot = {
  hasRefreshToken: null,
  hasAccessToken: false,
  accessTokenExpiresAt: null,
  accessTokenExpiresAtMs: null,
  accessTokenStatus: 'unknown',
};

const TOKEN_CONTAINERS = ['metadata', 'attributes'] as const;
const REFRESH_TOKEN_KEYS = ['refresh_token', 'refreshToken'] as const;
const ACCESS_TOKEN_KEYS = ['access_token', 'accessToken'] as const;

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const hasMeaningfulTokenValue = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim().length > 0 : value != null;

const readTokenValue = (
  record: Record<string, unknown> | null,
  keys: readonly string[]
): unknown => {
  if (!record) return undefined;

  for (const key of keys) {
    if (hasMeaningfulTokenValue(record[key])) {
      return record[key];
    }
  }

  for (const container of TOKEN_CONTAINERS) {
    const nested = toRecord(record[container]);
    for (const key of keys) {
      if (hasMeaningfulTokenValue(nested?.[key])) {
        return nested?.[key];
      }
    }
  }

  return undefined;
};

const formatAccessTokenExpiry = (valueMs: number): string =>
  new Date(valueMs).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

export const formatAccessTokenExpiryIso = (valueMs: number): string =>
  new Date(valueMs).toISOString();

export const readCodexAuthTokenSnapshotFromRecord = (
  input: unknown,
  options: SnapshotOptions = {}
): CodexAuthTokenSnapshot => {
  const record = toRecord(input);
  if (!record) return EMPTY_CODEX_AUTH_TOKEN_SNAPSHOT;

  const refreshToken = readTokenValue(record, REFRESH_TOKEN_KEYS);
  const accessToken = readTokenValue(record, ACCESS_TOKEN_KEYS);
  const hasRefreshToken = hasMeaningfulTokenValue(refreshToken)
    ? true
    : options.assumeComplete
      ? false
      : null;

  if (!hasMeaningfulTokenValue(accessToken)) {
    return {
      hasRefreshToken,
      hasAccessToken: false,
      accessTokenExpiresAt: null,
      accessTokenExpiresAtMs: null,
      accessTokenStatus: options.assumeComplete ? 'missing' : 'unknown',
    };
  }

  const accessTokenPayload = parseIdTokenPayload(accessToken);
  const exp = normalizeNumberValue(accessTokenPayload?.exp);
  if (exp === null) {
    return {
      hasRefreshToken,
      hasAccessToken: true,
      accessTokenExpiresAt: null,
      accessTokenExpiresAtMs: null,
      accessTokenStatus: 'invalid',
    };
  }

  const accessTokenExpiresAtMs = exp > 1e12 ? exp : exp * 1000;
  return {
    hasRefreshToken,
    hasAccessToken: true,
    accessTokenExpiresAt: formatAccessTokenExpiry(accessTokenExpiresAtMs),
    accessTokenExpiresAtMs,
    accessTokenStatus: 'found',
  };
};
