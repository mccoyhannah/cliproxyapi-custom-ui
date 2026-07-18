import { Worker } from 'node:worker_threads';

import type {
  CollectorMainMessage,
  CollectorOptions,
  CollectorWorkerData,
  CollectorWorkerMessage,
  TokenPulseCollector,
} from '../../src/shared/collectorTypes.js';
import type { WidgetPricingOverride, WidgetSnapshotV1 } from '../../src/shared/contracts.js';

export type {
  CollectorMainMessage,
  CollectorOptions,
  CollectorWorkerData,
  CollectorWorkerMessage,
  TokenPulseCollector,
} from '../../src/shared/collectorTypes.js';

class WorkerCollector implements TokenPulseCollector {
  private worker: Worker | null = null;
  private snapshot: WidgetSnapshotV1 | null = null;
  private listeners = new Set<(snapshot: WidgetSnapshotV1) => void>();
  private pendingSnapshotResolvers: Array<(snapshot: WidgetSnapshotV1) => void> = [];

  constructor(private readonly options: CollectorOptions) {}

  async start(): Promise<WidgetSnapshotV1> {
    if (!this.worker) {
      const workerData: CollectorWorkerData = {
        installDir: this.options.installDir,
        cacheDir: this.options.cacheDir,
        pricingOverrides: this.options.pricingOverrides,
      };
      const worker = new Worker(this.options.workerUrl ?? new URL('./worker.js', import.meta.url), {
        workerData,
      });
      worker.on('message', (message: CollectorWorkerMessage) => this.onMessage(message));
      this.worker = worker;
    }
    if (this.snapshot) return this.snapshot;
    return this.waitForSnapshot();
  }

  async stop(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    if (!worker) return;
    worker.postMessage({ type: 'shutdown' } satisfies CollectorMainMessage);
    await worker.terminate();
  }

  getSnapshot(): WidgetSnapshotV1 {
    if (!this.snapshot) throw new Error('collector-not-started');
    return this.snapshot;
  }

  subscribe(listener: (snapshot: WidgetSnapshotV1) => void): () => void {
    this.listeners.add(listener);
    if (this.snapshot) listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  setPricingOverrides(pricingOverrides: WidgetPricingOverride[]): void {
    this.post({ type: 'update-pricing', pricingOverrides });
  }

  async reconcile(): Promise<WidgetSnapshotV1> {
    const pending = this.waitForSnapshot();
    this.post({ type: 'reconcile' });
    return pending;
  }

  private post(message: CollectorMainMessage): void {
    if (!this.worker) throw new Error('collector-not-started');
    this.worker.postMessage(message);
  }

  private waitForSnapshot(): Promise<WidgetSnapshotV1> {
    return new Promise((resolve) => this.pendingSnapshotResolvers.push(resolve));
  }

  private onMessage(message: CollectorWorkerMessage): void {
    if (message.type !== 'snapshot') return;
    this.snapshot = message.snapshot;
    const resolvers = this.pendingSnapshotResolvers.splice(0);
    resolvers.forEach((resolve) => resolve(message.snapshot));
    this.listeners.forEach((listener) => listener(message.snapshot));
  }
}

export const createCollector = (options: CollectorOptions): TokenPulseCollector =>
  new WorkerCollector(options);
