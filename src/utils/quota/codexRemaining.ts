/**
 * Codex quota remaining helpers.
 */

import type { CodexQuotaState } from '@/types';

const clampPercent = (value: number): number => Math.max(0, Math.min(100, value));

export function getCodexMinRemainingPercent(
  quota: CodexQuotaState | undefined
): number | null {
  if (!quota || quota.status !== 'success') return null;

  const remainingValues = (quota.windows ?? [])
    .map((window) => {
      const used = window.usedPercent;
      if (typeof used !== 'number' || !Number.isFinite(used)) return null;
      return clampPercent(100 - used);
    })
    .filter((value): value is number => value !== null);

  return remainingValues.length > 0 ? Math.min(...remainingValues) : null;
}

export function getCodexFiveHourRemainingPercent(
  quota: CodexQuotaState | undefined
): number | null {
  if (!quota || quota.status !== 'success') return null;

  const fiveHourWindow = (quota.windows ?? []).find((window) => window.id === 'five-hour');
  const used = fiveHourWindow?.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  return clampPercent(100 - used);
}

export function compareCodexMinRemainingPercentAsc(
  a: number | null,
  b: number | null
): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}
