import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import {
  AUTO_DETAIL_LIMIT,
  DEFAULT_FILTERS,
  DEFAULT_TOKEN_LEDGER_FILTERS,
  DETAIL_CONCURRENCY,
  MAX_INDEX_LINES,
  PAGE_SIZE,
  UNPARSED_MODEL_LABEL,
  TokenLedgerPanel,
  UsageCharts,
  UsageDetailsRail,
  UsageFilters,
  UsageMetricsGrid,
  UsageRequestsTable,
  buildModelMatrix,
  buildModelOptions,
  buildModelUsage,
  buildRequestRecords,
  buildSourceOptions,
  buildTimelineBuckets,
  calculateAggregateTotals,
  calculateRequestMetrics,
  calculateTokenUsageMetrics,
  detailFromTokenLedgerEntry,
  emptyDetail,
  enrichRecord,
  filterUsageRecords,
  formatRangePlainLabel,
  getAutoDetailIds,
  getErrorMessage,
  getErrorStatus,
  getLatencyMax,
  getTimelineMax,
  hasRequestDetailLogMarkers,
  parseDetailLog,
  responseDataToBlob,
  responseDataToText,
  selectUsageRecord,
} from '@/features/usageStatistics';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { apiKeyUsageApi } from '@/services/api/apiKeyUsage';
import { configApi, logsApi } from '@/services/api';
import {
  cliProxyBackendControlApi,
  launchCliProxyBackendControlSidecar,
  type TokenLedgerMaintenanceResult,
} from '@/services/api/cliProxyBackendControl';
import { tokenLedgerApi } from '@/services/runtime/tokenLedger';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import { downloadBlob } from '@/utils/download';
import type { ApiKeyUsageResponse } from '@/utils/recentRequests';
import type {
  TokenLedgerFilters,
  TokenLedgerEntry,
  TokenLedgerSnapshot,
  UsageRequestDetail,
  UsageStatsRecord,
  UsageStatsFilters,
} from '@/types/usageStatistics';
import styles from './UsageStatisticsPage.module.scss';

const formatWindowStamp = (timestampMs: number, language: string): string =>
  new Date(timestampMs).toLocaleString(language, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

const formatWindowDuration = (start: number, end: number): string => {
  const spanMs = Math.max(0, end - start);
  if (spanMs < 60_000) return '不足 1 分钟';
  if (spanMs < 60 * 60_000) return `约 ${Math.ceil(spanMs / 60_000)} 分钟`;
  if (spanMs < 24 * 60 * 60_000) {
    return `约 ${Math.round((spanMs / (60 * 60_000)) * 10) / 10} 小时`;
  }
  return `约 ${Math.round((spanMs / (24 * 60 * 60_000)) * 10) / 10} 天`;
};

const buildCurrentWindowSummary = (
  records: UsageStatsRecord[],
  language: string
): string => {
  const timestamps = records
    .map((record) => record.timestampMs)
    .filter((timestamp): timestamp is number => timestamp !== null);

  if (records.length === 0 || timestamps.length === 0) {
    return `${records.length} 条 · 暂无可用时间窗口`;
  }

  const start = Math.min(...timestamps);
  const end = Math.max(...timestamps);
  return `${records.length} 条 · ${formatWindowStamp(start, language)} - ${formatWindowStamp(
    end,
    language
  )} · ${formatWindowDuration(start, end)}`;
};

const REQUEST_DETAIL_PARTIAL_MESSAGE = '详情日志只返回了部分内容，请刷新后重试';
const REQUEST_DETAIL_EMPTY_MESSAGE = '详情日志为空，请刷新后重试';
const REQUEST_DETAIL_DOWNLOAD_MESSAGE = '详情下载失败';
const TOKEN_LEDGER_CONTROL_WAKE_ATTEMPTS = 18;
const TOKEN_LEDGER_CONTROL_WAKE_INTERVAL_MS = 850;
const TOKEN_LEDGER_PRUNE_ACTIVE_WINDOW_MINUTES = 5;

type TokenLedgerUpdatePhase =
  | 'idle'
  | 'starting-control'
  | 'refreshing-ledger'
  | 'loading-ledger'
  | 'done'
  | 'error';

type TokenLedgerUpdateStatus = {
  phase: TokenLedgerUpdatePhase;
  message: string;
  detail?: string;
};

const IDLE_TOKEN_LEDGER_STATUS: TokenLedgerUpdateStatus = {
  phase: 'idle',
  message: '',
};

const formatLedgerCount = (value: number | null | undefined): string =>
  new Intl.NumberFormat('zh-CN').format(Math.max(0, Number(value) || 0));

const buildTokenLedgerResultMessage = (result: TokenLedgerMaintenanceResult): string => {
  const updated = Number(result.updatedFiles) || 0;
  if (updated > 0) {
    return `Token 台账已更新，新增 ${formatLedgerCount(updated)} 个日志文件`;
  }
  return 'Token 台账已检查，无新增日志';
};

const buildTokenLedgerResultDetail = (result: TokenLedgerMaintenanceResult): string =>
  `扫描 ${formatLedgerCount(result.scannedFiles)} 个，跳过 ${formatLedgerCount(
    result.skippedFiles
  )} 个，错误 ${formatLedgerCount(result.errorFiles)} 个`;

const wait = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

const isControlOfflineError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('failed to fetch') ||
    normalized.includes('fetch failed') ||
    normalized.includes('networkerror') ||
    normalized.includes('network request failed') ||
    normalized.includes('load failed') ||
    normalized.includes('connection refused') ||
    normalized.includes('err_connection_refused')
  );
};

const isPartialRequestLogStatus = (status?: number): boolean => status === 206 || status === 304;

const tokenLedgerStatusScore = (entry: TokenLedgerEntry): number => {
  if (entry.tokenUsage?.status === 'available') return 2;
  if (entry.tokenUsage?.status === 'unreported') return 1;
  return 0;
};

const tokenLedgerDetailScore = (entry: TokenLedgerEntry): number => {
  if (entry.detailStatus === 'ready') return 2;
  if (entry.detailStatus === 'missing-fields') return 1;
  return 0;
};

const tokenLedgerSourceScore = (entry: TokenLedgerEntry): number => {
  const normalized = (entry.sourceDir ?? '').replace(/\\/g, '/').toLowerCase();
  return normalized.endsWith('/auths/logs') ? 1 : 0;
};

const numericLedgerScore = (value: number | null | undefined): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const isPreferredTokenLedgerEntry = (
  candidate: TokenLedgerEntry,
  current: TokenLedgerEntry | undefined
): boolean => {
  if (!current) return true;

  const candidateScores = [
    tokenLedgerStatusScore(candidate),
    tokenLedgerDetailScore(candidate),
    numericLedgerScore(candidate.timestampMs),
    tokenLedgerSourceScore(candidate),
    numericLedgerScore(candidate.lastModifiedMs),
    numericLedgerScore(candidate.fileSize),
  ];
  const currentScores = [
    tokenLedgerStatusScore(current),
    tokenLedgerDetailScore(current),
    numericLedgerScore(current.timestampMs),
    tokenLedgerSourceScore(current),
    numericLedgerScore(current.lastModifiedMs),
    numericLedgerScore(current.fileSize),
  ];

  for (let index = 0; index < candidateScores.length; index += 1) {
    if (candidateScores[index] !== currentScores[index]) {
      return candidateScores[index] > currentScores[index];
    }
  }

  return String(candidate.sourceKey ?? candidate.fileName).localeCompare(
    String(current.sourceKey ?? current.fileName)
  ) < 0;
};

const buildDetailDownloadMessage = (message: string, status?: number | null): string => {
  if (status === 206) return REQUEST_DETAIL_PARTIAL_MESSAGE;
  if (status === 304) return '详情日志命中了浏览器缓存，请刷新后重试';
  if (!message) return REQUEST_DETAIL_DOWNLOAD_MESSAGE;
  if (message.toLowerCase().includes('network error')) return REQUEST_DETAIL_DOWNLOAD_MESSAGE;
  return `${REQUEST_DETAIL_DOWNLOAD_MESSAGE}: ${message}`;
};

export function UsageStatisticsPage() {
  const { t, i18n } = useTranslation();
  const { showNotification } = useNotificationStore();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
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
  const [tokenLedgerFilters, setTokenLedgerFilters] = useLocalStorage<TokenLedgerFilters>(
    'usageStatistics.tokenLedgerFilters',
    DEFAULT_TOKEN_LEDGER_FILTERS
  );

  const [usage, setUsage] = useState<ApiKeyUsageResponse | null>(null);
  const [tokenLedger, setTokenLedger] = useState<TokenLedgerSnapshot | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [requestDetails, setRequestDetails] = useState<Record<string, UsageRequestDetail>>({});
  const [loading, setLoading] = useState(false);
  const [tokenLedgerLoading, setTokenLedgerLoading] = useState(false);
  const [tokenLedgerRefreshRunning, setTokenLedgerRefreshRunning] = useState(false);
  const [tokenLedgerPruneRunning, setTokenLedgerPruneRunning] = useState(false);
  const [error, setError] = useState('');
  const [tokenLedgerError, setTokenLedgerError] = useState('');
  const [tokenLedgerUpdateStatus, setTokenLedgerUpdateStatus] =
    useState<TokenLedgerUpdateStatus>(IDLE_TOKEN_LEDGER_STATUS);
  const [enablingRequestLog, setEnablingRequestLog] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [tokenCompletionLoading, setTokenCompletionLoading] = useState(false);

  const latestTimestampRef = useRef<number>(0);
  const logRequestInFlightRef = useRef(false);
  const detailInFlightRef = useRef<Set<string>>(new Set());
  const tokenLedgerLoadedRef = useRef(false);
  const requestDetailsRef = useRef<Record<string, UsageRequestDetail>>({});
  const tokenLedgerDetailsRef = useRef<Map<string, UsageRequestDetail>>(new Map());

  useEffect(() => {
    requestDetailsRef.current = requestDetails;
  }, [requestDetails]);

  const normalizedFilters = useMemo(() => ({ ...DEFAULT_FILTERS, ...filters }), [filters]);
  const deferredSearch = useDeferredValue(normalizedFilters.search);
  const activeFilterKey = [
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

  const setTokenLedgerFilterValue = <K extends keyof TokenLedgerFilters>(
    key: K,
    value: TokenLedgerFilters[K]
  ) => {
    setTokenLedgerFilters((prev) => ({ ...DEFAULT_TOKEN_LEDGER_FILTERS, ...prev, [key]: value }));
  };

  const tokenLedgerDetailsByRequestId = useMemo(() => {
    const entries = new Map<string, TokenLedgerEntry>();
    tokenLedger?.entries.forEach((entry) => {
      if (!entry.requestId) return;
      if (isPreferredTokenLedgerEntry(entry, entries.get(entry.requestId))) {
        entries.set(entry.requestId, entry);
      }
    });
    const details = new Map<string, UsageRequestDetail>();
    entries.forEach((entry, requestId) => {
      details.set(requestId, detailFromTokenLedgerEntry(entry));
    });
    return details;
  }, [tokenLedger]);

  useEffect(() => {
    tokenLedgerDetailsRef.current = tokenLedgerDetailsByRequestId;
  }, [tokenLedgerDetailsByRequestId]);

  const loadTokenLedger = useCallback(async (
    forceNetwork = false,
    options: { showStatus?: boolean; requireLedger?: boolean } = {}
  ) => {
    const isInitialLoad = !tokenLedgerLoadedRef.current;
    if (isInitialLoad || options.showStatus) {
      setTokenLedgerLoading(true);
    }
    setTokenLedgerError('');
    if (options.showStatus) {
      setTokenLedgerUpdateStatus({
        phase: 'loading-ledger',
        message: '正在读取新的 Token 台账',
        detail: '正在加载 token-ledger.json，文件较大时需要等几秒',
      });
    }

    try {
      const snapshot = await tokenLedgerApi.getLedger({
        forceNetwork,
        controlFallback: true,
        requireLedger: options.requireLedger,
      });
      if (!snapshot && !options.requireLedger) {
        setTokenLedgerError('未从 8317 直接读取到台账；点击“更新 Token 台账”会启动本机助手读取。');
      }
      setTokenLedger(snapshot);
      tokenLedgerLoadedRef.current = true;
    } catch (err: unknown) {
      const message = getErrorMessage(err) || '长期 Token 台账加载失败';
      setTokenLedgerError(message);
      if (options.showStatus) {
        setTokenLedgerUpdateStatus({
          phase: 'error',
          message: 'Token 台账读取失败',
          detail: message,
        });
      }
      throw err;
    } finally {
      setTokenLedgerLoading(false);
    }
  }, []);

  const wakeTokenLedgerControlSidecar = useCallback(async () => {
    try {
      await cliProxyBackendControlApi.getStatus();
      return;
    } catch (err) {
      if (!isControlOfflineError(err)) throw err;
    }

    if (!launchCliProxyBackendControlSidecar()) {
      throw new Error('本机控制 helper 无法从浏览器唤起');
    }

    let lastError = '';
    for (let attempt = 0; attempt < TOKEN_LEDGER_CONTROL_WAKE_ATTEMPTS; attempt += 1) {
      await wait(attempt === 0 ? 650 : TOKEN_LEDGER_CONTROL_WAKE_INTERVAL_MS);
      try {
        await cliProxyBackendControlApi.getStatus();
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    throw new Error(`本机控制 helper 启动失败${lastError ? `: ${lastError}` : ''}`);
  }, []);

  const handlePruneRecordedTokenLedgerLogs = useCallback(async () => {
    if (connectionStatus !== 'connected' || !apiBase || !managementKey) {
      showNotification('请先连接管理后台，再清理已入账日志', 'warning');
      return;
    }

    setTokenLedgerPruneRunning(true);
    setTokenLedgerError('');
    setTokenLedgerUpdateStatus({
      phase: 'starting-control',
      message: '正在启动本机控制助手',
      detail: '用于清理已入账日志并重新读取台账',
    });
    try {
      await wakeTokenLedgerControlSidecar();
      setTokenLedgerUpdateStatus({
        phase: 'refreshing-ledger',
        message: '正在清理已入账日志',
        detail: '只清理已经写入台账的详情日志，活跃日志会保留',
      });
      const response = await cliProxyBackendControlApi.pruneRecordedTokenLedgerLogs({
        apiBase,
        managementKey,
        activeWindowMinutes: TOKEN_LEDGER_PRUNE_ACTIVE_WINDOW_MINUTES,
      });
      await loadTokenLedger(true, { showStatus: true, requireLedger: true });

      const prune = response.result.prune;
      const deletedLabel =
        prune.deletedGB >= 0.01
          ? `${prune.deletedGB}GB`
          : `${Math.round(prune.deletedBytes / 1024)}KB`;
      showNotification(
        `已清理 ${prune.deletedFiles} 个已入账日志，释放 ${deletedLabel}`,
        'success'
      );
      setTokenLedgerUpdateStatus({
        phase: 'done',
        message: `清理完成，删除 ${formatLedgerCount(prune.deletedFiles)} 个日志`,
        detail: `释放 ${deletedLabel}，台账已重新读取`,
      });
      if (prune.failedDeletes > 0) {
        showNotification(`有 ${prune.failedDeletes} 个日志删除失败，已保留`, 'warning');
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err) || (err instanceof Error ? err.message : String(err));
      setTokenLedgerError(`清理已入账日志失败${message ? `: ${message}` : ''}`);
      setTokenLedgerUpdateStatus({
        phase: 'error',
        message: '清理已入账日志失败',
        detail: message,
      });
      showNotification(`清理已入账日志失败${message ? `: ${message}` : ''}`, 'error');
    } finally {
      setTokenLedgerPruneRunning(false);
    }
  }, [
    apiBase,
    connectionStatus,
    loadTokenLedger,
    managementKey,
    showNotification,
    wakeTokenLedgerControlSidecar,
  ]);

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
      const loadDetailText = async (id: string) => {
        const fetchText = async (retryIndex: number) => {
          const response = await logsApi.downloadRequestLogTextById(id, Date.now() + retryIndex);
          const text = await responseDataToText((response as { data?: unknown }).data);
          const status = Number((response as { status?: unknown }).status);
          return { status, text };
        };

        const first = await fetchText(0);
        if (
          !isPartialRequestLogStatus(first.status) &&
          first.text.trim() &&
          hasRequestDetailLogMarkers(first.text)
        ) {
          return first.text;
        }

        const second = await fetchText(1);
        if (isPartialRequestLogStatus(second.status)) {
          throw new Error(buildDetailDownloadMessage('', second.status));
        }
        if (!second.text.trim()) {
          throw new Error(REQUEST_DETAIL_EMPTY_MESSAGE);
        }
        if (!hasRequestDetailLogMarkers(second.text)) {
          throw new Error(REQUEST_DETAIL_PARTIAL_MESSAGE);
        }
        return second.text;
      };

      const workers = Array.from({ length: workerCount }, async () => {
        while (queue.length > 0) {
          const id = queue.shift();
          if (!id) return;

          try {
            const text = await loadDetailText(id);
            const detail = parseDetailLog(id, text);
            setRequestDetails((prev) => ({ ...prev, [id]: detail }));
          } catch (err: unknown) {
            const status = getErrorStatus(err);
            const message = getErrorMessage(err);
            const ledgerDetail = status === 404 ? tokenLedgerDetailsRef.current.get(id) : undefined;
            setRequestDetails((prev) => ({
              ...prev,
              [id]:
                ledgerDetail ??
                emptyDetail(
                  id,
                  status === 404 ? 'unavailable' : 'download-error',
                  status === 404
                    ? '后端没有找到对应详情日志'
                    : buildDetailDownloadMessage(message, status)
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
        return;
      }

      if (logRequestInFlightRef.current) return;
      logRequestInFlightRef.current = true;
      if (!incremental) {
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
        logRequestInFlightRef.current = false;
      }
    },
    [connectionStatus, requestLogEnabled]
  );

  const handleUpdateTokenLedger = useCallback(async () => {
    if (connectionStatus !== 'connected' || !apiBase || !managementKey) {
      showNotification('请先连接管理后台，再更新 Token 台账', 'warning');
      return;
    }

    setTokenLedgerRefreshRunning(true);
    setTokenLedgerError('');
    setTokenLedgerUpdateStatus({
      phase: 'starting-control',
      message: '正在启动本机控制助手',
      detail: '如果助手刚刚空闲退出，会先唤起 8319 本地助手',
    });
    try {
      await wakeTokenLedgerControlSidecar();
      setTokenLedgerUpdateStatus({
        phase: 'refreshing-ledger',
        message: '正在扫描日志并生成 Token 台账',
        detail: '日志较多时可能需要几十秒，请保持本页打开',
      });
      const response = await cliProxyBackendControlApi.refreshTokenLedger({
        apiBase,
        managementKey,
      });
      const resultMessage = buildTokenLedgerResultMessage(response.result);
      const resultDetail = buildTokenLedgerResultDetail(response.result);
      await loadTokenLedger(true, { showStatus: true, requireLedger: true });
      setTokenLedgerUpdateStatus({
        phase: 'done',
        message: resultMessage,
        detail: resultDetail,
      });
      showNotification(resultMessage, 'success');
    } catch (err: unknown) {
      const message = getErrorMessage(err) || (err instanceof Error ? err.message : String(err));
      const detail = `更新 Token 台账失败${message ? `: ${message}` : ''}`;
      setTokenLedgerError(detail);
      setTokenLedgerUpdateStatus({
        phase: 'error',
        message: '更新 Token 台账失败',
        detail:
          message && isControlOfflineError(message)
            ? '本机控制助手未启动，无法更新台账'
            : message,
      });
      showNotification(detail, 'error');
    } finally {
      setTokenLedgerRefreshRunning(false);
    }
  }, [
    apiBase,
    connectionStatus,
    loadTokenLedger,
    managementKey,
    showNotification,
    wakeTokenLedgerControlSidecar,
  ]);

  useEffect(() => {
    fetchConfig().catch(() => {
      // Login flow handles connection errors.
    });
  }, [fetchConfig]);

  useEffect(() => {
    latestTimestampRef.current = 0;
    void loadUsageStats(false);
    void loadTokenLedger(false);
  }, [loadTokenLedger, loadUsageStats]);

  useEffect(() => {
    if (!autoRefresh || connectionStatus !== 'connected') return;
    const timer = window.setInterval(() => {
      void loadUsageStats(true);
      void loadTokenLedger(true);
    }, refreshInterval);
    return () => window.clearInterval(timer);
  }, [autoRefresh, connectionStatus, loadTokenLedger, loadUsageStats, refreshInterval]);

  const baseRecords = useMemo(
    () => (requestLogEnabled ? buildRequestRecords(logLines, i18n.language) : []),
    [i18n.language, logLines, requestLogEnabled]
  );

  const enrichedRecords = useMemo(
    () => {
      const effectiveDetails: Record<string, UsageRequestDetail> = {};
      Object.entries(requestDetails).forEach(([requestId, detail]) => {
        const ledgerDetail = tokenLedgerDetailsByRequestId.get(requestId);
        effectiveDetails[requestId] =
          detail.detailStatus === 'unavailable' && ledgerDetail ? ledgerDetail : detail;
      });
      return baseRecords.map((record) => enrichRecord(record, effectiveDetails));
    },
    [baseRecords, requestDetails, tokenLedgerDetailsByRequestId]
  );

  const modelOptions = useMemo(() => buildModelOptions(enrichedRecords), [enrichedRecords]);
  const sourceOptions = useMemo(() => buildSourceOptions(enrichedRecords), [enrichedRecords]);

  const filteredRecords = useMemo(
    () => filterUsageRecords(enrichedRecords, normalizedFilters, deferredSearch),
    [deferredSearch, enrichedRecords, normalizedFilters]
  );

  useEffect(() => {
    setPage(1);
  }, [activeFilterKey]);

  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pagedRecords = useMemo(
    () => filteredRecords.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredRecords, safePage]
  );

  const autoDetailIds = useMemo(
    () => getAutoDetailIds(baseRecords, deferredSearch, AUTO_DETAIL_LIMIT),
    [baseRecords, deferredSearch]
  );

  useEffect(() => {
    void loadRequestDetails(autoDetailIds);
  }, [autoDetailIds, loadRequestDetails]);

  useEffect(() => {
    if (!selectedRequestId && filteredRecords[0]?.requestId) {
      setSelectedRequestId(filteredRecords[0].requestId);
    }
  }, [filteredRecords, selectedRequestId]);

  const aggregateTotals = useMemo(() => calculateAggregateTotals(usage), [usage]);
  const requestMetrics = useMemo(
    () => calculateRequestMetrics(filteredRecords),
    [filteredRecords]
  );
  const tokenMetrics = useMemo(
    () => calculateTokenUsageMetrics(filteredRecords),
    [filteredRecords]
  );
  const rangeLabel = formatRangePlainLabel();
  const currentWindowSummary = useMemo(
    () => buildCurrentWindowSummary(baseRecords, i18n.language),
    [baseRecords, i18n.language]
  );
  const currentWindowHint = `最近 ${MAX_INDEX_LINES} 行摘要 · 筛选器和明细只作用于当前已加载请求尾部`;
  const modelUsage = useMemo(() => buildModelUsage(filteredRecords), [filteredRecords]);
  const timelineBuckets = useMemo(
    () => buildTimelineBuckets(filteredRecords, i18n.language),
    [filteredRecords, i18n.language]
  );
  const timelineMax = useMemo(() => getTimelineMax(timelineBuckets), [timelineBuckets]);
  const latencyMax = useMemo(() => getLatencyMax(timelineBuckets), [timelineBuckets]);
  const modelMatrix = useMemo(() => buildModelMatrix(filteredRecords), [filteredRecords]);
  const selectedRecord = useMemo(
    () => selectUsageRecord(filteredRecords, selectedRequestId),
    [filteredRecords, selectedRequestId]
  );
  const initialLoading = loading && !usage && logLines.length === 0 && filteredRecords.length === 0;

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

  const handleCompleteTokenDetails = async () => {
    const candidates = Array.from(
      new Set(
        filteredRecords
          .filter((record) => record.requestId && record.detailStatus === 'pending')
          .map((record) => record.requestId)
          .filter((id): id is string => Boolean(id))
      )
    );

    if (candidates.length === 0) {
      showNotification('当前筛选范围没有需要补全的 Token 详情', 'info');
      return;
    }

    setTokenCompletionLoading(true);
    try {
      await loadRequestDetails(candidates);
      showNotification(`已提交 ${candidates.length} 条请求详情解析`, 'success');
    } finally {
      setTokenCompletionLoading(false);
    }
  };

  const handleSelectRecord = useCallback(
    (requestId: string) => {
      setSelectedRequestId(requestId);
      void loadRequestDetails([requestId], true);
    },
    [loadRequestDetails]
  );

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
            variant="primary"
            onClick={() => void handleUpdateTokenLedger()}
            loading={tokenLedgerRefreshRunning || tokenLedgerLoading}
            disabled={connectionStatus !== 'connected' || tokenLedgerPruneRunning}
          >
            <IconRefreshCw size={16} />
            更新 Token 台账
          </Button>
        </div>
      </div>

      <TokenLedgerPanel
        error={tokenLedgerError}
        filters={tokenLedgerFilters}
        ledger={tokenLedger}
        loading={tokenLedgerLoading}
        onPruneRecordedLogs={() => void handlePruneRecordedTokenLedgerLogs()}
        pruneDisabled={connectionStatus !== 'connected' || tokenLedgerRefreshRunning}
        pruning={tokenLedgerPruneRunning}
        setFilterValue={setTokenLedgerFilterValue}
        updateStatus={tokenLedgerUpdateStatus}
      />

      <section className={styles.currentWindowSection} aria-labelledby="current-window-title">
        <div className={styles.currentWindowHeader}>
          <div>
            <span>当前加载窗口</span>
            <h2 id="current-window-title">当前窗口统计</h2>
          </div>
          <p>{currentWindowSummary}</p>
        </div>

        <UsageMetricsGrid
          aggregateTotals={aggregateTotals}
          loading={initialLoading}
          onCompleteTokenDetails={() => void handleCompleteTokenDetails()}
          rangeLabel={rangeLabel}
          requestMetrics={requestMetrics}
          tokenCompletionDisabled={
            tokenCompletionLoading ||
            connectionStatus !== 'connected' ||
            filteredRecords.every((record) => record.detailStatus !== 'pending')
          }
          tokenCompletionLoading={tokenCompletionLoading}
          tokenMetrics={tokenMetrics}
        />

        <UsageCharts
          latencyMax={latencyMax}
          loading={initialLoading}
          modelMatrix={modelMatrix}
          modelUsage={modelUsage}
          normalizedFilters={normalizedFilters}
          onModelUsageClick={handleModelUsageClick}
          rangeLabel={rangeLabel}
          requestMetrics={requestMetrics}
          tokenMetrics={tokenMetrics}
          timelineBuckets={timelineBuckets}
          timelineMax={timelineMax}
        />

        <UsageFilters
          autoRefresh={autoRefresh}
          configAvailable={Boolean(config)}
          connectionStatus={connectionStatus}
          enablingRequestLog={enablingRequestLog}
          error={error}
          modelOptions={modelOptions}
          normalizedFilters={normalizedFilters}
          onEnableRequestLog={() => void handleEnableRequestLog()}
          refreshInterval={refreshInterval}
          requestLogEnabled={requestLogEnabled}
          setAutoRefresh={setAutoRefresh}
          setFilterValue={setFilterValue}
          setRefreshInterval={setRefreshInterval}
          sourceOptions={sourceOptions}
          windowHint={currentWindowHint}
          windowSummary={currentWindowSummary}
        />

        <div className={styles.workbenchGrid}>
          <UsageRequestsTable
            filteredRecords={filteredRecords}
            loading={initialLoading}
            maxIndexLines={MAX_INDEX_LINES}
            onNextPage={() => setPage((current) => Math.min(pageCount, current + 1))}
            onPreviousPage={() => setPage((current) => Math.max(1, current - 1))}
            onSelectRecord={handleSelectRecord}
            pageCount={pageCount}
            pagedRecords={pagedRecords}
            rangeLabel={rangeLabel}
            safePage={safePage}
            selectedRecord={selectedRecord}
          />

          <UsageDetailsRail
            downloadingId={downloadingId}
            modelMatrix={modelMatrix}
            onDownloadLog={(requestId) => void handleDownloadRequestLog(requestId)}
            onParseDetails={(requestId) => void loadRequestDetails([requestId], true)}
            selectedRecord={selectedRecord}
          />
        </div>
      </section>
    </div>
  );
}
