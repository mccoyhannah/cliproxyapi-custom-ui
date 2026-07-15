import type { AuthFileStatusCategory } from '@/features/authFiles/statusClassification';
import type { StatusBlockDetail } from '@/utils/recentRequests';

export const STATUS_FAILURE_HISTORY_STORAGE_KEY = 'authFilesPage.statusFailureHistory.v1';
export const STATUS_FAILURE_HISTORY_TTL_MS = 3 * 60 * 60 * 1000;
export const STATUS_FAILURE_CAPTURE_MAX_AGE_MS = 10 * 60 * 1000;

const STATUS_FAILURE_HISTORY_VERSION = 1 as const;
const STATUS_FAILURE_CATEGORIES = new Set<AuthFileStatusCategory>([
  'credential_invalid',
  'account_model_restricted',
  'upstream_access_blocked',
  'local_proxy_unavailable',
  'dns_resolution_failed',
  'tls_certificate_error',
  'oauth_flow_failure',
  'connection_transient',
  'request_interrupted',
  'input_too_large',
  'content_policy',
  'rate_limited',
  'invalid_request',
  'upstream_service_error',
  'unknown_upstream_error',
]);
const STATUS_FAILURE_CATEGORY_FALLBACK: Record<AuthFileStatusCategory, string> = {
  credential_invalid: 'credential invalid',
  account_model_restricted: 'model unavailable',
  upstream_access_blocked: 'access blocked',
  local_proxy_unavailable: 'local proxy unavailable',
  dns_resolution_failed: 'DNS failed',
  tls_certificate_error: 'TLS error',
  oauth_flow_failure: 'OAuth failed',
  connection_transient: 'connection interrupted',
  request_interrupted: 'request interrupted',
  input_too_large: 'input too large',
  content_policy: 'content policy',
  rate_limited: 'rate limited',
  invalid_request: 'invalid request',
  upstream_service_error: 'upstream service error',
  unknown_upstream_error: '',
};

export type StatusFailureHistorySource = 'browser' | 'observer';

export type StatusFailureHistoryDetail = {
  category: AuthFileStatusCategory;
  message: string;
  observedAt: number;
  expiresAt: number;
  source?: StatusFailureHistorySource;
};

export type StatusFailureHistoryBucket = {
  startTime: number;
  endTime: number;
  details: Partial<Record<AuthFileStatusCategory, StatusFailureHistoryDetail>>;
};

export type StatusFailureActiveEpisode = {
  fingerprint: string | null;
  bucketStartTime: number;
  observedAt: number;
  expiresAt: number;
};

export type StatusFailureHistoryStore = {
  version: typeof STATUS_FAILURE_HISTORY_VERSION;
  files: Record<string, Record<string, StatusFailureHistoryBucket>>;
  active: Record<string, StatusFailureActiveEpisode>;
};

export type StatusFailureHistoryStorage = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

type FailureBlock = Pick<StatusBlockDetail, 'success' | 'failure' | 'startTime' | 'endTime'>;

type RecordStatusFailureInput = {
  fileName: string;
  bucket: Pick<StatusBlockDetail, 'startTime' | 'endTime'>;
  category: AuthFileStatusCategory;
  message: string;
  observedAt: number;
  source?: StatusFailureHistorySource;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const toFiniteTimestamp = (value: unknown): number | null => {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) ? timestamp : null;
};

const normalizeCategory = (value: unknown): AuthFileStatusCategory | null =>
  typeof value === 'string' && STATUS_FAILURE_CATEGORIES.has(value as AuthFileStatusCategory)
    ? (value as AuthFileStatusCategory)
    : null;

const normalizeStatusFailureSource = (value: unknown): StatusFailureHistorySource =>
  value === 'observer' ? 'observer' : 'browser';

const getStatusFailureSourcePriority = (source: unknown): number =>
  normalizeStatusFailureSource(source) === 'observer' ? 1 : 0;

const bucketKeyFromStartTime = (startTime: number): string => String(Math.trunc(startTime));

export const normalizeStatusFailureFileKey = (fileName: string): string =>
  fileName.trim().toLowerCase();

const redactSensitiveStatusText = (message: string): string =>
  message
    .replace(/\b(?:cookie|set[_-]?cookie|authorization)\s*:\s*[^\r\n]*/gi, '')
    .replace(
      /["']?[A-Za-z0-9_-]*(?:api[_-]?key|auth|token|cookie|session|credential|password|secret)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?(?:(?:Bearer|Basic)\s+)?[^"'\s,}]+/gi,
      ''
    )
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '')
    .replace(
      /([?&])(?:key|api[_-]?key|access[_-]?token|refresh[_-]?token|token|session(?:[_-]?(?:id|token))?|cookie)=[^&\s]+/gi,
      '$1'
    )
    .replace(/\b([a-z][a-z0-9+.-]*):\/\/[^/\s:@]+:[^/\s@]+@/gi, '$1://[已隐藏]@')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[已隐藏邮箱]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已隐藏]');

export const simplifyStatusFailureMessage = (
  category: AuthFileStatusCategory | null,
  message: string
): string => {
  const normalized = redactSensitiveStatusText(message)
    .replace(/<[^>]*>/g, ' ')
    .replace(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+"[^"]+"\s*:\s*/gi, '')
    .replace(/upstream connect error or disconnect\/reset before headers\.?\s*/i, '')
    .replace(/transport failure reason:\s*/i, '')
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[-,;:\s]+|[-,;:\s]+$/g, '')
    .trim();

  if (!category || category === 'unknown_upstream_error') return '';
  if (category === 'connection_transient' && /\b(?:unexpected\s+)?EOF\b/i.test(normalized)) {
    return /unexpected\s+EOF/i.test(normalized) ? 'unexpected EOF' : 'EOF';
  }
  if (
    category === 'connection_transient' &&
    /connection\s+(?:was\s+)?reset|ECONNRESET|forcibly\s+closed/i.test(normalized)
  ) {
    return 'connection reset';
  }
  if (
    category === 'connection_transient' &&
    /timed?\s*out|ETIMEDOUT|connection\s+timeout/i.test(normalized)
  ) {
    return 'connection timeout';
  }
  if (category === 'local_proxy_unavailable' && /connection\s+refused/i.test(normalized)) {
    return 'Connection refused';
  }
  if (category === 'request_interrupted' && /context\s+cancell?ed/i.test(normalized)) {
    return /context\s+cancelled/i.test(normalized) ? 'context cancelled' : 'context canceled';
  }
  if (category === 'request_interrupted' && /deadline\s+exceeded/i.test(normalized)) {
    return 'deadline exceeded';
  }

  const explicitStatusCode = normalized.match(
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?|status(?:\s+code)?|code)\s*[:=]?\s*([45]\d{2})\b/i
  )?.[1];
  const leadingStatusCode = normalized.match(/^([45]\d{2})\b/)?.[1];
  const statusCode = explicitStatusCode ?? leadingStatusCode;
  if (statusCode) return `HTTP ${statusCode}`;

  return STATUS_FAILURE_CATEGORY_FALLBACK[category];
};

const rebuildStatusFailureFingerprint = (
  value: unknown,
  sourceOverride?: StatusFailureHistorySource
): string | null => {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 1024) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || (parsed.length !== 2 && parsed.length !== 3)) return null;
    const [rawSource, rawCategory, rawMessage] =
      parsed.length === 3 ? parsed : ['browser', parsed[0], parsed[1]];
    const category = normalizeCategory(rawCategory);
    if (!category || typeof rawMessage !== 'string') return null;
    const source = sourceOverride ?? normalizeStatusFailureSource(rawSource);
    const message = simplifyStatusFailureMessage(category, rawMessage);
    return JSON.stringify([source, category, message]);
  } catch {
    return null;
  }
};

export const createEmptyStatusFailureHistory = (): StatusFailureHistoryStore => ({
  version: STATUS_FAILURE_HISTORY_VERSION,
  files: {},
  active: {},
});

const normalizeStatusFailureHistory = (
  value: unknown,
  now: number,
  sourceOverride?: StatusFailureHistorySource
): StatusFailureHistoryStore => {
  if (
    !isRecord(value) ||
    value.version !== STATUS_FAILURE_HISTORY_VERSION ||
    !isRecord(value.files)
  ) {
    return createEmptyStatusFailureHistory();
  }

  const files: StatusFailureHistoryStore['files'] = {};
  Object.entries(value.files).forEach(([rawFileKey, rawBuckets]) => {
    if (!isRecord(rawBuckets)) return;
    const fileKey = normalizeStatusFailureFileKey(rawFileKey);
    if (!fileKey) return;

    const buckets: Record<string, StatusFailureHistoryBucket> = {};
    Object.values(rawBuckets).forEach((rawBucket) => {
      if (!isRecord(rawBucket) || !isRecord(rawBucket.details)) return;
      const startTime = toFiniteTimestamp(rawBucket.startTime);
      const endTime = toFiniteTimestamp(rawBucket.endTime);
      if (startTime === null || endTime === null || endTime <= startTime) return;

      const details: StatusFailureHistoryBucket['details'] = {};
      Object.entries(rawBucket.details).forEach(([rawCategory, rawDetail]) => {
        const category = normalizeCategory(rawCategory);
        if (!category || !isRecord(rawDetail)) return;
        const observedAt = toFiniteTimestamp(rawDetail.observedAt);
        const expiresAt = toFiniteTimestamp(rawDetail.expiresAt);
        if (
          observedAt === null ||
          expiresAt === null ||
          observedAt > now + STATUS_FAILURE_CAPTURE_MAX_AGE_MS
        ) {
          return;
        }
        const boundedExpiresAt = Math.min(expiresAt, observedAt + STATUS_FAILURE_HISTORY_TTL_MS);
        if (boundedExpiresAt <= observedAt || boundedExpiresAt <= now) return;
        const message = simplifyStatusFailureMessage(
          category,
          typeof rawDetail.message === 'string' ? rawDetail.message : ''
        );
        details[category] = {
          category,
          message,
          observedAt,
          expiresAt: boundedExpiresAt,
          source: sourceOverride ?? normalizeStatusFailureSource(rawDetail.source),
        };
      });

      if (Object.keys(details).length === 0) return;
      buckets[bucketKeyFromStartTime(startTime)] = { startTime, endTime, details };
    });

    if (Object.keys(buckets).length > 0) files[fileKey] = buckets;
  });

  const active: StatusFailureHistoryStore['active'] = {};
  if (isRecord(value.active)) {
    Object.entries(value.active).forEach(([rawFileKey, rawEpisode]) => {
      if (!isRecord(rawEpisode)) return;
      const fileKey = normalizeStatusFailureFileKey(rawFileKey);
      const fingerprint = rebuildStatusFailureFingerprint(
        rawEpisode.fingerprint,
        sourceOverride
      );
      const bucketStartTime = toFiniteTimestamp(rawEpisode.bucketStartTime);
      const observedAt = toFiniteTimestamp(rawEpisode.observedAt);
      const expiresAt = toFiniteTimestamp(rawEpisode.expiresAt);
      if (
        !fileKey ||
        bucketStartTime === null ||
        observedAt === null ||
        expiresAt === null ||
        observedAt > now + STATUS_FAILURE_CAPTURE_MAX_AGE_MS
      ) {
        return;
      }
      const boundedExpiresAt = Math.min(expiresAt, observedAt + STATUS_FAILURE_HISTORY_TTL_MS);
      if (boundedExpiresAt <= observedAt || boundedExpiresAt <= now) return;
      active[fileKey] = {
        fingerprint,
        bucketStartTime,
        observedAt,
        expiresAt: boundedExpiresAt,
      };
    });
  }

  return { version: STATUS_FAILURE_HISTORY_VERSION, files, active };
};

export const pruneStatusFailureHistory = (
  store: StatusFailureHistoryStore,
  now = Date.now()
): StatusFailureHistoryStore => normalizeStatusFailureHistory(store, now);

export const parseStatusFailureHistory = (
  raw: string | null | undefined,
  now = Date.now(),
  sourceOverride?: StatusFailureHistorySource
): StatusFailureHistoryStore => {
  if (!raw) return createEmptyStatusFailureHistory();
  try {
    return normalizeStatusFailureHistory(JSON.parse(raw), now, sourceOverride);
  } catch {
    return createEmptyStatusFailureHistory();
  }
};

export const readStatusFailureHistory = (
  storage: StatusFailureHistoryStorage | null | undefined,
  now = Date.now()
): StatusFailureHistoryStore => {
  if (!storage) return createEmptyStatusFailureHistory();
  try {
    return parseStatusFailureHistory(storage.getItem(STATUS_FAILURE_HISTORY_STORAGE_KEY), now);
  } catch {
    return createEmptyStatusFailureHistory();
  }
};

export const serializeStatusFailureHistory = (store: StatusFailureHistoryStore): string => {
  const files = Object.fromEntries(
    Object.keys(store.files)
      .sort()
      .map((fileKey) => [
        fileKey,
        Object.fromEntries(
          Object.keys(store.files[fileKey])
            .sort((left, right) => Number(left) - Number(right))
            .map((bucketKey) => {
              const bucket = store.files[fileKey][bucketKey];
              return [
                bucketKey,
                {
                  startTime: bucket.startTime,
                  endTime: bucket.endTime,
                  details: Object.fromEntries(
                    Object.keys(bucket.details)
                      .sort()
                      .map((category) => [
                        category,
                        bucket.details[category as AuthFileStatusCategory],
                      ])
                  ),
                },
              ];
            })
        ),
      ])
  );
  const active = Object.fromEntries(
    Object.keys(store.active)
      .sort()
      .map((fileKey) => [fileKey, store.active[fileKey]])
  );
  return JSON.stringify({ version: STATUS_FAILURE_HISTORY_VERSION, files, active });
};

export const writeStatusFailureHistory = (
  storage: StatusFailureHistoryStorage | null | undefined,
  store: StatusFailureHistoryStore
): boolean => {
  if (!storage) return false;
  try {
    const serialized = serializeStatusFailureHistory(store);
    if (storage.getItem(STATUS_FAILURE_HISTORY_STORAGE_KEY) !== serialized) {
      storage.setItem(STATUS_FAILURE_HISTORY_STORAGE_KEY, serialized);
    }
    return true;
  } catch {
    return false;
  }
};

export const recordStatusFailure = (
  store: StatusFailureHistoryStore,
  input: RecordStatusFailureInput
): StatusFailureHistoryStore => {
  const observedAt = Number(input.observedAt);
  const startTime = Number(input.bucket.startTime);
  const endTime = Number(input.bucket.endTime);
  const fileKey = normalizeStatusFailureFileKey(input.fileName);
  if (
    !fileKey ||
    !Number.isFinite(observedAt) ||
    !Number.isFinite(startTime) ||
    !Number.isFinite(endTime) ||
    endTime <= startTime ||
    !STATUS_FAILURE_CATEGORIES.has(input.category)
  ) {
    return pruneStatusFailureHistory(store, Number.isFinite(observedAt) ? observedAt : Date.now());
  }

  const pruned = pruneStatusFailureHistory(store, observedAt);
  const bucketKey = bucketKeyFromStartTime(startTime);
  const existingFile = pruned.files[fileKey] ?? {};
  const existingBucket = existingFile[bucketKey];
  const message = simplifyStatusFailureMessage(input.category, input.message);
  const source = normalizeStatusFailureSource(input.source);
  const fingerprint = JSON.stringify([source, input.category, message]);
  const existingActive = pruned.active[fileKey];
  if (existingActive?.fingerprint === fingerprint && existingActive.bucketStartTime === startTime) {
    return pruned;
  }
  const detail = {
    category: input.category,
    message,
    observedAt,
    expiresAt: observedAt + STATUS_FAILURE_HISTORY_TTL_MS,
    source,
  };

  return {
    version: STATUS_FAILURE_HISTORY_VERSION,
    files: {
      ...pruned.files,
      [fileKey]: {
        ...existingFile,
        [bucketKey]: {
          startTime,
          endTime,
          details: {
            ...(existingBucket?.details ?? {}),
            [input.category]: detail,
          },
        },
      },
    },
    active: {
      ...pruned.active,
      [fileKey]: {
        fingerprint,
        bucketStartTime: startTime,
        observedAt,
        expiresAt: observedAt + STATUS_FAILURE_HISTORY_TTL_MS,
      },
    },
  };
};

export const clearActiveStatusFailure = (
  store: StatusFailureHistoryStore,
  fileName: string,
  now = Date.now()
): StatusFailureHistoryStore => {
  const pruned = pruneStatusFailureHistory(store, now);
  const fileKey = normalizeStatusFailureFileKey(fileName);
  const existing = fileKey ? pruned.active[fileKey] : undefined;
  if (!fileKey || !existing || existing.fingerprint === null) return pruned;
  const clearedAt = Math.max(now, existing.observedAt + 1);
  return {
    ...pruned,
    active: {
      ...pruned.active,
      [fileKey]: {
        fingerprint: null,
        bucketStartTime: existing.bucketStartTime,
        observedAt: clearedAt,
        expiresAt: clearedAt + STATUS_FAILURE_HISTORY_TTL_MS,
      },
    },
  };
};

export const mergeStatusFailureHistories = (
  left: StatusFailureHistoryStore,
  right: StatusFailureHistoryStore,
  now = Date.now()
): StatusFailureHistoryStore => {
  const sources = [pruneStatusFailureHistory(left, now), pruneStatusFailureHistory(right, now)];
  const merged = createEmptyStatusFailureHistory();

  sources.forEach((source) => {
    Object.entries(source.files).forEach(([fileKey, buckets]) => {
      const targetBuckets = merged.files[fileKey] ?? {};
      Object.entries(buckets).forEach(([bucketKey, bucket]) => {
        const targetBucket = targetBuckets[bucketKey];
        const details = { ...(targetBucket?.details ?? {}) };
        Object.entries(bucket.details).forEach(([category, detail]) => {
          if (!detail) return;
          const existing = details[category as AuthFileStatusCategory];
          const detailSourcePriority = getStatusFailureSourcePriority(detail.source);
          const existingSourcePriority = getStatusFailureSourcePriority(existing?.source);
          const detailTieBreak = existing
            ? JSON.stringify(detail).localeCompare(JSON.stringify(existing))
            : 1;
          if (
            !existing ||
            detailSourcePriority > existingSourcePriority ||
            (detailSourcePriority === existingSourcePriority &&
              (detail.observedAt > existing.observedAt ||
                (detail.observedAt === existing.observedAt && detailTieBreak > 0)))
          ) {
            details[category as AuthFileStatusCategory] = detail;
          }
        });
        targetBuckets[bucketKey] = {
          startTime: bucket.startTime,
          endTime: Math.max(targetBucket?.endTime ?? bucket.endTime, bucket.endTime),
          details,
        };
      });
      merged.files[fileKey] = targetBuckets;
    });

    Object.entries(source.active).forEach(([fileKey, episode]) => {
      const existing = merged.active[fileKey];
      const episodeTieBreak = existing
        ? JSON.stringify(episode).localeCompare(JSON.stringify(existing))
        : 1;
      if (
        !existing ||
        episode.observedAt > existing.observedAt ||
        (episode.observedAt === existing.observedAt && episodeTieBreak > 0)
      ) {
        merged.active[fileKey] = episode;
      }
    });
  });

  return pruneStatusFailureHistory(merged, now);
};

export const getStatusFailureBucketsForFile = (
  store: StatusFailureHistoryStore,
  fileName: string,
  now = Date.now()
): StatusFailureHistoryBucket[] => {
  const fileKey = normalizeStatusFailureFileKey(fileName);
  const buckets = store.files[fileKey];
  if (!buckets) return [];

  return Object.values(buckets)
    .map((bucket) => ({
      ...bucket,
      details: Object.fromEntries(
        Object.entries(bucket.details).filter(([, detail]) => detail && detail.expiresAt > now)
      ) as StatusFailureHistoryBucket['details'],
    }))
    .filter((bucket) => Object.keys(bucket.details).length > 0)
    .sort((left, right) => left.startTime - right.startTime);
};

export const getStatusFailureDetailsForBlock = (
  buckets: StatusFailureHistoryBucket[],
  block: Pick<StatusBlockDetail, 'startTime' | 'endTime'>,
  now = Date.now()
): StatusFailureHistoryDetail[] => {
  const bucket = buckets.find(
    (candidate) => candidate.startTime === block.startTime && candidate.endTime === block.endTime
  );
  if (!bucket) return [];
  return Object.values(bucket.details)
    .filter((detail): detail is StatusFailureHistoryDetail =>
      Boolean(detail && detail.expiresAt > now)
    )
    .sort((left, right) => right.observedAt - left.observedAt);
};

export const findLatestCapturableFailureBlock = (
  blocks: FailureBlock[],
  now = Date.now()
): { index: number; block: FailureBlock } | null => {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.failure <= 0) {
      if (block.success > 0) return null;
      continue;
    }
    if (now - block.endTime > STATUS_FAILURE_CAPTURE_MAX_AGE_MS) continue;
    return { index, block };
  }
  return null;
};

export const hasLatestSuccessfulRequestBlock = (blocks: FailureBlock[]): boolean => {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];
    if (block.success + block.failure <= 0) continue;
    return block.success > 0 && block.failure <= 0;
  }
  return false;
};

export const getNextStatusFailureExpiry = (
  store: StatusFailureHistoryStore,
  now = Date.now()
): number | null => {
  let nextExpiry: number | null = null;
  Object.values(store.files).forEach((buckets) => {
    Object.values(buckets).forEach((bucket) => {
      Object.values(bucket.details).forEach((detail) => {
        if (!detail || detail.expiresAt <= now) return;
        if (nextExpiry === null || detail.expiresAt < nextExpiry) nextExpiry = detail.expiresAt;
      });
    });
  });
  Object.values(store.active).forEach((episode) => {
    if (episode.expiresAt <= now) return;
    if (nextExpiry === null || episode.expiresAt < nextExpiry) nextExpiry = episode.expiresAt;
  });
  return nextExpiry;
};
