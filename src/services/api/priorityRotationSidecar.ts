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
  nextRunAt: string | null;
  lastAnalysis: PriorityRotationSidecarAnalysis | null;
  updatedAt: string | null;
};

export type PriorityRotationSidecarStatus = {
  ok: boolean;
  pid: number;
  host: string;
  port: number;
  settings: PriorityRotationSidecarSettings;
  state: PriorityRotationSidecarState;
};

const SIDECAR_BASE_URL = 'http://127.0.0.1:8318';

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
  const data = text.trim() ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      data && typeof data === 'object' && typeof data.error === 'string'
        ? data.error
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

  saveSecret: (
    managementKey: string,
    apiBase: string,
    settings: Partial<PriorityRotationSidecarSettings>
  ) =>
    requestSidecar<{
      saved: boolean;
      settings: PriorityRotationSidecarSettings;
      state: PriorityRotationSidecarState;
    }>('/secret', {
      method: 'POST',
      managementKey,
      body: JSON.stringify({ managementKey, apiBase, settings }),
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
