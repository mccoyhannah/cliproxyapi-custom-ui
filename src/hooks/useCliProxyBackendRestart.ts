import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  cliProxyBackendControlApi,
  launchCliProxyBackendControlSidecar,
  type CliProxyBackendControlStatus,
  type CliProxyBackendRestartResponse,
} from '@/services/api/cliProxyBackendControl';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';

const CONTROL_WAKE_ATTEMPTS = 18;
const CONTROL_WAKE_INTERVAL_MS = 850;

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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

type UseCliProxyBackendRestartOptions = {
  autoLoadStatus?: boolean;
};

export function useCliProxyBackendRestart(options: UseCliProxyBackendRestartOptions = {}) {
  const autoLoadStatus = options.autoLoadStatus !== false;
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const showNotification = useNotificationStore((state) => state.showNotification);

  const [status, setStatus] = useState<CliProxyBackendControlStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [waking, setWaking] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState('');

  const hydrateStatus = useCallback((nextStatus: CliProxyBackendControlStatus) => {
    setStatus(nextStatus);
    setError('');
  }, []);

  const loadStatus = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
      }
      try {
        const nextStatus = await cliProxyBackendControlApi.getStatus();
        hydrateStatus(nextStatus);
        return nextStatus;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setStatus(null);
        setError(silent ? '' : message);
        return null;
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [hydrateStatus]
  );

  const wake = useCallback(
    async ({
      force = false,
      notify = false,
      launch = true,
    }: { force?: boolean; notify?: boolean; launch?: boolean } = {}) => {
      if (!force && status && !error) {
        return status;
      }

      setWaking(true);
      setError('');
      try {
        if (launch) {
          const launched = launchCliProxyBackendControlSidecar();
          if (!launched) {
            const message = t('backend_control.wake_unavailable');
            setError(message);
            if (notify) {
              showNotification(message, 'error');
            }
            return null;
          }
        }

        let lastError = '';
        for (let attempt = 0; attempt < CONTROL_WAKE_ATTEMPTS; attempt += 1) {
          await wait(attempt === 0 ? 650 : CONTROL_WAKE_INTERVAL_MS);
          try {
            const nextStatus = await cliProxyBackendControlApi.getStatus();
            hydrateStatus(nextStatus);
            if (notify) {
              showNotification(t('backend_control.wake_success'), 'success');
            }
            return nextStatus;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
        }

        const message = t('backend_control.wake_failed', { message: lastError });
        setStatus(null);
        setError(message);
        if (notify) {
          showNotification(message, 'error');
        }
        return null;
      } finally {
        setWaking(false);
      }
    },
    [error, hydrateStatus, showNotification, status, t]
  );

  const requestWithWakeRetry = useCallback(
    async <T,>(request: () => Promise<T>): Promise<T> => {
      try {
        return await request();
      } catch (err) {
        if (!isControlOfflineError(err)) {
          throw err;
        }
        const nextStatus = await wake({ force: true, notify: false });
        if (!nextStatus) {
          throw err;
        }
        return request();
      }
    },
    [wake]
  );

  const refreshBackendState = useCallback(async () => {
    useConfigStore.getState().clearCache();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (attempt > 0) {
        await wait(900);
      }
      const ok = await useAuthStore.getState().checkAuth();
      if (ok) {
        return true;
      }
    }
    return false;
  }, []);

  const restartBackend = useCallback(async (): Promise<CliProxyBackendRestartResponse | null> => {
    if (connectionStatus !== 'connected' || !managementKey) {
      showNotification(t('notification.connection_required'), 'warning');
      return null;
    }

    setRestarting(true);
    setError('');
    try {
      if (!status || error) {
        const nextStatus = await wake({ force: true, notify: false });
        if (!nextStatus) {
          throw new Error(t('backend_control.wake_failed_short'));
        }
      }

      const result = await requestWithWakeRetry(() =>
        cliProxyBackendControlApi.restart({
          apiBase,
          managementKey,
        })
      );
      hydrateStatus(result.status);
      const refreshed = await refreshBackendState();

      showNotification(
        t('backend_control.restart_success', {
          oldPid: result.result.oldPid ?? '-',
          newPid: result.result.newPid ?? '-',
        }),
        'success'
      );
      if (!refreshed) {
        showNotification(t('backend_control.refresh_after_restart_failed'), 'warning');
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      showNotification(t('backend_control.restart_failed', { message }), 'error');
      return null;
    } finally {
      setRestarting(false);
    }
  }, [
    apiBase,
    connectionStatus,
    error,
    hydrateStatus,
    managementKey,
    refreshBackendState,
    requestWithWakeRetry,
    showNotification,
    status,
    t,
    wake,
  ]);

  useEffect(() => {
    if (!autoLoadStatus) return;
    void loadStatus(true);
  }, [autoLoadStatus, loadStatus]);

  return {
    status,
    error,
    loading,
    waking,
    restarting,
    busy: loading || waking || restarting,
    loadStatus,
    wake,
    restartBackend,
  };
}
