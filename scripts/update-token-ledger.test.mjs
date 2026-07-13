import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, 'update-token-ledger.mjs');

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

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-token-ledger-'));

try {
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

  const projection = await readProjection(tmpRoot);
  const duplicateEntries = projection.entries.filter((entry) => entry.requestId === 'dup00001');
  assert.equal(duplicateEntries.length, 1);
  assert.equal(duplicateEntries[0].tokenUsage.total, 34);
  assert.equal(path.normalize(duplicateEntries[0].sourceDir), path.normalize(authLogsDir));

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
    const largeLedgerDir = path.join(
      largeCoverageRoot,
      'usage-backups',
      'token-ledger'
    );
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
    const unrecordedLog = path.join(pruneOnlyLogsDir, 'v1-responses-2026-06-17T020000-new00001.log');
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
