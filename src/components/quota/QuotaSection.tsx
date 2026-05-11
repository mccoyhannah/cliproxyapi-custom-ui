/**
 * Generic quota section component.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, ResolvedTheme } from '@/types';
import { getStatusFromError } from '@/utils/quota';
import { QuotaCard } from './QuotaCard';
import type { QuotaStatusState } from './QuotaCard';
import { useQuotaLoader } from './useQuotaLoader';
import type { LoadQuotaOptions } from './useQuotaLoader';
import type { QuotaConfig } from './quotaConfigs';
import { useGridColumns } from './useGridColumns';
import { IconRefreshCw } from '@/components/ui/icons';
import styles from '@/pages/QuotaPage.module.scss';

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaSetter<T> = (updater: QuotaUpdater<T>) => void;

type ViewMode = 'paged' | 'all';

const MAX_ITEMS_PER_PAGE = 25;
const MAX_SHOW_ALL_THRESHOLD = 30;
const AUTO_REFRESH_INTERVAL_MS = 30_000;

interface QuotaPaginationState<T> {
  pageSize: number;
  totalPages: number;
  currentPage: number;
  pageItems: T[];
  setPageSize: (size: number) => void;
  goToPrev: () => void;
  goToNext: () => void;
  loading: boolean;
  loadingScope: 'page' | 'all' | null;
  setLoading: (loading: boolean, scope?: 'page' | 'all' | null) => void;
}

const useQuotaPagination = <T,>(items: T[], defaultPageSize = 6): QuotaPaginationState<T> => {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSizeState] = useState(defaultPageSize);
  const [loading, setLoadingState] = useState(false);
  const [loadingScope, setLoadingScope] = useState<'page' | 'all' | null>(null);

  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(items.length / pageSize)),
    [items.length, pageSize]
  );

  const currentPage = useMemo(() => Math.min(page, totalPages), [page, totalPages]);

  const pageItems = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return items.slice(start, start + pageSize);
  }, [items, currentPage, pageSize]);

  const setPageSize = useCallback((size: number) => {
    setPageSizeState(size);
    setPage(1);
  }, []);

  const goToPrev = useCallback(() => {
    setPage((prev) => Math.max(1, prev - 1));
  }, []);

  const goToNext = useCallback(() => {
    setPage((prev) => Math.min(totalPages, prev + 1));
  }, [totalPages]);

  const setLoading = useCallback((isLoading: boolean, scope?: 'page' | 'all' | null) => {
    setLoadingState(isLoading);
    setLoadingScope(isLoading ? (scope ?? null) : null);
  }, []);

  return {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    setPageSize,
    goToPrev,
    goToNext,
    loading,
    loadingScope,
    setLoading
  };
};

interface QuotaSectionProps<TState extends QuotaStatusState, TData> {
  config: QuotaConfig<TState, TData>;
  files: AuthFileItem[];
  loading: boolean;
  disabled: boolean;
  defaultViewMode?: ViewMode;
  autoRefreshOnReady?: boolean;
}

export function QuotaSection<TState extends QuotaStatusState, TData>({
  config,
  files,
  loading,
  disabled,
  defaultViewMode = 'paged',
  autoRefreshOnReady = false
}: QuotaSectionProps<TState, TData>) {
  const { t } = useTranslation();
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<
    Record<string, TState>
  >;
  const quotaRefreshMeta = useQuotaStore((state) => state.quotaRefreshMeta[config.type]);
  const setQuotaRefreshMeta = useQuotaStore((state) => state.setQuotaRefreshMeta);

  const [columns, gridRef] = useGridColumns(380); // Min card width 380px matches SCSS
  const [viewMode, setViewMode] = useState<ViewMode>(defaultViewMode);
  const [showTooManyWarning, setShowTooManyWarning] = useState(false);

  const filteredFiles = useMemo(() => files.filter((file) => config.filterFn(file)), [
    files,
    config
  ]);
  const showAllAllowed = filteredFiles.length <= MAX_SHOW_ALL_THRESHOLD;
  const effectiveViewMode: ViewMode = viewMode === 'all' && !showAllAllowed ? 'paged' : viewMode;

  const {
    pageSize,
    totalPages,
    currentPage,
    pageItems,
    setPageSize,
    goToPrev,
    goToNext,
    loading: sectionLoading,
    setLoading
  } = useQuotaPagination(filteredFiles);

  useEffect(() => {
    if (showAllAllowed) return;
    if (viewMode !== 'all') return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setViewMode('paged');
      setShowTooManyWarning(true);
    });

    return () => {
      cancelled = true;
    };
  }, [showAllAllowed, viewMode]);

  // Update page size based on view mode and columns
  useEffect(() => {
    if (effectiveViewMode === 'all') {
      setPageSize(Math.max(1, filteredFiles.length));
    } else {
      // Paged mode: 3 rows * columns, capped to avoid oversized pages.
      setPageSize(Math.min(columns * 3, MAX_ITEMS_PER_PAGE));
    }
  }, [effectiveViewMode, columns, filteredFiles.length, setPageSize]);

  const { quota, loadQuota } = useQuotaLoader(config);

  const pendingQuotaRefreshRef = useRef(false);
  const prevFilesLoadingRef = useRef(loading);
  const quotaRefreshMetaRef = useRef(quotaRefreshMeta);
  const filesLoadingRef = useRef(loading);
  const sectionLoadingRef = useRef(sectionLoading);
  const disabledRef = useRef(disabled);

  const autoRefreshSignature = useMemo(
    () => filteredFiles.map((file) => file.name).join('|'),
    [filteredFiles]
  );

  const hasAnyExistingQuota = useMemo(
    () =>
      filteredFiles.some((file) => {
        const status = quota[file.name]?.status;
        return status === 'success' || status === 'error';
      }),
    [filteredFiles, quota]
  );
  const hasEveryExistingQuota = useMemo(
    () =>
      filteredFiles.every((file) => {
        const status = quota[file.name]?.status;
        return status === 'success' || status === 'error';
      }),
    [filteredFiles, quota]
  );

  useEffect(() => {
    quotaRefreshMetaRef.current = quotaRefreshMeta;
  }, [quotaRefreshMeta]);

  useEffect(() => {
    filesLoadingRef.current = loading;
    sectionLoadingRef.current = sectionLoading;
    disabledRef.current = disabled;
  }, [disabled, loading, sectionLoading]);

  const buildTrackedLoadOptions = useCallback(
    (preserveExisting: boolean): LoadQuotaOptions => ({
      preserveExisting,
      onStart: () => {
        const startedAt = Date.now();
        setQuotaRefreshMeta(config.type, (prev) => ({
          signature: autoRefreshSignature,
          lastStartedAt: startedAt,
          lastCompletedAt:
            prev.signature === autoRefreshSignature ? prev.lastCompletedAt : null
        }));
      },
      onComplete: () => {
        const completedAt = Date.now();
        setQuotaRefreshMeta(config.type, (prev) => ({
          signature: autoRefreshSignature,
          lastStartedAt: prev.lastStartedAt ?? completedAt,
          lastCompletedAt: completedAt
        }));
      }
    }),
    [autoRefreshSignature, config.type, setQuotaRefreshMeta]
  );

  const refreshAutoQuota = useCallback(
    (preserveExisting: boolean) => {
      if (!autoRefreshSignature || filteredFiles.length === 0) {
        return Promise.resolve(false);
      }
      return loadQuota(
        filteredFiles,
        'all',
        setLoading,
        buildTrackedLoadOptions(preserveExisting)
      );
    },
    [autoRefreshSignature, buildTrackedLoadOptions, filteredFiles, loadQuota, setLoading]
  );

  const handleRefresh = useCallback(() => {
    pendingQuotaRefreshRef.current = true;
    void triggerHeaderRefresh();
  }, []);

  useEffect(() => {
    const wasLoading = prevFilesLoadingRef.current;
    prevFilesLoadingRef.current = loading;

    if (!pendingQuotaRefreshRef.current) return;
    if (loading) return;
    if (!wasLoading) return;

    pendingQuotaRefreshRef.current = false;
    const scope = effectiveViewMode === 'all' ? 'all' : 'page';
    const targets = effectiveViewMode === 'all' ? filteredFiles : pageItems;
    if (targets.length === 0) return;
    const shouldTrackRefresh =
      autoRefreshOnReady &&
      scope === 'all' &&
      targets.length === filteredFiles.length;
    void loadQuota(
      targets,
      scope,
      setLoading,
      shouldTrackRefresh
        ? buildTrackedLoadOptions(true)
        : { preserveExisting: true }
    );
  }, [
    autoRefreshOnReady,
    buildTrackedLoadOptions,
    effectiveViewMode,
    filteredFiles,
    loadQuota,
    loading,
    pageItems,
    setLoading
  ]);

  useEffect(() => {
    if (loading) return;
    if (filteredFiles.length === 0) {
      setQuota({});
      return;
    }
    setQuota((prev) => {
      const nextState: Record<string, TState> = {};
      filteredFiles.forEach((file) => {
        const cached = prev[file.name];
        if (cached) {
          nextState[file.name] = cached;
        }
      });
      return nextState;
    });
  }, [filteredFiles, loading, setQuota]);

  useEffect(() => {
    if (!autoRefreshOnReady) return;
    if (disabled || loading || sectionLoading) return;
    if (!autoRefreshSignature || filteredFiles.length === 0) return;

    const signatureChanged = quotaRefreshMeta?.signature !== autoRefreshSignature;
    const lastCompletedAt = quotaRefreshMeta?.lastCompletedAt ?? null;
    const missingSessionRefresh = !lastCompletedAt;
    const stale =
      lastCompletedAt !== null && Date.now() - lastCompletedAt >= AUTO_REFRESH_INTERVAL_MS;

    if (!signatureChanged && !missingSessionRefresh && !stale && hasEveryExistingQuota) {
      return;
    }

    void refreshAutoQuota(hasAnyExistingQuota);
  }, [
    autoRefreshOnReady,
    autoRefreshSignature,
    disabled,
    filteredFiles,
    hasAnyExistingQuota,
    hasEveryExistingQuota,
    loading,
    quotaRefreshMeta,
    refreshAutoQuota,
    sectionLoading,
  ]);

  useEffect(() => {
    if (!autoRefreshOnReady) return;
    if (disabled || loading || filteredFiles.length === 0 || !autoRefreshSignature) return;

    const refreshIfStale = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (disabledRef.current || filesLoadingRef.current || sectionLoadingRef.current) return;

      const meta = quotaRefreshMetaRef.current;
      if (!meta?.lastCompletedAt || meta.signature !== autoRefreshSignature) return;
      if (Date.now() - meta.lastCompletedAt < AUTO_REFRESH_INTERVAL_MS) return;

      void refreshAutoQuota(true);
    };

    const intervalId = window.setInterval(refreshIfStale, AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [
    autoRefreshOnReady,
    autoRefreshSignature,
    disabled,
    filteredFiles.length,
    loading,
    refreshAutoQuota
  ]);

  useEffect(() => {
    if (!autoRefreshOnReady) return;
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      if (disabledRef.current || filesLoadingRef.current || sectionLoadingRef.current) return;

      const meta = quotaRefreshMetaRef.current;
      if (!meta?.lastCompletedAt || meta.signature !== autoRefreshSignature) return;
      if (Date.now() - meta.lastCompletedAt < AUTO_REFRESH_INTERVAL_MS) return;

      void refreshAutoQuota(true);
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [autoRefreshOnReady, autoRefreshSignature, refreshAutoQuota]);

  const refreshQuotaForFile = useCallback(
    async (file: AuthFileItem) => {
      if (disabled || file.disabled) return;
      if (quota[file.name]?.status === 'loading') return;

      setQuota((prev) => ({
        ...prev,
        [file.name]: config.buildLoadingState()
      }));

      try {
        const data = await config.fetchQuota(file, t);
        setQuota((prev) => ({
          ...prev,
          [file.name]: config.buildSuccessState(data)
        }));
        showNotification(t('auth_files.quota_refresh_success', { name: file.name }), 'success');
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : t('common.unknown_error');
        const status = getStatusFromError(err);
        setQuota((prev) => ({
          ...prev,
          [file.name]: config.buildErrorState(message, status)
        }));
        showNotification(
          t('auth_files.quota_refresh_failed', { name: file.name, message }),
          'error'
        );
      }
    },
    [config, disabled, quota, setQuota, showNotification, t]
  );

  const titleNode = (
    <div className={styles.titleWrapper}>
      <span>{t(`${config.i18nPrefix}.title`)}</span>
      {filteredFiles.length > 0 && (
        <span className={styles.countBadge}>
          {filteredFiles.length}
        </span>
      )}
    </div>
  );

  const isRefreshing = sectionLoading || loading;

  return (
    <Card
      title={titleNode}
      extra={
        <div className={styles.headerActions}>
          <div className={styles.viewModeToggle}>
            <Button
              variant="secondary"
              size="sm"
              className={`${styles.viewModeButton} ${
                effectiveViewMode === 'paged' ? styles.viewModeButtonActive : ''
              }`}
              onClick={() => setViewMode('paged')}
            >
              {t('auth_files.view_mode_paged')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={`${styles.viewModeButton} ${
                effectiveViewMode === 'all' ? styles.viewModeButtonActive : ''
              }`}
              onClick={() => {
                if (filteredFiles.length > MAX_SHOW_ALL_THRESHOLD) {
                  setShowTooManyWarning(true);
                } else {
                  setViewMode('all');
                }
              }}
            >
              {t('auth_files.view_mode_all')}
            </Button>
          </div>
          <Button
            variant="secondary"
            size="sm"
            className={styles.refreshAllButton}
            onClick={handleRefresh}
            disabled={disabled || isRefreshing}
            loading={isRefreshing}
            title={t('quota_management.refresh_all_credentials')}
            aria-label={t('quota_management.refresh_all_credentials')}
          >
            {!isRefreshing && <IconRefreshCw size={16} />}
            {t('quota_management.refresh_all_credentials')}
          </Button>
        </div>
      }
    >
      {filteredFiles.length === 0 ? (
        <EmptyState
          title={t(`${config.i18nPrefix}.empty_title`)}
          description={t(`${config.i18nPrefix}.empty_desc`)}
        />
      ) : (
        <>
          <div ref={gridRef} className={config.gridClassName}>
            {pageItems.map((item) => (
              <QuotaCard
                key={item.name}
                item={item}
                quota={quota[item.name]}
                resolvedTheme={resolvedTheme}
                i18nPrefix={config.i18nPrefix}
                cardIdleMessageKey={config.cardIdleMessageKey}
                cardClassName={config.cardClassName}
                defaultType={config.type}
                canRefresh={!disabled && !item.disabled}
                onRefresh={() => void refreshQuotaForFile(item)}
                renderQuotaItems={config.renderQuotaItems}
              />
            ))}
          </div>
          {filteredFiles.length > pageSize && effectiveViewMode === 'paged' && (
            <div className={styles.pagination}>
              <Button
                variant="secondary"
                size="sm"
                onClick={goToPrev}
                disabled={currentPage <= 1}
              >
                {t('auth_files.pagination_prev')}
              </Button>
              <div className={styles.pageInfo}>
                {t('auth_files.pagination_info', {
                  current: currentPage,
                  total: totalPages,
                  count: filteredFiles.length
                })}
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={goToNext}
                disabled={currentPage >= totalPages}
              >
                {t('auth_files.pagination_next')}
              </Button>
            </div>
          )}
        </>
      )}
      {showTooManyWarning && (
        <div className={styles.warningOverlay} onClick={() => setShowTooManyWarning(false)}>
          <div className={styles.warningModal} onClick={(e) => e.stopPropagation()}>
            <p>{t('auth_files.too_many_files_warning')}</p>
            <Button variant="primary" size="sm" onClick={() => setShowTooManyWarning(false)}>
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
