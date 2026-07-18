import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, utilityProcess } from 'electron';

const smokeDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.resolve(smokeDirectory, '..', '..');
const workerPath = path.join(widgetRoot, 'dist-electron', 'maintenance', 'worker.js');
const tempDirectory = 'D:\\Tools\\Cache\\CPA-Token-Pulse\\maintenance-smoke-temp';
const resultPath = path.join(tempDirectory, 'result.json');
const readyTimeoutMs = 15_000;
const timeoutMs = 120_000;

app.disableHardwareAcceleration();

let settled = false;
const finish = (code, child, ...timers) => {
  if (settled) return;
  settled = true;
  timers.forEach((timer) => clearTimeout(timer));
  child?.kill();
  app.exit(code);
};

mkdirSync(tempDirectory, { recursive: true });
rmSync(resultPath, { force: true });

let readyTimedOut = false;
const readyTimer = setTimeout(() => {
  readyTimedOut = true;
  writeFileSync(resultPath, '{"status":"fail","code":"app-ready-timeout"}\n', 'utf8');
  finish(6, null, readyTimer);
}, readyTimeoutMs);
const startSmoke = () => {
  if (readyTimedOut || settled) return;
  clearTimeout(readyTimer);

  const child = utilityProcess.fork(workerPath, [], {
    cwd: path.dirname(workerPath),
    env: {
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
      TEMP: tempDirectory,
      TMP: tempDirectory,
    },
    serviceName: 'CPA Token Pulse Maintenance Preview Smoke',
    stdio: 'ignore',
  });

  let timer;
  const armTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      writeFileSync(resultPath, '{"status":"fail","code":"timeout"}\n', 'utf8');
      finish(3, child, timer);
    }, timeoutMs);
  };
  armTimer();
  child.once('spawn', () => child.postMessage({ type: 'preview' }));
  child.on('message', (message) => {
    if (message?.type === 'maintenance-progress') {
      armTimer();
      return;
    }
    const text = JSON.stringify(message);
    const preview = message?.type === 'preview-result' ? message.preview : null;
    const safe =
      preview?.version === 1 &&
      Number.isSafeInteger(preview.projectedLedgerEntries) &&
      Number.isSafeInteger(preview.projectedAvailableRequests) &&
      Number.isSafeInteger(preview.projectedTotalTokens) &&
      !/requestId|fileName|sourceKey|headers|prompt|stack|D:\\CLIProxyAPI/i.test(text);
    if (safe) {
      writeFileSync(
        resultPath,
        `${JSON.stringify({
          status: 'pass',
          projectedLedgerEntries: preview.projectedLedgerEntries,
          projectedAvailableRequests: preview.projectedAvailableRequests,
          projectedTotalTokens: preview.projectedTotalTokens,
          eligibleFiles: preview.prune.eligibleFiles,
        })}\n`,
        'utf8'
      );
    } else {
      writeFileSync(resultPath, '{"status":"fail","code":"invalid-preview"}\n', 'utf8');
    }
    finish(safe ? 0 : 2, child, timer);
  });
  child.once('error', () => {
    writeFileSync(resultPath, '{"status":"fail","code":"child-error"}\n', 'utf8');
    finish(4, child, timer);
  });
  child.once('exit', () => {
    if (!settled) {
      writeFileSync(resultPath, '{"status":"fail","code":"child-exit"}\n', 'utf8');
    }
    finish(5, null, timer);
  });
};

void app
  .whenReady()
  .then(startSmoke)
  .catch(() => {
    writeFileSync(resultPath, '{"status":"fail","code":"app-ready-error"}\n', 'utf8');
    finish(7, null, readyTimer);
  });
