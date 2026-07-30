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
  'lazyTokenLedgerDetails.ts'
);
const source = await fs.readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    isolatedModules: true,
  },
});

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-usage-ledger-dedupe-'));
const modulePath = path.join(tmpRoot, 'lazyTokenLedgerDetails.mjs');

try {
  await fs.writeFile(modulePath, transpiled.outputText, 'utf8');
  const { createLazyTokenLedgerDetailLookup } = await import(pathToFileURL(modulePath).href);

  let loadCount = 0;
  const firstDetail = { requestId: 'request-1' };
  const lookup = createLazyTokenLedgerDetailLookup(async () => {
    loadCount += 1;
    await Promise.resolve();
    return new Map([['request-1', firstDetail]]);
  });

  const [firstResult, missingResult, repeatedResult] = await Promise.all([
    lookup('request-1'),
    lookup('missing-request'),
    lookup('request-1'),
  ]);

  assert.equal(firstResult, firstDetail);
  assert.equal(missingResult, undefined);
  assert.equal(repeatedResult, firstDetail);
  assert.equal(loadCount, 1, 'Concurrent and repeated fallbacks must share one full ledger read.');

  assert.equal(await lookup('request-1'), firstDetail);
  assert.equal(loadCount, 1, 'A settled ledger read must be reused for later request details.');

  let failedLoadCount = 0;
  const failedLookup = createLazyTokenLedgerDetailLookup(async () => {
    failedLoadCount += 1;
    throw new Error('ledger unavailable');
  });

  await assert.rejects(failedLookup('request-1'), /ledger unavailable/);
  await assert.rejects(failedLookup('request-2'), /ledger unavailable/);
  assert.equal(failedLoadCount, 1, 'A failed fallback must not start a full ledger reload per request.');

  const [usageStatisticsPage, sidebarNav] = await Promise.all(
    [
      'src/pages/UsageStatisticsPage.tsx',
      'src/components/layout/SidebarNav.tsx',
    ].map((relativePath) => fs.readFile(path.join(repoRoot, relativePath), 'utf8'))
  );

  assert.doesNotMatch(
    usageStatisticsPage,
    /<TokenLedgerPanel\b/,
    'The request diagnostics page must not render the duplicate Token ledger dashboard.'
  );
  assert.doesNotMatch(
    usageStatisticsPage,
    /更新 Token 台账/,
    'The request diagnostics page must not expose Token ledger maintenance controls.'
  );
  assert.doesNotMatch(
    usageStatisticsPage,
    /runAutomaticTokenLedgerMaintenance|shouldStartAutomaticTokenLedgerMaintenance/,
    'Opening the request diagnostics page must not trigger automatic Token ledger maintenance.'
  );
  assert.doesNotMatch(
    usageStatisticsPage,
    /void loadTokenLedger\(/,
    'Initial and periodic request refreshes must not load the full Token ledger.'
  );
  assert.doesNotMatch(
    sidebarNav,
    /createUsageStatisticsAutoMaintenanceState/,
    'Navigation to request diagnostics must not attach an automatic ledger-maintenance intent.'
  );
  assert.match(
    usageStatisticsPage,
    /createLazyTokenLedgerDetailLookup/,
    'The page must retain a lazy Token ledger fallback for missing request logs.'
  );
  assert.match(
    usageStatisticsPage,
    /status === 404[\s\S]*?await tokenLedgerDetailLookupRef\.current\(id\)/,
    'Only a missing request log should consult the lazy Token ledger fallback.'
  );
  assert.match(
    usageStatisticsPage,
    /Token 总账与价格由 CPA Pulse 提供/,
    'The page must explain where the removed Token ledger dashboard now lives.'
  );
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
