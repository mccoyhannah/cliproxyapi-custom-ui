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

        const results = await Promise.all(
          targets.map(async (file): Promise<LoadQuotaResult<TData>> => {
            try {
              const data = await config.fetchQuota(file, t);
              return { name: file.name, status: 'success', data };
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : t('common.unknown_error');
              const errorStatus = getStatusFromError(err);
              return { name: file.name, status: 'error', error: message, errorStatus };
            }
          })
        );

        if (requestId !== requestIdRef.current) return false;

        setQuota((prev) => {
          const nextState = { ...prev };
          results.forEach((result) => {
            if (result.status === 'success') {
              nextState[result.name] = config.buildSuccessState(result.data as TData);
            } else {
              nextState[result.name] = config.buildErrorState(
                result.error || t('common.unknown_error'),
                result.errorStatus
              );
            }
          });
          return nextState;
        });
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
