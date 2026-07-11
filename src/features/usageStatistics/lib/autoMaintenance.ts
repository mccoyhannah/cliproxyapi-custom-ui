const USAGE_STATISTICS_AUTO_MAINTENANCE_STATE_KEY =
  'cpamcUsageStatisticsAutoMaintenance';

type NavigationType = 'POP' | 'PUSH' | 'REPLACE';

type AutomaticMaintenanceStartContext = {
  isCurrentLayer: boolean;
  navigationType: NavigationType;
  connectionStatus: string;
  hasApiBase: boolean;
  hasManagementKey: boolean;
  hasEntryIntent: boolean;
  entryKey: string;
  lastStartedEntryKey: string;
  inFlight: boolean;
};

type AutomaticMaintenanceSteps<TRefreshResult, TPruneResult> = {
  wakeControl: () => Promise<unknown>;
  refreshLedger: () => Promise<TRefreshResult>;
  reloadLedgerAfterRefresh: () => Promise<unknown>;
  pruneRecordedLogs: () => Promise<TPruneResult>;
  reloadLedgerAfterPrune: () => Promise<unknown>;
};

export type TokenLedgerMaintenanceOperation = {
  kind: 'automatic' | 'manual';
  promise: Promise<unknown>;
};

export type AutomaticTokenLedgerMaintenanceCoordinator = {
  getInFlight: () => TokenLedgerMaintenanceOperation | null;
  hasStarted: (entryKey: string) => boolean;
  isBusy: () => boolean;
  startAutomatic: <TResult>(
    entryKey: string,
    task: () => Promise<TResult>
  ) => Promise<TResult> | null;
  startManual: <TResult>(task: () => Promise<TResult>) => Promise<TResult> | null;
  subscribe: (listener: () => void) => () => void;
};

export type TokenLedgerMaintenanceSettlementTracker = {
  update: (isBusy: boolean) => boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

export const createUsageStatisticsAutoMaintenanceState = () => ({
  [USAGE_STATISTICS_AUTO_MAINTENANCE_STATE_KEY]: true,
});

export const hasUsageStatisticsAutoMaintenanceIntent = (state: unknown): boolean =>
  isRecord(state) && state[USAGE_STATISTICS_AUTO_MAINTENANCE_STATE_KEY] === true;

export const shouldStartAutomaticTokenLedgerMaintenance = ({
  isCurrentLayer,
  navigationType,
  connectionStatus,
  hasApiBase,
  hasManagementKey,
  hasEntryIntent,
  entryKey,
  lastStartedEntryKey,
  inFlight,
}: AutomaticMaintenanceStartContext): boolean =>
  isCurrentLayer &&
  navigationType === 'PUSH' &&
  connectionStatus === 'connected' &&
  hasApiBase &&
  hasManagementKey &&
  hasEntryIntent &&
  Boolean(entryKey) &&
  entryKey !== lastStartedEntryKey &&
  !inFlight;

export const createTokenLedgerMaintenanceSettlementTracker = (
  initialBusy = false
): TokenLedgerMaintenanceSettlementTracker => {
  let wasBusy = initialBusy;

  return {
    update: (isBusy) => {
      const settled = wasBusy && !isBusy;
      wasBusy = isBusy;
      return settled;
    },
  };
};

export const createAutomaticTokenLedgerMaintenanceCoordinator = ():
  AutomaticTokenLedgerMaintenanceCoordinator => {
  let inFlight: TokenLedgerMaintenanceOperation | null = null;
  const startedEntryKeys = new Set<string>();
  const listeners = new Set<() => void>();

  const notify = () => listeners.forEach((listener) => listener());

  const startOperation = <TResult>(
    kind: TokenLedgerMaintenanceOperation['kind'],
    task: () => Promise<TResult>
  ): Promise<TResult> | null => {
    if (inFlight) return null;

    const operation = Promise.resolve().then(task);
    inFlight = { kind, promise: operation };
    notify();
    const clearInFlight = () => {
      if (inFlight?.promise === operation) {
        inFlight = null;
        notify();
      }
    };
    void operation.then(clearInFlight, clearInFlight);
    return operation;
  };

  return {
    getInFlight: () => inFlight,
    hasStarted: (entryKey) => startedEntryKeys.has(entryKey),
    isBusy: () => Boolean(inFlight),
    startAutomatic: (entryKey, task) => {
      if (!entryKey || inFlight || startedEntryKeys.has(entryKey)) return null;

      startedEntryKeys.add(entryKey);
      return startOperation('automatic', task);
    },
    startManual: (task) => startOperation('manual', task),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

export async function runAutomaticTokenLedgerMaintenance<TRefreshResult, TPruneResult>({
  wakeControl,
  refreshLedger,
  reloadLedgerAfterRefresh,
  pruneRecordedLogs,
  reloadLedgerAfterPrune,
}: AutomaticMaintenanceSteps<TRefreshResult, TPruneResult>) {
  await wakeControl();
  const refreshResult = await refreshLedger();
  await reloadLedgerAfterRefresh();
  const pruneResult = await pruneRecordedLogs();
  await reloadLedgerAfterPrune();

  return { refreshResult, pruneResult };
}
