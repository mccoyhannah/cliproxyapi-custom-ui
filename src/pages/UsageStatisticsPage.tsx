import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import {
  AUTO_DETAIL_LIMIT,
  DEFAULT_FILTERS,
  DETAIL_CONCURRENCY,
  MAX_INDEX_LINES,
  PAGE_SIZE,
  UNPARSED_MODEL_LABEL,
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
  createLazyTokenLedgerDetailLookup,
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
import { tokenLedgerApi } from '@/services/runtime/tokenLedger';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import { downloadBlob } from '@/utils/download';
import type { ApiKeyUsageResponse } from '@/utils/recentRequests';
import type {
  TokenLedgerEntry,
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

const buildTokenLedgerDetailsByRequestId = (
  ledgerEntries: TokenLedgerEntry[]
): ReadonlyMap<string, UsageRequestDetail> => {
  const preferredEntries = new Map<string, TokenLedgerEntry>();
  ledgerEntries.forEach((entry) => {
    if (!entry.requestId) return;
    if (isPreferredTokenLedgerEntry(entry, preferredEntries.get(entry.requestId))) {
      preferredEntries.set(entry.requestId, entry);
    }
  });

  const details = new Map<string, UsageRequestDetail>();
  preferredEntries.forEach((entry, requestId) => {
    details.set(requestId, detailFromTokenLedgerEntry(entry));
  });
  return details;
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
  const pageTransitionLayer = usePageTransitionLayer();
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
  const [error, setError] = useState('');
  const [enablingRequestLog, setEnablingRequestLog] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [tokenCompletionLoading, setTokenCompletionLoading] = useState(false);

  const latestTimestampRef = useRef<number>(0);
  const logRequestInFlightRef = useRef(false);
  const detailInFlightRef = useRef<Set<string>>(new Set());
  const requestDetailsRef = useRef<Record<string, UsageRequestDetail>>({});
  const initialDataLoadStartedRef = useRef(false);
  const tokenLedgerDetailLookupRef = useRef(
    createLazyTokenLedgerDetailLookup(async () => {
      const snapshot = await tokenLedgerApi.getLedger({ controlFallback: true });
      return buildTokenLedgerDetailsByRequestId(
        Array.isArray(snapshot?.entries) ? snapshot.entries : []
      );
    })
  );

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
            let ledgerDetail: UsageRequestDetail | undefined;
            if (status === 404) {
              try {
                ledgerDetail = await tokenLedgerDetailLookupRef.current(id);
              } catch {
                // Preserve the missing-log result when the optional ledger fallback is unavailable.
              }
            }
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

  useEffect(() => {
    fetchConfig().catch(() => {
      // Login flow handles connection errors.
    });
  }, [fetchConfig]);

  useEffect(() => {
    if (!(pageTransitionLayer?.isCurrentLayer ?? true)) return;
    if (connectionStatus !== 'connected') return;
    if (initialDataLoadStartedRef.current) return;
    initialDataLoadStartedRef.current = true;
    latestTimestampRef.current = 0;
    void loadUsageStats(false);
  }, [
    connectionStatus,
    loadUsageStats,
    pageTransitionLayer?.isCurrentLayer,
  ]);

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
            按请求追踪配置模型、实际上游模型、状态和耗时。详情日志按需解析，不把完整请求内容存进本地存储。Token 总账与价格由 CPA Pulse 提供。
          </p>
        </div>
      </div>

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
