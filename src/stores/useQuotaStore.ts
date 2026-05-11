/**
 * Quota cache that survives route switches.
 */

import { create } from 'zustand';
import type { AntigravityQuotaState, ClaudeQuotaState, CodexQuotaState, GeminiCliQuotaState, KimiQuotaState } from '@/types';

type QuotaUpdater<T> = T | ((prev: T) => T);
export type QuotaRefreshType = 'antigravity' | 'claude' | 'codex' | 'gemini-cli' | 'kimi';

export interface QuotaRefreshMeta {
  signature: string;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
}

type QuotaRefreshMetaByType = Partial<Record<QuotaRefreshType, QuotaRefreshMeta>>;

interface QuotaStoreState {
  antigravityQuota: Record<string, AntigravityQuotaState>;
  claudeQuota: Record<string, ClaudeQuotaState>;
  codexQuota: Record<string, CodexQuotaState>;
  geminiCliQuota: Record<string, GeminiCliQuotaState>;
  kimiQuota: Record<string, KimiQuotaState>;
  quotaRefreshMeta: QuotaRefreshMetaByType;
  quotaRefreshInFlight: Partial<Record<QuotaRefreshType, boolean>>;
  setAntigravityQuota: (updater: QuotaUpdater<Record<string, AntigravityQuotaState>>) => void;
  setClaudeQuota: (updater: QuotaUpdater<Record<string, ClaudeQuotaState>>) => void;
  setCodexQuota: (updater: QuotaUpdater<Record<string, CodexQuotaState>>) => void;
  setGeminiCliQuota: (updater: QuotaUpdater<Record<string, GeminiCliQuotaState>>) => void;
  setKimiQuota: (updater: QuotaUpdater<Record<string, KimiQuotaState>>) => void;
  setQuotaRefreshMeta: (
    type: QuotaRefreshType,
    updater: QuotaUpdater<QuotaRefreshMeta>
  ) => void;
  setQuotaRefreshInFlight: (type: QuotaRefreshType, inFlight: boolean) => void;
  clearQuotaCache: () => void;
}

const resolveUpdater = <T,>(updater: QuotaUpdater<T>, prev: T): T => {
  if (typeof updater === 'function') {
    return (updater as (value: T) => T)(prev);
  }
  return updater;
};

export const useQuotaStore = create<QuotaStoreState>((set) => ({
  antigravityQuota: {},
  claudeQuota: {},
  codexQuota: {},
  geminiCliQuota: {},
  kimiQuota: {},
  quotaRefreshMeta: {},
  quotaRefreshInFlight: {},
  setAntigravityQuota: (updater) =>
    set((state) => ({
      antigravityQuota: resolveUpdater(updater, state.antigravityQuota)
    })),
  setClaudeQuota: (updater) =>
    set((state) => ({
      claudeQuota: resolveUpdater(updater, state.claudeQuota)
    })),
  setCodexQuota: (updater) =>
    set((state) => ({
      codexQuota: resolveUpdater(updater, state.codexQuota)
    })),
  setGeminiCliQuota: (updater) =>
    set((state) => ({
      geminiCliQuota: resolveUpdater(updater, state.geminiCliQuota)
    })),
  setKimiQuota: (updater) =>
    set((state) => ({
      kimiQuota: resolveUpdater(updater, state.kimiQuota)
    })),
  setQuotaRefreshMeta: (type, updater) =>
    set((state) => {
      const previous =
        state.quotaRefreshMeta[type] ?? {
          signature: '',
          lastStartedAt: null,
          lastCompletedAt: null
        };
      return {
        quotaRefreshMeta: {
          ...state.quotaRefreshMeta,
          [type]: resolveUpdater(updater, previous)
        }
      };
    }),
  setQuotaRefreshInFlight: (type, inFlight) =>
    set((state) => ({
      quotaRefreshInFlight: {
        ...state.quotaRefreshInFlight,
        [type]: inFlight
      }
    })),
  clearQuotaCache: () =>
    set({
      antigravityQuota: {},
      claudeQuota: {},
      codexQuota: {},
      geminiCliQuota: {},
      kimiQuota: {},
      quotaRefreshMeta: {},
      quotaRefreshInFlight: {}
    })
}));
