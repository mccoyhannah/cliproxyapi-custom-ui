import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.resolve(testDirectory, '../..');
const cacheRoot = 'D:\\Tools\\Cache\\CPA-Token-Pulse\\tests';
let compiledRoot;

const loadLedgerMaintenance = async () => {
  if (!compiledRoot) {
    await mkdir(cacheRoot, { recursive: true });
    compiledRoot = await mkdtemp(path.join(cacheRoot, 'ledger-maintenance-controller-'));
    await build({
      entryPoints: [path.join(widgetRoot, 'electron', 'ledgerMaintenance.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      outfile: path.join(compiledRoot, 'ledgerMaintenance.mjs'),
      logLevel: 'silent',
    });
  }
  return import(`${pathToFileURL(path.join(compiledRoot, 'ledgerMaintenance.mjs')).href}?v=1`);
};

after(async () => {
  if (compiledRoot) await rm(compiledRoot, { recursive: true, force: true });
});

const prune = {
  eligibleFiles: 2,
  eligibleBytes: 4096,
  keptActiveFiles: 1,
  keptUnrecordedFiles: 0,
  keptIncompleteFiles: 0,
  keptFingerprintMismatchFiles: 0,
  failedFiles: 0,
};

test('preview ids are short-lived, one-time handles for an internal runner ticket', async () => {
  const { createLedgerMaintenanceController } = await loadLedgerMaintenance();
  const fixedNow = Date.parse('2026-07-17T04:30:00.000Z');
  const fixedPreviewId = '6b838f74-bcca-4ef2-8f6e-2fa47332c873';
  const internalTicket = {
    opaque: 'runner-only',
    path: 'D:\\CLIProxyAPI\\logs\\must-not-leak.log',
  };
  let executeTicket;
  let executeFloor;
  const runner = {
    preview: async () => ({
      preview: {
        version: 1,
        ledgerGeneratedAt: '2026-07-17T04:00:00.000Z',
        previousLedgerEntries: 10,
        projectedLedgerEntries: 12,
        previousAvailableRequests: 9,
        projectedAvailableRequests: 11,
        newLedgerFiles: 2,
        previousTotalTokens: 100,
        projectedTotalTokens: 125,
        prune,
      },
      ticket: internalTicket,
    }),
    execute: async (ticket, floor) => {
      executeTicket = ticket;
      executeFloor = floor;
      return {
        version: 1,
        completedAt: '2026-07-17T04:31:00.000Z',
        ledgerGeneratedAt: '2026-07-17T04:30:30.000Z',
        ledgerEntries: 12,
        availableRequests: 11,
        updatedLedgerFiles: 2,
        previousTotalTokens: 100,
        totalTokens: 125,
        totalPreserved: true,
        prune: { ...prune, deletedFiles: 2, deletedBytes: 4096 },
      };
    },
  };
  let commitFloor = { totalTokens: 120, requests: 11, ledgerEntries: 11 };
  const controller = createLedgerMaintenanceController({
    runner,
    now: () => fixedNow,
    randomUuid: () => fixedPreviewId,
    getCommitFloor: () => commitFloor,
  });

  const preview = await controller.preview();
  assert.equal(preview.previewId, fixedPreviewId);
  assert.equal(preview.createdAt, '2026-07-17T04:30:00.000Z');
  assert.equal(preview.expiresAt, '2026-07-17T04:31:00.000Z');
  assert.equal(JSON.stringify(preview).includes('must-not-leak'), false);
  assert.equal(Object.hasOwn(preview, 'ticket'), false);

  commitFloor = { totalTokens: 999, requests: 99, ledgerEntries: 99 };

  const result = await controller.execute(preview.previewId);
  assert.equal(result.totalPreserved, true);
  assert.strictEqual(executeTicket, internalTicket);
  assert.deepEqual(executeFloor, { totalTokens: 120, requests: 11, ledgerEntries: 11 });
  await assert.rejects(
    controller.execute(preview.previewId),
    /ledger-maintenance-preview-unavailable/
  );
});

test('preview rescans once when the first candidate trails the captured commit floor', async () => {
  const { createLedgerMaintenanceController } = await loadLedgerMaintenance();
  const fixedNow = Date.parse('2026-07-17T04:40:00.000Z');
  const fixedPreviewId = 'b85d22d5-7d42-40d8-8ea8-72bb61ba0872';
  const floor = { totalTokens: 120, requests: 11, ledgerEntries: 11 };
  const previews = [
    {
      preview: {
        version: 1,
        ledgerGeneratedAt: '2026-07-17T04:00:00.000Z',
        previousLedgerEntries: 10,
        projectedLedgerEntries: 10,
        previousAvailableRequests: 9,
        projectedAvailableRequests: 10,
        newLedgerFiles: 0,
        previousTotalTokens: 100,
        projectedTotalTokens: 119,
        prune,
      },
      ticket: 'first-candidate',
    },
    {
      preview: {
        version: 1,
        ledgerGeneratedAt: '2026-07-17T04:00:00.000Z',
        previousLedgerEntries: 10,
        projectedLedgerEntries: 12,
        previousAvailableRequests: 9,
        projectedAvailableRequests: 11,
        newLedgerFiles: 2,
        previousTotalTokens: 100,
        projectedTotalTokens: 125,
        prune,
      },
      ticket: 'second-candidate',
    },
  ];
  let previewCalls = 0;
  let executeTicket;
  let executeFloor;
  const controller = createLedgerMaintenanceController({
    runner: {
      preview: async () => previews[previewCalls++],
      execute: async (ticket, invariantFloor) => {
        executeTicket = ticket;
        executeFloor = invariantFloor;
        return {
          version: 1,
          completedAt: '2026-07-17T04:41:00.000Z',
          ledgerGeneratedAt: '2026-07-17T04:40:30.000Z',
          ledgerEntries: 12,
          availableRequests: 11,
          updatedLedgerFiles: 2,
          previousTotalTokens: 100,
          totalTokens: 125,
          totalPreserved: true,
          prune: { ...prune, deletedFiles: 2, deletedBytes: 4096 },
        };
      },
    },
    now: () => fixedNow,
    randomUuid: () => fixedPreviewId,
    getCommitFloor: () => floor,
  });

  const preview = await controller.preview();
  assert.equal(previewCalls, 2);
  assert.equal(preview.projectedTotalTokens, 125);
  assert.equal(preview.projectedAvailableRequests, 11);
  assert.equal(preview.projectedLedgerEntries, 12);

  await controller.execute(preview.previewId);
  assert.equal(executeTicket, 'second-candidate');
  assert.deepEqual(executeFloor, floor);
});

test('preview rejects when two consecutive candidates trail the captured commit floor', async () => {
  const { createLedgerMaintenanceController } = await loadLedgerMaintenance();
  const fixedPreviewId = '90310b78-2442-4455-bac0-cc0f40086f4b';
  let previewCalls = 0;
  let executeCalls = 0;
  const controller = createLedgerMaintenanceController({
    runner: {
      preview: async () => {
        previewCalls += 1;
        return {
          preview: {
            version: 1,
            ledgerGeneratedAt: '2026-07-17T04:00:00.000Z',
            previousLedgerEntries: 10,
            projectedLedgerEntries: 10,
            previousAvailableRequests: 9,
            projectedAvailableRequests: 10,
            newLedgerFiles: 0,
            previousTotalTokens: 100,
            projectedTotalTokens: 119,
            prune,
          },
          ticket: `candidate-${previewCalls}`,
        };
      },
      execute: async () => {
        executeCalls += 1;
        throw new Error('should-not-run');
      },
    },
    randomUuid: () => fixedPreviewId,
    getCommitFloor: () => ({ totalTokens: 120, requests: 11, ledgerEntries: 11 }),
  });

  await assert.rejects(controller.preview(), /ledger-maintenance-total-regression/);
  assert.equal(previewCalls, 2);
  await assert.rejects(
    controller.execute(fixedPreviewId),
    /ledger-maintenance-preview-unavailable/
  );
  assert.equal(executeCalls, 0);
});

test('main-process preview reconciles the collector before capturing the commit floor', async () => {
  const {
    createLedgerMaintenanceController,
    previewLedgerMaintenanceAfterReconcile,
  } = await loadLedgerMaintenance();
  const order = [];
  let floor = { totalTokens: 130, requests: 12, ledgerEntries: 12 };
  let previewCalls = 0;
  const controller = createLedgerMaintenanceController({
    runner: {
      preview: async () => {
        order.push('preview');
        previewCalls += 1;
        return {
          preview: {
            version: 1,
            ledgerGeneratedAt: '2026-07-17T04:00:00.000Z',
            previousLedgerEntries: 10,
            projectedLedgerEntries: 12,
            previousAvailableRequests: 9,
            projectedAvailableRequests: 11,
            newLedgerFiles: 2,
            previousTotalTokens: 100,
            projectedTotalTokens: 125,
            prune,
          },
          ticket: 'fresh-candidate',
        };
      },
      execute: async () => {
        throw new Error('should-not-run');
      },
    },
    randomUuid: () => '9a090ef7-b788-432d-85a6-070ecf954fe9',
    getCommitFloor: () => floor,
  });

  const preview = await previewLedgerMaintenanceAfterReconcile({
    reconcile: async () => {
      order.push('reconcile');
      floor = { totalTokens: 120, requests: 11, ledgerEntries: 11 };
    },
    controller,
  });

  assert.deepEqual(order, ['reconcile', 'preview']);
  assert.equal(previewCalls, 1);
  assert.equal(preview.projectedTotalTokens, 125);
});

test('post-execute reconcile failure preserves the worker result and marks verification pending', async () => {
  const { executeLedgerMaintenanceWithPostVerification } = await loadLedgerMaintenance();
  const result = {
    version: 1,
    completedAt: '2026-07-17T04:31:00.000Z',
    ledgerGeneratedAt: '2026-07-17T04:30:30.000Z',
    ledgerEntries: 12,
    availableRequests: 11,
    updatedLedgerFiles: 2,
    previousTotalTokens: 100,
    totalTokens: 125,
    totalPreserved: true,
    prune: { ...prune, deletedFiles: 2, deletedBytes: 4096 },
  };
  let reconcileCalls = 0;
  let executeCalls = 0;

  const completed = await executeLedgerMaintenanceWithPostVerification({
    previewId: '6b838f74-bcca-4ef2-8f6e-2fa47332c873',
    reconcile: async () => {
      reconcileCalls += 1;
      if (reconcileCalls === 1) {
        return {
          periods: { ledgerCoverage: { totalTokens: 120, requests: 11 } },
          statusCounts: {
            available: 11,
            pending: 0,
            unreported: 1,
            ambiguous: 0,
            parseError: 0,
            unsupported: 0,
          },
        };
      }
      throw new Error('collector-reconcile-timeout');
    },
    controller: {
      execute: async () => {
        executeCalls += 1;
        return result;
      },
    },
  });

  assert.deepEqual(completed, { ...result, postVerificationPending: true });
  assert.equal(executeCalls, 1, 'the worker result must complete before verification is marked pending');
  assert.equal(reconcileCalls, 2);

  let verificationReconcileCalls = 0;
  const verificationPending = await executeLedgerMaintenanceWithPostVerification({
    previewId: '6b838f74-bcca-4ef2-8f6e-2fa47332c873',
    reconcile: async () => {
      verificationReconcileCalls += 1;
      if (verificationReconcileCalls === 1) {
        return {
          periods: { ledgerCoverage: { totalTokens: 120, requests: 11 } },
          statusCounts: {
            available: 11,
            pending: 0,
            unreported: 1,
            ambiguous: 0,
            parseError: 0,
            unsupported: 0,
          },
        };
      }
      return {
        source: { ledgerGeneratedAt: '2026-07-17T04:29:00.000Z' },
        periods: { ledgerCoverage: { totalTokens: 125, requests: 11 } },
        statusCounts: {
          available: 11,
          pending: 0,
          unreported: 1,
          ambiguous: 0,
          parseError: 0,
          unsupported: 0,
        },
        ledgerView: {
          periods: { ledgerCoverage: { totalTokens: 125, requests: 11 } },
          statusCounts: {
            available: 11,
            pending: 0,
            unreported: 1,
            ambiguous: 0,
            parseError: 0,
            unsupported: 0,
          },
        },
      };
    },
    controller: { execute: async () => result },
  });
  assert.deepEqual(verificationPending, { ...result, postVerificationPending: true });
});

test('pre-execute reconcile failure does not fabricate a completed maintenance result', async () => {
  const { executeLedgerMaintenanceWithPostVerification } = await loadLedgerMaintenance();
  let executeCalls = 0;

  await assert.rejects(
    executeLedgerMaintenanceWithPostVerification({
      previewId: '6b838f74-bcca-4ef2-8f6e-2fa47332c873',
      reconcile: async () => {
        throw new Error('collector-reconcile-timeout');
      },
      controller: {
        execute: async () => {
          executeCalls += 1;
          throw new Error('should-not-run');
        },
      },
    }),
    /collector-reconcile-timeout/
  );
  assert.equal(executeCalls, 0);
});

test('bundled runner treats maintenance progress as a heartbeat instead of a hard runtime cap', async () => {
  const { createBundledLedgerMaintenanceRunner } = await loadLedgerMaintenance();
  let killed = false;
  class FakeUtilityProcess extends EventEmitter {
    postMessage() {
      for (const delay of [10, 20, 30, 40, 50]) {
        setTimeout(() => this.emit('message', { type: 'maintenance-progress' }), delay);
      }
      setTimeout(
        () =>
          this.emit('message', {
            type: 'preview-result',
            preview: {
              version: 1,
              ledgerGeneratedAt: null,
              previousLedgerEntries: 0,
              projectedLedgerEntries: 0,
              previousAvailableRequests: 0,
              projectedAvailableRequests: 0,
              newLedgerFiles: 0,
              previousTotalTokens: 0,
              projectedTotalTokens: 0,
              prune: { ...prune, eligibleFiles: 0, eligibleBytes: 0 },
            },
            ticket: { opaque: 'internal' },
          }),
        60
      );
    }

    kill() {
      killed = true;
      return true;
    }
  }
  const runner = createBundledLedgerMaintenanceRunner({
    forkProcess: () => {
      const child = new FakeUtilityProcess();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    runnerPath: 'D:\\fixed\\maintenance\\worker.js',
    timeoutMs: 25,
  });

  const result = await runner.preview();
  assert.equal(result.preview.version, 1);
  assert.equal(killed, false);
});

test('bundled runner uses a fixed entry, empty argv, minimal environment, and structured messages', async () => {
  const {
    createBundledLedgerMaintenanceRunner,
    resolveLedgerMaintenanceRunnerPath,
  } = await loadLedgerMaintenance();
  const runnerPath = resolveLedgerMaintenanceRunnerPath({
    isPackaged: true,
    resourcesPath: 'D:\\apps\\CPA-Token-Pulse\\resources',
    moduleUrl: 'file:///D:/ignored/main.js',
  });
  assert.equal(
    runnerPath,
    'D:\\apps\\CPA-Token-Pulse\\resources\\app.asar.unpacked\\dist-electron\\maintenance\\worker.js'
  );

  const calls = [];
  class FakeUtilityProcess extends EventEmitter {
    postMessage(message) {
      calls[0].message = message;
      queueMicrotask(() =>
        this.emit('message', {
          type: 'preview-result',
          preview: {
            version: 1,
            ledgerGeneratedAt: null,
            previousLedgerEntries: 0,
            projectedLedgerEntries: 0,
            previousAvailableRequests: 0,
            projectedAvailableRequests: 0,
            newLedgerFiles: 0,
            previousTotalTokens: 0,
            projectedTotalTokens: 0,
            prune: { ...prune, eligibleFiles: 0, eligibleBytes: 0 },
          },
          ticket: { opaque: 'internal' },
        })
      );
    }

    kill() {
      return true;
    }
  }
  const forkProcess = (modulePath, args, options) => {
    const child = new FakeUtilityProcess();
    calls.push({ modulePath, args, options, child, message: null });
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  const runner = createBundledLedgerMaintenanceRunner({
    forkProcess,
    runnerPath,
    environment: {
      SystemRoot: 'C:\\Windows',
      TEMP: 'D:\\Tools\\Cache\\CPA-Token-Pulse\\tmp',
      CPAMC_MANAGEMENT_KEY: 'must-not-propagate',
      HTTPS_PROXY: 'http://must-not-propagate',
    },
  });

  const result = await runner.preview();
  assert.equal(result.preview.version, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].modulePath, runnerPath);
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].options.cwd, path.dirname(runnerPath));
  assert.equal(calls[0].options.stdio, 'ignore');
  assert.deepEqual(calls[0].options.env, {
    SystemRoot: 'C:\\Windows',
    TEMP: 'D:\\Tools\\Cache\\CPA-Token-Pulse\\tmp',
  });
  assert.deepEqual(calls[0].message, { type: 'preview' });
});

test('bundled runner keeps one worker session from preview through execute', async () => {
  const { createBundledLedgerMaintenanceRunner } = await loadLedgerMaintenance();
  const messages = [];
  let forkCount = 0;
  class FakeUtilityProcess extends EventEmitter {
    postMessage(message) {
      messages.push(message);
      if (message.type === 'preview') {
        queueMicrotask(() =>
          this.emit('message', {
            type: 'preview-result',
            preview: {
              version: 1,
              ledgerGeneratedAt: null,
              previousLedgerEntries: 0,
              projectedLedgerEntries: 1,
              previousAvailableRequests: 0,
              projectedAvailableRequests: 1,
              newLedgerFiles: 1,
              previousTotalTokens: 0,
              projectedTotalTokens: 10,
              prune: { ...prune, eligibleFiles: 0, eligibleBytes: 0 },
            },
            ticket: { opaque: 'same-worker' },
            expiresAt: '2026-07-17T04:31:00.000Z',
          })
        );
        return;
      }
      queueMicrotask(() =>
        this.emit('message', {
          type: 'execute-result',
          result: {
            version: 1,
            completedAt: '2026-07-17T04:30:30.000Z',
            ledgerGeneratedAt: '2026-07-17T04:30:00.000Z',
            ledgerEntries: 1,
            availableRequests: 1,
            updatedLedgerFiles: 1,
            previousTotalTokens: 0,
            totalTokens: 10,
            totalPreserved: true,
            prune: { ...prune, deletedFiles: 0, deletedBytes: 0 },
          },
        })
      );
    }

    kill() {
      return true;
    }
  }
  const runner = createBundledLedgerMaintenanceRunner({
    forkProcess: () => {
      forkCount += 1;
      const child = new FakeUtilityProcess();
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
    runnerPath: 'D:\\fixed\\maintenance\\worker.js',
  });

  const preview = await runner.preview();
  const floor = { totalTokens: 0, requests: 0, ledgerEntries: 0 };
  const result = await runner.execute(preview.ticket, floor);

  assert.equal(forkCount, 1);
  assert.deepEqual(messages, [
    { type: 'preview' },
    { type: 'execute', ticket: { opaque: 'same-worker' }, floor },
  ]);
  assert.equal(result.totalTokens, 10);
});

test('bundled runner preserves only whitelisted worker error codes', async () => {
  const { createBundledLedgerMaintenanceRunner } = await loadLedgerMaintenance();
  for (const code of ['ledger-maintenance-busy', 'ledger-maintenance-low-space']) {
    class FakeUtilityProcess extends EventEmitter {
      postMessage() {
        queueMicrotask(() =>
          this.emit('message', {
            type: 'maintenance-error',
            code,
            raw: 'D:\\CLIProxyAPI\\logs\\secret.log',
          })
        );
      }

      kill() {
        return true;
      }
    }

    const runner = createBundledLedgerMaintenanceRunner({
      forkProcess: () => {
        const child = new FakeUtilityProcess();
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
      runnerPath: 'D:\\fixed\\maintenance\\worker.js',
    });

    await assert.rejects(runner.preview(), new RegExp(code));
  }
});

test('maintenance IPC trusts only the current main window main frame at an allowed URL', async () => {
  const { isTrustedLedgerMaintenanceSender } = await loadLedgerMaintenance();
  const mainFrame = { url: 'file:///D:/app/dist/index.html' };
  const webContents = { mainFrame };
  const allowed = (url) => url === mainFrame.url;

  assert.equal(
    isTrustedLedgerMaintenanceSender(
      { sender: webContents, senderFrame: mainFrame },
      webContents,
      allowed
    ),
    true
  );
  assert.equal(
    isTrustedLedgerMaintenanceSender(
      { sender: webContents, senderFrame: { url: mainFrame.url } },
      webContents,
      allowed
    ),
    false,
    'a same-origin subframe is not the trusted main frame'
  );
  assert.equal(
    isTrustedLedgerMaintenanceSender(
      { sender: { mainFrame }, senderFrame: mainFrame },
      webContents,
      allowed
    ),
    false,
    'foreign webContents cannot invoke maintenance'
  );
  assert.equal(
    isTrustedLedgerMaintenanceSender(
      { sender: webContents, senderFrame: { ...mainFrame, url: 'https://example.invalid' } },
      webContents,
      () => false
    ),
    false
  );
});

test('invariant floor separates available requests from all visible ledger entries', async () => {
  const { getLedgerMaintenanceInvariantFloor } = await loadLedgerMaintenance();
  assert.deepEqual(
    getLedgerMaintenanceInvariantFloor({
      periods: { ledgerCoverage: { totalTokens: 125, requests: 11 } },
      statusCounts: {
        available: 11,
        pending: 1,
        unreported: 2,
        ambiguous: 0,
        parseError: 1,
        unsupported: 0,
      },
    }),
    { totalTokens: 125, requests: 11, ledgerEntries: 14 }
  );
});

test('worker commit floor uses the formal ledger while the post-check floor stays combined', async () => {
  const {
    getLedgerMaintenanceCommitFloor,
    getLedgerMaintenanceInvariantFloor,
  } = await loadLedgerMaintenance();
  const snapshot = {
    periods: { ledgerCoverage: { totalTokens: 125, requests: 11 } },
    statusCounts: {
      available: 11,
      pending: 1,
      unreported: 2,
      ambiguous: 0,
      parseError: 1,
      unsupported: 0,
    },
    ledgerView: {
      periods: { ledgerCoverage: { totalTokens: 100, requests: 9 } },
      statusCounts: {
        available: 9,
        pending: 0,
        unreported: 1,
        ambiguous: 0,
        parseError: 0,
        unsupported: 0,
      },
    },
  };

  assert.deepEqual(getLedgerMaintenanceCommitFloor(snapshot), {
    totalTokens: 100,
    requests: 9,
    ledgerEntries: 10,
  });
  assert.deepEqual(getLedgerMaintenanceInvariantFloor(snapshot), {
    totalTokens: 125,
    requests: 11,
    ledgerEntries: 14,
  });
});

test('post-maintenance snapshot verification accepts monotonic formal growth and rejects regressions', async () => {
  const { verifyLedgerMaintenanceSnapshot } = await loadLedgerMaintenance();
  const floor = { totalTokens: 120, requests: 11, ledgerEntries: 12 };
  const result = {
    version: 1,
    completedAt: '2026-07-17T04:31:00.000Z',
    ledgerGeneratedAt: '2026-07-17T04:30:30.000Z',
    ledgerEntries: 12,
    availableRequests: 11,
    updatedLedgerFiles: 2,
    previousTotalTokens: 100,
    totalTokens: 125,
    totalPreserved: true,
    prune: { ...prune, deletedFiles: 2, deletedBytes: 4096 },
  };
  const snapshot = {
    source: { ledgerGeneratedAt: result.ledgerGeneratedAt },
    periods: { ledgerCoverage: { totalTokens: 125, requests: 11 } },
    statusCounts: {
      available: 11,
      pending: 0,
      unreported: 1,
      ambiguous: 0,
      parseError: 0,
      unsupported: 0,
    },
    ledgerView: {
      periods: { ledgerCoverage: { totalTokens: 125, requests: 11 } },
      statusCounts: {
        available: 11,
        pending: 0,
        unreported: 1,
        ambiguous: 0,
        parseError: 0,
        unsupported: 0,
      },
    },
  };

  assert.equal(verifyLedgerMaintenanceSnapshot(snapshot, result, floor), true);
  assert.equal(
    verifyLedgerMaintenanceSnapshot(
      {
        ...snapshot,
        source: { ledgerGeneratedAt: '2026-07-17T04:32:00.000Z' },
        periods: { ledgerCoverage: { totalTokens: 140, requests: 12 } },
        statusCounts: {
          ...snapshot.statusCounts,
          available: 12,
          unreported: 1,
        },
        ledgerView: {
          periods: { ledgerCoverage: { totalTokens: 140, requests: 12 } },
          statusCounts: {
            ...snapshot.ledgerView.statusCounts,
            available: 12,
            unreported: 1,
          },
        },
      },
      result,
      floor
    ),
    true,
    'a newer formal ledger that monotonically extends the worker result must remain valid'
  );
  assert.throws(
    () =>
      verifyLedgerMaintenanceSnapshot(
        { ...snapshot, source: { ledgerGeneratedAt: '2026-07-17T04:29:00.000Z' } },
        result,
        floor
      ),
    /ledger-maintenance-invalid-response/
  );
  assert.throws(
    () =>
      verifyLedgerMaintenanceSnapshot(
        {
          ...snapshot,
          ledgerView: {
            periods: { ledgerCoverage: { totalTokens: 125, requests: 11 } },
            statusCounts: {
              available: 11,
              pending: 0,
              unreported: 0,
              ambiguous: 0,
              parseError: 0,
              unsupported: 0,
            },
          },
        },
        result,
        floor
      ),
    /ledger-maintenance-invalid-response/
  );
  assert.throws(
    () =>
      verifyLedgerMaintenanceSnapshot(
        {
          ...snapshot,
          ledgerView: {
            periods: { ledgerCoverage: { totalTokens: 124, requests: 11 } },
            statusCounts: snapshot.ledgerView.statusCounts,
          },
        },
        result,
        floor
      ),
    /ledger-maintenance-invalid-response/
  );
  assert.throws(
    () =>
      verifyLedgerMaintenanceSnapshot(
        {
          ...snapshot,
          periods: { ledgerCoverage: { totalTokens: 119, requests: 11 } },
        },
        result,
        floor
      ),
    /ledger-maintenance-total-regression/
  );
  assert.throws(
    () =>
      verifyLedgerMaintenanceSnapshot(
        {
          ...snapshot,
          statusCounts: { ...snapshot.statusCounts, available: 10 },
        },
        result,
        floor
      ),
    /ledger-maintenance-invalid-response/
  );
  assert.throws(
    () =>
      verifyLedgerMaintenanceSnapshot(
        {
          ...snapshot,
          periods: { ledgerCoverage: { totalTokens: 125, requests: 10 } },
          statusCounts: { ...snapshot.statusCounts, available: 10 },
        },
        result,
        floor
      ),
    /ledger-maintenance-total-regression/
  );
  assert.throws(
    () =>
      verifyLedgerMaintenanceSnapshot(
        {
          ...snapshot,
          ledgerView: {
            periods: { ledgerCoverage: { totalTokens: 125, requests: 10 } },
            statusCounts: { ...snapshot.ledgerView.statusCounts, available: 10 },
          },
        },
        result,
        floor
      ),
    /ledger-maintenance-invalid-response/
  );
});

test('a preview expires exactly at expiresAt and cannot be retried', async () => {
  const { createLedgerMaintenanceController } = await loadLedgerMaintenance();
  let nowMs = Date.parse('2026-07-17T05:00:00.000Z');
  let executeCalls = 0;
  const runner = {
    preview: async () => ({
      preview: {
        version: 1,
        ledgerGeneratedAt: null,
        previousLedgerEntries: 0,
        projectedLedgerEntries: 0,
        previousAvailableRequests: 0,
        projectedAvailableRequests: 0,
        newLedgerFiles: 0,
        previousTotalTokens: 0,
        projectedTotalTokens: 0,
        prune: { ...prune, eligibleFiles: 0, eligibleBytes: 0 },
      },
      ticket: { opaque: true },
    }),
    execute: async () => {
      executeCalls += 1;
      throw new Error('should-not-run');
    },
  };
  const controller = createLedgerMaintenanceController({
    runner,
    now: () => nowMs,
    randomUuid: () => '61f92c52-8088-4f49-9193-269dbfe0e716',
    previewTtlMs: 60_000,
  });
  const preview = await controller.preview();
  nowMs = Date.parse(preview.expiresAt);

  await assert.rejects(controller.execute(preview.previewId), /ledger-maintenance-preview-expired/);
  assert.equal(executeCalls, 0);
  await assert.rejects(
    controller.execute(preview.previewId),
    /ledger-maintenance-preview-unavailable/
  );
});

test('invalid ids do not reach the runner or consume a valid preview', async () => {
  const { createLedgerMaintenanceController } = await loadLedgerMaintenance();
  const validId = '2be0882a-bb2f-44d7-84b3-8c0d68c3fa44';
  let executeCalls = 0;
  const runner = {
    preview: async () => ({
      preview: {
        version: 1,
        ledgerGeneratedAt: null,
        previousLedgerEntries: 0,
        projectedLedgerEntries: 0,
        previousAvailableRequests: 0,
        projectedAvailableRequests: 0,
        newLedgerFiles: 0,
        previousTotalTokens: 0,
        projectedTotalTokens: 0,
        prune: { ...prune, eligibleFiles: 0, eligibleBytes: 0 },
      },
      ticket: 'internal',
    }),
    execute: async () => {
      executeCalls += 1;
      return {
        version: 1,
        completedAt: '2026-07-17T05:10:00.000Z',
        ledgerGeneratedAt: '2026-07-17T05:10:00.000Z',
        ledgerEntries: 0,
        availableRequests: 0,
        updatedLedgerFiles: 0,
        previousTotalTokens: 0,
        totalTokens: 0,
        totalPreserved: true,
        prune: { ...prune, eligibleFiles: 0, eligibleBytes: 0, deletedFiles: 0, deletedBytes: 0 },
      };
    },
  };
  const controller = createLedgerMaintenanceController({
    runner,
    randomUuid: () => validId,
  });
  await controller.preview();

  for (const invalid of [
    'D:\\CLIProxyAPI\\logs',
    '00000000-0000-0000-0000-000000000000',
    `${validId}extra`,
    { previewId: validId, command: 'delete' },
  ]) {
    await assert.rejects(controller.execute(invalid), /ledger-maintenance-preview-invalid/);
  }
  assert.equal(executeCalls, 0);
  await controller.execute(validId);
  assert.equal(executeCalls, 1);
});

test('operations are fail-fast serialized and runner errors are reduced to a stable code', async () => {
  const { createLedgerMaintenanceController } = await loadLedgerMaintenance();
  let releasePreview;
  const previewGate = new Promise((resolve) => {
    releasePreview = resolve;
  });
  const previewPayload = {
    preview: {
      version: 1,
      ledgerGeneratedAt: null,
      previousLedgerEntries: 0,
      projectedLedgerEntries: 0,
      previousAvailableRequests: 0,
      projectedAvailableRequests: 0,
      newLedgerFiles: 0,
      previousTotalTokens: 0,
      projectedTotalTokens: 0,
      prune: { ...prune, eligibleFiles: 0, eligibleBytes: 0 },
    },
    ticket: 'internal',
  };
  const controller = createLedgerMaintenanceController({
    runner: {
      preview: async () => {
        await previewGate;
        return previewPayload;
      },
      execute: async () => {
        throw new Error('D:\\CLIProxyAPI\\logs\\private.log SECRET_STACK');
      },
    },
    randomUuid: () => '24ded660-aed2-4970-a522-e8b402ac7f56',
  });

  const firstPreview = controller.preview();
  await assert.rejects(controller.preview(), /ledger-maintenance-busy/);
  releasePreview();
  const preview = await firstPreview;

  let failure;
  try {
    await controller.execute(preview.previewId);
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.message, 'ledger-maintenance-failed');
  assert.equal(String(failure).includes('private.log'), false);
  assert.equal(String(failure).includes('SECRET_STACK'), false);
});
