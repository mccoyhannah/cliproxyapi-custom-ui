import { useEffect, useMemo, useRef, useState } from 'react';
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

const HEALTHY_STATUS_MESSAGES = new Set(['ok', 'healthy', 'ready', 'success', 'available']);

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
  useEffect(() => {
    historyRef.current = history;
  }, [history]);

  useEffect(() => {
    const storage = getBrowserStorage();
    if (!storage) return;
    const now = Date.now();
    let nextHistory = readStatusFailureHistory(storage, now);

    files.forEach((file) => {
      const rawStatusMessage = getAuthFileStatusMessage(file);
      const hasStatusWarning =
        Boolean(rawStatusMessage) && !HEALTHY_STATUS_MESSAGES.has(rawStatusMessage.toLowerCase());
      const canCapture =
        hasStatusWarning && !file.disabled && !isRuntimeOnlyAuthFile(file);
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
