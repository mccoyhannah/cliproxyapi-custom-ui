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

export type AuthFileAccountMemo = {
  text: string;
  images: AuthFileAccountMemoImage[];
  updatedAt: number;
};

export type AuthFilesAccountMemoMap = Record<string, AuthFileAccountMemo>;

const STORAGE_KEY = 'authFilesPage.accountMemos.v1';
export const AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES = 3;

const normalizeMemoImage = (value: unknown): AuthFileAccountMemoImage | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const dataUrl = typeof record.dataUrl === 'string' ? record.dataUrl : '';
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType : '';
  if (!dataUrl.startsWith('data:image/') || !mimeType.startsWith('image/')) return null;

  const id = typeof record.id === 'string' && record.id.trim() ? record.id.trim() : `${Date.now()}`;
  const name =
    typeof record.name === 'string' && record.name.trim() ? record.name.trim() : 'account-memo.webp';
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
  if (!text && images.length === 0) return null;

  const updatedAt =
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) && record.updatedAt > 0
      ? Math.round(record.updatedAt)
      : 0;

  return { text, images, updatedAt };
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
