export type UsageStatsRangePreset = '1h' | '24h' | '7d' | 'custom';

export type UsageStatsStatusFilter = 'all' | 'success' | 'failure' | 'unknown';

export type UsageRequestStatus = 'success' | 'failure' | 'unknown';

export type UsageRequestDetailStatus =
  | 'pending'
  | 'loading'
  | 'ready'
  | 'missing-fields'
  | 'unavailable'
  | 'error';

export type ModelMatchStatus = 'match' | 'mismatch' | 'pending' | 'missing' | 'unavailable';

export interface UsageStatsFilters {
  range: UsageStatsRangePreset;
  customStart: string;
  customEnd: string;
  search: string;
  status: UsageStatsStatusFilter;
  model: string;
  source: string;
  onlyErrors: boolean;
  onlyMismatches: boolean;
  onlyUnparsed: boolean;
}

export interface UsageRequestDetail {
  requestId: string;
  detailStatus: UsageRequestDetailStatus;
  configuredModel: string | null;
  upstreamModel: string | null;
  responseModel: string | null;
  actualModel: string | null;
  upstreamUrl: string | null;
  provider: string | null;
  authLabel: string | null;
  authId: string | null;
  originator: string | null;
  userAgent: string | null;
  upstreamStatusCode: number | null;
  finalStatusCode: number | null;
  errorSummary: string | null;
  loadedAt: number | null;
}

export interface UsageStatsRecord {
  id: string;
  timestampMs: number | null;
  timeLabel: string;
  requestId: string | null;
  endpoint: string;
  source: string;
  status: UsageRequestStatus;
  statusCode: number | null;
  statusLabel: string;
  latency: string | null;
  latencyMs: number | null;
  raw: string;
}

export interface EnrichedUsageStatsRecord extends UsageStatsRecord {
  configuredModel: string | null;
  upstreamModel: string | null;
  actualModel: string | null;
  detailStatus: UsageRequestDetailStatus;
  modelMatch: ModelMatchStatus;
  detail?: UsageRequestDetail;
}
