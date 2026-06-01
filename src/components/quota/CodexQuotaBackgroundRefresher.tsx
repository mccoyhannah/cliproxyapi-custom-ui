import { useCallback, useEffect, useRef } from 'react';
import { authFilesApi } from '@/services/api';
import { useAuthStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { CODEX_CONFIG } from './quotaConfigs';
import { useQuotaLoader } from './useQuotaLoader';

const buildSignature = (files: AuthFileItem[]) => files.map((file) => file.name).join('|');

export function CodexQuotaBackgroundRefresher() {
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const setQuotaRefreshMeta = useQuotaStore((state) => state.setQuotaRefreshMeta);
  const { loadQuota } = useQuotaLoader(CODEX_CONFIG);
  const initialRefreshAttemptedRef = useRef(false);
  const refreshInFlightRef = useRef(false);

  const refreshCodexQuota = useCallback(async () => {
    if (connectionStatus !== 'connected') return false;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return false;
    if (initialRefreshAttemptedRef.current) return false;
    if (refreshInFlightRef.current) return false;

    initialRefreshAttemptedRef.current = true;
    refreshInFlightRef.current = true;
    try {
      const response = await authFilesApi.list();
      const targets = (response.files || []).filter((file) => CODEX_CONFIG.filterFn(file));
      const signature = buildSignature(targets);

      if (targets.length === 0) {
        setQuotaRefreshMeta('codex', {
          signature: '',
          lastStartedAt: null,
          lastCompletedAt: null,
        });
        return false;
      }

      const quotaState = useQuotaStore.getState();
      const hasAnyExistingQuota = targets.some((file) => {
        const status = quotaState.codexQuota[file.name]?.status;
        return status === 'success' || status === 'error';
      });

      const setSilentLoading = () => {};
      return loadQuota(targets, 'all', setSilentLoading, {
        preserveExisting: hasAnyExistingQuota,
        silent: true,
        onStart: () => {
          const startedAt = Date.now();
          setQuotaRefreshMeta('codex', (prev) => ({
            signature,
            lastStartedAt: startedAt,
            lastCompletedAt: prev.signature === signature ? prev.lastCompletedAt : null,
          }));
        },
        onComplete: () => {
          const completedAt = Date.now();
          setQuotaRefreshMeta('codex', (prev) => ({
            signature,
            lastStartedAt: prev.lastStartedAt ?? completedAt,
            lastCompletedAt: completedAt,
          }));
        },
      });
    } catch (error) {
      console.warn('Codex quota background refresh failed:', error);
      return false;
    } finally {
      refreshInFlightRef.current = false;
    }
  }, [connectionStatus, loadQuota, setQuotaRefreshMeta]);

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    void refreshCodexQuota();
  }, [connectionStatus, refreshCodexQuota]);

  useEffect(() => {
    if (connectionStatus !== 'connected') return;
    if (typeof document === 'undefined') return;

    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshCodexQuota();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [connectionStatus, refreshCodexQuota]);

  return null;
}
