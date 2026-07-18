import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.resolve(testDirectory, '../..');
const cacheRoot = 'D:\\Tools\\Cache\\CPA-Token-Pulse\\tests';
let compiledRoot;

const loadProtocol = async () => {
  if (!compiledRoot) {
    await mkdir(cacheRoot, { recursive: true });
    const nextCompiledRoot = await mkdtemp(path.join(cacheRoot, 'maintenance-worker-protocol-'));
    try {
      await build({
        entryPoints: [path.join(widgetRoot, 'electron', 'maintenance', 'protocol.ts')],
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        outfile: path.join(nextCompiledRoot, 'protocol.mjs'),
        logLevel: 'silent',
      });
      compiledRoot = nextCompiledRoot;
    } catch (error) {
      await rm(nextCompiledRoot, { recursive: true, force: true });
      throw error;
    }
  }
  return import(`${pathToFileURL(path.join(compiledRoot, 'protocol.mjs')).href}?v=1`);
};

after(async () => {
  if (compiledRoot) await rm(compiledRoot, { recursive: true, force: true });
});

const corePrune = {
  scannedFiles: 50,
  eligibleFiles: 38,
  eligibleBytes: 178 * 1024 * 1024,
  keptActiveFiles: 5,
  keptUnrecordedFiles: 2,
  keptNotReadyAvailableFiles: 4,
  keptFingerprintMismatchFiles: 1,
  keptUnsafeFiles: 0,
};

test('worker protocol projects a safe preview and keeps the core preview id inside its ticket', async () => {
  const { createMaintenanceRequestHandler } = await loadProtocol();
  const calls = [];
  const handler = createMaintenanceRequestHandler({
    runMaintenance: async (request) => {
      calls.push(request);
      return {
        schemaVersion: 1,
        status: 'preview',
        previewId: 'v1:123:opaque-core-preview',
        expiresAt: '2026-07-17T04:31:00.000Z',
        ledger: {
          formal: { requests: 6_310, total: 61_980_000 },
          projected: { requests: 6_320, total: 62_080_000 },
          entryCounts: { formal: 6_315, candidate: 6_322 },
          formalGeneratedAt: '2026-07-17T04:00:00.000Z',
        },
        scan: { updatedFiles: 7 },
        prune: corePrune,
        safety: { activeWindowMinutes: 5, canExecute: true },
      };
    },
  });

  const response = await handler({ type: 'preview' });

  assert.deepEqual(calls, [{ mode: 'preview', activeWindowMinutes: 5 }]);
  assert.equal(response.type, 'preview-result');
  assert.equal(response.expiresAt, '2026-07-17T04:31:00.000Z');
  assert.deepEqual(response.ticket, {
    previewId: 'v1:123:opaque-core-preview',
    activeWindowMinutes: 5,
  });
  assert.deepEqual(response.preview, {
    version: 1,
    ledgerGeneratedAt: '2026-07-17T04:00:00.000Z',
    previousLedgerEntries: 6_315,
    projectedLedgerEntries: 6_322,
    previousAvailableRequests: 6_310,
    projectedAvailableRequests: 6_320,
    newLedgerFiles: 7,
    previousTotalTokens: 61_980_000,
    projectedTotalTokens: 62_080_000,
    prune: {
      eligibleFiles: 38,
      eligibleBytes: 178 * 1024 * 1024,
      keptActiveFiles: 5,
      keptUnrecordedFiles: 2,
      keptIncompleteFiles: 4,
      keptFingerprintMismatchFiles: 1,
      failedFiles: 0,
    },
  });
  assert.equal(JSON.stringify(response).includes('D:\\CLIProxyAPI'), false);
});

test('worker protocol forwards the main-process invariant floor before execute and projects only aggregate results', async () => {
  const { createMaintenanceRequestHandler } = await loadProtocol();
  const calls = [];
  const handler = createMaintenanceRequestHandler({
    runMaintenance: async (request) => {
      calls.push(request);
      return {
        schemaVersion: 1,
        status: 'completed',
        generatedAt: '2026-07-17T04:31:00.000Z',
        ledgerGeneratedAt: '2026-07-17T04:30:30.000Z',
        ledgerEntries: 6_322,
        totalTokens: 62_080_000,
        scan: { updatedFiles: 7 },
        ledger: {
          formal: { requests: 6_310, total: 61_980_000 },
          beforePrune: { requests: 6_320, total: 62_080_000 },
          unchangedByPrune: true,
        },
        prune: {
          ...corePrune,
          deletedFiles: 38,
          deletedBytes: 178 * 1024 * 1024,
          failedDeletes: 0,
          keptChangedFiles: 0,
        },
      };
    },
  });
  const floor = { totalTokens: 62_000_000, requests: 6_320, ledgerEntries: 6_320 };

  const response = await handler({
    type: 'execute',
    ticket: { previewId: 'v1:123:opaque-core-preview', activeWindowMinutes: 5 },
    floor,
  });

  assert.deepEqual(calls, [
    {
      mode: 'execute',
      activeWindowMinutes: 5,
      previewId: 'v1:123:opaque-core-preview',
      minimumTotals: floor,
    },
  ]);
  assert.deepEqual(response, {
    type: 'execute-result',
    result: {
      version: 1,
      completedAt: '2026-07-17T04:31:00.000Z',
      ledgerGeneratedAt: '2026-07-17T04:30:30.000Z',
      ledgerEntries: 6_322,
      availableRequests: 6_320,
      updatedLedgerFiles: 7,
      previousTotalTokens: 61_980_000,
      totalTokens: 62_080_000,
      totalPreserved: true,
      prune: {
        eligibleFiles: 38,
        eligibleBytes: 178 * 1024 * 1024,
        keptActiveFiles: 5,
        keptUnrecordedFiles: 2,
        keptIncompleteFiles: 4,
        keptFingerprintMismatchFiles: 1,
        failedFiles: 0,
        deletedFiles: 38,
        deletedBytes: 178 * 1024 * 1024,
      },
    },
  });
});

test('worker protocol rejects raw entry growth that masks an available-request regression', async () => {
  const { createMaintenanceRequestHandler } = await loadProtocol();
  const handler = createMaintenanceRequestHandler({
    runMaintenance: async () => ({
      schemaVersion: 1,
      status: 'completed',
      generatedAt: '2026-07-17T04:31:00.000Z',
      ledgerGeneratedAt: '2026-07-17T04:30:30.000Z',
      ledgerEntries: 6_500,
      totalTokens: 62_080_000,
      scan: { updatedFiles: 7 },
      ledger: {
        formal: { requests: 6_310, total: 61_980_000 },
        beforePrune: { requests: 6_319, total: 62_080_000 },
        unchangedByPrune: true,
      },
      prune: {
        ...corePrune,
        deletedFiles: 38,
        deletedBytes: 178 * 1024 * 1024,
        failedDeletes: 0,
        keptChangedFiles: 0,
      },
    }),
  });

  const response = await handler({
    type: 'execute',
    ticket: { previewId: 'v1:123:opaque-core-preview', activeWindowMinutes: 5 },
    floor: { totalTokens: 62_000_000, requests: 6_320, ledgerEntries: 6_320 },
  });

  assert.deepEqual(response, {
    type: 'maintenance-error',
    code: 'ledger-maintenance-invalid-response',
  });
});

test('worker protocol maps all raw failures to a stable maintenance error code', async () => {
  const { createMaintenanceRequestHandler } = await loadProtocol();
  const handler = createMaintenanceRequestHandler({
    runMaintenance: async () => {
      throw new Error('D:\\CLIProxyAPI\\logs\\secret.log stack secret');
    },
  });

  const response = await handler({ type: 'preview' });
  assert.deepEqual(response, { type: 'maintenance-error', code: 'ledger-maintenance-failed' });
  assert.equal(JSON.stringify(response).includes('secret'), false);
});

test('worker protocol preserves the safe low-space classification without raw details', async () => {
  const { createMaintenanceRequestHandler } = await loadProtocol();
  const handler = createMaintenanceRequestHandler({
    runMaintenance: async () => {
      const error = new Error('D:\\CLIProxyAPI\\logs\\secret.log low-space details');
      error.code = 'TOKEN_LEDGER_LOW_SPACE';
      throw error;
    },
  });

  const response = await handler({ type: 'preview' });
  assert.deepEqual(response, {
    type: 'maintenance-error',
    code: 'ledger-maintenance-low-space',
  });
  assert.equal(JSON.stringify(response).includes('secret'), false);
});
