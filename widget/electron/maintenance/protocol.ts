import type {
  WidgetMaintenancePreviewV1,
  WidgetMaintenancePruneSummary,
  WidgetMaintenanceResultV1,
} from '../../src/shared/contracts.js';

interface MaintenanceFloor {
  totalTokens: number;
  requests: number;
  ledgerEntries: number;
}

interface MaintenanceTicket {
  previewId: string;
  activeWindowMinutes: number;
}

type MaintenanceRequest =
  | { type: 'preview' }
  | { type: 'execute'; ticket: unknown; floor: MaintenanceFloor };

type MaintenanceResponse =
  | {
      type: 'preview-result';
      preview: Omit<WidgetMaintenancePreviewV1, 'previewId' | 'createdAt' | 'expiresAt'>;
      ticket: MaintenanceTicket;
      expiresAt: string;
    }
  | { type: 'execute-result'; result: WidgetMaintenanceResultV1 }
  | { type: 'maintenance-error'; code: string };

type RunMaintenance = (request: {
  mode: 'preview' | 'execute';
  activeWindowMinutes: number;
  previewId?: string;
  minimumTotals?: MaintenanceFloor;
}) => Promise<unknown>;

const ACTIVE_WINDOW_MINUTES = 5;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isSafeCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const isIsoDateOrNull = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value)));

const readCount = (record: Record<string, unknown>, key: string): number | null => {
  const value = record[key];
  return isSafeCount(value) ? value : null;
};

const projectPrune = (value: unknown, completed: boolean): WidgetMaintenancePruneSummary | null => {
  if (!isRecord(value)) return null;
  const eligibleFiles = readCount(value, 'eligibleFiles');
  const eligibleBytes = readCount(value, 'eligibleBytes');
  const keptActiveFiles = readCount(value, 'keptActiveFiles');
  const keptUnrecordedFiles = readCount(value, 'keptUnrecordedFiles');
  const keptIncompleteFiles = readCount(value, 'keptNotReadyAvailableFiles');
  const keptFingerprintMismatchFiles = readCount(value, 'keptFingerprintMismatchFiles');
  const keptUnsafeFiles = readCount(value, 'keptUnsafeFiles');
  const failedDeletes = completed ? readCount(value, 'failedDeletes') : 0;
  const keptChangedFiles = completed ? readCount(value, 'keptChangedFiles') : 0;
  if (
    eligibleFiles === null ||
    eligibleBytes === null ||
    keptActiveFiles === null ||
    keptUnrecordedFiles === null ||
    keptIncompleteFiles === null ||
    keptFingerprintMismatchFiles === null ||
    keptUnsafeFiles === null ||
    failedDeletes === null ||
    keptChangedFiles === null
  ) {
    return null;
  }
  return {
    eligibleFiles,
    eligibleBytes,
    keptActiveFiles,
    keptUnrecordedFiles,
    keptIncompleteFiles,
    keptFingerprintMismatchFiles,
    failedFiles: keptUnsafeFiles + failedDeletes + keptChangedFiles,
  };
};

const readLedgerTotals = (value: unknown): { requests: number; total: number } | null => {
  if (!isRecord(value)) return null;
  const requests = readCount(value, 'requests');
  const total = readCount(value, 'total');
  return requests === null || total === null ? null : { requests, total };
};

const projectPreview = (value: unknown): {
  preview: Omit<WidgetMaintenancePreviewV1, 'previewId' | 'createdAt' | 'expiresAt'>;
  ticket: MaintenanceTicket;
  expiresAt: string;
} | null => {
  if (!isRecord(value) || value.status !== 'preview' || !isRecord(value.ledger)) return null;
  const ledger = value.ledger;
  const formal = readLedgerTotals(ledger.formal);
  const projected = readLedgerTotals(ledger.projected);
  const entryCounts = isRecord(ledger.entryCounts) ? ledger.entryCounts : null;
  const previousLedgerEntries = entryCounts ? readCount(entryCounts, 'formal') : null;
  const projectedLedgerEntries = entryCounts ? readCount(entryCounts, 'candidate') : null;
  const ledgerGeneratedAt = ledger.formalGeneratedAt;
  const previewId = value.previewId;
  const expiresAt = value.expiresAt;
  const safety = isRecord(value.safety) ? value.safety : null;
  const activeWindowMinutes = safety ? readCount(safety, 'activeWindowMinutes') : null;
  const prune = projectPrune(value.prune, false);
  if (
    !formal ||
    !projected ||
    previousLedgerEntries === null ||
    projectedLedgerEntries === null ||
    projectedLedgerEntries < previousLedgerEntries ||
    !isIsoDateOrNull(ledgerGeneratedAt) ||
    typeof previewId !== 'string' ||
    previewId.length === 0 ||
    previewId.length > 160 ||
    !isIsoDateOrNull(expiresAt) ||
    expiresAt === null ||
    activeWindowMinutes === null ||
    activeWindowMinutes < ACTIVE_WINDOW_MINUTES ||
    safety?.canExecute !== true ||
    !prune
  ) {
    return null;
  }
  return {
    preview: {
      version: 1,
      ledgerGeneratedAt,
      previousLedgerEntries,
      projectedLedgerEntries,
      previousAvailableRequests: formal.requests,
      projectedAvailableRequests: projected.requests,
      newLedgerFiles: projectedLedgerEntries - previousLedgerEntries,
      previousTotalTokens: formal.total,
      projectedTotalTokens: projected.total,
      prune,
    },
    ticket: { previewId, activeWindowMinutes },
    expiresAt,
  };
};

const projectExecute = (
  value: unknown,
  floor: MaintenanceFloor
): WidgetMaintenanceResultV1 | null => {
  if (!isRecord(value) || value.status !== 'completed' || !isRecord(value.ledger)) return null;
  const ledger = value.ledger;
  const formal = readLedgerTotals(ledger.formal);
  const beforePrune = readLedgerTotals(ledger.beforePrune);
  const completedAt = value.generatedAt;
  const ledgerGeneratedAt = value.ledgerGeneratedAt;
  const ledgerEntries = readCount(value, 'ledgerEntries');
  const totalTokens = readCount(value, 'totalTokens');
  const scan = isRecord(value.scan) ? value.scan : null;
  const updatedLedgerFiles = scan ? readCount(scan, 'updatedFiles') : null;
  const prune = projectPrune(value.prune, true);
  const rawPrune = isRecord(value.prune) ? value.prune : null;
  const deletedFiles = rawPrune ? readCount(rawPrune, 'deletedFiles') : null;
  const deletedBytes = rawPrune ? readCount(rawPrune, 'deletedBytes') : null;
  if (
    !formal ||
    !beforePrune ||
    !isIsoDateOrNull(completedAt) ||
    completedAt === null ||
    !isIsoDateOrNull(ledgerGeneratedAt) ||
    ledgerGeneratedAt === null ||
    ledgerEntries === null ||
    updatedLedgerFiles === null ||
    totalTokens === null ||
    totalTokens !== beforePrune.total ||
    totalTokens < formal.total ||
    totalTokens < floor.totalTokens ||
    beforePrune.requests < formal.requests ||
    beforePrune.requests < floor.requests ||
    ledgerEntries < floor.requests ||
    ledgerEntries < floor.ledgerEntries ||
    ledger.unchangedByPrune !== true ||
    !prune ||
    deletedFiles === null ||
    deletedBytes === null
  ) {
    return null;
  }
  return {
    version: 1,
    completedAt,
    ledgerGeneratedAt,
    ledgerEntries,
    availableRequests: beforePrune.requests,
    updatedLedgerFiles,
    previousTotalTokens: formal.total,
    totalTokens,
    totalPreserved: true,
    prune: { ...prune, deletedFiles, deletedBytes },
  };
};

const isFloor = (value: unknown): value is MaintenanceFloor =>
  isRecord(value) &&
  isSafeCount(value.totalTokens) &&
  isSafeCount(value.requests) &&
  isSafeCount(value.ledgerEntries);

const isTicket = (value: unknown): value is MaintenanceTicket =>
  isRecord(value) &&
  typeof value.previewId === 'string' &&
  value.previewId.length > 0 &&
  value.previewId.length <= 160 &&
  isSafeCount(value.activeWindowMinutes) &&
  value.activeWindowMinutes >= ACTIVE_WINDOW_MINUTES;

const safeErrorCode = (error: unknown): string => {
  const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
  if (code === 'TOKEN_LEDGER_BUSY') return 'ledger-maintenance-busy';
  if (code === 'TOKEN_LEDGER_LOW_SPACE') return 'ledger-maintenance-low-space';
  if (code === 'TOKEN_LEDGER_REGRESSION') return 'ledger-maintenance-total-regression';
  if (code === 'TOKEN_LEDGER_PREVIEW_STALE') return 'ledger-maintenance-preview-expired';
  if (code === 'TOKEN_LEDGER_PREVIEW_REQUIRED') return 'ledger-maintenance-preview-unavailable';
  return 'ledger-maintenance-failed';
};

export const createMaintenanceRequestHandler = ({
  runMaintenance,
}: {
  runMaintenance: RunMaintenance;
}) =>
  async (request: MaintenanceRequest): Promise<MaintenanceResponse> => {
    try {
      if (!isRecord(request)) {
        return { type: 'maintenance-error', code: 'ledger-maintenance-failed' };
      }
      if (request.type === 'preview') {
        const projected = projectPreview(
          await runMaintenance({ mode: 'preview', activeWindowMinutes: ACTIVE_WINDOW_MINUTES })
        );
        return projected
          ? { type: 'preview-result', ...projected }
          : { type: 'maintenance-error', code: 'ledger-maintenance-invalid-response' };
      }
      if (request.type === 'execute' && isTicket(request.ticket) && isFloor(request.floor)) {
        const result = projectExecute(
          await runMaintenance({
            mode: 'execute',
            activeWindowMinutes: request.ticket.activeWindowMinutes,
            previewId: request.ticket.previewId,
            minimumTotals: request.floor,
          }),
          request.floor
        );
        return result
          ? { type: 'execute-result', result }
          : { type: 'maintenance-error', code: 'ledger-maintenance-invalid-response' };
      }
      return { type: 'maintenance-error', code: 'ledger-maintenance-failed' };
    } catch (error) {
      return { type: 'maintenance-error', code: safeErrorCode(error) };
    }
  };
