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

export type TokenUsageStatus =
  | 'pending'
  | 'loading'
  | 'available'
  | 'unreported'
  | 'unavailable'
  | 'error';

export type TokenLedgerRangePreset = 'hours' | 'today' | '7d' | '30d' | 'month' | 'custom';

export type TokenLedgerEntryStatus = 'ready' | 'missing-fields' | 'error';

export interface TokenUsage {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  total: number;
  status: TokenUsageStatus;
}

export interface TokenLedgerFilters {
  range: TokenLedgerRangePreset;
  recentHours: number;
  customStart: string;
  customEnd: string;
}

export interface TokenLedgerEntry {
  fileName: string;
  fileType: string;
  timestampMs: number | null;
  requestId: string | null;
  detailStatus: TokenLedgerEntryStatus;
  configuredModel: string | null;
  actualModel: string | null;
  tokenUsage: TokenUsage;
  fileSize: number | null;
  lastModifiedMs: number | null;
}

export interface TokenLedgerCoverage {
  totalEntries: number;
  parsedEntries: number;
  knownEntries: number;
  unreportedEntries: number;
  coverageRate: number;
  parsedRate: number;
  earliestTimestampMs: number | null;
  latestTimestampMs: number | null;
}

export interface TokenLedgerSnapshot {
  version: number;
  generatedAt: string;
  coverage: TokenLedgerCoverage;
  entries: TokenLedgerEntry[];
}

export interface TokenLedgerModelUsageDatum {
  model: string;
  requests: number;
  knownRequests: number;
  total: number;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  percent: number;
}

export interface UsageStatsFilters {
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
  tokenUsage: TokenUsage;
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
  tokenUsage: TokenUsage;
  detail?: UsageRequestDetail;
}
