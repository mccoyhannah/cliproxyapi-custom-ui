import { parentPort, workerData } from 'node:worker_threads';

import type {
  CollectorMainMessage,
  CollectorWorkerData,
  CollectorWorkerMessage,
} from '../../src/shared/collectorTypes.js';
import { TokenPulseEngine } from './engine.mjs';

const port = parentPort;
if (!port) {
  throw new Error('collector-worker-port-missing');
}

const data = workerData as Partial<CollectorWorkerData>;
if (
  typeof data.installDir !== 'string' ||
  typeof data.cacheDir !== 'string' ||
  !Array.isArray(data.pricingOverrides)
) {
  port.postMessage({
    type: 'fatal',
    code: 'collector-worker-data-invalid',
  } satisfies CollectorWorkerMessage);
  process.exitCode = 1;
  port.close();
} else {
  const engine = new TokenPulseEngine({
    installDir: data.installDir,
    cacheDir: data.cacheDir,
    pricingOverrides: data.pricingOverrides,
  });

  engine.subscribe((snapshot) => {
    port.postMessage({ type: 'snapshot', snapshot } satisfies CollectorWorkerMessage);
  });

  let fatalShutdownStarted = false;
  const fail = (code: string): void => {
    if (fatalShutdownStarted) return;
    fatalShutdownStarted = true;
    port.postMessage({ type: 'fatal', code } satisfies CollectorWorkerMessage);
    void engine.stop().finally(() => {
      process.exitCode = 1;
      port.close();
    });
  };

  port.on('message', (message: CollectorMainMessage) => {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'update-pricing') {
      engine.updatePricing(message.pricingOverrides);
      return;
    }
    if (message.type === 'reconcile') {
      void engine
        .reconcile()
        .then(() => {
          if (typeof message.requestId === 'string' && message.requestId.length > 0) {
            port.postMessage({
              type: 'reconcile-complete',
              requestId: message.requestId,
            } satisfies CollectorWorkerMessage);
          }
        })
        .catch(() => fail('collector-reconcile-failed'));
      return;
    }
    if (message.type === 'shutdown') {
      void engine.stop().finally(() => port.close());
    }
  });

  void engine.start().catch(() => fail('collector-start-failed'));
}
