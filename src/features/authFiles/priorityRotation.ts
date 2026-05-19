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
const DEFAULT_ACTIVE_SLOT_LIMIT = 5;
const MANAGED_CODEX_PLANS = new Set(['team', 'plus', 'self_serve_business_usage_based']);

export type PriorityRotationChangeRole = 'demote' | 'promote';
export type PriorityRotationChangeReason =
  | 'low_remaining'
  | 'over_active_limit'
  | 'promote_standby';
export type PriorityRotationStatus =
  | 'ready'
  | 'no_changes'
  | 'quota_unknown'
  | 'insufficient_layers'
  | 'no_standby';

export type AuthFilesPriorityRotationSettings = {
  thresholdPercent: number;
  activeSlotLimit: number;
  lastAppliedAt?: number;
  lastAppliedChangeCount?: number;
  autoEnabled?: boolean;
  lastAutoAppliedAt?: number;
  lastAutoAppliedChangeCount?: number;
  lastAutoSkippedReason?: string;
};

export type PriorityRotationChange = {
  name: string;
  displayName: string;
  fromPriority: number;
  toPriority: number;
  remainingPercent: number;
  role: PriorityRotationChangeRole;
  reason: PriorityRotationChangeReason;
};

export type PriorityRotationAnalysis = {
  thresholdPercent: number;
  effectiveThresholdPercent: number;
  thresholdAdjusted: boolean;
  activeSlotLimit: number;
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
  projectedActiveCount: number;
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
  return Math.max(0, Math.min(100, Math.round(numeric)));
};

const clampActiveSlotLimit = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_ACTIVE_SLOT_LIMIT;
  return Math.max(1, Math.min(99, Math.round(numeric)));
};

export const normalizePriorityRotationThresholdPercent = clampThresholdPercent;
export const normalizePriorityRotationActiveSlotLimit = clampActiveSlotLimit;

export const readAuthFilesPriorityRotationSettings =
  (): AuthFilesPriorityRotationSettings => {
    if (typeof window === 'undefined') {
      return {
        thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
        activeSlotLimit: DEFAULT_ACTIVE_SLOT_LIMIT,
      };
    }

    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return {
          thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
          activeSlotLimit: DEFAULT_ACTIVE_SLOT_LIMIT,
        };
      }
      const parsed = JSON.parse(raw) as Partial<AuthFilesPriorityRotationSettings>;
      return {
        thresholdPercent: clampThresholdPercent(parsed.thresholdPercent),
        activeSlotLimit: clampActiveSlotLimit(parsed.activeSlotLimit),
        lastAppliedAt:
          typeof parsed.lastAppliedAt === 'number' && Number.isFinite(parsed.lastAppliedAt)
            ? parsed.lastAppliedAt
            : undefined,
        lastAppliedChangeCount:
          typeof parsed.lastAppliedChangeCount === 'number' &&
          Number.isFinite(parsed.lastAppliedChangeCount)
            ? parsed.lastAppliedChangeCount
            : undefined,
        autoEnabled: parsed.autoEnabled === true,
        lastAutoAppliedAt:
          typeof parsed.lastAutoAppliedAt === 'number' &&
          Number.isFinite(parsed.lastAutoAppliedAt)
            ? parsed.lastAutoAppliedAt
            : undefined,
        lastAutoAppliedChangeCount:
          typeof parsed.lastAutoAppliedChangeCount === 'number' &&
          Number.isFinite(parsed.lastAutoAppliedChangeCount)
            ? parsed.lastAutoAppliedChangeCount
            : undefined,
        lastAutoSkippedReason:
          typeof parsed.lastAutoSkippedReason === 'string' &&
          parsed.lastAutoSkippedReason.trim()
            ? parsed.lastAutoSkippedReason.trim()
            : undefined,
      };
    } catch {
      return {
        thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
        activeSlotLimit: DEFAULT_ACTIVE_SLOT_LIMIT,
      };
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
        activeSlotLimit: clampActiveSlotLimit(settings.activeSlotLimit),
        autoEnabled: settings.autoEnabled === true,
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
  activeSlotLimit: number,
  status: PriorityRotationStatus,
  unknownCount = 0
): PriorityRotationAnalysis => ({
  thresholdPercent,
  effectiveThresholdPercent: thresholdPercent,
  thresholdAdjusted: false,
  activeSlotLimit,
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
  projectedActiveCount: 0,
  changes: [],
});

export const analyzeCodexPriorityRotation = (
  files: AuthFileItem[],
  codexQuota: Record<string, CodexQuotaState>,
  thresholdPercent: number,
  activeSlotLimit: number
): PriorityRotationAnalysis => {
  const threshold = clampThresholdPercent(thresholdPercent);
  const slotLimit = clampActiveSlotLimit(activeSlotLimit);
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
      slotLimit,
      unknownCount > 0 ? 'quota_unknown' : 'no_changes',
      unknownCount
    );
  }

  const priorities = Array.from(new Set(candidates.map((candidate) => candidate.priority))).sort(
    (a, b) => b - a
  );
  const [activePriority = null, existingStandbyPriority = null, reservePriority = null] =
    priorities;

  if (activePriority === null) {
    return {
      ...buildEmptyAnalysis(threshold, slotLimit, 'insufficient_layers', unknownCount),
      managedCount: candidates.length,
    };
  }

  const standbyPriority = existingStandbyPriority ?? activePriority - 1;
  const activeCandidates = candidates.filter(
    (candidate) => candidate.priority === activePriority
  );
  const standbyCandidates = candidates.filter(
    (candidate) => candidate.priority === standbyPriority
  );
  const effectiveThreshold = threshold;
  const thresholdAdjusted = false;
  const healthyActiveCandidates = activeCandidates.filter(
    (candidate) => candidate.remainingPercent >= effectiveThreshold
  );
  const healthyStandbyCandidates = standbyCandidates.filter(
    (candidate) => candidate.remainingPercent >= effectiveThreshold
  );

  const demotionMap = new Map<string, PriorityRotationChangeReason>();
  activeCandidates.forEach((candidate) => {
    if (candidate.remainingPercent < effectiveThreshold) {
      demotionMap.set(candidate.file.name, 'low_remaining');
    }
  });

  let projectedActiveCount = activeCandidates.length - demotionMap.size;
  if (projectedActiveCount > slotLimit) {
    activeCandidates
      .filter((candidate) => !demotionMap.has(candidate.file.name))
      .sort((a, b) => {
        const remainingCompare = a.remainingPercent - b.remainingPercent;
        return remainingCompare !== 0
          ? remainingCompare
          : a.file.name.localeCompare(b.file.name);
      })
      .some((candidate) => {
        if (projectedActiveCount <= slotLimit) return true;
        demotionMap.set(candidate.file.name, 'over_active_limit');
        projectedActiveCount--;
        return false;
      });
  }

  const demotions = activeCandidates
    .filter((candidate) => demotionMap.has(candidate.file.name))
    .sort((a, b) => {
      const remainingCompare = a.remainingPercent - b.remainingPercent;
      return remainingCompare !== 0
        ? remainingCompare
        : a.file.name.localeCompare(b.file.name);
    })
    .map<PriorityRotationChange>((candidate) => ({
      name: candidate.file.name,
      displayName: getDisplayName(candidate.file),
      fromPriority: activePriority,
      toPriority: standbyPriority,
      remainingPercent: candidate.remainingPercent,
      role: 'demote',
      reason: demotionMap.get(candidate.file.name) ?? 'low_remaining',
    }));
  const promotionSlots = Math.max(0, slotLimit - projectedActiveCount);
  const promotions = healthyStandbyCandidates
    .sort((a, b) => {
      const remainingCompare = b.remainingPercent - a.remainingPercent;
      return remainingCompare !== 0
        ? remainingCompare
        : a.file.name.localeCompare(b.file.name);
    })
    .slice(0, promotionSlots)
    .map<PriorityRotationChange>((candidate) => ({
      name: candidate.file.name,
      displayName: getDisplayName(candidate.file),
      fromPriority: standbyPriority,
      toPriority: activePriority,
      remainingPercent: candidate.remainingPercent,
      role: 'promote',
      reason: 'promote_standby',
    }));
  const changes = [...demotions, ...promotions];

  if (changes.length === 0) {
    return {
      thresholdPercent: threshold,
      effectiveThresholdPercent: effectiveThreshold,
      thresholdAdjusted,
      activeSlotLimit: slotLimit,
      status: promotionSlots > 0 ? 'no_standby' : 'no_changes',
      managedCount: candidates.length,
      unknownCount,
      activePriority,
      standbyPriority,
      reservePriority,
      activeCount: activeCandidates.length,
      healthyActiveCount: healthyActiveCandidates.length,
      standbyCount: standbyCandidates.length,
      healthyStandbyCount: healthyStandbyCandidates.length,
      projectedActiveCount: activeCandidates.length,
      changes: [],
    };
  }

  return {
    thresholdPercent: threshold,
    effectiveThresholdPercent: effectiveThreshold,
    thresholdAdjusted,
    activeSlotLimit: slotLimit,
    status: 'ready',
    managedCount: candidates.length,
    unknownCount,
    activePriority,
    standbyPriority,
    reservePriority,
    activeCount: activeCandidates.length,
    healthyActiveCount: healthyActiveCandidates.length,
    standbyCount: standbyCandidates.length,
    healthyStandbyCount: healthyStandbyCandidates.length,
    projectedActiveCount: projectedActiveCount + promotions.length,
    changes,
  };
};
