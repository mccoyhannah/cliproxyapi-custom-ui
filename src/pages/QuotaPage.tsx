/**
 * Quota management page - coordinates the three quota sections.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { EmptyState } from '@/components/ui/EmptyState';
import { useAuthStore, useQuotaStore } from '@/stores';
import { authFilesApi, configFileApi } from '@/services/api';
import {
  QuotaSection,
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
} from '@/components/quota';
import type { QuotaDashboardFilter, QuotaItemSignal } from '@/components/quota/QuotaSection';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import { parsePriorityValue } from '@/features/authFiles/constants';
import {
  compareCodexMinRemainingPercentAsc,
  getCodexMinRemainingPercent,
  normalizePlanType,
  readCodexSubscriptionSnapshotFromRecord,
  resolveCodexPlanType,
} from '@/utils/quota';
import styles from './QuotaPage.module.scss';

type QuotaStateLike = {
  status?: 'idle' | 'loading' | 'success' | 'error' | string;
  windows?: Array<{ usedPercent?: number | null }>;
  groups?: Array<{ remainingFraction?: number | null }>;
  buckets?: Array<{ remainingFraction?: number | null }>;
  rows?: Array<{ used?: number; limit?: number }>;
};

type OverviewCounts = Record<QuotaDashboardFilter, number> & {
  total: number;
  refreshed: number;
};

const SUBSCRIPTION_WARNING_MS = 7 * 24 * 60 * 60 * 1000;

const getPrioritySortValue = (file: AuthFileItem): number =>
  parsePriorityValue(file.priority ?? file['priority']) ?? 0;

const getQuotaRemainingValues = (quota?: QuotaStateLike): number[] => {
  if (!quota || quota.status !== 'success') return [];
  const values: number[] = [];

  quota.windows?.forEach((window) => {
    const used = window.usedPercent;
    if (typeof used !== 'number' || !Number.isFinite(used)) return;
    values.push(Math.max(0, Math.min(100, 100 - used)));
  });

  quota.groups?.forEach((group) => {
    const fraction = group.remainingFraction;
    if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return;
    values.push(Math.max(0, Math.min(100, fraction * 100)));
  });

  quota.buckets?.forEach((bucket) => {
    const fraction = bucket.remainingFraction;
    if (typeof fraction !== 'number' || !Number.isFinite(fraction)) return;
    values.push(Math.max(0, Math.min(100, fraction * 100)));
  });

  quota.rows?.forEach((row) => {
    const { used, limit } = row;
    if (typeof used !== 'number' || typeof limit !== 'number' || !Number.isFinite(limit)) return;
    if (limit <= 0) return;
    values.push(Math.max(0, Math.min(100, ((limit - used) / limit) * 100)));
  });

  return values;
};

const getLowestRemainingPercent = (quota?: QuotaStateLike): number | null => {
  const values = getQuotaRemainingValues(quota);
  return values.length > 0 ? Math.min(...values) : null;
};

const isQuotaTight = (quota?: QuotaStateLike): boolean => {
  const remaining = getLowestRemainingPercent(quota);
  return remaining !== null && remaining <= 20;
};

const getCodexEffectivePlanType = (file: AuthFileItem, quota?: CodexQuotaState): string | null => {
  const fromQuota = quota?.status === 'success' ? normalizePlanType(quota.planType ?? null) : null;
  return fromQuota ?? normalizePlanType(resolveCodexPlanType(file));
};

const getCodexEffectiveExpiryMs = (file: AuthFileItem, quota?: CodexQuotaState): number | null => {
  if (getCodexEffectivePlanType(file, quota) === 'free') return null;

  if (
    quota?.status === 'success' &&
    quota.subscriptionStatus === 'found' &&
    typeof quota.subscriptionActiveUntilMs === 'number' &&
    Number.isFinite(quota.subscriptionActiveUntilMs)
  ) {
    return quota.subscriptionActiveUntilMs;
  }

  const snapshot = readCodexSubscriptionSnapshotFromRecord(file);
  return snapshot?.subscriptionStatus === 'found' &&
    typeof snapshot.subscriptionActiveUntilMs === 'number' &&
    Number.isFinite(snapshot.subscriptionActiveUntilMs)
    ? snapshot.subscriptionActiveUntilMs
    : null;
};

const sortCodexQuotaItems = (
  items: AuthFileItem[],
  quota: Record<string, CodexQuotaState>
): AuthFileItem[] => {
  const originalIndex = new Map(items.map((file, index) => [file.name, index]));
  const getOriginalIndex = (file: AuthFileItem) =>
    originalIndex.get(file.name) ?? Number.MAX_SAFE_INTEGER;

  const compareTie = (a: AuthFileItem, b: AuthFileItem): number => {
    const priorityCompare = getPrioritySortValue(b) - getPrioritySortValue(a);
    if (priorityCompare !== 0) return priorityCompare;

    const remainingCompare = compareCodexMinRemainingPercentAsc(
      getCodexMinRemainingPercent(quota[a.name]),
      getCodexMinRemainingPercent(quota[b.name])
    );
    if (remainingCompare !== 0) return remainingCompare;

    const originalCompare = getOriginalIndex(a) - getOriginalIndex(b);
    return originalCompare !== 0 ? originalCompare : a.name.localeCompare(b.name);
  };

  return [...items].sort((a, b) => {
    const expiryA = getCodexEffectiveExpiryMs(a, quota[a.name]);
    const expiryB = getCodexEffectiveExpiryMs(b, quota[b.name]);

    if (expiryA === null && expiryB === null) return compareTie(a, b);
    if (expiryA === null) return 1;
    if (expiryB === null) return -1;

    const expiryCompare = expiryA - expiryB;
    return expiryCompare !== 0 ? expiryCompare : compareTie(a, b);
  });
};

export function QuotaPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const antigravityQuota = useQuotaStore((state) => state.antigravityQuota);
  const claudeQuota = useQuotaStore((state) => state.claudeQuota);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const geminiCliQuota = useQuotaStore((state) => state.geminiCliQuota);
  const kimiQuota = useQuotaStore((state) => state.kimiQuota);

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [dashboardFilter, setDashboardFilter] = useState<QuotaDashboardFilter>('all');

  const disableControls = connectionStatus !== 'connected';

  const getGenericSignal = useCallback(
    (_file: AuthFileItem, quota?: QuotaStateLike): QuotaItemSignal => {
      const status = quota?.status ?? 'idle';
      const tight = isQuotaTight(quota);
      const badges: QuotaItemSignal['badges'] = [];

      if (status === 'error') {
        badges.push({ label: t('quota_management.badge_error'), tone: 'danger' });
      } else if (status === 'loading') {
        badges.push({ label: t('quota_management.badge_refreshing'), tone: 'info' });
      } else if (status !== 'success') {
        badges.push({ label: t('quota_management.badge_unchecked'), tone: 'neutral' });
      } else if (tight) {
        badges.push({ label: t('quota_management.badge_tight'), tone: 'warning' });
      }

      return {
        available: status === 'success' && !tight,
        tight,
        attention: status !== 'success',
        badges,
      };
    },
    [t]
  );

  const getCodexSignal = useCallback(
    (file: AuthFileItem, quota?: CodexQuotaState): QuotaItemSignal => {
      const status = quota?.status ?? 'idle';
      const planType = getCodexEffectivePlanType(file, quota);
      const free = planType === 'free';
      const expiryMs = getCodexEffectiveExpiryMs(file, quota);
      const now = Date.now();
      const expired = !free && expiryMs !== null && expiryMs <= now;
      const expiring = !free && expiryMs !== null && expiryMs - now <= SUBSCRIPTION_WARNING_MS;
      const tight = isQuotaTight(quota);
      const available = status === 'success' && !tight && !expired;
      const recommended = available && !free && !expiring;
      const badges: QuotaItemSignal['badges'] = [];

      if (status === 'error') {
        badges.push({ label: t('quota_management.badge_error'), tone: 'danger' });
      } else if (status === 'loading') {
        badges.push({ label: t('quota_management.badge_refreshing'), tone: 'info' });
      } else if (status !== 'success') {
        badges.push({ label: t('quota_management.badge_unchecked'), tone: 'neutral' });
      }

      if (recommended) {
        badges.push({ label: t('quota_management.badge_recommended'), tone: 'recommended' });
      }
      if (tight) {
        badges.push({ label: t('quota_management.badge_tight'), tone: 'warning' });
      }
      if (expired) {
        badges.push({ label: t('quota_management.badge_expired'), tone: 'danger' });
      } else if (expiring) {
        badges.push({ label: t('quota_management.badge_expiring'), tone: 'warning' });
      }
      if (free) {
        badges.push({ label: t('quota_management.badge_free'), tone: 'neutral' });
      }

      return {
        available,
        tight,
        expiring,
        free,
        attention: status !== 'success',
        badges,
      };
    },
    [t]
  );

  const overviewCounts = useMemo<OverviewCounts>(() => {
    const initial: OverviewCounts = {
      total: 0,
      refreshed: 0,
      all: 0,
      available: 0,
      tight: 0,
      expiring: 0,
      free: 0,
      attention: 0,
    };

    const collect = <TState extends QuotaStateLike>(
      filteredFiles: AuthFileItem[],
      quota: Record<string, TState>,
      getSignal: (file: AuthFileItem, quota: TState | undefined) => QuotaItemSignal
    ) => {
      filteredFiles.forEach((file) => {
        const state = quota[file.name];
        const signal = getSignal(file, state);
        initial.total += 1;
        initial.all += 1;
        if (state?.status === 'success' || state?.status === 'error') initial.refreshed += 1;
        if (signal.available) initial.available += 1;
        if (signal.tight) initial.tight += 1;
        if (signal.expiring) initial.expiring += 1;
        if (signal.free) initial.free += 1;
        if (signal.attention) initial.attention += 1;
      });
    };

    collect(files.filter(CODEX_CONFIG.filterFn), codexQuota, getCodexSignal);
    collect(files.filter(CLAUDE_CONFIG.filterFn), claudeQuota, getGenericSignal);
    collect(files.filter(ANTIGRAVITY_CONFIG.filterFn), antigravityQuota, getGenericSignal);
    collect(files.filter(GEMINI_CLI_CONFIG.filterFn), geminiCliQuota, getGenericSignal);
    collect(files.filter(KIMI_CONFIG.filterFn), kimiQuota, getGenericSignal);

    return initial;
  }, [
    antigravityQuota,
    claudeQuota,
    codexQuota,
    files,
    geminiCliQuota,
    getCodexSignal,
    getGenericSignal,
    kimiQuota,
  ]);

  const filterChips = useMemo(
    () => [
      {
        value: 'all' as const,
        label: t('quota_management.filter_all'),
        count: overviewCounts.all,
      },
      {
        value: 'available' as const,
        label: t('quota_management.filter_available'),
        count: overviewCounts.available,
      },
      {
        value: 'tight' as const,
        label: t('quota_management.filter_tight'),
        count: overviewCounts.tight,
      },
      {
        value: 'expiring' as const,
        label: t('quota_management.filter_expiring'),
        count: overviewCounts.expiring,
      },
      {
        value: 'free' as const,
        label: t('quota_management.filter_free'),
        count: overviewCounts.free,
      },
      {
        value: 'attention' as const,
        label: t('quota_management.filter_attention'),
        count: overviewCounts.attention,
      },
    ],
    [overviewCounts, t]
  );

  const refreshedPercent =
    overviewCounts.total > 0
      ? Math.round((overviewCounts.refreshed / overviewCounts.total) * 100)
      : 0;

  const loadConfig = useCallback(async () => {
    try {
      await configFileApi.fetchConfigYaml();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError((prev) => prev || errorMessage);
    }
  }, [t]);

  const loadFiles = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await authFilesApi.list();
      setFiles(data?.files || []);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [t]);

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([loadConfig(), loadFiles()]);
  }, [loadConfig, loadFiles]);

  useHeaderRefresh(handleHeaderRefresh);

  useEffect(() => {
    loadFiles();
    loadConfig();
  }, [loadFiles, loadConfig]);

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('quota_management.title')}</h1>
        <p className={styles.description}>{t('quota_management.description')}</p>
      </div>

      {error && (
        <EmptyState
          title={t('common.error')}
          description={error}
          variant="error"
          className={styles.quotaPageState}
          compact
        />
      )}

      <div className={styles.quotaConsole}>
        <div className={styles.quotaConsoleHero}>
          <div className={styles.quotaConsoleHeroTopline}>
            <span className={styles.quotaConsoleMetricLabel}>
              {t('quota_management.metric_refreshed')}
            </span>
            <strong>{refreshedPercent}%</strong>
          </div>
          <div className={styles.quotaConsoleProgress} aria-hidden="true">
            <span style={{ width: `${refreshedPercent}%` }} />
          </div>
          <div className={styles.quotaConsoleHeroMeta}>
            <span>
              {overviewCounts.refreshed}/{overviewCounts.total}
            </span>
            <span>{t('quota_management.metric_attention')}</span>
            <strong>{overviewCounts.attention}</strong>
          </div>
        </div>

        <div className={styles.quotaConsoleStats}>
          <div className={styles.quotaConsoleMetric}>
            <span className={styles.quotaConsoleMetricLabel}>
              {t('quota_management.metric_total')}
            </span>
            <strong>{overviewCounts.total}</strong>
          </div>
          <div className={styles.quotaConsoleMetric}>
            <span className={styles.quotaConsoleMetricLabel}>
              {t('quota_management.metric_refreshed')}
            </span>
            <strong>
              {overviewCounts.refreshed}/{overviewCounts.total}
            </strong>
          </div>
          <div className={styles.quotaConsoleMetric}>
            <span className={styles.quotaConsoleMetricLabel}>
              {t('quota_management.metric_available')}
            </span>
            <strong>{overviewCounts.available}</strong>
          </div>
          <div className={styles.quotaConsoleMetric}>
            <span className={styles.quotaConsoleMetricLabel}>
              {t('quota_management.metric_attention')}
            </span>
            <strong>{overviewCounts.attention}</strong>
          </div>
        </div>

        <div className={styles.quotaFilterChips} aria-label={t('quota_management.filter_label')}>
          {filterChips.map((chip) => (
            <button
              key={chip.value}
              type="button"
              className={`${styles.quotaFilterChip} ${
                dashboardFilter === chip.value ? styles.quotaFilterChipActive : ''
              }`}
              onClick={() => setDashboardFilter(chip.value)}
            >
              <span>{chip.label}</span>
              <strong>{chip.count}</strong>
            </button>
          ))}
        </div>
      </div>

      <QuotaSection
        config={CODEX_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        defaultViewMode="all"
        dashboardFilter={dashboardFilter}
        sortItems={sortCodexQuotaItems}
        getItemSignal={getCodexSignal}
      />
      <QuotaSection
        config={CLAUDE_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        dashboardFilter={dashboardFilter}
        getItemSignal={getGenericSignal}
      />
      <QuotaSection
        config={ANTIGRAVITY_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        dashboardFilter={dashboardFilter}
        getItemSignal={getGenericSignal}
      />
      <QuotaSection
        config={GEMINI_CLI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        dashboardFilter={dashboardFilter}
        getItemSignal={getGenericSignal}
      />
      <QuotaSection
        config={KIMI_CONFIG}
        files={files}
        loading={loading}
        disabled={disableControls}
        dashboardFilter={dashboardFilter}
        getItemSignal={getGenericSignal}
      />
    </div>
  );
}
