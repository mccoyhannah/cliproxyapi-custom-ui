import type { WidgetPricingOverride, WidgetSnapshotV1 } from '../../src/shared/contracts.js';
import type { BoundedLogResult } from './logReader.mjs';

export interface TokenPulseEngineOptions {
  installDir: string;
  cacheDir: string;
  pricingOverrides?: WidgetPricingOverride[];
  logsDirs?: string[];
  ledgerPaths?: string[];
  pendingStatePath?: string;
  pendingStateWriter?: (filePath: string, contents: string) => Promise<void>;
  reconcileIntervalMs?: number;
  stabilityDelayMs?: number;
  awaitInitialReconcile?: boolean;
  maxConcurrentLogReads?: number;
  now?: () => number;
  waitForStability?: (delayMs: number) => Promise<void>;
  watchFactory?: (
    path: string,
    options: { persistent: boolean },
    listener: (eventType: string, fileName: string | Buffer | null) => void
  ) => { on(event: string, listener: () => void): unknown; close(): void };
  readLog?: (
    filePath: string,
    stats: { size: number; mtimeMs: number },
    options: { stable: boolean }
  ) => Promise<BoundedLogResult>;
}

export class TokenPulseEngine {
  constructor(options: TokenPulseEngineOptions);
  start(): Promise<WidgetSnapshotV1>;
  stop(): Promise<void>;
  getSnapshot(): WidgetSnapshotV1 | null;
  subscribe(listener: (snapshot: WidgetSnapshotV1) => void): () => void;
  updatePricing(pricingOverrides: WidgetPricingOverride[]): WidgetSnapshotV1 | null;
  reconcile(): Promise<WidgetSnapshotV1 | null>;
}
