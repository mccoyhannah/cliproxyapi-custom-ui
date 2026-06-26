/**
 * 日志相关 API
 */

import { apiClient } from './client';
import { LOGS_TIMEOUT_MS } from '@/utils/constants';

export type LogCursor = number | string;
export type LogBackendKind = 'legacy' | 'file' | 'home-db' | string;

export interface LogsQuery {
  after?: LogCursor;
  cursor?: string;
  limit?: number;
  offset?: number;
}

export interface LogsResponse {
  lines: string[];
  'line-count': number;
  'latest-timestamp': number;
  lineCount: number;
  latestAfter: LogCursor | null;
  nextCursor: string;
  cursorReset: boolean;
  logBackendKind: LogBackendKind;
  requestLogHomeIpById: Record<string, string>;
  total?: number;
  limit?: number;
  offset?: number;
}

export interface ErrorLogFile {
  name: string;
  size?: number;
  modified?: number;
}

export interface ErrorLogsResponse {
  files?: ErrorLogFile[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return String(value);
};

const asNumber = (value: unknown): number | undefined => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
};

const asBoolean = (value: unknown): boolean => {
  if (value === true) return true;
  if (typeof value === 'string') {
    return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
  }
  return false;
};

const normalizeStringArray = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((item) => String(item ?? '')) : [];

const normalizeHomeIpMap = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};

  const result: Record<string, string> = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (!key) return;
    const homeIp = isRecord(entry)
      ? asString(entry.home_ip ?? entry.homeIp ?? entry.ip)
      : asString(entry);
    if (homeIp.trim()) result[key] = homeIp.trim();
  });
  return result;
};

const normalizeLogsResponse = (value: unknown): LogsResponse => {
  const source = isRecord(value) ? value : {};
  const lines = normalizeStringArray(source.lines);
  const legacyLineCount = asNumber(source['line-count'] ?? source.lineCount) ?? lines.length;
  const latestTimestamp =
    asNumber(
      source['latest-timestamp'] ??
        source.latestTimestamp ??
        source.latest_after ??
        source.latestAfter
    ) ?? 0;
  const latestAfter = source.latest_after ?? source.latestAfter ?? latestTimestamp;
  const nextCursor = asString(source.next_cursor ?? source.nextCursor ?? source.cursor);
  const cursorReset = asBoolean(source.cursor_reset ?? source.cursorReset);
  const logBackendKind =
    asString(source['home-db'] ?? source.homeDb ?? source.backend ?? source.logBackendKind) ||
    'legacy';

  return {
    lines,
    'line-count': legacyLineCount,
    'latest-timestamp': latestTimestamp,
    lineCount: legacyLineCount,
    latestAfter:
      latestAfter === undefined || latestAfter === null || latestAfter === ''
        ? null
        : (latestAfter as LogCursor),
    nextCursor,
    cursorReset,
    logBackendKind,
    requestLogHomeIpById: normalizeHomeIpMap(
      source.request_log_home_ip_by_id ??
        source.requestLogHomeIpById ??
        source.home_ip_by_id ??
        source.homeIpById
    ),
    total: asNumber(source.total),
    limit: asNumber(source.limit),
    offset: asNumber(source.offset),
  };
};

export const logsApi = {
  async fetchLogs(params: LogsQuery = {}): Promise<LogsResponse> {
    const data = await apiClient.get('/logs', {
      params,
      timeout: LOGS_TIMEOUT_MS,
    });
    return normalizeLogsResponse(data);
  },

  clearLogs: () => apiClient.delete('/logs'),

  fetchErrorLogs: (): Promise<ErrorLogsResponse> =>
    apiClient.get('/request-error-logs', { timeout: LOGS_TIMEOUT_MS }),

  downloadErrorLog: (filename: string) =>
    apiClient.getRaw(`/request-error-logs/${encodeURIComponent(filename)}`, {
      responseType: 'blob',
      timeout: LOGS_TIMEOUT_MS
    }),

  downloadRequestLogById: (id: string, homeIp?: string) =>
    apiClient.getRaw(`/request-log-by-id/${encodeURIComponent(id)}`, {
      params: homeIp ? { home_ip: homeIp } : undefined,
      responseType: 'blob',
      timeout: LOGS_TIMEOUT_MS
    }),

  downloadRequestLogTextById: (id: string, retryNonce = Date.now(), homeIp?: string) =>
    apiClient.getRaw(`/request-log-by-id/${encodeURIComponent(id)}`, {
      params: homeIp ? { _: retryNonce, home_ip: homeIp } : { _: retryNonce },
      responseType: 'text',
      timeout: LOGS_TIMEOUT_MS,
      headers: {
        Accept: 'text/plain, */*',
        'Cache-Control': 'no-cache, no-store, max-age=0',
        Pragma: 'no-cache',
        Expires: '0'
      },
      validateStatus: (status) => (status >= 200 && status < 300) || status === 304
    }),
};
