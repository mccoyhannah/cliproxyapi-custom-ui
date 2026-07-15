import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AuthFileItem } from '@/types';
import type { AuthFileStatusBarData } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import {
  getAuthFileStatusMessage,
  getAuthFileStatusProblem,
  isRuntimeOnlyAuthFile,
} from '@/features/authFiles/constants';
import {
  STATUS_FAILURE_HISTORY_STORAGE_KEY,
  clearActiveStatusFailure,
  createEmptyStatusFailureHistory,
  findLatestCapturableFailureBlock,
  getNextStatusFailureExpiry,
  getStatusFailureBucketsForFile,
  hasLatestSuccessfulRequestBlock,
  mergeStatusFailureHistories,
  parseStatusFailureHistory,
  readStatusFailureHistory,
  recordStatusFailure,
  serializeStatusFailureHistory,
  writeStatusFailureHistory,
  type StatusFailureHistoryStore,
} from '@/features/authFiles/statusFailureHistory';
import {
  launchPriorityRotationSidecar,
  priorityRotationSidecarApi,
  type AuthFailureHistoryResponse,
} from '@/services/api/priorityRotationSidecar';

const HEALTHY_STATUS_MESSAGES = new Set(['ok', 'healthy', 'ready', 'success', 'available']);
const AUTH_FAILURE_HISTORY_REFRESH_INTERVAL_MS = 10_000;
const AUTH_FAILURE_HISTORY_WAKE_COOLDOWN_MS = AUTH_FAILURE_HISTORY_REFRESH_INTERVAL_MS;
const AUTH_FAILURE_HISTORY_WAKE_ATTEMPTS = 8;
const AUTH_FAILURE_HISTORY_WAKE_INITIAL_DELAY_MS = 650;
const AUTH_FAILURE_HISTORY_WAKE_RETRY_MS = 350;

const wait = (delayMs: number, signal: AbortSignal) =>
  new Promise<boolean>((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }
    let timeoutId: number | null = null;
    const handleAbort = () => {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      resolve(false);
    };
    signal.addEventListener('abort', handleAbort, { once: true });
    timeoutId = window.setTimeout(() => {
      signal.removeEventListener('abort', handleAbort);
      resolve(true);
    }, delayMs);
  });

const getRequestStatus = (error: unknown): number | null => {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  const status = Number((error as { status?: unknown }).status);
  return Number.isInteger(status) ? status : null;
};

const getBrowserStorage = () => {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

export function useAuthFilesFailureHistory(
  files: AuthFileItem[],
  statusDataByFileName: Map<string, AuthFileStatusBarData>
) {
  const [history, setHistory] = useState<StatusFailureHistoryStore>(() => {
    const storage = getBrowserStorage();
    return storage
      ? readStatusFailureHistory(storage, Date.now())
      : createEmptyStatusFailureHistory();
  });
  const historyRef = useRef(history);
  const remoteRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const remoteAbortControllerRef = useRef<AbortController | null>(null);
  const sidecarWakeRetryAtRef = useRef(0);
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  const mergeRemoteHistory = useCallback((response: AuthFailureHistoryResponse) => {
    const mergeNow = Date.now();
    const storage = getBrowserStorage();
    const remoteHistory = parseStatusFailureHistory(
      JSON.stringify(response),
      mergeNow,
      'observer'
    );
    const mergedWithRemote = mergeStatusFailureHistories(
      historyRef.current,
      remoteHistory,
      mergeNow
    );
    const mergedHistory = storage
      ? mergeStatusFailureHistories(
          mergedWithRemote,
          readStatusFailureHistory(storage, mergeNow),
          mergeNow
        )
      : mergedWithRemote;
    if (storage) writeStatusFailureHistory(storage, mergedHistory);
    historyRef.current = mergedHistory;
    setHistory((current) =>
      serializeStatusFailureHistory(current) === serializeStatusFailureHistory(mergedHistory)
        ? current
        : mergedHistory
    );
  }, []);

  const refreshRemoteHistory = useCallback(async () => {
    if (remoteRefreshInFlightRef.current) return remoteRefreshInFlightRef.current;

    const controller = new AbortController();
    remoteAbortControllerRef.current = controller;
    const refreshPromise = (async () => {
      try {
        const response = await priorityRotationSidecarApi.getAuthFailureHistory(controller.signal);
        if (controller.signal.aborted) return;
        sidecarWakeRetryAtRef.current = 0;
        mergeRemoteHistory(response);
        return;
      } catch (error) {
        if (controller.signal.aborted) return;
        if (getRequestStatus(error) !== null || Date.now() < sidecarWakeRetryAtRef.current) return;
      }

      sidecarWakeRetryAtRef.current = Date.now() + AUTH_FAILURE_HISTORY_WAKE_COOLDOWN_MS;
      if (!launchPriorityRotationSidecar()) return;
      for (let attempt = 0; attempt < AUTH_FAILURE_HISTORY_WAKE_ATTEMPTS; attempt += 1) {
        const shouldContinue = await wait(
          attempt === 0
            ? AUTH_FAILURE_HISTORY_WAKE_INITIAL_DELAY_MS
            : AUTH_FAILURE_HISTORY_WAKE_RETRY_MS,
          controller.signal
        );
        if (!shouldContinue) return;
        try {
          const response = await priorityRotationSidecarApi.getAuthFailureHistory(
            controller.signal
          );
          if (controller.signal.aborted) return;
          sidecarWakeRetryAtRef.current = 0;
          mergeRemoteHistory(response);
          return;
        } catch (error) {
          if (controller.signal.aborted) return;
          if (getRequestStatus(error) !== null) return;
        }
      }
    })().finally(() => {
      if (remoteAbortControllerRef.current === controller) {
        remoteAbortControllerRef.current = null;
      }
      if (remoteRefreshInFlightRef.current === refreshPromise) {
        remoteRefreshInFlightRef.current = null;
      }
    });
    remoteRefreshInFlightRef.current = refreshPromise;
    return refreshPromise;
  }, [mergeRemoteHistory]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    const refreshIfVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void refreshRemoteHistory();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return;
      sidecarWakeRetryAtRef.current = 0;
      void refreshRemoteHistory();
    };

    refreshIfVisible();
    const intervalId = window.setInterval(
      refreshIfVisible,
      AUTH_FAILURE_HISTORY_REFRESH_INTERVAL_MS
    );
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      remoteAbortControllerRef.current?.abort(
        new DOMException('Auth failure history view unmounted', 'AbortError')
      );
      remoteAbortControllerRef.current = null;
      remoteRefreshInFlightRef.current = null;
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [refreshRemoteHistory]);

  useEffect(() => {
    const storage = getBrowserStorage();
    if (!storage) return;
    const now = Date.now();
    let nextHistory = readStatusFailureHistory(storage, now);

    files.forEach((file) => {
      const rawStatusMessage = getAuthFileStatusMessage(file);
      const hasStatusWarning =
        Boolean(rawStatusMessage) && !HEALTHY_STATUS_MESSAGES.has(rawStatusMessage.toLowerCase());
      const canCapture = hasStatusWarning && !file.disabled && !isRuntimeOnlyAuthFile(file);
      if (!canCapture) {
        nextHistory = clearActiveStatusFailure(nextHistory, file.name, now);
        return;
      }

      const statusData = statusDataByFileName.get(file.name);
      const latestFailure = statusData
        ? findLatestCapturableFailureBlock(statusData.blockDetails, now)
        : null;
      const problem = getAuthFileStatusProblem(file);
      if (!latestFailure) {
        if (statusData && hasLatestSuccessfulRequestBlock(statusData.blockDetails)) {
          nextHistory = clearActiveStatusFailure(nextHistory, file.name, now);
        }
        return;
      }
      if (!problem) return;

      nextHistory = recordStatusFailure(nextHistory, {
        fileName: file.name,
        bucket: latestFailure.block,
        category: problem.category,
        message: problem.message || rawStatusMessage,
        observedAt: now,
        source: 'browser',
      });
    });

    const updateId = window.setTimeout(() => {
      const mergeNow = Date.now();
      const mergedHistory = mergeStatusFailureHistories(
        mergeStatusFailureHistories(historyRef.current, nextHistory, mergeNow),
        readStatusFailureHistory(storage, mergeNow),
        mergeNow
      );
      writeStatusFailureHistory(storage, mergedHistory);
      historyRef.current = mergedHistory;
      setHistory((current) =>
        serializeStatusFailureHistory(current) === serializeStatusFailureHistory(mergedHistory)
          ? current
          : mergedHistory
      );
    }, 0);
    return () => window.clearTimeout(updateId);
  }, [files, statusDataByFileName]);

  const nextExpiry = useMemo(() => getNextStatusFailureExpiry(history), [history]);
  useEffect(() => {
    if (nextExpiry === null || typeof window === 'undefined') return;
    const delay = Math.min(Math.max(0, nextExpiry - Date.now() + 25), 2_147_483_647);
    const timeoutId = window.setTimeout(() => {
      const storage = getBrowserStorage();
      if (!storage) return;
      const cleanupNow = Date.now();
      const nextHistory = mergeStatusFailureHistories(
        historyRef.current,
        readStatusFailureHistory(storage, cleanupNow),
        cleanupNow
      );
      writeStatusFailureHistory(storage, nextHistory);
      historyRef.current = nextHistory;
      setHistory(nextHistory);
    }, delay);
    return () => window.clearTimeout(timeoutId);
  }, [nextExpiry]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== STATUS_FAILURE_HISTORY_STORAGE_KEY) return;
      const storage = getBrowserStorage();
      if (!storage) return;
      const mergeNow = Date.now();
      const mergedHistory = mergeStatusFailureHistories(
        mergeStatusFailureHistories(
          historyRef.current,
          parseStatusFailureHistory(event.newValue, mergeNow),
          mergeNow
        ),
        readStatusFailureHistory(storage, mergeNow),
        mergeNow
      );
      writeStatusFailureHistory(storage, mergedHistory);
      historyRef.current = mergedHistory;
      setHistory(mergedHistory);
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  return useMemo(() => {
    const byFileName = new Map<string, ReturnType<typeof getStatusFailureBucketsForFile>>();
    files.forEach((file) => {
      byFileName.set(file.name, getStatusFailureBucketsForFile(history, file.name));
    });
    return byFileName;
  }, [files, history]);
}
