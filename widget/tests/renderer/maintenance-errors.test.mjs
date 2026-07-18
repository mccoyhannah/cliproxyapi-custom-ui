import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build } from 'esbuild';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.resolve(testDirectory, '../..');
const cacheRoot = 'D:\\Tools\\Cache\\CPA-Token-Pulse\\tests';
let compiledRoot;

const loadMaintenanceErrors = async () => {
  if (!compiledRoot) {
    await mkdir(cacheRoot, { recursive: true });
    compiledRoot = await mkdtemp(path.join(cacheRoot, 'maintenance-errors-'));
    await build({
      entryPoints: [path.join(widgetRoot, 'src', 'maintenanceErrors.ts')],
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node22',
      outfile: path.join(compiledRoot, 'maintenanceErrors.mjs'),
      logLevel: 'silent',
    });
  }
  return import(pathToFileURL(path.join(compiledRoot, 'maintenanceErrors.mjs')).href);
};

after(async () => {
  if (compiledRoot) await rm(compiledRoot, { recursive: true, force: true });
});

test('maintenance total regression explains whether preview or execution was stopped', async () => {
  const { describeLedgerMaintenanceError } = await loadMaintenanceErrors();

  assert.equal(
    describeLedgerMaintenanceError(
      new Error('ledger-maintenance-total-regression'),
      'preview'
    ),
    '候选账本尚未追上当前合计；未写入账本、未删除日志。请稍后重新预览。'
  );
  assert.equal(
    describeLedgerMaintenanceError(
      new Error('ledger-maintenance-total-regression'),
      'execute'
    ),
    '总量安全核验未通过。维护已停止；请重新预览后再试。'
  );
});

test('maintenance low-space errors explain the safe outcome for each phase', async () => {
  const { describeLedgerMaintenanceError } = await loadMaintenanceErrors();

  assert.equal(
    describeLedgerMaintenanceError(new Error('ledger-maintenance-low-space'), 'preview'),
    '可用磁盘空间不足，安全预览未完成。没有修改正式账本，也没有删除日志。请先释放 D 盘空间后重试。'
  );
  assert.equal(
    describeLedgerMaintenanceError(new Error('ledger-maintenance-low-space'), 'execute'),
    '可用磁盘空间不足，入账未能安全写入，未执行日志清理。请先释放 D 盘空间后重新预览。'
  );
});

test('maintenance errors keep safe phase-specific fallbacks and are wired into both catches', async () => {
  const { describeLedgerMaintenanceError } = await loadMaintenanceErrors();
  const appSource = await readFile(path.join(widgetRoot, 'src', 'App.tsx'), 'utf8');

  assert.equal(
    describeLedgerMaintenanceError(new Error('unknown-private-detail'), 'preview'),
    '安全预览未完成。没有修改正式账本，也没有删除日志。'
  );
  assert.equal(
    describeLedgerMaintenanceError(new Error('unknown-private-detail'), 'execute'),
    '维护没有完成。安全流程已停止；请重新预览后再试。'
  );
  assert.match(appSource, /describeLedgerMaintenanceError\(error, 'preview'\)/);
  assert.match(appSource, /describeLedgerMaintenanceError\(error, 'execute'\)/);
});
