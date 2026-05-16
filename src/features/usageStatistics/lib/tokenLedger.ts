import type {
  TokenLedgerEntry,
  TokenLedgerFilters,
  TokenLedgerModelUsageDatum,
} from '@/types/usageStatistics';
import type { TokenUsageMetrics } from './statistics';
import { UNPARSED_MODEL_LABEL } from './constants';
import { formatDateTime, parseTimestampMs } from './formatters';

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfToday = (): number => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
};

const startOfThisMonth = (): number => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
};

export const getTokenLedgerRangeWindow = (
  filters: TokenLedgerFilters
): { start: number | null; end: number | null } => {
  const now = Date.now();
  if (filters.range === 'today') return { start: startOfToday(), end: now };
  if (filters.range === '7d') return { start: now - 7 * DAY_MS, end: now };
  if (filters.range === '30d') return { start: now - 30 * DAY_MS, end: now };
  if (filters.range === 'month') return { start: startOfThisMonth(), end: now };

  return {
    start: parseTimestampMs(filters.customStart),
    end: parseTimestampMs(filters.customEnd),
  };
};

export const formatTokenLedgerRangeLabel = (filters: TokenLedgerFilters): string => {
  if (filters.range === 'today') return '今日';
  if (filters.range === '7d') return '最近 7 天';
  if (filters.range === '30d') return '最近 30 天';
  if (filters.range === 'month') return '本月';
  return '自定义范围';
};

export const filterTokenLedgerEntries = (
  entries: TokenLedgerEntry[],
  filters: TokenLedgerFilters
): TokenLedgerEntry[] => {
  const { start, end } = getTokenLedgerRangeWindow(filters);

  return entries.filter((entry) => {
    if (entry.timestampMs === null) return start === null && end === null;
    if (start !== null && entry.timestampMs < start) return false;
    if (end !== null && entry.timestampMs > end) return false;
    return true;
  });
};

export const calculateTokenLedgerMetrics = (
  entries: TokenLedgerEntry[]
): TokenUsageMetrics => {
  let input = 0;
  let output = 0;
  let cached = 0;
  let reasoning = 0;
  let total = 0;
  let maxTotal = 0;
  let maxRequestId: string | null = null;
  let maxModel: string | null = null;

  const totalRequests = entries.length;
  const parsedRequests = entries.filter((entry) => entry.detailStatus !== 'error').length;
  const knownRecords = entries.filter((entry) => entry.tokenUsage.status === 'available');

  knownRecords.forEach((entry) => {
    input += entry.tokenUsage.input;
    output += entry.tokenUsage.output;
    cached += entry.tokenUsage.cached;
    reasoning += entry.tokenUsage.reasoning;
    total += entry.tokenUsage.total;

    if (entry.tokenUsage.total > maxTotal) {
      maxTotal = entry.tokenUsage.total;
      maxRequestId = entry.requestId ?? entry.fileName;
      maxModel = entry.actualModel ?? entry.configuredModel;
    }
  });

  const knownRequests = knownRecords.length;
  const unreportedRequests = entries.filter(
    (entry) => entry.tokenUsage.status === 'unreported'
  ).length;

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

export const buildTokenLedgerModelUsage = (
  entries: TokenLedgerEntry[]
): TokenLedgerModelUsageDatum[] => {
  const groups = new Map<
    string,
    Omit<TokenLedgerModelUsageDatum, 'percent'>
  >();

  entries.forEach((entry) => {
    const model = entry.actualModel ?? entry.configuredModel ?? UNPARSED_MODEL_LABEL;
    const current = groups.get(model) ?? {
      model,
      requests: 0,
      knownRequests: 0,
      total: 0,
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
    };

    current.requests += 1;
    if (entry.tokenUsage.status === 'available') {
      current.knownRequests += 1;
      current.total += entry.tokenUsage.total;
      current.input += entry.tokenUsage.input;
      current.output += entry.tokenUsage.output;
      current.cached += entry.tokenUsage.cached;
      current.reasoning += entry.tokenUsage.reasoning;
    }
    groups.set(model, current);
  });

  const rows = Array.from(groups.values())
    .filter((item) => item.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 8);
  const tokenTotal = Math.max(
    rows.reduce((sum, item) => sum + item.total, 0),
    1
  );

  return rows.map((item) => ({
    ...item,
    percent: Math.min(100, Math.max(0, (item.total / tokenTotal) * 100)),
  }));
};

export const getTokenLedgerEntrySpan = (
  entries: TokenLedgerEntry[]
): { start: number | null; end: number | null } => {
  const timestamps = entries
    .map((entry) => entry.timestampMs)
    .filter((timestamp): timestamp is number => timestamp !== null);

  if (timestamps.length === 0) return { start: null, end: null };
  return {
    start: Math.min(...timestamps),
    end: Math.max(...timestamps),
  };
};

export const formatTokenLedgerSpan = (
  start: number | null,
  end: number | null,
  language: string
): string => {
  if (start === null || end === null) return '-';
  return `${formatDateTime(start, language)} - ${formatDateTime(end, language)}`;
};
