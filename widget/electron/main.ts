import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  powerMonitor,
  screen,
  session,
  Tray,
  utilityProcess,
  type IpcMainInvokeEvent,
  type Rectangle,
} from 'electron';
import type {
  WidgetSettings,
  WidgetSnapshotV1,
  WidgetUsageTotals,
  WidgetUsageView,
} from '../src/shared/contracts.js';
import type { CollectorMainMessage, CollectorWorkerMessage } from './collector/index.js';
import {
  createBundledLedgerMaintenanceRunner,
  createLedgerMaintenanceController,
  executeLedgerMaintenanceWithPostVerification,
  getLedgerMaintenanceCommitFloor,
  isTrustedLedgerMaintenanceSender,
  previewLedgerMaintenanceAfterReconcile,
  resolveLedgerMaintenanceRunnerPath,
} from './ledgerMaintenance.js';
import { projectWidgetSnapshotV1 } from './snapshotProjection.mjs';
import { bindWindowVisibilityRefresh } from './windowEvents.mjs';
import {
  clampBoundsToWorkAreas,
  cloneSettings,
  COMPACT_WINDOW_SIZE,
  EXPANDED_WINDOW_SIZE,
  normalizeWidgetSettings,
  WindowStateStore,
} from './windowState.js';

const CACHE_ROOT = 'D:\\Tools\\Cache\\CPA-Token-Pulse';
const CPA_INSTALL_DIR = 'D:\\CLIProxyAPI';
const MAINTENANCE_TEMP_DIR = path.join(CACHE_ROOT, 'maintenance-temp');
const WINDOW_EDGE_MARGIN = 20;
const WINDOW_PLACEMENT_DEBOUNCE_MS = 300;
const WORKER_RESTART_DELAY_MS = 2_000;
const MAX_WORKER_RESTARTS = 3;
const COLLECTOR_RECONCILE_TIMEOUT_MS = 20_000;

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

const DEV_RENDERER_URL = app.isPackaged
  ? null
  : getSafeDevRendererUrl(process.env.VITE_DEV_SERVER_URL);
const IS_SMOKE_TEST = process.argv.includes('--smoke-test');
const stateStore = new WindowStateStore(CACHE_ROOT);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let collectorWorker: Worker | null = null;
let currentSettings: WidgetSettings = normalizeWidgetSettings(null);
let currentSnapshot = createEmptySnapshot();
let isQuitting = false;
let isCollectorShuttingDown = false;
let workerRestartCount = 0;
let placementTimer: NodeJS.Timeout | null = null;
let workerRestartTimer: NodeJS.Timeout | null = null;
const pendingCollectorReconciles = new Map<
  string,
  {
    resolve: (snapshot: WidgetSnapshotV1) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();
let settingsMutationChain = Promise.resolve();
let smokeRendererReady = false;
let smokeCollectorReady = false;
let smokeCompletionStarted = false;
let smokeTimeout: NodeJS.Timeout | null = null;

const ledgerMaintenanceController = createLedgerMaintenanceController({
  runner: createBundledLedgerMaintenanceRunner({
    forkProcess: (modulePath, args, options) =>
      utilityProcess.fork(modulePath, args, options),
    runnerPath: resolveLedgerMaintenanceRunnerPath({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    environment: {
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      TEMP: MAINTENANCE_TEMP_DIR,
      TMP: MAINTENANCE_TEMP_DIR,
    },
  }),
  getCommitFloor: () => getLedgerMaintenanceCommitFloor(currentSnapshot),
});

configureAppStorage();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  if (IS_SMOKE_TEST) app.exit(4);
  else app.quit();
} else {
  app.on('second-instance', () => showMainWindow());
  app.on('before-quit', () => {
    isQuitting = true;
    shutdownCollector();
  });
  app.on('window-all-closed', () => {
    // The tray owns the application lifetime on Windows.
  });
  app.on('activate', () => showMainWindow());
  app.on('certificate-error', (event, _webContents, _url, _error, _certificate, callback) => {
    event.preventDefault();
    callback(false);
  });

  void app
    .whenReady()
    .then(bootstrap)
    .catch(() => {
      app.exit(1);
    });
}

function configureAppStorage(): void {
  const storagePaths = {
    userData: path.join(CACHE_ROOT, 'user-data'),
    sessionData: path.join(CACHE_ROOT, 'session'),
    logs: path.join(CACHE_ROOT, 'logs'),
    crashDumps: path.join(CACHE_ROOT, 'crash-dumps'),
  } as const;

  mkdirSync(CACHE_ROOT, { recursive: true });
  mkdirSync(MAINTENANCE_TEMP_DIR, { recursive: true });
  for (const storagePath of Object.values(storagePaths)) {
    mkdirSync(storagePath, { recursive: true });
  }

  app.setPath('userData', storagePaths.userData);
  app.setPath('sessionData', storagePaths.sessionData);
  app.setPath('logs', storagePaths.logs);
  app.setPath('crashDumps', storagePaths.crashDumps);
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  app.commandLine.appendSwitch('disable-default-apps');
  app.commandLine.appendSwitch('disable-domain-reliability');
  app.commandLine.appendSwitch('disable-sync');
  app.commandLine.appendSwitch(
    'disable-features',
    'AutofillServerCommunication,CertificateTransparencyComponentUpdater,MediaRouter,OptimizationHints'
  );
}

async function bootstrap(): Promise<void> {
  app.setAppUserModelId('com.local.cpa.tokenpulse');
  Menu.setApplicationMenu(null);
  configureSessionSecurity();
  registerIpcHandlers();

  currentSettings = await stateStore.loadSettings();
  mainWindow = await createMainWindow(currentSettings);
  tray = createTray();
  startCollector();

  powerMonitor.on('resume', () => postCollectorMessage({ type: 'reconcile' }));

  if (IS_SMOKE_TEST) {
    smokeTimeout = setTimeout(() => {
      isQuitting = true;
      app.exit(2);
    }, 15_000);
    smokeTimeout.unref();

    try {
      smokeRendererReady = await mainWindow.webContents.executeJavaScript(`
        (() => {
          const shell = document.querySelector('#root .widget-shell');
          return Boolean(
            shell &&
            !document.querySelector('.source-badge--preview') &&
            typeof window.cpaWidget === 'object' &&
            typeof window.cpaWidget.getSnapshot === 'function'
          );
        })()
      `);
    } catch {
      smokeRendererReady = false;
    }
    if (!smokeRendererReady) {
      isQuitting = true;
      app.exit(3);
      return;
    }
    void maybeFinishSmokeTest();
  }
}

function configureSessionSecurity(): void {
  const widgetSession = session.defaultSession;
  widgetSession.setSpellCheckerEnabled(false);
  widgetSession.setPermissionCheckHandler(() => false);
  widgetSession.setPermissionRequestHandler((_webContents, _permission, callback) =>
    callback(false)
  );
  widgetSession.on('will-download', (event) => event.preventDefault());

  widgetSession.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedRendererResource(details.url) });
  });

  widgetSession.webRequest.onHeadersReceived((details, callback) => {
    const connectSource = DEV_RENDERER_URL
      ? "'self' http://127.0.0.1:5173 ws://127.0.0.1:5173"
      : "'self'";
    const contentSecurityPolicy = [
      "default-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      `connect-src ${connectSource}`,
    ].join('; ');

    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [contentSecurityPolicy],
      },
    });
  });
}

async function createMainWindow(settings: WidgetSettings): Promise<BrowserWindow> {
  const size = settings.expanded ? EXPANDED_WINDOW_SIZE : COMPACT_WINDOW_SIZE;
  const placement = await stateStore.loadPlacement();
  const primaryWorkArea = screen.getPrimaryDisplay().workArea;
  const desiredBounds: Rectangle = {
    x: placement?.x ?? primaryWorkArea.x + primaryWorkArea.width - size.width - WINDOW_EDGE_MARGIN,
    y:
      placement?.y ?? primaryWorkArea.y + primaryWorkArea.height - size.height - WINDOW_EDGE_MARGIN,
    width: size.width,
    height: size.height,
  };
  const initialBounds = clampBoundsToWorkAreas(
    desiredBounds,
    screen.getAllDisplays().map((display) => display.workArea)
  );

  const window = new BrowserWindow({
    ...initialBounds,
    alwaysOnTop: settings.alwaysOnTop,
    backgroundColor: '#00000000',
    frame: false,
    fullscreenable: false,
    hasShadow: true,
    maximizable: false,
    minimizable: true,
    resizable: false,
    roundedCorners: true,
    show: false,
    skipTaskbar: true,
    transparent: true,
    webPreferences: {
      allowRunningInsecureContent: false,
      contextIsolation: true,
      devTools: !app.isPackaged,
      nodeIntegration: false,
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), 'preload.cjs'),
      sandbox: true,
      webSecurity: true,
    },
  });

  window.setMenuBarVisibility(false);
  window.setAlwaysOnTop(settings.alwaysOnTop);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedRendererNavigation(url)) {
      event.preventDefault();
    }
  });

  window.on('move', schedulePlacementSave);
  window.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      window.hide();
      rebuildTrayMenu();
    }
  });
  bindWindowVisibilityRefresh(window, () => rebuildTrayMenu());

  window.once('ready-to-show', () => {
    if (!IS_SMOKE_TEST) {
      window.showInactive();
    }
  });

  if (DEV_RENDERER_URL) {
    await window.loadURL(DEV_RENDERER_URL);
  } else {
    await window.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  }

  return window;
}

function createTray(): Tray {
  const iconPath = path.join(app.getAppPath(), 'assets', 'icon.png');
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 18, height: 18 });
  const widgetTray = new Tray(icon);
  widgetTray.setToolTip('CPA Token Pulse');
  widgetTray.on('click', () => {
    if (mainWindow?.isVisible()) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
    rebuildTrayMenu();
  });

  rebuildTrayMenu(widgetTray);
  return widgetTray;
}

function rebuildTrayMenu(targetTray = tray): void {
  if (!targetTray) {
    return;
  }

  targetTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: mainWindow?.isVisible() ? '隐藏挂件' : '显示挂件',
        click: () => {
          if (mainWindow?.isVisible()) {
            mainWindow.hide();
          } else {
            showMainWindow();
          }
          rebuildTrayMenu();
        },
      },
      { type: 'separator' },
      {
        label: '始终置顶',
        type: 'checkbox',
        checked: currentSettings.alwaysOnTop,
        click: (menuItem) => {
          void updateSettings({ alwaysOnTop: menuItem.checked });
        },
      },
      {
        label: '展开详情',
        type: 'checkbox',
        checked: currentSettings.expanded,
        click: (menuItem) => {
          void updateSettings({ expanded: menuItem.checked });
        },
      },
      {
        label: '日志维护…',
        click: () => {
          void openLedgerMaintenanceDialog();
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

async function openLedgerMaintenanceDialog(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!currentSettings.expanded) {
    try {
      await updateSettings({ expanded: true });
    } catch {
      return;
    }
  }
  showMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.maintenanceOpen);
  }
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  rebuildTrayMenu();
}

function resizeMainWindow(expanded: boolean): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const currentBounds = mainWindow.getBounds();
  const size = expanded ? EXPANDED_WINDOW_SIZE : COMPACT_WINDOW_SIZE;
  const desiredBounds: Rectangle = {
    x: currentBounds.x + currentBounds.width - size.width,
    y: currentBounds.y,
    width: size.width,
    height: size.height,
  };
  const nextBounds = clampBoundsToWorkAreas(
    desiredBounds,
    screen.getAllDisplays().map((display) => display.workArea)
  );

  mainWindow.setBounds(nextBounds, true);
  schedulePlacementSave();
}

function schedulePlacementSave(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (placementTimer) {
    clearTimeout(placementTimer);
  }

  placementTimer = setTimeout(() => {
    placementTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      void stateStore.savePlacement(mainWindow.getBounds()).catch(() => undefined);
    }
  }, WINDOW_PLACEMENT_DEBOUNCE_MS);
}

function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.getSnapshot, () => currentSnapshot);
  ipcMain.handle(IPC_CHANNELS.getSettings, () => cloneSettings(currentSettings));
  ipcMain.handle(IPC_CHANNELS.saveSettings, async (_event, value: unknown) => {
    return enqueueSettingsMutation((settings) => normalizeWidgetSettings(value, settings));
  });
  ipcMain.handle(IPC_CHANNELS.setWindowMode, async (_event, expanded: unknown) => {
    assertBoolean(expanded);
    await updateSettings({ expanded });
  });
  ipcMain.handle(IPC_CHANNELS.setAlwaysOnTop, async (_event, alwaysOnTop: unknown) => {
    assertBoolean(alwaysOnTop);
    await updateSettings({ alwaysOnTop });
  });
  ipcMain.handle(IPC_CHANNELS.previewLedgerMaintenance, async (event, ...args: unknown[]) => {
    assertTrustedLedgerMaintenanceSender(event);
    if (args.length !== 0) throw new Error('ledger-maintenance-invalid-request');
    return previewLedgerMaintenanceAfterReconcile({
      reconcile: reconcileCollector,
      controller: ledgerMaintenanceController,
    });
  });
  ipcMain.handle(IPC_CHANNELS.executeLedgerMaintenance, async (event, ...args: unknown[]) => {
    assertTrustedLedgerMaintenanceSender(event);
    if (args.length !== 1) throw new Error('ledger-maintenance-invalid-request');
    if (!app.isPackaged) throw new Error('ledger-maintenance-unavailable');
    return executeLedgerMaintenanceWithPostVerification({
      previewId: args[0],
      reconcile: reconcileCollector,
      controller: ledgerMaintenanceController,
    });
  });
  ipcMain.handle(IPC_CHANNELS.hideToTray, () => {
    mainWindow?.hide();
    rebuildTrayMenu();
  });
  ipcMain.handle(IPC_CHANNELS.quit, () => {
    isQuitting = true;
    app.quit();
  });
}

function assertTrustedLedgerMaintenanceSender(event: IpcMainInvokeEvent): void {
  const window = mainWindow;
  if (
    !window ||
    window.isDestroyed() ||
    !isTrustedLedgerMaintenanceSender(event, window.webContents, isAllowedRendererNavigation)
  ) {
    throw new Error('ledger-maintenance-unavailable');
  }
}

function assertBoolean(value: unknown): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error('invalid-argument');
  }
}

async function updateSettings(patch: Partial<WidgetSettings>): Promise<void> {
  await enqueueSettingsMutation((settings) =>
    normalizeWidgetSettings(
      {
        ...settings,
        ...patch,
        pricingOverrides: patch.pricingOverrides ?? settings.pricingOverrides,
      },
      settings
    )
  );
}

function enqueueSettingsMutation(
  createNextSettings: (settings: WidgetSettings) => WidgetSettings
): Promise<WidgetSettings> {
  const operation = settingsMutationChain
    .catch(() => undefined)
    .then(async () => {
      const previousSettings = currentSettings;
      const nextSettings = cloneSettings(createNextSettings(previousSettings));

      try {
        await stateStore.saveSettings(nextSettings);
      } catch {
        throw new Error('settings-write-failed');
      }

      currentSettings = nextSettings;
      mainWindow?.setAlwaysOnTop(currentSettings.alwaysOnTop);
      if (previousSettings.expanded !== currentSettings.expanded) {
        resizeMainWindow(currentSettings.expanded);
      }
      if (!arePricingOverridesEqual(previousSettings, currentSettings)) {
        postCollectorMessage({
          type: 'update-pricing',
          pricingOverrides: currentSettings.pricingOverrides,
        });
      }
      broadcastSettings();
      rebuildTrayMenu();
      return cloneSettings(currentSettings);
    });

  settingsMutationChain = operation.then(
    () => undefined,
    () => undefined
  );
  return operation;
}

function arePricingOverridesEqual(left: WidgetSettings, right: WidgetSettings): boolean {
  return JSON.stringify(left.pricingOverrides) === JSON.stringify(right.pricingOverrides);
}

function startCollector(): void {
  if (collectorWorker || isCollectorShuttingDown || isQuitting) {
    return;
  }

  const workerPath = resolveCollectorWorkerPath();
  const worker = new Worker(pathToFileURL(workerPath), {
    workerData: {
      installDir: CPA_INSTALL_DIR,
      cacheDir: path.join(CACHE_ROOT, 'collector'),
      pricingOverrides: currentSettings.pricingOverrides,
    },
  });
  collectorWorker = worker;

  worker.on('message', (message: CollectorWorkerMessage) => {
    if (message.type === 'snapshot') {
      const snapshot = projectWidgetSnapshotV1(message.snapshot, CPA_INSTALL_DIR);
      if (!snapshot) {
        markCollectorUnavailable('error', 'collector-invalid-snapshot');
        return;
      }
      workerRestartCount = 0;
      currentSnapshot = snapshot;
      smokeCollectorReady = true;
      broadcastSnapshot();
      void maybeFinishSmokeTest();
      return;
    }

    if (message.type === 'reconcile-complete') {
      const pending = pendingCollectorReconciles.get(message.requestId);
      if (!pending) return;
      pendingCollectorReconciles.delete(message.requestId);
      clearTimeout(pending.timer);
      pending.resolve(currentSnapshot);
      return;
    }

    if (message.type === 'fatal') {
      rejectPendingCollectorReconciles('collector-reconcile-failed');
      markCollectorUnavailable('error', normalizeMessageCode(message.code));
    }
  });
  worker.on('error', () => {
    rejectPendingCollectorReconciles('collector-reconcile-failed');
    markCollectorUnavailable('error', 'collector-worker-error');
  });
  worker.on('exit', (code) => {
    if (collectorWorker === worker) {
      collectorWorker = null;
    }
    rejectPendingCollectorReconciles('collector-reconcile-failed');
    if (isCollectorShuttingDown || isQuitting || code === 0) {
      return;
    }

    markCollectorUnavailable('offline', 'collector-worker-exited');
    scheduleCollectorRestart();
  });
}

function scheduleCollectorRestart(): void {
  if (workerRestartCount >= MAX_WORKER_RESTARTS || workerRestartTimer) {
    return;
  }

  workerRestartCount += 1;
  workerRestartTimer = setTimeout(() => {
    workerRestartTimer = null;
    startCollector();
  }, WORKER_RESTART_DELAY_MS);
}

function postCollectorMessage(message: CollectorMainMessage): void {
  collectorWorker?.postMessage(message);
}

function reconcileCollector(): Promise<WidgetSnapshotV1> {
  const worker = collectorWorker;
  if (!worker) return Promise.reject(new Error('collector-reconcile-unavailable'));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCollectorReconciles.delete(requestId);
      reject(new Error('collector-reconcile-timeout'));
    }, COLLECTOR_RECONCILE_TIMEOUT_MS);
    timer.unref?.();
    pendingCollectorReconciles.set(requestId, { resolve, reject, timer });
    try {
      worker.postMessage({ type: 'reconcile', requestId } satisfies CollectorMainMessage);
    } catch {
      pendingCollectorReconciles.delete(requestId);
      clearTimeout(timer);
      reject(new Error('collector-reconcile-unavailable'));
    }
  });
}

function rejectPendingCollectorReconciles(code: string): void {
  const pending = [...pendingCollectorReconciles.values()];
  pendingCollectorReconciles.clear();
  for (const operation of pending) {
    clearTimeout(operation.timer);
    operation.reject(new Error(code));
  }
}

function shutdownCollector(): void {
  isCollectorShuttingDown = true;
  rejectPendingCollectorReconciles('collector-reconcile-unavailable');
  if (workerRestartTimer) {
    clearTimeout(workerRestartTimer);
    workerRestartTimer = null;
  }
  if (!collectorWorker) {
    return;
  }

  const worker = collectorWorker;
  collectorWorker = null;
  worker.postMessage({ type: 'shutdown' } satisfies CollectorMainMessage);
  setTimeout(() => {
    void worker.terminate();
  }, 750).unref();
}

function resolveCollectorWorkerPath(): string {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      'app.asar.unpacked',
      'dist-electron',
      'collector',
      'worker.js'
    );
  }

  return fileURLToPath(new URL('./collector/worker.js', import.meta.url));
}

function markCollectorUnavailable(
  status: WidgetSnapshotV1['source']['status'],
  messageCode: string
): void {
  currentSnapshot = {
    ...currentSnapshot,
    computedAt: new Date().toISOString(),
    source: {
      ...currentSnapshot.source,
      status,
      messageCode,
    },
  };
  broadcastSnapshot();
}

function broadcastSnapshot(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.snapshot, currentSnapshot);
  }
}

function broadcastSettings(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(IPC_CHANNELS.settings, cloneSettings(currentSettings));
  }
}

async function maybeFinishSmokeTest(): Promise<void> {
  if (!IS_SMOKE_TEST || !smokeRendererReady || !smokeCollectorReady || smokeCompletionStarted) {
    return;
  }
  smokeCompletionStarted = true;

  let passed = false;
  try {
    passed = await mainWindow?.webContents.executeJavaScript(`
      (async () => {
        const shell = document.querySelector('#root .widget-shell');
        const snapshot = await window.cpaWidget.getSnapshot();
        return Boolean(
          shell &&
          !document.querySelector('.source-badge--preview') &&
          snapshot?.version === 1 &&
          snapshot?.source?.collectorVersion &&
          snapshot.source.collectorVersion !== 'pending'
        );
      })()
    `);
  } catch {
    passed = false;
  }

  if (!passed) {
    isQuitting = true;
    app.exit(5);
    return;
  }
  if (smokeTimeout) {
    clearTimeout(smokeTimeout);
    smokeTimeout = null;
  }
  setTimeout(() => {
    isQuitting = true;
    app.exit(0);
  }, 150).unref();
}

function normalizeMessageCode(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9._-]{1,80}$/i.test(value)) {
    return 'collector-fatal';
  }
  return value;
}

function getSafeDevRendererUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port !== '5173') {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}

function isAllowedRendererNavigation(rawUrl: string): boolean {
  if (DEV_RENDERER_URL) {
    try {
      return new URL(rawUrl).origin === DEV_RENDERER_URL;
    } catch {
      return false;
    }
  }

  return isFileUrlInsideRendererDist(rawUrl);
}

function isAllowedRendererResource(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === 'data:' || url.protocol === 'blob:') {
      return true;
    }
    if (url.protocol === 'file:') {
      return isFileUrlInsideRendererDist(rawUrl);
    }
    return DEV_RENDERER_URL !== null && url.origin === DEV_RENDERER_URL;
  } catch {
    return false;
  }
}

function isFileUrlInsideRendererDist(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'file:') {
      return false;
    }

    const rendererRoot = path.resolve(app.getAppPath(), 'dist');
    const candidatePath = path.resolve(fileURLToPath(url));
    const relativePath = path.relative(rendererRoot, candidatePath);
    return (
      relativePath === '' ||
      (!relativePath.startsWith(`..${path.sep}`) &&
        relativePath !== '..' &&
        !path.isAbsolute(relativePath))
    );
  } catch {
    return false;
  }
}

function createEmptyUsage(): WidgetUsageTotals {
  return {
    fromMs: null,
    toMs: null,
    requests: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    estimatedUsd: null,
    pricedTokens: 0,
    unpricedTokens: 0,
    pricedRequests: 0,
    unpricedRequests: 0,
  };
}

function createEmptyUsageView(): WidgetUsageView {
  return {
    statusCounts: {
      available: 0,
      pending: 0,
      unreported: 0,
      ambiguous: 0,
      parseError: 0,
      unsupported: 0,
    },
    periods: {
      today: createEmptyUsage(),
      rolling24h: createEmptyUsage(),
      rolling7d: createEmptyUsage(),
      month: createEmptyUsage(),
      ledgerCoverage: createEmptyUsage(),
    },
    trend60m: [],
    topModels: [],
    recentModels: [],
    latestRequest: null,
  };
}

function createEmptySnapshot(): WidgetSnapshotV1 {
  return {
    version: 1,
    computedAt: new Date().toISOString(),
    source: {
      status: 'loading',
      installDir: CPA_INSTALL_DIR,
      collectorVersion: 'pending',
      parserVersion: 'pending',
      pricingVersion: 'pending',
      ledgerGeneratedAt: null,
      ledgerCoverageStartMs: null,
      ledgerCoverageEndMs: null,
      latestRequestAtMs: null,
      lastSuccessfulScanAtMs: null,
      lastReconcileAtMs: null,
      pendingFiles: 0,
      parseErrors: 0,
      unsupportedFiles: 0,
      possibleCoverageGap: false,
      messageCode: 'collector-starting',
    },
    statusCounts: {
      available: 0,
      pending: 0,
      unreported: 0,
      ambiguous: 0,
      parseError: 0,
      unsupported: 0,
    },
    periods: {
      today: createEmptyUsage(),
      rolling24h: createEmptyUsage(),
      rolling7d: createEmptyUsage(),
      month: createEmptyUsage(),
      ledgerCoverage: createEmptyUsage(),
    },
    trend60m: [],
    topModels: [],
    recentModels: [],
    latestRequest: null,
    ledgerView: createEmptyUsageView(),
    unledgeredView: createEmptyUsageView(),
  };
}
