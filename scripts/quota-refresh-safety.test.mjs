import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

async function readSourceTree(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const sources = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      sources.push(...(await readSourceTree(entryPath)));
    } else if (/\.(?:ts|tsx)$/.test(entry.name)) {
      sources.push({ path: entryPath, source: await fs.readFile(entryPath, 'utf8') });
    }
  }
  return sources;
}

const [appSource, authFilesSource, authFilesFocusSource, quotaLoaderSource, sourceTree] =
  await Promise.all([
    fs.readFile(path.join(repoRoot, 'src', 'App.tsx'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src', 'pages', 'AuthFilesPage.tsx'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src', 'router', 'authFilesFocus.ts'), 'utf8'),
    fs.readFile(path.join(repoRoot, 'src', 'components', 'quota', 'useQuotaLoader.ts'), 'utf8'),
    readSourceTree(path.join(repoRoot, 'src')),
  ]);

assert.match(
  appSource,
  /\{\s*path:\s*['"]\/['"],\s*element:\s*<Navigate\s+to=['"]\/dashboard['"]\s+replace\s*\/>\s*\}/,
  'The root route must redirect directly to /dashboard.'
);
assert.doesNotMatch(
  appSource,
  /requestAuthFilesInitialQuotaRefresh|AuthFilesInitialQuotaRedirect/,
  'The app shell must not create an automatic quota-refresh ticket.'
);

const headerRefreshMatch = authFilesSource.match(
  /const handleHeaderRefresh = useCallback\(async \(\) => \{([\s\S]*?)\n\s*\}, \[([\s\S]*?)\]\);/
);
assert.ok(headerRefreshMatch, 'AuthFiles header refresh callback must exist.');
assert.match(headerRefreshMatch[1], /loadFiles\s*\(/, 'Normal refresh must reload auth files.');
assert.match(headerRefreshMatch[1], /loadExcluded\s*\(/, 'Normal refresh must reload exclusions.');
assert.match(headerRefreshMatch[1], /loadModelAlias\s*\(/, 'Normal refresh must reload model aliases.');
assert.doesNotMatch(
  headerRefreshMatch[0],
  /loadCodexQuota|refreshAuthFilesAndCodexQuota/,
  'Normal refresh must never load Codex quota.'
);
assert.match(
  authFilesSource,
  /useHeaderRefresh\(handleHeaderRefresh,\s*isCurrentLayer\);/,
  'AuthFiles must register its header refresh handler only for the current transition layer.'
);
assert.doesNotMatch(
  authFilesSource,
  /consumeAuthFilesInitialQuotaRefresh|initialQuotaRefresh(InFlight|Consumed)/,
  'AuthFiles must not consume or track an automatic quota-refresh ticket.'
);
assert.doesNotMatch(
  authFilesFocusSource,
  /INITIAL_QUOTA_REFRESH|InitialQuotaRefresh|initial-quota-refresh/,
  'The obsolete automatic quota-refresh ticket mechanism must be removed.'
);

assert.match(
  quotaLoaderSource,
  /const REFRESH_ALL_BATCH_SIZE = 2;/,
  'Refresh-all must process at most two auth files per batch.'
);
assert.match(
  quotaLoaderSource,
  /const REFRESH_ALL_MIN_DELAY_MS = 800;/,
  'Refresh-all must wait at least 800ms between batches.'
);
assert.match(
  quotaLoaderSource,
  /const REFRESH_ALL_MAX_DELAY_MS = 1800;/,
  'Refresh-all must cap the randomized inter-batch delay at 1800ms.'
);

const dormantAutoRefreshSources = sourceTree
  .filter(({ source }) => /CodexQuotaBackgroundRefresher|autoRefreshOnReady/.test(source))
  .map(({ path: sourcePath, source }) => `${path.relative(repoRoot, sourcePath)}\n${source}`)
  .join('\n');
assert.equal(
  dormantAutoRefreshSources,
  '',
  'Dormant background or on-ready quota refresh code must not remain available for accidental mounting.'
);

console.log('quota refresh safety invariants passed');
