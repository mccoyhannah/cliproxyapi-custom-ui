import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = async (relativePath) =>
  (await fs.readFile(path.join(repoRoot, relativePath), 'utf8')).replace(/\r\n/g, '\n');

const [
  recentRequestsSource,
  providerStatusBarSource,
  authFileCardSource,
  authFilesPageSource,
  authFilesDataSource,
] =
  await Promise.all([
    readSource('src/utils/recentRequests.ts'),
    readSource('src/components/providers/ProviderStatusBar.tsx'),
    readSource('src/features/authFiles/components/AuthFileCard.tsx'),
    readSource('src/pages/AuthFilesPage.tsx'),
    readSource('src/features/authFiles/hooks/useAuthFilesData.ts'),
  ]);

const transpiledRecentRequests = ts.transpileModule(recentRequestsSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const recentRequests = await import(
  `data:text/javascript;base64,${Buffer.from(transpiledRecentRequests).toString('base64')}`
);

const nowMs = new Date(2026, 6, 14, 19, 5, 0, 0).getTime();
const statusData = recentRequests.statusBarDataFromRecentRequests(
  [{ time: '19:00-19:10', success: 0, failed: 1 }],
  nowMs
);
const latestBlock = statusData.blockDetails.at(-1);
assert.equal(latestBlock.timeLabel, '19:00-19:10');
assert.equal(latestBlock.startTime, new Date(2026, 6, 14, 19, 0, 0, 0).getTime());
assert.equal(latestBlock.endTime, new Date(2026, 6, 14, 19, 10, 0, 0).getTime());

const midnightStatusData = recentRequests.statusBarDataFromRecentRequests(
  [{ time: '23:50-00:00', success: 0, failed: 1 }],
  new Date(2026, 6, 14, 0, 5, 0, 0).getTime()
);
assert.equal(
  midnightStatusData.blockDetails.at(-1).startTime,
  new Date(2026, 6, 13, 23, 50, 0, 0).getTime(),
  'A backend bucket just before midnight must be anchored to the previous local day.'
);

assert.match(
  providerStatusBarSource,
  /failureDetail\?:\s*StatusBarFailureDetail\s*\|\s*null/,
  'The reusable status bar must accept an optional, explicitly typed failure detail.'
);
assert.match(
  providerStatusBarSource,
  /failureDetailUnavailableLabel\?:\s*string/,
  'The status bar must accept an honest fallback when CPA recorded only a failure count.'
);
assert.match(
  providerStatusBarSource,
  /failureDetailBlockIndex\?:\s*number\s*\|\s*null/,
  'A current failure clue must identify the single bucket it can be linked to.'
);
assert.match(
  providerStatusBarSource,
  /failureDetailBlockIndex === idx\s*\?\s*failureDetail\s*:\s*null/,
  'The current status clue must not be copied into every historical failed bucket.'
);
assert.match(
  providerStatusBarSource,
  /<button[\s\S]*?aria-expanded=/,
  'Each status block must be keyboard-focusable and expose its tooltip state.'
);
assert.match(
  providerStatusBarSource,
  /event\.key === 'Escape'/,
  'Status detail tooltips must close with Escape.'
);
assert.match(
  providerStatusBarSource,
  /tabIndex=\{idx === focusableBlockIndex \? 0 : -1\}/,
  'Each status bar must expose only one keyboard tab stop.'
);
assert.match(
  providerStatusBarSource,
  /event\.key === 'ArrowLeft'[\s\S]*?event\.key === 'ArrowRight'/,
  'Arrow keys must move between status buckets inside the roving tab stop.'
);
assert.match(
  providerStatusBarSource,
  /createPortal\([\s\S]*?document\.body/,
  'Status detail tooltips must render outside overflow-hidden cards.'
);
assert.match(
  providerStatusBarSource,
  /const tooltipPreferredWidth = activeTooltipHasFailure \? 280 : 180;/,
  'Success and idle tooltips must stay compact instead of reserving failure-detail width.'
);

assert.match(
  authFileCardSource,
  /failureDetail=\{requestFailureDetail\}/,
  'Auth-file cards must pass the current sanitized status clue into failed request blocks.'
);
assert.match(
  authFileCardSource,
  /failureDetailBlockIndex=\{latestFailureRequestWindow\?\.index \?\? null\}/,
  'Auth-file cards must link the current clue only to the latest failed request window.'
);
assert.match(
  authFileCardSource,
  /failureDetailUnavailableLabel=/,
  'Auth-file cards must explain when the backend did not retain a concrete reason.'
);
assert.doesNotMatch(
  authFileCardSource,
  /不是逐请求日志|not an exact per-request log/i,
  'The compact tooltip must not repeat a long explanatory footer.'
);
assert.doesNotMatch(
  authFileCardSource,
  /if \(!normalized\) return message\.trim\(\);/,
  'Sanitization must never fall back to the original unredacted message.'
);
assert.match(
  authFileCardSource,
  /const shouldShowRequestFailureDetail\s*=\s*[\s\S]*?hasStatusWarning[\s\S]*?!credentialInvalidHasRecovery/,
  'Only an active non-healthy status clue may be attached to failed buckets.'
);
assert.match(
  authFileCardSource,
  /id\[_-\]\?token[\s\S]*?credential[\s\S]*?password[\s\S]*?secret/,
  'Status tooltip sanitization must cover quoted JSON credential fields.'
);
assert.match(
  authFileCardSource,
  /const authFileStatusProblem\s*=\s*[\s\S]*?hasStatusWarning\s*\?\s*parsedAuthFileStatusProblem\s*:\s*null/,
  'Healthy status text must not surface as an unknown-error badge after a prior failed bucket.'
);
assert.match(
  authFileCardSource,
  /label:\s*parsedAuthFileStatusProblem[\s\S]*?\?\s*getStatusBadgeLabel\(parsedAuthFileStatusProblem\.category\)/,
  'Failed buckets should lead with the concrete category instead of a generic current-clue label.'
);

assert.match(
  authFilesPageSource,
  /const AUTH_FILES_STATUS_REFRESH_INTERVAL_MS = 10_000;/,
  'Visible auth-file status should refresh every ten seconds.'
);
assert.match(
  authFilesPageSource,
  /document\.visibilityState !== 'visible'/,
  'Polling must skip work while the document is hidden.'
);
assert.match(
  authFilesPageSource,
  /document\.addEventListener\('visibilitychange',[\s\S]*?refreshAuthFilesStatus/,
  'Returning to a visible tab must trigger an immediate status refresh.'
);

const refreshCallback = authFilesPageSource.match(
  /const refreshAuthFilesStatus = useCallback\(async \(\) => \{([\s\S]*?)\n\s*\}, \[([\s\S]*?)\]\);/
);
assert.ok(refreshCallback, 'A dedicated auth-file status refresh callback must exist.');
assert.match(refreshCallback[1], /loadFiles\s*\(/, 'Status polling must reload auth-file metadata.');
assert.doesNotMatch(
  refreshCallback[0],
  /quota|loadCodexQuota|refreshAuthFilesAndCodexQuota/i,
  'Status polling must never trigger quota requests.'
);
assert.match(
  refreshCallback[1],
  /rememberDisplayNames:\s*false/,
  'Ten-second status polling must not rewrite display-name memory.'
);
assert.match(
  authFilesDataSource,
  /rememberDisplayNames\?:\s*boolean/,
  'The auth-file loader must expose a switch for status-only polling.'
);
assert.match(
  authFilesDataSource,
  /if \(options\.rememberDisplayNames !== false\)\s*\{\s*rememberAuthFileDisplayNames\(finalFiles\)/,
  'Display-name memory writes must be skipped when status polling opts out.'
);

console.log('auth status observability invariants passed');
