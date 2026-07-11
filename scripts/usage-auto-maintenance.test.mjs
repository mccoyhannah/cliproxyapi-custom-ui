import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const sourcePath = path.join(
  repoRoot,
  'src',
  'features',
  'usageStatistics',
  'lib',
  'autoMaintenance.ts'
);
const source = await fs.readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    isolatedModules: true,
  },
});

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-usage-auto-maintenance-'));
const modulePath = path.join(tmpRoot, 'autoMaintenance.mjs');

try {
  await fs.writeFile(modulePath, transpiled.outputText, 'utf8');
  const {
    createUsageStatisticsAutoMaintenanceState,
    createAutomaticTokenLedgerMaintenanceCoordinator,
    createTokenLedgerMaintenanceSettlementTracker,
    hasUsageStatisticsAutoMaintenanceIntent,
    runAutomaticTokenLedgerMaintenance,
    shouldStartAutomaticTokenLedgerMaintenance,
  } = await import(pathToFileURL(modulePath).href);

  const entryState = createUsageStatisticsAutoMaintenanceState();
  assert.equal(hasUsageStatisticsAutoMaintenanceIntent(entryState), true);
  assert.equal(hasUsageStatisticsAutoMaintenanceIntent(null), false);

  const readyEntry = {
    isCurrentLayer: true,
    navigationType: 'PUSH',
    connectionStatus: 'connected',
    hasApiBase: true,
    hasManagementKey: true,
    hasEntryIntent: true,
    entryKey: 'entry-1',
    lastStartedEntryKey: '',
    inFlight: false,
  };

  assert.equal(shouldStartAutomaticTokenLedgerMaintenance(readyEntry), true);
  assert.equal(
    shouldStartAutomaticTokenLedgerMaintenance({ ...readyEntry, navigationType: 'POP' }),
    false,
    'Initial load or browser history navigation must not start automatic maintenance.'
  );
  assert.equal(
    shouldStartAutomaticTokenLedgerMaintenance({ ...readyEntry, navigationType: 'REPLACE' }),
    false,
    'Login redirects and route replacement must not start automatic maintenance.'
  );
  assert.equal(
    shouldStartAutomaticTokenLedgerMaintenance({ ...readyEntry, isCurrentLayer: false }),
    false,
    'Stacked or exiting page-transition layers must stay inert.'
  );
  assert.equal(
    shouldStartAutomaticTokenLedgerMaintenance({ ...readyEntry, hasEntryIntent: false }),
    false,
    'A PUSH without the explicit sidebar intent must not start automatic maintenance.'
  );
  assert.equal(
    shouldStartAutomaticTokenLedgerMaintenance({
      ...readyEntry,
      connectionStatus: 'disconnected',
    }),
    false
  );
  assert.equal(
    shouldStartAutomaticTokenLedgerMaintenance({ ...readyEntry, hasManagementKey: false }),
    false
  );
  assert.equal(
    shouldStartAutomaticTokenLedgerMaintenance({
      ...readyEntry,
      lastStartedEntryKey: readyEntry.entryKey,
    }),
    false,
    'One page entry may run only once.'
  );
  assert.equal(
    shouldStartAutomaticTokenLedgerMaintenance({ ...readyEntry, inFlight: true }),
    false,
    'Manual or automatic maintenance already in flight must block another run.'
  );

  const calls = [];
  const refreshResult = { updatedFiles: 3 };
  const pruneResult = { prune: { deletedFiles: 2 } };
  const result = await runAutomaticTokenLedgerMaintenance({
    wakeControl: async () => calls.push('wake'),
    refreshLedger: async () => {
      calls.push('refresh');
      return refreshResult;
    },
    reloadLedgerAfterRefresh: async () => calls.push('reload-after-refresh'),
    pruneRecordedLogs: async () => {
      calls.push('prune');
      return pruneResult;
    },
    reloadLedgerAfterPrune: async () => calls.push('reload-after-prune'),
  });

  assert.deepEqual(calls, [
    'wake',
    'refresh',
    'reload-after-refresh',
    'prune',
    'reload-after-prune',
  ]);
  assert.deepEqual(result, { refreshResult, pruneResult });

  const failureCalls = [];
  await assert.rejects(
    runAutomaticTokenLedgerMaintenance({
      wakeControl: async () => failureCalls.push('wake'),
      refreshLedger: async () => {
        failureCalls.push('refresh');
        throw new Error('refresh failed');
      },
      reloadLedgerAfterRefresh: async () => failureCalls.push('reload-after-refresh'),
      pruneRecordedLogs: async () => failureCalls.push('prune'),
      reloadLedgerAfterPrune: async () => failureCalls.push('reload-after-prune'),
    }),
    /refresh failed/
  );
  assert.deepEqual(
    failureCalls,
    ['wake', 'refresh'],
    'A failed ledger update must stop before ledger reload or log cleanup.'
  );

  const reloadFailureCalls = [];
  await assert.rejects(
    runAutomaticTokenLedgerMaintenance({
      wakeControl: async () => reloadFailureCalls.push('wake'),
      refreshLedger: async () => reloadFailureCalls.push('refresh'),
      reloadLedgerAfterRefresh: async () => {
        reloadFailureCalls.push('reload-after-refresh');
        throw new Error('ledger confirmation failed');
      },
      pruneRecordedLogs: async () => reloadFailureCalls.push('prune'),
      reloadLedgerAfterPrune: async () => reloadFailureCalls.push('reload-after-prune'),
    }),
    /ledger confirmation failed/
  );
  assert.deepEqual(
    reloadFailureCalls,
    ['wake', 'refresh', 'reload-after-refresh'],
    'Log cleanup must stay fail-closed until the refreshed ledger has been read back successfully.'
  );

  let releaseFirstOperation;
  const firstOperationGate = new Promise((resolve) => {
    releaseFirstOperation = resolve;
  });
  const coordinator = createAutomaticTokenLedgerMaintenanceCoordinator();
  const busyTransitions = [];
  const unsubscribeCoordinator = coordinator.subscribe(() => {
    busyTransitions.push(coordinator.isBusy());
  });
  const firstOperation = coordinator.startAutomatic('entry-a', async () => {
    await firstOperationGate;
    return 'first-complete';
  });
  assert.ok(firstOperation);
  assert.equal(coordinator.getInFlight()?.kind, 'automatic');
  assert.equal(coordinator.getInFlight()?.promise, firstOperation);
  assert.equal(
    coordinator.startAutomatic('entry-b', async () => 'should-not-start'),
    null,
    'A second page instance must join the shared in-flight operation instead of starting another refresh.'
  );
  assert.equal(
    coordinator.startManual(async () => 'manual-should-not-start'),
    null,
    'Manual maintenance must share the same global mutex as automatic maintenance.'
  );
  releaseFirstOperation();
  assert.equal(await firstOperation, 'first-complete');
  await Promise.resolve();
  assert.equal(coordinator.getInFlight(), null);
  assert.equal(coordinator.hasStarted('entry-a'), true);
  assert.equal(
    coordinator.startAutomatic('entry-a', async () => 'should-not-repeat'),
    null,
    'StrictMode or a remount of the same history entry must not rerun maintenance.'
  );
  const secondOperation = coordinator.startManual(async () => 'manual-complete');
  assert.equal(coordinator.getInFlight()?.kind, 'manual');
  assert.equal(await secondOperation, 'manual-complete');
  await Promise.resolve();
  const thirdOperation = coordinator.startAutomatic('entry-b', async () => 'second-complete');
  assert.equal(await thirdOperation, 'second-complete');
  await Promise.resolve();
  unsubscribeCoordinator();
  assert.deepEqual(busyTransitions, [true, false, true, false, true, false]);

  const settlementTracker = createTokenLedgerMaintenanceSettlementTracker(false);
  assert.equal(settlementTracker.update(false), false);
  assert.equal(settlementTracker.update(true), false);
  assert.equal(settlementTracker.update(true), false);
  assert.equal(
    settlementTracker.update(false),
    true,
    'A page that observed shared maintenance must detect the busy-to-idle settlement exactly once.'
  );
  assert.equal(settlementTracker.update(false), false);

  const [sidebarNav, pageTransition, pageTransitionLayer, usageStatisticsPage] =
    await Promise.all(
      [
        'src/components/layout/SidebarNav.tsx',
        'src/components/common/PageTransition.tsx',
        'src/components/common/PageTransitionLayer.ts',
        'src/pages/UsageStatisticsPage.tsx',
      ].map((relativePath) => fs.readFile(path.join(repoRoot, relativePath), 'utf8'))
    );

  assert.match(
    sidebarNav,
    /createUsageStatisticsAutoMaintenanceState\(\)/,
    'The sidebar must attach an explicit intent only to a user-selected statistics entry.'
  );
  assert.match(
    pageTransition,
    /const navigationType = useNavigationType\(\);/,
    'The transition shell must capture the real navigation type outside the overridden route tree.'
  );
  assert.match(
    pageTransition,
    /navigationType: layer\.navigationType/,
    'Each rendered layer must expose the navigation type that created that entry.'
  );
  assert.match(
    pageTransitionLayer,
    /navigationType: NavigationType;/,
    'The layer context must carry navigation type into pages rendered with an override location.'
  );
  assert.match(
    usageStatisticsPage,
    /pageTransitionLayer\?\.navigationType === 'PUSH'/,
    'Only an active PUSH entry may suppress the ordinary initial ledger read and start maintenance.'
  );
  assert.match(
    usageStatisticsPage,
    /if \(!\(pageTransitionLayer\?\.isCurrentLayer \?\? true\)\) return;\s*if \(connectionStatus !== 'connected'\) return;\s*if \(initialDataLoadStartedRef\.current\) return;/,
    'An exiting or stacked layer must never restart the ordinary initial data load.'
  );
  assert.doesNotMatch(
    usageStatisticsPage,
    /refreshAndPruneTokenLedger/,
    'Automatic maintenance must keep the refresh and prune steps separate for the read-back gate.'
  );
  assert.match(
    usageStatisticsPage,
    /automaticTokenLedgerMaintenanceCoordinator\.startManual\(async \(\) =>/,
    'Manual refresh and prune actions must share the same cross-page mutex as automatic maintenance.'
  );
  assert.match(
    usageStatisticsPage,
    /sharedTokenLedgerMaintenanceBusy/,
    'Every statistics page instance must disable maintenance controls while another instance is busy.'
  );
  assert.match(
    usageStatisticsPage,
    /createTokenLedgerMaintenanceSettlementTracker\(\s*automaticTokenLedgerMaintenanceCoordinator\.isBusy\(\)\s*\)/,
    'Every page instance must remember whether it observed shared maintenance in progress.'
  );
  assert.match(
    usageStatisticsPage,
    /sharedTokenLedgerMaintenanceSettlementTrackerRef\.current\.update\(\s*sharedTokenLedgerMaintenanceBusy\s*\)[\s\S]*?pendingSharedTokenLedgerReloadRef\.current = true;/,
    'A non-participating page must schedule a fresh ledger read when shared maintenance settles.'
  );
  assert.match(
    usageStatisticsPage,
    /pendingSharedTokenLedgerReloadRef\.current = false;\s*void loadTokenLedger\(true, \{ showStatus: false \}\)/,
    'The pending settlement reload must force a network ledger read once the page is current.'
  );
  assert.match(
    usageStatisticsPage,
    /window\.setInterval\(\(\) => \{[\s\S]*?if \(\s*!tokenLedgerMaintenanceInFlightRef\.current &&\s*!automaticTokenLedgerMaintenanceCoordinator\.isBusy\(\)\s*\)/,
    'Periodic ledger reads must stay paused for maintenance started by any page instance.'
  );
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
