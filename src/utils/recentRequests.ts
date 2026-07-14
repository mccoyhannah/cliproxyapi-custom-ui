export type StatusBlockState = 'success' | 'failure' | 'mixed' | 'idle';

export interface StatusBlockDetail {
  success: number;
  failure: number;
  rate: number;
  startTime: number;
  endTime: number;
  timeLabel?: string;
}

export interface StatusBarData {
  blocks: StatusBlockState[];
  blockDetails: StatusBlockDetail[];
  successRate: number;
  totalSuccess: number;
  totalFailure: number;
}

export interface RecentRequestBucket {
  time?: string;
  success: number;
  failed: number;
}

export interface RecentRequestUsageEntry {
  success: number;
  failed: number;
  recentRequests: RecentRequestBucket[];
}

export type ApiKeyUsageResponse = Record<
  string,
  Record<
    string,
    {
      success?: unknown;
      failed?: unknown;
      recent_requests?: unknown;
      recentRequests?: unknown;
    }
  >
>;

const RECENT_REQUEST_BLOCK_COUNT = 20;
const RECENT_REQUEST_BLOCK_DURATION_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const parseRecentRequestTimeRange = (
  value: string | undefined,
  nowMs: number
): { startTime: number; endTime: number } | null => {
  const match = value?.trim().match(/^(\d{1,2}):(\d{2})\s*[-–—]\s*(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const [, startHourText, startMinuteText, endHourText, endMinuteText] = match;
  const startHour = Number(startHourText);
  const startMinute = Number(startMinuteText);
  const endHour = Number(endHourText);
  const endMinute = Number(endMinuteText);
  if (
    startHour > 23 ||
    endHour > 23 ||
    startMinute > 59 ||
    endMinute > 59
  ) {
    return null;
  }

  const reference = new Date(nowMs);
  let startTime = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
    startHour,
    startMinute,
    0,
    0
  ).getTime();
  let endTime = new Date(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate(),
    endHour,
    endMinute,
    0,
    0
  ).getTime();

  if (endTime <= startTime) endTime += DAY_MS;
  if (startTime > nowMs + RECENT_REQUEST_BLOCK_DURATION_MS) {
    startTime -= DAY_MS;
    endTime -= DAY_MS;
  }

  return { startTime, endTime };
};

const toFiniteNumber = (value: unknown): number => {
  const numberValue = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

export function normalizeUsageTotal(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return 0;
    }
    const numberValue = Number(trimmed);
    return Number.isFinite(numberValue) ? numberValue : 0;
  }
  return 0;
}

export function buildRecentRequestCompositeKey(baseUrl: unknown, apiKey: unknown): string {
  const normalizedBaseUrl = String(baseUrl ?? '').trim();
  const normalizedApiKey = String(apiKey ?? '').trim();
  return `${normalizedBaseUrl}|${normalizedApiKey}`;
}

export function normalizeRecentRequestAuthIndex(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value.toString();
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

export function normalizeRecentRequestBuckets(input: unknown): RecentRequestBucket[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input.slice(-RECENT_REQUEST_BLOCK_COUNT).map((item) => {
    const record = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const time = typeof record.time === 'string' ? record.time : undefined;

    return {
      ...(time ? { time } : {}),
      success: toFiniteNumber(record.success),
      failed: toFiniteNumber(record.failed),
    };
  });
}

export function normalizeRecentRequestUsageEntry(input: unknown): RecentRequestUsageEntry {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      success: 0,
      failed: 0,
      recentRequests: [],
    };
  }

  const record = input as Record<string, unknown>;

  return {
    success: normalizeUsageTotal(record.success),
    failed: normalizeUsageTotal(record.failed),
    recentRequests: normalizeRecentRequestBuckets(record.recent_requests ?? record.recentRequests),
  };
}

export function mergeRecentRequestBucketGroups(
  groups: RecentRequestBucket[][]
): RecentRequestBucket[] {
  const normalizedGroups = groups
    .map((group) => normalizeRecentRequestBuckets(group))
    .filter((group) => group.length > 0);

  if (normalizedGroups.length === 0) {
    return [];
  }

  const mergedLength = Math.min(
    RECENT_REQUEST_BLOCK_COUNT,
    Math.max(...normalizedGroups.map((group) => group.length))
  );
  const merged: RecentRequestBucket[] = Array.from({ length: mergedLength }, () => ({
    success: 0,
    failed: 0,
  }));

  normalizedGroups.forEach((group) => {
    const tail = group.slice(-mergedLength);
    const offset = mergedLength - tail.length;

    tail.forEach((bucket, index) => {
      const target = merged[offset + index];
      target.success += bucket.success;
      target.failed += bucket.failed;
      if (!target.time && bucket.time) {
        target.time = bucket.time;
      }
    });
  });

  return merged;
}

export function sumRecentRequests(
  buckets: RecentRequestBucket[]
): { success: number; failure: number } {
  return normalizeRecentRequestBuckets(buckets).reduce(
    (total, bucket) => ({
      success: total.success + bucket.success,
      failure: total.failure + bucket.failed,
    }),
    { success: 0, failure: 0 }
  );
}

export function statusBarDataFromRecentRequests(
  buckets: RecentRequestBucket[],
  nowMs = Date.now()
): StatusBarData {
  const normalizedBuckets = normalizeRecentRequestBuckets(buckets);
  const emptyBucketCount = Math.max(0, RECENT_REQUEST_BLOCK_COUNT - normalizedBuckets.length);
  const blockStats: RecentRequestBucket[] = [
    ...Array.from({ length: emptyBucketCount }, () => ({ success: 0, failed: 0 })),
    ...normalizedBuckets.slice(-RECENT_REQUEST_BLOCK_COUNT),
  ];

  const currentBucketStart =
    Math.floor(nowMs / RECENT_REQUEST_BLOCK_DURATION_MS) * RECENT_REQUEST_BLOCK_DURATION_MS;
  const windowStart =
    currentBucketStart - (RECENT_REQUEST_BLOCK_COUNT - 1) * RECENT_REQUEST_BLOCK_DURATION_MS;

  const blocks: StatusBlockState[] = [];
  const blockDetails: StatusBarData['blockDetails'] = [];
  let totalSuccess = 0;
  let totalFailure = 0;

  blockStats.forEach((bucket, index) => {
    const success = bucket.success;
    const failure = bucket.failed;
    const total = success + failure;

    totalSuccess += success;
    totalFailure += failure;

    if (total === 0) {
      blocks.push('idle');
    } else if (failure === 0) {
      blocks.push('success');
    } else if (success === 0) {
      blocks.push('failure');
    } else {
      blocks.push('mixed');
    }

    const parsedTimeRange = parseRecentRequestTimeRange(bucket.time, nowMs);
    const blockStartTime =
      parsedTimeRange?.startTime ?? windowStart + index * RECENT_REQUEST_BLOCK_DURATION_MS;
    blockDetails.push({
      success,
      failure,
      rate: total > 0 ? success / total : -1,
      startTime: blockStartTime,
      endTime: parsedTimeRange?.endTime ?? blockStartTime + RECENT_REQUEST_BLOCK_DURATION_MS,
      ...(bucket.time ? { timeLabel: bucket.time } : {}),
    });
  });

  const total = totalSuccess + totalFailure;

  return {
    blocks,
    blockDetails,
    successRate: total > 0 ? (totalSuccess / total) * 100 : 100,
    totalSuccess,
    totalFailure,
  };
}
