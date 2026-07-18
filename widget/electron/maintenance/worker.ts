import { createMaintenanceRequestHandler } from './protocol.js';

const port = process.parentPort;
if (!port) {
  process.exit(1);
}

const libraryGlobal = globalThis as typeof globalThis & {
  __CPAMC_TOKEN_LEDGER_LIBRARY_MODE__?: boolean;
};
libraryGlobal.__CPAMC_TOKEN_LEDGER_LIBRARY_MODE__ = true;

const { runProductionTokenLedgerMaintenance } = await import(
  '../../../scripts/update-token-ledger.mjs'
);
const handleRequest = createMaintenanceRequestHandler({
  runMaintenance: runProductionTokenLedgerMaintenance,
});

const HEARTBEAT_INTERVAL_MS = 10_000;
const PREVIEW_IDLE_EXIT_MS = 70_000;
let state: 'idle' | 'previewed' | 'done' = 'idle';
let operationInFlight = false;
let idleExit: ReturnType<typeof setTimeout> | null = null;

const exitSoon = (): void => {
  state = 'done';
  setTimeout(() => process.exit(0), 10);
};

port.on('message', (event) => {
  if (state === 'done' || operationInFlight) return;
  const request = event.data as Parameters<typeof handleRequest>[0] | null;
  if (
    !request ||
    (state === 'idle' && request.type !== 'preview') ||
    (state === 'previewed' && request.type !== 'execute')
  ) {
    port.postMessage({ type: 'maintenance-error', code: 'ledger-maintenance-failed' });
    exitSoon();
    return;
  }
  if (idleExit) {
    clearTimeout(idleExit);
    idleExit = null;
  }
  operationInFlight = true;
  const heartbeat = setInterval(
    () => port.postMessage({ type: 'maintenance-progress' }),
    HEARTBEAT_INTERVAL_MS
  );
  heartbeat.unref?.();
  void handleRequest(request)
    .then((response) => {
      port.postMessage(response);
      if (response.type === 'preview-result') {
        state = 'previewed';
        idleExit = setTimeout(exitSoon, PREVIEW_IDLE_EXIT_MS);
        idleExit.unref?.();
      } else {
        exitSoon();
      }
    })
    .catch(() => {
      port.postMessage({ type: 'maintenance-error', code: 'ledger-maintenance-failed' });
      exitSoon();
    })
    .finally(() => {
      clearInterval(heartbeat);
      operationInFlight = false;
    });
});
