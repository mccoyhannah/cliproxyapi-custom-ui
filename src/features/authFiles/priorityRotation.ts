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
const DEFAULT_NO_STANDBY_THRESHOLD_DROP_PERCENT = 0;
const MANAGED_CODEX_PLANS = new Set(['team', 'plus', 'self_serve_business_usage_based']);
export const PRIORITY_ROTATION_ACTIVE_PRIORITY = 2;
export const PRIORITY_ROTATION_STANDBY_PRIORITY = 1;
export const PRIORITY_ROTATION_BUFFER_PRIORITY = 0;
export const PRIORITY_ROTATION_MANUAL_LOCKED_MIN_PRIORITY = 3;

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
  noStandbyThresholdDropPercent: number;
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
  remainingPercent: number | null;
  managed: boolean;
};

const clampThresholdPercent = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_THRESHOLD_PERCENT;
  return Math.max(0, Math.min(100, Math.round(numeric)));
};

const clampNoStandbyThresholdDropPercent = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_NO_STANDBY_THRESHOLD_DROP_PERCENT;
  return Math.max(0, Math.min(100, Math.round(numeric)));
};

const clampActiveSlotLimit = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_ACTIVE_SLOT_LIMIT;
  return Math.max(1, Math.min(99, Math.round(numeric)));
};

export const normalizePriorityRotationThresholdPercent = clampThresholdPercent;
export const normalizePriorityRotationNoStandbyThresholdDropPercent =
  clampNoStandbyThresholdDropPercent;
export const normalizePriorityRotationActiveSlotLimit = clampActiveSlotLimit;

export const readAuthFilesPriorityRotationSettings = (): AuthFilesPriorityRotationSettings => {
  if (typeof window === 'undefined') {
    return {
      thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
      noStandbyThresholdDropPercent: DEFAULT_NO_STANDBY_THRESHOLD_DROP_PERCENT,
      activeSlotLimit: DEFAULT_ACTIVE_SLOT_LIMIT,
    };
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return {
        thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
        noStandbyThresholdDropPercent: DEFAULT_NO_STANDBY_THRESHOLD_DROP_PERCENT,
        activeSlotLimit: DEFAULT_ACTIVE_SLOT_LIMIT,
      };
    }
    const parsed = JSON.parse(raw) as Partial<AuthFilesPriorityRotationSettings>;
    return {
      thresholdPercent: clampThresholdPercent(parsed.thresholdPercent),
      noStandbyThresholdDropPercent: clampNoStandbyThresholdDropPercent(
        parsed.noStandbyThresholdDropPercent
      ),
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
        typeof parsed.lastAutoAppliedAt === 'number' && Number.isFinite(parsed.lastAutoAppliedAt)
          ? parsed.lastAutoAppliedAt
          : undefined,
      lastAutoAppliedChangeCount:
        typeof parsed.lastAutoAppliedChangeCount === 'number' &&
        Number.isFinite(parsed.lastAutoAppliedChangeCount)
          ? parsed.lastAutoAppliedChangeCount
          : undefined,
      lastAutoSkippedReason:
        typeof parsed.lastAutoSkippedReason === 'string' && parsed.lastAutoSkippedReason.trim()
          ? parsed.lastAutoSkippedReason.trim()
          : undefined,
    };
  } catch {
    return {
      thresholdPercent: DEFAULT_THRESHOLD_PERCENT,
      noStandbyThresholdDropPercent: DEFAULT_NO_STANDBY_THRESHOLD_DROP_PERCENT,
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
        noStandbyThresholdDropPercent: clampNoStandbyThresholdDropPercent(
          settings.noStandbyThresholdDropPercent
        ),
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
  activePriority: PRIORITY_ROTATION_ACTIVE_PRIORITY,
  standbyPriority: PRIORITY_ROTATION_STANDBY_PRIORITY,
  reservePriority: PRIORITY_ROTATION_BUFFER_PRIORITY,
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
  activeSlotLimit: number,
  noStandbyThresholdDropPercent = DEFAULT_NO_STANDBY_THRESHOLD_DROP_PERCENT
): PriorityRotationAnalysis => {
  const threshold = clampThresholdPercent(thresholdPercent);
  const slotLimit = clampActiveSlotLimit(activeSlotLimit);
  const fallbackDrop = clampNoStandbyThresholdDropPercent(noStandbyThresholdDropPercent);
  const fallbackThreshold = Math.max(0, threshold - fallbackDrop);
  const candidates: PriorityRotationCandidate[] = [];
  let unknownCount = 0;

  files.forEach((file) => {
    if (!isCodexFile(file) || isDisabledAuthFile(file) || isRuntimeOnlyAuthFile(file)) return;

    const priority = parsePriorityValue(file.priority ?? file['priority']) ?? 0;
    if (
      priority !== PRIORITY_ROTATION_ACTIVE_PRIORITY &&
      priority !== PRIORITY_ROTATION_STANDBY_PRIORITY
    ) {
      return;
    }

    const quota = codexQuota[file.name];
    const planType = normalizePlanType(quota?.planType ?? resolveCodexPlanType(file));
    const remainingPercent = getCodexFiveHourRemainingPercent(quota);
    if (planType !== null && !isManagedPlan(planType)) {
      if (priority === PRIORITY_ROTATION_ACTIVE_PRIORITY) {
        candidates.push({
          file,
          priority,
          remainingPercent: null,
          managed: false,
        });
      }
      return;
    }

    if (planType === null || remainingPercent === null) {
      unknownCount++;
      if (priority === PRIORITY_ROTATION_ACTIVE_PRIORITY) {
        candidates.push({
          file,
          priority,
          remainingPercent: null,
          managed: false,
        });
      }
      return;
    }

    candidates.push({
      file,
      priority,
      remainingPercent,
      managed: true,
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

  const activePriority = PRIORITY_ROTATION_ACTIVE_PRIORITY;
  const standbyPriority = PRIORITY_ROTATION_STANDBY_PRIORITY;
  const reservePriority = PRIORITY_ROTATION_BUFFER_PRIORITY;
  const activeCandidates = candidates.filter((candidate) => candidate.priority === activePriority);
  const standbyCandidates = candidates.filter(
    (candidate) => candidate.priority === standbyPriority
  );
  const managedCandidates = candidates.filter((candidate) => candidate.managed);
  const getRemainingSortValue = (candidate: PriorityRotationCandidate): number =>
    typeof candidate.remainingPercent === 'number' && Number.isFinite(candidate.remainingPercent)
      ? candidate.remainingPercent
      : -1;
  const healthyActiveCandidates = activeCandidates.filter(
    (candidate) => candidate.managed && getRemainingSortValue(candidate) >= threshold
  );
  const normalHealthyStandbyCandidates = standbyCandidates.filter(
    (candidate) => candidate.managed && getRemainingSortValue(candidate) >= threshold
  );

  const demotionMap = new Map<string, PriorityRotationChangeReason>();
  activeCandidates.forEach((candidate) => {
    if (candidate.managed && getRemainingSortValue(candidate) < threshold) {
      demotionMap.set(candidate.file.name, 'low_remaining');
    }
  });

  let projectedActiveCount = activeCandidates.length - demotionMap.size;
  if (projectedActiveCount > slotLimit) {
    activeCandidates
      .filter((candidate) => !demotionMap.has(candidate.file.name))
      .sort((a, b) => {
        const remainingCompare = getRemainingSortValue(a) - getRemainingSortValue(b);
        return remainingCompare !== 0 ? remainingCompare : a.file.name.localeCompare(b.file.name);
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
      const remainingCompare = getRemainingSortValue(a) - getRemainingSortValue(b);
      return remainingCompare !== 0 ? remainingCompare : a.file.name.localeCompare(b.file.name);
    })
    .map<PriorityRotationChange>((candidate) => ({
      name: candidate.file.name,
      displayName: getDisplayName(candidate.file),
      fromPriority: activePriority,
      toPriority: standbyPriority,
      remainingPercent: Math.max(0, getRemainingSortValue(candidate)),
      role: 'demote',
      reason: demotionMap.get(candidate.file.name) ?? 'low_remaining',
    }));
  const activeDeficit = Math.max(0, slotLimit - projectedActiveCount);
  const lowRemainingDemotionCount = Array.from(demotionMap.values()).filter(
    (reason) => reason === 'low_remaining'
  ).length;
  const needsStandby =
    Math.max(0, slotLimit - projectedActiveCount) > 0 || lowRemainingDemotionCount > 0;
  const useFallbackStandbyThreshold =
    needsStandby && normalHealthyStandbyCandidates.length === 0 && fallbackThreshold < threshold;
  const effectiveThreshold = useFallbackStandbyThreshold ? fallbackThreshold : threshold;
  const thresholdAdjusted = effectiveThreshold !== threshold;
  const healthyStandbyCandidates = thresholdAdjusted
    ? standbyCandidates.filter(
        (candidate) => candidate.managed && getRemainingSortValue(candidate) >= effectiveThreshold
      )
    : normalHealthyStandbyCandidates;
  const replacementSlots = Math.min(lowRemainingDemotionCount, activeDeficit);
  const fillSlots = Math.min(activeDeficit, healthyStandbyCandidates.length);
  const promotionSlots = Math.max(replacementSlots, fillSlots);
  const promotions = healthyStandbyCandidates
    .sort((a, b) => {
      const remainingCompare = getRemainingSortValue(b) - getRemainingSortValue(a);
      return remainingCompare !== 0 ? remainingCompare : a.file.name.localeCompare(b.file.name);
    })
    .slice(0, promotionSlots)
    .map<PriorityRotationChange>((candidate) => ({
      name: candidate.file.name,
      displayName: getDisplayName(candidate.file),
      fromPriority: standbyPriority,
      toPriority: activePriority,
      remainingPercent: Math.max(0, getRemainingSortValue(candidate)),
      role: 'promote',
      reason: 'promote_standby',
    }));
  const changes = [...demotions, ...promotions];

  if (changes.length === 0) {
    const missingAdjacentStandby = activeDeficit > 0 && healthyStandbyCandidates.length === 0;
    const missingReplacementStandby =
      lowRemainingDemotionCount > 0 && healthyStandbyCandidates.length === 0;
    const status: PriorityRotationStatus =
      unknownCount > 0 && managedCandidates.length === 0
        ? 'quota_unknown'
        : missingAdjacentStandby || missingReplacementStandby
          ? 'no_standby'
          : 'no_changes';
    return {
      thresholdPercent: threshold,
      effectiveThresholdPercent: effectiveThreshold,
      thresholdAdjusted,
      activeSlotLimit: slotLimit,
      status,
      managedCount: managedCandidates.length,
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
    managedCount: managedCandidates.length,
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
