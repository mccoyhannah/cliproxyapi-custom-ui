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
  statusFailureHistorySource,
  authFilesFailureHistoryHookSource,
  authFilesStylesSource,
  aiProvidersStylesSource,
  ...localeSources
] =
  await Promise.all([
    readSource('src/utils/recentRequests.ts'),
    readSource('src/components/providers/ProviderStatusBar.tsx'),
    readSource('src/features/authFiles/components/AuthFileCard.tsx'),
    readSource('src/pages/AuthFilesPage.tsx'),
    readSource('src/features/authFiles/hooks/useAuthFilesData.ts'),
    readSource('src/features/authFiles/statusFailureHistory.ts'),
    readSource('src/features/authFiles/hooks/useAuthFilesFailureHistory.ts'),
    readSource('src/pages/AuthFilesPage.module.scss'),
    readSource('src/pages/AiProvidersPage.module.scss'),
    ...['zh-CN', 'zh-TW', 'en', 'ru'].map((locale) =>
      readSource(`src/i18n/locales/${locale}.json`)
    ),
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
  /failureDetailsByBlockIndex\?:\s*Readonly<Record<number,\s*StatusBarFailureDetail\[\]>>/,
  'The reusable status bar must accept persisted failure details for each request bucket.'
);
assert.doesNotMatch(
  providerStatusBarSource,
  /failureDetailBlockIndex|failureDetailUnavailableLabel/,
  'The status bar must not keep the old single-bucket clue contract or technical fallback prop.'
);
assert.match(
  providerStatusBarSource,
  /failureDetailsByBlockIndex\?\.\[idx\]\s*\?\?\s*\[\]/,
  'Each request bucket must read only its own persisted details.'
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
assert.doesNotMatch(
  providerStatusBarSource,
  /tooltipPreferredWidth|activeTooltipHasFailure|width:\s*tooltipPosition/,
  'Tooltips must not reserve a fixed 180px or 280px inline width.'
);
assert.match(
  providerStatusBarSource,
  /tooltipRef\.current\?\.offsetWidth/,
  'Tooltip placement must use the rendered content width.'
);
assert.match(
  providerStatusBarSource,
  /new ResizeObserver\(updateTooltipPosition\)/,
  'An open tooltip must reposition when live text changes its size.'
);
assert.match(
  providerStatusBarSource,
  /window\.setTimeout\([\s\S]*?setActiveTooltip\(null\)[\s\S]*?,\s*160\)/,
  'Pointer leave must allow enough time to cross the gap from a block into the portal tooltip.'
);
assert.match(
  providerStatusBarSource,
  /data-status-tooltip-content="true"[\s\S]*?tabIndex=\{0\}/,
  'Scrollable tooltip content must be keyboard-focusable.'
);
assert.match(
  providerStatusBarSource,
  /const focusTooltipContent[\s\S]*?data-status-tooltip-content[\s\S]*?focus\(\)/,
  'The status bar must expose a focused entry point into scrollable tooltip content.'
);
assert.match(
  providerStatusBarSource,
  /event\.key === 'Enter'[\s\S]*?focusTooltipContent\(\)/,
  'Enter on a status block must move keyboard focus into the open tooltip content.'
);
assert.match(
  providerStatusBarSource,
  /Math\.min\([\s\S]*?tooltipRef\.current\?\.offsetHeight[\s\S]*?viewportHeight - 24/,
  'Tooltip placement must cap the measured height to the visible viewport.'
);

assert.match(
  authFileCardSource,
  /failureDetailsByBlockIndex=\{failureDetailsByBlockIndex\}/,
  'Auth-file cards must pass persisted details for every matching request bucket.'
);
assert.match(
  authFileCardSource,
  /getStatusFailureDetailsForBlock\(failureHistoryBuckets,\s*detail/,
  'Auth-file cards must match history by the exact request bucket instead of copying one clue.'
);
assert.doesNotMatch(
  authFileCardSource,
  /failureDetailUnavailableLabel|requestFailureDetailUnavailableLabel|errorClueLabel/,
  'Auth-file cards must not carry explanatory fallback copy or a generic current-clue label.'
);
assert.doesNotMatch(
  [providerStatusBarSource, authFileCardSource, ...localeSources].join('\n'),
  /当前 CPA 只记录|没有可关联的具体原因|no specific reason could be linked|конкретную причину связать/i,
  'Compact tooltips and translations must not contain technical explanatory asides.'
);
assert.doesNotMatch(
  statusFailureHistorySource,
  /if \(!normalized\) return message\.trim\(\);/,
  'Sanitization must never fall back to the original unredacted message.'
);
assert.match(
  authFilesFailureHistoryHookSource,
  /hasStatusWarning[\s\S]*?!file\.disabled[\s\S]*?!isRuntimeOnlyAuthFile\(file\)[\s\S]*?findLatestCapturableFailureBlock/,
  'Only an active, enabled, non-runtime status clue may be captured into a recent failed bucket.'
);
assert.match(
  authFilesFailureHistoryHookSource,
  /hasLatestSuccessfulRequestBlock[\s\S]*?clearActiveStatusFailure/,
  'A later successful request bucket must clear the stale active warning episode.'
);
assert.match(
  authFilesFailureHistoryHookSource,
  /parseStatusFailureHistory\(event\.newValue/,
  'Cross-tab merging must include the storage-event snapshot even if localStorage was overwritten again.'
);
assert.match(
  statusFailureHistorySource,
  /api\[_-\]\?key[\s\S]*?auth[\s\S]*?token[\s\S]*?cookie[\s\S]*?session[\s\S]*?credential[\s\S]*?password[\s\S]*?secret/,
  'Persisted status history sanitization must cover credential, Cookie, and session fields.'
);
assert.match(
  authFileCardSource,
  /const authFileStatusProblem\s*=\s*[\s\S]*?hasStatusWarning\s*\?\s*parsedAuthFileStatusProblem\s*:\s*null/,
  'Healthy status text must not surface as an unknown-error badge after a prior failed bucket.'
);
assert.match(
  authFileCardSource,
  /label:\s*getStatusBadgeLabel\(detail\.category\)/,
  'Failed buckets should lead with the stored concrete category.'
);
assert.match(
  statusFailureHistorySource,
  /STATUS_FAILURE_HISTORY_TTL_MS\s*=\s*3\s*\*\s*60\s*\*\s*60\s*\*\s*1000/,
  'Captured failure reasons must have a three-hour lifetime.'
);
assert.match(
  authFilesPageSource,
  /useAuthFilesFailureHistory\(files,\s*statusDataByFileName\)/,
  'The page must capture status history for the complete auth-file list.'
);
assert.match(
  authFilesPageSource,
  /failureHistoryBuckets=\{failureHistoryByFileName\.get\(file\.name\) \?\? \[\]\}/,
  'Each card must receive only its own persisted buckets.'
);

for (const source of [authFilesStylesSource, aiProvidersStylesSource]) {
  assert.match(source, /\.statusTooltip\s*\{[\s\S]*?width:\s*max-content;/);
  assert.match(source, /\.statusTooltip\s*\{[\s\S]*?max-width:\s*min\(280px,\s*calc\(100vw - 24px\)\);/);
  assert.match(source, /\.tooltipTime\s*\{[\s\S]*?white-space:\s*nowrap;/);
  assert.match(source, /\.tooltipStats\s*\{[\s\S]*?white-space:\s*nowrap;/);
  assert.match(source, /\.tooltipFailureMessage\s*\{[\s\S]*?overflow-wrap:\s*anywhere;/);
  assert.match(source, /\.statusTooltipContent\s*\{[\s\S]*?max-height:\s*calc\(100vh - 48px\);/);
  assert.match(source, /\.statusTooltipContent\s*\{[\s\S]*?overflow-y:\s*auto;/);
}

const expectedUnavailableLabels = ['原因未记录', '原因未記錄', 'Reason not recorded', 'Причина не записана'];
localeSources.forEach((source, index) => {
  const locale = JSON.parse(source);
  assert.equal(locale.auth_files.status_failure_detail_unavailable, expectedUnavailableLabels[index]);
  assert.equal(locale.status_bar.failure_reason_unavailable, expectedUnavailableLabels[index]);
});
assert.match(
  providerStatusBarSource,
  /defaultValue:\s*'原因未记录'/,
  'The source fallback must stay as concise as the translated copy.'
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
