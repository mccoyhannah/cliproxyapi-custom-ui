import type { AuthFileItem } from '@/types';
import { parseIdTokenPayload } from '@/utils/quota';

export type AuthFileDisplayNameLookup = {
  strongKeys: string[];
  fallbackKeys: string[];
};

type AuthFileDisplayNameMemoryEntry = {
  version: 1;
  note: string;
  cleared: boolean;
  updatedAt: number;
  keys: string[];
};

type AuthFileDisplayNameMemoryMap = Record<string, AuthFileDisplayNameMemoryEntry>;

const STORAGE_KEY = 'authFilesPage.displayNameMemory.v1';
const MAX_STORED_KEYS = 900;
const EMPTY_LOOKUP: AuthFileDisplayNameLookup = { strongKeys: [], fallbackKeys: [] };

const IDENTITY_FIELD_GROUPS: Array<{ kind: string; fields: string[] }> = [
  {
    kind: 'chatgpt-account',
    fields: ['chatgpt_account_id', 'chatgptAccountId'],
  },
  {
    kind: 'account-id',
    fields: ['account_id', 'accountId', 'user_id', 'userId', 'sub'],
  },
  {
    kind: 'email',
    fields: [
      'email',
      'client_email',
      'clientEmail',
      'account_email',
      'accountEmail',
      'login_email',
      'loginEmail',
      'username',
      'login',
    ],
  },
  {
    kind: 'project',
    fields: ['project_id', 'projectId', 'quota_project_id', 'quotaProjectId'],
  },
  {
    kind: 'account',
    fields: ['account', 'account_name', 'accountName'],
  },
];

const TOKEN_PAYLOAD_FIELDS = ['id_token', 'idToken', 'access_token', 'accessToken'] as const;
const NESTED_RECORD_FIELDS = ['metadata', 'attributes', 'profile', 'user'] as const;
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const normalizeText = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
};

const normalizeKeyPart = (value: unknown): string | null => {
  const text = normalizeText(value);
  return text ? text.toLowerCase().replace(/\s+/g, ' ') : null;
};

const addUnique = (items: string[], value: string | null | undefined) => {
  if (!value || items.includes(value)) return;
  items.push(value);
};

const collectCandidateRecords = (source: unknown): Record<string, unknown>[] => {
  const root = toRecord(source);
  if (!root) return [];

  const records: Record<string, unknown>[] = [root];
  NESTED_RECORD_FIELDS.forEach((field) => {
    const nested = toRecord(root[field]);
    if (nested) records.push(nested);
  });

  [...records].forEach((record) => {
    TOKEN_PAYLOAD_FIELDS.forEach((field) => {
      const payload = parseIdTokenPayload(record[field]);
      if (!payload) return;
      records.push(payload);
      const openAiAuth = toRecord(payload[OPENAI_AUTH_CLAIM]);
      if (openAiAuth) records.push(openAiAuth);
    });
  });

  return records;
};

const resolveProvider = (records: Record<string, unknown>[]): string => {
  for (const record of records) {
    const provider =
      normalizeKeyPart(record.provider) ??
      normalizeKeyPart(record.type) ??
      normalizeKeyPart(record.service);
    if (provider) return provider;
  }
  return 'auth';
};

const buildStrongKey = (provider: string, kind: string, value: unknown): string | null => {
  const normalized = normalizeKeyPart(value);
  return normalized ? `${provider}:${kind}:${normalized}` : null;
};

const normalizeMemoryEntry = (value: unknown): AuthFileDisplayNameMemoryEntry | null => {
  const record = toRecord(value);
  if (!record) return null;

  const note = typeof record.note === 'string' ? record.note.trim() : '';
  const cleared = record.cleared === true || note.length === 0;
  const updatedAt =
    typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt)
      ? Math.max(0, Math.round(record.updatedAt))
      : 0;
  const keys = Array.isArray(record.keys)
    ? record.keys.map((key) => normalizeKeyPart(key)).filter((key): key is string => Boolean(key))
    : [];

  return {
    version: 1,
    note,
    cleared,
    updatedAt,
    keys,
  };
};

const readMemory = (): AuthFileDisplayNameMemoryMap => {
  if (typeof window === 'undefined') return {};

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    const record = toRecord(parsed);
    if (!record) return {};

    return Object.entries(record).reduce<AuthFileDisplayNameMemoryMap>((result, [key, entry]) => {
      const normalizedKey = normalizeKeyPart(key);
      const normalizedEntry = normalizeMemoryEntry(entry);
      if (!normalizedKey || !normalizedEntry) return result;
      result[normalizedKey] = normalizedEntry;
      return result;
    }, {});
  } catch {
    return {};
  }
};

const pruneMemory = (memory: AuthFileDisplayNameMemoryMap): AuthFileDisplayNameMemoryMap => {
  const entries = Object.entries(memory);
  if (entries.length <= MAX_STORED_KEYS) return memory;

  return entries
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_STORED_KEYS)
    .reduce<AuthFileDisplayNameMemoryMap>((result, [key, entry]) => {
      result[key] = entry;
      return result;
    }, {});
};

const writeMemory = (memory: AuthFileDisplayNameMemoryMap): boolean => {
  if (typeof window === 'undefined') return false;

  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(pruneMemory(memory)));
    return true;
  } catch {
    return false;
  }
};

export const buildAuthFileDisplayNameLookup = (
  source: unknown,
  fileName?: string
): AuthFileDisplayNameLookup => {
  const records = collectCandidateRecords(source);
  if (records.length === 0 && !fileName) return EMPTY_LOOKUP;

  const provider = resolveProvider(records);
  const strongKeys: string[] = [];
  records.forEach((record) => {
    IDENTITY_FIELD_GROUPS.forEach((group) => {
      group.fields.forEach((field) => {
        addUnique(strongKeys, buildStrongKey(provider, group.kind, record[field]));
      });
    });
  });

  const sourceName = normalizeText(toRecord(source)?.name);
  const fallbackName = normalizeKeyPart(fileName ?? sourceName);
  const fallbackKeys = fallbackName ? [`file:${fallbackName}`] : [];

  return { strongKeys, fallbackKeys };
};

export const mergeAuthFileDisplayNameLookups = (
  ...lookups: Array<AuthFileDisplayNameLookup | null | undefined>
): AuthFileDisplayNameLookup => {
  const strongKeys: string[] = [];
  const fallbackKeys: string[] = [];
  lookups.forEach((lookup) => {
    lookup?.strongKeys.forEach((key) => addUnique(strongKeys, normalizeKeyPart(key)));
    lookup?.fallbackKeys.forEach((key) => addUnique(fallbackKeys, normalizeKeyPart(key)));
  });
  return { strongKeys, fallbackKeys };
};

const selectStorageKeys = (lookup: AuthFileDisplayNameLookup, note: string): string[] =>
  note.length === 0
    ? [...lookup.strongKeys, ...lookup.fallbackKeys]
    : lookup.strongKeys.length > 0
      ? lookup.strongKeys
      : lookup.fallbackKeys;

const findLatestMemoryEntry = (
  memory: AuthFileDisplayNameMemoryMap,
  keys: string[]
): AuthFileDisplayNameMemoryEntry | null =>
  keys
    .map((key) => memory[key])
    .filter((entry): entry is AuthFileDisplayNameMemoryEntry => Boolean(entry))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;

export const rememberAuthFileDisplayName = (
  file: AuthFileItem,
  noteOverride?: string,
  lookupOverride?: AuthFileDisplayNameLookup
): boolean => {
  const lookup = mergeAuthFileDisplayNameLookups(
    lookupOverride,
    buildAuthFileDisplayNameLookup(file, file.name)
  );
  const note = (noteOverride ?? (typeof file.note === 'string' ? file.note : '')).trim();
  const keys = selectStorageKeys(lookup, note);
  if (keys.length === 0) return false;
  const entry: AuthFileDisplayNameMemoryEntry = {
    version: 1,
    note,
    cleared: note.length === 0,
    updatedAt: Date.now(),
    keys,
  };
  const memory = readMemory();
  keys.forEach((key) => {
    memory[key] = entry;
  });
  return writeMemory(memory);
};

export const rememberAuthFileDisplayNames = (files: AuthFileItem[]): void => {
  files.forEach((file) => {
    const note = typeof file.note === 'string' ? file.note.trim() : '';
    if (note) {
      rememberAuthFileDisplayName(file, note);
    }
  });
};

export const getRememberedAuthFileDisplayName = (
  file: AuthFileItem,
  uploadLookup?: AuthFileDisplayNameLookup
): string | null => {
  const lookup = mergeAuthFileDisplayNameLookups(
    uploadLookup,
    buildAuthFileDisplayNameLookup(file, file.name)
  );
  const candidateKeys = lookup.strongKeys.length > 0 ? lookup.strongKeys : lookup.fallbackKeys;
  if (candidateKeys.length === 0) return null;

  const memory = readMemory();
  const latest = findLatestMemoryEntry(memory, candidateKeys);

  if (!latest || latest.cleared) return null;
  const note = latest.note.trim();
  return note ? note : null;
};
