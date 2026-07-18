import type {
  WidgetPricingOverride,
  WidgetSnapshotV1,
  WidgetSourceStatus,
} from '../../src/shared/contracts.js';
import type { CoreEntryStatus, CoreTokenUsage } from '../../../scripts/lib/token-log-core.mjs';

export interface CollectorEntry {
  dedupeKey: string;
  timestampMs: number | null;
  lastModifiedMs?: number;
  model: string | null;
  status: CoreEntryStatus;
  tokenUsage: CoreTokenUsage;
}

export const TOKEN_COLLECTOR_VERSION: string;

export interface SnapshotSourceInput {
  status?: WidgetSourceStatus;
  ledgerGeneratedAt?: string | null;
  ledgerCoverageStartMs?: number | null;
  ledgerCoverageEndMs?: number | null;
  lastSuccessfulScanAtMs?: number | null;
  lastReconcileAtMs?: number | null;
  pendingFiles?: number;
  parseErrors?: number;
  unsupportedFiles?: number;
  possibleCoverageGap?: boolean;
  messageCode?: string | null;
}

export function buildWidgetSnapshot(options: {
  entries: CollectorEntry[];
  ledgerEntries?: CollectorEntry[];
  liveEntries?: CollectorEntry[];
  nowMs?: number;
  installDir: string;
  source?: SnapshotSourceInput;
  pricingOverrides?: WidgetPricingOverride[];
}): WidgetSnapshotV1;
