import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const mainUrl = new URL('../../electron/main.ts', import.meta.url);
const preloadUrl = new URL('../../electron/preload.ts', import.meta.url);
const appUrl = new URL('../../src/App.tsx', import.meta.url);
const contractsUrl = new URL('../../src/shared/contracts.ts', import.meta.url);

test('Electron exposes only the narrow ledger maintenance IPC and tray-open event', async () => {
  const [mainSource, preloadSource, appSource, contractsSource] = await Promise.all([
    readFile(mainUrl, 'utf8'),
    readFile(preloadUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
    readFile(contractsUrl, 'utf8'),
  ]);

  for (const channel of [
    'widget:preview-ledger-maintenance',
    'widget:execute-ledger-maintenance',
    'widget:maintenance-open',
  ]) {
    assert.equal(mainSource.includes(channel), true, `main is missing ${channel}`);
    assert.equal(preloadSource.includes(channel), true, `preload is missing ${channel}`);
  }

  assert.match(mainSource, /assertTrustedLedgerMaintenanceSender\(event\)/);
  assert.match(mainSource, /args\.length\s*!==\s*0/);
  assert.match(mainSource, /args\.length\s*!==\s*1/);
  assert.match(
    mainSource,
    /getCommitFloor:\s*\(\)\s*=>\s*getLedgerMaintenanceCommitFloor\(currentSnapshot\)/
  );
  assert.match(mainSource, /executeLedgerMaintenanceWithPostVerification\(\{/);
  assert.match(mainSource, /label:\s*'日志维护…'/);
  assert.match(mainSource, /void openLedgerMaintenanceDialog\(\)/);

  const openDialogFunction = mainSource.match(
    /async function openLedgerMaintenanceDialog\(\): Promise<void> \{([\s\S]*?)\n\}/
  )?.[1];
  assert.ok(openDialogFunction, 'tray-open helper must exist');
  assert.equal(openDialogFunction.includes('.preview('), false);
  assert.equal(openDialogFunction.includes('.execute('), false);
  assert.match(openDialogFunction, /IPC_CHANNELS\.maintenanceOpen/);

  assert.match(preloadSource, /previewLedgerMaintenance:\s*(?:async\s+)?\(\)\s*=>/);
  assert.match(
    preloadSource,
    /executeLedgerMaintenance:\s*(?:async\s+)?\(previewId:\s*string\)\s*=>/
  );
  assert.match(preloadSource, /subscribeMaintenanceOpen:/);
  assert.match(contractsSource, /postVerificationPending\?:\s*true/);
  assert.match(preloadSource, /postVerificationPending/);
  assert.match(preloadSource, /ledger-maintenance-low-space/);
  assert.match(
    appSource,
    /入账清理可能已完成，仅刷新复核失败；请勿重复执行，等待数据刷新或重新打开挂件。/
  );
  assert.doesNotMatch(preloadSource, /installDir|activeWindow|managementKey|command\s*:/i);
});
