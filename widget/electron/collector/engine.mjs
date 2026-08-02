import { watch } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  LOG_FILE_PATTERN,
  buildRequestDedupeKey,
  emptyTokenUsage,
  hashPrivateIdentifier,
  normalizeModelName,
  normalizeTokenUsage,
  parseLogFilename,
} from '../../../scripts/lib/token-log-core.mjs';
import { sanitizeModelPricingOverrides } from '../../../scripts/lib/token-pricing-core.mjs';
import { buildWidgetSnapshot } from './aggregate.mjs';
import { streamLedgerEntries } from './ledgerStream.mjs';
import { readBoundedResponseLog } from './logReader.mjs';

const DEFAULT_RECONCILE_INTERVAL_MS = 30_000;
const DEFAULT_STABILITY_DELAY_MS = 750;
const DEFAULT_MAX_CONCURRENT_LOG_READS = 8;
const WATCH_DEBOUNCE_MS = 250;
const PENDING_STATE_VERSION = 1;
const PENDING_STATE_FILE_NAME = 'unledgered-v1.json';
const PENDING_ENTRY_STATUSES = new Set([
  'available',
  'unreported',
  'ambiguous',
  'parse-error',
  'unsupported',
]);
const ATOMIC_WRITE_RETRIES = 6;
const ATOMIC_WRITE_RETRY_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY', 'ENOTEMPTY']);

const fingerprintForStats = (stats) => `${stats.size}:${Math.floor(stats.mtimeMs)}`;

const writeAtomicTextFile = async (filePath, contents) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt < ATOMIC_WRITE_RETRIES; attempt += 1) {
    const tempPath = `${filePath}.${process.pid}-${Date.now()}-${attempt}.tmp`;
    const backupPath = `${filePath}.${process.pid}-${Date.now()}-${attempt}.bak`;
    let preserveBackup = false;
    try {
      await fs.writeFile(tempPath, contents, { encoding: 'utf8', flag: 'wx' });
      try {
        await fs.rename(tempPath, filePath);
        return;
      } catch (error) {
        if (!ATOMIC_WRITE_RETRY_CODES.has(error?.code)) throw error;

        let originalMoved = false;
        try {
          await fs.rename(filePath, backupPath);
          originalMoved = true;
        } catch (backupError) {
          if (backupError?.code !== 'ENOENT') throw backupError;
        }

        try {
          await fs.rename(tempPath, filePath);
          if (originalMoved) await fs.rm(backupPath, { force: true });
          return;
        } catch (replaceError) {
          if (originalMoved) {
            await fs.rm(filePath, { force: true }).catch(() => {});
            try {
              await fs.rename(backupPath, filePath);
            } catch {
              preserveBackup = true;
            }
          }
          throw replaceError;
        }
      }
    } catch (error) {
      lastError = error;
      if (attempt + 1 < ATOMIC_WRITE_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
      }
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
      if (!preserveBackup) await fs.rm(backupPath, { force: true }).catch(() => {});
    }
  }
  throw lastError ?? new Error('atomic-write-failed');
};

const canonicalSourceIdentity = (sourceDir, fileName) =>
  `${path.normalize(path.resolve(sourceDir)).toLowerCase()}::${String(fileName).toLowerCase()}`;

const safeStatusFromLedger = (entry, usage) => {
  if (entry.detailStatus === 'ambiguous' || entry.tokenUsage?.status === 'ambiguous') {
    return 'ambiguous';
  }
  if (entry.detailStatus === 'error' || entry.tokenUsage?.status === 'error') return 'parse-error';
  if (usage.status === 'available') return 'available';
  return 'unreported';
};

const normalizeLedgerUsage = (rawUsage) => {
  if (!rawUsage || typeof rawUsage !== 'object') return emptyTokenUsage('unreported');
  const normalized = normalizeTokenUsage({
    input_tokens: rawUsage.input,
    output_tokens: rawUsage.output,
    total_tokens: rawUsage.total,
    input_tokens_details: { cached_tokens: rawUsage.cached },
    output_tokens_details: { reasoning_tokens: rawUsage.reasoning },
  });
  if (rawUsage.status !== 'available') return emptyTokenUsage('unreported');
  return normalized;
};

const isGptImageModel = (model) => model?.toLowerCase().startsWith('gpt-image-') === true;
const LEGACY_MISATTRIBUTED_IMAGE_MODELS = new Set(['gpt-image-2', 'gpt-image-2-codex']);

const repairLegacyLedgerModelMisattribution = (configuredModel, actualModel) => {
  const configured = normalizeModelName(configuredModel);
  const actual = normalizeModelName(actualModel);

  // Older ledgers could record a nested image_generation tool model as the request's actual model.
  if (
    actual &&
    configured &&
    LEGACY_MISATTRIBUTED_IMAGE_MODELS.has(actual.toLowerCase()) &&
    !isGptImageModel(configured)
  ) {
    return configured;
  }

  return actualModel === null || actualModel === undefined ? configured : actual;
};

const normalizeLedgerEntry = (raw, index) => {
  if (!raw || typeof raw !== 'object') return null;
  const fileName = typeof raw.fileName === 'string' ? raw.fileName : '';
  const sourceDir = typeof raw.sourceDir === 'string' ? raw.sourceDir : '';
  const filenameInfo = parseLogFilename(
    fileName,
    Number.isFinite(raw.timestampMs) ? raw.timestampMs : null
  );
  const timestampMs = Number.isFinite(raw.timestampMs)
    ? Math.floor(raw.timestampMs)
    : filenameInfo.timestampMs;
  const hasCanonicalSource = Boolean(sourceDir && fileName);
  const sourceIdentity = hasCanonicalSource
    ? canonicalSourceIdentity(sourceDir, fileName)
    : `ledger:${index}:${String(raw.sourceKey ?? fileName)}`;
  const sourceHash = hasCanonicalSource
    ? hashPrivateIdentifier(sourceIdentity)
    : `history:${index}`;
  const requestId = typeof raw.requestId === 'string' ? raw.requestId : filenameInfo.requestId;
  const usage = normalizeLedgerUsage(raw.tokenUsage);
  const status = safeStatusFromLedger(raw, usage);

  return {
    sourceHash,
    semanticError: !hasCanonicalSource,
    fingerprint:
      hasCanonicalSource && Number.isFinite(raw.fileSize) && Number.isFinite(raw.lastModifiedMs)
        ? `${Math.floor(raw.fileSize)}:${Math.floor(raw.lastModifiedMs)}`
        : null,
    entry: {
      dedupeKey: buildRequestDedupeKey({
        fileType: raw.fileType ?? filenameInfo.fileType,
        timestampMs,
        requestId,
        sourceIdentity,
      }),
      timestampMs,
      lastModifiedMs: Number.isFinite(raw.lastModifiedMs) ? Math.floor(raw.lastModifiedMs) : 0,
      model: repairLegacyLedgerModelMisattribution(raw.configuredModel, raw.actualModel),
      status,
      tokenUsage:
        status === 'parse-error'
          ? emptyTokenUsage('parse-error')
          : status === 'ambiguous'
            ? emptyTokenUsage('ambiguous')
            : usage,
    },
  };
};

const normalizePendingEntry = (raw) => {
  if (!raw || typeof raw !== 'object') return null;
  if (
    typeof raw.sourceHash !== 'string' ||
    !/^[a-f0-9]{64}$/i.test(raw.sourceHash) ||
    typeof raw.fingerprint !== 'string' ||
    !/^\d+:\d+$/.test(raw.fingerprint) ||
    typeof raw.dedupeKey !== 'string' ||
    !/^(?:request|source):[a-f0-9]{64}$/i.test(raw.dedupeKey) ||
    !Number.isFinite(raw.timestampMs) ||
    !Number.isFinite(raw.lastModifiedMs) ||
    typeof raw.status !== 'string' ||
    !PENDING_ENTRY_STATUSES.has(raw.status)
  ) {
    return null;
  }

  const model = raw.model === null ? null : normalizeModelName(raw.model);
  if (raw.model !== null && model === null) return null;

  const usage = normalizeTokenUsage({
    input_tokens: raw.tokenUsage?.input,
    output_tokens: raw.tokenUsage?.output,
    total_tokens: raw.tokenUsage?.total,
    input_tokens_details: { cached_tokens: raw.tokenUsage?.cached },
    output_tokens_details: { reasoning_tokens: raw.tokenUsage?.reasoning },
  });
  if (raw.status === 'available' && usage.status !== 'available') return null;

  const tokenUsage =
    raw.status === 'available' ? usage : emptyTokenUsage(raw.status);
  const sourceHash = raw.sourceHash.toLowerCase();
  return {
    sourceHash,
    fingerprint: raw.fingerprint,
    entry: {
      dedupeKey: raw.dedupeKey,
      timestampMs: Math.floor(raw.timestampMs),
      lastModifiedMs: Math.floor(raw.lastModifiedMs),
      model,
      status: raw.status,
      tokenUsage,
    },
  };
};

const serializePendingEntry = ({ sourceHash, fingerprint, entry }) => ({
  sourceHash,
  fingerprint,
  dedupeKey: entry.dedupeKey,
  timestampMs: entry.timestampMs,
  lastModifiedMs: entry.lastModifiedMs,
  model: entry.model,
  status: entry.status,
  tokenUsage: {
    input: entry.tokenUsage.input,
    output: entry.tokenUsage.output,
    cached: entry.tokenUsage.cached,
    reasoning: entry.tokenUsage.reasoning,
    total: entry.tokenUsage.total,
  },
});

const entriesEquivalent = (left, right) => {
  if (!left || !right || left.status !== right.status || left.model !== right.model) {
    return false;
  }
  const leftUsage = left.tokenUsage ?? emptyTokenUsage();
  const rightUsage = right.tokenUsage ?? emptyTokenUsage();
  return (
    leftUsage.status === rightUsage.status &&
    leftUsage.input === rightUsage.input &&
    leftUsage.output === rightUsage.output &&
    leftUsage.cached === rightUsage.cached &&
    leftUsage.reasoning === rightUsage.reasoning &&
    leftUsage.total === rightUsage.total
  );
};

const listLogFiles = async (logsDirs) => {
  const files = [];
  const unavailableDirs = [];
  for (const logsDir of logsDirs) {
    let items;
    try {
      items = await fs.readdir(logsDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') {
        unavailableDirs.push(logsDir);
        continue;
      }
      throw error;
    }

    for (const item of items) {
      if (!item.isFile() || !LOG_FILE_PATTERN.test(item.name)) continue;
      const filePath = path.join(logsDir, item.name);
      try {
        const stats = await fs.stat(filePath);
        const sourceIdentity = canonicalSourceIdentity(logsDir, item.name);
        const filenameInfo = parseLogFilename(item.name, stats.mtimeMs);
        files.push({
          filePath,
          fileName: item.name,
          sourceHash: hashPrivateIdentifier(sourceIdentity),
          sourceIdentity,
          fingerprint: fingerprintForStats(stats),
          stats,
          filenameInfo,
        });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
  }
  return { files, unavailableDirs };
};

export class TokenPulseEngine {
  constructor(options) {
    this.installDir = path.resolve(options.installDir);
    this.cacheDir = path.resolve(options.cacheDir);
    this.pendingStatePath = path.resolve(
      options.pendingStatePath ??
        path.join(this.installDir, 'usage-backups', 'token-ledger', PENDING_STATE_FILE_NAME)
    );
    this.pendingStateRecoveryPath = `${this.pendingStatePath}.recovery`;
    this.logsDirs = options.logsDirs ?? [
      path.join(this.installDir, 'logs'),
      path.join(this.installDir, 'auths', 'logs'),
    ];
    this.ledgerPaths = options.ledgerPaths ?? [
      path.join(this.installDir, 'static', 'token-ledger.json'),
      path.join(this.installDir, 'usage-backups', 'token-ledger', 'ledger.json'),
    ];
    this.reconcileIntervalMs = options.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
    this.stabilityDelayMs = options.stabilityDelayMs ?? DEFAULT_STABILITY_DELAY_MS;
    this.awaitInitialReconcile = options.awaitInitialReconcile === true;
    this.maxConcurrentLogReads = Math.max(
      1,
      Math.min(32, Math.floor(options.maxConcurrentLogReads ?? DEFAULT_MAX_CONCURRENT_LOG_READS))
    );
    this.now = options.now ?? Date.now;
    this.readLog = options.readLog ?? readBoundedResponseLog;
    this.pendingStateWriter = options.pendingStateWriter ?? writeAtomicTextFile;
    this.watchFactory = options.watchFactory ?? watch;
    this.waitForStability =
      options.waitForStability ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.pricingOverrides = sanitizeModelPricingOverrides(options.pricingOverrides);
    this.baselineEntries = new Map();
    this.liveEntries = new Map();
    this.pendingEntries = new Map();
    this.persistedPendingEntries = new Map();
    this.baselineFingerprints = new Map();
    this.liveFingerprints = new Map();
    this.observations = new Map();
    this.watchers = new Map();
    this.listeners = new Set();
    this.queuedWatchPaths = new Set();
    this.snapshot = null;
    this.loadedLedgerIdentity = null;
    this.ledgerGeneratedAt = null;
    this.ledgerCoverageStartMs = null;
    this.ledgerCoverageEndMs = null;
    this.ledgerParseErrors = 0;
    this.lastSuccessfulScanAtMs = null;
    this.lastReconcileAtMs = null;
    this.possibleCoverageGap = false;
    this.ledgerCoverageGap = false;
    this.pendingLedgerConflict = false;
    this.unavailableDirs = [];
    this.currentSourceIdentities = new Set();
    this.started = false;
    this.starting = false;
    this.stopped = false;
    this.reconcileChain = Promise.resolve(null);
    this.interval = null;
    this.watchTimer = null;
    this.pendingTimer = null;
    this.cacheWriteChain = Promise.resolve();
    this.pendingStateWriteChain = Promise.resolve();
    this.pendingStateLoaded = false;
    this.pendingStateDirty = false;
    this.pendingStateError = false;
    this.pendingStateErrorCode = null;
    this.pendingStateErrorCount = 0;
    this.pendingStateMainError = false;
    this.pendingStateWritePath = this.pendingStatePath;
    this.initialReconcilePromise = null;
  }

  async start() {
    if (this.started && this.snapshot) return this.snapshot;
    this.started = true;
    this.starting = true;
    this.stopped = false;
    let highWater;
    try {
      await this.loadPendingState();
      await this.ensureWatchers();
      highWater = await listLogFiles(this.logsDirs);
      this.currentSourceIdentities = new Set(highWater.files.map((file) => file.sourceIdentity));
      this.unavailableDirs = highWater.unavailableDirs;
      await this.reloadLedgerIfChanged(true);
      this.publishSnapshot();
    } finally {
      this.starting = false;
    }

    const initialReconcile = this.reconcileChain.then(async () => {
      await this.scanFiles(highWater, false);
      if (this.stabilityDelayMs > 0) {
        await this.waitForStability(this.stabilityDelayMs);
      }
      return this.performReconcile();
    });
    this.initialReconcilePromise = initialReconcile;
    this.reconcileChain = initialReconcile.catch(() => null);
    this.interval = setInterval(() => void this.reconcile(), this.reconcileIntervalMs);
    this.interval.unref?.();

    if (this.awaitInitialReconcile) {
      await initialReconcile;
    } else {
      void initialReconcile.catch(() => {
        this.possibleCoverageGap = true;
        this.publishSnapshot();
      });
    }
    return this.snapshot;
  }

  async stop() {
    this.stopped = true;
    if (this.interval) clearInterval(this.interval);
    if (this.watchTimer) clearTimeout(this.watchTimer);
    if (this.pendingTimer) clearTimeout(this.pendingTimer);
    this.interval = null;
    this.watchTimer = null;
    this.pendingTimer = null;
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
    await this.initialReconcilePromise?.catch(() => null);
    await this.cacheWriteChain;
    await this.pendingStateWriteChain;
  }

  getSnapshot() {
    return this.snapshot;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    if (this.snapshot) listener(this.snapshot);
    return () => this.listeners.delete(listener);
  }

  updatePricing(pricingOverrides) {
    this.pricingOverrides = sanitizeModelPricingOverrides(pricingOverrides);
    this.publishSnapshot();
    return this.snapshot;
  }

  reconcile() {
    const next = this.reconcileChain.then(() => this.performReconcile());
    this.reconcileChain = next.catch(() => null);
    return next;
  }

  async performReconcile() {
    if (this.stopped) return this.snapshot;
    await this.ensureWatchers();
    const listing = await listLogFiles(this.logsDirs);
    this.currentSourceIdentities = new Set(listing.files.map((file) => file.sourceIdentity));
    await this.reloadLedgerIfChanged(false);
    await this.scanFiles(listing, true);
    this.lastReconcileAtMs = this.now();
    this.publishSnapshot();
    return this.snapshot;
  }

  refreshPossibleCoverageGap() {
    this.possibleCoverageGap =
      this.ledgerCoverageGap || this.pendingLedgerConflict || this.pendingStateError;
  }

  markPendingStateError(code, preserveMainState = false) {
    this.pendingStateError = true;
    this.pendingStateErrorCode = code;
    this.pendingStateErrorCount = 1;
    if (preserveMainState) {
      this.pendingStateMainError = true;
      this.pendingStateWritePath = this.pendingStateRecoveryPath;
    }
    this.refreshPossibleCoverageGap();
  }

  clearPendingStateError() {
    if (this.pendingStateMainError) return;
    this.pendingStateError = false;
    this.pendingStateErrorCode = null;
    this.pendingStateErrorCount = 0;
    this.refreshPossibleCoverageGap();
  }

  applyPendingStateDocument(document, targetEntries) {
    if (
      !document ||
      typeof document !== 'object' ||
      document.version !== PENDING_STATE_VERSION ||
      !Array.isArray(document.entries)
    ) {
      return false;
    }

    let semanticErrors = 0;
    for (const rawEntry of document.entries) {
      const normalized = normalizePendingEntry(rawEntry);
      if (!normalized || targetEntries.has(normalized.sourceHash)) {
        semanticErrors += 1;
        continue;
      }
      targetEntries.set(normalized.sourceHash, normalized);
    }
    return semanticErrors === 0;
  }

  async readPendingStateDocument(filePath) {
    let text;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return { status: 'missing', document: null };
      return { status: 'unavailable', document: null };
    }

    try {
      return { status: 'loaded', document: JSON.parse(text) };
    } catch {
      return { status: 'corrupt', document: null };
    }
  }

  async loadPendingState() {
    if (this.pendingStateLoaded) return;
    this.pendingStateLoaded = true;

    const nextEntries = new Map();
    const mainState = await this.readPendingStateDocument(this.pendingStatePath);
    if (mainState.status === 'loaded') {
      if (!this.applyPendingStateDocument(mainState.document, nextEntries)) {
        this.markPendingStateError('collector-unledgered-state-corrupt', true);
      }
    } else if (mainState.status === 'corrupt') {
      this.markPendingStateError('collector-unledgered-state-corrupt', true);
    } else if (mainState.status === 'unavailable') {
      this.markPendingStateError('collector-unledgered-state-unavailable', true);
    }

    if (mainState.status !== 'loaded' || this.pendingStateMainError) {
      const recoveryState = await this.readPendingStateDocument(this.pendingStateRecoveryPath);
      if (recoveryState.status === 'loaded') {
        if (!this.applyPendingStateDocument(recoveryState.document, nextEntries)) {
          this.markPendingStateError('collector-unledgered-state-corrupt', true);
        }
      } else if (recoveryState.status === 'corrupt') {
        this.markPendingStateError('collector-unledgered-state-corrupt', true);
      } else if (recoveryState.status === 'unavailable') {
        this.markPendingStateError('collector-unledgered-state-unavailable', true);
      }
    }

    this.pendingEntries = nextEntries;
    this.persistedPendingEntries = new Map(nextEntries);
    for (const [sourceHash, pending] of nextEntries) {
      this.liveEntries.set(sourceHash, pending.entry);
      this.liveFingerprints.set(sourceHash, pending.fingerprint);
    }
  }

  async flushPendingState() {
    if (!this.pendingStateDirty) return;
    const document = {
      version: PENDING_STATE_VERSION,
      entries: [...this.pendingEntries.values()].map(serializePendingEntry),
    };
    const contents = `${JSON.stringify(document, null, 2)}\n`;
    this.pendingStateDirty = false;
    this.pendingStateWriteChain = this.pendingStateWriteChain.then(async () => {
      try {
        await this.pendingStateWriter(this.pendingStateWritePath, contents);
        this.persistedPendingEntries = new Map(this.pendingEntries);
        this.clearPendingStateError();
      } catch {
        this.pendingStateDirty = true;
        this.markPendingStateError('collector-unledgered-state-unavailable');
      }
    });
    await this.pendingStateWriteChain;
  }

  markPendingEntryAmbiguous(sourceHash, pending) {
    this.liveEntries.set(sourceHash, {
      ...pending.entry,
      dedupeKey: `conflict:${sourceHash}`,
      status: 'ambiguous',
      tokenUsage: emptyTokenUsage('ambiguous'),
    });
  }

  consumeLedgerEntries(ledgerEntries, ledgerFingerprints) {
    this.pendingLedgerConflict = false;
    if (this.pendingEntries.size === 0) {
      this.refreshPossibleCoverageGap();
      return;
    }
    const ledgerByDedupeKey = new Map();
    for (const entry of ledgerEntries.values()) {
      const candidates = ledgerByDedupeKey.get(entry.dedupeKey) ?? [];
      candidates.push(entry);
      ledgerByDedupeKey.set(entry.dedupeKey, candidates);
    }
    for (const [sourceHash, pending] of this.pendingEntries) {
      const ledgerEntry = ledgerEntries.get(sourceHash);
      const ledgerFingerprint = ledgerFingerprints.get(sourceHash);
      const sameSourceAndFingerprint =
        ledgerEntry &&
        Boolean(ledgerFingerprint) &&
        pending.fingerprint === ledgerFingerprint &&
        entriesEquivalent(pending.entry, ledgerEntry);
      const sameRequestCandidates = ledgerByDedupeKey.get(pending.entry.dedupeKey) ?? [];
      const sameRequestAndEquivalent =
        sameRequestCandidates.length > 0 &&
        sameRequestCandidates.every((entry) => entriesEquivalent(pending.entry, entry));
      if (!sameSourceAndFingerprint && !sameRequestAndEquivalent) {
        if (ledgerEntry && ledgerFingerprint && pending.fingerprint === ledgerFingerprint) {
          this.pendingLedgerConflict = true;
          this.markPendingEntryAmbiguous(sourceHash, pending);
        }
        if (
          sameRequestCandidates.some((entry) => !entriesEquivalent(pending.entry, entry))
        ) {
          this.pendingLedgerConflict = true;
          this.markPendingEntryAmbiguous(sourceHash, pending);
        }
        continue;
      }

      this.pendingEntries.delete(sourceHash);
      this.persistedPendingEntries.delete(sourceHash);
      this.liveEntries.delete(sourceHash);
      this.liveFingerprints.delete(sourceHash);
      this.observations.delete(sourceHash);
      this.pendingStateDirty = true;
    }
    this.refreshPossibleCoverageGap();
  }

  async reloadLedgerIfChanged(force) {
    let sawCandidateFailure = false;
    for (const ledgerPath of this.ledgerPaths) {
      let stats;
      try {
        stats = await fs.stat(ledgerPath);
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'EACCES' || error?.code === 'EPERM') {
          sawCandidateFailure ||= error?.code !== 'ENOENT';
          continue;
        }
        throw error;
      }
      const identity = `${path.normalize(ledgerPath).toLowerCase()}|${fingerprintForStats(stats)}`;
      if (!force && identity === this.loadedLedgerIdentity) {
        this.ledgerCoverageGap = sawCandidateFailure;
        this.refreshPossibleCoverageGap();
        return 'unchanged';
      }

      const nextEntries = new Map();
      const nextFingerprints = new Map();
      let index = 0;
      let semanticErrors = 0;
      try {
        const result = await streamLedgerEntries(ledgerPath, {
          onEntry: (rawEntry) => {
            const normalized = normalizeLedgerEntry(rawEntry, index);
            index += 1;
            if (!normalized) {
              semanticErrors += 1;
              return;
            }
            if (normalized.semanticError) semanticErrors += 1;
            if (nextEntries.has(normalized.sourceHash)) {
              semanticErrors += 1;
              return;
            }
            nextEntries.set(normalized.sourceHash, normalized.entry);
            if (normalized.fingerprint) {
              nextFingerprints.set(normalized.sourceHash, normalized.fingerprint);
            }
          },
        });
        const totalParseErrors =
          result.parseErrors + semanticErrors + (result.version === 1 ? 0 : 1);
        this.baselineEntries = nextEntries;
        this.baselineFingerprints = nextFingerprints;
        if (totalParseErrors === 0) {
          this.pendingLedgerConflict = false;
          this.consumeLedgerEntries(nextEntries, nextFingerprints);
          await this.flushPendingState();
        }
        this.loadedLedgerIdentity = identity;
        this.ledgerGeneratedAt = result.generatedAt;
        this.ledgerCoverageStartMs = result.coverageStartMs;
        this.ledgerCoverageEndMs = result.coverageEndMs;
        this.ledgerParseErrors = totalParseErrors;
        this.ledgerCoverageGap = sawCandidateFailure || totalParseErrors > 0;
        this.refreshPossibleCoverageGap();
        return 'reloaded';
      } catch {
        sawCandidateFailure = true;
      }
    }

    const hadLoadedLedger = this.loadedLedgerIdentity !== null;
    if (force) {
      this.baselineEntries.clear();
      this.baselineFingerprints.clear();
      this.loadedLedgerIdentity = null;
    }
    this.ledgerCoverageGap = sawCandidateFailure || hadLoadedLedger;
    this.refreshPossibleCoverageGap();
    if (sawCandidateFailure || hadLoadedLedger || this.pendingStateError) {
      return 'failed';
    }
    return 'missing';
  }

  async scanFiles(listing, schedulePending = true) {
    this.unavailableDirs = listing.unavailableDirs;
    const presentSourceHashes = new Set(listing.files.map((file) => file.sourceHash));
    if (listing.unavailableDirs.length === 0) {
      for (const sourceHash of this.liveEntries.keys()) {
        if (presentSourceHashes.has(sourceHash) || this.pendingEntries.has(sourceHash)) continue;
        this.liveEntries.delete(sourceHash);
        this.liveFingerprints.delete(sourceHash);
        this.observations.delete(sourceHash);
      }
    }
    for (let index = 0; index < listing.files.length; index += this.maxConcurrentLogReads) {
      await Promise.all(
        listing.files
          .slice(index, index + this.maxConcurrentLogReads)
          .map((file) => this.processFile(file))
      );
    }
    this.lastSuccessfulScanAtMs = this.now();
    this.queuedWatchPaths.clear();
    if (this.ledgerParseErrors === 0) {
      this.consumeLedgerEntries(this.baselineEntries, this.baselineFingerprints);
    }
    await this.flushPendingState();
    if (schedulePending) this.schedulePendingPass();
  }

  async processFile(file) {
    const recordedFingerprint =
      this.liveFingerprints.get(file.sourceHash) ?? this.baselineFingerprints.get(file.sourceHash);
    if (recordedFingerprint === file.fingerprint) return;

    const previousObservation = this.observations.get(file.sourceHash);
    const stable = previousObservation?.fingerprint === file.fingerprint;
    this.observations.set(file.sourceHash, {
      fingerprint: file.fingerprint,
      observedAtMs: this.now(),
    });

    let parsed;
    try {
      const result = await this.readLog(file.filePath, file.stats, { stable });
      parsed = result.parsed;
    } catch {
      if (!stable) {
        parsed = {
          status: 'pending',
          model: null,
          tokenUsage: emptyTokenUsage('pending'),
        };
      } else {
        parsed = {
          status: 'parse-error',
          model: null,
          tokenUsage: emptyTokenUsage('parse-error'),
        };
      }
    }

    const entry = {
      dedupeKey: buildRequestDedupeKey({
        fileType: file.filenameInfo.fileType,
        timestampMs: file.filenameInfo.timestampMs,
        requestId: file.filenameInfo.requestId,
        sourceIdentity: file.sourceIdentity,
      }),
      timestampMs: file.filenameInfo.timestampMs,
      lastModifiedMs: Math.floor(file.stats.mtimeMs),
      model: parsed.model,
      status: parsed.status,
      tokenUsage: parsed.tokenUsage,
    };
    this.liveEntries.set(file.sourceHash, entry);

    if (parsed.status !== 'pending') {
      this.liveFingerprints.set(file.sourceHash, file.fingerprint);
      this.pendingEntries.set(file.sourceHash, {
        sourceHash: file.sourceHash,
        fingerprint: file.fingerprint,
        entry,
      });
      this.pendingStateDirty = true;
    }
  }

  async ensureWatchers() {
    const watchDirs = [
      ...this.logsDirs,
      ...new Set(this.ledgerPaths.map((ledgerPath) => path.dirname(ledgerPath))),
      path.dirname(this.pendingStatePath),
    ];
    for (const directory of watchDirs) {
      const normalized = path.normalize(directory).toLowerCase();
      if (this.watchers.has(normalized)) continue;
      try {
        const stats = await fs.stat(directory);
        if (!stats.isDirectory()) continue;
        const watcher = this.watchFactory(
          directory,
          { persistent: false },
          (_eventType, fileName) => {
            if (fileName) this.queuedWatchPaths.add(path.join(directory, String(fileName)));
            this.scheduleWatchPass();
          }
        );
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(normalized);
        });
        this.watchers.set(normalized, watcher);
      } catch {
        // A later reconcile retries missing or temporarily inaccessible directories.
      }
    }
  }

  scheduleWatchPass() {
    if (this.stopped || this.starting || this.watchTimer) return;
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.reconcile();
    }, WATCH_DEBOUNCE_MS);
    this.watchTimer.unref?.();
  }

  schedulePendingPass() {
    const hasPending = [...this.liveEntries.values()].some((entry) => entry.status === 'pending');
    if (!hasPending || this.pendingTimer || this.stopped) return;
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null;
      void this.reconcile();
    }, this.stabilityDelayMs);
    this.pendingTimer.unref?.();
  }

  publishSnapshot() {
    const ledgerEntries = [...this.baselineEntries.values()];
    const liveEntries = [...this.liveEntries.values()];
    const entries = [...ledgerEntries, ...liveEntries];
    let pendingFiles = 0;
    let parseErrors = this.ledgerParseErrors + this.pendingStateErrorCount;
    let unsupportedFiles = 0;
    for (const entry of entries) {
      if (entry.status === 'pending') pendingFiles += 1;
      else if (entry.status === 'parse-error') parseErrors += 1;
      else if (entry.status === 'unsupported') unsupportedFiles += 1;
    }
    const availableSourceCount = this.logsDirs.length - this.unavailableDirs.length;
    let status = 'live';
    let messageCode = null;
    if (this.pendingStateError) {
      status = 'degraded';
      messageCode = this.pendingStateErrorCode;
    } else if (this.pendingLedgerConflict) {
      status = 'degraded';
      messageCode = 'collector-unledgered-conflict';
    } else if (availableSourceCount === 0 && !this.loadedLedgerIdentity) {
      status = 'offline';
      messageCode = 'collector-sources-unavailable';
    } else if (!this.loadedLedgerIdentity) {
      status = 'degraded';
      messageCode = 'collector-ledger-unavailable';
    } else if (this.unavailableDirs.length > 0 || this.possibleCoverageGap) {
      status = 'degraded';
      messageCode = this.possibleCoverageGap
        ? 'collector-coverage-gap'
        : 'collector-partial-sources';
    }

    this.snapshot = buildWidgetSnapshot({
      entries,
      ledgerEntries,
      liveEntries,
      nowMs: this.now(),
      installDir: this.installDir,
      pricingOverrides: this.pricingOverrides,
      source: {
        status,
        ledgerGeneratedAt: this.ledgerGeneratedAt,
        ledgerCoverageStartMs: this.ledgerCoverageStartMs,
        ledgerCoverageEndMs: this.ledgerCoverageEndMs,
        lastSuccessfulScanAtMs: this.lastSuccessfulScanAtMs,
        lastReconcileAtMs: this.lastReconcileAtMs,
        pendingFiles,
        parseErrors,
        unsupportedFiles,
        possibleCoverageGap: this.possibleCoverageGap,
        messageCode,
      },
    });
    const snapshotToCache = this.snapshot;
    this.cacheWriteChain = this.cacheWriteChain
      .then(() => this.writeSnapshotCache(snapshotToCache))
      .catch(() => {});
    for (const listener of this.listeners) listener(this.snapshot);
  }

  async writeSnapshotCache(snapshot) {
    const cachePath = path.join(this.cacheDir, 'snapshot-v1.json');
    const tempPath = `${cachePath}.${process.pid}-${Date.now()}.tmp`;
    await fs.mkdir(this.cacheDir, { recursive: true });
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(snapshot)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
      await fs.rename(tempPath, cachePath);
    } finally {
      await fs.rm(tempPath, { force: true }).catch(() => {});
    }
  }
}
