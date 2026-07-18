import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  WidgetMaintenancePreviewV1,
  WidgetMaintenancePruneSummary,
  WidgetMaintenanceResultV1,
  WidgetEntryStatusCounts,
  WidgetSnapshotV1,
} from '../src/shared/contracts.js';

const PREVIEW_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const DEFAULT_LEDGER_MAINTENANCE_PREVIEW_TTL_MS = 60_000;
export const DEFAULT_LEDGER_MAINTENANCE_RUN_TIMEOUT_MS = 120_000;

type LedgerMaintenancePreviewPayload = Omit<
  WidgetMaintenancePreviewV1,
  'previewId' | 'createdAt' | 'expiresAt'
>;

export interface LedgerMaintenanceRunnerPreview {
  preview: LedgerMaintenancePreviewPayload;
  ticket: unknown;
  expiresAt?: string;
}

export interface LedgerMaintenanceInvariantFloor {
  totalTokens: number;
  requests: number;
  ledgerEntries: number;
}

export interface LedgerMaintenanceRunner {
  preview(): Promise<LedgerMaintenanceRunnerPreview>;
  execute(
    ticket: unknown,
    floor: LedgerMaintenanceInvariantFloor
  ): Promise<WidgetMaintenanceResultV1>;
}

interface UtilityProcessLike {
  on(event: 'spawn', listener: () => void): this;
  on(event: 'message', listener: (message: unknown) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  on(event: 'error', listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
  postMessage(message: unknown): void;
  kill(): boolean;
}

type ForkUtilityProcess = (
  modulePath: string,
  args: string[],
  options: {
    cwd: string;
    env: Record<string, string>;
    serviceName: string;
    stdio: 'ignore';
  }
) => UtilityProcessLike;

export interface LedgerMaintenanceController {
  preview(): Promise<WidgetMaintenancePreviewV1>;
  execute(previewId: unknown): Promise<WidgetMaintenanceResultV1>;
}

interface PreviewRecord {
  previewId: string;
  expiresAtMs: number;
  ticket: unknown;
  floor: LedgerMaintenanceInvariantFloor;
}

type LedgerMaintenanceErrorCode =
  | 'ledger-maintenance-busy'
  | 'ledger-maintenance-failed'
  | 'ledger-maintenance-invalid-response'
  | 'ledger-maintenance-low-space'
  | 'ledger-maintenance-preview-expired'
  | 'ledger-maintenance-preview-invalid'
  | 'ledger-maintenance-preview-unavailable'
  | 'ledger-maintenance-total-regression';

const LEDGER_MAINTENANCE_ERROR_CODES = new Set<LedgerMaintenanceErrorCode>([
  'ledger-maintenance-busy',
  'ledger-maintenance-failed',
  'ledger-maintenance-invalid-response',
  'ledger-maintenance-low-space',
  'ledger-maintenance-preview-expired',
  'ledger-maintenance-preview-invalid',
  'ledger-maintenance-preview-unavailable',
  'ledger-maintenance-total-regression',
]);

class LedgerMaintenanceError extends Error {
  readonly code: LedgerMaintenanceErrorCode;

  constructor(code: LedgerMaintenanceErrorCode) {
    super(code);
    this.name = 'LedgerMaintenanceError';
    this.code = code;
  }
}

const maintenanceError = (code: LedgerMaintenanceErrorCode): LedgerMaintenanceError =>
  new LedgerMaintenanceError(code);

const normalizeMaintenanceErrorCode = (value: unknown): LedgerMaintenanceErrorCode =>
  typeof value === 'string' && LEDGER_MAINTENANCE_ERROR_CODES.has(value as LedgerMaintenanceErrorCode)
    ? (value as LedgerMaintenanceErrorCode)
    : 'ledger-maintenance-failed';

export function resolveLedgerMaintenanceRunnerPath({
  isPackaged,
  resourcesPath,
  moduleUrl = import.meta.url,
}: {
  isPackaged: boolean;
  resourcesPath: string;
  moduleUrl?: string;
}): string {
  if (isPackaged) {
    return path.join(
      resourcesPath,
      'app.asar.unpacked',
      'dist-electron',
      'maintenance',
      'worker.js'
    );
  }
  return fileURLToPath(new URL('./maintenance/worker.js', moduleUrl));
}

const createMinimalEnvironment = (
  environment: Record<string, string | undefined>
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP'] as const) {
    const value = environment[key];
    if (typeof value === 'string' && value.length > 0) result[key] = value;
  }
  return result;
};

export function createBundledLedgerMaintenanceRunner({
  forkProcess,
  runnerPath,
  environment = process.env,
  timeoutMs = DEFAULT_LEDGER_MAINTENANCE_RUN_TIMEOUT_MS,
}: {
  forkProcess: ForkUtilityProcess;
  runnerPath: string;
  environment?: Record<string, string | undefined>;
  timeoutMs?: number;
}): LedgerMaintenanceRunner {
  type MaintenanceRequest =
    | { type: 'preview' }
    | { type: 'execute'; ticket: unknown; floor: LedgerMaintenanceInvariantFloor };
  type ExpectedType = 'preview-result' | 'execute-result';
  interface PendingRequest {
    expectedType: ExpectedType;
    request: MaintenanceRequest;
    resolve: (value: unknown) => void;
    reject: (error: LedgerMaintenanceError) => void;
    timeout: ReturnType<typeof setTimeout> | null;
  }
  interface RunnerSession {
    request(request: MaintenanceRequest, expectedType: ExpectedType): Promise<unknown>;
    close(kill: boolean): void;
    isAlive(): boolean;
  }

  let activeSession: RunnerSession | null = null;
  const createSession = (): RunnerSession => {
    let spawned = false;
    let alive = true;
    let pending: PendingRequest | null = null;

    const clearPendingTimeout = (): void => {
      if (pending?.timeout) clearTimeout(pending.timeout);
      if (pending) pending.timeout = null;
    };
    const rejectPending = (code: LedgerMaintenanceErrorCode): void => {
      const current = pending;
      if (!current) return;
      clearPendingTimeout();
      pending = null;
      current.reject(maintenanceError(code));
    };
    const armTimeout = (): void => {
      if (!pending) return;
      clearPendingTimeout();
      pending.timeout = setTimeout(() => {
        try {
          child.kill();
        } finally {
          alive = false;
          rejectPending('ledger-maintenance-failed');
        }
      }, timeoutMs);
      pending.timeout.unref?.();
    };
    const postPending = (): void => {
      if (!spawned || !pending) return;
      try {
        child.postMessage(pending.request);
        armTimeout();
      } catch {
        rejectPending('ledger-maintenance-failed');
      }
    };
    const onSpawn = (): void => {
      spawned = true;
      postPending();
    };
    const onMessage = (message: unknown): void => {
      if (!message || typeof message !== 'object' || Array.isArray(message)) {
        rejectPending('ledger-maintenance-failed');
        return;
      }
      const candidate = message as Record<string, unknown>;
      if (candidate.type === 'maintenance-progress') {
        armTimeout();
        return;
      }
      if (candidate.type === 'maintenance-error') {
        rejectPending(normalizeMaintenanceErrorCode(candidate.code));
        return;
      }
      const current = pending;
      if (!current || candidate.type !== current.expectedType) return;
      clearPendingTimeout();
      pending = null;
      if (current.expectedType === 'preview-result') {
        current.resolve({
          preview: candidate.preview,
          ticket: candidate.ticket,
          expiresAt: candidate.expiresAt,
        });
      } else {
        current.resolve(candidate.result);
      }
    };
    const onExit = (): void => {
      alive = false;
      rejectPending('ledger-maintenance-failed');
    };
    const onError = (): void => {
      alive = false;
      rejectPending('ledger-maintenance-failed');
    };
    const close = (kill: boolean): void => {
      if (!alive) return;
      alive = false;
      clearPendingTimeout();
      pending = null;
      child.removeListener('spawn', onSpawn as (...args: never[]) => void);
      child.removeListener('message', onMessage as (...args: never[]) => void);
      child.removeListener('exit', onExit as (...args: never[]) => void);
      child.removeListener('error', onError as (...args: never[]) => void);
      if (kill) child.kill();
    };

    const child = forkProcess(runnerPath, [], {
      cwd: path.dirname(runnerPath),
      env: createMinimalEnvironment(environment),
      serviceName: 'CPA Token Pulse Ledger Maintenance',
      stdio: 'ignore',
    });
    child.on('spawn', onSpawn);
    child.on('message', onMessage);
    child.on('exit', onExit);
    child.on('error', onError);

    return {
      request: (request, expectedType) =>
        new Promise((resolve, reject) => {
          if (!alive || pending) {
            reject(maintenanceError('ledger-maintenance-failed'));
            return;
          }
          pending = { expectedType, request, resolve, reject, timeout: null };
          postPending();
        }),
      close,
      isAlive: () => alive,
    };
  };

  return {
    preview: async () => {
      activeSession?.close(true);
      let session: RunnerSession;
      try {
        session = createSession();
      } catch {
        throw maintenanceError('ledger-maintenance-failed');
      }
      activeSession = session;
      try {
        return (await session.request(
          { type: 'preview' },
          'preview-result'
        )) as LedgerMaintenanceRunnerPreview;
      } catch (error) {
        if (activeSession === session) activeSession = null;
        session.close(true);
        throw error;
      }
    },
    execute: async (ticket, floor) => {
      const session = activeSession;
      activeSession = null;
      if (!session?.isAlive()) throw maintenanceError('ledger-maintenance-preview-unavailable');
      try {
        return (await session.request(
          { type: 'execute', ticket, floor },
          'execute-result'
        )) as WidgetMaintenanceResultV1;
      } finally {
        session.close(true);
      }
    },
  };
}

export const isValidLedgerMaintenancePreviewId = (value: unknown): value is string =>
  typeof value === 'string' && value.length === 36 && PREVIEW_ID_PATTERN.test(value);

export function verifyLedgerMaintenanceSnapshot(
  snapshot: Pick<WidgetSnapshotV1, 'source' | 'periods' | 'statusCounts' | 'ledgerView'>,
  result: WidgetMaintenanceResultV1,
  floor: LedgerMaintenanceInvariantFloor
): true {
  const combined = snapshot.periods.ledgerCoverage;
  const formal = snapshot.ledgerView.periods.ledgerCoverage;
  const combinedAvailableRequests = snapshot.statusCounts.available;
  const formalAvailableRequests = snapshot.ledgerView.statusCounts.available;
  const combinedLedgerEntries = countLedgerEntries(snapshot.statusCounts);
  const formalLedgerEntries = countLedgerEntries(snapshot.ledgerView.statusCounts);
  const resultGeneratedAtMs = Date.parse(result.ledgerGeneratedAt);
  const formalGeneratedAtMs = Date.parse(snapshot.source.ledgerGeneratedAt ?? '');
  if (
    !Number.isFinite(resultGeneratedAtMs) ||
    !Number.isFinite(formalGeneratedAtMs) ||
    formalGeneratedAtMs < resultGeneratedAtMs ||
    formal.totalTokens < result.totalTokens ||
    formal.requests < result.availableRequests ||
    formalLedgerEntries < result.ledgerEntries ||
    formalAvailableRequests !== formal.requests ||
    formalLedgerEntries < formalAvailableRequests ||
    combinedAvailableRequests !== combined.requests ||
    combinedLedgerEntries < combinedAvailableRequests
  ) {
    throw maintenanceError('ledger-maintenance-invalid-response');
  }
  if (
    combined.totalTokens < floor.totalTokens ||
    combinedAvailableRequests < floor.requests ||
    combined.requests < floor.requests ||
    combinedLedgerEntries < floor.ledgerEntries
  ) {
    throw maintenanceError('ledger-maintenance-total-regression');
  }
  return true;
}

const countLedgerEntries = (counts: WidgetEntryStatusCounts): number =>
  counts.available +
  counts.unreported +
  counts.ambiguous +
  counts.parseError +
  counts.unsupported;

export const getLedgerMaintenanceInvariantFloor = (
  snapshot: Pick<WidgetSnapshotV1, 'periods' | 'statusCounts'>
): LedgerMaintenanceInvariantFloor => ({
  totalTokens: snapshot.periods.ledgerCoverage.totalTokens,
  requests: snapshot.statusCounts.available,
  ledgerEntries: countLedgerEntries(snapshot.statusCounts),
});

export const getLedgerMaintenanceCommitFloor = (
  snapshot: Pick<WidgetSnapshotV1, 'ledgerView'>
): LedgerMaintenanceInvariantFloor => ({
  totalTokens: snapshot.ledgerView.periods.ledgerCoverage.totalTokens,
  requests: snapshot.ledgerView.statusCounts.available,
  ledgerEntries: countLedgerEntries(snapshot.ledgerView.statusCounts),
});

export async function previewLedgerMaintenanceAfterReconcile({
  reconcile,
  controller,
}: {
  reconcile: () => Promise<unknown>;
  controller: Pick<LedgerMaintenanceController, 'preview'>;
}): Promise<WidgetMaintenancePreviewV1> {
  await reconcile();
  return controller.preview();
}

export async function executeLedgerMaintenanceWithPostVerification({
  previewId,
  reconcile,
  controller,
}: {
  previewId: unknown;
  reconcile: () => Promise<WidgetSnapshotV1>;
  controller: Pick<LedgerMaintenanceController, 'execute'>;
}): Promise<WidgetMaintenanceResultV1> {
  const before = await reconcile();
  const floor = getLedgerMaintenanceInvariantFloor(before);
  const result = await controller.execute(previewId);
  try {
    const after = await reconcile();
    verifyLedgerMaintenanceSnapshot(after, result, floor);
    return result;
  } catch {
    return { ...result, postVerificationPending: true };
  }
}

export const isTrustedLedgerMaintenanceSender = (
  event: { sender: unknown; senderFrame: unknown },
  webContents: { mainFrame: unknown },
  isAllowedUrl: (url: string) => boolean
): boolean => {
  if (event.sender !== webContents || event.senderFrame !== webContents.mainFrame) return false;
  if (!event.senderFrame || typeof event.senderFrame !== 'object') return false;
  const url = (event.senderFrame as { url?: unknown }).url;
  return typeof url === 'string' && isAllowedUrl(url);
};

const isSafeCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

const projectPruneSummary = (value: unknown): WidgetMaintenancePruneSummary | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<WidgetMaintenancePruneSummary>;
  const fields = [
    'eligibleFiles',
    'eligibleBytes',
    'keptActiveFiles',
    'keptUnrecordedFiles',
    'keptIncompleteFiles',
    'keptFingerprintMismatchFiles',
    'failedFiles',
  ] as const;
  const projected = {} as WidgetMaintenancePruneSummary;
  for (const field of fields) {
    if (!isSafeCount(candidate[field])) return null;
    projected[field] = candidate[field];
  }
  return projected;
};

const projectPreviewPayload = (value: unknown): LedgerMaintenancePreviewPayload | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<LedgerMaintenancePreviewPayload>;
  const prune = projectPruneSummary(candidate.prune);
  if (
    candidate.version !== 1 ||
    (candidate.ledgerGeneratedAt !== null && !isIsoDate(candidate.ledgerGeneratedAt)) ||
    !isSafeCount(candidate.previousLedgerEntries) ||
    !isSafeCount(candidate.projectedLedgerEntries) ||
    !isSafeCount(candidate.previousAvailableRequests) ||
    !isSafeCount(candidate.projectedAvailableRequests) ||
    candidate.projectedAvailableRequests < candidate.previousAvailableRequests ||
    !isSafeCount(candidate.newLedgerFiles) ||
    !isSafeCount(candidate.previousTotalTokens) ||
    !isSafeCount(candidate.projectedTotalTokens) ||
    candidate.projectedTotalTokens < candidate.previousTotalTokens ||
    !prune
  ) {
    return null;
  }

  return {
    version: 1,
    ledgerGeneratedAt: candidate.ledgerGeneratedAt,
    previousLedgerEntries: candidate.previousLedgerEntries,
    projectedLedgerEntries: candidate.projectedLedgerEntries,
    previousAvailableRequests: candidate.previousAvailableRequests,
    projectedAvailableRequests: candidate.projectedAvailableRequests,
    newLedgerFiles: candidate.newLedgerFiles,
    previousTotalTokens: candidate.previousTotalTokens,
    projectedTotalTokens: candidate.projectedTotalTokens,
    prune,
  };
};

const previewCoversInvariantFloor = (
  preview: LedgerMaintenancePreviewPayload,
  floor: LedgerMaintenanceInvariantFloor
): boolean =>
  preview.projectedTotalTokens >= floor.totalTokens &&
  preview.projectedAvailableRequests >= floor.requests &&
  preview.projectedLedgerEntries >= floor.ledgerEntries;

const projectResult = (value: unknown): WidgetMaintenanceResultV1 | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<WidgetMaintenanceResultV1>;
  const basePrune = projectPruneSummary(candidate.prune);
  const candidatePrune = candidate.prune as
    | (Partial<WidgetMaintenancePruneSummary> & {
        deletedFiles?: unknown;
        deletedBytes?: unknown;
      })
    | undefined;
  if (
    candidate.version !== 1 ||
    !isIsoDate(candidate.completedAt) ||
    !isIsoDate(candidate.ledgerGeneratedAt) ||
    !isSafeCount(candidate.ledgerEntries) ||
    !isSafeCount(candidate.availableRequests) ||
    !isSafeCount(candidate.updatedLedgerFiles) ||
    !isSafeCount(candidate.previousTotalTokens) ||
    !isSafeCount(candidate.totalTokens) ||
    candidate.totalPreserved !== true ||
    candidate.totalTokens < candidate.previousTotalTokens ||
    !basePrune ||
    !isSafeCount(candidatePrune?.deletedFiles) ||
    !isSafeCount(candidatePrune?.deletedBytes)
  ) {
    return null;
  }

  return {
    version: 1,
    completedAt: candidate.completedAt,
    ledgerGeneratedAt: candidate.ledgerGeneratedAt,
    ledgerEntries: candidate.ledgerEntries,
    availableRequests: candidate.availableRequests,
    updatedLedgerFiles: candidate.updatedLedgerFiles,
    previousTotalTokens: candidate.previousTotalTokens,
    totalTokens: candidate.totalTokens,
    totalPreserved: true,
    prune: {
      ...basePrune,
      deletedFiles: candidatePrune.deletedFiles,
      deletedBytes: candidatePrune.deletedBytes,
    },
  };
};

export function createLedgerMaintenanceController({
  runner,
  now = Date.now,
  randomUuid = randomUUID,
  previewTtlMs = DEFAULT_LEDGER_MAINTENANCE_PREVIEW_TTL_MS,
  getCommitFloor = () => ({ totalTokens: 0, requests: 0, ledgerEntries: 0 }),
}: {
  runner: LedgerMaintenanceRunner;
  now?: () => number;
  randomUuid?: () => string;
  previewTtlMs?: number;
  getCommitFloor?: () => LedgerMaintenanceInvariantFloor;
}): LedgerMaintenanceController {
  let previewRecord: PreviewRecord | null = null;
  let operationInFlight = false;

  const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (operationInFlight) throw maintenanceError('ledger-maintenance-busy');
    operationInFlight = true;
    try {
      return await operation();
    } catch (error) {
      if (error instanceof LedgerMaintenanceError) throw error;
      throw maintenanceError('ledger-maintenance-failed');
    } finally {
      operationInFlight = false;
    }
  };

  return {
    preview: () =>
      runExclusive(async () => {
        previewRecord = null;
        const floor = getCommitFloor();
        if (
          !isSafeCount(floor?.totalTokens) ||
          !isSafeCount(floor?.requests) ||
          !isSafeCount(floor?.ledgerEntries)
        ) {
          throw maintenanceError('ledger-maintenance-invalid-response');
        }
        let runnerPreview = await runner.preview();
        let projected = projectPreviewPayload(runnerPreview?.preview);
        if (!projected) {
          throw maintenanceError('ledger-maintenance-invalid-response');
        }
        if (!previewCoversInvariantFloor(projected, floor)) {
          runnerPreview = await runner.preview();
          projected = projectPreviewPayload(runnerPreview?.preview);
          if (!projected) {
            throw maintenanceError('ledger-maintenance-invalid-response');
          }
          if (!previewCoversInvariantFloor(projected, floor)) {
            throw maintenanceError('ledger-maintenance-total-regression');
          }
        }
        const createdAtMs = now();
        const previewId = randomUuid();
        const runnerExpiresAtMs = Date.parse(String(runnerPreview?.expiresAt ?? ''));
        if (
          !Number.isSafeInteger(createdAtMs) ||
          createdAtMs < 0 ||
          !Number.isSafeInteger(previewTtlMs) ||
          previewTtlMs <= 0 ||
          !isValidLedgerMaintenancePreviewId(previewId)
        ) {
          throw maintenanceError('ledger-maintenance-invalid-response');
        }
        const expiresAtMs = Number.isFinite(runnerExpiresAtMs)
          ? runnerExpiresAtMs
          : createdAtMs + previewTtlMs;
        if (expiresAtMs <= createdAtMs) {
          throw maintenanceError('ledger-maintenance-preview-expired');
        }
        previewRecord = { previewId, expiresAtMs, ticket: runnerPreview.ticket, floor };
        return {
          ...projected,
          previewId,
          createdAt: new Date(createdAtMs).toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
        };
      }),
    execute: (previewId) => {
      if (!isValidLedgerMaintenancePreviewId(previewId)) {
        return Promise.reject(maintenanceError('ledger-maintenance-preview-invalid'));
      }
      return runExclusive(async () => {
        const record = previewRecord;
        if (!record || record.previewId !== previewId) {
          throw maintenanceError('ledger-maintenance-preview-unavailable');
        }
        previewRecord = null;
        if (now() >= record.expiresAtMs) {
          throw maintenanceError('ledger-maintenance-preview-expired');
        }
        const floor = record.floor;
        const result = projectResult(await runner.execute(record.ticket, floor));
        if (
          !result ||
          result.totalTokens < floor.totalTokens ||
          result.availableRequests < floor.requests ||
          result.ledgerEntries < floor.ledgerEntries
        ) {
          throw maintenanceError('ledger-maintenance-total-regression');
        }
        return result;
      });
    },
  };
}
