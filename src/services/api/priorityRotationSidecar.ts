export type PriorityRotationSidecarSettings = {
  enabled: boolean;
  apiBase: string;
  thresholdPercent: number;
  activeSlotLimit: number;
  checkIntervalMinutes: number;
};

export type PriorityRotationSidecarChange = {
  name: string;
  displayName: string;
  fromPriority: number;
  toPriority: number;
  remainingPercent: number;
  role: 'demote' | 'promote';
  reason: 'low_remaining' | 'over_active_limit' | 'promote_standby';
};

export type PriorityRotationSidecarCandidate = {
  name: string;
  displayName: string;
  priority: number | null;
  planType: string | null;
  remainingPercent: number | null;
  tier: 'active' | 'standby' | 'buffer' | 'manual_locked' | 'other' | string;
  isActive: boolean;
  isStandby: boolean;
  isBuffer?: boolean;
  isManualLocked?: boolean;
  belowThreshold: boolean | null;
  decision: string;
};

export type PriorityRotationSidecarAnalysis = {
  thresholdPercent: number;
  effectiveThresholdPercent: number;
  thresholdAdjusted: boolean;
  activeSlotLimit: number;
  status: string;
  managedCount: number;
  unknownCount: number;
  activePriority: number | null;
  standbyPriority: number | null;
  reservePriority: number | null;
  activeCount: number;
  standbyCount: number;
  projectedActiveCount: number;
  candidates: PriorityRotationSidecarCandidate[];
  changes: PriorityRotationSidecarChange[];
};

export type PriorityRotationSidecarState = {
  serviceStartedAt: string | null;
  running: boolean;
  enabled: boolean;
  hasSecret: boolean;
  lastStatus: string;
  lastSkippedReason: string | null;
  lastError: string | null;
  lastRunStartedAt: string | null;
  lastCompletedAt: string | null;
  lastAppliedChangeCount: number;
  lastFailedChangeCount: number;
  lastMutationAt?: string | null;
  lastMutationAppliedChangeCount?: number;
  lastMutationChanges?: PriorityRotationSidecarChange[];
  nextRunAt: string | null;
  lastAnalysis: PriorityRotationSidecarAnalysis | null;
  updatedAt: string | null;
};

export type PriorityRotationSidecarStatus = {
  ok: boolean;
  pid: number;
  host: string;
  port: number;
  idleShutdownMinutes?: number;
  idleShutdownAt?: string | null;
  settings: PriorityRotationSidecarSettings;
  state: PriorityRotationSidecarState;
};

const SIDECAR_BASE_URL = 'http://127.0.0.1:8318';
const SIDECAR_WAKE_URL = 'cpamc-priority-rotation://start';

export const launchPriorityRotationSidecar = (): boolean => {
  if (typeof document === 'undefined') return false;

  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.setAttribute('aria-hidden', 'true');
  frame.src = SIDECAR_WAKE_URL;
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), 5_000);
  return true;
};

const buildHeaders = (managementKey?: string): HeadersInit => ({
  'Content-Type': 'application/json',
  ...(managementKey ? { Authorization: `Bearer ${managementKey}` } : {}),
});

const requestSidecar = async <T>(
  path: string,
  options: RequestInit & { managementKey?: string } = {}
): Promise<T> => {
  const { managementKey, ...fetchOptions } = options;
  const response = await fetch(`${SIDECAR_BASE_URL}${path}`, {
    ...fetchOptions,
    headers: {
      ...buildHeaders(managementKey),
      ...(fetchOptions.headers || {}),
    },
  });
  const text = await response.text();
  const trimmedText = text.trim();
  let data: unknown = null;
  let parseFailed = false;
  if (trimmedText) {
    try {
      data = JSON.parse(trimmedText);
    } catch {
      parseFailed = true;
      data = null;
    }
  }
  if (response.ok && parseFailed) {
    throw new Error(
      `Invalid sidecar JSON response: ${response.status} ${trimmedText.slice(0, 160)}`
    );
  }
  if (!response.ok) {
    const rawMessage = trimmedText.slice(0, 160);
    const errorMessage =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error?: unknown }).error
        : null;
    const message =
      typeof errorMessage === 'string'
        ? errorMessage
        : rawMessage
          ? `Sidecar request failed: ${response.status} ${rawMessage}`
          : `Sidecar request failed: ${response.status}`;
    throw new Error(message);
  }
  return data as T;
};

export const priorityRotationSidecarApi = {
  getStatus: () => requestSidecar<PriorityRotationSidecarStatus>('/status'),

  updateSettings: (settings: Partial<PriorityRotationSidecarSettings>, managementKey: string) =>
    requestSidecar<{ settings: PriorityRotationSidecarSettings; state: PriorityRotationSidecarState }>(
      '/settings',
      {
        method: 'PUT',
        managementKey,
        body: JSON.stringify({ settings }),
      }
    ),

  saveSecret: (managementKey: string, apiBase: string) =>
    requestSidecar<{
      saved: boolean;
      settings: PriorityRotationSidecarSettings;
      state: PriorityRotationSidecarState;
    }>('/secret', {
      method: 'POST',
      managementKey,
      body: JSON.stringify({ managementKey, apiBase }),
    }),

  runNow: (managementKey: string) =>
    requestSidecar<{ settings: PriorityRotationSidecarSettings; state: PriorityRotationSidecarState }>(
      '/run-now',
      {
        method: 'POST',
        managementKey,
        body: JSON.stringify({ dryRun: false }),
      }
    ),
};
