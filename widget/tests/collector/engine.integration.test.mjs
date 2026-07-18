import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { TokenPulseEngine } from '../../electron/collector/engine.mjs';
import { readBoundedResponseLog } from '../../electron/collector/logReader.mjs';

const makeLog = (model, input, output) =>
  [
    '=== REQUEST BODY ===',
    '{"model":"gpt-fake","usage":{"input_tokens":999,"output_tokens":1,"total_tokens":1000}}',
    '=== API RESPONSE 1 ===',
    JSON.stringify({
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        total_tokens: input + output,
      },
    }),
    '',
  ].join('\n');

const makeLedgerEntry = ({
  logsDir,
  fileName,
  stats,
  model,
  configuredModel = model,
  actualModel = model,
  timestampMs = new Date(2026, 6, 16, 10, 0, 0).getTime(),
  input,
  output,
}) => ({
  fileName,
  fileType: 'responses',
  timestampMs,
  requestId: fileName.match(/-([A-Za-z0-9_-]+)\.log$/)?.[1] ?? null,
  sourceDir: logsDir,
  sourceKey: `${logsDir}::${fileName}`,
  detailStatus: 'ready',
  configuredModel,
  actualModel,
  tokenUsage: {
    input,
    output,
    cached: 0,
    reasoning: 0,
    total: input + output,
    status: 'available',
  },
  fileSize: stats?.size ?? 0,
  lastModifiedMs: stats ? Math.floor(stats.mtimeMs) : 0,
});

const writeLedger = async (ledgerPath, entries, generatedAt = '2026-07-16T00:00:00.000Z') => {
  await fs.mkdir(path.dirname(ledgerPath), { recursive: true });
  const timestamps = entries.map((entry) => entry.timestampMs).filter(Number.isFinite);
  await fs.writeFile(
    ledgerPath,
    JSON.stringify(
      {
        version: 1,
        generatedAt,
        coverage: {
          earliestTimestampMs: timestamps.length ? Math.min(...timestamps) : null,
          latestTimestampMs: timestamps.length ? Math.max(...timestamps) : null,
        },
        entries,
      },
      null,
      2
    ),
    'utf8'
  );
};

const inertWatchFactory = () => ({ on: () => {}, close: () => {} });

test('legacy ledger image misattribution is repaired in memory without changing real image usage', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-legacy-model-repair-'));
  const logsDir = path.join(root, 'logs');
  const ledgerPath = path.join(root, 'static', 'token-ledger.json');
  const nowMs = new Date(2026, 6, 16, 12, 0, 0).getTime();

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await writeLedger(ledgerPath, [
      makeLedgerEntry({
        logsDir,
        fileName: 'v1-responses-2026-07-16T110000-legacySolar.log',
        stats: null,
        configuredModel: 'gpt-5.6-sol',
        actualModel: 'gpt-image-2-codex',
        timestampMs: new Date(2026, 6, 16, 11, 0, 0).getTime(),
        input: 100,
        output: 20,
      }),
      makeLedgerEntry({
        logsDir,
        fileName: 'v1-responses-2026-07-16T100000-realImage.log',
        stats: null,
        configuredModel: 'gpt-image-2-codex',
        actualModel: 'gpt-image-2-codex',
        timestampMs: new Date(2026, 6, 16, 10, 0, 0).getTime(),
        input: 8,
        output: 2,
      }),
      makeLedgerEntry({
        logsDir,
        fileName: 'v1-responses-2026-07-16T090000-futureImage.log',
        stats: null,
        configuredModel: 'gpt-5.6-sol',
        actualModel: 'gpt-image-3',
        timestampMs: new Date(2026, 6, 16, 9, 0, 0).getTime(),
        input: 5,
        output: 2,
      }),
    ]);
    const ledgerBefore = await fs.readFile(ledgerPath, 'utf8');

    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir],
      ledgerPaths: [ledgerPath],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 0,
      watchFactory: inertWatchFactory,
      now: () => nowMs,
    });

    try {
      const snapshot = await engine.start();
      const coverage = snapshot.periods.ledgerCoverage;
      const solar = snapshot.topModels.find((entry) => entry.model === 'gpt-5.6-sol');
      const image = snapshot.topModels.find((entry) => entry.model === 'gpt-image-2-codex');
      const futureImage = snapshot.topModels.find((entry) => entry.model === 'gpt-image-3');

      assert.equal(coverage.totalTokens, 137, 'model repair must not change token totals');
      assert.equal(coverage.unpricedTokens, 127);
      assert.equal(coverage.pricedTokens, 10);
      assert.equal(coverage.unpricedRequests, 2);
      assert.equal(coverage.pricedRequests, 1);
      assert.ok(solar);
      assert.equal(solar.totalTokens, 120);
      assert.equal(solar.estimatedUsd, null);
      assert.ok(image);
      assert.equal(image.totalTokens, 10);
      assert.ok(futureImage, 'unconfirmed future image models must not be rewritten');
      assert.equal(futureImage.totalTokens, 7);
      assert.equal(coverage.estimatedUsd, image.estimatedUsd);
      assert.deepEqual(
        snapshot.recentModels.map((entry) => entry.model),
        ['gpt-5.6-sol', 'gpt-image-2-codex', 'gpt-image-3']
      );
      assert.equal(snapshot.latestRequest?.model, 'gpt-5.6-sol');
      assert.equal(snapshot.latestRequest?.status, 'unpriced');
      assert.equal(
        await fs.readFile(ledgerPath, 'utf8'),
        ledgerBefore,
        'legacy model repair must not rewrite the source ledger'
      );
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('start publishes the streamed ledger baseline before slow live reconciliation finishes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-fast-baseline-'));
  const logsDir = path.join(root, 'logs');
  const ledgerPath = path.join(root, 'static', 'token-ledger.json');
  const baselineFileName = 'v1-responses-2026-07-16T100000-baseline01.log';
  const liveFileName = 'v1-responses-2026-07-16T110000-live01.log';
  let releaseRead;
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });

  try {
    await fs.mkdir(logsDir, { recursive: true });
    const baselinePath = path.join(logsDir, baselineFileName);
    await fs.writeFile(baselinePath, makeLog('gpt-5.4', 8, 2), 'utf8');
    const baselineStats = await fs.stat(baselinePath);
    await writeLedger(ledgerPath, [
      makeLedgerEntry({
        logsDir,
        fileName: baselineFileName,
        stats: baselineStats,
        model: 'gpt-5.4',
        input: 8,
        output: 2,
      }),
    ]);
    await fs.writeFile(path.join(logsDir, liveFileName), makeLog('gpt-5.4', 5, 1), 'utf8');

    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir],
      ledgerPaths: [ledgerPath],
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 1,
      watchFactory: inertWatchFactory,
      readLog: async (...args) => {
        await readGate;
        return readBoundedResponseLog(...args);
      },
    });
    const startPromise = engine.start();
    try {
      let timeoutId;
      const timeoutPromise = new Promise((resolve) => {
        timeoutId = setTimeout(() => resolve('timeout'), 2_000);
      });
      const initial = await Promise.race([startPromise, timeoutPromise]);
      clearTimeout(timeoutId);
      assert.notEqual(initial, 'timeout');
      assert.equal(initial.periods.ledgerCoverage.totalTokens, 10);
    } finally {
      releaseRead();
      await startPromise.catch(() => null);
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('initial live catch-up reads independent changed logs with bounded concurrency', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-concurrent-scan-'));
  const logsDir = path.join(root, 'logs');
  let inFlight = 0;
  let maximumInFlight = 0;
  try {
    await fs.mkdir(logsDir, { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      await fs.writeFile(
        path.join(logsDir, `v1-responses-2026-07-16T11000${index}-scan0${index}.log`),
        makeLog('gpt-5.4', 5, 1),
        'utf8'
      );
    }
    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir],
      ledgerPaths: [path.join(root, 'missing-ledger.json')],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 0,
      watchFactory: inertWatchFactory,
      readLog: async () => {
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight -= 1;
        return {
          bytesRead: 1,
          parsed: {
            status: 'available',
            model: 'gpt-5.4',
            tokenUsage: {
              input: 5,
              output: 1,
              cached: 0,
              reasoning: 0,
              total: 6,
              status: 'available',
            },
          },
        };
      },
    });
    try {
      await engine.start();
      assert.ok(maximumInFlight >= 2, `expected parallel reads, saw ${maximumInFlight}`);
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('baseline fingerprint skips parser; stable live fingerprints parse once then stop rescanning', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-engine-'));
  const logsDir = path.join(root, 'logs');
  const authLogsDir = path.join(root, 'auths', 'logs');
  const ledgerPath = path.join(root, 'static', 'token-ledger.json');
  const oldFileName = 'v1-responses-2026-07-16T100000-synthetic01.log';
  const oldPath = path.join(logsDir, oldFileName);
  let reads = 0;

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(authLogsDir, { recursive: true });
    await fs.writeFile(oldPath, makeLog('gpt-5.4', 8, 2), 'utf8');
    const oldStats = await fs.stat(oldPath);
    await writeLedger(ledgerPath, [
      makeLedgerEntry({
        logsDir,
        fileName: oldFileName,
        stats: oldStats,
        model: 'gpt-5.4',
        input: 8,
        output: 2,
      }),
    ]);

    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir, authLogsDir],
      ledgerPaths: [ledgerPath],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 60 * 1000,
      waitForStability: async () => {},
      watchFactory: inertWatchFactory,
      now: () => new Date(2026, 6, 16, 12, 0, 0).getTime(),
      readLog: async (...args) => {
        reads += 1;
        return readBoundedResponseLog(...args);
      },
    });

    try {
      const initial = await engine.start();
      assert.equal(reads, 0, 'baseline fingerprint must avoid re-reading recorded logs');
      assert.equal(initial.periods.ledgerCoverage.totalTokens, 10);
      assert.equal(initial.ledgerView.periods.ledgerCoverage.totalTokens, 10);
      assert.equal(initial.unledgeredView.periods.ledgerCoverage.totalTokens, 0);

      const liveFileName = 'v1-responses-2026-07-16T110000-synthetic02.log';
      const livePath = path.join(logsDir, liveFileName);
      await fs.writeFile(livePath, makeLog('gpt-5.4', 5, 1), 'utf8');
      await engine.reconcile();
      assert.equal(reads, 1);
      assert.equal(engine.getSnapshot().statusCounts.pending, 1);
      await engine.reconcile();
      assert.equal(reads, 2);
      assert.equal(engine.getSnapshot().periods.ledgerCoverage.totalTokens, 16);
      assert.equal(engine.getSnapshot().ledgerView.periods.ledgerCoverage.totalTokens, 10);
      assert.equal(engine.getSnapshot().unledgeredView.periods.ledgerCoverage.totalTokens, 6);
      await engine.reconcile();
      assert.equal(reads, 2, 'same successful fingerprint must not invoke the parser again');

      await fs.writeFile(livePath, makeLog('gpt-5.4', 9, 3), 'utf8');
      const changedTime = new Date(Date.now() + 5000);
      await fs.utimes(livePath, changedTime, changedTime);
      await engine.reconcile();
      await engine.reconcile();
      assert.equal(reads, 4);
      assert.equal(engine.getSnapshot().periods.ledgerCoverage.totalTokens, 22);
      await engine.reconcile();
      assert.equal(reads, 4, 'same failed-or-successful stable fingerprint stays memoized');

      const movedPath = path.join(authLogsDir, liveFileName);
      await fs.rename(livePath, movedPath);
      await engine.reconcile();
      await engine.reconcile();
      assert.equal(
        engine.getSnapshot().periods.ledgerCoverage.totalTokens,
        22,
        'rename across watched directories must not double count the request'
      );
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reconcile removes completed live entries whose source logs no longer exist', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-pruned-live-entry-'));
  const logsDir = path.join(root, 'logs');
  const ledgerPath = path.join(root, 'static', 'token-ledger.json');
  const fileName = 'v1-responses-2026-07-16T110000-prunedLive01.log';
  const filePath = path.join(logsDir, fileName);

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await writeLedger(ledgerPath, []);
    await fs.writeFile(filePath, makeLog('gpt-5.6-sol', 5, 1), 'utf8');

    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir],
      ledgerPaths: [ledgerPath],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 1,
      waitForStability: async () => {},
      watchFactory: inertWatchFactory,
      now: () => new Date(2026, 6, 16, 12, 0, 0).getTime(),
    });

    try {
      await engine.start();
      await engine.reconcile();
      assert.equal(engine.getSnapshot().periods.ledgerCoverage.totalTokens, 6);
      assert.equal(engine.getSnapshot().unledgeredView.periods.ledgerCoverage.totalTokens, 6);

      await fs.rm(filePath);
      const reconciled = await engine.reconcile();

      assert.equal(reconciled.periods.ledgerCoverage.totalTokens, 0);
      assert.equal(reconciled.unledgeredView.periods.ledgerCoverage.totalTokens, 0);
      assert.equal(reconciled.statusCounts.available, 0);
      assert.equal(engine.liveEntries.size, 0);
      assert.equal(engine.liveFingerprints.size, 0);
      assert.equal(engine.observations.size, 0);
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reconcile retains live entries while any configured log source is unavailable', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-unavailable-live-source-'));
  const logsDir = path.join(root, 'logs');
  const authLogsDir = path.join(root, 'auths', 'logs');
  const unavailableAuthLogsDir = `${authLogsDir}.offline`;
  const ledgerPath = path.join(root, 'static', 'token-ledger.json');
  const fileName = 'v1-responses-2026-07-16T110000-unavailableLive01.log';

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(authLogsDir, { recursive: true });
    await writeLedger(ledgerPath, []);
    await fs.writeFile(path.join(authLogsDir, fileName), makeLog('gpt-5.6-sol', 5, 1), 'utf8');

    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir, authLogsDir],
      ledgerPaths: [ledgerPath],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 1,
      waitForStability: async () => {},
      watchFactory: inertWatchFactory,
      now: () => new Date(2026, 6, 16, 12, 0, 0).getTime(),
    });

    try {
      await engine.start();
      await engine.reconcile();
      assert.equal(engine.getSnapshot().periods.ledgerCoverage.totalTokens, 6);

      await fs.rename(authLogsDir, unavailableAuthLogsDir);
      const degraded = await engine.reconcile();

      assert.equal(degraded.source.status, 'degraded');
      assert.equal(degraded.periods.ledgerCoverage.totalTokens, 6);
      assert.equal(degraded.unledgeredView.periods.ledgerCoverage.totalTokens, 6);

      await fs.rm(path.join(unavailableAuthLogsDir, fileName));
      await fs.rename(unavailableAuthLogsDir, authLogsDir);
      const recovered = await engine.reconcile();

      assert.equal(recovered.source.status, 'live');
      assert.equal(recovered.periods.ledgerCoverage.totalTokens, 0);
      assert.equal(recovered.unledgeredView.periods.ledgerCoverage.totalTokens, 0);
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reconcile retains missing live entries when a changed ledger cannot be reloaded', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-ledger-reload-failure-'));
  const logsDir = path.join(root, 'logs');
  const ledgerPath = path.join(root, 'static', 'token-ledger.json');
  const fileName = 'v1-responses-2026-07-16T110000-ledgerReload01.log';
  const filePath = path.join(logsDir, fileName);

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await writeLedger(ledgerPath, []);
    await fs.writeFile(filePath, makeLog('gpt-5.6-sol', 5, 1), 'utf8');
    const fileStats = await fs.stat(filePath);

    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir],
      ledgerPaths: [ledgerPath],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 1,
      waitForStability: async () => {},
      watchFactory: inertWatchFactory,
      now: () => new Date(2026, 6, 16, 12, 0, 0).getTime(),
    });

    try {
      await engine.start();
      await engine.reconcile();
      assert.equal(engine.getSnapshot().periods.ledgerCoverage.totalTokens, 6);

      await fs.rm(ledgerPath);
      await fs.mkdir(ledgerPath);
      await fs.rm(filePath);
      const degraded = await engine.reconcile();

      assert.equal(degraded.source.status, 'degraded');
      assert.equal(degraded.source.messageCode, 'collector-coverage-gap');
      assert.equal(degraded.periods.ledgerCoverage.totalTokens, 6);
      assert.equal(degraded.unledgeredView.periods.ledgerCoverage.totalTokens, 6);

      await fs.rm(ledgerPath, { recursive: true });
      await writeLedger(
        ledgerPath,
        [
          makeLedgerEntry({
            logsDir,
            fileName,
            stats: fileStats,
            model: 'gpt-5.6-sol',
            input: 5,
            output: 1,
          }),
        ],
        '2026-07-16T02:00:00.000Z'
      );
      const recovered = await engine.reconcile();

      assert.equal(recovered.ledgerView.periods.ledgerCoverage.totalTokens, 6);
      assert.equal(recovered.unledgeredView.periods.ledgerCoverage.totalTokens, 0);
      assert.equal(recovered.periods.ledgerCoverage.totalTokens, 6);
      assert.equal(engine.liveEntries.size, 0);
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reconcile retains missing live entries when a changed ledger only partially parses', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-ledger-partial-parse-'));
  const logsDir = path.join(root, 'logs');
  const ledgerPath = path.join(root, 'static', 'token-ledger.json');
  const liveFileName = 'v1-responses-2026-07-16T110000-ledgerPartial01.log';
  const liveFilePath = path.join(logsDir, liveFileName);

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await writeLedger(ledgerPath, []);
    await fs.writeFile(liveFilePath, makeLog('gpt-5.6-sol', 5, 1), 'utf8');
    const liveStats = await fs.stat(liveFilePath);

    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir],
      ledgerPaths: [ledgerPath],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 1,
      waitForStability: async () => {},
      watchFactory: inertWatchFactory,
      now: () => new Date(2026, 6, 16, 12, 0, 0).getTime(),
    });

    try {
      await engine.start();
      await engine.reconcile();
      assert.equal(engine.getSnapshot().periods.ledgerCoverage.totalTokens, 6);

      const validBaselineEntry = makeLedgerEntry({
        logsDir,
        fileName: 'v1-responses-2026-07-16T100000-validBaseline01.log',
        stats: null,
        model: 'gpt-5.6-sol',
        timestampMs: new Date(2026, 6, 16, 10, 0, 0).getTime(),
        input: 8,
        output: 2,
      });
      const malformedLiveEntry = makeLedgerEntry({
        logsDir,
        fileName: liveFileName,
        stats: liveStats,
        model: 'gpt-5.6-sol',
        timestampMs: new Date(2026, 6, 16, 11, 0, 0).getTime(),
        input: 5,
        output: 1,
      });
      await writeLedger(
        ledgerPath,
        [validBaselineEntry, malformedLiveEntry],
        '2026-07-16T02:00:00.000Z'
      );
      const validLedgerText = await fs.readFile(ledgerPath, 'utf8');
      const partiallyMalformedLedgerText = validLedgerText.replace('"total": 6', '"total": invalid');
      assert.notEqual(partiallyMalformedLedgerText, validLedgerText);
      await fs.writeFile(ledgerPath, partiallyMalformedLedgerText, 'utf8');
      await fs.rm(liveFilePath);

      const degraded = await engine.reconcile();

      assert.equal(degraded.source.status, 'degraded');
      assert.equal(degraded.source.messageCode, 'collector-coverage-gap');
      assert.equal(degraded.source.parseErrors, 1);
      assert.equal(degraded.ledgerView.periods.ledgerCoverage.totalTokens, 10);
      assert.equal(degraded.unledgeredView.periods.ledgerCoverage.totalTokens, 6);
      assert.equal(degraded.periods.ledgerCoverage.totalTokens, 16);
      assert.equal(engine.liveEntries.size, 1);
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reconcile retains missing live entries when a changed ledger contains a structural entry error', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-ledger-structural-error-'));
  const logsDir = path.join(root, 'logs');
  const ledgerPath = path.join(root, 'static', 'token-ledger.json');
  const liveFileName = 'v1-responses-2026-07-16T110000-ledgerStructural01.log';
  const liveFilePath = path.join(logsDir, liveFileName);

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await writeLedger(ledgerPath, []);
    await fs.writeFile(liveFilePath, makeLog('gpt-5.6-sol', 5, 1), 'utf8');

    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir],
      ledgerPaths: [ledgerPath],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 1,
      waitForStability: async () => {},
      watchFactory: inertWatchFactory,
      now: () => new Date(2026, 6, 16, 12, 0, 0).getTime(),
    });

    try {
      await engine.start();
      await engine.reconcile();
      assert.equal(engine.getSnapshot().periods.ledgerCoverage.totalTokens, 6);

      const validBaselineEntry = makeLedgerEntry({
        logsDir,
        fileName: 'v1-responses-2026-07-16T100000-validStructural01.log',
        stats: null,
        model: 'gpt-5.6-sol',
        input: 8,
        output: 2,
      });
      await fs.writeFile(
        ledgerPath,
        JSON.stringify(
          {
            version: 1,
            generatedAt: '2026-07-16T02:00:00.000Z',
            coverage: { earliestTimestampMs: null, latestTimestampMs: null },
            entries: [validBaselineEntry, {}],
          },
          null,
          2
        ),
        'utf8'
      );
      await fs.rm(liveFilePath);

      const degraded = await engine.reconcile();

      assert.equal(degraded.source.status, 'degraded');
      assert.equal(degraded.source.messageCode, 'collector-coverage-gap');
      assert.equal(degraded.source.parseErrors, 1);
      assert.equal(degraded.unledgeredView.periods.ledgerCoverage.totalTokens, 6);
      assert.equal(engine.liveEntries.size, 1);

      await fs.writeFile(
        ledgerPath,
        JSON.stringify(
          {
            version: 2,
            schemaNote: 'unsupported-version',
            generatedAt: '2026-07-16T03:00:00.000Z',
            coverage: { earliestTimestampMs: null, latestTimestampMs: null },
            entries: [validBaselineEntry],
          },
          null,
          2
        ),
        'utf8'
      );
      const unsupported = await engine.reconcile();
      assert.equal(unsupported.source.status, 'degraded');
      assert.equal(unsupported.source.parseErrors, 1);
      assert.equal(engine.liveEntries.size, 1);

      await fs.writeFile(
        ledgerPath,
        JSON.stringify(
          {
            version: 1,
            generatedAt: '2026-07-16T04:00:00.000Z',
            coverage: { earliestTimestampMs: null, latestTimestampMs: null },
            entries: [validBaselineEntry, validBaselineEntry],
          },
          null,
          2
        ),
        'utf8'
      );
      const duplicate = await engine.reconcile();
      assert.equal(duplicate.source.status, 'degraded');
      assert.equal(duplicate.source.parseErrors, 1);
      assert.equal(engine.liveEntries.size, 1);
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('conflicting complete retries across log directories become ambiguous and do not count tokens', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-ambiguous-'));
  const logsDir = path.join(root, 'logs');
  const authLogsDir = path.join(root, 'auths', 'logs');
  const fileName = 'v1-responses-2026-07-16T110000-synthetic03.log';
  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(authLogsDir, { recursive: true });
    await fs.writeFile(path.join(logsDir, fileName), makeLog('gpt-5.4', 5, 1), 'utf8');
    await fs.writeFile(path.join(authLogsDir, fileName), makeLog('gpt-5.4', 8, 2), 'utf8');
    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir, authLogsDir],
      ledgerPaths: [path.join(root, 'missing-ledger.json')],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 1,
      waitForStability: async () => {},
      watchFactory: inertWatchFactory,
      now: () => new Date(2026, 6, 16, 12, 0, 0).getTime(),
    });
    try {
      const snapshot = await engine.start();
      assert.equal(snapshot.statusCounts.ambiguous, 1);
      assert.equal(snapshot.periods.ledgerCoverage.totalTokens, 0);
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('a stable parse failure is fingerprinted and is not reparsed forever', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-failure-fingerprint-'));
  const logsDir = path.join(root, 'logs');
  const authLogsDir = path.join(root, 'auths', 'logs');
  const fileName = 'v1-responses-2026-07-16T110000-synthetic06.log';
  let reads = 0;
  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(authLogsDir, { recursive: true });
    await fs.writeFile(
      path.join(logsDir, fileName),
      '=== RESPONSE ===\n{"model":"gpt-5.4","usage":{"input_tokens":5\n',
      'utf8'
    );
    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir, authLogsDir],
      ledgerPaths: [path.join(root, 'missing-ledger.json')],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 1,
      waitForStability: async () => {},
      watchFactory: inertWatchFactory,
      now: () => new Date(2026, 6, 16, 12, 0, 0).getTime(),
      readLog: async (...args) => {
        reads += 1;
        return readBoundedResponseLog(...args);
      },
    });
    try {
      const snapshot = await engine.start();
      assert.equal(snapshot.statusCounts.parseError, 1);
      assert.equal(reads, 2);
      await engine.reconcile();
      assert.equal(reads, 2, 'same failed stable fingerprint must be skipped');
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('reconcile notices atomic ledger replacement and missing sources degrade safely', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-ledger-replace-'));
  const logsDir = path.join(root, 'logs');
  const authLogsDir = path.join(root, 'auths', 'logs');
  const ledgerPath = path.join(root, 'static', 'token-ledger.json');
  try {
    await fs.mkdir(logsDir, { recursive: true });
    await fs.mkdir(authLogsDir, { recursive: true });
    const first = makeLedgerEntry({
      logsDir,
      fileName: 'v1-responses-2026-07-16T090000-synthetic04.log',
      stats: null,
      model: 'gpt-5.4',
      input: 2,
      output: 1,
    });
    await writeLedger(ledgerPath, [first]);
    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir, authLogsDir],
      ledgerPaths: [ledgerPath],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 1,
      waitForStability: async () => {},
      watchFactory: inertWatchFactory,
      now: () => new Date(2026, 6, 16, 12, 0, 0).getTime(),
    });
    try {
      assert.equal((await engine.start()).periods.ledgerCoverage.totalTokens, 3);
      const second = makeLedgerEntry({
        logsDir,
        fileName: 'v1-responses-2026-07-16T100000-synthetic05.log',
        stats: null,
        model: 'gpt-5.4',
        input: 4,
        output: 1,
      });
      const staged = `${ledgerPath}.next`;
      await writeLedger(staged, [first, second], '2026-07-16T01:00:00.000Z');
      await fs.rename(staged, ledgerPath);
      const replaced = await engine.reconcile();
      assert.equal(replaced.periods.ledgerCoverage.totalTokens, 8);
      assert.equal(replaced.source.ledgerGeneratedAt, '2026-07-16T01:00:00.000Z');
    } finally {
      await engine.stop();
    }

    const missingEngine = new TokenPulseEngine({
      installDir: path.join(root, 'missing'),
      cacheDir: path.join(root, 'cache-missing'),
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 1,
      waitForStability: async () => {},
      watchFactory: inertWatchFactory,
    });
    try {
      const missing = await missingEngine.start();
      assert.equal(missing.source.status, 'offline');
      assert.equal(missing.source.messageCode, 'collector-sources-unavailable');
    } finally {
      await missingEngine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('ledger reload consumes a completed live entry even after its source log was pruned', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-ledger-consume-live-'));
  const logsDir = path.join(root, 'logs');
  const ledgerPath = path.join(root, 'static', 'token-ledger.json');
  const fileName = 'v1-responses-2026-07-16T110000-consumeLive01.log';
  const filePath = path.join(logsDir, fileName);
  const nowMs = new Date(2026, 6, 16, 12, 0, 0).getTime();

  try {
    await fs.mkdir(logsDir, { recursive: true });
    await writeLedger(ledgerPath, []);
    await fs.writeFile(filePath, makeLog('gpt-5.6-sol', 5, 1), 'utf8');

    const engine = new TokenPulseEngine({
      installDir: root,
      cacheDir: path.join(root, 'cache'),
      logsDirs: [logsDir],
      ledgerPaths: [ledgerPath],
      awaitInitialReconcile: true,
      reconcileIntervalMs: 60 * 60 * 1000,
      stabilityDelayMs: 1,
      waitForStability: async () => {},
      watchFactory: inertWatchFactory,
      now: () => nowMs,
    });

    try {
      await engine.start();
      await engine.reconcile();
      assert.equal(engine.getSnapshot().ledgerView.periods.ledgerCoverage.totalTokens, 0);
      assert.equal(engine.getSnapshot().unledgeredView.periods.ledgerCoverage.totalTokens, 6);
      assert.equal(engine.liveEntries.size, 1);

      const stats = await fs.stat(filePath);
      await writeLedger(
        ledgerPath,
        [
          makeLedgerEntry({
            logsDir,
            fileName,
            stats,
            model: 'gpt-5.6-sol',
            timestampMs: new Date(2026, 6, 16, 11, 0, 0).getTime(),
            input: 5,
            output: 1,
          }),
        ],
        '2026-07-16T02:00:00.000Z'
      );
      await fs.rm(filePath);

      const reconciled = await engine.reconcile();
      assert.equal(reconciled.ledgerView.periods.ledgerCoverage.totalTokens, 6);
      assert.equal(reconciled.unledgeredView.periods.ledgerCoverage.totalTokens, 0);
      assert.equal(reconciled.periods.ledgerCoverage.totalTokens, 6);
      assert.equal(engine.liveEntries.size, 0, 'formal ledger must consume the matching live entry');
      assert.equal(engine.baselineFingerprints.size, 1, 'fingerprint remains stable after source deletion');
    } finally {
      await engine.stop();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
