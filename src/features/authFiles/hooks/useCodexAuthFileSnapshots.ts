import { useEffect, useMemo, useRef, useState } from 'react';
import { authFilesApi } from '@/services/api';
import type { AuthFileItem } from '@/types';
import {
  EMPTY_CODEX_AUTH_TOKEN_SNAPSHOT,
  EMPTY_CODEX_SUBSCRIPTION_SNAPSHOT,
  isCodexFile,
  readCodexAuthTokenSnapshotFromRecord,
  readCodexSubscriptionSnapshotFromRecord,
  type CodexAuthTokenSnapshot,
  type CodexSubscriptionSnapshot,
} from '@/utils/quota';

type SnapshotCacheEntry = {
  signature: string;
  authToken: CodexAuthTokenSnapshot;
  subscription: CodexSubscriptionSnapshot;
};

export type CodexAuthFileSnapshots = {
  authTokenSnapshots: Map<string, CodexAuthTokenSnapshot>;
  subscriptionSnapshots: Map<string, CodexSubscriptionSnapshot>;
};

const CODEX_AUTH_SNAPSHOT_CONCURRENCY = 5;

const runSnapshotDownloads = async <T>(
  downloads: Array<{ file: AuthFileItem; signature: string }>,
  worker: (download: { file: AuthFileItem; signature: string }) => Promise<T>
): Promise<T[]> => {
  const results = new Array<T>(downloads.length);
  let nextIndex = 0;

  const runNext = async () => {
    while (nextIndex < downloads.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(downloads[index] as { file: AuthFileItem; signature: string });
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(CODEX_AUTH_SNAPSHOT_CONCURRENCY, downloads.length) },
      () => runNext()
    )
  );
  return results;
};

const buildFileSignature = (file: AuthFileItem): string =>
  [
    file.name,
    file.size ?? '',
    file.modified ?? '',
    file.lastRefresh ?? '',
    file['modtime'] ?? '',
  ].join('|');

const hasVisibleSubscription = (
  snapshot: CodexSubscriptionSnapshot | null | undefined
): snapshot is CodexSubscriptionSnapshot =>
  snapshot?.subscriptionStatus === 'found' && Boolean(snapshot.subscriptionActiveUntil);

export function useCodexAuthFileSnapshots(files: AuthFileItem[]): CodexAuthFileSnapshots {
  const [cache, setCache] = useState<Record<string, SnapshotCacheEntry>>({});
  const cacheRef = useRef(cache);

  const listSubscriptionSnapshots = useMemo(() => {
    const snapshots = new Map<string, CodexSubscriptionSnapshot>();

    files.forEach((file) => {
      if (!isCodexFile(file)) return;
      const fromList = readCodexSubscriptionSnapshotFromRecord(file);
      if (hasVisibleSubscription(fromList)) {
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
      const cached = currentCache[file.name];
      if (cached?.signature === signature) return;
      downloads.push({ file, signature });
    });

    if (downloads.length === 0) return;

    void runSnapshotDownloads(
      downloads,
      async ({ file, signature }) => {
        try {
          const authJson = await authFilesApi.downloadJsonObject(file.name);
          return {
            name: file.name,
            signature,
            authToken: readCodexAuthTokenSnapshotFromRecord(authJson, { assumeComplete: true }),
            subscription:
              readCodexSubscriptionSnapshotFromRecord(authJson) ??
              EMPTY_CODEX_SUBSCRIPTION_SNAPSHOT,
          };
        } catch {
          return {
            name: file.name,
            signature,
            authToken: {
              ...EMPTY_CODEX_AUTH_TOKEN_SNAPSHOT,
              accessTokenStatus: 'unknown' as const,
            },
            subscription: {
              ...EMPTY_CODEX_SUBSCRIPTION_SNAPSHOT,
              subscriptionStatus: 'read_error' as const,
            },
          };
        }
      }
    ).then((results) => {
      if (cancelled) return;
      setCache((prev) => {
        const next = { ...prev };
        results.forEach((result) => {
          next[result.name] = {
            signature: result.signature,
            authToken: result.authToken,
            subscription: result.subscription,
          };
        });
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [files]);

  return useMemo(() => {
    const authTokenSnapshots = new Map<string, CodexAuthTokenSnapshot>();
    const subscriptionSnapshots = new Map<string, CodexSubscriptionSnapshot>();

    files.forEach((file) => {
      if (!isCodexFile(file)) return;
      const signature = buildFileSignature(file);
      const cached = cache[file.name];

      if (cached?.signature === signature) {
        authTokenSnapshots.set(file.name, cached.authToken);
        if (hasVisibleSubscription(cached.subscription)) {
          subscriptionSnapshots.set(file.name, cached.subscription);
        }
        return;
      }

      const listSubscription = listSubscriptionSnapshots.get(file.name);
      if (listSubscription) {
        subscriptionSnapshots.set(file.name, listSubscription);
      }
    });

    return { authTokenSnapshots, subscriptionSnapshots };
  }, [cache, files, listSubscriptionSnapshots]);
}
