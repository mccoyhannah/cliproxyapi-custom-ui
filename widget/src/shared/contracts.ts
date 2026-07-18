export type WidgetSourceStatus = 'loading' | 'live' | 'degraded' | 'offline' | 'error';

export type WidgetEntryStatus =
  | 'available'
  | 'pending'
  | 'unreported'
  | 'ambiguous'
  | 'parse-error'
  | 'unsupported';

export interface WidgetCostSummary {
  estimatedUsd: number | null;
  pricedTokens: number;
  unpricedTokens: number;
  pricedRequests: number;
  unpricedRequests: number;
}

export interface WidgetUsageTotals extends WidgetCostSummary {
  fromMs: number | null;
  toMs: number | null;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface WidgetTrendPoint {
  startMs: number;
  requests: number;
  totalTokens: number;
  estimatedUsd: number | null;
}

export interface WidgetModelUsage extends WidgetCostSummary {
  model: string;
  requests: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface WidgetLatestRequest {
  model: string;
  timestampMs: number;
  status: 'available' | 'unpriced' | 'pending';
  totalTokens: number;
  estimatedUsd: number | null;
}

export interface WidgetRecentModel {
  model: string;
  timestampMs: number;
  totalTokens: number;
  estimatedUsd: number | null;
}

export interface WidgetSourceSummary {
  status: WidgetSourceStatus;
  installDir: string;
  collectorVersion: string;
  parserVersion: string;
  pricingVersion: string;
  ledgerGeneratedAt: string | null;
  ledgerCoverageStartMs: number | null;
  ledgerCoverageEndMs: number | null;
  latestRequestAtMs: number | null;
  lastSuccessfulScanAtMs: number | null;
  lastReconcileAtMs: number | null;
  pendingFiles: number;
  parseErrors: number;
  unsupportedFiles: number;
  possibleCoverageGap: boolean;
  messageCode: string | null;
}

export interface WidgetEntryStatusCounts {
  available: number;
  pending: number;
  unreported: number;
  ambiguous: number;
  parseError: number;
  unsupported: number;
}

export interface WidgetUsageView {
  statusCounts: WidgetEntryStatusCounts;
  periods: {
    today: WidgetUsageTotals;
    rolling24h: WidgetUsageTotals;
    rolling7d: WidgetUsageTotals;
    month: WidgetUsageTotals;
    ledgerCoverage: WidgetUsageTotals;
  };
  trend60m: WidgetTrendPoint[];
  topModels: WidgetModelUsage[];
  recentModels: WidgetRecentModel[];
  latestRequest: WidgetLatestRequest | null;
}

export interface WidgetSnapshotV1 {
  version: 1;
  computedAt: string;
  source: WidgetSourceSummary;
  statusCounts: WidgetEntryStatusCounts;
  periods: {
    today: WidgetUsageTotals;
    rolling24h: WidgetUsageTotals;
    rolling7d: WidgetUsageTotals;
    month: WidgetUsageTotals;
    ledgerCoverage: WidgetUsageTotals;
  };
  trend60m: WidgetTrendPoint[];
  topModels: WidgetModelUsage[];
  recentModels: WidgetRecentModel[];
  latestRequest: WidgetLatestRequest | null;
  /** Exact projection of D:\\CLIProxyAPI\\static\\token-ledger.json. */
  ledgerView: WidgetUsageView;
  /** Stable completed log entries not yet present in the formal ledger. */
  unledgeredView: WidgetUsageView;
}

export interface WidgetMaintenancePruneSummary {
  eligibleFiles: number;
  eligibleBytes: number;
  keptActiveFiles: number;
  keptUnrecordedFiles: number;
  keptIncompleteFiles: number;
  keptFingerprintMismatchFiles: number;
  failedFiles: number;
}

export interface WidgetMaintenancePreviewV1 {
  version: 1;
  previewId: string;
  createdAt: string;
  expiresAt: string;
  ledgerGeneratedAt: string | null;
  previousLedgerEntries: number;
  projectedLedgerEntries: number;
  previousAvailableRequests: number;
  projectedAvailableRequests: number;
  newLedgerFiles: number;
  previousTotalTokens: number;
  projectedTotalTokens: number;
  prune: WidgetMaintenancePruneSummary;
}

export interface WidgetMaintenanceResultV1 {
  version: 1;
  /** Worker completed, but the collector could not finish its auxiliary refresh verification. */
  postVerificationPending?: true;
  completedAt: string;
  ledgerGeneratedAt: string;
  ledgerEntries: number;
  availableRequests: number;
  updatedLedgerFiles: number;
  previousTotalTokens: number;
  totalTokens: number;
  totalPreserved: boolean;
  prune: WidgetMaintenancePruneSummary & {
    deletedFiles: number;
    deletedBytes: number;
  };
}

export interface WidgetPricingOverride {
  pattern: string;
  inputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  outputUsdPer1M: number;
  enabled: boolean;
}

export interface WidgetSettings {
  alwaysOnTop: boolean;
  expanded: boolean;
  pricingOverrides: WidgetPricingOverride[];
}

export interface WidgetApi {
  getSnapshot: () => Promise<WidgetSnapshotV1>;
  subscribe: (listener: (snapshot: WidgetSnapshotV1) => void) => () => void;
  getSettings: () => Promise<WidgetSettings>;
  subscribeSettings: (listener: (settings: WidgetSettings) => void) => () => void;
  saveSettings: (settings: WidgetSettings) => Promise<WidgetSettings>;
  setWindowMode: (expanded: boolean) => Promise<void>;
  setAlwaysOnTop: (alwaysOnTop: boolean) => Promise<void>;
  previewLedgerMaintenance: () => Promise<WidgetMaintenancePreviewV1>;
  executeLedgerMaintenance: (previewId: string) => Promise<WidgetMaintenanceResultV1>;
  subscribeMaintenanceOpen: (listener: () => void) => () => void;
  hideToTray: () => Promise<void>;
  quit: () => Promise<void>;
}
