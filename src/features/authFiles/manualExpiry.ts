export type AuthFilesManualExpiryMap = Record<string, number>;

export type ManualExpiryRenderInfo = {
  expiresAtMs: number;
  label: string;
  title: string;
};

const STORAGE_KEY = 'authFilesPage.manualExpiry.v1';
const BOOTSTRAP_KEY = 'authFilesPage.manualExpiry.bootstrapped.v1';

const DEFAULT_MANUAL_EXPIRIES: AuthFilesManualExpiryMap = {};

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

const normalizeManualExpiryMap = (value: unknown): AuthFilesManualExpiryMap => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.entries(value as Record<string, unknown>).reduce<AuthFilesManualExpiryMap>(
    (result, [name, expiresAtMs]) => {
      const normalizedName = String(name ?? '').trim();
      if (!normalizedName || !isFiniteTimestamp(expiresAtMs)) return result;
      result[normalizedName] = Math.round(expiresAtMs);
      return result;
    },
    {}
  );
};

const readJsonMap = (storage: Pick<Storage, 'getItem'>): AuthFilesManualExpiryMap => {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return {};
  return normalizeManualExpiryMap(JSON.parse(raw));
};

export const readAuthFilesManualExpiry = (): AuthFilesManualExpiryMap => {
  if (typeof window === 'undefined') return {};
  try {
    return readJsonMap(window.localStorage);
  } catch {
    return {};
  }
};

export const writeAuthFilesManualExpiry = (map: AuthFilesManualExpiryMap) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeManualExpiryMap(map)));
  } catch {
    // ignore
  }
};

export const bootstrapAuthFilesManualExpiry = (): AuthFilesManualExpiryMap => {
  if (typeof window === 'undefined') return {};

  try {
    const current = readJsonMap(window.localStorage);
    if (window.localStorage.getItem(BOOTSTRAP_KEY) === 'true') {
      return current;
    }

    const next = { ...DEFAULT_MANUAL_EXPIRIES, ...current };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    window.localStorage.setItem(BOOTSTRAP_KEY, 'true');
    return next;
  } catch {
    return {};
  }
};

export const getManualExpiryMs = (
  map: AuthFilesManualExpiryMap,
  name: string
): number | null => {
  const value = map[name];
  return isFiniteTimestamp(value) ? value : null;
};

export const getDefaultManualExpiryMs = (): number => {
  const now = new Date();
  return new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    now.getDate(),
    now.getHours(),
    now.getMinutes(),
    0,
    0
  ).getTime();
};

export const formatManualExpiryShortDate = (expiresAtMs: number): string =>
  new Date(expiresAtMs).toLocaleString(undefined, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

export const formatManualExpiryFullDate = (expiresAtMs: number): string =>
  new Date(expiresAtMs).toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

export const buildManualExpiryRenderInfo = (
  expiresAtMs: number | null | undefined
): ManualExpiryRenderInfo | null => {
  if (!isFiniteTimestamp(expiresAtMs)) return null;
  return {
    expiresAtMs,
    label: formatManualExpiryShortDate(expiresAtMs),
    title: formatManualExpiryFullDate(expiresAtMs),
  };
};

export const formatDateInputValue = (expiresAtMs: number): string => {
  const date = new Date(expiresAtMs);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export const formatTimeInputValue = (expiresAtMs: number): string => {
  const date = new Date(expiresAtMs);
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${hours}:${minutes}`;
};

export const parseManualExpiryInput = (dateValue: string, timeValue: string): number | null => {
  const normalizedDate = dateValue.trim();
  const normalizedTime = timeValue.trim() || '00:00';
  if (!normalizedDate) return null;

  const parsed = new Date(`${normalizedDate}T${normalizedTime}`).getTime();
  return isFiniteTimestamp(parsed) ? parsed : null;
};
