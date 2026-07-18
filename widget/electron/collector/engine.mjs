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

const fingerprintForStats = (stats) => `${stats.size}:${Math.floor(stats.mtimeMs)}`;

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
    this.watchFactory = options.watchFactory ?? watch;
    this.waitForStability =
      options.waitForStability ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
    this.pricingOverrides = sanitizeModelPricingOverrides(options.pricingOverrides);
    this.baselineEntries = new Map();
    this.liveEntries = new Map();
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
    this.initialReconcilePromise = null;
  }

  async start() {
    if (this.started && this.snapshot) return this.snapshot;
    this.started = true;
    this.starting = true;
    this.stopped = false;
    let highWater;
    try {
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
    const ledgerReloadStatus = await this.reloadLedgerIfChanged(false);
    await this.scanFiles(
      listing,
      true,
      ledgerReloadStatus !== 'failed' && this.ledgerParseErrors === 0
    );
    this.lastReconcileAtMs = this.now();
    this.publishSnapshot();
    return this.snapshot;
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
        if (sawCandidateFailure) this.possibleCoverageGap = true;
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
          for (const sourceHash of nextFingerprints.keys()) {
            this.liveEntries.delete(sourceHash);
            this.liveFingerprints.delete(sourceHash);
            this.observations.delete(sourceHash);
          }
        }
        this.loadedLedgerIdentity = identity;
        this.ledgerGeneratedAt = result.generatedAt;
        this.ledgerCoverageStartMs = result.coverageStartMs;
        this.ledgerCoverageEndMs = result.coverageEndMs;
        this.ledgerParseErrors = totalParseErrors;
        this.possibleCoverageGap = sawCandidateFailure || totalParseErrors > 0;
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
    if (sawCandidateFailure || hadLoadedLedger) {
      this.possibleCoverageGap = true;
      return 'failed';
    }
    return 'missing';
  }

  async scanFiles(listing, schedulePending = true, allowMissingLivePurge = true) {
    this.unavailableDirs = listing.unavailableDirs;
    const presentSourceHashes = new Set(listing.files.map((file) => file.sourceHash));
    if (allowMissingLivePurge && listing.unavailableDirs.length === 0) {
      for (const sourceHash of this.liveEntries.keys()) {
        if (presentSourceHashes.has(sourceHash)) continue;
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
    }
  }

  async ensureWatchers() {
    const watchDirs = [
      ...this.logsDirs,
      ...new Set(this.ledgerPaths.map((ledgerPath) => path.dirname(ledgerPath))),
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
    let parseErrors = this.ledgerParseErrors;
    let unsupportedFiles = 0;
    for (const entry of entries) {
      if (entry.status === 'pending') pendingFiles += 1;
      else if (entry.status === 'parse-error') parseErrors += 1;
      else if (entry.status === 'unsupported') unsupportedFiles += 1;
    }
    const availableSourceCount = this.logsDirs.length - this.unavailableDirs.length;
    let status = 'live';
    let messageCode = null;
    if (availableSourceCount === 0 && !this.loadedLedgerIdentity) {
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
