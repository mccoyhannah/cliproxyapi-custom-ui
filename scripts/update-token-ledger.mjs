#!/usr/bin/env node

import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  LOG_FILE_PATTERN,
  buildRequestDedupeKey,
  dedupeLedgerEntries,
  emptyTokenUsage,
  extractActualModel,
  extractConfiguredModel,
  parseLogFilename,
} from './lib/token-log-core.mjs';
import { readTokenResponseLog } from './lib/token-log-reader.mjs';
import {
  createTokenLedgerMaintenanceCore,
  TokenLedgerMaintenanceError,
  toSafeTokenLedgerMaintenanceError,
  withTokenLedgerMaintenanceLock,
} from './lib/token-ledger-maintenance-core.mjs';

const VERSION = 1;
const DEFAULT_INSTALL_DIR = 'D:\\CLIProxyAPI';
const DEFAULT_LOG_STABILITY_DELAY_MS = 750;
const DEFAULT_PRUNE_ACTIVE_WINDOW_MINUTES = 5;
const PRUNE_ERROR_SAMPLE_LIMIT = 10;
const EMBEDDED_LEDGER_ID = 'cpamc-token-ledger';
const LOW_SPACE_ERROR_CODE = 'TOKEN_LEDGER_LOW_SPACE';
const DEFAULT_MIN_FREE_BYTES = 2 * 1024 ** 3;
const DEFAULT_MIN_FREE_RATIO = 0.02;
const DEFAULT_CUSTOM_UI_DIR = 'D:\\CLIProxyAPI_Maintenance\\custom-ui';
const PRODUCTION_LEDGER_PATH = path.join(
  DEFAULT_INSTALL_DIR,
  'usage-backups',
  'token-ledger',
  'ledger.json'
);
const PRODUCTION_PROJECTION_PATH = path.join(DEFAULT_INSTALL_DIR, 'static', 'token-ledger.json');
const PRODUCTION_LOG_ROOTS = [
  path.join(DEFAULT_INSTALL_DIR, 'logs'),
  path.join(DEFAULT_INSTALL_DIR, 'auths', 'logs'),
];
const PRODUCTION_MAINTENANCE_LOCK_PATH = `${PRODUCTION_LEDGER_PATH}.maintenance.lock`;
const MAINTENANCE_PATH_ARGUMENTS = new Set([
  'logs-dir',
  'ledger-dir',
  'static-dir',
  'ledger-path',
  'projection-path',
]);
const MAINTENANCE_INCOMPATIBLE_FLAGS = [
  'rebuild',
  'dryRun',
  'embed',
  'embed-full',
  'no-embed',
  'prune-recorded-logs',
  'prune-only',
  'rescue-low-space',
  'min-free-bytes',
];
const parseArgs = (argv) => {
  const result = {
    dryRun: false,
    rebuild: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    if (arg === '--rebuild') {
      result.rebuild = true;
      continue;
    }
    if (arg === '--help') {
      result.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }

  return result;
};

const readJson = async (filePath) => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to read JSON file ${filePath}: ${message}`, { cause: error });
  }
};

const atomicWriteText = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}-${Date.now()}-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tempPath, value, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(tempPath, filePath);
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => {});
  }
};

const pathExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const normalizeSourceDir = (logsDir) => path.normalize(path.resolve(logsDir));
const compareSourceDir = (logsDir) => normalizeSourceDir(logsDir).replace(/\\/g, '/').toLowerCase();

const makeSourceKey = (logsDir, fileName) => `${normalizeSourceDir(logsDir)}::${fileName}`;

const resolveLogDirs = (args, installDir) => {
  if (args['logs-dir']) return [args['logs-dir']];
  return [path.join(installDir, 'logs'), path.join(installDir, 'auths', 'logs')];
};

const resolveSafeLegacyLogRoots = async (logsDirs, fsAdapter = fs) => {
  const io = fsAdapter;
  const roots = [];
  const seen = new Set();
  for (const rawLogsDir of logsDirs) {
    const logicalPath = normalizeSourceDir(rawLogsDir);
    let stats;
    try {
      stats = await io.lstat(logicalPath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error('CLIProxyAPI log root must be an ordinary directory.');
    }
    const realPath = normalizeSourceDir(await io.realpath(logicalPath));
    const realKey = compareSourceDir(realPath);
    if (realKey !== compareSourceDir(logicalPath) || seen.has(realKey)) {
      throw new Error('CLIProxyAPI log root must not be a junction, symlink, or duplicate.');
    }
    seen.add(realKey);
    roots.push({ logicalPath, realPath });
  }
  if (roots.length === 0) {
    throw new Error(
      `No CLIProxyAPI log directories found: ${logsDirs.map(normalizeSourceDir).join(', ')}`
    );
  }
  return roots;
};

const escapeJsonForHtml = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const buildEmbeddedLedgerSummary = (projection) => ({
  version: projection.version,
  generatedAt: projection.generatedAt,
  source: projection.source,
  coverage: projection.coverage,
  entries: [],
  embeddedMode: 'summary',
  externalLedgerUrl: '/token-ledger.json',
});

const buildEmbeddedLedgerScript = (projection, mode) => {
  const payload = mode === 'full' ? projection : buildEmbeddedLedgerSummary(projection);
  return `<script id="${EMBEDDED_LEDGER_ID}" type="application/json">${escapeJsonForHtml(payload)}</script>`;
};

const embedLedgerInHtml = async (htmlPath, projection, mode) => {
  if (!(await pathExists(htmlPath))) return false;

  const html = await fs.readFile(htmlPath, 'utf8');
  const script = buildEmbeddedLedgerScript(projection, mode);
  const existingPattern = new RegExp(
    `\\s*<script[^>]*id=["']${EMBEDDED_LEDGER_ID}["'][^>]*>[\\s\\S]*?<\\/script>`,
    'gi'
  );
  const htmlWithoutLedger = html.replace(existingPattern, '');
  const closingBodyMatches = [...htmlWithoutLedger.matchAll(/<\/body>/gi)];

  let nextHtml;
  if (closingBodyMatches.length > 0) {
    const lastClosingBody = closingBodyMatches[closingBodyMatches.length - 1];
    const insertAt = lastClosingBody.index;
    nextHtml = `${htmlWithoutLedger.slice(0, insertAt)}\n${script}\n${htmlWithoutLedger.slice(insertAt)}`;
  } else {
    nextHtml = `${htmlWithoutLedger}\n${script}\n`;
  }

  if (nextHtml === html) return false;
  await atomicWriteText(htmlPath, nextHtml);
  return true;
};

const removeEmbeddedLedgerFromHtml = async (htmlPath) => {
  if (!(await pathExists(htmlPath))) return false;

  const html = await fs.readFile(htmlPath, 'utf8');
  const existingPattern = new RegExp(
    `\\s*<script[^>]*id=["']${EMBEDDED_LEDGER_ID}["'][^>]*>[\\s\\S]*?<\\/script>`,
    'gi'
  );
  const nextHtml = html.replace(existingPattern, '');

  if (nextHtml === html) return false;
  await atomicWriteText(htmlPath, nextHtml);
  return true;
};

const numberValue = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return null;
};

const nonNegativeInteger = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
};

const minFreeBytesOverride = (value) => {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`--min-free-bytes must be a non-negative safe integer: ${value}`);
  }
  return parsed;
};

const nearestExistingAncestor = async (targetPath) => {
  let currentPath = path.resolve(targetPath);

  while (true) {
    try {
      await fs.access(currentPath);
      return currentPath;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parentPath = path.dirname(currentPath);
      if (parentPath === currentPath) throw error;
      currentPath = parentPath;
    }
  }
};

const inspectFreeSpace = async (targetPaths, overrideBytes, writeBytes = 0) => {
  const checks = [];
  const checkedRoots = new Set();

  for (const targetPath of targetPaths) {
    const probePath = await nearestExistingAncestor(path.dirname(targetPath));
    const rootPath = path.parse(probePath).root.toLowerCase();
    if (checkedRoots.has(rootPath)) continue;
    checkedRoots.add(rootPath);

    const stats = await fs.statfs(probePath);
    const blockSize = Number(stats.bsize);
    const capacityBytes = blockSize * Number(stats.blocks);
    const availableBytes = blockSize * Number(stats.bavail ?? stats.bfree);
    const reserveBytes =
      overrideBytes ??
      Math.max(DEFAULT_MIN_FREE_BYTES, Math.ceil(capacityBytes * DEFAULT_MIN_FREE_RATIO));
    const requiredBytes = reserveBytes + Math.max(0, writeBytes);

    checks.push({
      targetPath,
      probePath,
      capacityBytes,
      availableBytes,
      reserveBytes,
      writeBytes,
      requiredBytes,
      lowSpace: availableBytes < requiredBytes,
    });
  }

  return checks;
};

const assertEnoughFreeSpace = async (targetPaths, overrideBytes, writeBytes = 0, details = {}) => {
  const checks = await inspectFreeSpace(targetPaths, overrideBytes, writeBytes);
  const failed = checks.find((check) => check.lowSpace);
  if (!failed) return checks;

  const error = new Error(
    `Token ledger refresh requires ${failed.requiredBytes} free bytes but only ${failed.availableBytes} are available.`
  );
  error.code = LOW_SPACE_ERROR_CODE;
  error.details = {
    ...details,
    targetPath: failed.targetPath,
    probePath: failed.probePath,
    capacityBytes: failed.capacityBytes,
    availableBytes: failed.availableBytes,
    reserveBytes: failed.reserveBytes,
    writeBytes: failed.writeBytes,
    requiredBytes: failed.requiredBytes,
  };
  throw error;
};

const fingerprintForStats = (stats) => `${stats.size}:${Math.floor(stats.mtimeMs)}`;

const parseFilename = (fileName, stats) => {
  return parseLogFilename(fileName, Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null);
};

const parseLogFile = async (
  filePath,
  fileName,
  stats,
  sourceDir,
  { stable = true, fsAdapter = fs } = {}
) => {
  const filenameInfo = parseFilename(fileName, stats);
  const { response, parsed: parsedResponse } = await readTokenResponseLog(filePath, stats, {
    stable,
    fsAdapter,
  });
  const responseText = response.status === 'complete' ? response.text : '';
  const configuredModel = responseText ? extractConfiguredModel(responseText) : null;
  const actualModel =
    parsedResponse.model ?? (responseText ? extractActualModel(responseText) : null);
  const tokenUsage = ['ambiguous', 'parse-error'].includes(parsedResponse.status)
    ? emptyTokenUsage('error')
    : parsedResponse.tokenUsage.status === 'available'
      ? parsedResponse.tokenUsage
      : emptyTokenUsage('unreported');

  return {
    fileName,
    fileType: filenameInfo.fileType,
    timestampMs: filenameInfo.timestampMs,
    requestId: filenameInfo.requestId,
    sourceDir: normalizeSourceDir(sourceDir),
    sourceKey: makeSourceKey(sourceDir, fileName),
    detailStatus: configuredModel && actualModel ? 'ready' : 'missing-fields',
    configuredModel,
    actualModel,
    tokenUsage,
    fileSize: stats.size,
    lastModifiedMs: Math.floor(stats.mtimeMs),
  };
};

const sameFileSnapshot = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

export const parseProductionLogSnapshot = async ({
  filePath,
  fileName,
  sourceDir,
  stable = false,
  firstStats = null,
  fsAdapter = fs,
}) => {
  const io = fsAdapter;
  const initialStats = firstStats ?? (await io.lstat(filePath));
  if (!initialStats.isFile() || initialStats.isSymbolicLink()) return { status: 'changed' };
  const entry = await parseLogFile(filePath, fileName, initialStats, sourceDir, {
    stable,
    fsAdapter: io,
  });
  const finalStats = await io.lstat(filePath);
  if (
    !finalStats.isFile() ||
    finalStats.isSymbolicLink() ||
    fingerprintForStats(finalStats) !== fingerprintForStats(initialStats) ||
    !sameFileSnapshot(initialStats, finalStats)
  ) {
    return { status: 'changed' };
  }
  return {
    status: 'parsed',
    entry,
    fingerprint: fingerprintForStats(initialStats),
  };
};

export const buildSafeLogErrorEntry = (fileName, stats, sourceDir) => {
  const filenameInfo = parseFilename(fileName, stats);
  return {
    fileName,
    fileType: filenameInfo.fileType,
    timestampMs: filenameInfo.timestampMs,
    requestId: filenameInfo.requestId,
    sourceDir: normalizeSourceDir(sourceDir),
    sourceKey: makeSourceKey(sourceDir, fileName),
    detailStatus: 'error',
    configuredModel: null,
    actualModel: null,
    tokenUsage: emptyTokenUsage('error'),
    fileSize: stats.size,
    lastModifiedMs: Math.floor(stats.mtimeMs),
    errorCode: 'log-parse-failed',
  };
};

const listLogFiles = async (logsDirs, fsAdapter = fs) => {
  const io = fsAdapter;
  const results = [];

  for (const logsDir of logsDirs) {
    let items;
    try {
      items = await io.readdir(logsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }

    results.push(
      ...items
        .filter((item) => item.isFile() && LOG_FILE_PATTERN.test(item.name))
        .map((item) => ({
          fileName: item.name,
          logsDir,
          filePath: path.join(logsDir, item.name),
          sourceKey: makeSourceKey(logsDir, item.name),
        }))
    );
  }

  return results.sort((left, right) => {
    const nameCompare = left.fileName.localeCompare(right.fileName);
    if (nameCompare !== 0) return nameCompare;
    return normalizeSourceDir(left.logsDir).localeCompare(normalizeSourceDir(right.logsDir));
  });
};

const calculateCoverage = (entries) => {
  const totalEntries = entries.length;
  const parsedEntries = entries.filter((entry) => entry.detailStatus !== 'error').length;
  const knownEntries = entries.filter((entry) => entry.tokenUsage?.status === 'available').length;
  const unreportedEntries = entries.filter(
    (entry) => entry.tokenUsage?.status === 'unreported'
  ).length;
  let earliestTimestampMs = null;
  let latestTimestampMs = null;

  entries.forEach((entry) => {
    const timestampMs = entry.timestampMs;
    if (typeof timestampMs !== 'number' || !Number.isFinite(timestampMs)) return;
    if (earliestTimestampMs === null || timestampMs < earliestTimestampMs) {
      earliestTimestampMs = timestampMs;
    }
    if (latestTimestampMs === null || timestampMs > latestTimestampMs) {
      latestTimestampMs = timestampMs;
    }
  });

  return {
    totalEntries,
    parsedEntries,
    knownEntries,
    unreportedEntries,
    coverageRate: totalEntries > 0 ? (knownEntries / totalEntries) * 100 : 0,
    parsedRate: totalEntries > 0 ? (parsedEntries / totalEntries) * 100 : 0,
    earliestTimestampMs,
    latestTimestampMs,
  };
};

const dedupeEntries = (entries) => dedupeLedgerEntries(entries);

const buildProjection = ({
  entries,
  generatedAt,
  generationId,
  logsDirs,
  scannedFiles,
  updatedFiles,
  skippedFiles,
  errorFiles,
}) => ({
  version: VERSION,
  ...(generationId ? { generationId } : {}),
  generatedAt,
  source: {
    logsDir: logsDirs[0] ?? null,
    logsDirs,
    patterns: ['v1-responses-*.log', 'v1-chat-completions-*.log', 'v1-messages-*.log'],
    scannedFiles,
    updatedFiles,
    skippedFiles,
    errorFiles,
  },
  coverage: calculateCoverage(entries),
  entries,
});

const emptyPruneSummary = ({ enabled, dryRun, logsDirs, activeWindowMinutes }) => ({
  enabled,
  dryRun,
  logsDirs: logsDirs.map(normalizeSourceDir),
  activeWindowMinutes,
  activeCutoffMs: null,
  scannedFiles: 0,
  deletedFiles: 0,
  deletedBytes: 0,
  deletedGB: 0,
  failedDeletes: 0,
  keptActiveFiles: 0,
  keptUnrecordedFiles: 0,
  keptNotReadyAvailableFiles: 0,
  keptFingerprintMismatchFiles: 0,
  keptUnsafeFiles: 0,
  keptChangedFiles: 0,
  errorSamples: [],
});

const pruneRecordedLogs = async ({
  dryRun,
  entriesBySourceKey,
  logFiles,
  logsDirs,
  nextFingerprints,
  activeWindowMinutes,
}) => {
  const safeRoots = await resolveSafeLegacyLogRoots(logsDirs);
  const rootsByLogicalPath = new Map(
    safeRoots.map((root) => [compareSourceDir(root.logicalPath), root])
  );
  const summary = emptyPruneSummary({
    enabled: true,
    dryRun,
    logsDirs,
    activeWindowMinutes,
  });
  const nowMs = Date.now();
  const activeWindowMs = activeWindowMinutes * 60_000;
  const activeCutoffMs = nowMs - activeWindowMs;
  summary.activeCutoffMs = activeCutoffMs;

  for (const { filePath, logsDir, sourceKey } of logFiles) {
    const root = rootsByLogicalPath.get(compareSourceDir(logsDir));
    if (!root) {
      summary.keptUnsafeFiles += 1;
      continue;
    }
    let stats;
    try {
      stats = await fs.lstat(filePath);
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      summary.failedDeletes += 1;
      if (summary.errorSamples.length < PRUNE_ERROR_SAMPLE_LIMIT) {
        summary.errorSamples.push({
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      continue;
    }

    summary.scannedFiles += 1;

    if (!stats.isFile() || stats.isSymbolicLink()) {
      summary.keptUnsafeFiles += 1;
      continue;
    }

    if (activeWindowMs > 0 && stats.mtimeMs >= activeCutoffMs) {
      summary.keptActiveFiles += 1;
      continue;
    }

    const ledgerFingerprint = nextFingerprints[sourceKey];
    const ledgerEntry = entriesBySourceKey.get(sourceKey);
    if (!ledgerFingerprint || !ledgerEntry) {
      summary.keptUnrecordedFiles += 1;
      continue;
    }

    if (ledgerEntry.detailStatus !== 'ready' || ledgerEntry.tokenUsage?.status !== 'available') {
      summary.keptNotReadyAvailableFiles += 1;
      continue;
    }

    if (ledgerFingerprint !== fingerprintForStats(stats)) {
      summary.keptFingerprintMismatchFiles += 1;
      continue;
    }

    if (!dryRun) {
      try {
        const finalRealPath = normalizeSourceDir(await fs.realpath(filePath));
        if (
          compareSourceDir(path.dirname(finalRealPath)) !== compareSourceDir(root.realPath) ||
          compareSourceDir(finalRealPath) !== compareSourceDir(filePath)
        ) {
          summary.keptChangedFiles += 1;
          continue;
        }
        const finalStats = await fs.lstat(filePath);
        if (
          !finalStats.isFile() ||
          finalStats.isSymbolicLink() ||
          finalStats.mtimeMs >= activeCutoffMs ||
          fingerprintForStats(finalStats) !== ledgerFingerprint ||
          !sameFileSnapshot(stats, finalStats)
        ) {
          summary.keptChangedFiles += 1;
          continue;
        }
        await fs.unlink(filePath);
      } catch (error) {
        summary.failedDeletes += 1;
        if (summary.errorSamples.length < PRUNE_ERROR_SAMPLE_LIMIT) {
          summary.errorSamples.push({
            filePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
    }

    summary.deletedFiles += 1;
    summary.deletedBytes += stats.size;
  }

  summary.deletedGB = Number((summary.deletedBytes / 1024 ** 3).toFixed(2));
  return summary;
};

const normalizePreviousEntry = (entry, fallbackSourceDir) => {
  const sourceDir = entry.sourceDir ? normalizeSourceDir(entry.sourceDir) : fallbackSourceDir;
  const sourceKey = entry.sourceKey ?? makeSourceKey(sourceDir, entry.fileName);
  return {
    ...entry,
    sourceDir,
    sourceKey,
  };
};

const finalizedIdentityForEntry = (entry) =>
  buildRequestDedupeKey({
    fileType: entry?.fileType ?? 'unknown',
    timestampMs: Number.isFinite(entry?.timestampMs) ? entry.timestampMs : null,
    requestId: entry?.requestId ?? null,
    sourceIdentity: entry?.sourceKey ?? entry?.fileName ?? '',
  });

const availableEntriesMatch = (left, right) =>
  left?.tokenUsage?.status === 'available' &&
  right?.tokenUsage?.status === 'available' &&
  finalizedIdentityForEntry(left) === finalizedIdentityForEntry(right) &&
  left.configuredModel === right.configuredModel &&
  left.actualModel === right.actualModel &&
  ['input', 'output', 'cached', 'reasoning', 'total'].every(
    (key) => left.tokenUsage[key] === right.tokenUsage[key]
  );

const waitForDelay = (delayMs) =>
  new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });

export const buildProductionMaintenanceCandidate = async ({
  formalLedger,
  snapshotTimeMs = Date.now(),
  logRoots = PRODUCTION_LOG_ROOTS,
  stabilityDelayMs = DEFAULT_LOG_STABILITY_DELAY_MS,
  sleep = waitForDelay,
  fsAdapter = fs,
} = {}) => {
  const io = fsAdapter;
  const requestedLogRoots = Array.isArray(logRoots) ? logRoots : PRODUCTION_LOG_ROOTS;
  const previous = formalLedger && Object.keys(formalLedger).length > 0 ? formalLedger : {};
  const fallbackPreviousSourceDir = normalizeSourceDir(requestedLogRoots[0]);
  const previousEntries = Array.isArray(previous.entries) ? previous.entries : [];
  const entriesBySourceKey = new Map(
    previousEntries.map((entry) => {
      const normalizedEntry = normalizePreviousEntry(entry, fallbackPreviousSourceDir);
      return [normalizedEntry.sourceKey, normalizedEntry];
    })
  );
  const previousFingerprints = { ...(previous.state?.fileFingerprints ?? {}) };
  const nextFingerprints = {};
  for (const [sourceKey, entry] of entriesBySourceKey) {
    if (entry?.tokenUsage?.status !== 'available') continue;
    const fingerprint = previousFingerprints[sourceKey] ?? previousFingerprints[entry.fileName];
    if (typeof fingerprint === 'string') nextFingerprints[sourceKey] = fingerprint;
  }
  let productionLogRoots;
  try {
    productionLogRoots = await resolveSafeLegacyLogRoots(requestedLogRoots, io);
  } catch {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
  if (productionLogRoots.length !== requestedLogRoots.length || productionLogRoots.length !== 2) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
  const productionLogDirs = productionLogRoots.map((root) => root.logicalPath);

  const formalFinalizedIdentities = new Set(
    previousEntries
      .filter((entry) => entry?.tokenUsage?.status === 'available')
      .map(finalizedIdentityForEntry)
  );
  const pendingEntries = [];
  const logFiles = await listLogFiles(productionLogDirs, io);
  const parseCandidates = [];
  let updatedFiles = 0;
  let skippedFiles = 0;
  let errorFiles = 0;

  for (const { fileName, filePath, logsDir, sourceKey } of logFiles) {
    let firstStats;
    try {
      firstStats = await io.lstat(filePath);
    } catch {
      skippedFiles += 1;
      continue;
    }
    if (!firstStats.isFile() || firstStats.isSymbolicLink()) {
      skippedFiles += 1;
      continue;
    }
    if (Number.isFinite(snapshotTimeMs) && Math.floor(firstStats.mtimeMs) > snapshotTimeMs) {
      skippedFiles += 1;
      continue;
    }
    const fingerprint = fingerprintForStats(firstStats);
    const migratedFingerprint = previousFingerprints[sourceKey] ?? previousFingerprints[fileName];
    const existingEntry = entriesBySourceKey.get(sourceKey);
    if (migratedFingerprint === fingerprint && existingEntry?.tokenUsage?.status === 'available') {
      nextFingerprints[sourceKey] = fingerprint;
      skippedFiles += 1;
      continue;
    }

    parseCandidates.push({
      fileName,
      filePath,
      logsDir,
      sourceKey,
      firstStats,
      fingerprint,
    });
  }

  if (parseCandidates.length > 0) {
    const normalizedDelayMs = Number.isFinite(stabilityDelayMs)
      ? Math.max(0, Math.floor(stabilityDelayMs))
      : DEFAULT_LOG_STABILITY_DELAY_MS;
    await sleep(normalizedDelayMs);
  }

  for (const candidate of parseCandidates) {
    const { fileName, filePath, logsDir, sourceKey, firstStats } = candidate;
    let stableStats;
    try {
      stableStats = await io.lstat(filePath);
      if (
        !stableStats.isFile() ||
        stableStats.isSymbolicLink() ||
        fingerprintForStats(stableStats) !== candidate.fingerprint ||
        !sameFileSnapshot(firstStats, stableStats)
      ) {
        skippedFiles += 1;
        continue;
      }

      const parsedSnapshot = await parseProductionLogSnapshot({
        filePath,
        fileName,
        sourceDir: logsDir,
        stable: true,
        firstStats: stableStats,
        fsAdapter: io,
      });
      if (parsedSnapshot.status !== 'parsed') {
        skippedFiles += 1;
        continue;
      }
      const entry = parsedSnapshot.entry;
      updatedFiles += 1;
      const existingEntry = entriesBySourceKey.get(sourceKey);
      if (entry.tokenUsage?.status === 'available') {
        if (existingEntry?.tokenUsage?.status === 'available') {
          if (!availableEntriesMatch(existingEntry, entry)) {
            errorFiles += 1;
            continue;
          }
        } else {
          entriesBySourceKey.set(sourceKey, entry);
        }
        nextFingerprints[sourceKey] = parsedSnapshot.fingerprint;
        if (!formalFinalizedIdentities.has(finalizedIdentityForEntry(entry))) {
          pendingEntries.push(entry);
        }
      } else if (existingEntry?.tokenUsage?.status !== 'available') {
        entriesBySourceKey.set(sourceKey, entry);
        delete nextFingerprints[sourceKey];
      }
    } catch {
      if (entriesBySourceKey.get(sourceKey)?.tokenUsage?.status !== 'available') {
        entriesBySourceKey.set(
          sourceKey,
          buildSafeLogErrorEntry(fileName, stableStats ?? firstStats, logsDir)
        );
        delete nextFingerprints[sourceKey];
      }
      errorFiles += 1;
    }
  }

  const entries = dedupeEntries(Array.from(entriesBySourceKey.values())).sort((a, b) => {
    const timestampCompare = (b.timestampMs ?? 0) - (a.timestampMs ?? 0);
    if (timestampCompare !== 0) return timestampCompare;
    const nameCompare = a.fileName.localeCompare(b.fileName);
    if (nameCompare !== 0) return nameCompare;
    return (a.sourceDir ?? '').localeCompare(b.sourceDir ?? '');
  });
  const generatedAt = new Date(snapshotTimeMs).toISOString();
  const generationId = randomUUID();
  const projection = buildProjection({
    entries,
    generatedAt,
    generationId,
    logsDirs: requestedLogRoots.map(normalizeSourceDir),
    scannedFiles: logFiles.length,
    updatedFiles,
    skippedFiles,
    errorFiles,
  });
  const ledger = {
    ...projection,
    state: { fileFingerprints: nextFingerprints },
  };

  return {
    ledger,
    projection,
    pendingEntries: dedupeEntries(pendingEntries),
    scan: {
      scannedFiles: logFiles.length,
      updatedFiles,
      skippedFiles,
      errorFiles,
    },
  };
};

export const commitLedgerProjectionPairWithRollback = async ({
  candidate,
  ledgerPath,
  projectionPath,
  atomicWriter = atomicWriteText,
  fsAdapter = fs,
}) => {
  const ledgerText = `${JSON.stringify(candidate.ledger, null, 2)}\n`;
  const projectionText = `${JSON.stringify(candidate.projection, null, 2)}\n`;
  let previousLedgerText = null;
  let ledgerCommitted = false;
  try {
    previousLedgerText = await fsAdapter.readFile(ledgerPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  try {
    await atomicWriter(ledgerPath, ledgerText);
    ledgerCommitted = true;
    await atomicWriter(projectionPath, projectionText);
  } catch (error) {
    if (ledgerCommitted) {
      try {
        if (previousLedgerText === null) {
          await fsAdapter.rm(ledgerPath, { force: true });
        } else {
          await atomicWriter(ledgerPath, previousLedgerText);
        }
      } catch {
        throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_INTERNAL');
      }
    }
    throw error;
  }
};

const commitProductionMaintenanceCandidate = async (candidate) => {
  const ledgerText = `${JSON.stringify(candidate.ledger, null, 2)}\n`;
  const projectionText = `${JSON.stringify(candidate.projection, null, 2)}\n`;
  try {
    await assertEnoughFreeSpace(
      [PRODUCTION_LEDGER_PATH, PRODUCTION_PROJECTION_PATH],
      null,
      Buffer.byteLength(ledgerText, 'utf8') + Buffer.byteLength(projectionText, 'utf8'),
      { phase: 'maintenance-pre-commit' }
    );
  } catch (error) {
    if (error?.code === LOW_SPACE_ERROR_CODE || error?.code === 'ENOSPC') {
      throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_LOW_SPACE', undefined, {
        availableBytes: error?.details?.availableBytes,
        requiredBytes: error?.details?.requiredBytes,
        reserveBytes: error?.details?.reserveBytes,
        writeBytes: error?.details?.writeBytes,
      });
    }
    throw error;
  }
  await commitLedgerProjectionPairWithRollback({
    candidate,
    ledgerPath: PRODUCTION_LEDGER_PATH,
    projectionPath: PRODUCTION_PROJECTION_PATH,
  });
};

export const createProductionMaintenanceCore = () =>
  createTokenLedgerMaintenanceCore({
    policy: {
      ledgerPath: PRODUCTION_LEDGER_PATH,
      projectionPath: PRODUCTION_PROJECTION_PATH,
      lockPath: PRODUCTION_MAINTENANCE_LOCK_PATH,
      allowedLogRoots: PRODUCTION_LOG_ROOTS,
      minimumActiveWindowMinutes: DEFAULT_PRUNE_ACTIVE_WINDOW_MINUTES,
      previewTtlMs: 60_000,
    },
    buildCandidate: buildProductionMaintenanceCandidate,
    commitCandidate: commitProductionMaintenanceCandidate,
  });

let productionMaintenanceCore = null;

export const runProductionTokenLedgerMaintenance = async ({
  mode,
  activeWindowMinutes = DEFAULT_PRUNE_ACTIVE_WINDOW_MINUTES,
  previewId,
  minimumTotals,
} = {}) => {
  const normalizedMode = String(mode ?? '')
    .trim()
    .toLowerCase();
  if (!['preview', 'execute'].includes(normalizedMode)) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
  productionMaintenanceCore ??= createProductionMaintenanceCore();
  const core = productionMaintenanceCore;
  if (normalizedMode === 'preview') return core.preview({ activeWindowMinutes });
  try {
    return await core.execute({ activeWindowMinutes, previewId, minimumTotals });
  } finally {
    productionMaintenanceCore = null;
  }
};

const assertFixedMaintenancePaths = (args) => {
  const mode = String(args.maintenance ?? '')
    .trim()
    .toLowerCase();
  if (!['preview', 'execute'].includes(mode)) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
  if ([...MAINTENANCE_PATH_ARGUMENTS].some((key) => args[key] !== undefined)) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_FIXED_PATHS');
  }
  if (MAINTENANCE_INCOMPATIBLE_FLAGS.some((key) => Boolean(args[key]))) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_FIXED_PATHS');
  }
  if (
    args['install-dir'] !== undefined &&
    normalizeSourceDir(args['install-dir']) !== normalizeSourceDir(DEFAULT_INSTALL_DIR)
  ) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_FIXED_PATHS');
  }
  if (
    args['custom-ui-dir'] !== undefined &&
    normalizeSourceDir(args['custom-ui-dir']) !== normalizeSourceDir(DEFAULT_CUSTOM_UI_DIR)
  ) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_FIXED_PATHS');
  }
};

const runLegacyMain = async (args) => {
  const installDir = args['install-dir'] ?? DEFAULT_INSTALL_DIR;
  let logsDirs = resolveLogDirs(args, installDir);
  const ledgerDir = args['ledger-dir'] ?? path.join(installDir, 'usage-backups', 'token-ledger');
  const staticDir = args['static-dir'] ?? path.join(installDir, 'static');
  const cwdLooksLikeCustomUi = await pathExists(path.join(process.cwd(), 'package.json'));
  const customUiDir = args['custom-ui-dir'] ?? (cwdLooksLikeCustomUi ? process.cwd() : null);
  const ledgerPath = args['ledger-path'] ?? path.join(ledgerDir, 'ledger.json');
  const projectionPath = args['projection-path'] ?? path.join(staticDir, 'token-ledger.json');
  const shouldEmbed = Boolean(args.embed) && !args['no-embed'];
  const shouldStripEmbeddedLedger = Boolean(args['no-embed']);
  const embeddedLedgerMode = args['embed-full'] ? 'full' : 'summary';
  const pruneOnly = Boolean(args['prune-only']);
  const minimumFreeBytes = minFreeBytesOverride(args['min-free-bytes']);

  if (pruneOnly && !args['prune-recorded-logs']) {
    throw new Error('--prune-only requires --prune-recorded-logs');
  }

  const previous = (await readJson(ledgerPath)) ?? {};
  const safeLogRoots = await resolveSafeLegacyLogRoots(logsDirs);
  logsDirs = safeLogRoots.map((root) => root.logicalPath);
  const normalizedLogDirs = logsDirs.map(normalizeSourceDir);
  const previousEntries = Array.isArray(previous.entries) ? previous.entries : [];
  const fallbackPreviousSourceDir = normalizeSourceDir(logsDirs[0]);
  const entriesBySourceKey = new Map(
    previousEntries.map((entry) => {
      const normalizedEntry = normalizePreviousEntry(entry, fallbackPreviousSourceDir);
      return [normalizedEntry.sourceKey, normalizedEntry];
    })
  );
  const previousFingerprints = { ...(previous.state?.fileFingerprints ?? {}) };
  const nextFingerprints = { ...previousFingerprints };

  let logFiles = await listLogFiles(logsDirs);
  let rescueLowSpace = {
    requested: Boolean(args['rescue-low-space']),
    attempted: false,
    phase: null,
    prune: null,
    freeSpace: null,
  };

  const activeWindowMinutes = nonNegativeInteger(
    args['active-window-minutes'],
    DEFAULT_PRUNE_ACTIVE_WINDOW_MINUTES
  );

  const ensureWriteSpace = async (phase, writeBytes = 0) => {
    try {
      rescueLowSpace.freeSpace = await assertEnoughFreeSpace(
        [ledgerPath, projectionPath],
        minimumFreeBytes,
        writeBytes,
        {
          phase,
          rescueRequested: rescueLowSpace.requested,
          rescueAttempted: rescueLowSpace.attempted,
        }
      );
    } catch (error) {
      if (
        error?.code !== LOW_SPACE_ERROR_CODE ||
        !rescueLowSpace.requested ||
        rescueLowSpace.attempted
      ) {
        throw error;
      }

      const rescuePrune = await pruneRecordedLogs({
        dryRun: false,
        entriesBySourceKey,
        logFiles,
        logsDirs: normalizedLogDirs,
        nextFingerprints: previousFingerprints,
        activeWindowMinutes,
      });
      rescueLowSpace = {
        ...rescueLowSpace,
        attempted: true,
        phase,
        prune: rescuePrune,
      };
      logFiles = await listLogFiles(logsDirs);
      rescueLowSpace.freeSpace = await assertEnoughFreeSpace(
        [ledgerPath, projectionPath],
        minimumFreeBytes,
        writeBytes,
        {
          phase: `${phase}-after-rescue`,
          rescueRequested: true,
          rescueAttempted: true,
          rescuePrune,
        }
      );
    }
  };

  if (!args.dryRun && !pruneOnly) {
    await ensureWriteSpace('pre-refresh');
  }
  let updatedFiles = 0;
  let skippedFiles = 0;
  let errorFiles = 0;

  if (pruneOnly) {
    const prune = await pruneRecordedLogs({
      dryRun: Boolean(args.dryRun),
      entriesBySourceKey,
      logFiles,
      logsDirs: normalizedLogDirs,
      nextFingerprints: previousFingerprints,
      activeWindowMinutes,
    });
    const entries = dedupeEntries(Array.from(entriesBySourceKey.values()));
    const coverage = previous.coverage ?? calculateCoverage(entries);
    console.log(
      JSON.stringify(
        {
          status: args.dryRun ? 'dry-run' : 'completed',
          mode: 'prune-only',
          generatedAt: new Date().toISOString(),
          ledgerPath,
          projectionPath,
          embeddedHtmlFiles: [],
          source: {
            logsDir: normalizedLogDirs[0] ?? null,
            logsDirs: normalizedLogDirs,
            patterns: ['v1-responses-*.log', 'v1-chat-completions-*.log', 'v1-messages-*.log'],
            scannedFiles: logFiles.length,
            updatedFiles: 0,
            skippedFiles: logFiles.length,
            errorFiles: 0,
          },
          scannedFiles: logFiles.length,
          updatedFiles: 0,
          skippedFiles: logFiles.length,
          errorFiles: 0,
          coverage,
          prune,
        },
        null,
        2
      )
    );
    return;
  }

  for (const { fileName, filePath, logsDir, sourceKey } of logFiles) {
    const stats = await fs.stat(filePath);
    const fingerprint = fingerprintForStats(stats);
    const migratedFingerprint = previousFingerprints[sourceKey] ?? previousFingerprints[fileName];

    if (!args.rebuild && migratedFingerprint === fingerprint && entriesBySourceKey.has(sourceKey)) {
      nextFingerprints[sourceKey] = fingerprint;
      skippedFiles += 1;
      continue;
    }

    try {
      const entry = await parseLogFile(filePath, fileName, stats, logsDir);
      entriesBySourceKey.set(sourceKey, entry);
      nextFingerprints[sourceKey] = fingerprint;
      updatedFiles += 1;
    } catch {
      entriesBySourceKey.set(sourceKey, buildSafeLogErrorEntry(fileName, stats, logsDir));
      nextFingerprints[sourceKey] = fingerprint;
      errorFiles += 1;
    }
  }

  const entries = dedupeEntries(Array.from(entriesBySourceKey.values())).sort((a, b) => {
    const left = b.timestampMs ?? 0;
    const right = a.timestampMs ?? 0;
    if (left !== right) return left - right;
    const nameCompare = a.fileName.localeCompare(b.fileName);
    if (nameCompare !== 0) return nameCompare;
    return (a.sourceDir ?? '').localeCompare(b.sourceDir ?? '');
  });
  const generatedAt = new Date().toISOString();
  const generationId = randomUUID();
  const projection = buildProjection({
    entries,
    generatedAt,
    generationId,
    logsDirs: normalizedLogDirs,
    scannedFiles: logFiles.length,
    updatedFiles,
    skippedFiles,
    errorFiles,
  });
  const ledger = {
    ...projection,
    state: {
      fileFingerprints: nextFingerprints,
    },
  };

  const embeddedHtmlFiles = [];
  const strippedHtmlFiles = [];
  let prune = emptyPruneSummary({
    enabled: false,
    dryRun: Boolean(args.dryRun),
    logsDirs: normalizedLogDirs,
    activeWindowMinutes: nonNegativeInteger(
      args['active-window-minutes'],
      DEFAULT_PRUNE_ACTIVE_WINDOW_MINUTES
    ),
  });
  const ledgerText = `${JSON.stringify(ledger, null, 2)}\n`;
  const projectionText = `${JSON.stringify(projection, null, 2)}\n`;

  if (!args.dryRun) {
    await ensureWriteSpace(
      'pre-write',
      Buffer.byteLength(ledgerText, 'utf8') + Buffer.byteLength(projectionText, 'utf8')
    );
    await commitLedgerProjectionPairWithRollback({
      candidate: { ledger, projection },
      ledgerPath,
      projectionPath,
    });

    const htmlCandidates = [
      path.join(staticDir, 'management.html'),
      customUiDir ? path.join(customUiDir, 'dist', 'index.html') : null,
    ].filter(Boolean);

    if (shouldEmbed) {
      for (const htmlPath of htmlCandidates) {
        if (await embedLedgerInHtml(htmlPath, projection, embeddedLedgerMode)) {
          embeddedHtmlFiles.push(htmlPath);
        }
      }
    } else if (shouldStripEmbeddedLedger) {
      for (const htmlPath of htmlCandidates) {
        if (await removeEmbeddedLedgerFromHtml(htmlPath)) {
          strippedHtmlFiles.push(htmlPath);
        }
      }
    }
  }

  if (args['prune-recorded-logs']) {
    prune = await pruneRecordedLogs({
      dryRun: Boolean(args.dryRun),
      entriesBySourceKey,
      logFiles,
      logsDirs: normalizedLogDirs,
      nextFingerprints,
      activeWindowMinutes: nonNegativeInteger(
        args['active-window-minutes'],
        DEFAULT_PRUNE_ACTIVE_WINDOW_MINUTES
      ),
    });
  }

  console.log(
    JSON.stringify(
      {
        status: args.dryRun ? 'dry-run' : 'completed',
        generatedAt,
        ledgerPath,
        projectionPath,
        embeddedHtmlFiles,
        embeddedLedgerMode: shouldEmbed ? embeddedLedgerMode : 'none',
        strippedHtmlFiles,
        source: projection.source,
        scannedFiles: logFiles.length,
        updatedFiles,
        skippedFiles,
        errorFiles,
        coverage: projection.coverage,
        rescueLowSpace,
        prune,
      },
      null,
      2
    )
  );
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/update-token-ledger.mjs [--maintenance preview|execute] [--preview-id ID] [--active-window-minutes 5] [--install-dir D:\\CLIProxyAPI] [--custom-ui-dir D:\\CLIProxyAPI_Maintenance\\custom-ui] [--rebuild] [--dry-run] [--embed] [--embed-full] [--no-embed] [--prune-recorded-logs] [--prune-only] [--rescue-low-space] [--min-free-bytes N]'
    );
    return;
  }

  if (args.maintenance) {
    assertFixedMaintenancePaths(args);
    const activeWindowMinutes = nonNegativeInteger(
      args['active-window-minutes'],
      DEFAULT_PRUNE_ACTIVE_WINDOW_MINUTES
    );
    const result = await runProductionTokenLedgerMaintenance({
      mode: args.maintenance,
      activeWindowMinutes,
      previewId: args['preview-id'],
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const installDir = args['install-dir'] ?? DEFAULT_INSTALL_DIR;
  const ledgerDir = args['ledger-dir'] ?? path.join(installDir, 'usage-backups', 'token-ledger');
  const ledgerPath = args['ledger-path'] ?? path.join(ledgerDir, 'ledger.json');
  await withTokenLedgerMaintenanceLock(
    { lockPath: `${path.resolve(ledgerPath)}.maintenance.lock` },
    () => runLegacyMain(args)
  );
};

const handleMainError = (error) => {
  if (error instanceof TokenLedgerMaintenanceError) {
    console.error(JSON.stringify(toSafeTokenLedgerMaintenanceError(error)));
    process.exitCode = 1;
    return;
  }
  if (error?.code === LOW_SPACE_ERROR_CODE || error?.code === 'ENOSPC') {
    console.error(
      JSON.stringify({
        status: 'error',
        code: LOW_SPACE_ERROR_CODE,
        message: error instanceof Error ? error.message : String(error),
        ...(error?.details ?? {}),
      })
    );
    process.exitCode = 1;
    return;
  }
  console.error(error);
  process.exitCode = 1;
};

const isDirectExecution =
  Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const isLibraryMode = globalThis.__CPAMC_TOKEN_LEDGER_LIBRARY_MODE__ === true;

if (isDirectExecution) {
  if (!isLibraryMode) main().catch(handleMainError);
}
