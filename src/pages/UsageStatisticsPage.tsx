import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconChartLine,
  IconCheck,
  IconDownload,
  IconEye,
  IconInfo,
  IconRefreshCw,
  IconSearch,
  IconSlidersHorizontal,
  IconTimer,
} from '@/components/ui/icons';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { apiKeyUsageApi } from '@/services/api/apiKeyUsage';
import { configApi, logsApi } from '@/services/api';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import { downloadBlob } from '@/utils/download';
import { parseLogLine } from './hooks/logParsing';
import { normalizeRecentRequestUsageEntry, type ApiKeyUsageResponse } from '@/utils/recentRequests';
import type {
  EnrichedUsageStatsRecord,
  ModelMatchStatus,
  UsageRequestDetail,
  UsageRequestDetailStatus,
  UsageRequestStatus,
  UsageStatsFilters,
  UsageStatsRangePreset,
  UsageStatsRecord,
} from '@/types/usageStatistics';
import styles from './UsageStatisticsPage.module.scss';

const DEFAULT_FILTERS: UsageStatsFilters = {
  range: '24h',
  customStart: '',
  customEnd: '',
  search: '',
  status: 'all',
  model: '',
  source: '',
  onlyErrors: false,
  onlyMismatches: false,
  onlyUnparsed: false,
};

const RANGE_OPTIONS: Array<{ value: UsageStatsRangePreset; label: string }> = [
  { value: '1h', label: '最近 1 小时' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: 'custom', label: '自定义' },
];

const REFRESH_INTERVAL_OPTIONS = [
  { value: 8000, label: '8 秒' },
  { value: 15000, label: '15 秒' },
  { value: 30000, label: '30 秒' },
];

const MODEL_REQUEST_PATHS = ['/v1/responses', '/v1/chat/completions', '/v1/messages'];
const MAX_INDEX_LINES = 800;
const PAGE_SIZE = 50;
const AUTO_DETAIL_LIMIT = 24;
const DETAIL_CONCURRENCY = 2;
const MATRIX_ROW_LIMIT = 10;

const emptyDetail = (
  requestId: string,
  detailStatus: UsageRequestDetailStatus,
  errorSummary: string | null = null
): UsageRequestDetail => ({
  requestId,
  detailStatus,
  configuredModel: null,
  upstreamModel: null,
  responseModel: null,
  actualModel: null,
  upstreamUrl: null,
  provider: null,
  authLabel: null,
  authId: null,
  originator: null,
  userAgent: null,
  upstreamStatusCode: null,
  finalStatusCode: null,
  errorSummary,
  loadedAt: detailStatus === 'loading' ? null : Date.now(),
});

const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return '';
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
};

const getErrorStatus = (err: unknown): number | null => {
  if (!err || typeof err !== 'object') return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
};

const parseTimestampMs = (value?: string | null): number | null => {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d{10,13}$/.test(trimmed)) {
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return null;
    return trimmed.length === 10 ? parsed * 1000 : parsed;
  }

  const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const formatDateTime = (timestampMs: number | null, language: string): string =>
  timestampMs ? new Date(timestampMs).toLocaleString(language) : '-';

const normalizeModelForCompare = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

const cleanModelValue = (value: string | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim().replace(/^["'`]+|["'`,;}\]]+$/g, '');
  return trimmed && trimmed !== '-' && trimmed !== 'null' ? trimmed : null;
};

const extractFirstModel = (raw: string, patterns: RegExp[]): string | null => {
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const value = cleanModelValue(match?.[1]);
    if (value) return value;
  }
  return null;
};

const extractConfiguredModel = (raw: string): string | null =>
  extractFirstModel(raw, [
    /"configured[_-]?model"\s*:\s*"([^"]+)"/i,
    /"requested[_-]?model"\s*:\s*"([^"]+)"/i,
    /\b(?:configured|requested)\s+model\s*[:=]\s*([A-Za-z0-9._:/+-]+)/i,
    /"model"\s*:\s*"([^"]+)"/i,
    /\bmodel\s*[:=]\s*([A-Za-z0-9._:/+-]+)/i,
  ]);

const extractActualModel = (raw: string): string | null =>
  extractFirstModel(raw, [
    /"actual[_-]?model"\s*:\s*"([^"]+)"/i,
    /"upstream[_-]?model"\s*:\s*"([^"]+)"/i,
    /"target[_-]?model"\s*:\s*"([^"]+)"/i,
    /\b(?:actual|upstream|routed|selected|target)\s+model\s*[:=]\s*([A-Za-z0-9._:/+-]+)/i,
    /\bmapped\s+(?:to|model)\s*[:=]?\s*([A-Za-z0-9._:/+-]+)/i,
    /"model"\s*:\s*"([^"]+)"/i,
  ]);

const firstValue = <T,>(values: Array<T | null | undefined>): T | null =>
  values.find((value): value is T => value !== null && value !== undefined) ?? null;

const extractField = (raw: string, name: string): string | null => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = raw.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() || null;
};

const extractStatusCode = (raw: string): number | null => {
  const value = extractField(raw, 'Status');
  if (value) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  const match = raw.match(/\bstatus\s*[:=]\s*([1-5]\d{2})\b/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseLatencyMs = (value?: string | null): number | null => {
  if (!value) return null;
  const normalized = value.trim().replace(/\s+/g, '');
  const matches = Array.from(normalized.matchAll(/(\d+(?:\.\d+)?)(µs|us|ms|s|m)/gi));
  if (matches.length === 0) return null;

  return matches.reduce((total, match) => {
    const amount = Number(match[1]);
    const unit = match[2].toLowerCase();
    if (!Number.isFinite(amount)) return total;
    if (unit === 'm') return total + amount * 60_000;
    if (unit === 's') return total + amount * 1000;
    if (unit === 'ms') return total + amount;
    return total + amount / 1000;
  }, 0);
};

const formatLatency = (latencyMs: number | null): string => {
  if (latencyMs === null) return '-';
  if (latencyMs >= 1000) return `${Math.round((latencyMs / 1000) * 10) / 10}s`;
  return `${Math.round(latencyMs)}ms`;
};

const maskSecret = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '-';
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
};

const splitLogSections = (text: string): Record<string, string> => {
  const regex = /^===\s*([^=\r\n]+?)\s*===\s*$/gm;
  const matches: Array<{ key: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    matches.push({
      key: match[1].trim().toUpperCase(),
      start: match.index,
      end: regex.lastIndex,
    });
  }

  return matches.reduce<Record<string, string>>((sections, item, index) => {
    const next = matches[index + 1];
    sections[item.key] = text.slice(item.end, next?.start ?? text.length).trim();
    return sections;
  }, {});
};

const parseAuthLine = (raw: string): Pick<UsageRequestDetail, 'provider' | 'authLabel' | 'authId'> => {
  const line = extractField(raw, 'Auth');
  if (!line) {
    return { provider: null, authLabel: null, authId: null };
  }

  const pairs = Array.from(line.matchAll(/([a-z_]+)=([^,]+)/gi)).reduce<Record<string, string>>(
    (result, match) => {
      result[match[1].toLowerCase()] = match[2].trim();
      return result;
    },
    {}
  );

  return {
    provider: pairs.provider ?? null,
    authLabel: pairs.label ?? null,
    authId: pairs.auth_id ?? null,
  };
};

const extractErrorSummary = (sections: string[]): string | null => {
  for (const section of sections) {
    const messageMatch = section.match(/"message"\s*:\s*"([^"]{1,260})"/i);
    if (messageMatch && !/success/i.test(messageMatch[1])) return messageMatch[1];

    const line = section
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => {
        if (!item) return false;
        if (/"error"\s*:\s*null/i.test(item)) return false;
        return /\b(error|failed|failure|timeout|rate[-\s]?limit|unauthorized|forbidden)\b/i.test(item);
      });

    if (line) return line.slice(0, 260);
  }

  return null;
};

const parseDetailLog = (requestId: string, text: string): UsageRequestDetail => {
  const sections = splitLogSections(text);
  const headers = sections.HEADERS ?? '';
  const requestBody = sections['REQUEST BODY'] ?? '';
  const apiRequestSections = Object.entries(sections)
    .filter(([key]) => key.startsWith('API REQUEST'))
    .map(([, value]) => value);
  const apiResponseSections = Object.entries(sections)
    .filter(([key]) => key.startsWith('API RESPONSE'))
    .map(([, value]) => value);
  const responseSection = sections.RESPONSE ?? '';
  const firstApiRequest = apiRequestSections[0] ?? '';
  const firstApiResponse = apiResponseSections[0] ?? '';

  const configuredModel = extractConfiguredModel(requestBody);
  const upstreamModel = firstValue(apiRequestSections.map((section) => extractConfiguredModel(section)));
  const responseModel = firstValue([
    ...apiResponseSections.map((section) => extractActualModel(section)),
    extractActualModel(responseSection),
  ]);
  const actualModel = responseModel ?? upstreamModel;
  const auth = parseAuthLine(firstApiRequest);
  const detailStatus: UsageRequestDetailStatus =
    configuredModel && actualModel ? 'ready' : 'missing-fields';

  return {
    requestId,
    detailStatus,
    configuredModel,
    upstreamModel,
    responseModel,
    actualModel,
    upstreamUrl: extractField(firstApiRequest, 'Upstream URL'),
    provider: auth.provider,
    authLabel: auth.authLabel,
    authId: auth.authId,
    originator: extractField(headers, 'Originator'),
    userAgent: extractField(headers, 'User-Agent'),
    upstreamStatusCode: extractStatusCode(firstApiResponse),
    finalStatusCode: extractStatusCode(responseSection),
    errorSummary: extractErrorSummary([firstApiResponse, responseSection]),
    loadedAt: Date.now(),
  };
};

const responseDataToText = async (data: unknown): Promise<string> => {
  if (typeof data === 'string') return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return JSON.stringify(data ?? '');
};

const responseDataToBlob = (data: unknown): Blob => {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return new Blob([data], { type: 'text/plain' });
  if (typeof data === 'string') return new Blob([data], { type: 'text/plain' });
  return new Blob([JSON.stringify(data ?? '')], { type: 'text/plain' });
};

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

const buildRequestRecords = (lines: string[], language: string): UsageStatsRecord[] =>
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

const getRangeWindow = (filters: UsageStatsFilters): { start: number | null; end: number | null } => {
  const now = Date.now();
  if (filters.range === '1h') return { start: now - 60 * 60 * 1000, end: now };
  if (filters.range === '24h') return { start: now - 24 * 60 * 60 * 1000, end: now };
  if (filters.range === '7d') return { start: now - 7 * 24 * 60 * 60 * 1000, end: now };

  return {
    start: parseTimestampMs(filters.customStart),
    end: parseTimestampMs(filters.customEnd),
  };
};

const resolveModelMatch = (
  detailStatus: UsageRequestDetailStatus,
  configuredModel: string | null,
  actualModel: string | null
): ModelMatchStatus => {
  if (detailStatus === 'pending' || detailStatus === 'loading') return 'pending';
  if (detailStatus === 'unavailable' || detailStatus === 'error') return 'unavailable';

  const configured = normalizeModelForCompare(configuredModel);
  const actual = normalizeModelForCompare(actualModel);
  if (!configured || !actual) return 'missing';
  return configured === actual ? 'match' : 'mismatch';
};

const getMatchLabel = (status: ModelMatchStatus): string => {
  if (status === 'match') return '没改写';
  if (status === 'mismatch') return '被改写';
  if (status === 'missing') return '日志缺字段';
  if (status === 'unavailable') return '无详情';
  return '还没核验';
};

const getDetailStatusLabel = (status: UsageRequestDetailStatus): string => {
  if (status === 'loading') return '正在核验';
  if (status === 'ready') return '已核验';
  if (status === 'missing-fields') return '日志缺字段';
  if (status === 'unavailable') return '无详情';
  if (status === 'error') return '详情错误';
  return '还没核验';
};

const getStatusLabel = (status: UsageRequestStatus, statusCode: number | null): string => {
  if (statusCode) return String(statusCode);
  if (status === 'success') return '成功';
  if (status === 'failure') return '错误';
  return '未知';
};

const enrichRecord = (
  record: UsageStatsRecord,
  details: Record<string, UsageRequestDetail>
): EnrichedUsageStatsRecord => {
  const detail = record.requestId ? details[record.requestId] : undefined;
  const detailStatus = detail?.detailStatus ?? (record.requestId ? 'pending' : 'unavailable');
  const configuredModel = detail?.configuredModel ?? null;
  const upstreamModel = detail?.upstreamModel ?? null;
  const actualModel = detail?.actualModel ?? null;

  return {
    ...record,
    configuredModel,
    upstreamModel,
    actualModel,
    detailStatus,
    modelMatch: resolveModelMatch(detailStatus, configuredModel, actualModel),
    detail,
  };
};

const calculateP95 = (values: number[]): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index];
};

const formatPercent = (value: number): string => `${Math.round(value * 10) / 10}%`;
const UNPARSED_MODEL_LABEL = '还没核验';

interface ModelUsageDatum {
  model: string;
  total: number;
  success: number;
  failure: number;
  percent: number;
}

interface TimelineBucket {
  key: string;
  label: string;
  total: number;
  success: number;
  failure: number;
  unknown: number;
  avgLatency: number | null;
  p95Latency: number | null;
}

const clampPercent = (value: number): number => Math.min(100, Math.max(0, value));

const formatRangePlainLabel = (filters: UsageStatsFilters): string => {
  if (filters.range === '1h') return '最近 1 小时';
  if (filters.range === '24h') return '最近 24 小时';
  if (filters.range === '7d') return '最近 7 天';
  return '自定义时间段';
};

const getBucketSizeMs = (filters: UsageStatsFilters, start: number, end: number): number => {
  if (filters.range === '1h') return 5 * 60 * 1000;
  if (filters.range === '24h') return 60 * 60 * 1000;
  if (filters.range === '7d') return 24 * 60 * 60 * 1000;
  const span = Math.max(end - start, 60 * 60 * 1000);
  return Math.max(5 * 60 * 1000, Math.ceil(span / 12));
};

const formatBucketLabel = (timestampMs: number, filters: UsageStatsFilters, language: string): string => {
  const date = new Date(timestampMs);
  if (filters.range === '1h') {
    return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  }
  if (filters.range === '24h') {
    return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString(language, { month: 'numeric', day: 'numeric' });
};

const buildModelUsage = (records: EnrichedUsageStatsRecord[]): ModelUsageDatum[] => {
  const groups = new Map<string, Omit<ModelUsageDatum, 'percent'>>();

  records.forEach((record) => {
    const model = record.configuredModel ?? UNPARSED_MODEL_LABEL;
    const current = groups.get(model) ?? { model, total: 0, success: 0, failure: 0 };
    current.total += 1;
    if (record.status === 'success') current.success += 1;
    if (record.status === 'failure') current.failure += 1;
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

const buildTimelineBuckets = (
  records: EnrichedUsageStatsRecord[],
  filters: UsageStatsFilters,
  language: string
): TimelineBucket[] => {
  const { start: rangeStart, end: rangeEnd } = getRangeWindow(filters);
  const now = Date.now();
  const recordTimes = records
    .map((record) => record.timestampMs)
    .filter((timestamp): timestamp is number => timestamp !== null);
  const end = rangeEnd ?? now;
  const fallbackStart = recordTimes.length > 0 ? Math.min(...recordTimes) : end - 24 * 60 * 60 * 1000;
  const start = Math.min(rangeStart ?? fallbackStart, end - 1);
  const bucketSizeMs = getBucketSizeMs(filters, start, end);
  const bucketCount = Math.min(32, Math.max(1, Math.ceil((end - start) / bucketSizeMs)));
  const alignedStart = end - bucketCount * bucketSizeMs;

  const buckets: TimelineBucket[] = Array.from({ length: bucketCount }, (_, index) => {
    const bucketStart = alignedStart + index * bucketSizeMs;
    return {
      key: String(bucketStart),
      label: formatBucketLabel(bucketStart, filters, language),
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
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((record.timestampMs - alignedStart) / bucketSizeMs)));
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

export function UsageStatisticsPage() {
  const { t, i18n } = useTranslation();
  const { showNotification } = useNotificationStore();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const clearCache = useConfigStore((state) => state.clearCache);
  const updateConfigValue = useConfigStore((state) => state.updateConfigValue);

  const requestLogEnabled = config?.requestLog ?? false;
  const [filters, setFilters] = useLocalStorage<UsageStatsFilters>(
    'usageStatistics.filters',
    DEFAULT_FILTERS
  );
  const [autoRefresh, setAutoRefresh] = useLocalStorage('usageStatistics.autoRefresh', false);
  const [refreshInterval, setRefreshInterval] = useLocalStorage(
    'usageStatistics.refreshInterval',
    15000
  );

  const [usage, setUsage] = useState<ApiKeyUsageResponse | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [requestDetails, setRequestDetails] = useState<Record<string, UsageRequestDetail>>({});
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [enablingRequestLog, setEnablingRequestLog] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const latestTimestampRef = useRef<number>(0);
  const logRequestInFlightRef = useRef(false);
  const detailInFlightRef = useRef<Set<string>>(new Set());
  const requestDetailsRef = useRef<Record<string, UsageRequestDetail>>({});

  useEffect(() => {
    requestDetailsRef.current = requestDetails;
  }, [requestDetails]);

  const normalizedFilters = useMemo(() => ({ ...DEFAULT_FILTERS, ...filters }), [filters]);
  const deferredSearch = useDeferredValue(normalizedFilters.search);
  const activeRangeKey = [
    normalizedFilters.range,
    normalizedFilters.customStart,
    normalizedFilters.customEnd,
    normalizedFilters.status,
    normalizedFilters.model,
    normalizedFilters.source,
    normalizedFilters.onlyErrors,
    normalizedFilters.onlyMismatches,
    normalizedFilters.onlyUnparsed,
    deferredSearch,
  ].join('|');

  const setFilterValue = <K extends keyof UsageStatsFilters>(
    key: K,
    value: UsageStatsFilters[K]
  ) => {
    setFilters((prev) => ({ ...DEFAULT_FILTERS, ...prev, [key]: value }));
  };

  const loadRequestDetails = useCallback(
    async (ids: string[], force = false) => {
      const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
      const candidates = uniqueIds.filter((id) => {
        if (detailInFlightRef.current.has(id)) return false;
        if (!force && requestDetailsRef.current[id]) return false;
        return true;
      });

      if (candidates.length === 0) return;

      candidates.forEach((id) => detailInFlightRef.current.add(id));
      setRequestDetails((prev) => {
        const next = { ...prev };
        candidates.forEach((id) => {
          next[id] = emptyDetail(id, 'loading');
        });
        return next;
      });

      const queue = [...candidates];
      const workerCount = Math.min(DETAIL_CONCURRENCY, queue.length);
      const workers = Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          const id = queue.shift();
          if (!id) return;

          try {
            const response = await logsApi.downloadRequestLogById(id);
            const text = await responseDataToText((response as { data?: unknown }).data);
            const detail = parseDetailLog(id, text);
            setRequestDetails((prev) => ({ ...prev, [id]: detail }));
          } catch (err: unknown) {
            const status = getErrorStatus(err);
            const message = getErrorMessage(err);
            setRequestDetails((prev) => ({
              ...prev,
              [id]: emptyDetail(
                id,
                status === 404 ? 'unavailable' : 'error',
                message || (status === 404 ? '后端没有找到对应详情日志' : '详情解析失败')
              ),
            }));
          } finally {
            detailInFlightRef.current.delete(id);
          }
        }
      });

      await Promise.all(workers);
    },
    []
  );

  const loadUsageStats = useCallback(
    async (incremental = false) => {
      if (connectionStatus !== 'connected') {
        setLoading(false);
        setRefreshing(false);
        return;
      }

      if (logRequestInFlightRef.current) return;
      logRequestInFlightRef.current = true;
      if (incremental) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError('');

      try {
        const logsParams =
          incremental && latestTimestampRef.current > 0 ? { after: latestTimestampRef.current } : {};
        const usagePromise = apiKeyUsageApi.getUsage();
        const logsPromise = requestLogEnabled ? logsApi.fetchLogs(logsParams) : Promise.resolve(null);

        const [usageResult, logsResult] = await Promise.allSettled([usagePromise, logsPromise]);

        if (usageResult.status === 'fulfilled') {
          setUsage(usageResult.value);
        } else if (!incremental) {
          setUsage(null);
          setError(getErrorMessage(usageResult.reason) || '后端累计统计读取失败');
        }

        if (logsResult.status === 'fulfilled' && logsResult.value) {
          const lines = Array.isArray(logsResult.value.lines) ? logsResult.value.lines : [];
          if (logsResult.value['latest-timestamp']) {
            latestTimestampRef.current = logsResult.value['latest-timestamp'];
          }
          setLogLines((prev) => {
            const combined = incremental ? [...prev, ...lines] : lines;
            return combined.slice(-MAX_INDEX_LINES);
          });
        } else if (requestLogEnabled && !incremental) {
          setLogLines([]);
        }
      } catch (err: unknown) {
        if (!incremental) setError(getErrorMessage(err) || '模型请求统计加载失败');
      } finally {
        setLoading(false);
        setRefreshing(false);
        logRequestInFlightRef.current = false;
      }
    },
    [connectionStatus, requestLogEnabled]
  );

  useEffect(() => {
    fetchConfig().catch(() => {
      // Login flow handles connection errors.
    });
  }, [fetchConfig]);

  useEffect(() => {
    latestTimestampRef.current = 0;
    void loadUsageStats(false);
  }, [loadUsageStats]);

  useEffect(() => {
    if (!autoRefresh || connectionStatus !== 'connected') return;
    const timer = window.setInterval(() => {
      void loadUsageStats(true);
    }, refreshInterval);
    return () => window.clearInterval(timer);
  }, [autoRefresh, connectionStatus, loadUsageStats, refreshInterval]);

  const baseRecords = useMemo(
    () => (requestLogEnabled ? buildRequestRecords(logLines, i18n.language) : []),
    [i18n.language, logLines, requestLogEnabled]
  );

  const enrichedRecords = useMemo(
    () => baseRecords.map((record) => enrichRecord(record, requestDetails)),
    [baseRecords, requestDetails]
  );

  const modelOptions = useMemo(() => {
    const values = new Set<string>();
    enrichedRecords.forEach((record) => {
      if (record.configuredModel) values.add(record.configuredModel);
      if (record.actualModel) values.add(record.actualModel);
    });
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [enrichedRecords]);

  const sourceOptions = useMemo(() => {
    const values = new Set<string>();
    enrichedRecords.forEach((record) => values.add(record.endpoint));
    return Array.from(values).sort((a, b) => a.localeCompare(b));
  }, [enrichedRecords]);

  const filteredRecords = useMemo(() => {
    const { start, end } = getRangeWindow(normalizedFilters);
    const search = deferredSearch.trim().toLowerCase();
    const selectedModel = normalizedFilters.model.trim().toLowerCase();
    const selectedSource = normalizedFilters.source.trim().toLowerCase();

    return enrichedRecords.filter((record) => {
      if (record.timestampMs !== null) {
        if (start !== null && record.timestampMs < start) return false;
        if (end !== null && record.timestampMs > end) return false;
      }

      if (normalizedFilters.status !== 'all' && record.status !== normalizedFilters.status) {
        return false;
      }
      if (normalizedFilters.onlyErrors && record.status !== 'failure') return false;
      if (normalizedFilters.onlyMismatches && record.modelMatch !== 'mismatch') return false;
      if (
        normalizedFilters.onlyUnparsed &&
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
  }, [deferredSearch, enrichedRecords, normalizedFilters]);

  useEffect(() => {
    setPage(1);
  }, [activeRangeKey]);

  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pagedRecords = useMemo(
    () => filteredRecords.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredRecords, safePage]
  );

  const autoDetailIds = useMemo(() => {
    const { start, end } = getRangeWindow(normalizedFilters);
    const search = deferredSearch.trim().toLowerCase();

    return baseRecords
      .filter((record) => {
        if (!record.requestId) return false;
        if (record.timestampMs !== null) {
          if (start !== null && record.timestampMs < start) return false;
          if (end !== null && record.timestampMs > end) return false;
        }
        if (!search) return true;
        return [record.timeLabel, record.requestId, record.endpoint, record.source, record.statusLabel]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(search);
      })
      .slice(0, AUTO_DETAIL_LIMIT)
      .map((record) => record.requestId)
      .filter((id): id is string => Boolean(id));
  }, [baseRecords, deferredSearch, normalizedFilters]);

  useEffect(() => {
    void loadRequestDetails(autoDetailIds);
  }, [autoDetailIds, loadRequestDetails]);

  useEffect(() => {
    if (!selectedRequestId && filteredRecords[0]?.requestId) {
      setSelectedRequestId(filteredRecords[0].requestId);
    }
  }, [filteredRecords, selectedRequestId]);

  const aggregateTotals = useMemo(() => {
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
  }, [usage]);

  const requestMetrics = useMemo(() => {
    const total = filteredRecords.length;
    const success = filteredRecords.filter((record) => record.status === 'success').length;
    const failure = filteredRecords.filter((record) => record.status === 'failure').length;
    const verified = filteredRecords.filter(
      (record) => record.modelMatch === 'match' || record.modelMatch === 'mismatch'
    ).length;
    const mismatch = filteredRecords.filter((record) => record.modelMatch === 'mismatch').length;
    const latencyValues = filteredRecords
      .map((record) => record.latencyMs)
      .filter((value): value is number => value !== null);
    const avg =
      latencyValues.length > 0
        ? latencyValues.reduce((totalLatency, value) => totalLatency + value, 0) / latencyValues.length
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
  }, [filteredRecords]);

  const rangeLabel = formatRangePlainLabel(normalizedFilters);

  const modelUsage = useMemo(() => buildModelUsage(filteredRecords), [filteredRecords]);

  const timelineBuckets = useMemo(
    () => buildTimelineBuckets(filteredRecords, normalizedFilters, i18n.language),
    [filteredRecords, i18n.language, normalizedFilters]
  );

  const timelineMax = useMemo(
    () => Math.max(...timelineBuckets.map((bucket) => bucket.total), 1),
    [timelineBuckets]
  );

  const latencyMax = useMemo(
    () =>
      Math.max(
        ...timelineBuckets.flatMap((bucket) =>
          [bucket.avgLatency, bucket.p95Latency].filter((value): value is number => value !== null)
        ),
        1
      ),
    [timelineBuckets]
  );

  const modelMatrix = useMemo(() => {
    const groups = new Map<
      string,
      {
        configuredModel: string;
        actualModel: string;
        total: number;
        success: number;
        failure: number;
        changed: boolean;
      }
    >();

    filteredRecords.forEach((record) => {
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
      .slice(0, MATRIX_ROW_LIMIT);
    const maxTotal = Math.max(...rows.map((item) => item.total), 1);
    return rows.map((item) => ({
      ...item,
      percent: clampPercent((item.total / maxTotal) * 100),
    }));
  }, [filteredRecords]);

  const selectedRecord = useMemo(
    () =>
      filteredRecords.find((record) => record.requestId === selectedRequestId) ??
      filteredRecords.find((record) => Boolean(record.requestId)) ??
      null,
    [filteredRecords, selectedRequestId]
  );

  const handleEnableRequestLog = async () => {
    if (connectionStatus !== 'connected' || !config) return;
    const previous = requestLogEnabled;
    setEnablingRequestLog(true);
    updateConfigValue('request-log', true);
    try {
      await configApi.updateRequestLog(true);
      clearCache('request-log');
      await fetchConfig(undefined, true);
      showNotification('请求日志已开启，后续模型请求会进入统计页', 'success');
    } catch (err: unknown) {
      updateConfigValue('request-log', previous);
      const message = getErrorMessage(err);
      showNotification(`开启请求日志失败${message ? `: ${message}` : ''}`, 'error');
    } finally {
      setEnablingRequestLog(false);
    }
  };

  const handleDownloadRequestLog = async (requestId: string) => {
    setDownloadingId(requestId);
    try {
      const response = await logsApi.downloadRequestLogById(requestId);
      const blob = responseDataToBlob((response as { data?: unknown }).data);
      downloadBlob({ filename: `request-${requestId}.log`, blob });
      showNotification('请求详情日志已下载', 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      showNotification(`下载请求详情失败${message ? `: ${message}` : ''}`, 'error');
    } finally {
      setDownloadingId(null);
    }
  };

  const handleModelUsageClick = (model: string) => {
    setFilters((prev) => {
      const next = { ...DEFAULT_FILTERS, ...prev };
      if (model === UNPARSED_MODEL_LABEL) {
        return {
          ...next,
          model: '',
          onlyUnparsed: !next.onlyUnparsed,
        };
      }
      return {
        ...next,
        model: next.model === model ? '' : model,
        onlyUnparsed: false,
      };
    });
  };

  const title = t('usage_statistics.title', { defaultValue: '模型请求统计' });

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <div>
          <div className={styles.eyebrow}>MODEL REQUEST RECORDER</div>
          <h1 className={styles.pageTitle}>{title}</h1>
          <p className={styles.pageSubtitle}>
            按请求追踪配置模型、实际上游模型、状态和耗时。详情日志按需解析，不把完整请求内容存进本地存储。
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button
            type="button"
            variant="secondary"
            onClick={() => void loadUsageStats(true)}
            loading={refreshing}
            disabled={connectionStatus !== 'connected'}
          >
            <IconRefreshCw size={16} />
            增量刷新
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => void loadUsageStats(false)}
            loading={loading}
            disabled={connectionStatus !== 'connected'}
          >
            <IconRefreshCw size={16} />
            {t('common.refresh')}
          </Button>
        </div>
      </div>

      <div className={styles.metricsGrid}>
        <Card className={styles.metricCard}>
          <div className={styles.metricIcon}>
            <IconChartLine size={18} />
          </div>
          <div>
            <div className={styles.metricLabel}>模型请求</div>
            <div className={styles.metricValue}>{requestMetrics.total}</div>
            <div className={styles.metricHint}>
              {rangeLabel}里一共发起 {requestMetrics.total} 次模型请求。
            </div>
          </div>
        </Card>
        <Card className={styles.metricCard}>
          <div className={styles.metricIcon}>
            <IconCheck size={18} />
          </div>
          <div>
            <div className={styles.metricLabel}>成功 / 错误</div>
            <div className={styles.metricValue}>
              {requestMetrics.success}
              <span> / {requestMetrics.failure}</span>
            </div>
            <div className={styles.metricHint}>
              成功 {requestMetrics.success} 次，错误 {requestMetrics.failure} 次，成功率{' '}
              {formatPercent(requestMetrics.successRate)}。
            </div>
          </div>
        </Card>
        <Card className={styles.metricCard}>
          <div className={styles.metricIcon}>
            <IconTimer size={18} />
          </div>
          <div>
            <div className={styles.metricLabel}>慢请求参考 / 平均速度</div>
            <div className={styles.metricValue}>
              {formatLatency(requestMetrics.p95Latency)}
              <span> / {formatLatency(requestMetrics.avgLatency)}</span>
            </div>
            <div className={styles.metricHint}>P95 表示 100 次里最慢那 5 次大概多慢。</div>
          </div>
        </Card>
        <Card className={styles.metricCard}>
          <div className={styles.metricIcon}>
            <IconEye size={18} />
          </div>
          <div>
            <div className={styles.metricLabel}>已确认是否被改写</div>
            <div className={styles.metricValue}>
              {requestMetrics.verified}
              <span> / {requestMetrics.mismatch} 被改写</span>
            </div>
            <div className={styles.metricHint}>
              拉到详情日志后，才能知道配置模型和实际模型是否一致。
            </div>
          </div>
        </Card>
        <Card className={styles.metricCard}>
          <div className={styles.metricIcon}>
            <IconInfo size={18} />
          </div>
          <div>
            <div className={styles.metricLabel}>后端总账</div>
            <div className={styles.metricValue}>{aggregateTotals.total}</div>
            <div className={styles.metricHint}>
              后端保存的总成功/失败，不一定等于当前时间筛选。
            </div>
          </div>
        </Card>
      </div>

      <div className={styles.chartGrid}>
        <Card className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <div>
              <h2>模型用量柱状图</h2>
              <p>看这段时间主要在用哪个模型。点柱子可以直接筛选。</p>
            </div>
            <span>Top {modelUsage.length || 0}</span>
          </div>
          {modelUsage.length === 0 ? (
            <EmptyState title="暂无模型用量" description="换个时间范围，或发起一次模型请求。" />
          ) : (
            <div className={styles.modelBars}>
              {modelUsage.map((item) => {
                const active =
                  item.model === UNPARSED_MODEL_LABEL
                    ? normalizedFilters.onlyUnparsed
                    : normalizedFilters.model === item.model;
                return (
                  <button
                    key={item.model}
                    type="button"
                    className={`${styles.modelBarRow} ${active ? styles.modelBarRowActive : ''}`}
                    onClick={() => handleModelUsageClick(item.model)}
                    aria-pressed={active}
                  >
                    <span className={styles.modelBarName} title={item.model}>
                      {item.model}
                    </span>
                    <span className={styles.modelBarTrack}>
                      <span className={styles.modelBarFill} style={{ width: `${item.percent}%` }} />
                    </span>
                    <span className={styles.modelBarMeta}>
                      {item.total} 次 · 错误 {item.failure}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <Card className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <div>
              <h2>成功 / 错误时间分布</h2>
              <p>看请求是在什么时候集中爆发，红色越多说明错误越集中。</p>
            </div>
            <span>{rangeLabel}</span>
          </div>
          <div className={styles.stackedBars} aria-label="成功和错误时间分布">
            {timelineBuckets.map((bucket) => {
              const height = bucket.total > 0 ? Math.max(8, (bucket.total / timelineMax) * 100) : 2;
              const successHeight = bucket.total > 0 ? (bucket.success / bucket.total) * 100 : 0;
              const failureHeight = bucket.total > 0 ? (bucket.failure / bucket.total) * 100 : 0;
              const unknownHeight = bucket.total > 0 ? (bucket.unknown / bucket.total) * 100 : 0;
              return (
                <div
                  key={bucket.key}
                  className={styles.stackedBarColumn}
                  title={`${bucket.label}: 成功 ${bucket.success} / 错误 ${bucket.failure} / 未知 ${bucket.unknown}`}
                >
                  <div className={styles.stackedBarTrack}>
                    <div className={styles.stackedBarFill} style={{ height: `${height}%` }}>
                      {unknownHeight > 0 && (
                        <span className={styles.segmentUnknown} style={{ height: `${unknownHeight}%` }} />
                      )}
                      {failureHeight > 0 && (
                        <span className={styles.segmentFailure} style={{ height: `${failureHeight}%` }} />
                      )}
                      {successHeight > 0 && (
                        <span className={styles.segmentSuccess} style={{ height: `${successHeight}%` }} />
                      )}
                    </div>
                  </div>
                  <span>{bucket.label}</span>
                </div>
              );
            })}
          </div>
          <div className={styles.chartLegend}>
            <span className={styles.legendSuccess}>成功</span>
            <span className={styles.legendFailure}>错误</span>
            <span className={styles.legendUnknown}>未知</span>
          </div>
        </Card>

        <Card className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <div>
              <h2>耗时趋势</h2>
              <p>浅色是平均速度，深色是慢请求参考；柱子越高越慢。</p>
            </div>
            <span>P95 / 平均</span>
          </div>
          <div className={styles.latencyBars} aria-label="耗时趋势">
            {timelineBuckets.map((bucket) => {
              const avgHeight = bucket.avgLatency ? Math.max(5, (bucket.avgLatency / latencyMax) * 100) : 0;
              const p95Height = bucket.p95Latency ? Math.max(5, (bucket.p95Latency / latencyMax) * 100) : 0;
              return (
                <div
                  key={bucket.key}
                  className={styles.latencyColumn}
                  title={`${bucket.label}: P95 ${formatLatency(bucket.p95Latency)} / 平均 ${formatLatency(
                    bucket.avgLatency
                  )}`}
                >
                  <div className={styles.latencyTrack}>
                    {avgHeight > 0 && (
                      <span className={styles.latencyAvg} style={{ height: `${avgHeight}%` }} />
                    )}
                    {p95Height > 0 && (
                      <span className={styles.latencyP95} style={{ height: `${p95Height}%` }} />
                    )}
                  </div>
                  <span>{bucket.label}</span>
                </div>
              );
            })}
          </div>
          <div className={styles.chartLegend}>
            <span className={styles.legendAvg}>平均速度</span>
            <span className={styles.legendP95}>慢请求参考</span>
          </div>
        </Card>

        <Card className={styles.chartCard}>
          <div className={styles.chartHeader}>
            <div>
              <h2>模型改写概览</h2>
              <p>看“你配置的模型”最后有没有被代理改成别的模型。</p>
            </div>
            <span>{requestMetrics.mismatch} 条被改写</span>
          </div>
          {modelMatrix.length === 0 ? (
            <EmptyState title="还没有可核验模型" description="详情解析完成后会显示模型是否被改写。" />
          ) : (
            <div className={styles.rewriteBars}>
              {modelMatrix.slice(0, 6).map((item) => (
                <div
                  key={`${item.configuredModel}-${item.actualModel}`}
                  className={`${styles.rewriteRow} ${item.changed ? styles.rewriteRowChanged : ''}`}
                >
                  <div className={styles.rewriteModels}>
                    <span title={item.configuredModel}>{item.configuredModel}</span>
                    <strong title={item.actualModel}>{item.actualModel}</strong>
                  </div>
                  <div className={styles.rewriteTrack}>
                    <span style={{ width: `${item.percent}%` }} />
                  </div>
                  <div className={styles.rewriteMeta}>
                    <b>{item.total}</b>
                    <small>{item.changed ? '被改写' : '没改写'}</small>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className={styles.controlCard}>
        <div className={styles.controlTopRow}>
          <div className={styles.rangeTabs} role="tablist" aria-label="model request range">
            {RANGE_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`${styles.rangeTab} ${
                  normalizedFilters.range === option.value ? styles.rangeTabActive : ''
                }`}
                onClick={() => setFilterValue('range', option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className={styles.refreshControls}>
            <ToggleSwitch
              checked={autoRefresh}
              onChange={setAutoRefresh}
              label="自动刷新"
              disabled={connectionStatus !== 'connected'}
            />
            <select
              className={styles.selectControl}
              value={refreshInterval}
              onChange={(event) => setRefreshInterval(Number(event.target.value))}
              disabled={!autoRefresh}
              aria-label="刷新间隔"
            >
              {REFRESH_INTERVAL_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        {normalizedFilters.range === 'custom' && (
          <div className={styles.customRange}>
            <Input
              type="datetime-local"
              label="开始时间"
              value={normalizedFilters.customStart}
              onChange={(event) => setFilterValue('customStart', event.target.value)}
            />
            <Input
              type="datetime-local"
              label="结束时间"
              value={normalizedFilters.customEnd}
              onChange={(event) => setFilterValue('customEnd', event.target.value)}
            />
          </div>
        )}

        <div className={styles.filterGrid}>
          <Input
            className={styles.searchInput}
            value={normalizedFilters.search}
            placeholder="搜索请求 ID、模型、来源、认证或错误"
            onChange={(event) => setFilterValue('search', event.target.value)}
            rightElement={<IconSearch size={16} />}
          />
          <select
            className={styles.selectControl}
            value={normalizedFilters.status}
            onChange={(event) =>
              setFilterValue('status', event.target.value as UsageStatsFilters['status'])
            }
            aria-label="状态筛选"
          >
            <option value="all">全部状态</option>
            <option value="success">成功</option>
            <option value="failure">错误</option>
            <option value="unknown">未知</option>
          </select>
          <select
            className={styles.selectControl}
            value={normalizedFilters.model}
            onChange={(event) => setFilterValue('model', event.target.value)}
            aria-label="模型筛选"
          >
            <option value="">全部模型</option>
            {modelOptions.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
          <select
            className={styles.selectControl}
            value={normalizedFilters.source}
            onChange={(event) => setFilterValue('source', event.target.value)}
            aria-label="来源筛选"
          >
            <option value="">全部来源</option>
            {sourceOptions.map((source) => (
              <option key={source} value={source}>
                {source}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.quickFilters}>
          <label>
            <input
              type="checkbox"
              checked={normalizedFilters.onlyErrors}
              onChange={(event) => setFilterValue('onlyErrors', event.target.checked)}
            />
            只看错误
          </label>
          <label>
            <input
              type="checkbox"
              checked={normalizedFilters.onlyMismatches}
              onChange={(event) => setFilterValue('onlyMismatches', event.target.checked)}
            />
            只看被改写的请求
          </label>
          <label>
            <input
              type="checkbox"
              checked={normalizedFilters.onlyUnparsed}
              onChange={(event) => setFilterValue('onlyUnparsed', event.target.checked)}
            />
            只看还没核验的请求
          </label>
        </div>

        <div className={requestLogEnabled ? styles.logStatusOn : styles.logStatusOff}>
          <div>
            <strong>{requestLogEnabled ? '请求日志已开启' : '请求日志未开启'}</strong>
            <span>
              {requestLogEnabled
                ? `首屏自动解析最近 ${AUTO_DETAIL_LIMIT} 条详情；更多请求可以点行按需解析。`
                : '只能看到后端累计成功/失败；要核验模型路由，需要先开启请求日志。'}
            </span>
          </div>
          {!requestLogEnabled && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void handleEnableRequestLog()}
              loading={enablingRequestLog}
              disabled={connectionStatus !== 'connected' || !config}
            >
              开启请求日志
            </Button>
          )}
        </div>

        {error && <div className={styles.errorBanner}>{error}</div>}
      </Card>

      <div className={styles.workbenchGrid}>
        <Card className={styles.tableCard}>
          <div className={styles.tableHeader}>
            <div>
              <h2>模型请求明细</h2>
              <p>
                当前看到的是：{rangeLabel} 的 {filteredRecords.length} 条模型请求。先读取最近{' '}
                {MAX_INDEX_LINES} 行摘要，再按需核验详情；当前第 {safePage} / {pageCount} 页。
              </p>
            </div>
            <span>{filteredRecords.length} 条</span>
          </div>

          {filteredRecords.length === 0 ? (
            <EmptyState
              title={loading ? '正在加载模型请求' : '暂无模型请求'}
              description={
                loading
                  ? '正在读取请求摘要和后端累计统计。'
                  : '可以换个时间范围，或者开启请求日志后发起一次模型请求。'
              }
            />
          ) : (
            <>
              <div className={styles.tableWrap}>
                <table className={styles.usageTable}>
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>请求 ID</th>
                      <th>来源</th>
                      <th>配置模型</th>
                      <th>实际模型</th>
                      <th>状态</th>
                      <th>延迟</th>
                      <th>是否改写</th>
                      <th>详情</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pagedRecords.map((record) => (
                      <tr
                        key={record.id}
                        className={
                          selectedRecord?.id === record.id ? styles.selectedRow : styles.clickableRow
                        }
                        onClick={() => {
                          if (record.requestId) {
                            setSelectedRequestId(record.requestId);
                            void loadRequestDetails([record.requestId]);
                          }
                        }}
                      >
                        <td>{record.timeLabel}</td>
                        <td className={styles.monoCell}>{record.requestId ?? '-'}</td>
                        <td className={styles.sourceCell} title={`${record.endpoint} | ${record.source}`}>
                          <span>{record.endpoint}</span>
                          <small>{record.source}</small>
                        </td>
                        <td className={styles.modelCell}>{record.configuredModel ?? '还没核验'}</td>
                        <td className={styles.modelCell}>{record.actualModel ?? '还没核验'}</td>
                        <td>
                          <span className={`${styles.statusPill} ${styles[`status_${record.status}`]}`}>
                            {getStatusLabel(record.status, record.statusCode)}
                          </span>
                        </td>
                        <td>{record.latency ?? '-'}</td>
                        <td>
                          <span className={`${styles.matchPill} ${styles[`match_${record.modelMatch}`]}`}>
                            {getMatchLabel(record.modelMatch)}
                          </span>
                        </td>
                        <td>
                          <span
                            className={`${styles.detailPill} ${
                              styles[`detail_${record.detailStatus.replace('-', '_')}`]
                            }`}
                          >
                            {getDetailStatusLabel(record.detailStatus)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className={styles.pagination}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={safePage <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  上一页
                </Button>
                <span>
                  {safePage} / {pageCount}
                </span>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={safePage >= pageCount}
                  onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
                >
                  下一页
                </Button>
              </div>
            </>
          )}
        </Card>

        <aside className={styles.sideRail}>
          <Card className={styles.detailCard}>
            <div className={styles.sideHeader}>
              <div>
                <h2>单次请求详情</h2>
                <p>只展示结构化摘要，完整内容需手动下载。</p>
              </div>
              <IconSlidersHorizontal size={18} />
            </div>

            {!selectedRecord ? (
              <EmptyState
                title="还没有选中请求"
                description="点击左侧模型请求即可解析并查看模型链路。"
              />
            ) : (
              <div className={styles.detailBody}>
                <div className={styles.detailIdentity}>
                  <span>{selectedRecord.requestId ?? '-'}</span>
                  <strong>{getStatusLabel(selectedRecord.status, selectedRecord.statusCode)}</strong>
                </div>

                <div className={styles.routeDiagram}>
                  <div>
                    <span>配置模型</span>
                    <strong>{selectedRecord.configuredModel ?? '还没核验'}</strong>
                  </div>
                  <div>
                    <span>上游模型</span>
                    <strong>{selectedRecord.upstreamModel ?? '还没核验'}</strong>
                  </div>
                  <div>
                    <span>返回模型</span>
                    <strong>{selectedRecord.actualModel ?? '还没核验'}</strong>
                  </div>
                </div>

                <dl className={styles.detailList}>
                  <div>
                    <dt>详情状态</dt>
                    <dd>{getDetailStatusLabel(selectedRecord.detailStatus)}</dd>
                  </div>
                  <div>
                    <dt>请求入口</dt>
                    <dd>{selectedRecord.endpoint}</dd>
                  </div>
                  <div>
                    <dt>耗时</dt>
                    <dd>{selectedRecord.latency ?? '-'}</dd>
                  </div>
                  <div>
                    <dt>上游状态</dt>
                    <dd>{selectedRecord.detail?.upstreamStatusCode ?? '-'}</dd>
                  </div>
                  <div>
                    <dt>Provider</dt>
                    <dd>{selectedRecord.detail?.provider ?? '-'}</dd>
                  </div>
                  <div>
                    <dt>认证</dt>
                    <dd title={selectedRecord.detail?.authId ?? undefined}>
                      {selectedRecord.detail?.authLabel ??
                        (selectedRecord.detail?.authId ? maskSecret(selectedRecord.detail.authId) : '-')}
                    </dd>
                  </div>
                  <div>
                    <dt>Originator</dt>
                    <dd>{selectedRecord.detail?.originator ?? '-'}</dd>
                  </div>
                  <div>
                    <dt>上游地址</dt>
                    <dd title={selectedRecord.detail?.upstreamUrl ?? undefined}>
                      {selectedRecord.detail?.upstreamUrl ?? '-'}
                    </dd>
                  </div>
                </dl>

                {selectedRecord.detail?.errorSummary && (
                  <div className={styles.errorSummary}>
                    <strong>错误摘要</strong>
                    <span>{selectedRecord.detail.errorSummary}</span>
                  </div>
                )}

                <div className={styles.detailActions}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!selectedRecord.requestId || selectedRecord.detailStatus === 'loading'}
                    loading={selectedRecord.detailStatus === 'loading'}
                    onClick={() =>
                      selectedRecord.requestId &&
                      void loadRequestDetails([selectedRecord.requestId], true)
                    }
                  >
                    <IconEye size={15} />
                    解析详情
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={!selectedRecord.requestId}
                    loading={downloadingId === selectedRecord.requestId}
                    onClick={() =>
                      selectedRecord.requestId && void handleDownloadRequestLog(selectedRecord.requestId)
                    }
                  >
                    <IconDownload size={15} />
                    下载完整日志
                  </Button>
                </div>
              </div>
            )}
          </Card>

          <Card className={styles.matrixCard}>
            <div className={styles.sideHeader}>
              <div>
                <h2>改写明细排行</h2>
                <p>同一个配置模型最后实际走到了哪里。</p>
              </div>
            </div>
            {modelMatrix.length === 0 ? (
              <EmptyState title="暂无可聚合模型" description="核验详情后会显示模型路由排行。" />
            ) : (
              <div className={styles.matrixList}>
                {modelMatrix.map((item) => (
                  <div
                    key={`${item.configuredModel}-${item.actualModel}`}
                    className={`${styles.matrixRow} ${item.changed ? styles.matrixRowChanged : ''}`}
                  >
                    <div>
                      <span>{item.configuredModel}</span>
                      <strong>{item.actualModel}</strong>
                    </div>
                    <div>
                      <b>{item.total}</b>
                      <small>
                        {item.changed ? '被改写' : '没改写'} · 错误 {item.failure}
                      </small>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </aside>
      </div>
    </div>
  );
}
