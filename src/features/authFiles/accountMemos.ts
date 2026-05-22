export type AuthFileAccountMemo = {
  text: string;
  updatedAt: number;
};

export type AuthFilesAccountMemoMap = Record<string, AuthFileAccountMemo>;

const STORAGE_KEY = 'authFilesPage.accountMemos.v1';

const normalizeMemoEntry = (value: unknown): AuthFileAccountMemo | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const text = typeof record.text === 'string' ? record.text.trim() : '';
  if (!text) return null;

  const updatedAt =
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) && record.updatedAt > 0
      ? Math.round(record.updatedAt)
      : 0;

  return { text, updatedAt };
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

export const writeAuthFilesAccountMemos = (map: AuthFilesAccountMemoMap) => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeMemoMap(map)));
  } catch {
    // ignore
  }
};

export const getAuthFileAccountMemo = (
  map: AuthFilesAccountMemoMap,
  name: string
): AuthFileAccountMemo | null => {
  const memo = map[name];
  return memo ? normalizeMemoEntry(memo) : null;
};
