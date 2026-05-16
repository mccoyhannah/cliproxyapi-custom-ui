import type {
  ModelMatchStatus,
  TokenUsageStatus,
  UsageRequestDetailStatus,
  UsageRequestStatus,
  UsageStatsFilters,
} from '@/types/usageStatistics';

export const parseTimestampMs = (value?: string | null): number | null => {
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

export const formatDateTime = (timestampMs: number | null, language: string): string =>
  timestampMs ? new Date(timestampMs).toLocaleString(language) : '-';

export const normalizeModelForCompare = (value: string | null): string | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized || null;
};

export const parseLatencyMs = (value?: string | null): number | null => {
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

export const formatLatency = (latencyMs: number | null): string => {
  if (latencyMs === null) return '-';
  if (latencyMs >= 1000) return `${Math.round((latencyMs / 1000) * 10) / 10}s`;
  return `${Math.round(latencyMs)}ms`;
};

export const formatTokenCount = (value: number | null): string => {
  if (value === null || value <= 0) return '-';
  if (value >= 1_000_000) return `${Math.round((value / 1_000_000) * 10) / 10}M`;
  if (value >= 1_000) return `${Math.round((value / 1_000) * 10) / 10}K`;
  return String(value);
};

export const formatPercent = (value: number): string => `${Math.round(value * 10) / 10}%`;

export const formatRangePlainLabel = (filters: UsageStatsFilters): string => {
  if (filters.range === '1h') return '最近 1 小时';
  if (filters.range === '24h') return '最近 24 小时';
  if (filters.range === '7d') return '最近 7 天';
  return '自定义时间段';
};

export const maskSecret = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '-';
  if (trimmed.length <= 12) return trimmed;
  return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
};

export const resolveModelMatch = (
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

export const getMatchLabel = (status: ModelMatchStatus): string => {
  if (status === 'match') return '没改写';
  if (status === 'mismatch') return '被改写';
  if (status === 'missing') return '日志缺字段';
  if (status === 'unavailable') return '无详情';
  return '还没核验';
};

export const getDetailStatusLabel = (status: UsageRequestDetailStatus): string => {
  if (status === 'loading') return '正在核验';
  if (status === 'ready') return '已核验';
  if (status === 'missing-fields') return '日志缺字段';
  if (status === 'unavailable') return '无详情';
  if (status === 'error') return '详情错误';
  return '还没核验';
};

export const getTokenStatusLabel = (status: TokenUsageStatus): string => {
  if (status === 'available') return '已上报';
  if (status === 'loading') return '正在解析';
  if (status === 'unreported') return '未上报';
  if (status === 'unavailable') return '无详情';
  if (status === 'error') return '解析错误';
  return '待解析';
};

export const getStatusLabel = (
  status: UsageRequestStatus,
  statusCode: number | null
): string => {
  if (statusCode) return String(statusCode);
  if (status === 'success') return '成功';
  if (status === 'failure') return '错误';
  return '未知';
};

export const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (!err || typeof err !== 'object') return '';
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' ? message : '';
};

export const getErrorStatus = (err: unknown): number | null => {
  if (!err || typeof err !== 'object') return null;
  const status = (err as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
};
