import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.dirname(scriptsDirectory);
const viteEntry = path.join(widgetRoot, 'node_modules', 'vite', 'bin', 'vite.js');
const electronEntry = path.join(widgetRoot, 'node_modules', 'electron', 'cli.js');
const buildEntry = path.join(scriptsDirectory, 'build-electron.mjs');
const rendererUrl = 'http://127.0.0.1:5173';

function spawnNode(args, environment = process.env) {
  return spawn(process.execPath, args, {
    cwd: widgetRoot,
    env: environment,
    stdio: 'inherit',
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`child-exit:${code ?? signal ?? 'unknown'}`));
    });
  });
}

async function waitForRenderer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(rendererUrl, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Vite is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error('renderer-start-timeout');
}

await waitForExit(spawnNode([buildEntry]));

const viteProcess = spawnNode([viteEntry, '--host', '127.0.0.1', '--port', '5173', '--strictPort']);

let electronProcess;
const cleanup = () => {
  electronProcess?.kill();
  viteProcess.kill();
};

process.once('SIGINT', cleanup);
process.once('SIGTERM', cleanup);

try {
  await waitForRenderer();
  electronProcess = spawnNode([electronEntry, '.'], {
    ...process.env,
    VITE_DEV_SERVER_URL: rendererUrl,
  });
  await waitForExit(electronProcess);
} finally {
  cleanup();
}
