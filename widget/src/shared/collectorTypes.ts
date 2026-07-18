import type { WidgetPricingOverride, WidgetSnapshotV1 } from './contracts.js';

export interface CollectorWorkerData {
  installDir: string;
  cacheDir: string;
  pricingOverrides: WidgetPricingOverride[];
}

/** Messages emitted by the collector worker and received by Electron main. */
export type CollectorWorkerMessage =
  | { type: 'snapshot'; snapshot: WidgetSnapshotV1 }
  | { type: 'reconcile-complete'; requestId: string }
  | { type: 'fatal'; code: string };

/** Messages emitted by Electron main and received by the collector worker. */
export type CollectorMainMessage =
  | { type: 'update-pricing'; pricingOverrides: WidgetPricingOverride[] }
  | { type: 'reconcile'; requestId?: string }
  | { type: 'shutdown' };

export interface CollectorOptions extends CollectorWorkerData {
  workerUrl?: URL;
}

export interface TokenPulseCollector {
  start(): Promise<WidgetSnapshotV1>;
  stop(): Promise<void>;
  getSnapshot(): WidgetSnapshotV1;
  subscribe(listener: (snapshot: WidgetSnapshotV1) => void): () => void;
  setPricingOverrides(pricingOverrides: WidgetPricingOverride[]): void;
  reconcile(): Promise<WidgetSnapshotV1>;
}
