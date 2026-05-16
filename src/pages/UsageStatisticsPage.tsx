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
  emptyDetail,
  enrichRecord,
  filterUsageRecords,
  formatRangePlainLabel,
  getAutoDetailIds,
  getErrorMessage,
  getErrorStatus,
  getLatencyMax,
  getTimelineMax,
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
  TokenLedgerFilters,
  TokenLedgerSnapshot,
  UsageRequestDetail,
  UsageStatsFilters,
} from '@/types/usageStatistics';
import styles from './UsageStatisticsPage.module.scss';

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
  const [tokenLedgerFilters, setTokenLedgerFilters] = useLocalStorage<TokenLedgerFilters>(
    'usageStatistics.tokenLedgerFilters',
    DEFAULT_TOKEN_LEDGER_FILTERS
  );

  const [usage, setUsage] = useState<ApiKeyUsageResponse | null>(null);
  const [tokenLedger, setTokenLedger] = useState<TokenLedgerSnapshot | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [requestDetails, setRequestDetails] = useState<Record<string, UsageRequestDetail>>({});
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [tokenLedgerLoading, setTokenLedgerLoading] = useState(false);
  const [tokenLedgerRefreshing, setTokenLedgerRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [tokenLedgerError, setTokenLedgerError] = useState('');
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

  const setTokenLedgerFilterValue = <K extends keyof TokenLedgerFilters>(
    key: K,
    value: TokenLedgerFilters[K]
  ) => {
    setTokenLedgerFilters((prev) => ({ ...DEFAULT_TOKEN_LEDGER_FILTERS, ...prev, [key]: value }));
  };

  const loadTokenLedger = useCallback(async (forceNetwork = false) => {
    const isInitialLoad = !tokenLedgerLoadedRef.current;
    if (isInitialLoad) {
      setTokenLedgerLoading(true);
    } else {
      setTokenLedgerRefreshing(true);
    }
    setTokenLedgerError('');

    try {
      const snapshot = await tokenLedgerApi.getLedger({ forceNetwork });
      setTokenLedger(snapshot);
      tokenLedgerLoadedRef.current = true;
    } catch (err: unknown) {
      setTokenLedgerError(getErrorMessage(err) || '长期 Token 台账加载失败');
    } finally {
      setTokenLedgerLoading(false);
      setTokenLedgerRefreshing(false);
    }
  }, []);

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
  }, [activeRangeKey]);

  const pageCount = Math.max(1, Math.ceil(filteredRecords.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount);
  const pagedRecords = useMemo(
    () => filteredRecords.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE),
    [filteredRecords, safePage]
  );

  const autoDetailIds = useMemo(
    () => getAutoDetailIds(baseRecords, normalizedFilters, deferredSearch, AUTO_DETAIL_LIMIT),
    [baseRecords, deferredSearch, normalizedFilters]
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
  const rangeLabel = formatRangePlainLabel(normalizedFilters);
  const modelUsage = useMemo(() => buildModelUsage(filteredRecords), [filteredRecords]);
  const timelineBuckets = useMemo(
    () => buildTimelineBuckets(filteredRecords, normalizedFilters, i18n.language),
    [filteredRecords, i18n.language, normalizedFilters]
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
      void loadRequestDetails([requestId]);
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
            variant="secondary"
            onClick={() => {
              void loadUsageStats(true);
              void loadTokenLedger(true);
            }}
            loading={refreshing || tokenLedgerRefreshing}
            disabled={connectionStatus !== 'connected'}
          >
            <IconRefreshCw size={16} />
            增量刷新
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={() => {
              void loadUsageStats(false);
              void loadTokenLedger(true);
            }}
            loading={loading || tokenLedgerLoading}
            disabled={connectionStatus !== 'connected'}
          >
            <IconRefreshCw size={16} />
            {t('common.refresh')}
          </Button>
        </div>
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

      <TokenLedgerPanel
        error={tokenLedgerError}
        filters={tokenLedgerFilters}
        ledger={tokenLedger}
        loading={tokenLedgerLoading}
        onRefresh={() => void loadTokenLedger(true)}
        refreshing={tokenLedgerRefreshing}
        setFilterValue={setTokenLedgerFilterValue}
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
    </div>
  );
}
