import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_INSTALL_DIR = 'D:\\CLIProxyAPI';
const DEFAULT_CUSTOM_UI_DIR = 'D:\\CLIProxyAPI_Maintenance\\custom-ui';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8319;
const DEFAULT_BACKEND_PORT = 8317;
const DEFAULT_IDLE_SHUTDOWN_MINUTES = 10;
const MANAGEMENT_PREFIX = '/v0/management';
const MAX_BODY_BYTES = 128 * 1024;
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:8317',
  'http://localhost:8317',
  'http://[::1]:8317',
]);
const ALLOWED_BACKEND_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    'Usage: node scripts/cliproxyapi-control-sidecar.mjs [--install-dir D:\\CLIProxyAPI] [--custom-ui-dir D:\\CLIProxyAPI_Maintenance\\custom-ui] [--port 8319] [--backend-port 8317] [--idle-shutdown-minutes 10]'
  );
  process.exit(0);
}

const installDir = args['install-dir'] ?? DEFAULT_INSTALL_DIR;
const customUiDir = args['custom-ui-dir'] ?? DEFAULT_CUSTOM_UI_DIR;
const host = args.host ?? DEFAULT_HOST;
const port = normalizePort(args.port ?? DEFAULT_PORT, DEFAULT_PORT);
const backendPort = normalizePort(args['backend-port'] ?? DEFAULT_BACKEND_PORT, DEFAULT_BACKEND_PORT);
const idleShutdownMinutes = clampInteger(
  args['idle-shutdown-minutes'] ?? DEFAULT_IDLE_SHUTDOWN_MINUTES,
  DEFAULT_IDLE_SHUTDOWN_MINUTES,
  1,
  180
);
const idleShutdownMs = idleShutdownMinutes * 60_000;
const restartScriptPath =
  args['restart-script'] ?? path.join(installDir, 'Restart-CLIProxyAPI-Logged.ps1');
const logsDir = args['logs-dir'] ?? path.join(installDir, 'logs');
const expectedExePath = path.join(installDir, 'cli-proxy-api.exe');

let serverRef = null;
let idleShutdownTimer = null;
let lastActivityAt = Date.now();
let restartInFlight = null;

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

function normalizePort(value, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65_535) return fallback;
  return numeric;
}

function clampInteger(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

export function normalizeApiBase(value) {
  let base = String(value ?? '').trim();
  if (!base) return `http://127.0.0.1:${backendPort}`;
  base = base.replace(/\/?v0\/management\/?$/i, '');
  base = base.replace(/\/+$/g, '');
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  return base;
}

export function isLocalBackendApiBaseValue(value) {
  try {
    const url = new URL(normalizeApiBase(value));
    const normalizedPort =
      url.port || (url.protocol === 'https:' ? '443' : url.protocol === 'http:' ? '80' : '');
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      ALLOWED_BACKEND_HOSTS.has(url.hostname) &&
      Number(normalizedPort) === backendPort
    );
  } catch {
    return false;
  }
}

function managementUrl(apiBase, endpoint) {
  const base = normalizeApiBase(apiBase);
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${base}${MANAGEMENT_PREFIX}${normalizedEndpoint}`;
}

export function isOriginAllowedValue(origin) {
  const value = String(origin ?? '').trim();
  return !value || ALLOWED_ORIGINS.has(value);
}

export function resolvePwshPath(env = process.env, fileExists = existsSync) {
  const programFiles = env.ProgramFiles || 'C:\\Program Files';
  const windowsDir = env.WINDIR || env.SystemRoot || 'C:\\Windows';
  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    path.win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    'D:\\Tools\\PowerShell\\7\\pwsh.exe',
    path.win32.join(windowsDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'pwsh.exe',
  ];

  for (const candidate of [...new Set(candidates)]) {
    if (candidate === 'pwsh.exe' || fileExists(candidate)) {
      return candidate;
    }
  }

  return 'pwsh.exe';
}

function isOriginAllowed(req) {
  return isOriginAllowedValue(req.headers.origin);
}

function applyCors(req, res) {
  const origin = String(req.headers.origin ?? '').trim();
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-CPAMC-Management-Key'
  );
}

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function extractBearer(req) {
  const authorization = String(req.headers.authorization ?? '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]?.trim()) return match[1].trim();
  const headerKey = req.headers['x-cpamc-management-key'];
  return typeof headerKey === 'string' ? headerKey.trim() : '';
}

async function readBody(req) {
  let total = 0;
  const chunks = [];
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function extractErrorMessage(value) {
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value : '';
  const error = value.error;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && typeof error.message === 'string') {
    return error.message;
  }
  if (typeof value.message === 'string') return value.message;
  return '';
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const message = extractErrorMessage(data) || text || `HTTP ${response.status}`;
      throw new HttpError(response.status, message);
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export async function validateManagementKey(key, apiBase) {
  const trimmed = String(key ?? '').trim();
  if (!trimmed) throw new HttpError(401, 'Management key required');
  if (!isLocalBackendApiBaseValue(apiBase)) {
    throw new HttpError(400, 'Only local CLIProxyAPI backend can be controlled');
  }
  await fetchJson(managementUrl(apiBase, '/config'), {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${trimmed}`,
    },
    timeoutMs: 20_000,
  });
  return true;
}

function runPwsh(script, input = '') {
  return new Promise((resolve, reject) => {
    const pwshPath = resolvePwshPath();
    const child = spawn(
      pwshPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      reject(new Error(`failed to launch PowerShell (${pwshPath}): ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `${path.basename(pwshPath)} exited with ${code}`));
      }
    });
    child.stdin.end(input, 'utf8');
  });
}

function runPwshFile(filePath, argumentList = []) {
  return new Promise((resolve, reject) => {
    const pwshPath = resolvePwshPath();
    const child = spawn(
      pwshPath,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', filePath, ...argumentList],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      reject(new Error(`failed to launch PowerShell (${pwshPath}): ${err.message}`));
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `${path.basename(pwshPath)} exited with ${code}`));
      }
    });
  });
}

function runNative(filePath, argumentList = [], { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(filePath, argumentList, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${filePath} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `${filePath} exited with ${code}`));
      }
    });
  });
}

export function isCliProxyApiProcessPath(actualPath, expectedPath) {
  const normalize = (value) => String(value ?? '').trim().replace(/\//g, '\\').toLowerCase();
  return Boolean(normalize(actualPath)) && normalize(actualPath) === normalize(expectedPath);
}

function parseNetstatListenerPid(output, targetPort) {
  const portSuffix = `:${targetPort}`;
  const lines = String(output ?? '').split(/\r?\n/);
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[0].toUpperCase() !== 'TCP') continue;
    const localAddress = parts[1];
    const state = parts[3];
    const pid = Number(parts[4]);
    if (
      Number.isInteger(pid) &&
      state?.toUpperCase() === 'LISTENING' &&
      (localAddress === `127.0.0.1${portSuffix}` ||
        localAddress === `0.0.0.0${portSuffix}` ||
        localAddress.endsWith(portSuffix))
    ) {
      return pid;
    }
  }
  return null;
}

function parseWmicList(output) {
  const record = {};
  String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .forEach((line) => {
      const index = line.indexOf('=');
      if (index <= 0) return;
      record[line.slice(0, index)] = line.slice(index + 1);
    });
  return record;
}

function parseWmicDate(value) {
  const match = String(value ?? '').match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d*([+-])(\d{3})/
  );
  if (!match) return null;
  const [, year, month, day, hour, minute, second, millisecond, sign, offset] = match;
  const offsetMinutes = Number(offset) * (sign === '-' ? -1 : 1);
  const utcMs =
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(millisecond)
    ) -
    offsetMinutes * 60_000;
  return Number.isFinite(utcMs) ? new Date(utcMs).toISOString() : null;
}

async function getProcessInfo(pid) {
  try {
    const output = await runNative(
      'wmic.exe',
      [
        'process',
        'where',
        `processid=${pid}`,
        'get',
        'ProcessId,ExecutablePath,CreationDate',
        '/format:list',
      ],
      { timeoutMs: 5_000 }
    );
    const record = parseWmicList(output);
    return {
      path: record.ExecutablePath || null,
      startedAt: parseWmicDate(record.CreationDate),
    };
  } catch {
    return null;
  }
}

async function getBackendProcessInfo() {
  try {
    const netstat = await runNative('netstat.exe', ['-ano', '-p', 'TCP'], { timeoutMs: 5_000 });
    const pid = parseNetstatListenerPid(netstat, backendPort);
    if (!pid) {
      return {
        running: false,
        pid: null,
        path: null,
        startedAt: null,
        expectedPath: expectedExePath,
        matchesExpectedPath: false,
      };
    }
    const processInfo = await getProcessInfo(pid);
    const processPath = processInfo?.path ?? null;
    return {
      running: true,
      pid,
      path: processPath,
      startedAt: processInfo?.startedAt ?? null,
      expectedPath: expectedExePath,
      matchesExpectedPath: isCliProxyApiProcessPath(processPath, expectedExePath),
    };
  } catch {
    return getBackendProcessInfoViaPwsh();
  }
}

async function getBackendProcessInfoViaPwsh() {
  const script = `
$ErrorActionPreference = "Stop"
$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
$port = [int]$payload.backendPort
$expectedPath = [string]$payload.expectedExePath
$listener = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
$process = $null
if ($listener) {
  $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
}
$matchesExpectedPath = $false
if ($process -and $process.Path) {
  $matchesExpectedPath = ([System.IO.Path]::GetFullPath($process.Path).TrimEnd('\') -ieq [System.IO.Path]::GetFullPath($expectedPath).TrimEnd('\'))
}
[pscustomobject]@{
  running = [bool]$listener
  pid = if ($listener) { [int]$listener.OwningProcess } else { $null }
  path = if ($process) { $process.Path } else { $null }
  startedAt = if ($process) { $process.StartTime.ToString("o") } else { $null }
  expectedPath = $expectedPath
  matchesExpectedPath = $matchesExpectedPath
} | ConvertTo-Json -Compress -Depth 4
`;
  const output = await runPwsh(
    script,
    JSON.stringify({
      backendPort,
      expectedExePath,
    })
  );
  return output ? JSON.parse(output) : null;
}

async function logLine(level, message, details = {}) {
  const safeDetails = { ...details };
  delete safeDetails.managementKey;
  delete safeDetails.secret;
  delete safeDetails.authorization;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const logPath = path.join(logsDir, `control-sidecar-${today}.log`);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...safeDetails,
  });
  await mkdir(logsDir, { recursive: true });
  await writeFile(logPath, `${line}\n`, { encoding: 'utf8', flag: 'a' }).catch(() => {});
}

async function buildStatusPayload() {
  let backend = null;
  let backendError = null;
  try {
    backend = await getBackendProcessInfo();
  } catch (error) {
    backendError = error instanceof Error ? error.message : String(error);
  }

  return {
    ok: true,
    pid: process.pid,
    host,
    port,
    installDir,
    customUiDir,
    backendPort,
    idleShutdownMinutes,
    restartScriptPath,
    backendRunning: backend?.running === true && backend?.matchesExpectedPath === true,
    backendPid: backend?.running === true ? backend.pid : null,
    backendPath: backend?.path ?? null,
    backendStartedAt: backend?.startedAt ?? null,
    backendPathMatches: backend?.matchesExpectedPath === true,
    backendError,
    restarting: Boolean(restartInFlight),
  };
}

async function runRestartScript() {
  if (restartInFlight) return restartInFlight;

  restartInFlight = (async () => {
    await logLine('info', 'backend restart requested', { backendPort, restartScriptPath });
    const output = await runPwshFile(restartScriptPath, [
      '-InstallDir',
      installDir,
      '-BackendPort',
      String(backendPort),
    ]);
    const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const jsonLine = [...lines].reverse().find((line) => line.startsWith('{') && line.endsWith('}'));
    const result = jsonLine ? JSON.parse(jsonLine) : { ok: true, rawOutput: output };
    await logLine('info', 'backend restart completed', {
      ok: result.ok,
      oldPid: result.oldPid,
      newPid: result.newPid,
    });
    return result;
  })();

  try {
    return await restartInFlight;
  } catch (error) {
    await logLine('error', 'backend restart failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    restartInFlight = null;
  }
}

function sendJson(req, res, statusCode, payload) {
  applyCors(req, res);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(`${JSON.stringify(payload)}\n`);
}

function sendError(req, res, error) {
  const statusCode = error instanceof HttpError ? error.statusCode : error.statusCode || 500;
  sendJson(req, res, statusCode, {
    error: error instanceof Error ? error.message : String(error),
  });
}

function touchActivity() {
  lastActivityAt = Date.now();
  scheduleIdleShutdown();
}

function scheduleIdleShutdown() {
  if (idleShutdownTimer) clearTimeout(idleShutdownTimer);
  const delayMs = Math.max(1_000, lastActivityAt + idleShutdownMs - Date.now());
  idleShutdownTimer = setTimeout(async () => {
    if (restartInFlight) {
      touchActivity();
      return;
    }
    await logLine('info', 'control sidecar idle shutdown', { idleShutdownMinutes });
    serverRef?.close(() => process.exit(0));
  }, delayMs);
  idleShutdownTimer.unref?.();
}

async function handleRequest(req, res) {
  if (!isOriginAllowed(req)) {
    throw new HttpError(403, 'Origin not allowed');
  }
  if (req.method === 'OPTIONS') {
    applyCors(req, res);
    res.statusCode = 204;
    res.end();
    return;
  }

  touchActivity();
  const url = new URL(req.url ?? '/', `http://${host}:${port}`);

  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
    sendJson(req, res, 200, await buildStatusPayload());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/restart') {
    const body = await readBody(req);
    const key = extractBearer(req) || String(body.managementKey ?? '').trim();
    const apiBase = normalizeApiBase(body.apiBase);
    await validateManagementKey(key, apiBase);
    const result = await runRestartScript();
    sendJson(req, res, 200, {
      ok: result.ok !== false,
      controlPid: process.pid,
      result,
      status: await buildStatusPayload(),
    });
    return;
  }

  throw new HttpError(404, 'Not found');
}

async function startServer() {
  await mkdir(logsDir, { recursive: true });
  scheduleIdleShutdown();
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => sendError(req, res, error));
  });
  serverRef = server;
  server.listen(port, host, async () => {
    await logLine('info', 'control sidecar started', {
      host,
      port,
      installDir,
      customUiDir,
      backendPort,
      restartScriptPath,
      idleShutdownMinutes,
    });
  });
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  startServer().catch(async (error) => {
    await logLine('error', 'control sidecar startup failed', {
      message: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    process.exitCode = 1;
  });
}
