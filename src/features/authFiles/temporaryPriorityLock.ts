const STORAGE_KEY = 'authFilesPage.temporaryPriorityLock.v1';

export type AuthFilesTemporaryPriorityLockSnapshot = {
  version: 1;
  createdAt: number;
  targetPriority: number;
  priorities: Record<string, number>;
};

const isSafePriority = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const normalizePriorities = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.entries(value as Record<string, unknown>).reduce<Record<string, number>>(
    (result, [name, priority]) => {
      const normalizedName = String(name ?? '').trim();
      if (!normalizedName) return result;

      if (isSafePriority(priority)) {
        result[normalizedName] = priority;
        return result;
      }

      if (typeof priority === 'string') {
        const parsed = Number.parseInt(priority.trim(), 10);
        if (isSafePriority(parsed)) {
          result[normalizedName] = parsed;
        }
      }

      return result;
    },
    {}
  );
};

const normalizeSnapshot = (value: unknown): AuthFilesTemporaryPriorityLockSnapshot | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  const priorities = normalizePriorities(record.priorities);
  if (Object.keys(priorities).length === 0) return null;

  return {
    version: 1,
    createdAt: isSafePriority(record.createdAt) ? record.createdAt : Date.now(),
    targetPriority: isSafePriority(record.targetPriority) ? record.targetPriority : 3,
    priorities,
  };
};

export const readAuthFilesTemporaryPriorityLock =
  (): AuthFilesTemporaryPriorityLockSnapshot | null => {
    if (typeof window === 'undefined') return null;

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      return normalizeSnapshot(JSON.parse(raw));
    } catch {
      return null;
    }
  };

export const writeAuthFilesTemporaryPriorityLock = (
  snapshot: AuthFilesTemporaryPriorityLockSnapshot
) => {
  if (typeof window === 'undefined') return;

  try {
    const normalized = normalizeSnapshot(snapshot);
    if (!normalized) {
      window.localStorage.removeItem(STORAGE_KEY);
      return;
    }
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  } catch {
    // ignore
  }
};

export const clearAuthFilesTemporaryPriorityLock = () => {
  if (typeof window === 'undefined') return;

  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
};
