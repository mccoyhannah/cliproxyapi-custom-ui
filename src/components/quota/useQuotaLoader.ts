/**
 * Generic hook for quota data fetching and management.
 */

import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { AuthFileItem } from '@/types';
import { useQuotaStore } from '@/stores';
import { getStatusFromError } from '@/utils/quota';
import type { QuotaConfig } from './quotaConfigs';

type QuotaScope = 'page' | 'all';

type QuotaUpdater<T> = T | ((prev: T) => T);

type QuotaSetter<T> = (updater: QuotaUpdater<T>) => void;

interface LoadQuotaResult<TData> {
  name: string;
  status: 'success' | 'error';
  data?: TData;
  error?: string;
  errorStatus?: number;
}

const REFRESH_ALL_BATCH_SIZE = 3;
const REFRESH_ALL_MIN_DELAY_MS = 600;
const REFRESH_ALL_MAX_DELAY_MS = 1600;

const sleep = (durationMs: number) =>
  new Promise((resolve) => {
    window.setTimeout(resolve, durationMs);
  });

const randomDelayMs = () =>
  REFRESH_ALL_MIN_DELAY_MS +
  Math.floor(Math.random() * (REFRESH_ALL_MAX_DELAY_MS - REFRESH_ALL_MIN_DELAY_MS + 1));

const shuffleTargets = (targets: AuthFileItem[]) => {
  const shuffled = [...targets];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
};

export interface LoadQuotaOptions {
  preserveExisting?: boolean;
  silent?: boolean;
  onStart?: () => void;
  onComplete?: () => void;
}

export function useQuotaLoader<TState, TData>(config: QuotaConfig<TState, TData>) {
  const { t } = useTranslation();
  const quota = useQuotaStore(config.storeSelector);
  const setQuota = useQuotaStore((state) => state[config.storeSetter]) as QuotaSetter<
    Record<string, TState>
  >;

  const loadingRef = useRef(false);
  const requestIdRef = useRef(0);

  const loadQuota = useCallback(
    async (
      targets: AuthFileItem[],
      scope: QuotaScope,
      setLoading: (loading: boolean, scope?: QuotaScope | null) => void,
      options: LoadQuotaOptions = {}
    ): Promise<boolean> => {
      const quotaStore = useQuotaStore.getState();
      if (
        loadingRef.current ||
        quotaStore.quotaRefreshInFlight[config.type] ||
        targets.length === 0
      ) {
        return false;
      }

      loadingRef.current = true;
      quotaStore.setQuotaRefreshInFlight(config.type, true);
      const requestId = ++requestIdRef.current;
      options.onStart?.();
      if (!options.silent) {
        setLoading(true, scope);
      }

      try {
        setQuota((prev) => {
          const nextState = { ...prev };
          targets.forEach((file) => {
            const currentStatus = (nextState[file.name] as { status?: unknown } | undefined)
              ?.status;
            if (
              !options.preserveExisting ||
              !nextState[file.name] ||
              currentStatus === 'idle'
            ) {
              nextState[file.name] = config.buildLoadingState();
            }
          });
          return nextState;
        });

        const applyResult = (result: LoadQuotaResult<TData>) => {
          setQuota((prev) => {
            const nextState = { ...prev };
            if (result.status === 'success') {
              nextState[result.name] = config.buildSuccessState(result.data as TData);
            } else {
              nextState[result.name] = config.buildErrorState(
                result.error || t('common.unknown_error'),
                result.errorStatus
              );
            }
            return nextState;
          });
        };

        const loadOne = async (file: AuthFileItem): Promise<LoadQuotaResult<TData>> => {
          try {
            const data = await config.fetchQuota(file, t);
            return { name: file.name, status: 'success', data };
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : t('common.unknown_error');
            const errorStatus = getStatusFromError(err);
            return { name: file.name, status: 'error', error: message, errorStatus };
          }
        };

        const orderedTargets = scope === 'all' && targets.length > 1 ? shuffleTargets(targets) : targets;
        const batchSize =
          scope === 'all' && orderedTargets.length > 1 ? REFRESH_ALL_BATCH_SIZE : orderedTargets.length;

        for (let index = 0; index < orderedTargets.length; index += batchSize) {
          if (requestId !== requestIdRef.current) return false;

          const batch = orderedTargets.slice(index, index + batchSize);
          const results = await Promise.all(
            batch.map(async (file): Promise<LoadQuotaResult<TData>> => {
              const result = await loadOne(file);
              if (requestId === requestIdRef.current) {
                applyResult(result);
              }
              return result;
            })
          );

          if (requestId !== requestIdRef.current) return false;
          if (results.length === 0) continue;
          if (index + batchSize < orderedTargets.length && scope === 'all') {
            await sleep(randomDelayMs());
          }
        }

        return true;
      } finally {
        if (requestId === requestIdRef.current) {
          options.onComplete?.();
          if (!options.silent) {
            setLoading(false);
          }
          loadingRef.current = false;
          useQuotaStore.getState().setQuotaRefreshInFlight(config.type, false);
        }
      }
    },
    [config, setQuota, t]
  );

  return { quota, loadQuota };
}
