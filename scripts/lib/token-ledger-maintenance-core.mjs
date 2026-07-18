import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { LOG_FILE_PATTERN, buildRequestDedupeKey } from './token-log-core.mjs';

export const TOKEN_LEDGER_MAINTENANCE_SCHEMA_VERSION = 1;
export const TOKEN_LEDGER_MAINTENANCE_LOCK_VERSION = 1;
export const MINIMUM_ACTIVE_WINDOW_MINUTES = 5;
export const DEFAULT_PREVIEW_TTL_MS = 60_000;

const SAFE_ERROR_MESSAGES = {
  TOKEN_LEDGER_BUSY: 'Token ledger maintenance is already running.',
  TOKEN_LEDGER_FIXED_PATHS: 'Token ledger maintenance uses fixed production paths.',
  TOKEN_LEDGER_INTERNAL: 'Token ledger maintenance failed.',
  TOKEN_LEDGER_LOW_SPACE: 'Token ledger maintenance needs more free disk space.',
  TOKEN_LEDGER_PREVIEW_REQUIRED: 'A current token ledger maintenance preview is required.',
  TOKEN_LEDGER_PREVIEW_STALE: 'The token ledger maintenance preview is stale.',
  TOKEN_LEDGER_REGRESSION: 'The token ledger candidate would reduce finalized accounting data.',
  TOKEN_LEDGER_SCHEMA_UNSUPPORTED: 'The token ledger schema is not supported for maintenance.',
};

export class TokenLedgerMaintenanceError extends Error {
  constructor(
    code,
    message = SAFE_ERROR_MESSAGES[code] ?? SAFE_ERROR_MESSAGES.TOKEN_LEDGER_INTERNAL,
    details = null
  ) {
    super(message);
    this.name = 'TokenLedgerMaintenanceError';
    this.code = code;
    if (details && typeof details === 'object') this.details = details;
  }
}

const asNonNegativeInteger = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
};

const normalizeWindowsPath = (value) => path.normalize(path.resolve(String(value)));
const comparePath = (value) => normalizeWindowsPath(value).replace(/\\/g, '/').toLowerCase();
const makeSourceKey = (logsDir, fileName) => `${normalizeWindowsPath(logsDir)}::${fileName}`;
const compareSourceKey = (value) =>
  String(value ?? '')
    .replace(/\\/g, '/')
    .toLowerCase();
const fingerprintForStats = (stats) => `${stats.size}:${Math.floor(stats.mtimeMs)}`;

const safeScanSummary = (scan = {}) => ({
  scannedFiles: asNonNegativeInteger(scan.scannedFiles),
  updatedFiles: asNonNegativeInteger(scan.updatedFiles),
  skippedFiles: asNonNegativeInteger(scan.skippedFiles),
  errorFiles: asNonNegativeInteger(scan.errorFiles),
});

const emptyTotals = () => ({
  requests: 0,
  input: 0,
  output: 0,
  cached: 0,
  reasoning: 0,
  total: 0,
});

export const summarizeFinalizedLedger = (ledger) => {
  const totals = emptyTotals();
  const entries = Array.isArray(ledger?.entries) ? ledger.entries : [];
  for (const entry of entries) {
    if (entry?.tokenUsage?.status !== 'available') continue;
    totals.requests += 1;
    totals.input += asNonNegativeInteger(entry.tokenUsage.input);
    totals.output += asNonNegativeInteger(entry.tokenUsage.output);
    totals.cached += asNonNegativeInteger(entry.tokenUsage.cached);
    totals.reasoning += asNonNegativeInteger(entry.tokenUsage.reasoning);
    totals.total += asNonNegativeInteger(entry.tokenUsage.total);
  }
  return totals;
};

const addTotals = (left, right) => {
  const total = {};
  for (const key of Object.keys(emptyTotals())) total[key] = left[key] + right[key];
  return total;
};

const summarizePendingEntries = (formalLedger, pendingEntries) => {
  if (!Array.isArray(pendingEntries)) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
  const formalIdentities = new Set(
    (Array.isArray(formalLedger?.entries) ? formalLedger.entries : [])
      .filter((entry) => entry?.tokenUsage?.status === 'available')
      .map(finalizedIdentity)
  );
  const uniquePending = new Map();
  for (const entry of pendingEntries) {
    if (entry?.tokenUsage?.status !== 'available') continue;
    const identity = finalizedIdentity(entry);
    if (formalIdentities.has(identity)) continue;
    const existing = uniquePending.get(identity);
    if (
      existing &&
      tokenTuple(existing).some((value, index) => value !== tokenTuple(entry)[index])
    ) {
      throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
    }
    uniquePending.set(identity, entry);
  }
  return summarizeFinalizedLedger({ entries: [...uniquePending.values()] });
};

const subtractTotals = (current, formal) => {
  const pending = {};
  for (const key of Object.keys(emptyTotals())) {
    const delta = current[key] - formal[key];
    if (delta < 0) throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_REGRESSION');
    pending[key] = delta;
  }
  return pending;
};

const tokenTuple = (entry) => [
  asNonNegativeInteger(entry?.tokenUsage?.input),
  asNonNegativeInteger(entry?.tokenUsage?.output),
  asNonNegativeInteger(entry?.tokenUsage?.cached),
  asNonNegativeInteger(entry?.tokenUsage?.reasoning),
  asNonNegativeInteger(entry?.tokenUsage?.total),
];

const finalizedIdentity = (entry) =>
  buildRequestDedupeKey({
    fileType: entry?.fileType ?? 'unknown',
    timestampMs: Number.isFinite(entry?.timestampMs) ? entry.timestampMs : null,
    requestId: entry?.requestId ?? null,
    sourceIdentity: entry?.sourceKey ?? entry?.fileName ?? '',
  });

const assertFinalizedEntriesPreserved = (formalLedger, candidateLedger) => {
  const candidateEntries = new Map();
  for (const entry of Array.isArray(candidateLedger?.entries) ? candidateLedger.entries : []) {
    if (entry?.tokenUsage?.status !== 'available') continue;
    const identity = finalizedIdentity(entry);
    if (candidateEntries.has(identity)) {
      throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
    }
    candidateEntries.set(identity, entry);
  }

  const seenFormal = new Set();
  for (const entry of Array.isArray(formalLedger?.entries) ? formalLedger.entries : []) {
    if (entry?.tokenUsage?.status !== 'available') continue;
    const identity = finalizedIdentity(entry);
    if (seenFormal.has(identity)) {
      throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
    }
    seenFormal.add(identity);
    const candidate = candidateEntries.get(identity);
    if (
      !candidate ||
      tokenTuple(candidate).some((value, index) => value !== tokenTuple(entry)[index])
    ) {
      throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_REGRESSION');
    }
  }
};

const validateLedgerShape = (ledger, { allowEmpty = false } = {}) => {
  if (allowEmpty && (!ledger || Object.keys(ledger).length === 0)) return;
  if (ledger?.version !== 1 || !Array.isArray(ledger.entries)) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
  if (!ledger.state || typeof ledger.state.fileFingerprints !== 'object') {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
};

const readJson = async (io, filePath, { allowMissing = false } = {}) => {
  try {
    return JSON.parse(await io.readFile(filePath, 'utf8'));
  } catch (error) {
    if (allowMissing && error?.code === 'ENOENT') return {};
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const canonicalizeForDigest = (value) => {
  if (Array.isArray(value)) return value.map(canonicalizeForDigest);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      if (value[key] !== undefined) result[key] = canonicalizeForDigest(value[key]);
      return result;
    }, {});
};

const stableSerialize = (value) => JSON.stringify(canonicalizeForDigest(value));

const semanticSnapshot = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const { generatedAt: _generatedAt, generationId: _generationId, ...semantic } = value;
  return semantic;
};

const normalizePolicy = (policy) => {
  if (!policy || !Array.isArray(policy.allowedLogRoots) || policy.allowedLogRoots.length !== 2) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
  const ledgerPath = normalizeWindowsPath(policy.ledgerPath);
  return {
    ledgerPath,
    projectionPath: normalizeWindowsPath(policy.projectionPath),
    lockPath: normalizeWindowsPath(policy.lockPath ?? `${ledgerPath}.maintenance.lock`),
    allowedLogRoots: policy.allowedLogRoots.map(normalizeWindowsPath),
    minimumActiveWindowMinutes: Math.max(
      MINIMUM_ACTIVE_WINDOW_MINUTES,
      asNonNegativeInteger(policy.minimumActiveWindowMinutes)
    ),
    previewTtlMs: Math.max(
      1_000,
      asNonNegativeInteger(policy.previewTtlMs) || DEFAULT_PREVIEW_TTL_MS
    ),
  };
};

const processExists = (pid) => {
  if (!Number.isInteger(pid) || pid < 1) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return null;
  }
};

const tryReclaimDeadLock = async (io, lockPath) => {
  let owner;
  try {
    owner = JSON.parse(await io.readFile(lockPath, 'utf8'));
  } catch {
    return false;
  }
  if (processExists(Number(owner?.pid)) !== false) return false;
  const stalePath = `${lockPath}.stale-${randomUUID()}`;
  try {
    await io.rename(lockPath, stalePath);
    await io.rm(stalePath, { force: true });
    return true;
  } catch {
    return false;
  }
};

export const withTokenLedgerMaintenanceLock = async ({ lockPath, fsAdapter = fs }, task) => {
  const io = fsAdapter;
  await io.mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await io.open(lockPath, 'wx');
  } catch (error) {
    if (error?.code !== 'EEXIST' || !(await tryReclaimDeadLock(io, lockPath))) {
      throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_BUSY');
    }
    try {
      handle = await io.open(lockPath, 'wx');
    } catch {
      throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_BUSY');
    }
  }

  const nonce = randomUUID();
  try {
    await handle.writeFile(
      JSON.stringify({
        version: TOKEN_LEDGER_MAINTENANCE_LOCK_VERSION,
        pid: process.pid,
        processStartedAtMs: Math.floor(Date.now() - process.uptime() * 1_000),
        executableIdentity: sha256(process.execPath.toLowerCase()),
        nonce,
      }),
      'utf8'
    );
  } catch {
    await handle.close().catch(() => {});
    handle = null;
    await io.rm(lockPath, { force: true }).catch(() => {});
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_INTERNAL');
  }

  try {
    return await task();
  } finally {
    await handle?.close().catch(() => {});
    try {
      const current = JSON.parse(await io.readFile(lockPath, 'utf8'));
      if (current?.nonce === nonce) await io.rm(lockPath, { force: true });
    } catch {
      // Never remove a lock whose ownership cannot be proven.
    }
  }
};

const resolveAllowedRoots = async (io, policy) => {
  const resolved = [];
  const seenRealPaths = new Set();
  for (let index = 0; index < policy.allowedLogRoots.length; index += 1) {
    const logicalPath = policy.allowedLogRoots[index];
    try {
      const stats = await io.lstat(logicalPath);
      if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
      }
      const realPath = normalizeWindowsPath(await io.realpath(logicalPath));
      const realKey = comparePath(realPath);
      if (realKey !== comparePath(logicalPath) || seenRealPaths.has(realKey)) {
        throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
      }
      seenRealPaths.add(realKey);
      resolved.push({ id: index, logicalPath, realPath });
    } catch (error) {
      if (error instanceof TokenLedgerMaintenanceError) throw error;
      throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
    }
  }
  if (resolved.length !== policy.allowedLogRoots.length || resolved.length !== 2) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
  return resolved;
};

const directChildOf = (candidatePath, rootPath) =>
  comparePath(path.dirname(candidatePath)) === comparePath(rootPath);

const eligibleEntryMap = (ledger, roots) => {
  const rootsByLogicalPath = new Map(roots.map((root) => [comparePath(root.logicalPath), root]));
  const entries = new Map();
  let invalidEntries = 0;
  for (const entry of ledger.entries) {
    const root = rootsByLogicalPath.get(comparePath(entry?.sourceDir ?? ''));
    const fileName = String(entry?.fileName ?? '');
    if (!root || !LOG_FILE_PATTERN.test(fileName)) {
      invalidEntries += 1;
      continue;
    }
    const expectedSourceKey = makeSourceKey(root.logicalPath, fileName);
    if (compareSourceKey(entry.sourceKey) !== compareSourceKey(expectedSourceKey)) {
      invalidEntries += 1;
      continue;
    }
    const sourceKey = compareSourceKey(expectedSourceKey);
    if (entries.has(sourceKey)) {
      invalidEntries += 1;
      continue;
    }
    entries.set(sourceKey, { entry, root });
  }
  return { entries, invalidEntries };
};

const buildPrunePlan = async ({ ledger, policy, roots, nowMs, activeWindowMinutes, io }) => {
  validateLedgerShape(ledger);
  const verifiedRoots = roots ?? (await resolveAllowedRoots(io, policy));
  const entryIndex = eligibleEntryMap(ledger, verifiedRoots);
  const fingerprints = ledger.state.fileFingerprints;
  const activeCutoffMs = nowMs - activeWindowMinutes * 60_000;
  const candidates = [];
  const summary = {
    allowlistedRootsPresent: verifiedRoots.length,
    invalidSourceEntries: entryIndex.invalidEntries,
    scannedFiles: 0,
    eligibleFiles: 0,
    eligibleBytes: 0,
    keptActiveFiles: 0,
    keptUnrecordedFiles: 0,
    keptNotReadyAvailableFiles: 0,
    keptFingerprintMismatchFiles: 0,
    keptUnsafeFiles: entryIndex.invalidEntries,
  };
  const seenRealPaths = new Set();

  for (const root of verifiedRoots) {
    let items;
    try {
      items = await io.readdir(root.logicalPath, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_INTERNAL');
    }
    for (const item of items) {
      if (!LOG_FILE_PATTERN.test(item.name)) continue;
      summary.scannedFiles += 1;
      if (!item.isFile() || item.isSymbolicLink()) {
        summary.keptUnsafeFiles += 1;
        continue;
      }
      const filePath = path.join(root.logicalPath, item.name);
      let firstStats;
      let realPath;
      try {
        firstStats = await io.lstat(filePath);
        if (!firstStats.isFile() || firstStats.isSymbolicLink()) {
          summary.keptUnsafeFiles += 1;
          continue;
        }
        realPath = normalizeWindowsPath(await io.realpath(filePath));
      } catch {
        summary.keptUnsafeFiles += 1;
        continue;
      }
      if (!directChildOf(realPath, root.realPath)) {
        summary.keptUnsafeFiles += 1;
        continue;
      }
      const realKey = comparePath(realPath);
      if (seenRealPaths.has(realKey)) continue;
      seenRealPaths.add(realKey);

      const expectedSourceKey = makeSourceKey(root.logicalPath, item.name);
      const indexed = entryIndex.entries.get(compareSourceKey(expectedSourceKey));
      if (!indexed) {
        summary.keptUnrecordedFiles += 1;
        continue;
      }
      if (
        indexed.entry.detailStatus !== 'ready' ||
        indexed.entry.tokenUsage?.status !== 'available'
      ) {
        summary.keptNotReadyAvailableFiles += 1;
        continue;
      }
      if (firstStats.mtimeMs >= activeCutoffMs) {
        summary.keptActiveFiles += 1;
        continue;
      }
      const fingerprint = fingerprints[expectedSourceKey] ?? fingerprints[indexed.entry.sourceKey];
      if (fingerprint !== fingerprintForStats(firstStats)) {
        summary.keptFingerprintMismatchFiles += 1;
        continue;
      }
      candidates.push({
        filePath,
        realPath,
        rootLogicalPath: root.logicalPath,
        rootRealPath: root.realPath,
        fingerprint,
        firstStats: {
          dev: firstStats.dev,
          ino: firstStats.ino,
          size: firstStats.size,
          mtimeMs: firstStats.mtimeMs,
          ctimeMs: firstStats.ctimeMs,
        },
      });
      summary.eligibleFiles += 1;
      summary.eligibleBytes += firstStats.size;
    }
  }

  return {
    candidates,
    summary,
    roots: verifiedRoots.map((root) => ({
      logicalPath: root.logicalPath,
      realPath: root.realPath,
    })),
  };
};

const candidateDigest = ({ candidate, plan, activeWindowMinutes }) => {
  const files = plan.candidates
    .map((item) => ({
      realPath: comparePath(item.realPath),
      rootLogicalPath: comparePath(item.rootLogicalPath),
      rootRealPath: comparePath(item.rootRealPath),
      fingerprint: item.fingerprint,
      firstStats: item.firstStats,
    }))
    .sort((left, right) => left.realPath.localeCompare(right.realPath));
  return sha256(
    stableSerialize({
      activeWindowMinutes,
      candidate: {
        ledger: semanticSnapshot(candidate.ledger),
        projection: semanticSnapshot(candidate.projection),
        pendingEntries: candidate.pendingEntries,
        scan: safeScanSummary(candidate.scan),
      },
      prune: {
        ...safePrunePreview(plan.summary),
        allowlistedRootsPresent: plan.summary.allowlistedRootsPresent,
      },
      roots: plan.roots
        .map((root) => ({
          logicalPath: comparePath(root.logicalPath),
          realPath: comparePath(root.realPath),
        }))
        .sort((left, right) => left.logicalPath.localeCompare(right.logicalPath)),
      files,
    })
  );
};

const buildPreviewId = (snapshotTimeMs, issuedAtMs, digest) =>
  `v2:${snapshotTimeMs}:${issuedAtMs}:${sha256(
    `${snapshotTimeMs}:${issuedAtMs}:${digest}`
  )}`;

const parsePreviewId = (value) => {
  const match = String(value ?? '').match(/^v2:(\d+):(\d+):([a-f0-9]{64})$/);
  if (!match) throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_PREVIEW_REQUIRED');
  const snapshotTimeMs = Number(match[1]);
  const issuedAtMs = Number(match[2]);
  if (
    !Number.isSafeInteger(snapshotTimeMs) ||
    snapshotTimeMs < 0 ||
    !Number.isSafeInteger(issuedAtMs) ||
    issuedAtMs < snapshotTimeMs
  ) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_PREVIEW_REQUIRED');
  }
  return { snapshotTimeMs, issuedAtMs, value: match[0] };
};

const buildLedgerSummary = (formalLedger, candidateLedger, pendingEntries) => {
  const formal = summarizeFinalizedLedger(formalLedger);
  const pending = summarizePendingEntries(formalLedger, pendingEntries);
  const floor = addTotals(formal, pending);
  const projected = summarizeFinalizedLedger(candidateLedger);
  assertFinalizedEntriesPreserved(formalLedger, candidateLedger);
  subtractTotals(projected, formal);
  if (Object.keys(emptyTotals()).some((key) => projected[key] < floor[key])) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_REGRESSION');
  }
  return {
    formal,
    pending,
    floor,
    projected,
    current: projected,
    entryCounts: {
      formal: Array.isArray(formalLedger?.entries) ? formalLedger.entries.length : 0,
      candidate: Array.isArray(candidateLedger?.entries) ? candidateLedger.entries.length : 0,
    },
    formalGeneratedAt:
      typeof formalLedger?.generatedAt === 'string' ? formalLedger.generatedAt : null,
    candidateGeneratedAt:
      typeof candidateLedger?.generatedAt === 'string' ? candidateLedger.generatedAt : null,
  };
};

const assertExternalMinimumTotals = (ledgerSummary, minimumTotals) => {
  if (minimumTotals === undefined || minimumTotals === null) return;
  if (
    typeof minimumTotals !== 'object' ||
    !Number.isSafeInteger(minimumTotals.requests) ||
    minimumTotals.requests < 0 ||
    !Number.isSafeInteger(minimumTotals.totalTokens) ||
    minimumTotals.totalTokens < 0 ||
    !Number.isSafeInteger(minimumTotals.ledgerEntries) ||
    minimumTotals.ledgerEntries < 0
  ) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
  if (
    ledgerSummary.projected.requests < minimumTotals.requests ||
    ledgerSummary.projected.total < minimumTotals.totalTokens ||
    ledgerSummary.entryCounts.candidate < minimumTotals.ledgerEntries
  ) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_REGRESSION');
  }
};

const safePrunePreview = (summary) => ({
  scannedFiles: summary.scannedFiles,
  eligibleFiles: summary.eligibleFiles,
  eligibleBytes: summary.eligibleBytes,
  keptActiveFiles: summary.keptActiveFiles,
  keptUnrecordedFiles: summary.keptUnrecordedFiles,
  keptNotReadyAvailableFiles: summary.keptNotReadyAvailableFiles,
  keptFingerprintMismatchFiles: summary.keptFingerprintMismatchFiles,
  keptUnsafeFiles: summary.keptUnsafeFiles,
  invalidSourceEntries: summary.invalidSourceEntries,
});

const assertPlanExecutable = (plan) => {
  if (
    plan.summary.allowlistedRootsPresent !== 2 ||
    plan.summary.invalidSourceEntries !== 0
  ) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
};

const sameStatIdentity = (left, right) =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.size === right.size &&
  left.mtimeMs === right.mtimeMs &&
  left.ctimeMs === right.ctimeMs;

const executePrunePlan = async ({ plan, activeWindowMinutes, nowMs, io }) => {
  const activeCutoffMs = nowMs - activeWindowMinutes * 60_000;
  const result = {
    ...safePrunePreview(plan.summary),
    deletedFiles: 0,
    deletedBytes: 0,
    failedDeletes: 0,
    keptChangedFiles: 0,
  };

  for (const candidate of plan.candidates) {
    try {
      const rootStats = await io.lstat(candidate.rootLogicalPath);
      const secondRootRealPath = normalizeWindowsPath(await io.realpath(candidate.rootLogicalPath));
      if (
        !rootStats.isDirectory() ||
        rootStats.isSymbolicLink() ||
        comparePath(secondRootRealPath) !== comparePath(candidate.rootRealPath) ||
        comparePath(secondRootRealPath) !== comparePath(candidate.rootLogicalPath)
      ) {
        result.keptChangedFiles += 1;
        continue;
      }
      const secondRealPath = normalizeWindowsPath(await io.realpath(candidate.filePath));
      const secondStats = await io.lstat(candidate.filePath);
      if (!secondStats.isFile() || secondStats.isSymbolicLink()) {
        result.keptChangedFiles += 1;
        continue;
      }
      if (
        comparePath(secondRealPath) !== comparePath(candidate.realPath) ||
        !directChildOf(secondRealPath, candidate.rootRealPath) ||
        secondStats.mtimeMs >= activeCutoffMs ||
        fingerprintForStats(secondStats) !== candidate.fingerprint ||
        !sameStatIdentity(candidate.firstStats, secondStats)
      ) {
        result.keptChangedFiles += 1;
        continue;
      }
      await io.unlink(candidate.filePath);
      result.deletedFiles += 1;
      result.deletedBytes += secondStats.size;
    } catch (error) {
      if (error?.code === 'ENOENT') result.keptChangedFiles += 1;
      else result.failedDeletes += 1;
    }
  }

  return result;
};

const sameTotals = (left, right) =>
  Object.keys(emptyTotals()).every((key) => left[key] === right[key]);

const assertCandidateReadback = (candidate, canonicalLedger, projection) => {
  validateLedgerShape(canonicalLedger);
  if (
    typeof candidate?.ledger?.generationId !== 'string' ||
    !candidate.ledger.generationId ||
    canonicalLedger.generationId !== candidate.ledger.generationId ||
    projection?.generationId !== candidate.ledger.generationId ||
    sha256(JSON.stringify(canonicalLedger)) !== sha256(JSON.stringify(candidate.ledger)) ||
    sha256(JSON.stringify(projection)) !== sha256(JSON.stringify(candidate.projection))
  ) {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }
};

const runSafeMaintenanceOperation = async (task) => {
  try {
    return await task();
  } catch (error) {
    if (error instanceof TokenLedgerMaintenanceError) throw error;
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_INTERNAL');
  }
};

export const createTokenLedgerMaintenanceCore = ({
  policy: rawPolicy,
  buildCandidate,
  commitCandidate,
  fsAdapter = fs,
  now = Date.now,
}) => {
  const policy = normalizePolicy(rawPolicy);
  const io = fsAdapter;
  if (typeof buildCandidate !== 'function' || typeof commitCandidate !== 'function') {
    throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_SCHEMA_UNSUPPORTED');
  }

  let previewCache = null;

  const preview = ({ activeWindowMinutes } = {}) =>
    runSafeMaintenanceOperation(() =>
      withTokenLedgerMaintenanceLock({ lockPath: policy.lockPath, fsAdapter: io }, async () => {
        previewCache = null;
        const verifiedRoots = await resolveAllowedRoots(io, policy);
        const effectiveActiveWindowMinutes = Math.max(
          policy.minimumActiveWindowMinutes,
          asNonNegativeInteger(activeWindowMinutes)
        );
        const snapshotTimeMs = asNonNegativeInteger(now());
        const formalLedger = await readJson(io, policy.ledgerPath, { allowMissing: true });
        validateLedgerShape(formalLedger, { allowEmpty: true });
        const candidate = await buildCandidate({
          formalLedger,
          snapshotTimeMs,
          mode: 'preview',
        });
        validateLedgerShape(candidate?.ledger);
        const ledger = buildLedgerSummary(formalLedger, candidate.ledger, candidate.pendingEntries);
        const plan = await buildPrunePlan({
          ledger: candidate.ledger,
          policy,
          roots: verifiedRoots,
          nowMs: snapshotTimeMs,
          activeWindowMinutes: effectiveActiveWindowMinutes,
          io,
        });
        const digest = candidateDigest({
          candidate,
          plan,
          activeWindowMinutes: effectiveActiveWindowMinutes,
        });
        const issuedAtMs = asNonNegativeInteger(now());
        const previewId = buildPreviewId(snapshotTimeMs, issuedAtMs, digest);
        previewCache = {
          previewId,
          formalDigest: sha256(stableSerialize(formalLedger ?? {})),
          activeWindowMinutes: effectiveActiveWindowMinutes,
          candidate,
          plan,
        };
        return {
          schemaVersion: TOKEN_LEDGER_MAINTENANCE_SCHEMA_VERSION,
          status: 'preview',
          mode: 'preview',
          generatedAt: new Date(issuedAtMs).toISOString(),
          previewId,
          expiresAt: new Date(issuedAtMs + policy.previewTtlMs).toISOString(),
          scan: safeScanSummary(candidate.scan),
          ledger,
          ledgerEntries: ledger.entryCounts.candidate,
          totalTokens: ledger.projected.total,
          ledgerGeneratedAt: ledger.candidateGeneratedAt,
          prune: safePrunePreview(plan.summary),
          safety: {
            activeWindowMinutes: effectiveActiveWindowMinutes,
            lockVersion: TOKEN_LEDGER_MAINTENANCE_LOCK_VERSION,
            allowlistedRootsPresent: plan.summary.allowlistedRootsPresent,
            canExecute:
              plan.summary.allowlistedRootsPresent === 2 &&
              plan.summary.invalidSourceEntries === 0,
          },
        };
      })
    );

  const execute = ({ activeWindowMinutes, previewId, minimumTotals } = {}) =>
    runSafeMaintenanceOperation(() =>
      withTokenLedgerMaintenanceLock({ lockPath: policy.lockPath, fsAdapter: io }, async () => {
        const preview = parsePreviewId(previewId);
        const nowMs = asNonNegativeInteger(now());
        if (preview.issuedAtMs > nowMs || nowMs - preview.issuedAtMs > policy.previewTtlMs) {
          throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_PREVIEW_STALE');
        }
        const effectiveActiveWindowMinutes = Math.max(
          policy.minimumActiveWindowMinutes,
          asNonNegativeInteger(activeWindowMinutes)
        );
        const verifiedRoots = await resolveAllowedRoots(io, policy);
        const formalLedger = await readJson(io, policy.ledgerPath, { allowMissing: true });
        validateLedgerShape(formalLedger, { allowEmpty: true });
        const cached = previewCache?.previewId === preview.value ? previewCache : null;
        previewCache = null;
        if (
          cached &&
          (cached.activeWindowMinutes !== effectiveActiveWindowMinutes ||
            cached.formalDigest !== sha256(stableSerialize(formalLedger ?? {})))
        ) {
          throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_PREVIEW_STALE');
        }
        const candidate = cached
          ? cached.candidate
          : await buildCandidate({
              formalLedger,
              snapshotTimeMs: preview.snapshotTimeMs,
              mode: 'execute',
            });
        validateLedgerShape(candidate?.ledger);
        const ledgerSummary = buildLedgerSummary(
          formalLedger,
          candidate.ledger,
          candidate.pendingEntries
        );
        assertExternalMinimumTotals(ledgerSummary, minimumTotals);
        const preCommitPlan = cached
          ? cached.plan
          : await buildPrunePlan({
              ledger: candidate.ledger,
              policy,
              roots: verifiedRoots,
              nowMs: preview.snapshotTimeMs,
              activeWindowMinutes: effectiveActiveWindowMinutes,
              io,
            });
        assertPlanExecutable(preCommitPlan);
        if (!cached) {
          const preCommitDigest = candidateDigest({
            candidate,
            plan: preCommitPlan,
            activeWindowMinutes: effectiveActiveWindowMinutes,
          });
          if (
            buildPreviewId(preview.snapshotTimeMs, preview.issuedAtMs, preCommitDigest) !==
            preview.value
          ) {
            throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_PREVIEW_STALE');
          }
        }

        await commitCandidate(candidate);
        const beforePruneText = await io.readFile(policy.ledgerPath, 'utf8');
        const canonicalLedger = JSON.parse(beforePruneText);
        const projection = await readJson(io, policy.projectionPath);
        assertCandidateReadback(candidate, canonicalLedger, projection);

        const beforePrune = summarizeFinalizedLedger(canonicalLedger);
        const prune = await executePrunePlan({
          plan: preCommitPlan,
          activeWindowMinutes: effectiveActiveWindowMinutes,
          nowMs,
          io,
        });
        const afterPruneText = await io.readFile(policy.ledgerPath, 'utf8');
        const afterPruneLedger = JSON.parse(afterPruneText);
        const afterPrune = summarizeFinalizedLedger(afterPruneLedger);
        const unchangedByPrune =
          sha256(beforePruneText) === sha256(afterPruneText) && sameTotals(beforePrune, afterPrune);
        if (!unchangedByPrune) throw new TokenLedgerMaintenanceError('TOKEN_LEDGER_REGRESSION');

        return {
          schemaVersion: TOKEN_LEDGER_MAINTENANCE_SCHEMA_VERSION,
          status: 'completed',
          mode: 'execute',
          generatedAt: new Date(nowMs).toISOString(),
          scan: safeScanSummary(candidate.scan),
          ledger: {
            ...ledgerSummary,
            entryCounts: {
              ...ledgerSummary.entryCounts,
              committed: Array.isArray(canonicalLedger.entries)
                ? canonicalLedger.entries.length
                : 0,
            },
            committedGeneratedAt:
              typeof canonicalLedger.generatedAt === 'string' ? canonicalLedger.generatedAt : null,
            beforePrune,
            afterPrune,
            unchangedByPrune,
          },
          ledgerEntries: Array.isArray(canonicalLedger.entries)
            ? canonicalLedger.entries.length
            : 0,
          totalTokens: beforePrune.total,
          ledgerGeneratedAt:
            typeof canonicalLedger.generatedAt === 'string' ? canonicalLedger.generatedAt : null,
          prune,
          safety: {
            activeWindowMinutes: effectiveActiveWindowMinutes,
            lockVersion: TOKEN_LEDGER_MAINTENANCE_LOCK_VERSION,
            allowlistedRootsPresent: preCommitPlan.summary.allowlistedRootsPresent,
            canExecute: true,
          },
        };
      })
    );

  return { preview, execute };
};

export const toSafeTokenLedgerMaintenanceError = (error) => {
  const code =
    error instanceof TokenLedgerMaintenanceError && SAFE_ERROR_MESSAGES[error.code]
      ? error.code
      : 'TOKEN_LEDGER_INTERNAL';
  const payload = {
    schemaVersion: TOKEN_LEDGER_MAINTENANCE_SCHEMA_VERSION,
    status: 'error',
    code,
    message: SAFE_ERROR_MESSAGES[code],
  };
  for (const key of ['availableBytes', 'requiredBytes', 'reserveBytes', 'writeBytes']) {
    const value = error instanceof TokenLedgerMaintenanceError ? error.details?.[key] : null;
    if (Number.isFinite(value) && value >= 0) payload[key] = Math.floor(value);
  }
  return payload;
};
