import { parseLogLine } from '@/pages/hooks/logParsing';
import {
  normalizeRecentRequestUsageEntry,
  type ApiKeyUsageResponse,
} from '@/utils/recentRequests';
import type {
  EnrichedUsageStatsRecord,
  TokenUsage,
  UsageRequestDetail,
  UsageRequestStatus,
  UsageStatsFilters,
  UsageStatsRecord,
} from '@/types/usageStatistics';
import {
  MATRIX_ROW_LIMIT,
  MODEL_REQUEST_PATHS,
  UNPARSED_MODEL_LABEL,
} from './constants';
import {
  formatDateTime,
  getDetailStatusLabel,
  getMatchLabel,
  getStatusLabel,
  normalizeModelForCompare,
  parseLatencyMs,
  parseTimestampMs,
  resolveModelMatch,
} from './formatters';
import { emptyTokenUsage } from './requestDetails';

export interface AggregateTotals {
  success: number;
  failure: number;
  total: number;
  successRate: number;
}

export interface RequestMetrics {
  total: number;
  success: number;
  failure: number;
  successRate: number;
  verified: number;
  mismatch: number;
  avgLatency: number | null;
  p95Latency: number | null;
}

export interface ModelUsageDatum {
  model: string;
  total: number;
  success: number;
  failure: number;
  tokenTotal: number;
  percent: number;
}

export interface TokenUsageMetrics {
  totalRequests: number;
  parsedRequests: number;
  knownRequests: number;
  unreportedRequests: number;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  total: number;
  averagePerKnown: number | null;
  maxTotal: number;
  maxRequestId: string | null;
  maxModel: string | null;
  coverageRate: number;
  parsedRate: number;
}

export interface TimelineBucket {
  key: string;
  label: string;
  total: number;
  success: number;
  failure: number;
  unknown: number;
  avgLatency: number | null;
  p95Latency: number | null;
}

export interface ModelMatrixDatum {
  configuredModel: string;
  actualModel: string;
  total: number;
  success: number;
  failure: number;
  changed: boolean;
  percent: number;
}

const isModelRequestLog = (raw: string, path?: string): boolean => {
  const lowerRaw = raw.toLowerCase();
  const lowerPath = path?.toLowerCase() ?? '';
  if (lowerRaw.includes('/v0/management')) return false;
  return MODEL_REQUEST_PATHS.some((item) => lowerPath.includes(item) || lowerRaw.includes(item));
};

const statusFromCode = (statusCode?: number): UsageRequestStatus => {
  if (!statusCode) return 'unknown';
  return statusCode >= 200 && statusCode < 300 ? 'success' : 'failure';
};

const pendingTokenUsage = (detailStatus: UsageRequestDetail['detailStatus']): TokenUsage => {
  if (detailStatus === 'loading') return emptyTokenUsage('loading');
  if (detailStatus === 'error') return emptyTokenUsage('error');
  if (detailStatus === 'unavailable') return emptyTokenUsage('unavailable');
  return emptyTokenUsage('pending');
};

export const buildRequestRecords = (
  lines: string[],
  language: string
): UsageStatsRecord[] =>
  lines
    .map((line, index) => {
      const parsed = parseLogLine(line);
      if (!isModelRequestLog(line, parsed.path)) return null;

      const timestampMs = parseTimestampMs(parsed.timestamp);
      const latencyMs = parseLatencyMs(parsed.latency);
      const status = statusFromCode(parsed.statusCode);
      const endpoint = parsed.path ?? MODEL_REQUEST_PATHS.find((item) => line.includes(item)) ?? '-';
      const source = parsed.ip ?? parsed.source ?? 'local';
      const rowKey = parsed.requestId ?? `${timestampMs ?? 'no-time'}:${index}`;

      return {
        id: `model-request:${rowKey}`,
        timestampMs,
        timeLabel: formatDateTime(timestampMs, language),
        requestId: parsed.requestId ?? null,
        endpoint,
        source,
        status,
        statusCode: parsed.statusCode ?? null,
        statusLabel: parsed.statusCode ? String(parsed.statusCode) : status,
        latency: parsed.latency ?? null,
        latencyMs,
        raw: parsed.raw,
      } satisfies UsageStatsRecord;
    })
    .filter((record): record is UsageStatsRecord => Boolean(record))
    .sort((a, b) => (b.timestampMs ?? 0) - (a.timestampMs ?? 0)) as UsageStatsRecord[];

export const enrichRecord = (
  record: UsageStatsRecord,
  details: Record<string, UsageRequestDetail>
): EnrichedUsageStatsRecord => {
  const detail = record.requestId ? details[record.requestId] : undefined;
  const detailStatus = detail?.detailStatus ?? (record.requestId ? 'pending' : 'unavailable');
  const configuredModel = detail?.configuredModel ?? null;
  const upstreamModel = detail?.upstreamModel ?? null;
  const actualModel = detail?.actualModel ?? null;
  const tokenUsage = detail?.tokenUsage ?? pendingTokenUsage(detailStatus);

  return {
    ...record,
    configuredModel,
    upstreamModel,
    actualModel,
    detailStatus,
    modelMatch: resolveModelMatch(detailStatus, configuredModel, actualModel),
    tokenUsage,
    detail,
  };
};

const calculateP95 = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
};

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

export const buildModelOptions = (records: EnrichedUsageStatsRecord[]): string[] => {
  const values = new Set<string>();
  records.forEach((record) => {
    if (record.configuredModel) values.add(record.configuredModel);
    if (record.actualModel) values.add(record.actualModel);
  });
  return Array.from(values).sort((a, b) => a.localeCompare(b));
};

export const buildSourceOptions = (records: EnrichedUsageStatsRecord[]): string[] => {
  const values = new Set<string>();
  records.forEach((record) => values.add(record.endpoint));
  return Array.from(values).sort((a, b) => a.localeCompare(b));
};

export const filterUsageRecords = (
  records: EnrichedUsageStatsRecord[],
  filters: UsageStatsFilters,
  deferredSearch: string
): EnrichedUsageStatsRecord[] => {
  const search = deferredSearch.trim().toLowerCase();
  const selectedModel = filters.model.trim().toLowerCase();
  const selectedSource = filters.source.trim().toLowerCase();

  return records.filter((record) => {
    if (filters.status !== 'all' && record.status !== filters.status) {
      return false;
    }
    if (filters.onlyErrors && record.status !== 'failure') return false;
    if (filters.onlyMismatches && record.modelMatch !== 'mismatch') return false;
    if (
      filters.onlyUnparsed &&
      record.detailStatus !== 'pending' &&
      record.detailStatus !== 'loading'
    ) {
      return false;
    }
    if (
      selectedModel &&
      normalizeModelForCompare(record.configuredModel) !== selectedModel &&
      normalizeModelForCompare(record.actualModel) !== selectedModel
    ) {
      return false;
    }
    if (selectedSource && record.endpoint.toLowerCase() !== selectedSource) return false;

    if (!search) return true;
    const haystack = [
      record.timeLabel,
      record.requestId,
      record.endpoint,
      record.source,
      record.configuredModel,
      record.actualModel,
      getStatusLabel(record.status, record.statusCode),
      getMatchLabel(record.modelMatch),
      getDetailStatusLabel(record.detailStatus),
      record.detail?.authLabel,
      record.detail?.provider,
      record.detail?.errorSummary,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(search);
  });
};

export const getAutoDetailIds = (
  baseRecords: UsageStatsRecord[],
  deferredSearch: string,
  limit: number
): string[] => {
  const search = deferredSearch.trim().toLowerCase();

  return baseRecords
    .filter((record) => {
      if (!record.requestId) return false;
      if (!search) return true;
      return [record.timeLabel, record.requestId, record.endpoint, record.source, record.statusLabel]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
        .includes(search);
    })
    .slice(0, limit)
    .map((record) => record.requestId)
    .filter((id): id is string => Boolean(id));
};

export const calculateAggregateTotals = (
  usage: ApiKeyUsageResponse | null
): AggregateTotals => {
  let success = 0;
  let failure = 0;
  if (usage) {
    Object.values(usage).forEach((apiKeys) => {
      Object.values(apiKeys ?? {}).forEach((entry) => {
        const normalized = normalizeRecentRequestUsageEntry(entry);
        success += normalized.success;
        failure += normalized.failed;
      });
    });
  }
  const total = success + failure;
  return {
    success,
    failure,
    total,
    successRate: total > 0 ? (success / total) * 100 : 0,
  };
};

export const calculateRequestMetrics = (
  records: EnrichedUsageStatsRecord[]
): RequestMetrics => {
  const total = records.length;
  const success = records.filter((record) => record.status === 'success').length;
  const failure = records.filter((record) => record.status === 'failure').length;
  const verified = records.filter(
    (record) => record.modelMatch === 'match' || record.modelMatch === 'mismatch'
  ).length;
  const mismatch = records.filter((record) => record.modelMatch === 'mismatch').length;
  const latencyValues = records
    .map((record) => record.latencyMs)
    .filter((value): value is number => value !== null);
  const avg =
    latencyValues.length > 0
      ? latencyValues.reduce((totalLatency, value) => totalLatency + value, 0) /
        latencyValues.length
      : null;

  return {
    total,
    success,
    failure,
    successRate: total > 0 ? (success / total) * 100 : 0,
    verified,
    mismatch,
    avgLatency: avg,
    p95Latency: calculateP95(latencyValues),
  };
};

export const calculateTokenUsageMetrics = (
  records: EnrichedUsageStatsRecord[]
): TokenUsageMetrics => {
  let input = 0;
  let output = 0;
  let cached = 0;
  let reasoning = 0;
  let total = 0;
  let maxTotal = 0;
  let maxRequestId: string | null = null;
  let maxModel: string | null = null;

  const totalRequests = records.length;
  const parsedRequests = records.filter(
    (record) => record.detailStatus !== 'pending' && record.detailStatus !== 'loading'
  ).length;
  const knownRecords = records.filter((record) => record.tokenUsage.status === 'available');

  knownRecords.forEach((record) => {
    input += record.tokenUsage.input;
    output += record.tokenUsage.output;
    cached += record.tokenUsage.cached;
    reasoning += record.tokenUsage.reasoning;
    total += record.tokenUsage.total;
    if (record.tokenUsage.total > maxTotal) {
      maxTotal = record.tokenUsage.total;
      maxRequestId = record.requestId;
      maxModel = record.actualModel ?? record.configuredModel;
    }
  });

  const knownRequests = knownRecords.length;
  const unreportedRequests = records.filter((record) => record.tokenUsage.status === 'unreported').length;

  return {
    totalRequests,
    parsedRequests,
    knownRequests,
    unreportedRequests,
    input,
    output,
    cached,
    reasoning,
    total,
    averagePerKnown: knownRequests > 0 ? total / knownRequests : null,
    maxTotal,
    maxRequestId,
    maxModel,
    coverageRate: totalRequests > 0 ? (knownRequests / totalRequests) * 100 : 0,
    parsedRate: totalRequests > 0 ? (parsedRequests / totalRequests) * 100 : 0,
  };
};

export const buildModelUsage = (
  records: EnrichedUsageStatsRecord[]
): ModelUsageDatum[] => {
  const groups = new Map<string, Omit<ModelUsageDatum, 'percent'>>();

  records.forEach((record) => {
    const model = record.configuredModel ?? UNPARSED_MODEL_LABEL;
    const current = groups.get(model) ?? { model, total: 0, success: 0, failure: 0, tokenTotal: 0 };
    current.total += 1;
    if (record.status === 'success') current.success += 1;
    if (record.status === 'failure') current.failure += 1;
    if (record.tokenUsage.status === 'available') current.tokenTotal += record.tokenUsage.total;
    groups.set(model, current);
  });

  const rows = Array.from(groups.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);
  const maxTotal = Math.max(...rows.map((item) => item.total), 1);
  return rows.map((item) => ({
    ...item,
    percent: clampPercent((item.total / maxTotal) * 100),
  }));
};

const getBucketSizeMs = (start: number, end: number): number => {
  const span = Math.max(end - start, 60 * 60 * 1000);
  if (span <= 60 * 60 * 1000) return 5 * 60 * 1000;
  if (span <= 24 * 60 * 60 * 1000) return 60 * 60 * 1000;
  if (span <= 7 * 24 * 60 * 60 * 1000) return 24 * 60 * 60 * 1000;
  return Math.max(5 * 60 * 1000, Math.ceil(span / 12));
};

const formatBucketLabel = (
  timestampMs: number,
  start: number,
  end: number,
  language: string
): string => {
  const date = new Date(timestampMs);
  const span = Math.max(end - start, 0);
  if (span <= 24 * 60 * 60 * 1000) {
    return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  }
  if (span <= 7 * 24 * 60 * 60 * 1000) {
    return date.toLocaleDateString(language, { month: 'numeric', day: 'numeric' });
  }
  return date.toLocaleDateString(language, { month: 'numeric', day: 'numeric' });
};

export const buildTimelineBuckets = (
  records: EnrichedUsageStatsRecord[],
  language: string
): TimelineBucket[] => {
  const now = Date.now();
  const recordTimes = records
    .map((record) => record.timestampMs)
    .filter((timestamp): timestamp is number => timestamp !== null);
  const end = recordTimes.length > 0 ? Math.max(...recordTimes) : now;
  const fallbackStart = recordTimes.length > 0 ? Math.min(...recordTimes) : end - 60 * 60 * 1000;
  const start = Math.min(fallbackStart, end - 1);
  const bucketSizeMs = getBucketSizeMs(start, end);
  const bucketCount = Math.min(32, Math.max(1, Math.ceil((end - start) / bucketSizeMs)));
  const alignedStart = end - bucketCount * bucketSizeMs;

  const buckets: TimelineBucket[] = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = alignedStart + index * bucketSizeMs;
    return {
      key: String(bucketStart),
      label: formatBucketLabel(bucketStart, start, end, language),
      total: 0,
      success: 0,
      failure: 0,
      unknown: 0,
      avgLatency: null,
      p95Latency: null,
    };
  });
  const latencyValues = new Map<number, number[]>();

  records.forEach((record) => {
    if (record.timestampMs === null || record.timestampMs < alignedStart || record.timestampMs > end) {
      return;
    }
    const index = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((record.timestampMs - alignedStart) / bucketSizeMs))
    );
    const bucket = buckets[index];
    bucket.total += 1;
    if (record.status === 'success') bucket.success += 1;
    else if (record.status === 'failure') bucket.failure += 1;
    else bucket.unknown += 1;

    if (record.latencyMs !== null) {
      const current = latencyValues.get(index) ?? [];
      current.push(record.latencyMs);
      latencyValues.set(index, current);
    }
  });

  buckets.forEach((bucket, index) => {
    const values = latencyValues.get(index) ?? [];
    if (values.length > 0) {
      bucket.avgLatency = values.reduce((sum, value) => sum + value, 0) / values.length;
      bucket.p95Latency = calculateP95(values);
    }
  });

  return buckets;
};

export const getTimelineMax = (buckets: TimelineBucket[]): number =>
  Math.max(...buckets.map((bucket) => bucket.total), 1);

export const getLatencyMax = (buckets: TimelineBucket[]): number =>
  Math.max(
    ...buckets.flatMap((bucket) =>
      [bucket.avgLatency, bucket.p95Latency].filter((value): value is number => value !== null)
    ),
    1
  );

export const buildModelMatrix = (
  records: EnrichedUsageStatsRecord[],
  limit = MATRIX_ROW_LIMIT
): ModelMatrixDatum[] => {
  const groups = new Map<string, Omit<ModelMatrixDatum, 'percent'>>();

  records.forEach((record) => {
    if (record.detailStatus === 'pending' || record.detailStatus === 'loading') return;
    const configuredModel = record.configuredModel ?? '缺字段';
    const actualModel = record.actualModel ?? '缺字段';
    const key = `${configuredModel}->${actualModel}`;
    const changed =
      configuredModel !== '缺字段' &&
      actualModel !== '缺字段' &&
      normalizeModelForCompare(configuredModel) !== normalizeModelForCompare(actualModel);
    const current =
      groups.get(key) ??
      {
        configuredModel,
        actualModel,
        total: 0,
        success: 0,
        failure: 0,
        changed,
      };
    current.total += 1;
    if (record.status === 'success') current.success += 1;
    if (record.status === 'failure') current.failure += 1;
    groups.set(key, current);
  });

  const rows = Array.from(groups.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
  const maxTotal = Math.max(...rows.map((item) => item.total), 1);
  return rows.map((item) => ({
    ...item,
    percent: clampPercent((item.total / maxTotal) * 100),
  }));
};

export const selectUsageRecord = (
  records: EnrichedUsageStatsRecord[],
  selectedRequestId: string | null
): EnrichedUsageStatsRecord | null =>
  records.find((record) => record.requestId === selectedRequestId) ??
  records.find((record) => Boolean(record.requestId)) ??
  null;
