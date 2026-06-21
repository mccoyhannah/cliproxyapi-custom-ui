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
      path.dirname(__dirname),
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
