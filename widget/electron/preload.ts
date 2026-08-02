import { contextBridge, ipcRenderer } from 'electron';
import type {
  WidgetApi,
  WidgetMaintenancePreviewV1,
  WidgetMaintenancePruneSummary,
  WidgetMaintenanceResultV1,
  WidgetSettings,
  WidgetSnapshotV1,
} from '../src/shared/contracts.js';

const IPC_CHANNELS = Object.freeze({
  getSnapshot: 'widget:get-snapshot',
  snapshot: 'widget:snapshot',
  getSettings: 'widget:get-settings',
  settings: 'widget:settings',
  saveSettings: 'widget:save-settings',
  setWindowMode: 'widget:set-window-mode',
  setAlwaysOnTop: 'widget:set-always-on-top',
  previewLedgerMaintenance: 'widget:preview-ledger-maintenance',
  executeLedgerMaintenance: 'widget:execute-ledger-maintenance',
  maintenanceOpen: 'widget:maintenance-open',
  hideToTray: 'widget:hide-to-tray',
  quit: 'widget:quit',
});

const PREVIEW_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAINTENANCE_ERROR_CODES = [
  'ledger-maintenance-busy',
  'ledger-maintenance-failed',
  'ledger-maintenance-invalid-request',
  'ledger-maintenance-invalid-response',
  'ledger-maintenance-low-space',
  'ledger-maintenance-preview-expired',
  'ledger-maintenance-preview-invalid',
  'ledger-maintenance-preview-unavailable',
  'ledger-maintenance-total-regression',
  'ledger-maintenance-unavailable',
] as const;

function isWidgetSnapshot(value: unknown): value is WidgetSnapshotV1 {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  return (value as { version?: unknown }).version === 1;
}

function isWidgetSettings(value: unknown): value is WidgetSettings {
  if (typeof value !== 'object' || value === null) return false;
  const settings = value as Partial<WidgetSettings>;
  return (
    typeof settings.alwaysOnTop === 'boolean' &&
    typeof settings.expanded === 'boolean' &&
    typeof settings.dockToBottomRight === 'boolean' &&
    Array.isArray(settings.pricingOverrides)
  );
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isSafeCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

const isIsoDate = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value));

const projectPruneSummary = (value: unknown): WidgetMaintenancePruneSummary | null => {
  if (!isRecord(value)) return null;
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
    if (!isSafeCount(value[field])) return null;
    projected[field] = value[field];
  }
  return projected;
};

const projectMaintenancePreview = (value: unknown): WidgetMaintenancePreviewV1 | null => {
  if (!isRecord(value)) return null;
  const prune = projectPruneSummary(value.prune);
  if (
    value.version !== 1 ||
    typeof value.previewId !== 'string' ||
    value.previewId.length !== 36 ||
    !PREVIEW_ID_PATTERN.test(value.previewId) ||
    !isIsoDate(value.createdAt) ||
    !isIsoDate(value.expiresAt) ||
    (value.ledgerGeneratedAt !== null && !isIsoDate(value.ledgerGeneratedAt)) ||
    !isSafeCount(value.previousLedgerEntries) ||
    !isSafeCount(value.projectedLedgerEntries) ||
    !isSafeCount(value.previousAvailableRequests) ||
    !isSafeCount(value.projectedAvailableRequests) ||
    value.projectedAvailableRequests < value.previousAvailableRequests ||
    !isSafeCount(value.newLedgerFiles) ||
    !isSafeCount(value.previousTotalTokens) ||
    !isSafeCount(value.projectedTotalTokens) ||
    value.projectedTotalTokens < value.previousTotalTokens ||
    !prune
  ) {
    return null;
  }
  return {
    version: 1,
    previewId: value.previewId,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    ledgerGeneratedAt: value.ledgerGeneratedAt,
    previousLedgerEntries: value.previousLedgerEntries,
    projectedLedgerEntries: value.projectedLedgerEntries,
    previousAvailableRequests: value.previousAvailableRequests,
    projectedAvailableRequests: value.projectedAvailableRequests,
    newLedgerFiles: value.newLedgerFiles,
    previousTotalTokens: value.previousTotalTokens,
    projectedTotalTokens: value.projectedTotalTokens,
    prune,
  };
};

const projectMaintenanceResult = (value: unknown): WidgetMaintenanceResultV1 | null => {
  if (!isRecord(value) || !isRecord(value.prune)) return null;
  const prune = projectPruneSummary(value.prune);
  if (
    value.version !== 1 ||
    !isIsoDate(value.completedAt) ||
    !isIsoDate(value.ledgerGeneratedAt) ||
    !isSafeCount(value.ledgerEntries) ||
    !isSafeCount(value.availableRequests) ||
    !isSafeCount(value.updatedLedgerFiles) ||
    !isSafeCount(value.previousTotalTokens) ||
    !isSafeCount(value.totalTokens) ||
    value.totalPreserved !== true ||
    (value.postVerificationPending !== undefined && value.postVerificationPending !== true) ||
    value.totalTokens < value.previousTotalTokens ||
    !prune ||
    !isSafeCount(value.prune.deletedFiles) ||
    !isSafeCount(value.prune.deletedBytes)
  ) {
    return null;
  }
  return {
    version: 1,
    ...(value.postVerificationPending === true ? { postVerificationPending: true as const } : {}),
    completedAt: value.completedAt,
    ledgerGeneratedAt: value.ledgerGeneratedAt,
    ledgerEntries: value.ledgerEntries,
    availableRequests: value.availableRequests,
    updatedLedgerFiles: value.updatedLedgerFiles,
    previousTotalTokens: value.previousTotalTokens,
    totalTokens: value.totalTokens,
    totalPreserved: true,
    prune: {
      ...prune,
      deletedFiles: value.prune.deletedFiles,
      deletedBytes: value.prune.deletedBytes,
    },
  };
};

const sanitizeMaintenanceError = (error: unknown): Error => {
  const message = error instanceof Error ? error.message : '';
  const code = MAINTENANCE_ERROR_CODES.find((candidate) => message.includes(candidate));
  return new Error(code ?? 'ledger-maintenance-failed');
};

const invokeMaintenance = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    throw sanitizeMaintenanceError(error);
  }
};

const widgetApi: WidgetApi = Object.freeze({
  getSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.getSnapshot),
  subscribe: (listener: (snapshot: WidgetSnapshotV1) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isWidgetSnapshot(value)) {
        listener(value);
      }
    };

    ipcRenderer.on(IPC_CHANNELS.snapshot, wrappedListener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.snapshot, wrappedListener);
  },
  getSettings: () => ipcRenderer.invoke(IPC_CHANNELS.getSettings),
  subscribeSettings: (listener: (settings: WidgetSettings) => void) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, value: unknown) => {
      if (isWidgetSettings(value)) listener(value);
    };

    ipcRenderer.on(IPC_CHANNELS.settings, wrappedListener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.settings, wrappedListener);
  },
  saveSettings: (settings: WidgetSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.saveSettings, settings),
  setWindowMode: (expanded: boolean) => ipcRenderer.invoke(IPC_CHANNELS.setWindowMode, expanded),
  setAlwaysOnTop: (alwaysOnTop: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.setAlwaysOnTop, alwaysOnTop),
  previewLedgerMaintenance: async () => {
    const preview = projectMaintenancePreview(
      await invokeMaintenance(IPC_CHANNELS.previewLedgerMaintenance)
    );
    if (!preview) throw new Error('ledger-maintenance-invalid-response');
    return preview;
  },
  executeLedgerMaintenance: async (previewId: string) => {
    if (
      typeof previewId !== 'string' ||
      previewId.length !== 36 ||
      !PREVIEW_ID_PATTERN.test(previewId)
    ) {
      throw new Error('ledger-maintenance-preview-invalid');
    }
    const result = projectMaintenanceResult(
      await invokeMaintenance(IPC_CHANNELS.executeLedgerMaintenance, previewId)
    );
    if (!result) throw new Error('ledger-maintenance-invalid-response');
    return result;
  },
  subscribeMaintenanceOpen: (listener: () => void) => {
    const wrappedListener = () => listener();
    ipcRenderer.on(IPC_CHANNELS.maintenanceOpen, wrappedListener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.maintenanceOpen, wrappedListener);
  },
  hideToTray: () => ipcRenderer.invoke(IPC_CHANNELS.hideToTray),
  quit: () => ipcRenderer.invoke(IPC_CHANNELS.quit),
});

contextBridge.exposeInMainWorld('cpaWidget', widgetApi);
