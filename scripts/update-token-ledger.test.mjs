import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createTokenLedgerMaintenanceCore,
  withTokenLedgerMaintenanceLock,
} from './lib/token-ledger-maintenance-core.mjs';
import {
  buildSafeLogErrorEntry,
  buildProductionMaintenanceCandidate,
  commitLedgerProjectionPairWithRollback,
  parseProductionLogSnapshot,
} from './update-token-ledger.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'update-token-ledger.mjs');
const wrapperPath = path.join(__dirname, 'update-token-ledger.ps1');

const makeLogText = (model, totalTokens) => `
=== REQUEST BODY ===
{"model":"${model}"}
=== API REQUEST 1 ===
{"model":"${model}"}
=== API RESPONSE 1 ===
{"model":"${model}","usage":{"input_tokens":${totalTokens - 2},"output_tokens":2,"total_tokens":${totalTokens}}}
`;

const setFileAgeMinutes = async (filePath, minutesAgo) => {
  const date = new Date(Date.now() - minutesAgo * 60_000);
  await fs.utimes(filePath, date, date);
};

const runLedgerProcess = (installDir, extraArgs = []) =>
  spawnSync(
    process.execPath,
    [
      scriptPath,
      '--install-dir',
      installDir,
      '--custom-ui-dir',
      path.join(installDir, 'custom-ui'),
      ...extraArgs,
    ],
    {
      cwd: path.dirname(__dirname),
      encoding: 'utf8',
    }
  );

const runLedger = (installDir, extraArgs = []) => {
  const result = runLedgerProcess(installDir, ['--dry-run', ...extraArgs]);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

const runLedgerWrite = (installDir, extraArgs = []) => {
  const result = runLedgerProcess(installDir, extraArgs);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

const readProjection = async (installDir) =>
  JSON.parse(await fs.readFile(path.join(installDir, 'static', 'token-ledger.json'), 'utf8'));

const pathExistsForTest = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const availableBytesAt = async (targetPath) => {
  const stats = await fs.statfs(targetPath);
  return Number(stats.bsize) * Number(stats.bavail ?? stats.bfree);
};

const maintenanceTokenUsage = (total, status = 'available') => ({
  input: status === 'available' ? Math.max(0, total - 2) : 0,
  output: status === 'available' ? Math.min(2, total) : 0,
  cached: 0,
  reasoning: 0,
  total: status === 'available' ? total : 0,
  status,
});

const maintenanceSourceKey = (logsDir, fileName) =>
  `${path.normalize(path.resolve(logsDir))}::${fileName}`;

const maintenanceEntry = ({
  logsDir,
  fileName,
  stats,
  total,
  detailStatus = 'ready',
  tokenStatus = 'available',
}) => ({
  fileName,
  fileType: 'responses',
  timestampMs: Math.floor(stats.mtimeMs),
  requestId: fileName.match(/-([A-Za-z0-9_-]+)\.log$/)?.[1] ?? null,
  sourceDir: path.normalize(path.resolve(logsDir)),
  sourceKey: maintenanceSourceKey(logsDir, fileName),
  detailStatus,
  configuredModel: detailStatus === 'ready' ? 'gpt-test' : null,
  actualModel: detailStatus === 'ready' ? 'gpt-test' : null,
  tokenUsage: maintenanceTokenUsage(total, tokenStatus),
  fileSize: stats.size,
  lastModifiedMs: Math.floor(stats.mtimeMs),
});

const maintenanceLedger = ({ entries, fingerprints, generationId = 'fixture-generation' }) => ({
  version: 1,
  generationId,
  generatedAt: '2026-07-17T00:00:00.000Z',
  source: {
    scannedFiles: entries.length,
    updatedFiles: 0,
    skippedFiles: entries.length,
    errorFiles: 0,
  },
  coverage: {
    totalEntries: entries.length,
    parsedEntries: entries.filter((entry) => entry.detailStatus !== 'error').length,
    knownEntries: entries.filter((entry) => entry.tokenUsage.status === 'available').length,
    unreportedEntries: entries.filter((entry) => entry.tokenUsage.status === 'unreported').length,
    coverageRate: 0,
    parsedRate: 0,
    earliestTimestampMs: null,
    latestTimestampMs: null,
  },
  entries,
  state: { fileFingerprints: fingerprints },
});

const maintenanceProjection = (ledger) => {
  const { state: _state, ...projection } = ledger;
  return projection;
};

const fingerprintForTest = (stats) => `${stats.size}:${Math.floor(stats.mtimeMs)}`;

const assertSafeMaintenancePayload = (value, forbiddenValues) => {
  const serialized = JSON.stringify(value);
  forbiddenValues.forEach((forbidden) => {
    assert.equal(
      serialized.toLowerCase().includes(String(forbidden).toLowerCase()),
      false,
      `maintenance payload must not expose ${forbidden}`
    );
  });
};

const waitForChildLine = (child, expectedLine) =>
  new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(
      () => reject(new Error(`Timed out waiting for ${expectedLine}`)),
      5_000
    );
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.split(/\r?\n/).includes(expectedLine)) {
        clearTimeout(timeout);
        resolve({ stdout, stderr });
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('exit', (code) => {
      if (!stdout.split(/\r?\n/).includes(expectedLine)) {
        clearTimeout(timeout);
        reject(new Error(`Child exited ${code}: ${stderr || stdout}`));
      }
    });
  });

const maintenanceTestBase = 'D:\\Tools\\Cache\\CPA-Token-Pulse\\tests';
await fs.mkdir(maintenanceTestBase, { recursive: true });

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-token-ledger-'));

try {
  const maintenanceRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-preview-')
  );
  try {
    const maintenanceLogsDir = path.join(maintenanceRoot, 'logs');
    const maintenanceAuthLogsDir = path.join(maintenanceRoot, 'auths', 'logs');
    const maintenanceLedgerPath = path.join(
      maintenanceRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const maintenanceProjectionPath = path.join(maintenanceRoot, 'static', 'token-ledger.json');
    await fs.mkdir(maintenanceLogsDir, { recursive: true });
    await fs.mkdir(maintenanceAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(maintenanceLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(maintenanceProjectionPath), { recursive: true });

    const formalName = 'v1-responses-2026-07-17T000000-formal001.log';
    const pendingName = 'v1-responses-2026-07-17T000100-pending01.log';
    const unreportedName = 'v1-responses-2026-07-17T000200-unreport1.log';
    const formalPath = path.join(maintenanceLogsDir, formalName);
    const pendingPath = path.join(maintenanceAuthLogsDir, pendingName);
    const unreportedPath = path.join(maintenanceLogsDir, unreportedName);
    await fs.writeFile(formalPath, makeLogText('gpt-test-formal', 10), 'utf8');
    await fs.writeFile(pendingPath, makeLogText('gpt-test-pending', 20), 'utf8');
    await fs.writeFile(unreportedPath, makeLogText('gpt-test-unreported', 30), 'utf8');
    await Promise.all(
      [formalPath, pendingPath, unreportedPath].map((filePath) => setFileAgeMinutes(filePath, 10))
    );

    const formalStats = await fs.stat(formalPath);
    const pendingStats = await fs.stat(pendingPath);
    const unreportedStats = await fs.stat(unreportedPath);
    const formalEntry = maintenanceEntry({
      logsDir: maintenanceLogsDir,
      fileName: formalName,
      stats: formalStats,
      total: 10,
    });
    const pendingEntry = maintenanceEntry({
      logsDir: maintenanceAuthLogsDir,
      fileName: pendingName,
      stats: pendingStats,
      total: 20,
    });
    const unreportedEntry = maintenanceEntry({
      logsDir: maintenanceLogsDir,
      fileName: unreportedName,
      stats: unreportedStats,
      total: 0,
      tokenStatus: 'unreported',
    });
    const formalLedger = maintenanceLedger({
      entries: [formalEntry],
      fingerprints: {
        [formalEntry.sourceKey]: fingerprintForTest(formalStats),
      },
      generationId: 'formal-generation',
    });
    const candidateLedger = maintenanceLedger({
      entries: [formalEntry, pendingEntry, unreportedEntry],
      fingerprints: {
        [formalEntry.sourceKey]: fingerprintForTest(formalStats),
        [pendingEntry.sourceKey]: fingerprintForTest(pendingStats),
        [unreportedEntry.sourceKey]: fingerprintForTest(unreportedStats),
      },
      generationId: 'candidate-generation',
    });
    const formalText = `${JSON.stringify(formalLedger, null, 2)}\n`;
    const projectionSentinel = '{"sentinel":true}\n';
    await fs.writeFile(maintenanceLedgerPath, formalText, 'utf8');
    await fs.writeFile(maintenanceProjectionPath, projectionSentinel, 'utf8');

    let candidateBuilds = 0;
    const core = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: maintenanceLedgerPath,
        projectionPath: maintenanceProjectionPath,
        lockPath: `${maintenanceLedgerPath}.maintenance.lock`,
        allowedLogRoots: [maintenanceLogsDir, maintenanceAuthLogsDir],
        minimumActiveWindowMinutes: 5,
        previewTtlMs: 60_000,
      },
      buildCandidate: async () => {
        candidateBuilds += 1;
        return {
          ledger: candidateLedger,
          projection: maintenanceProjection(candidateLedger),
          pendingEntries: [pendingEntry],
          scan: { scannedFiles: 3, updatedFiles: 2, skippedFiles: 1, errorFiles: 0 },
        };
      },
      commitCandidate: async (candidate) => {
        await fs.writeFile(
          maintenanceLedgerPath,
          `${JSON.stringify(candidate.ledger, null, 2)}\n`,
          'utf8'
        );
        await fs.writeFile(
          maintenanceProjectionPath,
          `${JSON.stringify(candidate.projection, null, 2)}\n`,
          'utf8'
        );
      },
      now: () => Date.now(),
    });

    const preview = await core.preview({ activeWindowMinutes: 0 });
    assert.equal(preview.status, 'preview');
    assert.equal(preview.safety.activeWindowMinutes, 5);
    assert.deepEqual(preview.ledger.formal, {
      requests: 1,
      input: 8,
      output: 2,
      cached: 0,
      reasoning: 0,
      total: 10,
    });
    assert.deepEqual(preview.ledger.pending, {
      requests: 1,
      input: 18,
      output: 2,
      cached: 0,
      reasoning: 0,
      total: 20,
    });
    assert.deepEqual(preview.ledger.current, {
      requests: 2,
      input: 26,
      output: 4,
      cached: 0,
      reasoning: 0,
      total: 30,
    });
    assert.equal(preview.prune.eligibleFiles, 2);
    assert.equal(preview.prune.keptNotReadyAvailableFiles, 1);
    assert.deepEqual(preview.ledger.entryCounts, { formal: 1, candidate: 3 });
    assert.equal(preview.ledgerEntries, 3);
    assert.equal(preview.totalTokens, 30);
    assert.equal(preview.ledgerGeneratedAt, candidateLedger.generatedAt);
    assert.match(preview.previewId, /^v2:\d+:\d+:[a-f0-9]{64}$/);
    assert.equal(await fs.readFile(maintenanceLedgerPath, 'utf8'), formalText);
    assert.equal(await fs.readFile(maintenanceProjectionPath, 'utf8'), projectionSentinel);
    assert.equal(await pathExistsForTest(formalPath), true);
    assert.equal(await pathExistsForTest(pendingPath), true);
    assert.equal(await pathExistsForTest(unreportedPath), true);
    assertSafeMaintenancePayload(preview, [
      maintenanceRoot,
      formalName,
      pendingName,
      unreportedName,
      formalEntry.sourceKey,
    ]);

    await fs.rm(pendingPath);

    const execute = await core.execute({
      activeWindowMinutes: 0,
      previewId: preview.previewId,
    });
    assert.equal(execute.status, 'completed');
    assert.equal(execute.mode, 'execute');
    assert.equal(execute.prune.deletedFiles, 1);
    assert.equal(execute.prune.failedDeletes, 0);
    assert.equal(execute.prune.keptNotReadyAvailableFiles, 1);
    assert.equal(execute.ledger.unchangedByPrune, true);
    assert.deepEqual(execute.ledger.beforePrune, execute.ledger.afterPrune);
    assert.deepEqual(execute.ledger.beforePrune, preview.ledger.current);
    assert.deepEqual(execute.ledger.entryCounts, { formal: 1, candidate: 3, committed: 3 });
    assert.equal(execute.ledgerEntries, 3);
    assert.equal(execute.totalTokens, 30);
    assert.equal(execute.ledgerGeneratedAt, candidateLedger.generatedAt);
    assert.equal(candidateBuilds, 1, 'execute must reuse the preview candidate in the same session');
    assert.equal(await pathExistsForTest(formalPath), false);
    assert.equal(await pathExistsForTest(pendingPath), false);
    assert.equal(await pathExistsForTest(unreportedPath), true);
    assert.deepEqual(JSON.parse(await fs.readFile(maintenanceLedgerPath, 'utf8')), candidateLedger);
    assert.deepEqual(
      JSON.parse(await fs.readFile(maintenanceProjectionPath, 'utf8')),
      maintenanceProjection(candidateLedger)
    );
    assertSafeMaintenancePayload(execute, [
      maintenanceRoot,
      formalName,
      pendingName,
      unreportedName,
      pendingEntry.sourceKey,
    ]);
  } finally {
    await fs.rm(maintenanceRoot, { recursive: true, force: true });
  }

  const slowPreviewRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-slow-preview-')
  );
  try {
    const slowLogsDir = path.join(slowPreviewRoot, 'logs');
    const slowAuthLogsDir = path.join(slowPreviewRoot, 'auths', 'logs');
    const slowLedgerPath = path.join(
      slowPreviewRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const slowProjectionPath = path.join(slowPreviewRoot, 'static', 'token-ledger.json');
    await fs.mkdir(slowLogsDir, { recursive: true });
    await fs.mkdir(slowAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(slowLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(slowProjectionPath), { recursive: true });

    const slowFormalLedger = maintenanceLedger({
      entries: [],
      fingerprints: {},
      generationId: 'slow-formal',
    });
    await fs.writeFile(slowLedgerPath, `${JSON.stringify(slowFormalLedger, null, 2)}\n`, 'utf8');
    await fs.writeFile(
      slowProjectionPath,
      `${JSON.stringify(maintenanceProjection(slowFormalLedger), null, 2)}\n`,
      'utf8'
    );

    let slowClockMs = 0;
    let slowBuildCount = 0;
    const slowFs = new Proxy(fs, {
      get(target, property) {
        if (property === 'readdir') {
          return async (...args) => {
            const result = await target.readdir(...args);
            if (slowBuildCount > 0) slowClockMs += 15_000;
            return result;
          };
        }
        return target[property];
      },
    });
    const slowCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: slowLedgerPath,
        projectionPath: slowProjectionPath,
        lockPath: `${slowLedgerPath}.maintenance.lock`,
        allowedLogRoots: [slowLogsDir, slowAuthLogsDir],
        minimumActiveWindowMinutes: 5,
        previewTtlMs: 60_000,
      },
      fsAdapter: slowFs,
      buildCandidate: async ({ snapshotTimeMs }) => {
        if (slowBuildCount === 0) slowClockMs += 90_000;
        slowBuildCount += 1;
        const ledger = {
          ...maintenanceLedger({
            entries: [],
            fingerprints: {},
            generationId: `slow-candidate-${slowBuildCount}`,
          }),
          generatedAt: new Date(snapshotTimeMs).toISOString(),
        };
        return {
          ledger,
          projection: maintenanceProjection(ledger),
          pendingEntries: [],
          scan: { scannedFiles: 0, updatedFiles: 0, skippedFiles: 0, errorFiles: 0 },
        };
      },
      commitCandidate: async (candidate) => {
        await fs.writeFile(slowLedgerPath, `${JSON.stringify(candidate.ledger, null, 2)}\n`, 'utf8');
        await fs.writeFile(
          slowProjectionPath,
          `${JSON.stringify(candidate.projection, null, 2)}\n`,
          'utf8'
        );
      },
      now: () => slowClockMs,
    });

    const slowPreview = await slowCore.preview();
    assert.equal(Date.parse(slowPreview.generatedAt), slowClockMs);
    assert.equal(Date.parse(slowPreview.expiresAt) - Date.parse(slowPreview.generatedAt), 60_000);
    assert.equal((await slowCore.execute({ previewId: slowPreview.previewId })).status, 'completed');
  } finally {
    await fs.rm(slowPreviewRoot, { recursive: true, force: true });
  }

  const stalePreviewRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-stale-')
  );
  try {
    const staleLogsDir = path.join(stalePreviewRoot, 'logs');
    const staleAuthLogsDir = path.join(stalePreviewRoot, 'auths', 'logs');
    const staleLedgerPath = path.join(
      stalePreviewRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const staleProjectionPath = path.join(stalePreviewRoot, 'static', 'token-ledger.json');
    await fs.mkdir(staleLogsDir, { recursive: true });
    await fs.mkdir(staleAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(staleLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(staleProjectionPath), { recursive: true });

    const firstName = 'v1-responses-2026-07-17T001000-stale001.log';
    const firstPath = path.join(staleLogsDir, firstName);
    await fs.writeFile(firstPath, makeLogText('gpt-test-stale-a', 40), 'utf8');
    await setFileAgeMinutes(firstPath, 10);
    const firstStats = await fs.stat(firstPath);
    const firstEntry = maintenanceEntry({
      logsDir: staleLogsDir,
      fileName: firstName,
      stats: firstStats,
      total: 40,
    });
    const formalLedger = maintenanceLedger({
      entries: [firstEntry],
      fingerprints: { [firstEntry.sourceKey]: fingerprintForTest(firstStats) },
      generationId: 'stale-formal-generation',
    });
    await fs.writeFile(staleLedgerPath, `${JSON.stringify(formalLedger, null, 2)}\n`, 'utf8');
    await fs.writeFile(
      staleProjectionPath,
      `${JSON.stringify(maintenanceProjection(formalLedger), null, 2)}\n`,
      'utf8'
    );

    let candidateLedger = maintenanceLedger({
      entries: [firstEntry],
      fingerprints: { [firstEntry.sourceKey]: fingerprintForTest(firstStats) },
      generationId: 'stale-candidate-a',
    });
    const previewCandidateLedger = candidateLedger;
    let pendingEntries = [];
    const staleCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: staleLedgerPath,
        projectionPath: staleProjectionPath,
        lockPath: `${staleLedgerPath}.maintenance.lock`,
        allowedLogRoots: [staleLogsDir, staleAuthLogsDir],
        minimumActiveWindowMinutes: 5,
        previewTtlMs: 60_000,
      },
      buildCandidate: async () => ({
        ledger: candidateLedger,
        projection: maintenanceProjection(candidateLedger),
        pendingEntries,
        scan: { scannedFiles: candidateLedger.entries.length },
      }),
      commitCandidate: async (candidate) => {
        await fs.writeFile(staleLedgerPath, `${JSON.stringify(candidate.ledger, null, 2)}\n`, 'utf8');
        await fs.writeFile(
          staleProjectionPath,
          `${JSON.stringify(candidate.projection, null, 2)}\n`,
          'utf8'
        );
      },
    });
    const stalePreview = await staleCore.preview();

    const secondName = 'v1-responses-2026-07-17T001100-stale002.log';
    const secondPath = path.join(staleAuthLogsDir, secondName);
    await fs.writeFile(secondPath, makeLogText('gpt-test-stale-b', 50), 'utf8');
    await setFileAgeMinutes(secondPath, 10);
    const secondStats = await fs.stat(secondPath);
    const secondEntry = maintenanceEntry({
      logsDir: staleAuthLogsDir,
      fileName: secondName,
      stats: secondStats,
      total: 50,
    });
    candidateLedger = maintenanceLedger({
      entries: [firstEntry, secondEntry],
      fingerprints: {
        [firstEntry.sourceKey]: fingerprintForTest(firstStats),
        [secondEntry.sourceKey]: fingerprintForTest(secondStats),
      },
      generationId: 'stale-candidate-b',
    });
    pendingEntries = [secondEntry];

    const staleExecute = await staleCore.execute({ previewId: stalePreview.previewId });
    assert.equal(staleExecute.status, 'completed');
    assert.equal(await pathExistsForTest(firstPath), false);
    assert.equal(await pathExistsForTest(secondPath), true);
    assert.deepEqual(JSON.parse(await fs.readFile(staleLedgerPath, 'utf8')), previewCandidateLedger);
  } finally {
    await fs.rm(stalePreviewRoot, { recursive: true, force: true });
  }

  const completeDigestRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-complete-digest-')
  );
  try {
    const digestLogsDir = path.join(completeDigestRoot, 'logs');
    const digestAuthLogsDir = path.join(completeDigestRoot, 'auths', 'logs');
    const digestLedgerPath = path.join(
      completeDigestRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const digestProjectionPath = path.join(completeDigestRoot, 'static', 'token-ledger.json');
    await fs.mkdir(digestLogsDir, { recursive: true });
    await fs.mkdir(digestAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(digestLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(digestProjectionPath), { recursive: true });

    const incompleteName = 'v1-responses-2026-07-17T001500-digest001.log';
    const incompletePath = path.join(digestLogsDir, incompleteName);
    await fs.writeFile(incompletePath, makeLogText('gpt-test-digest', 41), 'utf8');
    await setFileAgeMinutes(incompletePath, 10);
    const incompleteStats = await fs.stat(incompletePath);
    const baseIncompleteEntry = maintenanceEntry({
      logsDir: digestLogsDir,
      fileName: incompleteName,
      stats: incompleteStats,
      total: 0,
      detailStatus: 'missing-fields',
      tokenStatus: 'unreported',
    });
    const formalLedger = maintenanceLedger({
      entries: [],
      fingerprints: {},
      generationId: 'complete-digest-formal',
    });
    await fs.writeFile(digestLedgerPath, `${JSON.stringify(formalLedger, null, 2)}\n`, 'utf8');
    await fs.writeFile(
      digestProjectionPath,
      `${JSON.stringify(maintenanceProjection(formalLedger), null, 2)}\n`,
      'utf8'
    );

    let incompleteEntry = baseIncompleteEntry;
    let projectionMarker = 'projection-a';
    let scanErrorFiles = 0;
    const buildDigestCandidate = async () => {
      const ledger = maintenanceLedger({
        entries: [incompleteEntry],
        fingerprints: { [incompleteEntry.sourceKey]: fingerprintForTest(incompleteStats) },
        generationId: 'complete-digest-candidate',
      });
      const projection = {
        ...maintenanceProjection(ledger),
        source: { ...maintenanceProjection(ledger).source, marker: projectionMarker },
      };
      return {
        ledger,
        projection,
        pendingEntries: [],
        scan: { scannedFiles: 1, updatedFiles: 0, skippedFiles: 1, errorFiles: scanErrorFiles },
      };
    };
    let committed = false;
    const createDigestCore = () => createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: digestLedgerPath,
        projectionPath: digestProjectionPath,
        lockPath: `${digestLedgerPath}.maintenance.lock`,
        allowedLogRoots: [digestLogsDir, digestAuthLogsDir],
        minimumActiveWindowMinutes: 5,
      },
      buildCandidate: buildDigestCandidate,
      commitCandidate: async () => {
        committed = true;
      },
    });

    const entryPreview = await createDigestCore().preview();
    incompleteEntry = { ...incompleteEntry, configuredModel: 'gpt-test-digest-mutated' };
    await assert.rejects(
      createDigestCore().execute({ previewId: entryPreview.previewId }),
      (error) => error?.code === 'TOKEN_LEDGER_PREVIEW_STALE'
    );

    incompleteEntry = baseIncompleteEntry;
    const projectionPreview = await createDigestCore().preview();
    projectionMarker = 'projection-b';
    await assert.rejects(
      createDigestCore().execute({ previewId: projectionPreview.previewId }),
      (error) => error?.code === 'TOKEN_LEDGER_PREVIEW_STALE'
    );

    projectionMarker = 'projection-a';
    const scanPreview = await createDigestCore().preview();
    scanErrorFiles = 1;
    await assert.rejects(
      createDigestCore().execute({ previewId: scanPreview.previewId }),
      (error) => error?.code === 'TOKEN_LEDGER_PREVIEW_STALE'
    );

    scanErrorFiles = 0;
    const keptPreview = await createDigestCore().preview();
    const unrecordedPath = path.join(
      digestAuthLogsDir,
      'v1-responses-2026-07-17T001600-digest002.log'
    );
    await fs.writeFile(unrecordedPath, makeLogText('gpt-test-unrecorded-digest', 43), 'utf8');
    await setFileAgeMinutes(unrecordedPath, 10);
    await assert.rejects(
      createDigestCore().execute({ previewId: keptPreview.previewId }),
      (error) => error?.code === 'TOKEN_LEDGER_PREVIEW_STALE'
    );
    assert.equal(committed, false, 'complete preview digest must stop before commit');

    let volatileBuildCount = 0;
    const volatileCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: digestLedgerPath,
        projectionPath: digestProjectionPath,
        lockPath: `${digestLedgerPath}.maintenance.lock`,
        allowedLogRoots: [digestLogsDir, digestAuthLogsDir],
        minimumActiveWindowMinutes: 5,
      },
      buildCandidate: async () => {
        volatileBuildCount += 1;
        const ledger = maintenanceLedger({
          entries: [baseIncompleteEntry],
          fingerprints: {
            [baseIncompleteEntry.sourceKey]: fingerprintForTest(incompleteStats),
          },
          generationId: `volatile-generation-${volatileBuildCount}`,
        });
        ledger.generatedAt = new Date(volatileBuildCount * 1_000).toISOString();
        return {
          ledger,
          projection: maintenanceProjection(ledger),
          pendingEntries: [],
          scan: { scannedFiles: 1, updatedFiles: 0, skippedFiles: 1, errorFiles: 0 },
        };
      },
      commitCandidate: async (candidate) => {
        await fs.writeFile(
          digestLedgerPath,
          `${JSON.stringify(candidate.ledger, null, 2)}\n`,
          'utf8'
        );
        await fs.writeFile(
          digestProjectionPath,
          `${JSON.stringify(candidate.projection, null, 2)}\n`,
          'utf8'
        );
        const arrivedDuringCommitPath = path.join(
          digestAuthLogsDir,
          'v1-responses-2026-07-17T001700-digest003.log'
        );
        await fs.writeFile(
          arrivedDuringCommitPath,
          makeLogText('gpt-test-arrived-during-commit', 47),
          'utf8'
        );
        await setFileAgeMinutes(arrivedDuringCommitPath, 10);
      },
    });
    const volatilePreview = await volatileCore.preview();
    const volatileExecute = await volatileCore.execute({ previewId: volatilePreview.previewId });
    assert.equal(volatileExecute.status, 'completed');
    assert.equal(volatileBuildCount, 1);
  } finally {
    await fs.rm(completeDigestRoot, { recursive: true, force: true });
  }

  const floorRegressionRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-floor-')
  );
  try {
    const floorLogsDir = path.join(floorRegressionRoot, 'logs');
    const floorAuthLogsDir = path.join(floorRegressionRoot, 'auths', 'logs');
    const floorLedgerPath = path.join(
      floorRegressionRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const floorProjectionPath = path.join(floorRegressionRoot, 'static', 'token-ledger.json');
    await fs.mkdir(floorLogsDir, { recursive: true });
    await fs.mkdir(floorAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(floorLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(floorProjectionPath), { recursive: true });

    const formalName = 'v1-responses-2026-07-17T002000-floor001.log';
    const pendingName = 'v1-responses-2026-07-17T002100-floor002.log';
    const formalPath = path.join(floorLogsDir, formalName);
    const pendingPath = path.join(floorAuthLogsDir, pendingName);
    await fs.writeFile(formalPath, makeLogText('gpt-test-floor-formal', 60), 'utf8');
    await fs.writeFile(pendingPath, makeLogText('gpt-test-floor-pending', 70), 'utf8');
    await Promise.all([formalPath, pendingPath].map((filePath) => setFileAgeMinutes(filePath, 10)));
    const formalStats = await fs.stat(formalPath);
    const pendingStats = await fs.stat(pendingPath);
    const formalEntry = maintenanceEntry({
      logsDir: floorLogsDir,
      fileName: formalName,
      stats: formalStats,
      total: 60,
    });
    const pendingEntry = maintenanceEntry({
      logsDir: floorAuthLogsDir,
      fileName: pendingName,
      stats: pendingStats,
      total: 70,
    });
    const formalLedger = maintenanceLedger({
      entries: [formalEntry],
      fingerprints: { [formalEntry.sourceKey]: fingerprintForTest(formalStats) },
      generationId: 'floor-formal-generation',
    });
    const shiftedPendingEntry = {
      ...pendingEntry,
      tokenUsage: {
        input: 0,
        output: 70,
        cached: 0,
        reasoning: 0,
        total: 70,
        status: 'available',
      },
    };
    const regressingCandidate = maintenanceLedger({
      entries: [formalEntry, shiftedPendingEntry],
      fingerprints: {
        [formalEntry.sourceKey]: fingerprintForTest(formalStats),
        [pendingEntry.sourceKey]: fingerprintForTest(pendingStats),
      },
      generationId: 'floor-regressing-candidate',
    });
    await fs.writeFile(floorLedgerPath, `${JSON.stringify(formalLedger, null, 2)}\n`, 'utf8');
    await fs.writeFile(
      floorProjectionPath,
      `${JSON.stringify(maintenanceProjection(formalLedger), null, 2)}\n`,
      'utf8'
    );
    let committed = false;
    const floorCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: floorLedgerPath,
        projectionPath: floorProjectionPath,
        lockPath: `${floorLedgerPath}.maintenance.lock`,
        allowedLogRoots: [floorLogsDir, floorAuthLogsDir],
        minimumActiveWindowMinutes: 5,
      },
      buildCandidate: async () => ({
        ledger: regressingCandidate,
        projection: maintenanceProjection(regressingCandidate),
        pendingEntries: [pendingEntry],
        scan: { scannedFiles: 2, updatedFiles: 1, skippedFiles: 1, errorFiles: 0 },
      }),
      commitCandidate: async () => {
        committed = true;
      },
    });

    await assert.rejects(floorCore.preview(), (error) => error?.code === 'TOKEN_LEDGER_REGRESSION');
    assert.equal(committed, false);
    assert.equal(await pathExistsForTest(formalPath), true);
    assert.equal(await pathExistsForTest(pendingPath), true);
  } finally {
    await fs.rm(floorRegressionRoot, { recursive: true, force: true });
  }

  const availableMissingFieldsRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-available-missing-fields-')
  );
  try {
    const availableLogsDir = path.join(availableMissingFieldsRoot, 'logs');
    const availableAuthLogsDir = path.join(availableMissingFieldsRoot, 'auths', 'logs');
    const availableLedgerPath = path.join(
      availableMissingFieldsRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const availableProjectionPath = path.join(
      availableMissingFieldsRoot,
      'static',
      'token-ledger.json'
    );
    await fs.mkdir(availableLogsDir, { recursive: true });
    await fs.mkdir(availableAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(availableLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(availableProjectionPath), { recursive: true });

    const accountedName = 'v1-responses-2026-07-17T002300-accounted1.log';
    const replacementName = 'v1-responses-2026-07-17T002400-accounted2.log';
    const accountedPath = path.join(availableLogsDir, accountedName);
    const replacementPath = path.join(availableAuthLogsDir, replacementName);
    await fs.writeFile(accountedPath, makeLogText('gpt-test-accounted-missing', 111), 'utf8');
    await fs.writeFile(replacementPath, makeLogText('gpt-test-unreported-replacement', 0), 'utf8');
    await Promise.all(
      [accountedPath, replacementPath].map((filePath) => setFileAgeMinutes(filePath, 10))
    );
    const accountedStats = await fs.stat(accountedPath);
    const replacementStats = await fs.stat(replacementPath);
    const accountedEntry = maintenanceEntry({
      logsDir: availableLogsDir,
      fileName: accountedName,
      stats: accountedStats,
      total: 111,
      detailStatus: 'missing-fields',
      tokenStatus: 'available',
    });
    const replacementEntry = maintenanceEntry({
      logsDir: availableAuthLogsDir,
      fileName: replacementName,
      stats: replacementStats,
      total: 0,
      detailStatus: 'missing-fields',
      tokenStatus: 'unreported',
    });
    const formalLedger = maintenanceLedger({
      entries: [accountedEntry],
      fingerprints: { [accountedEntry.sourceKey]: fingerprintForTest(accountedStats) },
      generationId: 'available-missing-formal',
    });
    let candidateLedger = maintenanceLedger({
      entries: [accountedEntry],
      fingerprints: { [accountedEntry.sourceKey]: fingerprintForTest(accountedStats) },
      generationId: 'available-missing-candidate',
    });
    await fs.writeFile(availableLedgerPath, `${JSON.stringify(formalLedger)}\n`, 'utf8');
    await fs.writeFile(
      availableProjectionPath,
      `${JSON.stringify(maintenanceProjection(formalLedger))}\n`,
      'utf8'
    );
    let committed = false;
    const availableCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: availableLedgerPath,
        projectionPath: availableProjectionPath,
        lockPath: `${availableLedgerPath}.maintenance.lock`,
        allowedLogRoots: [availableLogsDir, availableAuthLogsDir],
        minimumActiveWindowMinutes: 5,
      },
      buildCandidate: async () => ({
        ledger: candidateLedger,
        projection: maintenanceProjection(candidateLedger),
        pendingEntries: [],
        scan: { scannedFiles: 2, updatedFiles: 0, skippedFiles: 2, errorFiles: 0 },
      }),
      commitCandidate: async () => {
        committed = true;
      },
    });
    const accountedPreview = await availableCore.preview();
    assert.equal(accountedPreview.ledger.projected.requests, 1);
    assert.equal(accountedPreview.totalTokens, 111);
    assert.equal(accountedPreview.prune.eligibleFiles, 0);
    assert.equal(accountedPreview.prune.keptNotReadyAvailableFiles, 1);

    candidateLedger = maintenanceLedger({
      entries: [replacementEntry],
      fingerprints: { [replacementEntry.sourceKey]: fingerprintForTest(replacementStats) },
      generationId: 'available-missing-regression',
    });
    await assert.rejects(
      availableCore.preview(),
      (error) => error?.code === 'TOKEN_LEDGER_REGRESSION'
    );
    assert.equal(committed, false);
    assert.equal(await pathExistsForTest(accountedPath), true);
    assert.equal(await pathExistsForTest(replacementPath), true);
  } finally {
    await fs.rm(availableMissingFieldsRoot, { recursive: true, force: true });
  }

  const externalFloorRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-external-floor-')
  );
  try {
    const externalFloorLogsDir = path.join(externalFloorRoot, 'logs');
    const externalFloorAuthLogsDir = path.join(externalFloorRoot, 'auths', 'logs');
    const externalFloorLedgerPath = path.join(
      externalFloorRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const externalFloorProjectionPath = path.join(externalFloorRoot, 'static', 'token-ledger.json');
    await fs.mkdir(externalFloorLogsDir, { recursive: true });
    await fs.mkdir(externalFloorAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(externalFloorLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(externalFloorProjectionPath), { recursive: true });

    const formalLedger = maintenanceLedger({
      entries: [],
      fingerprints: {},
      generationId: 'external-floor-formal',
    });
    const nonFinalizedName = 'v1-responses-2026-07-17T002500-external-floor.log';
    const nonFinalizedPath = path.join(externalFloorLogsDir, nonFinalizedName);
    await fs.writeFile(nonFinalizedPath, makeLogText('gpt-test-external-floor', 0), 'utf8');
    await setFileAgeMinutes(nonFinalizedPath, 10);
    const nonFinalizedStats = await fs.stat(nonFinalizedPath);
    const nonFinalizedEntry = maintenanceEntry({
      logsDir: externalFloorLogsDir,
      fileName: nonFinalizedName,
      stats: nonFinalizedStats,
      total: 0,
      detailStatus: 'missing-fields',
      tokenStatus: 'unreported',
    });
    const candidateLedger = maintenanceLedger({
      entries: [nonFinalizedEntry],
      fingerprints: {
        [nonFinalizedEntry.sourceKey]: fingerprintForTest(nonFinalizedStats),
      },
      generationId: 'external-floor-candidate',
    });
    await fs.writeFile(
      externalFloorLedgerPath,
      `${JSON.stringify(formalLedger, null, 2)}\n`,
      'utf8'
    );
    await fs.writeFile(
      externalFloorProjectionPath,
      `${JSON.stringify(maintenanceProjection(formalLedger), null, 2)}\n`,
      'utf8'
    );
    let committed = false;
    const externalFloorCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: externalFloorLedgerPath,
        projectionPath: externalFloorProjectionPath,
        lockPath: `${externalFloorLedgerPath}.maintenance.lock`,
        allowedLogRoots: [externalFloorLogsDir, externalFloorAuthLogsDir],
        minimumActiveWindowMinutes: 5,
      },
      buildCandidate: async () => ({
        ledger: candidateLedger,
        projection: maintenanceProjection(candidateLedger),
        pendingEntries: [],
        scan: { scannedFiles: 0, updatedFiles: 0, skippedFiles: 0, errorFiles: 0 },
      }),
      commitCandidate: async () => {
        committed = true;
      },
    });
    const preview = await externalFloorCore.preview();

    await assert.rejects(
      externalFloorCore.execute({
        previewId: preview.previewId,
        minimumTotals: { requests: 1, totalTokens: 0, ledgerEntries: 0 },
      }),
      (error) => error?.code === 'TOKEN_LEDGER_REGRESSION'
    );
    assert.equal(committed, false, 'external combined floor must be checked before commit');

    const ledgerEntryPreview = await externalFloorCore.preview();
    await assert.rejects(
      externalFloorCore.execute({
        previewId: ledgerEntryPreview.previewId,
        minimumTotals: { requests: 0, totalTokens: 0, ledgerEntries: 2 },
      }),
      (error) => error?.code === 'TOKEN_LEDGER_REGRESSION'
    );
    assert.equal(committed, false, 'external ledger-entry floor must be checked before commit');
  } finally {
    await fs.rm(externalFloorRoot, { recursive: true, force: true });
  }

  const unsafePathRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-unsafe-')
  );
  try {
    const unsafeLogsDir = path.join(unsafePathRoot, 'logs');
    const unsafeAuthLogsDir = path.join(unsafePathRoot, 'auths', 'logs');
    const externalDir = path.join(unsafePathRoot, 'external-target');
    const unsafeLedgerPath = path.join(
      unsafePathRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const unsafeProjectionPath = path.join(unsafePathRoot, 'static', 'token-ledger.json');
    await fs.mkdir(unsafeLogsDir, { recursive: true });
    await fs.mkdir(unsafeAuthLogsDir, { recursive: true });
    await fs.mkdir(externalDir, { recursive: true });
    await fs.mkdir(path.dirname(unsafeLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(unsafeProjectionPath), { recursive: true });

    const reparseName = 'v1-responses-2026-07-17T003000-reparse01.log';
    const reparsePath = path.join(unsafeLogsDir, reparseName);
    await fs.symlink(externalDir, reparsePath, 'junction');
    const externalStats = await fs.stat(externalDir);
    const externalEntry = maintenanceEntry({
      logsDir: externalDir,
      fileName: reparseName,
      stats: externalStats,
      total: 80,
    });
    const formalLedger = maintenanceLedger({
      entries: [],
      fingerprints: {},
      generationId: 'unsafe-formal-generation',
    });
    const unsafeCandidate = maintenanceLedger({
      entries: [externalEntry],
      fingerprints: { [externalEntry.sourceKey]: fingerprintForTest(externalStats) },
      generationId: 'unsafe-candidate-generation',
    });
    await fs.writeFile(unsafeLedgerPath, `${JSON.stringify(formalLedger, null, 2)}\n`, 'utf8');
    await fs.writeFile(
      unsafeProjectionPath,
      `${JSON.stringify(maintenanceProjection(formalLedger), null, 2)}\n`,
      'utf8'
    );
    const unsafeCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: unsafeLedgerPath,
        projectionPath: unsafeProjectionPath,
        lockPath: `${unsafeLedgerPath}.maintenance.lock`,
        allowedLogRoots: [unsafeLogsDir, unsafeAuthLogsDir],
        minimumActiveWindowMinutes: 5,
      },
      buildCandidate: async () => ({
        ledger: unsafeCandidate,
        projection: maintenanceProjection(unsafeCandidate),
        pendingEntries: [],
        scan: { scannedFiles: 1 },
      }),
      commitCandidate: async () => {
        throw new Error('unsafe preview must not commit');
      },
    });
    const unsafePreview = await unsafeCore.preview();
    assert.equal(unsafePreview.prune.eligibleFiles, 0);
    assert.equal(
      unsafePreview.prune.keptUnsafeFiles,
      2,
      'external ledger identity and matching-name reparse entry must both be counted unsafe'
    );
    assert.equal(await pathExistsForTest(reparsePath), true);
  } finally {
    await fs.rm(unsafePathRoot, { recursive: true, force: true });
  }

  const strictRootsRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-strict-roots-')
  );
  try {
    const strictLogsDir = path.join(strictRootsRoot, 'logs');
    const missingAuthLogsDir = path.join(strictRootsRoot, 'auths', 'logs');
    const strictLedgerPath = path.join(
      strictRootsRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const strictProjectionPath = path.join(strictRootsRoot, 'static', 'token-ledger.json');
    await fs.mkdir(strictLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(strictLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(strictProjectionPath), { recursive: true });
    const emptyLedger = maintenanceLedger({
      entries: [],
      fingerprints: {},
      generationId: 'strict-roots-empty',
    });
    await fs.writeFile(strictLedgerPath, `${JSON.stringify(emptyLedger)}\n`, 'utf8');
    await fs.writeFile(
      strictProjectionPath,
      `${JSON.stringify(maintenanceProjection(emptyLedger))}\n`,
      'utf8'
    );
    let buildCalled = false;
    const strictRootsCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: strictLedgerPath,
        projectionPath: strictProjectionPath,
        lockPath: `${strictLedgerPath}.maintenance.lock`,
        allowedLogRoots: [strictLogsDir, missingAuthLogsDir],
      },
      buildCandidate: async () => {
        buildCalled = true;
        return {
          ledger: emptyLedger,
          projection: maintenanceProjection(emptyLedger),
          pendingEntries: [],
          scan: {},
        };
      },
      commitCandidate: async () => {},
    });
    await assert.rejects(
      strictRootsCore.preview(),
      (error) => error?.code === 'TOKEN_LEDGER_SCHEMA_UNSUPPORTED'
    );
    assert.equal(buildCalled, false, 'both safe roots must be verified before candidate log reads');

    const actualAuthLogsDir = path.join(strictRootsRoot, 'actual-auth-logs');
    await fs.mkdir(actualAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(missingAuthLogsDir), { recursive: true });
    await fs.symlink(actualAuthLogsDir, missingAuthLogsDir, 'junction');
    await assert.rejects(
      strictRootsCore.preview(),
      (error) => error?.code === 'TOKEN_LEDGER_SCHEMA_UNSUPPORTED'
    );
    assert.equal(buildCalled, false, 'junction roots must be rejected before candidate log reads');
  } finally {
    await fs.rm(strictRootsRoot, { recursive: true, force: true });
  }

  const invalidSourceRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-invalid-source-')
  );
  try {
    const validLogsDir = path.join(invalidSourceRoot, 'logs');
    const validAuthLogsDir = path.join(invalidSourceRoot, 'auths', 'logs');
    const externalLogsDir = path.join(invalidSourceRoot, 'external');
    const invalidLedgerPath = path.join(
      invalidSourceRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const invalidProjectionPath = path.join(invalidSourceRoot, 'static', 'token-ledger.json');
    await fs.mkdir(validLogsDir, { recursive: true });
    await fs.mkdir(validAuthLogsDir, { recursive: true });
    await fs.mkdir(externalLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(invalidLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(invalidProjectionPath), { recursive: true });
    const externalName = 'v1-responses-2026-07-17T003500-invalid01.log';
    const externalPath = path.join(externalLogsDir, externalName);
    await fs.writeFile(externalPath, makeLogText('gpt-test-invalid-source', 83), 'utf8');
    await setFileAgeMinutes(externalPath, 10);
    const externalStats = await fs.stat(externalPath);
    const externalEntry = maintenanceEntry({
      logsDir: externalLogsDir,
      fileName: externalName,
      stats: externalStats,
      total: 83,
    });
    const formalLedger = maintenanceLedger({
      entries: [],
      fingerprints: {},
      generationId: 'invalid-source-formal',
    });
    const candidateLedger = maintenanceLedger({
      entries: [externalEntry],
      fingerprints: { [externalEntry.sourceKey]: fingerprintForTest(externalStats) },
      generationId: 'invalid-source-candidate',
    });
    await fs.writeFile(invalidLedgerPath, `${JSON.stringify(formalLedger)}\n`, 'utf8');
    await fs.writeFile(
      invalidProjectionPath,
      `${JSON.stringify(maintenanceProjection(formalLedger))}\n`,
      'utf8'
    );
    let committed = false;
    const invalidSourceCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: invalidLedgerPath,
        projectionPath: invalidProjectionPath,
        lockPath: `${invalidLedgerPath}.maintenance.lock`,
        allowedLogRoots: [validLogsDir, validAuthLogsDir],
      },
      buildCandidate: async () => ({
        ledger: candidateLedger,
        projection: maintenanceProjection(candidateLedger),
        pendingEntries: [externalEntry],
        scan: { scannedFiles: 1, updatedFiles: 1, skippedFiles: 0, errorFiles: 0 },
      }),
      commitCandidate: async () => {
        committed = true;
      },
    });
    const invalidPreview = await invalidSourceCore.preview();
    assert.equal(invalidPreview.prune.invalidSourceEntries, 1);
    assert.equal(invalidPreview.safety.canExecute, false);
    await assert.rejects(
      invalidSourceCore.execute({ previewId: invalidPreview.previewId }),
      (error) => error?.code === 'TOKEN_LEDGER_SCHEMA_UNSUPPORTED'
    );
    assert.equal(committed, false, 'invalid source entries must stop before commit');
    assert.equal(await pathExistsForTest(externalPath), true);
  } finally {
    await fs.rm(invalidSourceRoot, { recursive: true, force: true });
  }

  const changedBetweenStatsRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-stat-race-')
  );
  try {
    const raceLogsDir = path.join(changedBetweenStatsRoot, 'logs');
    const raceAuthLogsDir = path.join(changedBetweenStatsRoot, 'auths', 'logs');
    const raceLedgerPath = path.join(
      changedBetweenStatsRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const raceProjectionPath = path.join(changedBetweenStatsRoot, 'static', 'token-ledger.json');
    await fs.mkdir(raceLogsDir, { recursive: true });
    await fs.mkdir(raceAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(raceLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(raceProjectionPath), { recursive: true });
    const raceName = 'v1-responses-2026-07-17T004000-statrace1.log';
    const racePath = path.join(raceLogsDir, raceName);
    await fs.writeFile(racePath, makeLogText('gpt-test-stat-race', 90), 'utf8');
    await setFileAgeMinutes(racePath, 10);
    const raceStats = await fs.stat(racePath);
    const raceEntry = maintenanceEntry({
      logsDir: raceLogsDir,
      fileName: raceName,
      stats: raceStats,
      total: 90,
    });
    const formalLedger = maintenanceLedger({
      entries: [raceEntry],
      fingerprints: { [raceEntry.sourceKey]: fingerprintForTest(raceStats) },
      generationId: 'race-formal-generation',
    });
    const candidateLedger = maintenanceLedger({
      entries: [raceEntry],
      fingerprints: { [raceEntry.sourceKey]: fingerprintForTest(raceStats) },
      generationId: 'race-candidate-generation',
    });
    await fs.writeFile(raceLedgerPath, `${JSON.stringify(formalLedger, null, 2)}\n`, 'utf8');
    await fs.writeFile(
      raceProjectionPath,
      `${JSON.stringify(maintenanceProjection(formalLedger), null, 2)}\n`,
      'utf8'
    );

    let armRace = false;
    const racingFs = {
      mkdir: (...args) => fs.mkdir(...args),
      open: (...args) => fs.open(...args),
      readFile: (...args) => fs.readFile(...args),
      writeFile: (...args) => fs.writeFile(...args),
      rename: (...args) => fs.rename(...args),
      rm: (...args) => fs.rm(...args),
      realpath: (...args) => fs.realpath(...args),
      readdir: (...args) => fs.readdir(...args),
      unlink: (...args) => fs.unlink(...args),
      lstat: async (targetPath) => {
        if (armRace && path.normalize(targetPath) === path.normalize(racePath)) {
          armRace = false;
          await fs.appendFile(racePath, 'changed-before-final-stat', 'utf8');
        }
        return fs.lstat(targetPath);
      },
    };
    const raceCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: raceLedgerPath,
        projectionPath: raceProjectionPath,
        lockPath: `${raceLedgerPath}.maintenance.lock`,
        allowedLogRoots: [raceLogsDir, raceAuthLogsDir],
        minimumActiveWindowMinutes: 5,
      },
      fsAdapter: racingFs,
      buildCandidate: async () => ({
        ledger: candidateLedger,
        projection: maintenanceProjection(candidateLedger),
        pendingEntries: [],
        scan: { scannedFiles: 1, skippedFiles: 1 },
      }),
      commitCandidate: async (candidate) => {
        await fs.writeFile(
          raceLedgerPath,
          `${JSON.stringify(candidate.ledger, null, 2)}\n`,
          'utf8'
        );
        await fs.writeFile(
          raceProjectionPath,
          `${JSON.stringify(candidate.projection, null, 2)}\n`,
          'utf8'
        );
        armRace = true;
      },
    });
    const racePreview = await raceCore.preview();
    const raceExecute = await raceCore.execute({ previewId: racePreview.previewId });
    assert.equal(raceExecute.prune.deletedFiles, 0);
    assert.equal(raceExecute.prune.keptChangedFiles, 1);
    assert.equal(await pathExistsForTest(racePath), true);
  } finally {
    await fs.rm(changedBetweenStatsRoot, { recursive: true, force: true });
  }

  const exactCutoffRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-exact-cutoff-')
  );
  try {
    const cutoffLogsDir = path.join(exactCutoffRoot, 'logs');
    const cutoffAuthLogsDir = path.join(exactCutoffRoot, 'auths', 'logs');
    const cutoffLedgerPath = path.join(
      exactCutoffRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const cutoffProjectionPath = path.join(exactCutoffRoot, 'static', 'token-ledger.json');
    await fs.mkdir(cutoffLogsDir, { recursive: true });
    await fs.mkdir(cutoffAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(cutoffLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(cutoffProjectionPath), { recursive: true });
    const cutoffName = 'v1-responses-2026-07-17T004400-cutoff01.log';
    const cutoffPath = path.join(cutoffLogsDir, cutoffName);
    await fs.writeFile(cutoffPath, makeLogText('gpt-test-cutoff', 89), 'utf8');
    const cutoffStats = await fs.stat(cutoffPath);
    const cutoffEntry = maintenanceEntry({
      logsDir: cutoffLogsDir,
      fileName: cutoffName,
      stats: cutoffStats,
      total: 89,
    });
    const cutoffLedger = maintenanceLedger({
      entries: [cutoffEntry],
      fingerprints: { [cutoffEntry.sourceKey]: fingerprintForTest(cutoffStats) },
      generationId: 'exact-cutoff-candidate',
    });
    await fs.writeFile(cutoffLedgerPath, `${JSON.stringify(cutoffLedger)}\n`, 'utf8');
    await fs.writeFile(
      cutoffProjectionPath,
      `${JSON.stringify(maintenanceProjection(cutoffLedger))}\n`,
      'utf8'
    );
    const cutoffCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: cutoffLedgerPath,
        projectionPath: cutoffProjectionPath,
        lockPath: `${cutoffLedgerPath}.maintenance.lock`,
        allowedLogRoots: [cutoffLogsDir, cutoffAuthLogsDir],
        minimumActiveWindowMinutes: 5,
      },
      buildCandidate: async () => ({
        ledger: cutoffLedger,
        projection: maintenanceProjection(cutoffLedger),
        pendingEntries: [],
        scan: { scannedFiles: 1, updatedFiles: 0, skippedFiles: 1, errorFiles: 0 },
      }),
      commitCandidate: async () => {},
      now: () => cutoffStats.mtimeMs + 5 * 60_000,
    });
    const cutoffPreview = await cutoffCore.preview();
    assert.equal(cutoffPreview.prune.eligibleFiles, 0);
    assert.equal(cutoffPreview.prune.keptActiveFiles, 1);
  } finally {
    await fs.rm(exactCutoffRoot, { recursive: true, force: true });
  }

  const commitDelayRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-commit-delay-')
  );
  try {
    const delayLogsDir = path.join(commitDelayRoot, 'logs');
    const delayAuthLogsDir = path.join(commitDelayRoot, 'auths', 'logs');
    const delayLedgerPath = path.join(
      commitDelayRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const delayProjectionPath = path.join(commitDelayRoot, 'static', 'token-ledger.json');
    await fs.mkdir(delayLogsDir, { recursive: true });
    await fs.mkdir(delayAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(delayLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(delayProjectionPath), { recursive: true });
    const delayName = 'v1-responses-2026-07-17T004430-delay001.log';
    const delayPath = path.join(delayLogsDir, delayName);
    await fs.writeFile(delayPath, makeLogText('gpt-test-delay', 90), 'utf8');
    const delayStats = await fs.stat(delayPath);
    const delayEntry = maintenanceEntry({
      logsDir: delayLogsDir,
      fileName: delayName,
      stats: delayStats,
      total: 90,
    });
    const delayLedger = maintenanceLedger({
      entries: [delayEntry],
      fingerprints: { [delayEntry.sourceKey]: fingerprintForTest(delayStats) },
      generationId: 'commit-delay-candidate',
    });
    await fs.writeFile(delayLedgerPath, `${JSON.stringify(delayLedger)}\n`, 'utf8');
    await fs.writeFile(
      delayProjectionPath,
      `${JSON.stringify(maintenanceProjection(delayLedger))}\n`,
      'utf8'
    );
    let maintenanceClockMs = Math.floor(delayStats.mtimeMs) + 4 * 60_000 + 59_000;
    const delayCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: delayLedgerPath,
        projectionPath: delayProjectionPath,
        lockPath: `${delayLedgerPath}.maintenance.lock`,
        allowedLogRoots: [delayLogsDir, delayAuthLogsDir],
        minimumActiveWindowMinutes: 5,
      },
      buildCandidate: async () => ({
        ledger: delayLedger,
        projection: maintenanceProjection(delayLedger),
        pendingEntries: [],
        scan: { scannedFiles: 1, updatedFiles: 0, skippedFiles: 1, errorFiles: 0 },
      }),
      commitCandidate: async (candidate) => {
        await fs.writeFile(delayLedgerPath, `${JSON.stringify(candidate.ledger)}\n`, 'utf8');
        await fs.writeFile(
          delayProjectionPath,
          `${JSON.stringify(candidate.projection)}\n`,
          'utf8'
        );
        maintenanceClockMs += 2_000;
      },
      now: () => maintenanceClockMs,
    });
    const delayPreview = await delayCore.preview();
    assert.equal(delayPreview.prune.keptActiveFiles, 1);
    const delayExecute = await delayCore.execute({ previewId: delayPreview.previewId });
    assert.equal(delayExecute.status, 'completed');
    assert.equal(delayExecute.prune.deletedFiles, 0);
    assert.equal(delayExecute.prune.keptActiveFiles, 1);
    assert.equal(await pathExistsForTest(delayPath), true);
  } finally {
    await fs.rm(commitDelayRoot, { recursive: true, force: true });
  }

  const productionParseRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-production-parse-')
  );
  try {
    const productionLogsDir = path.join(productionParseRoot, 'logs');
    await fs.mkdir(productionLogsDir, { recursive: true });
    const recentName = 'v1-responses-2026-07-17T004500-recent001.log';
    const recentPath = path.join(productionLogsDir, recentName);
    await fs.writeFile(recentPath, makeLogText('gpt-test-recent', 91), 'utf8');

    const recentWithoutEnd = await parseProductionLogSnapshot({
      filePath: recentPath,
      fileName: recentName,
      sourceDir: productionLogsDir,
      stable: false,
    });
    assert.equal(recentWithoutEnd.status, 'parsed');
    assert.equal(recentWithoutEnd.entry.detailStatus, 'missing-fields');
    assert.equal(recentWithoutEnd.entry.tokenUsage.status, 'unreported');

    const recentStableWithoutEnd = await parseProductionLogSnapshot({
      filePath: recentPath,
      fileName: recentName,
      sourceDir: productionLogsDir,
      stable: true,
    });
    assert.equal(recentStableWithoutEnd.status, 'parsed');
    assert.equal(recentStableWithoutEnd.entry.detailStatus, 'ready');
    assert.equal(recentStableWithoutEnd.entry.tokenUsage.status, 'available');

    await fs.appendFile(recentPath, '\n=== END API RESPONSE ===\n', 'utf8');
    const recentWithEnd = await parseProductionLogSnapshot({
      filePath: recentPath,
      fileName: recentName,
      sourceDir: productionLogsDir,
      stable: false,
    });
    assert.equal(recentWithEnd.status, 'parsed');
    assert.equal(recentWithEnd.entry.detailStatus, 'ready');
    assert.equal(recentWithEnd.entry.tokenUsage.status, 'available');

    await fs.writeFile(recentPath, makeLogText('gpt-test-aged', 93), 'utf8');
    await setFileAgeMinutes(recentPath, 10);
    const agedWithoutEnd = await parseProductionLogSnapshot({
      filePath: recentPath,
      fileName: recentName,
      sourceDir: productionLogsDir,
      stable: false,
    });
    assert.equal(agedWithoutEnd.status, 'parsed');
    assert.equal(agedWithoutEnd.entry.detailStatus, 'missing-fields');
    assert.equal(agedWithoutEnd.entry.tokenUsage.status, 'unreported');

    const agedStableWithoutEnd = await parseProductionLogSnapshot({
      filePath: recentPath,
      fileName: recentName,
      sourceDir: productionLogsDir,
      stable: true,
    });
    assert.equal(agedStableWithoutEnd.status, 'parsed');
    assert.equal(agedStableWithoutEnd.entry.detailStatus, 'ready');
    assert.equal(agedStableWithoutEnd.entry.tokenUsage.status, 'available');

    const largeName = 'v1-responses-2026-07-17T004520-large0001.log';
    const largePath = path.join(productionLogsDir, largeName);
    const largeText = [
      '=== REQUEST BODY ===',
      '{"model":"gpt-test-large","usage":{"input_tokens":999,"output_tokens":1,"total_tokens":1000}}',
      'h'.repeat(700 * 1024),
      '=== API RESPONSE 1 ===',
      't'.repeat(700 * 1024),
      '{"model":"gpt-test-large","usage":{"input_tokens":95,"output_tokens":2,"total_tokens":97}}',
      '=== END API RESPONSE ===',
    ].join('\n');
    await fs.writeFile(largePath, largeText, 'utf8');
    const largeSnapshot = await parseProductionLogSnapshot({
      filePath: largePath,
      fileName: largeName,
      sourceDir: productionLogsDir,
      stable: false,
    });
    assert.equal(largeSnapshot.status, 'parsed');
    assert.equal(largeSnapshot.entry.tokenUsage.status, 'available');
    assert.equal(largeSnapshot.entry.tokenUsage.total, 97);

    let lstatCalls = 0;
    const changingFs = {
      lstat: async (...args) => {
        lstatCalls += 1;
        if (lstatCalls === 2) await fs.appendFile(recentPath, 'changed-during-read', 'utf8');
        return fs.lstat(...args);
      },
      readFile: (...args) => fs.readFile(...args),
      open: (...args) => fs.open(...args),
    };
    const changedSnapshot = await parseProductionLogSnapshot({
      filePath: recentPath,
      fileName: recentName,
      sourceDir: productionLogsDir,
      stable: true,
      fsAdapter: changingFs,
    });
    assert.equal(changedSnapshot.status, 'changed');
  } finally {
    await fs.rm(productionParseRoot, { recursive: true, force: true });
  }

  const productionCandidateRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-production-candidate-')
  );
  try {
    const candidateLogsDir = path.join(productionCandidateRoot, 'logs');
    const candidateAuthLogsDir = path.join(productionCandidateRoot, 'auths', 'logs');
    await fs.mkdir(candidateLogsDir, { recursive: true });
    await fs.mkdir(candidateAuthLogsDir, { recursive: true });

    const stableName = 'v1-responses-2026-07-17T004530-stable001.log';
    const stablePath = path.join(candidateLogsDir, stableName);
    const stableText = [
      '=== REQUEST BODY ===',
      '{"model":"prompt-model-must-not-win"}',
      'h'.repeat(160 * 1024),
      '=== API RESPONSE 1 ===',
      '{"model":"gpt-test-stable","usage":{"input_tokens":109,"output_tokens":2,"total_tokens":111}}',
      't'.repeat(400 * 1024),
    ].join('\n');
    await fs.writeFile(stablePath, stableText, 'utf8');

    const stableCandidate = await buildProductionMaintenanceCandidate({
      formalLedger: maintenanceLedger({ entries: [], fingerprints: {} }),
      snapshotTimeMs: Date.now(),
      logRoots: [candidateLogsDir, candidateAuthLogsDir],
      stabilityDelayMs: 0,
      sleep: async () => {},
    });
    assert.equal(stableCandidate.ledger.entries.length, 1);
    assert.equal(stableCandidate.ledger.entries[0].tokenUsage.status, 'available');
    assert.equal(stableCandidate.ledger.entries[0].tokenUsage.total, 111);
    assert.equal(stableCandidate.pendingEntries.length, 1);
    assert.equal(
      stableCandidate.ledger.state.fileFingerprints[
        maintenanceSourceKey(candidateLogsDir, stableName)
      ],
      fingerprintForTest(await fs.stat(stablePath))
    );
    assert.equal(
      await pathExistsForTest(stablePath),
      true,
      'recent stable logs may be accounted but must remain protected from deletion'
    );

    const afterSnapshotName = 'v1-responses-2026-07-17T004535-aftercut1.log';
    const afterSnapshotPath = path.join(candidateLogsDir, afterSnapshotName);
    await fs.writeFile(afterSnapshotPath, makeLogText('gpt-test-after-snapshot', 112), 'utf8');
    const snapshotCutoffMs = Date.now();
    const afterSnapshotTime = new Date(snapshotCutoffMs + 60_000);
    await fs.utimes(afterSnapshotPath, afterSnapshotTime, afterSnapshotTime);
    const cutoffCandidate = await buildProductionMaintenanceCandidate({
      formalLedger: maintenanceLedger({ entries: [], fingerprints: {} }),
      snapshotTimeMs: snapshotCutoffMs,
      logRoots: [candidateLogsDir, candidateAuthLogsDir],
      stabilityDelayMs: 0,
      sleep: async () => {},
    });
    assert.equal(
      cutoffCandidate.ledger.entries.some(
        (entry) => entry.sourceKey === maintenanceSourceKey(candidateLogsDir, afterSnapshotName)
      ),
      false,
      'logs newer than the preview snapshot must remain for a later maintenance run'
    );

    const changingName = 'v1-responses-2026-07-17T004540-changing01.log';
    const changingPath = path.join(candidateAuthLogsDir, changingName);
    await fs.writeFile(changingPath, makeLogText('gpt-test-changing', 113), 'utf8');
    const changingCandidate = await buildProductionMaintenanceCandidate({
      formalLedger: maintenanceLedger({ entries: [], fingerprints: {} }),
      snapshotTimeMs: Date.now(),
      logRoots: [candidateLogsDir, candidateAuthLogsDir],
      stabilityDelayMs: 750,
      sleep: async () => {
        await fs.appendFile(changingPath, '\nstill-writing', 'utf8');
      },
    });
    const changingSourceKey = maintenanceSourceKey(candidateAuthLogsDir, changingName);
    assert.equal(
      changingCandidate.ledger.entries.some((entry) => entry.sourceKey === changingSourceKey),
      false
    );
    assert.equal(changingCandidate.ledger.state.fileFingerprints[changingSourceKey], undefined);
    assert.equal(changingCandidate.pendingEntries.length, 1, 'the other stable file stays pending');

    const retryName = 'v1-responses-2026-07-17T004550-retry0001.log';
    const retryPath = path.join(candidateAuthLogsDir, retryName);
    await fs.writeFile(retryPath, makeLogText('gpt-test-retry', 115), 'utf8');
    const retryStats = await fs.stat(retryPath);
    const retryEntry = maintenanceEntry({
      logsDir: candidateAuthLogsDir,
      fileName: retryName,
      stats: retryStats,
      total: 0,
      detailStatus: 'missing-fields',
      tokenStatus: 'unreported',
    });
    const retryCandidate = await buildProductionMaintenanceCandidate({
      formalLedger: maintenanceLedger({
        entries: [retryEntry],
        fingerprints: { [retryEntry.sourceKey]: fingerprintForTest(retryStats) },
      }),
      snapshotTimeMs: Date.now(),
      logRoots: [candidateLogsDir, candidateAuthLogsDir],
      stabilityDelayMs: 0,
      sleep: async () => {},
    });
    const reparsedRetry = retryCandidate.ledger.entries.find(
      (entry) => entry.sourceKey === retryEntry.sourceKey
    );
    assert.equal(reparsedRetry.tokenUsage.status, 'available');
    assert.equal(reparsedRetry.tokenUsage.total, 115);
    assert.equal(
      retryCandidate.ledger.state.fileFingerprints[retryEntry.sourceKey],
      fingerprintForTest(retryStats),
      'only a successful available parse may refresh the stored fingerprint'
    );

    const errorRetryName = 'v1-responses-2026-07-17T004555-errretry1.log';
    const errorRetryPath = path.join(candidateAuthLogsDir, errorRetryName);
    await fs.writeFile(errorRetryPath, makeLogText('gpt-test-error-retry', 117), 'utf8');
    const errorRetryStats = await fs.stat(errorRetryPath);
    const oldErrorEntry = buildSafeLogErrorEntry(
      errorRetryName,
      errorRetryStats,
      candidateAuthLogsDir
    );
    const errorRetryCandidate = await buildProductionMaintenanceCandidate({
      formalLedger: maintenanceLedger({
        entries: [oldErrorEntry],
        fingerprints: {
          [oldErrorEntry.sourceKey]: fingerprintForTest(errorRetryStats),
        },
      }),
      snapshotTimeMs: Date.now(),
      logRoots: [candidateLogsDir, candidateAuthLogsDir],
      stabilityDelayMs: 0,
      sleep: async () => {},
    });
    const reparsedError = errorRetryCandidate.ledger.entries.find(
      (entry) => entry.sourceKey === oldErrorEntry.sourceKey
    );
    assert.equal(reparsedError.tokenUsage.status, 'available');
    assert.equal(reparsedError.tokenUsage.total, 117);
  } finally {
    await fs.rm(productionCandidateRoot, { recursive: true, force: true });
  }

  const safeParseErrorRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-safe-parse-error-')
  );
  try {
    const safeParseLogsDir = path.join(safeParseErrorRoot, 'logs');
    await fs.mkdir(safeParseLogsDir, { recursive: true });
    const safeParseName = 'v1-responses-2026-07-17T004550-safeerr01.log';
    const safeParsePath = path.join(safeParseLogsDir, safeParseName);
    await fs.writeFile(safeParsePath, 'synthetic invalid response', 'utf8');
    const safeParseStats = await fs.stat(safeParsePath);
    const sensitiveFailurePath = 'D:\\private\\raw-logs\\request-secret.log';
    const rawFailure = new Error(`decoder exploded at ${sensitiveFailurePath}: raw upstream body`);
    const safeErrorEntry = buildSafeLogErrorEntry(
      safeParseName,
      safeParseStats,
      safeParseLogsDir,
      rawFailure
    );
    const safeErrorLedger = maintenanceLedger({
      entries: [safeErrorEntry],
      fingerprints: { [safeErrorEntry.sourceKey]: fingerprintForTest(safeParseStats) },
      generationId: 'safe-parse-error-ledger',
    });
    const fullLedgerText = JSON.stringify(safeErrorLedger);
    const projectionText = JSON.stringify(maintenanceProjection(safeErrorLedger));
    for (const serialized of [fullLedgerText, projectionText]) {
      assert.equal(serialized.includes(sensitiveFailurePath), false);
      assert.equal(serialized.includes(rawFailure.message), false);
      assert.equal(serialized.includes('raw upstream body'), false);
      assert.equal(serialized.includes('log-parse-failed'), true);
    }
  } finally {
    await fs.rm(safeParseErrorRoot, { recursive: true, force: true });
  }

  const rollbackRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-rollback-')
  );
  try {
    const rollbackLogsDir = path.join(rollbackRoot, 'logs');
    const rollbackAuthLogsDir = path.join(rollbackRoot, 'auths', 'logs');
    const rollbackLedgerPath = path.join(
      rollbackRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const rollbackProjectionPath = path.join(rollbackRoot, 'static', 'token-ledger.json');
    await fs.mkdir(rollbackLogsDir, { recursive: true });
    await fs.mkdir(rollbackAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(rollbackLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(rollbackProjectionPath), { recursive: true });
    const rollbackName = 'v1-responses-2026-07-17T004600-rollback1.log';
    const rollbackLogPath = path.join(rollbackLogsDir, rollbackName);
    await fs.writeFile(rollbackLogPath, makeLogText('gpt-test-rollback', 95), 'utf8');
    await setFileAgeMinutes(rollbackLogPath, 10);
    const rollbackStats = await fs.stat(rollbackLogPath);
    const rollbackEntry = maintenanceEntry({
      logsDir: rollbackLogsDir,
      fileName: rollbackName,
      stats: rollbackStats,
      total: 95,
    });
    const formalLedger = maintenanceLedger({
      entries: [rollbackEntry],
      fingerprints: { [rollbackEntry.sourceKey]: fingerprintForTest(rollbackStats) },
      generationId: 'rollback-formal',
    });
    const candidateLedger = maintenanceLedger({
      entries: [rollbackEntry],
      fingerprints: { [rollbackEntry.sourceKey]: fingerprintForTest(rollbackStats) },
      generationId: 'rollback-candidate',
    });
    const formalText = `${JSON.stringify(formalLedger, null, 2)}\n`;
    const projectionText = `${JSON.stringify(maintenanceProjection(formalLedger), null, 2)}\n`;
    await fs.writeFile(rollbackLedgerPath, formalText, 'utf8');
    await fs.writeFile(rollbackProjectionPath, projectionText, 'utf8');
    let projectionWrites = 0;
    const rollbackCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: rollbackLedgerPath,
        projectionPath: rollbackProjectionPath,
        lockPath: `${rollbackLedgerPath}.maintenance.lock`,
        allowedLogRoots: [rollbackLogsDir, rollbackAuthLogsDir],
      },
      buildCandidate: async () => ({
        ledger: candidateLedger,
        projection: maintenanceProjection(candidateLedger),
        pendingEntries: [],
        scan: { scannedFiles: 1, updatedFiles: 0, skippedFiles: 1, errorFiles: 0 },
      }),
      commitCandidate: (candidate) =>
        commitLedgerProjectionPairWithRollback({
          candidate,
          ledgerPath: rollbackLedgerPath,
          projectionPath: rollbackProjectionPath,
          atomicWriter: async (targetPath, text) => {
            if (path.normalize(targetPath) === path.normalize(rollbackProjectionPath)) {
              projectionWrites += 1;
              throw new Error('synthetic projection write failure');
            }
            await fs.writeFile(targetPath, text, 'utf8');
          },
        }),
    });
    const rollbackPreview = await rollbackCore.preview();
    await assert.rejects(
      rollbackCore.execute({ previewId: rollbackPreview.previewId }),
      (error) => error?.code === 'TOKEN_LEDGER_INTERNAL'
    );
    assert.equal(projectionWrites, 1);
    assert.equal(await fs.readFile(rollbackLedgerPath, 'utf8'), formalText);
    assert.equal(await fs.readFile(rollbackProjectionPath, 'utf8'), projectionText);
    assert.equal(await pathExistsForTest(rollbackLogPath), true, 'rollback failure must not prune');

    let ledgerWrites = 0;
    await assert.rejects(
      commitLedgerProjectionPairWithRollback({
        candidate: {
          ledger: candidateLedger,
          projection: maintenanceProjection(candidateLedger),
        },
        ledgerPath: rollbackLedgerPath,
        projectionPath: rollbackProjectionPath,
        atomicWriter: async (targetPath, text) => {
          if (path.normalize(targetPath) === path.normalize(rollbackLedgerPath)) {
            ledgerWrites += 1;
            if (ledgerWrites > 1) throw new Error('synthetic rollback failure');
            await fs.writeFile(targetPath, text, 'utf8');
            return;
          }
          throw new Error('synthetic projection failure before rollback failure');
        },
      }),
      (error) => error?.code === 'TOKEN_LEDGER_INTERNAL'
    );
  } finally {
    await fs.rm(rollbackRoot, { recursive: true, force: true });
  }

  const processLockRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-lock-')
  );
  try {
    const lockPath = path.join(processLockRoot, 'maintenance.lock');
    let closedAfterWriteFailure = false;
    let taskCalledAfterWriteFailure = false;
    const writeFailureFs = {
      mkdir: (...args) => fs.mkdir(...args),
      open: async (...args) => {
        const handle = await fs.open(...args);
        return {
          writeFile: async () => {
            throw new Error('synthetic owner metadata write failure');
          },
          close: async () => {
            closedAfterWriteFailure = true;
            await handle.close();
          },
        };
      },
      readFile: (...args) => fs.readFile(...args),
      rename: (...args) => fs.rename(...args),
      rm: (...args) => fs.rm(...args),
    };
    await assert.rejects(
      withTokenLedgerMaintenanceLock({ lockPath, fsAdapter: writeFailureFs }, async () => {
        taskCalledAfterWriteFailure = true;
      }),
      (error) => error?.code === 'TOKEN_LEDGER_INTERNAL'
    );
    assert.equal(closedAfterWriteFailure, true);
    assert.equal(taskCalledAfterWriteFailure, false);
    assert.equal(
      await pathExistsForTest(lockPath),
      false,
      'failed owner metadata writes must not leave a permanent busy lock'
    );

    const coreModuleUrl = pathToFileURL(
      path.join(__dirname, 'lib', 'token-ledger-maintenance-core.mjs')
    ).href;
    const lockChildSource = `
      import { withTokenLedgerMaintenanceLock, toSafeTokenLedgerMaintenanceError } from ${JSON.stringify(coreModuleUrl)};
      const [lockPath, holdText] = process.argv.slice(1);
      try {
        await withTokenLedgerMaintenanceLock({ lockPath }, async () => {
          console.log('LOCKED');
          await new Promise((resolve) => setTimeout(resolve, Number(holdText) || 0));
        });
        console.log('DONE');
      } catch (error) {
        console.error(JSON.stringify(toSafeTokenLedgerMaintenanceError(error)));
        process.exitCode = 2;
      }
    `;
    const firstLockProcess = spawn(
      process.execPath,
      ['--input-type=module', '-e', lockChildSource, lockPath, '1500'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const firstExitPromise = new Promise((resolve) => firstLockProcess.once('exit', resolve));
    await waitForChildLine(firstLockProcess, 'LOCKED');
    const secondLockProcess = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', lockChildSource, lockPath, '0'],
      { encoding: 'utf8' }
    );
    assert.equal(secondLockProcess.status, 2, secondLockProcess.stderr || secondLockProcess.stdout);
    const busyError = JSON.parse(secondLockProcess.stderr.trim());
    assert.equal(busyError.code, 'TOKEN_LEDGER_BUSY');
    assertSafeMaintenancePayload(busyError, [processLockRoot, lockPath]);
    const firstExitCode = await firstExitPromise;
    assert.equal(firstExitCode, 0);
    assert.equal(await pathExistsForTest(lockPath), false);
  } finally {
    await fs.rm(processLockRoot, { recursive: true, force: true });
  }

  const safeErrorRoot = await fs.mkdtemp(
    path.join(maintenanceTestBase, 'cpamc-token-ledger-maintenance-safe-error-')
  );
  try {
    const safeErrorLogsDir = path.join(safeErrorRoot, 'logs');
    const safeErrorAuthLogsDir = path.join(safeErrorRoot, 'auths', 'logs');
    const safeErrorLedgerPath = path.join(
      safeErrorRoot,
      'usage-backups',
      'token-ledger',
      'ledger.json'
    );
    const safeErrorProjectionPath = path.join(safeErrorRoot, 'static', 'token-ledger.json');
    await fs.mkdir(safeErrorLogsDir, { recursive: true });
    await fs.mkdir(safeErrorAuthLogsDir, { recursive: true });
    await fs.mkdir(path.dirname(safeErrorLedgerPath), { recursive: true });
    await fs.mkdir(path.dirname(safeErrorProjectionPath), { recursive: true });
    const emptyLedger = maintenanceLedger({
      entries: [],
      fingerprints: {},
      generationId: 'safe-error-generation',
    });
    await fs.writeFile(safeErrorLedgerPath, `${JSON.stringify(emptyLedger)}\n`, 'utf8');
    await fs.writeFile(
      safeErrorProjectionPath,
      `${JSON.stringify(maintenanceProjection(emptyLedger))}\n`,
      'utf8'
    );
    const safeErrorCore = createTokenLedgerMaintenanceCore({
      policy: {
        ledgerPath: safeErrorLedgerPath,
        projectionPath: safeErrorProjectionPath,
        lockPath: `${safeErrorLedgerPath}.maintenance.lock`,
        allowedLogRoots: [safeErrorLogsDir, safeErrorAuthLogsDir],
        minimumActiveWindowMinutes: 5,
      },
      buildCandidate: async () => {
        throw new Error(`sensitive failure at ${safeErrorRoot}`);
      },
      commitCandidate: async () => {},
    });
    await assert.rejects(safeErrorCore.preview(), (error) => {
      assert.equal(error?.code, 'TOKEN_LEDGER_INTERNAL');
      assert.equal(String(error?.message).includes(safeErrorRoot), false);
      assert.doesNotMatch(String(error?.stack), new RegExp(safeErrorRoot.replace(/\\/g, '\\\\')));
      return true;
    });
  } finally {
    await fs.rm(safeErrorRoot, { recursive: true, force: true });
  }

  const logsDir = path.join(tmpRoot, 'logs');
  const authLogsDir = path.join(tmpRoot, 'auths', 'logs');
  await fs.mkdir(logsDir, { recursive: true });
  await fs.mkdir(authLogsDir, { recursive: true });

  await fs.writeFile(
    path.join(logsDir, 'v1-responses-2026-06-15T010000-old00001.log'),
    makeLogText('gpt-test-old', 11),
    'utf8'
  );
  await fs.writeFile(
    path.join(authLogsDir, 'v1-responses-2026-06-15T230000-new00001.log'),
    makeLogText('gpt-test-new', 23),
    'utf8'
  );

  const defaultResult = runLedger(tmpRoot);
  assert.equal(defaultResult.scannedFiles, 2);
  assert.equal(defaultResult.coverage.totalEntries, 2);
  assert.equal(defaultResult.coverage.knownEntries, 2);
  assert.deepEqual(
    defaultResult.source.logsDirs.map((item) => path.normalize(item)).sort(),
    [logsDir, authLogsDir].map((item) => path.normalize(item)).sort()
  );

  const explicitResult = runLedger(tmpRoot, ['--logs-dir', logsDir]);
  assert.equal(explicitResult.scannedFiles, 1);
  assert.equal(explicitResult.coverage.totalEntries, 1);
  assert.deepEqual(explicitResult.source.logsDirs, [logsDir]);

  await fs.writeFile(
    path.join(logsDir, 'v1-responses-2026-06-15T231000-dup00001.log'),
    makeLogText('gpt-test-duplicate-old', 12),
    'utf8'
  );
  await fs.writeFile(
    path.join(authLogsDir, 'v1-responses-2026-06-15T231000-dup00001.log'),
    makeLogText('gpt-test-duplicate-auth', 34),
    'utf8'
  );

  const dedupResult = runLedgerWrite(tmpRoot, ['--no-embed']);
  assert.equal(dedupResult.status, 'completed');
  assert.equal(dedupResult.scannedFiles, 4);
  assert.equal(dedupResult.coverage.totalEntries, 3);
  assert.equal(dedupResult.coverage.knownEntries, 2);

  const projection = await readProjection(tmpRoot);
  const fullLedger = JSON.parse(
    await fs.readFile(path.join(tmpRoot, 'usage-backups', 'token-ledger', 'ledger.json'), 'utf8')
  );
  assert.match(fullLedger.generationId, /^[0-9a-f-]{36}$/i);
  assert.equal(projection.generationId, fullLedger.generationId);
  const duplicateEntries = projection.entries.filter((entry) => entry.requestId === 'dup00001');
  assert.equal(duplicateEntries.length, 1);
  assert.equal(duplicateEntries[0].detailStatus, 'ambiguous');
  assert.equal(duplicateEntries[0].tokenUsage.status, 'ambiguous');
  assert.equal(duplicateEntries[0].tokenUsage.total, 0);
  assert.equal(duplicateEntries[0].errorCode, 'ambiguous-request');

  const htmlPath = path.join(tmpRoot, 'static', 'management.html');
  await fs.writeFile(htmlPath, '<html><body><div id="root"></div></body></html>', 'utf8');
  const embedResult = runLedgerWrite(tmpRoot, ['--embed']);
  assert.equal(embedResult.embeddedHtmlFiles.length, 1);
  assert.equal(embedResult.embeddedLedgerMode, 'summary');
  const embeddedHtml = await fs.readFile(htmlPath, 'utf8');
  const embeddedMatch = embeddedHtml.match(
    /<script[^>]+id=["']cpamc-token-ledger["'][^>]*>([\s\S]*?)<\/script>/
  );
  assert.ok(embeddedMatch, 'expected embedded ledger summary script');
  const embeddedPayload = JSON.parse(embeddedMatch[1]);
  assert.equal(embeddedPayload.embeddedMode, 'summary');
  assert.equal(embeddedPayload.coverage.totalEntries, embedResult.coverage.totalEntries);
  assert.deepEqual(embeddedPayload.entries, []);
  assert.equal(embeddedPayload.externalLedgerUrl, '/token-ledger.json');
  assert.ok(
    !embeddedHtml.includes('gpt-test-duplicate-auth'),
    'full ledger entries should stay out of management.html'
  );

  const preserveEmbeddedResult = runLedgerWrite(tmpRoot);
  assert.deepEqual(
    preserveEmbeddedResult.strippedHtmlFiles,
    [],
    'Default ledger refresh must preserve an existing embedded summary.'
  );
  assert.match(
    await fs.readFile(htmlPath, 'utf8'),
    /id=["']cpamc-token-ledger["']/,
    'Default ledger refresh must leave the embedded summary available.'
  );

  const stripEmbeddedResult = runLedgerWrite(tmpRoot, ['--no-embed']);
  assert.equal(stripEmbeddedResult.strippedHtmlFiles.length, 1);
  assert.doesNotMatch(
    await fs.readFile(htmlPath, 'utf8'),
    /id=["']cpamc-token-ledger["']/,
    'Explicit --no-embed must remove the embedded summary.'
  );

  const largeCoverageRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'cpamc-token-ledger-large-coverage-')
  );
  try {
    const largeLogsDir = path.join(largeCoverageRoot, 'logs');
    const largeLedgerDir = path.join(largeCoverageRoot, 'usage-backups', 'token-ledger');
    const largeEntryCount = 130_000;
    await fs.mkdir(largeLogsDir, { recursive: true });
    await fs.mkdir(largeLedgerDir, { recursive: true });
    await fs.writeFile(
      path.join(largeLedgerDir, 'ledger.json'),
      JSON.stringify({
        entries: Array.from({ length: largeEntryCount }, (_, index) => ({
          fileName: `large-${String(index).padStart(6, '0')}.log`,
          sourceDir: largeLogsDir,
          sourceKey: `large:${index}`,
          timestampMs: index,
          detailStatus: 'ready',
          tokenUsage: { status: 'available' },
        })),
        source: { logsDir: largeLogsDir, logsDirs: [largeLogsDir] },
        state: { fileFingerprints: {} },
      }),
      'utf8'
    );

    const largeCoverageResult = runLedger(largeCoverageRoot, ['--no-embed']);
    assert.equal(largeCoverageResult.coverage.totalEntries, largeEntryCount);
    assert.equal(largeCoverageResult.coverage.earliestTimestampMs, 0);
    assert.equal(largeCoverageResult.coverage.latestTimestampMs, largeEntryCount - 1);
  } finally {
    await fs.rm(largeCoverageRoot, { recursive: true, force: true });
  }

  const pruneRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-token-ledger-prune-'));
  try {
    const pruneLogsDir = path.join(pruneRoot, 'logs');
    await fs.mkdir(pruneLogsDir, { recursive: true });
    const recordedLog = path.join(pruneLogsDir, 'v1-responses-2026-06-16T010000-prune001.log');
    const activeLog = path.join(pruneLogsDir, 'v1-responses-2026-06-16T010100-active01.log');
    const nonDetailLog = path.join(pruneLogsDir, 'control-sidecar-20260616.log');
    await fs.writeFile(recordedLog, makeLogText('gpt-test-prune', 45), 'utf8');
    await fs.writeFile(activeLog, makeLogText('gpt-test-active', 67), 'utf8');
    await fs.writeFile(nonDetailLog, '{"message":"sidecar log"}\n', 'utf8');
    await setFileAgeMinutes(recordedLog, 10);
    await setFileAgeMinutes(activeLog, 1);
    await setFileAgeMinutes(nonDetailLog, 10);

    const pruneDryRun = runLedgerWrite(pruneRoot, [
      '--no-embed',
      '--prune-recorded-logs',
      '--active-window-minutes',
      '5',
      '--dry-run',
    ]);
    assert.equal(pruneDryRun.prune.deletedFiles, 1);
    assert.equal(pruneDryRun.prune.keptActiveFiles, 1);
    assert.equal(await pathExistsForTest(recordedLog), true);

    const pruneResult = runLedgerWrite(pruneRoot, [
      '--no-embed',
      '--prune-recorded-logs',
      '--active-window-minutes',
      '5',
    ]);
    assert.equal(pruneResult.prune.deletedFiles, 1);
    assert.equal(pruneResult.prune.keptActiveFiles, 1);
    assert.equal(await pathExistsForTest(recordedLog), false);
    assert.equal(await pathExistsForTest(activeLog), true);
    assert.equal(await pathExistsForTest(nonDetailLog), true);

    const prunedProjection = await readProjection(pruneRoot);
    assert.equal(prunedProjection.entries.length, 2);
  } finally {
    await fs.rm(pruneRoot, { recursive: true, force: true });
  }

  const pruneOnlyRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-token-ledger-prune-only-'));
  try {
    const pruneOnlyLogsDir = path.join(pruneOnlyRoot, 'logs');
    await fs.mkdir(pruneOnlyLogsDir, { recursive: true });
    const recordedLog = path.join(pruneOnlyLogsDir, 'v1-responses-2026-06-17T010000-known001.log');
    const unrecordedLog = path.join(
      pruneOnlyLogsDir,
      'v1-responses-2026-06-17T020000-new00001.log'
    );
    await fs.writeFile(recordedLog, makeLogText('gpt-test-known', 89), 'utf8');
    await setFileAgeMinutes(recordedLog, 10);

    const initialLedger = runLedgerWrite(pruneOnlyRoot, ['--no-embed']);
    assert.equal(initialLedger.coverage.totalEntries, 1);

    await fs.writeFile(unrecordedLog, makeLogText('gpt-test-unrecorded', 101), 'utf8');
    await setFileAgeMinutes(unrecordedLog, 10);

    const pruneOnlyResult = runLedgerWrite(pruneOnlyRoot, [
      '--no-embed',
      '--prune-recorded-logs',
      '--prune-only',
      '--active-window-minutes',
      '5',
    ]);
    assert.equal(pruneOnlyResult.mode, 'prune-only');
    assert.equal(pruneOnlyResult.prune.deletedFiles, 1);
    assert.equal(pruneOnlyResult.prune.keptUnrecordedFiles, 1);
    assert.equal(await pathExistsForTest(recordedLog), false);
    assert.equal(await pathExistsForTest(unrecordedLog), true);

    const pruneOnlyProjection = await readProjection(pruneOnlyRoot);
    assert.equal(pruneOnlyProjection.entries.length, 1);
  } finally {
    await fs.rm(pruneOnlyRoot, { recursive: true, force: true });
  }

  const strictLegacyPruneRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'cpamc-token-ledger-strict-legacy-prune-')
  );
  try {
    const configuredLogsDir = path.join(strictLegacyPruneRoot, 'logs');
    const externalLogsDir = path.join(strictLegacyPruneRoot, 'ledger-controlled-external');
    const strictLedgerDir = path.join(strictLegacyPruneRoot, 'usage-backups', 'token-ledger');
    await fs.mkdir(configuredLogsDir, { recursive: true });
    await fs.mkdir(externalLogsDir, { recursive: true });
    await fs.mkdir(strictLedgerDir, { recursive: true });

    const readyName = 'v1-responses-2026-06-17T030000-strict01.log';
    const unreportedName = 'v1-responses-2026-06-17T031000-strict02.log';
    const missingName = 'v1-responses-2026-06-17T032000-strict03.log';
    const externalName = 'v1-responses-2026-06-17T033000-strict04.log';
    const readyPath = path.join(configuredLogsDir, readyName);
    const unreportedPath = path.join(configuredLogsDir, unreportedName);
    const missingPath = path.join(configuredLogsDir, missingName);
    const externalPath = path.join(externalLogsDir, externalName);
    await fs.writeFile(readyPath, makeLogText('gpt-test-strict-ready', 103), 'utf8');
    await fs.writeFile(unreportedPath, makeLogText('gpt-test-strict-unreported', 105), 'utf8');
    await fs.writeFile(missingPath, makeLogText('gpt-test-strict-missing', 107), 'utf8');
    await fs.writeFile(externalPath, makeLogText('gpt-test-strict-external', 109), 'utf8');
    await Promise.all(
      [readyPath, unreportedPath, missingPath, externalPath].map((filePath) =>
        setFileAgeMinutes(filePath, 10)
      )
    );
    const readyStats = await fs.stat(readyPath);
    const unreportedStats = await fs.stat(unreportedPath);
    const missingStats = await fs.stat(missingPath);
    const externalStats = await fs.stat(externalPath);
    const readyEntry = maintenanceEntry({
      logsDir: configuredLogsDir,
      fileName: readyName,
      stats: readyStats,
      total: 103,
    });
    const unreportedEntry = maintenanceEntry({
      logsDir: configuredLogsDir,
      fileName: unreportedName,
      stats: unreportedStats,
      total: 0,
      tokenStatus: 'unreported',
    });
    const missingEntry = maintenanceEntry({
      logsDir: configuredLogsDir,
      fileName: missingName,
      stats: missingStats,
      total: 107,
      detailStatus: 'missing-fields',
    });
    const externalEntry = maintenanceEntry({
      logsDir: externalLogsDir,
      fileName: externalName,
      stats: externalStats,
      total: 109,
    });
    const strictLedger = maintenanceLedger({
      entries: [readyEntry, unreportedEntry, missingEntry, externalEntry],
      fingerprints: {
        [readyEntry.sourceKey]: fingerprintForTest(readyStats),
        [unreportedEntry.sourceKey]: fingerprintForTest(unreportedStats),
        [missingEntry.sourceKey]: fingerprintForTest(missingStats),
        [externalEntry.sourceKey]: fingerprintForTest(externalStats),
      },
      generationId: 'strict-legacy-prune',
    });
    strictLedger.source = {
      ...strictLedger.source,
      logsDir: externalLogsDir,
      logsDirs: [externalLogsDir],
    };
    await fs.writeFile(
      path.join(strictLedgerDir, 'ledger.json'),
      `${JSON.stringify(strictLedger, null, 2)}\n`,
      'utf8'
    );

    const strictPrune = runLedgerWrite(strictLegacyPruneRoot, [
      '--no-embed',
      '--prune-recorded-logs',
      '--prune-only',
      '--active-window-minutes',
      '5',
    ]);
    assert.equal(strictPrune.prune.deletedFiles, 1);
    assert.equal(strictPrune.prune.keptNotReadyAvailableFiles, 2);
    assert.equal(await pathExistsForTest(readyPath), false);
    assert.equal(await pathExistsForTest(unreportedPath), true);
    assert.equal(await pathExistsForTest(missingPath), true);
    assert.equal(
      await pathExistsForTest(externalPath),
      true,
      'prune-only must never take its scan root from ledger.source.logsDirs'
    );
    assert.equal(
      strictPrune.source.logsDirs.some(
        (item) => path.normalize(item) === path.normalize(externalLogsDir)
      ),
      false
    );
  } finally {
    await fs.rm(strictLegacyPruneRoot, { recursive: true, force: true });
  }

  const lowSpaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-token-ledger-low-space-'));
  try {
    const lowSpaceLogsDir = path.join(lowSpaceRoot, 'logs');
    await fs.mkdir(lowSpaceLogsDir, { recursive: true });
    const recordedLog = path.join(lowSpaceLogsDir, 'v1-responses-2026-06-18T010000-lowspace1.log');
    await fs.writeFile(recordedLog, makeLogText('gpt-test-low-space', 113), 'utf8');
    await setFileAgeMinutes(recordedLog, 10);

    runLedgerWrite(lowSpaceRoot, ['--no-embed', '--min-free-bytes', '0']);
    const ledgerPath = path.join(lowSpaceRoot, 'usage-backups', 'token-ledger', 'ledger.json');
    const ledgerBefore = await fs.readFile(ledgerPath, 'utf8');

    const lowSpaceResult = runLedgerProcess(lowSpaceRoot, [
      '--no-embed',
      '--prune-recorded-logs',
      '--active-window-minutes',
      '0',
      '--min-free-bytes',
      String(Number.MAX_SAFE_INTEGER),
    ]);
    assert.notEqual(lowSpaceResult.status, 0, 'ordinary refresh must fail closed on low space');
    const lowSpaceStderrLines = lowSpaceResult.stderr.trim().split(/\r?\n/);
    assert.equal(lowSpaceStderrLines.length, 1, lowSpaceResult.stderr);
    const lowSpaceError = JSON.parse(lowSpaceStderrLines[0]);
    assert.equal(lowSpaceError.code, 'TOKEN_LEDGER_LOW_SPACE');
    assert.equal(Number.isFinite(lowSpaceError.availableBytes), true);
    assert.equal(Number.isFinite(lowSpaceError.requiredBytes), true);
    assert.equal(lowSpaceError.requiredBytes > lowSpaceError.availableBytes, true);
    assert.doesNotMatch(lowSpaceResult.stderr, /\bError:|\n\s*at\s/);
    assert.equal(await pathExistsForTest(recordedLog), true, 'fail-closed refresh must not prune');
    assert.equal(await fs.readFile(ledgerPath, 'utf8'), ledgerBefore);
  } finally {
    await fs.rm(lowSpaceRoot, { recursive: true, force: true });
  }

  const rescueRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-token-ledger-rescue-'));
  try {
    const rescueLogsDir = path.join(rescueRoot, 'logs');
    await fs.mkdir(rescueLogsDir, { recursive: true });
    const recordedLog = path.join(rescueLogsDir, 'v1-responses-2026-06-19T010000-rescue01.log');
    const unrecordedLog = path.join(rescueLogsDir, 'v1-responses-2026-06-19T020000-rescue02.log');
    const recordedHandle = await fs.open(recordedLog, 'w');
    try {
      await recordedHandle.writeFile(makeLogText('gpt-test-rescue-recorded', 127), 'utf8');
      await recordedHandle.write(Buffer.alloc(64 * 1024 * 1024, 0x78));
    } finally {
      await recordedHandle.close();
    }
    await setFileAgeMinutes(recordedLog, 10);

    runLedgerWrite(rescueRoot, ['--no-embed', '--min-free-bytes', '0']);
    await fs.writeFile(unrecordedLog, makeLogText('gpt-test-rescue-new', 131), 'utf8');
    await setFileAgeMinutes(unrecordedLog, 10);

    const availableBeforeRescue = await availableBytesAt(rescueRoot);
    const rescueResult = runLedgerWrite(rescueRoot, [
      '--no-embed',
      '--rescue-low-space',
      '--active-window-minutes',
      '0',
      '--min-free-bytes',
      String(availableBeforeRescue + 32 * 1024 * 1024),
    ]);
    assert.equal(rescueResult.rescueLowSpace.attempted, true);
    assert.equal(rescueResult.rescueLowSpace.prune.deletedFiles, 1);
    assert.equal(rescueResult.rescueLowSpace.prune.keptUnrecordedFiles, 1);
    assert.equal(rescueResult.scannedFiles, 1, 'refresh must re-list logs after rescue prune');
    assert.equal(await pathExistsForTest(recordedLog), false);
    assert.equal(await pathExistsForTest(unrecordedLog), true);

    const rescueProjection = await readProjection(rescueRoot);
    assert.equal(rescueProjection.entries.length, 2);
  } finally {
    await fs.rm(rescueRoot, { recursive: true, force: true });
  }

  const corruptRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-token-ledger-corrupt-'));
  try {
    const corruptLogsDir = path.join(corruptRoot, 'logs');
    const corruptLedgerDir = path.join(corruptRoot, 'usage-backups', 'token-ledger');
    await fs.mkdir(corruptLogsDir, { recursive: true });
    await fs.mkdir(corruptLedgerDir, { recursive: true });
    const recordedLog = path.join(corruptLogsDir, 'v1-responses-2026-06-20T010000-corrupt1.log');
    await fs.writeFile(recordedLog, makeLogText('gpt-test-corrupt-ledger', 137), 'utf8');
    await setFileAgeMinutes(recordedLog, 10);
    await fs.writeFile(path.join(corruptLedgerDir, 'ledger.json'), '{not-json', 'utf8');

    const corruptResult = runLedgerProcess(corruptRoot, [
      '--prune-recorded-logs',
      '--prune-only',
      '--active-window-minutes',
      '0',
    ]);
    assert.notEqual(corruptResult.status, 0, 'corrupt history must stop maintenance');
    assert.match(corruptResult.stderr, /Unable to read JSON file/);
    assert.equal(
      await pathExistsForTest(recordedLog),
      true,
      'corrupt history must never authorize log deletion'
    );
  } finally {
    await fs.rm(corruptRoot, { recursive: true, force: true });
  }

  const atomicRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-token-ledger-atomic-'));
  try {
    const atomicLogsDir = path.join(atomicRoot, 'logs');
    const atomicLedgerDir = path.join(atomicRoot, 'usage-backups', 'token-ledger');
    await fs.mkdir(atomicLogsDir, { recursive: true });
    await fs.mkdir(atomicLedgerDir, { recursive: true });
    await fs.writeFile(
      path.join(atomicLogsDir, 'v1-responses-2026-06-21T010000-atomic01.log'),
      makeLogText('gpt-test-atomic', 149),
      'utf8'
    );
    const legacyTempPath = path.join(atomicLedgerDir, 'ledger.json.tmp');
    await fs.writeFile(legacyTempPath, 'legacy-temp-sentinel', 'utf8');

    runLedgerWrite(atomicRoot, ['--no-embed', '--min-free-bytes', '0']);
    assert.equal(
      await fs.readFile(legacyTempPath, 'utf8'),
      'legacy-temp-sentinel',
      'new writes must not reuse the legacy fixed .tmp path'
    );
    const ledgerTempFiles = (await fs.readdir(atomicLedgerDir)).filter(
      (name) => name !== 'ledger.json.tmp' && name.endsWith('.tmp')
    );
    assert.deepEqual(ledgerTempFiles, []);

    const projectionTarget = path.join(atomicRoot, 'static', 'projection-target');
    await fs.mkdir(projectionTarget, { recursive: true });
    const ledgerBeforeProjectionFailure = await fs.readFile(
      path.join(atomicLedgerDir, 'ledger.json'),
      'utf8'
    );
    const failedAtomicWrite = runLedgerProcess(atomicRoot, [
      '--no-embed',
      '--min-free-bytes',
      '0',
      '--projection-path',
      projectionTarget,
    ]);
    assert.notEqual(failedAtomicWrite.status, 0);
    assert.equal(
      await fs.readFile(path.join(atomicLedgerDir, 'ledger.json'), 'utf8'),
      ledgerBeforeProjectionFailure,
      'legacy refresh must roll back the full ledger when projection commit fails'
    );
    const projectionParentFiles = await fs.readdir(path.dirname(projectionTarget));
    assert.deepEqual(
      projectionParentFiles.filter(
        (name) => name.startsWith('projection-target.') && name.endsWith('.tmp')
      ),
      [],
      'failed atomic writes must clean their unique staging file'
    );
  } finally {
    await fs.rm(atomicRoot, { recursive: true, force: true });
  }

  const wrapperSource = await fs.readFile(wrapperPath, 'utf8');
  const updaterSource = await fs.readFile(scriptPath, 'utf8');
  assert.match(wrapperSource, /\[switch\]\$RescueLowSpace/);
  assert.match(wrapperSource, /--rescue-low-space/);
  assert.match(wrapperSource, /\$MinFreeBytes/);
  assert.match(wrapperSource, /--min-free-bytes/);
  assert.match(wrapperSource, /\[ValidateSet\("Refresh",\s*"Preview",\s*"Execute"\)\]/);
  assert.match(wrapperSource, /\[string\]\$Mode\s*=\s*"Refresh"/);
  assert.match(wrapperSource, /--maintenance/);
  assert.match(wrapperSource, /--preview-id/);
  assert.match(updaterSource, /export const createProductionMaintenanceCore/);
  assert.match(updaterSource, /export const runProductionTokenLedgerMaintenance/);
  assert.match(updaterSource, /pathToFileURL\(path\.resolve\(process\.argv\[1\]\)\)/);
  assert.match(updaterSource, /globalThis\.__CPAMC_TOKEN_LEDGER_LIBRARY_MODE__/);
  assert.match(updaterSource, /if \(isDirectExecution\)/);

  const fixedPolicyResult = runLedgerProcess(tmpRoot, [
    '--maintenance',
    'preview',
    '--logs-dir',
    logsDir,
  ]);
  assert.notEqual(fixedPolicyResult.status, 0);
  const fixedPolicyError = JSON.parse(fixedPolicyResult.stderr.trim());
  assert.equal(fixedPolicyError.code, 'TOKEN_LEDGER_FIXED_PATHS');
  assertSafeMaintenancePayload(fixedPolicyError, [tmpRoot, logsDir]);

  const missingRoot = path.join(tmpRoot, 'missing-install');
  const projectionPath = path.join(missingRoot, 'static', 'token-ledger.json');
  await fs.mkdir(path.dirname(projectionPath), { recursive: true });
  await fs.writeFile(projectionPath, '{"sentinel":true}\n', 'utf8');
  const missingResult = runLedgerProcess(missingRoot, ['--no-embed']);
  assert.notEqual(missingResult.status, 0);
  assert.match(missingResult.stderr, /No CLIProxyAPI log directories found/);
  assert.equal(await fs.readFile(projectionPath, 'utf8'), '{"sentinel":true}\n');
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
