import type { AuthFileItem, CodexQuotaState } from '@/types';
import {
  getCodexFiveHourRemainingPercent,
  isCodexFile,
  isDisabledAuthFile,
  isRuntimeOnlyAuthFile,
  normalizePlanType,
  resolveCodexPlanType,
} from '@/utils/quota';
import { parsePriorityValue } from './constants';

const STORAGE_KEY = 'authFilesPage.priorityRotation.v1';
const DEFAULT_THRESHOLD_PERCENT = 50;
const MANAGED_CODEX_PLANS = new Set(['team', 'plus']);

export type PriorityRotationChangeRole = 'demote' | 'promote';
export type PriorityRotationStatus =
  | 'ready'
  | 'no_changes'
  | 'quota_unknown'
  | 'insufficient_layers'
  | 'no_standby';

export type AuthFilesPriorityRotationSettings = {
  thresholdPercent: number;
  lastAppliedAt?: number;
  lastAppliedChangeCount?: number;
};

export type PriorityRotationChange = {
  name: string;
  displayName: string;
  fromPriority: number;
  toPriority: number;
  remainingPercent: number;
  role: PriorityRotationChangeRole;
};

export type PriorityRotationAnalysis = {
  thresholdPercent: number;
  status: PriorityRotationStatus;
  managedCount: number;
  unknownCount: number;
  activePriority: number | null;
  standbyPriority: number | null;
  reservePriority: number | null;
  activeCount: number;
  healthyActiveCount: number;
  standbyCount: number;
  healthyStandbyCount: number;
  changes: PriorityRotationChange[];
};

type PriorityRotationCandidate = {
  file: AuthFileItem;
  priority: number;
  remainingPercent: number;
};

const clampThresholdPercent = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_THRESHOLD_PERCENT;
  return Math.max(1, Math.min(99, Math.round(numeric)));
};

export const readAuthFilesPriorityRotationSettings =
  (): AuthFilesPriorityRotationSettings => {
    if (typeof window === 'undefined') {
      return { thresholdPercent: DEFAULT_THRESHOLD_PERCENT };
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return { thresholdPercent: DEFAULT_THRESHOLD_PERCENT };
      const parsed = JSON.parse(raw) as Partial<AuthFilesPriorityRotationSettings>;
      return {
        thresholdPercent: clampThresholdPercent(parsed.thresholdPercent),
        lastAppliedAt:
          typeof parsed.lastAppliedAt === 'number' && Number.isFinite(parsed.lastAppliedAt)
            ? parsed.lastAppliedAt
            : undefined,
        lastAppliedChangeCount:
          typeof parsed.lastAppliedChangeCount === 'number' &&
          Number.isFinite(parsed.lastAppliedChangeCount)
            ? parsed.lastAppliedChangeCount
            : undefined,
      };
    } catch {
      return { thresholdPercent: DEFAULT_THRESHOLD_PERCENT };
    }
  };

export const writeAuthFilesPriorityRotationSettings = (
  settings: AuthFilesPriorityRotationSettings
) => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...settings,
        thresholdPercent: clampThresholdPercent(settings.thresholdPercent),
      })
    );
  } catch {
    // ignore
  }
};

const getDisplayName = (file: AuthFileItem): string => {
  const note = typeof file.note === 'string' ? file.note.trim() : '';
  return note || file.name;
};

const isManagedPlan = (planType: string | null): boolean =>
  planType !== null && MANAGED_CODEX_PLANS.has(planType);

const buildEmptyAnalysis = (
  thresholdPercent: number,
  status: PriorityRotationStatus,
  unknownCount = 0
): PriorityRotationAnalysis => ({
  thresholdPercent,
  status,
  managedCount: 0,
  unknownCount,
  activePriority: null,
  standbyPriority: null,
  reservePriority: null,
  activeCount: 0,
  healthyActiveCount: 0,
  standbyCount: 0,
  healthyStandbyCount: 0,
  changes: [],
});

export const analyzeCodexPriorityRotation = (
  files: AuthFileItem[],
  codexQuota: Record<string, CodexQuotaState>,
  thresholdPercent: number
): PriorityRotationAnalysis => {
  const threshold = clampThresholdPercent(thresholdPercent);
  const candidates: PriorityRotationCandidate[] = [];
  let unknownCount = 0;

  files.forEach((file) => {
    if (!isCodexFile(file) || isDisabledAuthFile(file) || isRuntimeOnlyAuthFile(file)) return;

    const quota = codexQuota[file.name];
    const planType = normalizePlanType(quota?.planType ?? resolveCodexPlanType(file));
    if (planType !== null && !isManagedPlan(planType)) return;

    const remainingPercent = getCodexFiveHourRemainingPercent(quota);
    const priority = parsePriorityValue(file.priority ?? file['priority']) ?? 0;

    if (planType === null || remainingPercent === null) {
      unknownCount++;
      return;
    }

    candidates.push({
      file,
      priority,
      remainingPercent,
    });
  });

  if (candidates.length === 0) {
    return buildEmptyAnalysis(
      threshold,
      unknownCount > 0 ? 'quota_unknown' : 'no_changes',
      unknownCount
    );
  }

  const priorities = Array.from(new Set(candidates.map((candidate) => candidate.priority))).sort(
    (a, b) => b - a
  );
  const [activePriority = null, standbyPriority = null, reservePriority = null] = priorities;

  if (activePriority === null || standbyPriority === null) {
    return {
      ...buildEmptyAnalysis(threshold, 'insufficient_layers', unknownCount),
      managedCount: candidates.length,
      activePriority,
      standbyPriority,
      reservePriority,
      activeCount: candidates.filter((candidate) => candidate.priority === activePriority).length,
    };
  }

  const activeCandidates = candidates.filter(
    (candidate) => candidate.priority === activePriority
  );
  const standbyCandidates = candidates.filter(
    (candidate) => candidate.priority === standbyPriority
  );
  const healthyActiveCandidates = activeCandidates.filter(
    (candidate) => candidate.remainingPercent >= threshold
  );
  const healthyStandbyCandidates = standbyCandidates.filter(
    (candidate) => candidate.remainingPercent >= threshold
  );

  if (healthyActiveCandidates.length > 0) {
    return {
      thresholdPercent: threshold,
      status: 'no_changes',
      managedCount: candidates.length,
      unknownCount,
      activePriority,
      standbyPriority,
      reservePriority,
      activeCount: activeCandidates.length,
      healthyActiveCount: healthyActiveCandidates.length,
      standbyCount: standbyCandidates.length,
      healthyStandbyCount: healthyStandbyCandidates.length,
      changes: [],
    };
  }

  if (healthyStandbyCandidates.length === 0) {
    return {
      thresholdPercent: threshold,
      status: 'no_standby',
      managedCount: candidates.length,
      unknownCount,
      activePriority,
      standbyPriority,
      reservePriority,
      activeCount: activeCandidates.length,
      healthyActiveCount: 0,
      standbyCount: standbyCandidates.length,
      healthyStandbyCount: 0,
      changes: [],
    };
  }

  const demotions = activeCandidates.map<PriorityRotationChange>((candidate) => ({
    name: candidate.file.name,
    displayName: getDisplayName(candidate.file),
    fromPriority: activePriority,
    toPriority: standbyPriority,
    remainingPercent: candidate.remainingPercent,
    role: 'demote',
  }));
  const promotions = healthyStandbyCandidates.map<PriorityRotationChange>((candidate) => ({
    name: candidate.file.name,
    displayName: getDisplayName(candidate.file),
    fromPriority: standbyPriority,
    toPriority: activePriority,
    remainingPercent: candidate.remainingPercent,
    role: 'promote',
  }));

  return {
    thresholdPercent: threshold,
    status: 'ready',
    managedCount: candidates.length,
    unknownCount,
    activePriority,
    standbyPriority,
    reservePriority,
    activeCount: activeCandidates.length,
    healthyActiveCount: 0,
    standbyCount: standbyCandidates.length,
    healthyStandbyCount: healthyStandbyCandidates.length,
    changes: [...demotions, ...promotions],
  };
};
