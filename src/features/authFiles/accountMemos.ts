import type { CodexAuthTimeSnapshot, CodexAuthTimeSource } from '@/utils/quota';

export type AuthFileAccountMemoImage = {
  id: string;
  name: string;
  mimeType: string;
  dataUrl: string;
  size: number;
  width: number;
  height: number;
  createdAt: number;
};

export type AuthFileAccountMemoAuthTimeHistoryEntry = {
  authenticatedAt: string;
  authenticatedAtShort: string;
  authenticatedAtMs: number;
  authTimeSource: Exclude<CodexAuthTimeSource, 'file_modified'>;
  authTimeStatus: 'found';
  recordedAt: number;
};

export type AuthFileAccountMemo = {
  text: string;
  images: AuthFileAccountMemoImage[];
  updatedAt: number;
  authTimeHistory: AuthFileAccountMemoAuthTimeHistoryEntry[];
};

export type AuthFilesAccountMemoMap = Record<string, AuthFileAccountMemo>;

const STORAGE_KEY = 'authFilesPage.accountMemos.v1';
export const AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES = 3;
export const AUTH_FILE_ACCOUNT_MEMO_MAX_AUTH_TIME_HISTORY = 20;

const AUTH_FILE_ACCOUNT_MEMO_AUTH_TIME_SOURCES = new Set<
  AuthFileAccountMemoAuthTimeHistoryEntry['authTimeSource']
>(['id_token_auth_time', 'id_token_iat', 'access_token_iat']);

const normalizePositiveInteger = (value: unknown): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return Math.round(value);
};

const formatMemoAuthTime = (valueMs: number): string =>
  new Date(valueMs).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

const formatMemoAuthTimeShort = (valueMs: number): string =>
  new Date(valueMs).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

const normalizeMemoImage = (value: unknown): AuthFileAccountMemoImage | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : '';
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType : '';
  if (!dataUrl.startsWith('data:image/') || !mimeType.startsWith('image/')) return null;

  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `${Date.now()}`;
  const name =
    typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'account-memo.png';
  const size =
    typeof record.size === 'number' && Number.isFinite(record.size) && record.size > 0
      ? Math.round(record.size)
      : 0;
  const width =
    typeof record.width === 'number' && Number.isFinite(record.width) && record.width > 0
      ? Math.round(record.width)
      : 0;
  const height =
    typeof record.height === 'number' && Number.isFinite(record.height) && record.height > 0
      ? Math.round(record.height)
      : 0;
  const createdAt =
    typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) && record.createdAt > 0
      ? Math.round(record.createdAt)
      : 0;

  return { id, name, mimeType, dataUrl, size, width, height, createdAt };
};

const normalizeMemoAuthTimeHistoryEntry = (
  value: unknown
): AuthFileAccountMemoAuthTimeHistoryEntry | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const authenticatedAtMs = normalizePositiveInteger(record.authenticatedAtMs);
  if (authenticatedAtMs === null) return null;

  const authTimeSource =
    typeof record.authTimeSource === 'string' &&
    AUTH_FILE_ACCOUNT_MEMO_AUTH_TIME_SOURCES.has(
      record.authTimeSource as AuthFileAccountMemoAuthTimeHistoryEntry['authTimeSource']
    )
      ? (record.authTimeSource as AuthFileAccountMemoAuthTimeHistoryEntry['authTimeSource'])
      : null;
  if (!authTimeSource) return null;

  if (record.authTimeStatus !== 'found') return null;

  const authenticatedAt =
    typeof record.authenticatedAt === 'string' && record.authenticatedAt.trim()
      ? record.authenticatedAt.trim()
      : formatMemoAuthTime(authenticatedAtMs);
  const authenticatedAtShort =
    typeof record.authenticatedAtShort === 'string' && record.authenticatedAtShort.trim()
      ? record.authenticatedAtShort.trim()
      : formatMemoAuthTimeShort(authenticatedAtMs);
  const recordedAt = normalizePositiveInteger(record.recordedAt) ?? authenticatedAtMs;

  return {
    authenticatedAt,
    authenticatedAtShort,
    authenticatedAtMs,
    authTimeSource,
    authTimeStatus: 'found',
    recordedAt,
  };
};

const normalizeMemoAuthTimeHistory = (
  value: unknown
): AuthFileAccountMemoAuthTimeHistoryEntry[] => {
  if (!Array.isArray(value)) return [];

  const byAuthenticatedAt = new Map<number, AuthFileAccountMemoAuthTimeHistoryEntry>();
  value.forEach((entry) => {
    const normalized = normalizeMemoAuthTimeHistoryEntry(entry);
    if (!normalized) return;
    const existing = byAuthenticatedAt.get(normalized.authenticatedAtMs);
    if (!existing || normalized.recordedAt > existing.recordedAt) {
      byAuthenticatedAt.set(normalized.authenticatedAtMs, normalized);
    }
  });

  return Array.from(byAuthenticatedAt.values())
    .sort((a, b) => b.authenticatedAtMs - a.authenticatedAtMs)
    .slice(0, AUTH_FILE_ACCOUNT_MEMO_MAX_AUTH_TIME_HISTORY);
};

const normalizeMemoEntry = (value: unknown): AuthFileAccountMemo | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  const images = Array.isArray(record.images)
    ? record.images
        .map(normalizeMemoImage)
        .filter((image): image is AuthFileAccountMemoImage => Boolean(image))
        .slice(0, AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES)
    : [];
  const authTimeHistory = normalizeMemoAuthTimeHistory(record.authTimeHistory);
  if (!text && images.length === 0 && authTimeHistory.length === 0) return null;

  const updatedAt =
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) && record.updatedAt > 0
      ? Math.round(record.updatedAt)
      : 0;

  return { text, images, updatedAt, authTimeHistory };
};

const normalizeMemoMap = (value: unknown): AuthFilesAccountMemoMap => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.entries(value as Record<string, unknown>).reduce<AuthFilesAccountMemoMap>(
    (result, [name, memo]) => {
      const normalizedName = String(name ?? '').trim();
      if (!normalizedName) return result;

      const normalizedMemo = normalizeMemoEntry(memo);
      if (!normalizedMemo) return result;

      result[normalizedName] = normalizedMemo;
      return result;
    },
    {}
  );
};

export const readAuthFilesAccountMemos = (): AuthFilesAccountMemoMap => {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    return normalizeMemoMap(JSON.parse(raw));
  } catch {
    return {};
  }
};

export const writeAuthFilesAccountMemos = (map: AuthFilesAccountMemoMap): boolean => {
  if (typeof window === 'undefined') return false;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeMemoMap(map)));
    return true;
  } catch {
    return false;
  }
};

export const getAuthFileAccountMemo = (
  map: AuthFilesAccountMemoMap,
  name: string
): AuthFileAccountMemo | null => {
  const memo = map[name];
  return memo ? normalizeMemoEntry(memo) : null;
};

const buildAuthTimeHistoryEntry = (
  snapshot: CodexAuthTimeSnapshot,
  recordedAt = Date.now()
): AuthFileAccountMemoAuthTimeHistoryEntry | null => {
  const authenticatedAtMs = normalizePositiveInteger(snapshot.authenticatedAtMs);
  if (authenticatedAtMs === null) return null;
  if (snapshot.authTimeStatus !== 'found') return null;
  if (
    !snapshot.authTimeSource ||
    !AUTH_FILE_ACCOUNT_MEMO_AUTH_TIME_SOURCES.has(
      snapshot.authTimeSource as AuthFileAccountMemoAuthTimeHistoryEntry['authTimeSource']
    )
  ) {
    return null;
  }

  return {
    authenticatedAt: snapshot.authenticatedAt ?? formatMemoAuthTime(authenticatedAtMs),
    authenticatedAtShort: snapshot.authenticatedAtShort ?? formatMemoAuthTimeShort(authenticatedAtMs),
    authenticatedAtMs,
    authTimeSource: snapshot.authTimeSource as AuthFileAccountMemoAuthTimeHistoryEntry['authTimeSource'],
    authTimeStatus: 'found',
    recordedAt: normalizePositiveInteger(recordedAt) ?? Date.now(),
  };
};

export const upsertAuthFileAccountMemoAuthTime = (
  map: AuthFilesAccountMemoMap,
  name: string,
  snapshot: CodexAuthTimeSnapshot,
  recordedAt = Date.now()
): { changed: boolean; map: AuthFilesAccountMemoMap } => {
  const normalizedName = String(name ?? '').trim();
  if (!normalizedName) return { changed: false, map };

  const nextEntry = buildAuthTimeHistoryEntry(snapshot, recordedAt);
  if (!nextEntry) return { changed: false, map };

  const currentMemo = getAuthFileAccountMemo(map, normalizedName) ?? {
    text: '',
    images: [],
    updatedAt: nextEntry.recordedAt,
    authTimeHistory: [],
  };
  if (
    currentMemo.authTimeHistory.some(
      (entry) => entry.authenticatedAtMs === nextEntry.authenticatedAtMs
    )
  ) {
    return { changed: false, map };
  }

  return {
    changed: true,
    map: {
      ...map,
      [normalizedName]: {
        ...currentMemo,
        authTimeHistory: normalizeMemoAuthTimeHistory([nextEntry, ...currentMemo.authTimeHistory]),
      },
    },
  };
};
