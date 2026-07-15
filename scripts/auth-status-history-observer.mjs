import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

export const AUTH_FAILURE_HISTORY_VERSION = 1;
export const AUTH_FAILURE_HISTORY_TTL_MS = 3 * 60 * 60 * 1000;
export const AUTH_FAILURE_BUCKET_MS = 10 * 60 * 1000;
const RECENT_REQUEST_BLOCK_COUNT = 20;
const MAIN_LOG_READ_LIMIT_BYTES = 4 * 1024 * 1024;

const DEFAULT_INSTALL_DIR = 'D:\\CLIProxyAPI';
const RESPONSE_LOG_PATTERN =
  /^v1-responses-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})-([0-9a-z_-]+)\.log$/i;
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}$/i;
const MAX_FILE_NAME_LENGTH = 260;
const FAILURE_CATEGORIES = new Set([
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
const CATEGORY_FALLBACK_MESSAGE = {
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
  unknown_upstream_error: 'unknown upstream error',
};

let defaultClassifierPromise = null;

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const finiteNumberOrNull = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const normalizeCategory = (value) =>
  typeof value === 'string' && FAILURE_CATEGORIES.has(value) ? value : 'unknown_upstream_error';

const normalizeAuthFileName = (value) => {
  const normalized = path.win32
    .basename(String(value ?? ''))
    .replace(/[\p{Cc}]/gu, '')
    .trim()
    .slice(0, MAX_FILE_NAME_LENGTH);
  return normalized || null;
};

const normalizeAuthFileKey = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const parseLocalTimestamp = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(value ?? ''));
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const timestamp = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    0
  ).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
};

const parseResponseLogName = (fileName) => {
  const match = RESPONSE_LOG_PATTERN.exec(fileName);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, requestId] = match;
  const timestampMs = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
    0
  ).getTime();
  if (!Number.isFinite(timestampMs) || !REQUEST_ID_PATTERN.test(requestId)) return null;
  return { requestId: requestId.toLowerCase(), timestampMs };
};

const parseRecentRequestTimeRange = (value, nowMs) => {
  const match = /^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const [, rawStartHour, rawStartMinute, rawEndHour, rawEndMinute] = match;
  const startHour = Number(rawStartHour);
  const startMinute = Number(rawStartMinute);
  const endHour = Number(rawEndHour);
  const endMinute = Number(rawEndMinute);
  if (startHour > 23 || endHour > 23 || startMinute > 59 || endMinute > 59) {
    return null;
  }
  const reference = new Date(nowMs);
  let startTime = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
    startHour,
    startMinute,
    0,
    0
  ).getTime();
  let endTime = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
    endHour,
    endMinute,
    0,
    0
  ).getTime();
  if (endTime <= startTime) endTime += 24 * 60 * 60 * 1000;
  if (startTime > nowMs + AUTH_FAILURE_BUCKET_MS) {
    startTime -= 24 * 60 * 60 * 1000;
    endTime -= 24 * 60 * 60 * 1000;
  }
  return { startTime, endTime };
};

const findLatestStatusFailureBucket = (file, nowMs, bucketMs) => {
  const rawBuckets = Array.isArray(file?.recent_requests)
    ? file.recent_requests
    : Array.isArray(file?.recentRequests)
      ? file.recentRequests
      : [];
  const normalized = rawBuckets.slice(-RECENT_REQUEST_BLOCK_COUNT).map((item) => ({
    success: Math.max(0, Number(item?.success) || 0),
    failure: Math.max(0, Number(item?.failed ?? item?.failure) || 0),
    time: typeof item?.time === 'string' ? item.time : null,
  }));
  const emptyCount = Math.max(0, RECENT_REQUEST_BLOCK_COUNT - normalized.length);
  const blocks = [
    ...Array.from({ length: emptyCount }, () => ({ success: 0, failure: 0, time: null })),
    ...normalized,
  ];
  const currentBucketStart = Math.floor(nowMs / bucketMs) * bucketMs;
  const windowStart = currentBucketStart - (RECENT_REQUEST_BLOCK_COUNT - 1) * bucketMs;

  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const item = blocks[index];
    if (item.success + item.failure <= 0) continue;
    if (item.failure <= 0) return { block: null, clearEpisode: true };
    const parsed = parseRecentRequestTimeRange(item.time, nowMs);
    const startTime = parsed?.startTime ?? windowStart + index * bucketMs;
    const endTime = parsed?.endTime ?? startTime + bucketMs;
    if (nowMs - endTime > bucketMs) return { block: null, clearEpisode: false };
    return { block: { startTime, endTime }, clearEpisode: false };
  }
  return { block: null, clearEpisode: false };
};

export function simplifyObservedFailureMessage(category, rawMessage, statusCode = null) {
  const normalizedCategory = normalizeCategory(category);
  const raw = String(rawMessage ?? '');
  if (normalizedCategory === 'connection_transient') {
    if (/unexpected\s+EOF/i.test(raw)) return 'unexpected EOF';
    if (/\bEOF\b/i.test(raw)) return 'EOF';
    if (/connection\s+reset|ECONNRESET|forcibly\s+closed/i.test(raw)) return 'connection reset';
    if (/timed?\s*out|ETIMEDOUT/i.test(raw)) return 'connection timeout';
  }
  if (normalizedCategory === 'request_interrupted') {
    if (/context\s+cancelled/i.test(raw)) return 'context cancelled';
    if (/context\s+canceled/i.test(raw)) return 'context canceled';
    if (/deadline\s+exceeded/i.test(raw)) return 'deadline exceeded';
  }
  if (normalizedCategory === 'local_proxy_unavailable' && /connection\s+refused/i.test(raw)) {
    return 'Connection refused';
  }

  if (Number.isInteger(Number(statusCode)) && Number(statusCode) >= 400) {
    return `HTTP ${Number(statusCode)}`;
  }
  return normalizedCategory === 'unknown_upstream_error'
    ? ''
    : (CATEGORY_FALLBACK_MESSAGE[normalizedCategory] ?? '');
}

const emptyProjection = (generatedAt = null) => ({
  version: AUTH_FAILURE_HISTORY_VERSION,
  ...(generatedAt ? { generatedAt } : {}),
  files: {},
  active: {},
});

const emptyState = () => ({
  ...emptyProjection(),
  state: {
    mainLogOffset: 0,
    mainLogSize: 0,
    mainLogMtimeMs: 0,
    nextAttemptSequence: 1,
    attemptsByRequest: {},
    responseSources: {},
    responseSourceBackfillCompletedAtMs: null,
    statusRecords: {},
    statusEpisodes: {},
  },
});

async function readJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rename(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 5) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    } finally {
      await rm(tmpPath, { force: true }).catch(() => {});
    }
  }
  throw lastError ?? new Error(`Failed to write ${filePath}`);
}

export function normalizeAuthFailureObserverOptions(input = {}) {
  const installDir = String(input.installDir ?? DEFAULT_INSTALL_DIR);
  const logsDir = String(
    input.logsDir ?? input.modelRequestLogsDir ?? path.join(installDir, 'logs')
  );
  const dataDir = String(input.dataDir ?? path.join(installDir, 'priority-rotation'));
  return {
    installDir,
    logsDir,
    mainLogPath: String(input.mainLogPath ?? path.join(logsDir, 'main.log')),
    statePath: String(input.statePath ?? path.join(dataDir, 'auth-failure-history.json')),
    retentionMs: AUTH_FAILURE_HISTORY_TTL_MS,
    bucketMs: AUTH_FAILURE_BUCKET_MS,
  };
}

const normalizeStatusRecords = (value, cutoffMs) => {
  if (!isRecord(value)) return {};
  const nowMs = cutoffMs + AUTH_FAILURE_HISTORY_TTL_MS;
  const records = {};
  Object.entries(value).forEach(([rawFileKey, rawBuckets]) => {
    if (!isRecord(rawBuckets)) return;
    const fileKey = normalizeAuthFileKey(rawFileKey);
    if (!fileKey) return;
    const buckets = {};
    Object.entries(rawBuckets).forEach(([rawBucketKey, rawBucket]) => {
      if (!isRecord(rawBucket) || !isRecord(rawBucket.details)) return;
      const startTime = finiteNumberOrNull(rawBucket.startTime ?? rawBucketKey);
      const endTime = finiteNumberOrNull(rawBucket.endTime);
      if (startTime === null || endTime === null || endTime <= startTime) return;
      const details = {};
      Object.entries(rawBucket.details).forEach(([rawCategory, rawDetail]) => {
        if (!isRecord(rawDetail)) return;
        const category = normalizeCategory(rawCategory);
        const observedAt = finiteNumberOrNull(rawDetail.observedAt);
        const expiresAt = finiteNumberOrNull(rawDetail.expiresAt);
        if (observedAt === null || expiresAt === null || observedAt < cutoffMs) return;
        const boundedExpiresAt = Math.min(expiresAt, observedAt + AUTH_FAILURE_HISTORY_TTL_MS);
        if (boundedExpiresAt <= nowMs) return;
        details[category] = {
          category,
          message: simplifyObservedFailureMessage(category, rawDetail.message),
          observedAt,
          expiresAt: boundedExpiresAt,
        };
      });
      if (Object.keys(details).length > 0) {
        buckets[String(Math.trunc(startTime))] = { startTime, endTime, details };
      }
    });
    if (Object.keys(buckets).length > 0) records[fileKey] = buckets;
  });
  return records;
};

const normalizeStatusEpisodes = (value, cutoffMs) => {
  if (!isRecord(value)) return {};
  const episodes = {};
  Object.entries(value).forEach(([rawFileKey, rawEpisode]) => {
    if (!isRecord(rawEpisode)) return;
    const fileKey = normalizeAuthFileKey(rawFileKey);
    const fingerprint =
      typeof rawEpisode.fingerprint === 'string' ? rawEpisode.fingerprint.slice(0, 256) : '';
    const bucketStartTime = finiteNumberOrNull(rawEpisode.bucketStartTime);
    if (!fileKey || !fingerprint || bucketStartTime === null || bucketStartTime < cutoffMs) return;
    episodes[fileKey] = { fingerprint, bucketStartTime };
  });
  return episodes;
};

const normalizeLoadedState = (value, cutoffMs) => {
  if (
    !isRecord(value) ||
    value.version !== AUTH_FAILURE_HISTORY_VERSION ||
    !isRecord(value.state)
  ) {
    return emptyState();
  }
  const normalized = emptyState();
  normalized.generatedAt = typeof value.generatedAt === 'string' ? value.generatedAt : undefined;
  normalized.state.mainLogOffset = Math.max(
    0,
    Math.trunc(finiteNumberOrNull(value.state.mainLogOffset) ?? 0)
  );
  normalized.state.mainLogSize = Math.max(
    0,
    Math.trunc(finiteNumberOrNull(value.state.mainLogSize) ?? 0)
  );
  normalized.state.mainLogMtimeMs = Math.max(
    0,
    finiteNumberOrNull(value.state.mainLogMtimeMs) ?? 0
  );
  normalized.state.nextAttemptSequence = Math.max(
    1,
    Math.trunc(finiteNumberOrNull(value.state.nextAttemptSequence) ?? 1)
  );

  if (isRecord(value.state.attemptsByRequest)) {
    Object.entries(value.state.attemptsByRequest).forEach(([requestId, rawAttempts]) => {
      if (!REQUEST_ID_PATTERN.test(requestId) || !Array.isArray(rawAttempts)) return;
      const attempts = rawAttempts
        .map((rawAttempt, fallbackAttemptIndex) => {
          if (!isRecord(rawAttempt)) return null;
          const fileName = normalizeAuthFileName(rawAttempt.fileName);
          const observedAt = finiteNumberOrNull(rawAttempt.observedAt);
          const sequence = finiteNumberOrNull(rawAttempt.sequence);
          const attemptIndex = finiteNumberOrNull(rawAttempt.attemptIndex);
          if (!fileName || observedAt === null || observedAt < cutoffMs || sequence === null)
            return null;
          return {
            fileName,
            observedAt,
            sequence: Math.max(0, Math.trunc(sequence)),
            attemptIndex: Math.max(
              0,
              Math.trunc(attemptIndex === null ? fallbackAttemptIndex : attemptIndex)
            ),
          };
        })
        .filter(Boolean)
        .sort((left, right) => left.sequence - right.sequence);
      if (attempts.length > 0)
        normalized.state.attemptsByRequest[requestId.toLowerCase()] = attempts;
    });
  }

  if (isRecord(value.state.responseSources)) {
    Object.entries(value.state.responseSources).forEach(([fileName, rawSource]) => {
      const filenameInfo = parseResponseLogName(fileName);
      if (!filenameInfo || !isRecord(rawSource) || filenameInfo.timestampMs < cutoffMs) return;
      const fingerprint = typeof rawSource.fingerprint === 'string' ? rawSource.fingerprint : '';
      if (!fingerprint || !Array.isArray(rawSource.failures)) return;
      const failures = rawSource.failures
        .map((rawFailure) => {
          if (!isRecord(rawFailure)) return null;
          const category = normalizeCategory(rawFailure.category);
          const attemptIndex = Math.trunc(finiteNumberOrNull(rawFailure.attemptIndex) ?? -1);
          return {
            category,
            message: simplifyObservedFailureMessage(
              category,
              rawFailure.message,
              rawSource.statusCode
            ),
            attemptIndex,
          };
        })
        .filter(Boolean);
      normalized.state.responseSources[fileName] = {
        fingerprint,
        timestampMs: filenameInfo.timestampMs,
        requestId: filenameInfo.requestId,
        statusCode: finiteNumberOrNull(rawSource.statusCode),
        failures,
      };
    });
  }
  const rawBackfillCompletedAtMs = value.state.responseSourceBackfillCompletedAtMs;
  normalized.state.responseSourceBackfillCompletedAtMs =
    rawBackfillCompletedAtMs === null || rawBackfillCompletedAtMs === undefined
      ? null
      : finiteNumberOrNull(rawBackfillCompletedAtMs);
  normalized.state.statusRecords = normalizeStatusRecords(value.state.statusRecords, cutoffMs);
  normalized.state.statusEpisodes = normalizeStatusEpisodes(value.state.statusEpisodes, cutoffMs);
  return normalized;
};

const getLegacyResponseSourceBackfillWatermark = (value) => {
  if (
    !isRecord(value) ||
    value.version !== AUTH_FAILURE_HISTORY_VERSION ||
    !isRecord(value.state) ||
    !isRecord(value.state.responseSources) ||
    value.state.responseSourceBackfillCompletedAtMs !== undefined
  ) {
    return null;
  }
  const generatedAtMs = Date.parse(String(value.generatedAt ?? ''));
  return Number.isFinite(generatedAtMs) ? generatedAtMs : null;
};

const parseMainLogSelectionLine = (line) => {
  const match =
    /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\s+\[([^\]]+)\].*\bauth=(.*?)\s+provider=/.exec(
      line
    );
  if (!match) return null;
  const [, rawTimestamp, rawRequestId, rawFileName] = match;
  const requestId = rawRequestId.trim().toLowerCase();
  const fileName = normalizeAuthFileName(rawFileName);
  const observedAt = parseLocalTimestamp(rawTimestamp);
  if (!REQUEST_ID_PATTERN.test(requestId) || !fileName || observedAt === null) return null;
  return { requestId, fileName, observedAt };
};

async function readNewMainLogSelections(mainLogPath, cursor) {
  let stats;
  try {
    stats = await stat(mainLogPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { selections: [], offset: 0, size: 0, mtimeMs: 0 };
    }
    throw error;
  }
  const previousOffset = Math.max(0, Math.trunc(finiteNumberOrNull(cursor?.offset) ?? 0));
  const offset = stats.size >= previousOffset ? previousOffset : 0;
  if (stats.size <= offset) {
    return {
      selections: [],
      offset,
      size: stats.size,
      mtimeMs: Math.floor(stats.mtimeMs),
    };
  }

  const handle = await open(mainLogPath, 'r');
  try {
    const remainingBytes = stats.size - offset;
    const readLength = Math.min(remainingBytes, MAIN_LOG_READ_LIMIT_BYTES);
    const buffer = Buffer.alloc(readLength);
    const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
    if (bytesRead <= 0) {
      return {
        selections: [],
        offset,
        size: stats.size,
        mtimeMs: Math.floor(stats.mtimeMs),
      };
    }
    const chunk = buffer.subarray(0, bytesRead);
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      const boundedAdvance =
        remainingBytes > MAIN_LOG_READ_LIMIT_BYTES && bytesRead === readLength ? bytesRead : 0;
      return {
        selections: [],
        offset: offset + boundedAdvance,
        size: stats.size,
        mtimeMs: Math.floor(stats.mtimeMs),
      };
    }
    const lines = chunk
      .subarray(0, lastNewline + 1)
      .toString('utf8')
      .split(/\r?\n/);
    return {
      selections: lines.map(parseMainLogSelectionLine).filter(Boolean),
      offset: offset + lastNewline + 1,
      size: stats.size,
      mtimeMs: Math.floor(stats.mtimeMs),
    };
  } finally {
    await handle.close();
  }
}

const getDefaultClassifier = async () => {
  defaultClassifierPromise ??= import('./priority-rotation-sidecar.mjs').then(
    (module) => module.classifyUpstreamStatusText
  );
  return defaultClassifierPromise;
};

async function parseResponseFailureSource(filePath, fileName, stats, classifySignal) {
  let statusCode = null;
  const errors = [];
  const events = [];
  let section = 'unknown';
  let hasStructuredSections = false;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    const sectionMatch = /^===\s*(.+?)\s*===$/.exec(line);
    if (sectionMatch) {
      hasStructuredSections = true;
      const sectionName = sectionMatch[1].trim().toUpperCase();
      section = sectionName.includes('RESPONSE')
        ? 'response'
        : sectionName.includes('REQUEST')
          ? 'request'
          : 'other';
      continue;
    }
    if (hasStructuredSections && section !== 'response') continue;
    const statusMatch = /^Status:\s*(\d+)/.exec(line);
    if (statusMatch) {
      statusCode = Number(statusMatch[1]);
      continue;
    }
    const errorMatch = /^Error:\s*(.+)/.exec(line);
    if (errorMatch) {
      errors.push(errorMatch[1].trim());
      continue;
    }
    const eventMatch = /^event:\s*(response\.(?:failed|error|incomplete))/.exec(line);
    if (eventMatch) events.push(eventMatch[1]);
  }

  const rawSignals =
    errors.length > 0
      ? errors.map((signal, index) => ({ signal, attemptIndex: index }))
      : events.length > 0
        ? events.map((signal) => ({ signal, attemptIndex: -1 }))
        : Number.isFinite(statusCode) && statusCode >= 400
          ? [{ signal: `Status: ${statusCode}`, attemptIndex: -1 }]
          : [];
  const failures = [];
  for (const item of rawSignals) {
    const category = normalizeCategory(await classifySignal(item.signal, statusCode));
    failures.push({
      category,
      message: simplifyObservedFailureMessage(category, item.signal, statusCode),
      attemptIndex: item.attemptIndex,
    });
  }
  const filenameInfo = parseResponseLogName(fileName);
  return {
    fingerprint: `${stats.size}:${Math.floor(stats.mtimeMs)}`,
    timestampMs: filenameInfo.timestampMs,
    requestId: filenameInfo.requestId,
    statusCode,
    failures,
  };
}

const buildProjectionFiles = (state, cutoffMs, retentionMs, bucketMs) => {
  const files = {};
  Object.values(state.responseSources).forEach((source) => {
    const attempts = state.attemptsByRequest[source.requestId];
    if (!Array.isArray(attempts) || attempts.length === 0) return;
    source.failures.forEach((failure) => {
      const attempt =
        failure.attemptIndex < 0
          ? attempts[attempts.length - 1]
          : attempts.find((candidate) => candidate.attemptIndex === failure.attemptIndex);
      if (!attempt || attempt.observedAt < cutoffMs) return;
      const fileKey = normalizeAuthFileKey(attempt.fileName);
      if (!fileKey) return;
      const bucketStart = Math.floor(attempt.observedAt / bucketMs) * bucketMs;
      const bucketKey = String(bucketStart);
      const fileBuckets = files[fileKey] ?? {};
      const bucket = fileBuckets[bucketKey] ?? {
        startTime: bucketStart,
        endTime: bucketStart + bucketMs,
        details: {},
      };
      const detail = {
        category: failure.category,
        message: failure.message,
        observedAt: attempt.observedAt,
        expiresAt: attempt.observedAt + retentionMs,
      };
      const existing = bucket.details[failure.category];
      if (
        !existing ||
        detail.observedAt > existing.observedAt ||
        (detail.observedAt === existing.observedAt &&
          detail.message.localeCompare(existing.message) > 0)
      ) {
        bucket.details[failure.category] = detail;
      }
      fileBuckets[bucketKey] = bucket;
      files[fileKey] = fileBuckets;
    });
  });
  Object.entries(state.statusRecords ?? {}).forEach(([fileKey, statusBuckets]) => {
    const fileBuckets = files[fileKey] ?? {};
    Object.entries(statusBuckets).forEach(([bucketKey, statusBucket]) => {
      const bucket = fileBuckets[bucketKey] ?? {
        startTime: statusBucket.startTime,
        endTime: statusBucket.endTime,
        details: {},
      };
      Object.entries(statusBucket.details).forEach(([category, detail]) => {
        if (!bucket.details[category]) bucket.details[category] = detail;
      });
      fileBuckets[bucketKey] = bucket;
    });
    files[fileKey] = fileBuckets;
  });
  return Object.fromEntries(
    Object.entries(files)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([fileKey, buckets]) => [
        fileKey,
        Object.fromEntries(
          Object.entries(buckets).sort(([left], [right]) => Number(left) - Number(right))
        ),
      ])
  );
};

const projectUnexpiredFiles = (files, nowMs) => {
  if (!isRecord(files)) return {};
  const projected = {};
  Object.entries(files).forEach(([rawFileKey, rawBuckets]) => {
    if (!isRecord(rawBuckets)) return;
    const fileKey = normalizeAuthFileKey(rawFileKey);
    const buckets = {};
    Object.entries(rawBuckets).forEach(([bucketKey, rawBucket]) => {
      if (!isRecord(rawBucket) || !isRecord(rawBucket.details)) return;
      const details = Object.fromEntries(
        Object.entries(rawBucket.details).filter(([, detail]) => {
          return isRecord(detail) && finiteNumberOrNull(detail.expiresAt) > nowMs;
        })
      );
      if (Object.keys(details).length === 0) return;
      buckets[bucketKey] = { ...rawBucket, details };
    });
    if (Object.keys(buckets).length > 0) projected[fileKey] = buckets;
  });
  return projected;
};

export async function readAuthFailureHistoryProjection(statePath, nowMs = Date.now()) {
  const value = await readJson(statePath, emptyProjection());
  if (!isRecord(value) || value.version !== AUTH_FAILURE_HISTORY_VERSION) {
    return emptyProjection();
  }
  const normalized = normalizeLoadedState(value, nowMs - AUTH_FAILURE_HISTORY_TTL_MS);
  return {
    version: AUTH_FAILURE_HISTORY_VERSION,
    ...(typeof value.generatedAt === 'string' ? { generatedAt: value.generatedAt } : {}),
    files: projectUnexpiredFiles(
      buildProjectionFiles(
        normalized.state,
        nowMs - AUTH_FAILURE_HISTORY_TTL_MS,
        AUTH_FAILURE_HISTORY_TTL_MS,
        AUTH_FAILURE_BUCKET_MS
      ),
      nowMs
    ),
    active: {},
  };
}

const pruneResponseFailuresWithoutRetainedAttempts = (state) => {
  Object.values(state.responseSources).forEach((source) => {
    if (!Array.isArray(source.failures) || source.failures.length === 0) return;
    const attempts = state.attemptsByRequest[source.requestId];
    if (!Array.isArray(attempts) || attempts.length === 0) return;
    const retainedFailures = source.failures.filter((failure) => {
      if (failure.attemptIndex < 0) return attempts.length > 0;
      return attempts.some((attempt) => attempt.attemptIndex === failure.attemptIndex);
    });
    source.failures = retainedFailures;
  });
};

const isTruthyFlag = (value) =>
  value === true ||
  value === 1 ||
  (typeof value === 'string' && value.trim().toLowerCase() === 'true');

const recordAuthFileStatusSnapshots = async (
  state,
  authFiles,
  nowMs,
  bucketMs,
  retentionMs,
  classifySignal
) => {
  state.statusRecords = normalizeStatusRecords(state.statusRecords, nowMs - retentionMs);
  state.statusEpisodes = normalizeStatusEpisodes(state.statusEpisodes, nowMs - retentionMs);
  if (!Array.isArray(authFiles)) return;

  for (const file of authFiles) {
    const fileName = normalizeAuthFileName(file?.name);
    const fileKey = normalizeAuthFileKey(fileName);
    if (
      !fileKey ||
      isTruthyFlag(file?.disabled) ||
      isTruthyFlag(file?.runtime_only ?? file?.runtimeOnly)
    ) {
      if (fileKey) delete state.statusEpisodes[fileKey];
      continue;
    }
    const rawMessage = String(file?.status_message ?? file?.statusMessage ?? '').trim();
    if (!rawMessage) {
      delete state.statusEpisodes[fileKey];
      continue;
    }
    const category = await classifySignal(rawMessage, null);
    if (!category) {
      delete state.statusEpisodes[fileKey];
      continue;
    }
    const latest = findLatestStatusFailureBucket(file, nowMs, bucketMs);
    if (latest.clearEpisode) delete state.statusEpisodes[fileKey];
    if (!latest.block) continue;
    const normalizedCategory = normalizeCategory(category);
    const message = simplifyObservedFailureMessage(normalizedCategory, rawMessage);
    const fingerprint = JSON.stringify([normalizedCategory, message]);
    const existingEpisode = state.statusEpisodes[fileKey];
    if (
      existingEpisode?.fingerprint === fingerprint &&
      existingEpisode.bucketStartTime === latest.block.startTime
    ) {
      continue;
    }
    const bucketKey = String(Math.trunc(latest.block.startTime));
    const fileBuckets = state.statusRecords[fileKey] ?? {};
    const bucket = fileBuckets[bucketKey] ?? {
      startTime: latest.block.startTime,
      endTime: latest.block.endTime,
      details: {},
    };
    bucket.details[normalizedCategory] = {
      category: normalizedCategory,
      message,
      observedAt: nowMs,
      expiresAt: nowMs + retentionMs,
    };
    fileBuckets[bucketKey] = bucket;
    state.statusRecords[fileKey] = fileBuckets;
    state.statusEpisodes[fileKey] = {
      fingerprint,
      bucketStartTime: latest.block.startTime,
    };
  }
};

export async function observeAuthFailureHistory(input = {}, dependencies = {}) {
  const options = normalizeAuthFailureObserverOptions(input);
  const nowMs = Number(input.nowMs ?? dependencies.now?.() ?? Date.now());
  const cutoffMs = nowMs - options.retentionMs;
  const previousRaw = await readJson(options.statePath, emptyState());
  const previous = normalizeLoadedState(previousRaw, cutoffMs);
  const next = structuredClone(previous);
  const legacyBackfillWatermarkMs = getLegacyResponseSourceBackfillWatermark(previousRaw);

  const mainLogResult = await readNewMainLogSelections(options.mainLogPath, {
    offset: next.state.mainLogOffset,
  });
  next.state.mainLogOffset = mainLogResult.offset;
  next.state.mainLogSize = mainLogResult.size;
  next.state.mainLogMtimeMs = mainLogResult.mtimeMs;
  mainLogResult.selections.forEach((selection) => {
    if (selection.observedAt < cutoffMs) return;
    const attempts = next.state.attemptsByRequest[selection.requestId] ?? [];
    const duplicate = attempts.some(
      (attempt) =>
        attempt.fileName.toLowerCase() === selection.fileName.toLowerCase() &&
        attempt.observedAt === selection.observedAt
    );
    if (!duplicate) {
      const nextAttemptIndex =
        attempts.reduce(
          (maximum, attempt) => Math.max(maximum, Number(attempt.attemptIndex ?? -1)),
          -1
        ) + 1;
      attempts.push({
        fileName: selection.fileName,
        observedAt: selection.observedAt,
        sequence: next.state.nextAttemptSequence,
        attemptIndex: nextAttemptIndex,
      });
      next.state.nextAttemptSequence += 1;
      attempts.sort((left, right) => left.sequence - right.sequence);
      next.state.attemptsByRequest[selection.requestId] = attempts;
    }
  });
  Object.entries(next.state.attemptsByRequest).forEach(([requestId, attempts]) => {
    const retained = attempts.filter((attempt) => attempt.observedAt >= cutoffMs);
    if (retained.length > 0) next.state.attemptsByRequest[requestId] = retained;
    else delete next.state.attemptsByRequest[requestId];
  });

  const classifySignal = dependencies.classifySignal ?? (await getDefaultClassifier());
  let entries = [];
  try {
    entries = await readdir(options.logsDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const candidates = entries
    .filter((entry) => entry.isFile())
    .map((entry) => ({ entry, info: parseResponseLogName(entry.name) }))
    .filter(({ info }) => info && info.timestampMs >= cutoffMs)
    .sort((left, right) => left.entry.name.localeCompare(right.entry.name));

  for (const { entry, info } of candidates) {
    const filePath = path.join(options.logsDir, entry.name);
    let stats;
    try {
      stats = await stat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    const fingerprint = `${stats.size}:${Math.floor(stats.mtimeMs)}`;
    const existingSource = next.state.responseSources[entry.name];
    if (existingSource?.fingerprint === fingerprint) continue;
    if (
      !existingSource &&
      legacyBackfillWatermarkMs !== null &&
      info.timestampMs <= legacyBackfillWatermarkMs &&
      Math.floor(stats.mtimeMs) <= legacyBackfillWatermarkMs
    ) {
      next.state.responseSources[entry.name] = {
        fingerprint,
        timestampMs: info.timestampMs,
        requestId: info.requestId,
        statusCode: null,
        failures: [],
      };
      continue;
    }
    const parseResponseSource = dependencies.parseResponseSource ?? parseResponseFailureSource;
    const source = await parseResponseSource(filePath, entry.name, stats, classifySignal);
    next.state.responseSources[entry.name] = source;
  }
  if (legacyBackfillWatermarkMs !== null) {
    next.state.responseSourceBackfillCompletedAtMs = legacyBackfillWatermarkMs;
  }
  Object.entries(next.state.responseSources).forEach(([fileName, source]) => {
    const info = parseResponseLogName(fileName);
    if (!info || info.timestampMs < cutoffMs || source.timestampMs < cutoffMs) {
      delete next.state.responseSources[fileName];
    }
  });
  pruneResponseFailuresWithoutRetainedAttempts(next.state);
  await recordAuthFileStatusSnapshots(
    next.state,
    input.authFiles,
    nowMs,
    options.bucketMs,
    options.retentionMs,
    classifySignal
  );

  next.files = buildProjectionFiles(next.state, cutoffMs, options.retentionMs, options.bucketMs);
  next.active = {};
  next.version = AUTH_FAILURE_HISTORY_VERSION;

  const previousComparable = JSON.stringify({ ...previousRaw, generatedAt: undefined });
  const nextComparable = JSON.stringify({ ...next, generatedAt: undefined });
  if (previousComparable !== nextComparable) {
    next.generatedAt = new Date(nowMs).toISOString();
    await (dependencies.writeState ?? writeJsonAtomic)(options.statePath, next);
    return next;
  }
  return previous;
}
