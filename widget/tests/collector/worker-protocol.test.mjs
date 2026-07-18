import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import test from 'node:test';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(testDirectory, '../../dist-electron/collector/worker.js');

const nextMessage = (worker, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker-message-timeout')), timeoutMs);
    worker.once('message', (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    worker.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

const nextMatchingMessage = (worker, predicate, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      worker.off('message', onMessage);
      worker.off('error', onError);
    };
    const onMessage = (message) => {
      if (!predicate(message)) return;
      cleanup();
      resolve(message);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('worker-matching-message-timeout'));
    }, timeoutMs);
    worker.on('message', onMessage);
    worker.on('error', onError);
  });

test('worker IPC emits aggregate snapshots or stable fatal codes only', async () => {
  await fs.access(workerPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-worker-'));
  const logsDir = path.join(root, 'logs');
  const authLogsDir = path.join(root, 'auths', 'logs');
  const requestId = 'synthetic-secret-id';
  const promptSecret = 'prompt-must-never-cross-ipc';
  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(authLogsDir, { recursive: true });
    await fs.writeFile(
      path.join(logsDir, `v1-responses-2026-07-16T110000-${requestId}.log`),
      [
        '=== REQUEST BODY ===',
        JSON.stringify({
          model: 'gpt-fake-request',
          prompt: promptSecret,
          headers: { authorization: 'Bearer synthetic-secret' },
        }),
        '=== RESPONSE ===',
        '{"model":"gpt-5.6-sol","usage":{"input_tokens":5,"output_tokens":1,"total_tokens":6}}',
        '=== END RESPONSE ===',
        '',
      ].join('\n'),
      'utf8'
    );

    const worker = new Worker(pathToFileURL(workerPath), {
      workerData: {
        installDir: root,
        cacheDir: path.join(root, 'cache'),
        pricingOverrides: [],
      },
    });
    try {
      const message = await nextMatchingMessage(
        worker,
        (candidate) =>
          candidate?.type === 'snapshot' &&
          candidate.snapshot.periods.ledgerCoverage.unpricedTokens === 6
      );
      assert.equal(message.type, 'snapshot');
      assert.deepEqual(Object.keys(message).sort(), ['snapshot', 'type']);
      assert.equal(message.snapshot.version, 1);
      const serialized = JSON.stringify(message);
      assert.ok(!serialized.includes(requestId));
      assert.ok(!serialized.includes(promptSecret));
      assert.ok(!serialized.includes('synthetic-secret'));
      assert.ok(!serialized.includes('gpt-fake-request'));
      assert.ok(!/requestId|fileName|headers|prompt|rawBuffer|rawText/.test(serialized));
      assert.equal(message.snapshot.periods.ledgerCoverage.unpricedTokens, 6);

      const repricedMessage = nextMessage(worker);
      worker.postMessage({
        type: 'update-pricing',
        pricingOverrides: [
          {
            pattern: 'gpt-5.6-*',
            inputUsdPer1M: 1,
            cachedInputUsdPer1M: 0.1,
            outputUsdPer1M: 2,
            enabled: true,
          },
        ],
      });
      const repriced = await repricedMessage;
      assert.equal(repriced.type, 'snapshot');
      assert.equal(repriced.snapshot.periods.ledgerCoverage.pricedTokens, 6);
      assert.ok(repriced.snapshot.periods.ledgerCoverage.estimatedUsd > 0);

      const reconcileMessages = [];
      const captureReconcile = (candidate) => reconcileMessages.push(candidate);
      worker.on('message', captureReconcile);
      const reconcileCompletePromise = nextMatchingMessage(
        worker,
        (candidate) =>
          candidate?.type === 'reconcile-complete' && candidate.requestId === 'reconcile-1'
      );
      worker.postMessage({ type: 'reconcile', requestId: 'reconcile-1' });
      const reconcileComplete = await reconcileCompletePromise;
      worker.off('message', captureReconcile);

      assert.deepEqual(reconcileComplete, {
        type: 'reconcile-complete',
        requestId: 'reconcile-1',
      });
      const snapshotIndex = reconcileMessages.findIndex((candidate) => candidate?.type === 'snapshot');
      const completionIndex = reconcileMessages.findIndex(
        (candidate) => candidate?.type === 'reconcile-complete'
      );
      assert.ok(snapshotIndex >= 0, 'reconcile must publish its fresh snapshot');
      assert.ok(
        completionIndex > snapshotIndex,
        'reconcile completion must be emitted after the fresh snapshot'
      );
    } finally {
      worker.postMessage({ type: 'shutdown' });
      await new Promise((resolve) => worker.once('exit', resolve));
    }

    const cachedSnapshot = JSON.parse(
      await fs.readFile(path.join(root, 'cache', 'snapshot-v1.json'), 'utf8')
    );
    const cachedText = JSON.stringify(cachedSnapshot);
    assert.equal(cachedSnapshot.version, 1);
    assert.ok(!cachedText.includes(requestId));
    assert.ok(!cachedText.includes(promptSecret));
    assert.ok(!/requestId|fileName|headers|prompt|rawBuffer|rawText/.test(cachedText));

    const invalidWorker = new Worker(pathToFileURL(workerPath), { workerData: {} });
    const fatal = await nextMessage(invalidWorker);
    assert.deepEqual(fatal, {
      type: 'fatal',
      code: 'collector-worker-data-invalid',
    });
    await new Promise((resolve) => invalidWorker.once('exit', resolve));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
