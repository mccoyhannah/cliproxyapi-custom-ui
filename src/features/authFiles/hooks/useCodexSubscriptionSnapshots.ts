import { useEffect, useMemo, useRef, useState } from 'react';
import { authFilesApi } from '@/services/api';
import type { AuthFileItem } from '@/types';
import {
  EMPTY_CODEX_SUBSCRIPTION_SNAPSHOT,
  isCodexFile,
  readCodexSubscriptionSnapshotFromRecord,
  type CodexSubscriptionSnapshot,
} from '@/utils/quota';

type SnapshotCacheEntry = {
  signature: string;
  snapshot: CodexSubscriptionSnapshot;
};

const buildFileSignature = (file: AuthFileItem): string =>
  [
    file.name,
    file.size ?? '',
    file.modified ?? '',
    file.lastRefresh ?? '',
    file['modtime'] ?? '',
  ].join('|');

const hasVisibleSubscription = (snapshot: CodexSubscriptionSnapshot | null | undefined): boolean =>
  snapshot?.subscriptionStatus === 'found' && Boolean(snapshot.subscriptionActiveUntil);

export function useCodexSubscriptionSnapshots(files: AuthFileItem[]) {
  const [cache, setCache] = useState<Record<string, SnapshotCacheEntry>>({});
  const cacheRef = useRef(cache);
  const listSnapshots = useMemo(() => {
    const snapshots = new Map<string, CodexSubscriptionSnapshot>();

    files.forEach((file) => {
      if (!isCodexFile(file)) return;
      const fromList = readCodexSubscriptionSnapshotFromRecord(file);
      if (fromList?.subscriptionStatus === 'found' && fromList.subscriptionActiveUntil) {
        snapshots.set(file.name, fromList);
      }
    });

    return snapshots;
  }, [files]);

  useEffect(() => {
    cacheRef.current = cache;
  }, [cache]);

  useEffect(() => {
    const codexFiles = files.filter((file) => isCodexFile(file));
    if (codexFiles.length === 0) return;

    let cancelled = false;
    const downloads: Array<{ file: AuthFileItem; signature: string }> = [];
    const currentCache = cacheRef.current;

    codexFiles.forEach((file) => {
      const signature = buildFileSignature(file);
      if (listSnapshots.has(file.name)) return;

      const cached = currentCache[file.name];
      if (cached?.signature === signature) return;
      downloads.push({ file, signature });
    });

    if (downloads.length === 0) return;

    void Promise.all(
      downloads.map(async ({ file, signature }) => {
        try {
          const authJson = await authFilesApi.downloadJsonObject(file.name);
          const snapshot =
            readCodexSubscriptionSnapshotFromRecord(authJson) ??
            EMPTY_CODEX_SUBSCRIPTION_SNAPSHOT;
          return { name: file.name, signature, snapshot };
        } catch {
          return {
            name: file.name,
            signature,
            snapshot: {
              ...EMPTY_CODEX_SUBSCRIPTION_SNAPSHOT,
              subscriptionStatus: 'read_error' as const,
            },
          };
        }
      })
    ).then((results) => {
      if (cancelled) return;
      setCache((prev) => {
        const next = { ...prev };
        results.forEach((result) => {
          next[result.name] = {
            signature: result.signature,
            snapshot: result.snapshot,
          };
        });
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [files, listSnapshots]);

  return useMemo(() => {
    const visible = new Map<string, CodexSubscriptionSnapshot>();
    files.forEach((file) => {
      const fromList = listSnapshots.get(file.name);
      if (fromList) {
        visible.set(file.name, fromList);
        return;
      }

      const cached = cache[file.name];
      if (
        cached &&
        cached.signature === buildFileSignature(file) &&
        hasVisibleSubscription(cached.snapshot)
      ) {
        visible.set(file.name, cached.snapshot);
      }
    });
    return visible;
  }, [cache, files, listSnapshots]);
}
