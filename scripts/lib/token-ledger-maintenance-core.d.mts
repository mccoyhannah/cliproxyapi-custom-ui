export const TOKEN_LEDGER_MAINTENANCE_SCHEMA_VERSION: number;
export const TOKEN_LEDGER_MAINTENANCE_LOCK_VERSION: number;
export const MINIMUM_ACTIVE_WINDOW_MINUTES: number;
export const DEFAULT_PREVIEW_TTL_MS: number;

export type TokenLedgerAccountingTotals = {
  requests: number;
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  total: number;
};

export type TokenLedgerMaintenanceResult = {
  schemaVersion: number;
  status: 'preview' | 'completed';
  mode: 'preview' | 'execute';
  generatedAt: string;
  previewId?: string;
  expiresAt?: string;
  ledgerEntries: number;
  totalTokens: number;
  ledgerGeneratedAt: string | null;
  scan: {
    scannedFiles: number;
    updatedFiles: number;
    skippedFiles: number;
    errorFiles: number;
  };
  ledger: {
    formal: TokenLedgerAccountingTotals;
    pending: TokenLedgerAccountingTotals;
    floor: TokenLedgerAccountingTotals;
    projected: TokenLedgerAccountingTotals;
    current: TokenLedgerAccountingTotals;
    entryCounts: { formal: number; candidate: number; committed?: number };
    formalGeneratedAt: string | null;
    candidateGeneratedAt: string | null;
    committedGeneratedAt?: string | null;
    beforePrune?: TokenLedgerAccountingTotals;
    afterPrune?: TokenLedgerAccountingTotals;
    unchangedByPrune?: boolean;
  };
  prune: {
    scannedFiles: number;
    eligibleFiles: number;
    eligibleBytes: number;
    keptActiveFiles: number;
    keptUnrecordedFiles: number;
    keptNotReadyAvailableFiles: number;
    keptFingerprintMismatchFiles: number;
    keptUnsafeFiles: number;
    invalidSourceEntries: number;
    deletedFiles?: number;
    deletedBytes?: number;
    failedDeletes?: number;
    keptChangedFiles?: number;
  };
  safety: {
    activeWindowMinutes: number;
    lockVersion: number;
    allowlistedRootsPresent: number;
    canExecute: boolean;
  };
};

export class TokenLedgerMaintenanceError extends Error {
  code: string;
  details?: Record<string, number>;
  constructor(code: string, message?: string, details?: Record<string, number> | null);
}

export function summarizeFinalizedLedger(ledger: unknown): TokenLedgerAccountingTotals;

export function withTokenLedgerMaintenanceLock<T>(
  options: { lockPath: string; fsAdapter?: Record<string, unknown> },
  task: () => Promise<T>
): Promise<T>;

export function createTokenLedgerMaintenanceCore(options: {
  policy: {
    ledgerPath: string;
    projectionPath: string;
    lockPath?: string;
    allowedLogRoots: [string, string] | string[];
    minimumActiveWindowMinutes?: number;
    previewTtlMs?: number;
  };
  buildCandidate: (context: {
    formalLedger: unknown;
    snapshotTimeMs: number;
    mode: 'preview' | 'execute';
  }) => Promise<{
    ledger: unknown;
    projection: unknown;
    pendingEntries: unknown[];
    scan?: Record<string, number>;
  }>;
  commitCandidate: (candidate: {
    ledger: unknown;
    projection: unknown;
    pendingEntries: unknown[];
    scan?: Record<string, number>;
  }) => Promise<void>;
  fsAdapter?: Record<string, unknown>;
  now?: () => number;
}): {
  preview(options?: { activeWindowMinutes?: number }): Promise<TokenLedgerMaintenanceResult>;
  execute(options: {
    activeWindowMinutes?: number;
    previewId: string;
    minimumTotals?: { requests: number; totalTokens: number; ledgerEntries: number };
  }): Promise<TokenLedgerMaintenanceResult>;
};

export function toSafeTokenLedgerMaintenanceError(error: unknown): {
  schemaVersion: number;
  status: 'error';
  code: string;
  message: string;
  availableBytes?: number;
  requiredBytes?: number;
  reserveBytes?: number;
  writeBytes?: number;
};
