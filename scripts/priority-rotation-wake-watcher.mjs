import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readLatestModelRequestAtMs } from './priority-rotation-sidecar.mjs';

const DEFAULT_INSTALL_DIR = 'D:\\CLIProxyAPI';
const DEFAULT_CUSTOM_UI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8318;
const DEFAULT_IDLE_SHUTDOWN_MINUTES = 20;
const DEFAULT_POLL_SECONDS = 5;
const DEFAULT_COOLDOWN_SECONDS = 30;
const MIN_POLL_SECONDS = 1;
const MAX_POLL_SECONDS = 300;
const MIN_COOLDOWN_SECONDS = 1;
const MAX_COOLDOWN_SECONDS = 600;

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = rawArgs[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

function clampInteger(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

function normalizePort(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65_535) return DEFAULT_PORT;
  return numeric;
}

function toIso(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Date(numeric).toISOString() : null;
}

function finiteNumberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function normalizeWatcherOptions(input = {}) {
  const installDir = String(input.installDir ?? input['install-dir'] ?? DEFAULT_INSTALL_DIR);
  const customUiDir = String(input.customUiDir ?? input['custom-ui-dir'] ?? DEFAULT_CUSTOM_UI_DIR);
  const dataDir = String(input.dataDir ?? input['data-dir'] ?? path.join(installDir, 'priority-rotation'));
  const port = normalizePort(input.port ?? DEFAULT_PORT);
  const pollSeconds = clampInteger(
    input.pollSeconds ?? input['poll-seconds'],
    DEFAULT_POLL_SECONDS,
    MIN_POLL_SECONDS,
    MAX_POLL_SECONDS
  );
  const cooldownSeconds = clampInteger(
    input.cooldownSeconds ?? input['cooldown-seconds'],
    DEFAULT_COOLDOWN_SECONDS,
    MIN_COOLDOWN_SECONDS,
    MAX_COOLDOWN_SECONDS
  );

  return {
    installDir,
    customUiDir,
    dataDir,
    host: String(input.host ?? DEFAULT_HOST),
    port,
    idleShutdownMinutes: clampInteger(
      input.idleShutdownMinutes ?? input['idle-shutdown-minutes'],
      DEFAULT_IDLE_SHUTDOWN_MINUTES,
      1,
      180
    ),
    modelRequestLogsDir: String(
      input.modelRequestLogsDir ?? input['model-request-logs-dir'] ?? path.join(installDir, 'logs')
    ),
    settingsPath: String(input.settingsPath ?? path.join(dataDir, 'settings.json')),
    statePath: String(input.statePath ?? path.join(dataDir, 'wake-watcher-state.json')),
    watcherLogsDir: String(input.watcherLogsDir ?? path.join(dataDir, 'logs')),
    pollSeconds,
    cooldownSeconds,
  };
}

export function createInitialWatcherState(nowMs = Date.now()) {
  const nowIso = toIso(nowMs);
  return {
    serviceStartedAt: nowIso,
    lastSeenRequestAtMs: null,
    lastSeenRequestAt: null,
    lastWakeAttemptAtMs: null,
    lastWakeAttemptAt: null,
    lastWakeResult: null,
    lastSkippedReason: null,
    lastError: null,
    wakeCount: 0,
    updatedAt: nowIso,
  };
}

function normalizeWatcherState(input = {}, nowMs = Date.now()) {
  const base = createInitialWatcherState(nowMs);
  const lastSeenRequestAtMs = finiteNumberOrNull(input.lastSeenRequestAtMs);
  const lastWakeAttemptAtMs = finiteNumberOrNull(input.lastWakeAttemptAtMs);
  return {
    ...base,
    ...input,
    lastSeenRequestAtMs,
    lastSeenRequestAt: lastSeenRequestAtMs !== null
      ? toIso(lastSeenRequestAtMs)
      : input.lastSeenRequestAt ?? null,
    lastWakeAttemptAtMs,
    lastWakeAttemptAt: lastWakeAttemptAtMs !== null
      ? toIso(lastWakeAttemptAtMs)
      : input.lastWakeAttemptAt ?? null,
  };
}

async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${attempt}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    try {
      await rename(tmpPath, filePath);
      return;
    } catch (error) {
      lastError = error;
      await rm(tmpPath, { force: true }).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function readSettingsEnabled(settingsPath) {
  const settings = await readJson(settingsPath, {});
  return settings?.enabled === true;
}

async function logLine(options, level, message, details = {}) {
  await mkdir(options.watcherLogsDir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const logPath = path.join(options.watcherLogsDir, `wake-watcher-${today}.log`);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...details,
  });
  await writeFile(logPath, `${line}\n`, { encoding: 'utf8', flag: 'a' }).catch(() => {});
}

async function fetchWithTimeout(url, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function isSidecarReachable(options) {
  try {
    const response = await fetchWithTimeout(`http://${options.host}:${options.port}/status`);
    return response.ok;
  } catch {
    return false;
  }
}

export function launchSidecar(options) {
  const wscriptPath = path.join(process.env.WINDIR ?? 'C:\\Windows', 'System32', 'wscript.exe');
  const runnerPath = path.join(options.customUiDir, 'scripts', 'run-priority-rotation-sidecar-hidden.vbs');
  const child = spawn(
    wscriptPath,
    [
      '//B',
      '//NoLogo',
      runnerPath,
      options.installDir,
      options.customUiDir,
      String(options.port),
      String(options.idleShutdownMinutes),
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }
  );
  child.unref();
}

async function waitForSidecar(options, attempts = 15, delayMs = 750) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await isSidecarReachable(options)) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

export function shouldWakeForActivity({
  latestRequestAtMs,
  lastSeenRequestAtMs,
  lastWakeAttemptAtMs,
  nowMs = Date.now(),
  cooldownSeconds = DEFAULT_COOLDOWN_SECONDS,
  settingsEnabled = false,
  sidecarRunning = false,
} = {}) {
  const latest = finiteNumberOrNull(latestRequestAtMs);
  const lastSeen = finiteNumberOrNull(lastSeenRequestAtMs);
  const lastWakeAttempt = finiteNumberOrNull(lastWakeAttemptAtMs);
  if (!Number.isFinite(latest)) {
    return {
      wake: false,
      reason: 'no_request_logs',
      nextLastSeenRequestAtMs: lastSeen,
    };
  }
  if (lastSeen === null) {
    return { wake: false, reason: 'bootstrap', nextLastSeenRequestAtMs: latest };
  }
  if (latest <= lastSeen) {
    return { wake: false, reason: 'no_new_request', nextLastSeenRequestAtMs: lastSeen };
  }
  if (!settingsEnabled) {
    return { wake: false, reason: 'disabled', nextLastSeenRequestAtMs: latest };
  }
  if (sidecarRunning) {
    return { wake: false, reason: 'already_running', nextLastSeenRequestAtMs: latest };
  }
  const cooldownMs =
    clampInteger(
      cooldownSeconds,
      DEFAULT_COOLDOWN_SECONDS,
      MIN_COOLDOWN_SECONDS,
      MAX_COOLDOWN_SECONDS
    ) * 1_000;
  if (lastWakeAttempt !== null && nowMs - lastWakeAttempt < cooldownMs) {
    return { wake: false, reason: 'cooldown', nextLastSeenRequestAtMs: latest };
  }
  return { wake: true, reason: 'new_request', nextLastSeenRequestAtMs: latest };
}

export async function runWatcherOnce({
  options,
  state,
  dependencies = {},
  bootstrap = false,
} = {}) {
  const normalizedOptions = normalizeWatcherOptions(options);
  const nowMs = Number(dependencies.now?.() ?? Date.now());
  const currentState = normalizeWatcherState(
    state ?? (await readJson(normalizedOptions.statePath, {})),
    nowMs
  );
  const latestRequestAtMs = await (dependencies.readLatestRequestAtMs ??
    (() => readLatestModelRequestAtMs(normalizedOptions.modelRequestLogsDir, null)))();

  let settingsEnabled = false;
  let sidecarRunning = false;
  let decision = shouldWakeForActivity({
    latestRequestAtMs,
    lastSeenRequestAtMs: bootstrap ? null : currentState.lastSeenRequestAtMs,
    lastWakeAttemptAtMs: currentState.lastWakeAttemptAtMs,
    nowMs,
    cooldownSeconds: normalizedOptions.cooldownSeconds,
    settingsEnabled,
    sidecarRunning,
  });

  if (
    decision.reason !== 'no_request_logs' &&
    decision.reason !== 'bootstrap' &&
    decision.reason !== 'no_new_request'
  ) {
    settingsEnabled = await (dependencies.readSettingsEnabled ??
      (() => readSettingsEnabled(normalizedOptions.settingsPath)))();
    if (settingsEnabled) {
      sidecarRunning = await (dependencies.isSidecarReachable ??
        (() => isSidecarReachable(normalizedOptions)))();
    }
    decision = shouldWakeForActivity({
      latestRequestAtMs,
      lastSeenRequestAtMs: currentState.lastSeenRequestAtMs,
      lastWakeAttemptAtMs: currentState.lastWakeAttemptAtMs,
      nowMs,
      cooldownSeconds: normalizedOptions.cooldownSeconds,
      settingsEnabled,
      sidecarRunning,
    });
  }

  const nextState = {
    ...currentState,
    lastSeenRequestAtMs: decision.nextLastSeenRequestAtMs,
    lastSeenRequestAt: toIso(decision.nextLastSeenRequestAtMs),
    lastSkippedReason: decision.wake ? null : decision.reason,
    lastError: null,
  };

  if (decision.wake) {
    nextState.lastWakeAttemptAtMs = nowMs;
    nextState.lastWakeAttemptAt = toIso(nowMs);
    try {
      await (dependencies.launchSidecar ?? (() => launchSidecar(normalizedOptions)))();
      const reachable = await (dependencies.waitForSidecar ??
        (() => waitForSidecar(normalizedOptions)))();
      nextState.lastWakeResult = reachable ? 'started' : 'started_unconfirmed';
      nextState.wakeCount = Number(nextState.wakeCount ?? 0) + 1;
      await (dependencies.logLine ?? ((level, message, details) => logLine(normalizedOptions, level, message, details)))(
        'info',
        'priority rotation sidecar wake requested',
        {
          requestAt: toIso(latestRequestAtMs),
          result: nextState.lastWakeResult,
        }
      );
    } catch (error) {
      nextState.lastWakeResult = 'failed';
      nextState.lastError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      await (dependencies.logLine ?? ((level, message, details) => logLine(normalizedOptions, level, message, details)))(
        'error',
        'priority rotation sidecar wake failed',
        {
          requestAt: toIso(latestRequestAtMs),
          message: nextState.lastError,
        }
      );
    }
  }

  const shouldPersist =
    nextState.lastSeenRequestAtMs !== currentState.lastSeenRequestAtMs ||
    nextState.lastSkippedReason !== currentState.lastSkippedReason ||
    nextState.lastWakeAttemptAtMs !== currentState.lastWakeAttemptAtMs ||
    nextState.lastWakeResult !== currentState.lastWakeResult ||
    nextState.lastError !== currentState.lastError ||
    nextState.wakeCount !== currentState.wakeCount;

  if (shouldPersist) {
    nextState.updatedAt = toIso(nowMs);
    await (dependencies.persistState ?? ((value) => writeJsonAtomic(normalizedOptions.statePath, value)))(
      nextState
    );
  }

  return {
    decision,
    state: nextState,
    settingsEnabled,
    sidecarRunning,
  };
}

async function startWatcher() {
  const options = normalizeWatcherOptions(parseArgs(process.argv.slice(2)));
  await mkdir(options.dataDir, { recursive: true });
  await mkdir(options.watcherLogsDir, { recursive: true });
  await logLine(options, 'info', 'priority rotation wake watcher started', {
    installDir: options.installDir,
    customUiDir: options.customUiDir,
    modelRequestLogsDir: options.modelRequestLogsDir,
    port: options.port,
    pollSeconds: options.pollSeconds,
    cooldownSeconds: options.cooldownSeconds,
  });

  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    try {
      await runWatcherOnce({ options });
    } catch (error) {
      await logLine(options, 'error', 'priority rotation wake watcher pass failed', {
        message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
    await new Promise((resolve) => setTimeout(resolve, options.pollSeconds * 1_000));
  }

  await logLine(options, 'info', 'priority rotation wake watcher stopped');
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  startWatcher().catch(async (error) => {
    const options = normalizeWatcherOptions(parseArgs(process.argv.slice(2)));
    await logLine(options, 'error', 'priority rotation wake watcher fatal error', {
      message: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
    });
    process.exit(1);
  });
}
