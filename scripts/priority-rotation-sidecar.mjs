import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_INSTALL_DIR = 'D:\\CLIProxyAPI';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8318;
const MANAGEMENT_PREFIX = '/v0/management';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';
const FIVE_HOUR_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;
const DEFAULT_IDLE_SHUTDOWN_MINUTES = 20;
const DEFAULT_SETTINGS = {
  enabled: false,
  apiBase: 'http://127.0.0.1:8317',
  thresholdPercent: 50,
  activeSlotLimit: 5,
  checkIntervalMinutes: 5,
  revision: 0,
};
const PRIORITY_ROTATION_ACTIVE_PRIORITY = 2;
const PRIORITY_ROTATION_STANDBY_PRIORITY = 1;
const PRIORITY_ROTATION_BUFFER_PRIORITY = 0;
const PRIORITY_ROTATION_MANUAL_LOCKED_MIN_PRIORITY = 3;
const MAX_BODY_BYTES = 1024 * 1024;
const MODEL_ACTIVITY_SCAN_MIN_MS = 30_000;
const ALLOWED_ORIGINS = new Set([
  'http://127.0.0.1:8317',
  'http://localhost:8317',
  'http://[::1]:8317',
]);
const MANAGED_CODEX_PLANS = new Set(['team', 'plus', 'self_serve_business_usage_based']);
const INTEGER_STRING_PATTERN = /^[+-]?\d+$/;
const MAX_ROTATION_PASSES = 8;

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(
    'Usage: node scripts/priority-rotation-sidecar.mjs [--install-dir D:\\CLIProxyAPI] [--custom-ui-dir D:\\CLIProxyAPI_Maintenance\\custom-ui] [--port 8318] [--idle-shutdown-minutes 20] [--model-request-logs-dir D:\\CLIProxyAPI\\logs]'
  );
  process.exit(0);
}
const installDir = args['install-dir'] ?? DEFAULT_INSTALL_DIR;
const host = args.host ?? DEFAULT_HOST;
const port = normalizePort(args.port ?? DEFAULT_PORT);
const idleShutdownMinutes = clampInteger(
  args['idle-shutdown-minutes'] ?? DEFAULT_IDLE_SHUTDOWN_MINUTES,
  DEFAULT_IDLE_SHUTDOWN_MINUTES,
  1,
  180
);
const idleShutdownMs = idleShutdownMinutes * 60_000;
const dataDir = args['data-dir'] ?? path.join(installDir, 'priority-rotation');
const customUiDir = args['custom-ui-dir'] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelRequestLogsDir = args['model-request-logs-dir'] ?? path.join(installDir, 'logs');
const settingsPath = path.join(dataDir, 'settings.json');
const statePath = path.join(dataDir, 'state.json');
const secretPath = path.join(dataDir, 'management-key.dpapi');
const sidecarLogsDir = path.join(dataDir, 'logs');

let settings = { ...DEFAULT_SETTINGS };
let state = {
  serviceStartedAt: new Date().toISOString(),
  running: false,
  enabled: false,
  hasSecret: false,
  lastStatus: 'idle',
  lastSkippedReason: null,
  lastError: null,
  lastRunStartedAt: null,
  lastCompletedAt: null,
  lastAppliedChangeCount: 0,
  lastFailedChangeCount: 0,
  lastMutationAt: null,
  lastMutationAppliedChangeCount: 0,
  lastMutationChanges: [],
  nextRunAt: null,
  lastAnalysis: null,
  updatedAt: new Date().toISOString(),
};
let runInFlight = null;
let loopTimer = null;
let idleShutdownTimer = null;
let serverRef = null;
let shuttingDown = false;
let lastModelRequestAt = Date.now();
let lastModelActivityScanAt = 0;

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

function normalizePort(value) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65_535) return DEFAULT_PORT;
  return numeric;
}

function clampInteger(value, fallback, min, max) {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(min, Math.min(max, Math.round(numeric)));
}

export function shouldStopForIdle({
  nowMs = Date.now(),
  lastActivityAtMs,
  idleMinutes = DEFAULT_IDLE_SHUTDOWN_MINUTES,
  running = false,
} = {}) {
  const normalizedIdleMinutes = clampInteger(
    idleMinutes,
    DEFAULT_IDLE_SHUTDOWN_MINUTES,
    1,
    180
  );
  const activityAt = Number(lastActivityAtMs);
  if (running || !Number.isFinite(activityAt)) return false;
  return nowMs - activityAt >= normalizedIdleMinutes * 60_000;
}

export function parseModelRequestLogTimeMs(fileName) {
  const match =
    /^v1-[a-z0-9][a-z0-9-]*-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})-/i.exec(
      String(fileName ?? '')
    );
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const value = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ).getTime();
  return Number.isFinite(value) ? value : null;
}

export function isModelRequestLogName(fileName) {
  return parseModelRequestLogTimeMs(fileName) !== null;
}

export function getLatestModelRequestAtMs(entries, fallback = null) {
  let latest = Number.isFinite(Number(fallback)) ? Number(fallback) : null;
  for (const entry of entries ?? []) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    const parsedTime = parseModelRequestLogTimeMs(name);
    const mtimeMs = typeof entry === 'object' ? Number(entry?.mtimeMs) : NaN;
    const candidate = parsedTime ?? (Number.isFinite(mtimeMs) ? mtimeMs : null);
    if (candidate === null) continue;
    latest = latest === null ? candidate : Math.max(latest, candidate);
  }
  return latest;
}

export async function readLatestModelRequestAtMs(logDirectory, fallback = null) {
  try {
    const entries = await readdir(logDirectory, { withFileTypes: true });
    return getLatestModelRequestAtMs(
      entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
      fallback
    );
  } catch {
    return Number.isFinite(Number(fallback)) ? Number(fallback) : null;
  }
}

function normalizeSettings(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: source.enabled === true,
    apiBase: normalizeApiBase(source.apiBase ?? DEFAULT_SETTINGS.apiBase),
    thresholdPercent: clampInteger(
      source.thresholdPercent,
      DEFAULT_SETTINGS.thresholdPercent,
      0,
      100
    ),
    activeSlotLimit: clampInteger(
      source.activeSlotLimit,
      DEFAULT_SETTINGS.activeSlotLimit,
      1,
      99
    ),
    checkIntervalMinutes: clampInteger(
      source.checkIntervalMinutes,
      DEFAULT_SETTINGS.checkIntervalMinutes,
      1,
      180
    ),
    revision: clampInteger(source.revision, DEFAULT_SETTINGS.revision, 0, Number.MAX_SAFE_INTEGER),
  };
}

function normalizeApiBase(value) {
  let base = String(value ?? '').trim();
  if (!base) return DEFAULT_SETTINGS.apiBase;
  base = base.replace(/\/?v0\/management\/?$/i, '');
  base = base.replace(/\/+$/g, '');
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  return base;
}

function managementUrl(apiBase, endpoint) {
  const base = normalizeApiBase(apiBase);
  const normalizedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  return `${base}${MANAGEMENT_PREFIX}${normalizedEndpoint}`;
}

async function ensureDataDirs() {
  await mkdir(dataDir, { recursive: true });
  await mkdir(sidecarLogsDir, { recursive: true });
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
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  try {
    await rm(filePath, { force: true });
  } catch {
    // ignore
  }
  await rename(tmpPath, filePath);
}

async function hasSecretFile() {
  try {
    const info = await stat(secretPath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

function sanitizeSettingsForResponse(value = settings) {
  return normalizeSettings(value);
}

function sanitizeStateForResponse(value = state) {
  return {
    ...value,
    running: Boolean(value.running),
    enabled: settings.enabled,
    hasSecret: Boolean(value.hasSecret),
  };
}

async function updateState(patch) {
  state = {
    ...state,
    ...patch,
    enabled: settings.enabled,
    hasSecret: await hasSecretFile(),
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(statePath, state);
}

function getIdleShutdownAtIso() {
  return new Date(lastModelRequestAt + idleShutdownMs).toISOString();
}

export function buildIdleShutdownStatePatch(currentSettings = settings, currentState = state) {
  const normalizedSettings = normalizeSettings(currentSettings);
  return {
    running: false,
    enabled: normalizedSettings.enabled,
    lastStatus: 'skipped',
    lastSkippedReason: 'idle_timeout',
    lastError: null,
    nextRunAt: normalizedSettings.enabled
      ? currentState?.nextRunAt || nextRunIso()
      : null,
  };
}

function scheduleIdleShutdown() {
  if (idleShutdownTimer) clearTimeout(idleShutdownTimer);
  const delayMs = Math.max(1_000, lastModelRequestAt + idleShutdownMs - Date.now());
  idleShutdownTimer = setTimeout(() => {
    shutdownForIdle().catch(async (error) => {
      await logLine('error', 'idle shutdown failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, delayMs);
  idleShutdownTimer.unref?.();
}

async function refreshModelRequestActivity({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastModelActivityScanAt < MODEL_ACTIVITY_SCAN_MIN_MS) {
    return lastModelRequestAt;
  }
  lastModelActivityScanAt = now;
  const latest = await readLatestModelRequestAtMs(modelRequestLogsDir, lastModelRequestAt);
  if (latest !== null && latest > lastModelRequestAt) {
    lastModelRequestAt = latest;
    scheduleIdleShutdown();
  }
  return lastModelRequestAt;
}

async function persistIdleShutdownState() {
  await updateState(buildIdleShutdownStatePatch(settings, state));
}

async function shutdownForIdle() {
  if (shuttingDown) return;
  if (
    !shouldStopForIdle({
      nowMs: Date.now(),
      lastActivityAtMs: await refreshModelRequestActivity({ force: true }),
      idleMinutes: idleShutdownMinutes,
      running: Boolean(runInFlight),
    })
  ) {
    scheduleIdleShutdown();
    return;
  }

  shuttingDown = true;
  if (loopTimer) {
    clearInterval(loopTimer);
    loopTimer = null;
  }
  if (idleShutdownTimer) {
    clearTimeout(idleShutdownTimer);
    idleShutdownTimer = null;
  }

  await persistIdleShutdownState();
  await logLine('info', 'priority rotation sidecar idle shutdown', {
    idleShutdownMinutes,
    lastModelRequestAt: new Date(lastModelRequestAt).toISOString(),
  });

  if (!serverRef) {
    process.exit(0);
    return;
  }

  const forceExitTimer = setTimeout(() => process.exit(0), 2_000);
  forceExitTimer.unref?.();
  serverRef.close(() => {
    clearTimeout(forceExitTimer);
    process.exit(0);
  });
}

async function loadRuntimeState() {
  settings = normalizeSettings(await readJson(settingsPath, DEFAULT_SETTINGS));
  const loadedState = await readJson(statePath, {});
  state = {
    ...state,
    ...loadedState,
    serviceStartedAt: new Date().toISOString(),
    running: false,
    enabled: settings.enabled,
    hasSecret: await hasSecretFile(),
    updatedAt: new Date().toISOString(),
  };
  if (!state.nextRunAt && settings.enabled) {
    state.nextRunAt = new Date().toISOString();
  }
  await writeJsonAtomic(statePath, state);
}

async function logLine(level, message, details = {}) {
  const safeDetails = { ...details };
  delete safeDetails.managementKey;
  delete safeDetails.secret;
  delete safeDetails.authorization;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const logPath = path.join(sidecarLogsDir, `sidecar-${today}.log`);
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    message,
    ...safeDetails,
  });
  await writeFile(logPath, `${line}\n`, { encoding: 'utf8', flag: 'a' }).catch(() => {});
}

function runPwsh(script, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'pwsh.exe',
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
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `pwsh exited with ${code}`));
      }
    });
    child.stdin.end(input, 'utf8');
  });
}

async function protectSecret(secret) {
  const script = `
$ErrorActionPreference = "Stop"
$plain = [Console]::In.ReadToEnd()
$bytes = [System.Text.Encoding]::UTF8.GetBytes($plain)
$protected = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;
  return runPwsh(script, secret);
}

async function unprotectSecret(blob) {
  const script = `
$ErrorActionPreference = "Stop"
$blob = [Console]::In.ReadToEnd().Trim()
$bytes = [Convert]::FromBase64String($blob)
$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))
`;
  return runPwsh(script, blob);
}

async function saveSecret(secret) {
  const trimmed = String(secret ?? '').trim();
  if (!trimmed) throw new Error('Management key is empty');
  const blob = await protectSecret(trimmed);
  await writeFile(secretPath, `${blob}\n`, 'utf8');
  await updateState({ hasSecret: true, lastError: null });
}

async function readSecret() {
  const blob = await readFile(secretPath, 'utf8');
  return unprotectSecret(blob);
}

function extractBearer(req) {
  const authorization = String(req.headers.authorization ?? '').trim();
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (match?.[1]?.trim()) return match[1].trim();
  const headerKey = req.headers['x-cpamc-management-key'];
  return typeof headerKey === 'string' ? headerKey.trim() : '';
}

function isOriginAllowed(req) {
  const origin = String(req.headers.origin ?? '').trim();
  if (!origin) return true;
  return ALLOWED_ORIGINS.has(origin);
}

function applyCors(req, res) {
  const origin = String(req.headers.origin ?? '').trim();
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, X-CPAMC-Management-Key'
  );
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

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 60_000);
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
      const err = new Error(message);
      err.statusCode = response.status;
      err.data = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timeout);
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

async function managementJson(endpoint, key, options = {}) {
  const targetApiBase = options.apiBase ?? settings.apiBase;
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers ?? {}),
  };
  return fetchJson(managementUrl(targetApiBase, endpoint), {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    timeoutMs: options.timeoutMs,
  });
}

export async function validateManagementKey(key, apiBase = settings.apiBase) {
  await managementJson('/config', key, {
    apiBase,
    timeoutMs: 20_000,
  });
  return true;
}

async function validateControlKey(req, body = {}) {
  const key = extractBearer(req) || String(body.managementKey ?? '').trim();
  if (!key) throw new HttpError(401, 'Management key required');

  if (await hasSecretFile()) {
    const stored = await readSecret();
    if (stored !== key) throw new HttpError(403, 'Management key rejected');
    return key;
  }

  await validateManagementKey(key, body.apiBase ?? settings.apiBase);
  return key;
}

function normalizeAuthFilesResponse(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const files = Array.isArray(payload.files)
    ? payload.files
    : Array.isArray(payload.items)
      ? payload.items
      : [];
  return files.filter((item) => item && typeof item === 'object');
}

function resolveAuthProvider(file) {
  return String(file.provider ?? file.type ?? '').trim().toLowerCase();
}

function isCodexFile(file) {
  return resolveAuthProvider(file) === 'codex';
}

function isRuntimeOnlyAuthFile(file) {
  const raw = file.runtime_only ?? file.runtimeOnly;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

function isDisabledAuthFile(file) {
  const raw = file.disabled;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  if (typeof raw === 'string') return raw.trim().toLowerCase() === 'true';
  return false;
}

function parsePriorityValue(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || !INTEGER_STRING_PATTERN.test(trimmed)) return undefined;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function normalizeStringValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
  return null;
}

function normalizePlanType(value) {
  const normalized = normalizeStringValue(value);
  return normalized ? normalized.toLowerCase() : null;
}

function normalizeNumberValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function decodeBase64UrlPayload(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  try {
    const normalized = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

function parseIdTokenPayload(value) {
  if (!value) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Continue to JWT parsing.
  }
  const segments = trimmed.split('.');
  if (segments.length < 2) return null;
  const decoded = decodeBase64UrlPayload(segments[1]);
  if (!decoded) return null;
  try {
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function resolveCodexChatgptAccountId(file) {
  const metadata = file.metadata && typeof file.metadata === 'object' ? file.metadata : null;
  const attributes = file.attributes && typeof file.attributes === 'object' ? file.attributes : null;
  const candidates = [file.id_token, metadata?.id_token, attributes?.id_token];
  for (const candidate of candidates) {
    const payload = parseIdTokenPayload(candidate);
    const id = normalizeStringValue(payload?.chatgpt_account_id ?? payload?.chatgptAccountId);
    if (id) return id;
  }
  return null;
}

function resolveCodexPlanType(file) {
  const metadata = file.metadata && typeof file.metadata === 'object' ? file.metadata : null;
  const attributes = file.attributes && typeof file.attributes === 'object' ? file.attributes : null;
  const idToken = file.id_token && typeof file.id_token === 'object' ? file.id_token : null;
  const metadataIdToken =
    metadata?.id_token && typeof metadata.id_token === 'object' ? metadata.id_token : null;
  const candidates = [
    file.plan_type,
    file.planType,
    file.id_token,
    idToken?.plan_type,
    idToken?.planType,
    metadata?.plan_type,
    metadata?.planType,
    metadata?.id_token,
    metadataIdToken?.plan_type,
    metadataIdToken?.planType,
    attributes?.plan_type,
    attributes?.planType,
    attributes?.id_token,
  ];
  for (const candidate of candidates) {
    const planType = normalizePlanType(candidate);
    if (planType) return planType;
  }
  return null;
}

function normalizeAuthIndex(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toString();
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  return null;
}

function getDisplayName(file) {
  const note = typeof file.note === 'string' ? file.note.trim() : '';
  return note || file.name;
}

function buildCandidateDetail({
  file,
  priority = null,
  planType = null,
  remainingPercent = null,
  tier = 'other',
  belowThreshold = null,
  decision = 'keep',
}) {
  return {
    name: String(file?.name ?? ''),
    displayName: getDisplayName(file),
    priority,
    planType,
    remainingPercent,
    tier,
    isActive: tier === 'active',
    isStandby: tier === 'standby',
    isBuffer: tier === 'buffer',
    isManualLocked: tier === 'manual_locked',
    belowThreshold,
    decision,
  };
}

function stripCandidateOrder(candidate) {
  const { order: _order, ...rest } = candidate;
  return rest;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

function getCodexFiveHourRemainingPercent(quota) {
  if (!quota || quota.status !== 'success') return null;
  const fiveHourWindow = (quota.windows ?? []).find((window) => window.id === 'five-hour');
  const used = fiveHourWindow?.usedPercent;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  return clampPercent(100 - used);
}

function buildEmptyAnalysis(
  thresholdPercent,
  activeSlotLimit,
  status,
  unknownCount = 0,
  candidates = []
) {
  return {
    thresholdPercent,
    effectiveThresholdPercent: thresholdPercent,
    thresholdAdjusted: false,
    activeSlotLimit,
    status,
    managedCount: 0,
    unknownCount,
    activePriority: PRIORITY_ROTATION_ACTIVE_PRIORITY,
    standbyPriority: PRIORITY_ROTATION_STANDBY_PRIORITY,
    reservePriority: PRIORITY_ROTATION_BUFFER_PRIORITY,
    activeCount: 0,
    healthyActiveCount: 0,
    standbyCount: 0,
    healthyStandbyCount: 0,
    projectedActiveCount: 0,
    candidates,
    changes: [],
  };
}

export function analyzeCodexPriorityRotation(
  files,
  codexQuota,
  thresholdPercent,
  activeSlotLimit
) {
  const threshold = clampInteger(thresholdPercent, DEFAULT_SETTINGS.thresholdPercent, 0, 100);
  const slotLimit = clampInteger(activeSlotLimit, DEFAULT_SETTINGS.activeSlotLimit, 1, 99);
  const candidates = [];
  const skippedCandidates = [];
  let unknownCount = 0;

  files.forEach((file, order) => {
    if (!isCodexFile(file)) return;

    const priority = parsePriorityValue(file.priority) ?? 0;
    const filePlanType = normalizePlanType(resolveCodexPlanType(file));
    const addSkippedCandidate = (decision, values = {}) => {
      skippedCandidates.push({
        order,
        ...buildCandidateDetail({
          file,
          priority,
          planType: filePlanType,
          tier: 'other',
          belowThreshold: null,
          decision,
          ...values,
        }),
      });
    };

    if (isDisabledAuthFile(file)) {
      addSkippedCandidate('skipped_disabled');
      return;
    }

    if (isRuntimeOnlyAuthFile(file)) {
      addSkippedCandidate('skipped_runtime_only');
      return;
    }

    if (priority === PRIORITY_ROTATION_BUFFER_PRIORITY) {
      addSkippedCandidate('observe_buffer', {
        tier: 'buffer',
        belowThreshold: null,
      });
      return;
    }

    if (priority >= PRIORITY_ROTATION_MANUAL_LOCKED_MIN_PRIORITY) {
      addSkippedCandidate('manual_locked', {
        tier: 'manual_locked',
        belowThreshold: null,
      });
      return;
    }

    if (
      priority !== PRIORITY_ROTATION_ACTIVE_PRIORITY &&
      priority !== PRIORITY_ROTATION_STANDBY_PRIORITY
    ) {
      addSkippedCandidate('skipped_unmanaged_priority', {
        belowThreshold: null,
      });
      return;
    }

    const quota = codexQuota[file.name];
    const planType = normalizePlanType(quota?.planType ?? resolveCodexPlanType(file));
    const remainingPercent = getCodexFiveHourRemainingPercent(quota);
    if (planType !== null && !MANAGED_CODEX_PLANS.has(planType)) {
      if (priority === PRIORITY_ROTATION_ACTIVE_PRIORITY) {
        candidates.push({
          order,
          file,
          priority,
          planType,
          remainingPercent: null,
          managed: false,
        });
        return;
      }
      addSkippedCandidate('skipped_plan', {
        planType,
        remainingPercent,
      });
      return;
    }

    if (planType === null || remainingPercent === null) {
      unknownCount += 1;
      if (priority === PRIORITY_ROTATION_ACTIVE_PRIORITY) {
        candidates.push({
          order,
          file,
          priority,
          planType,
          remainingPercent: null,
          managed: false,
        });
        return;
      }
      addSkippedCandidate('quota_unknown', {
        planType,
        remainingPercent,
        belowThreshold: remainingPercent === null ? null : remainingPercent < threshold,
      });
      return;
    }

    candidates.push({ order, file, priority, planType, remainingPercent, managed: true });
  });

  if (candidates.length === 0) {
    return buildEmptyAnalysis(
      threshold,
      slotLimit,
      unknownCount > 0 ? 'quota_unknown' : 'no_changes',
      unknownCount,
      skippedCandidates.sort((a, b) => a.order - b.order).map(stripCandidateOrder)
    );
  }

  const activePriority = PRIORITY_ROTATION_ACTIVE_PRIORITY;
  const standbyPriority = PRIORITY_ROTATION_STANDBY_PRIORITY;
  const reservePriority = PRIORITY_ROTATION_BUFFER_PRIORITY;
  const activeCandidates = candidates.filter((candidate) => candidate.priority === activePriority);
  const standbyCandidates = candidates.filter(
    (candidate) => candidate.priority === standbyPriority
  );
  const effectiveThreshold = threshold;
  const thresholdAdjusted = false;
  const managedCandidates = candidates.filter((candidate) => candidate.managed !== false);
  const getRemainingSortValue = (candidate) =>
    typeof candidate.remainingPercent === 'number' && Number.isFinite(candidate.remainingPercent)
      ? candidate.remainingPercent
      : -1;
  const healthyActiveCandidates = activeCandidates.filter(
    (candidate) => candidate.managed !== false && getRemainingSortValue(candidate) >= effectiveThreshold
  );
  const healthyStandbyCandidates = standbyCandidates.filter(
    (candidate) => candidate.managed !== false && getRemainingSortValue(candidate) >= effectiveThreshold
  );

  const demotionMap = new Map();
  activeCandidates.forEach((candidate) => {
    if (
      candidate.managed !== false &&
      getRemainingSortValue(candidate) < effectiveThreshold
    ) {
      demotionMap.set(candidate.file.name, 'low_remaining');
    }
  });

  let projectedActiveCount = activeCandidates.length - demotionMap.size;
  if (projectedActiveCount > slotLimit) {
    activeCandidates
      .filter((candidate) => !demotionMap.has(candidate.file.name))
      .sort((a, b) => {
        const remainingCompare = getRemainingSortValue(a) - getRemainingSortValue(b);
        return remainingCompare !== 0
          ? remainingCompare
          : a.file.name.localeCompare(b.file.name);
      })
      .some((candidate) => {
        if (projectedActiveCount <= slotLimit) return true;
        demotionMap.set(candidate.file.name, 'over_active_limit');
        projectedActiveCount -= 1;
        return false;
      });
  }

  const demotions = activeCandidates
    .filter((candidate) => demotionMap.has(candidate.file.name))
    .sort((a, b) => {
      const remainingCompare = getRemainingSortValue(a) - getRemainingSortValue(b);
      return remainingCompare !== 0 ? remainingCompare : a.file.name.localeCompare(b.file.name);
    })
    .map((candidate) => ({
      name: candidate.file.name,
      displayName: getDisplayName(candidate.file),
      fromPriority: activePriority,
      toPriority: standbyPriority,
      remainingPercent: Math.max(0, getRemainingSortValue(candidate)),
      role: 'demote',
      reason: demotionMap.get(candidate.file.name) ?? 'low_remaining',
    }));

  const activeDeficit = Math.max(0, slotLimit - projectedActiveCount);
  const lowRemainingDemotionCount = Array.from(demotionMap.values()).filter(
    (reason) => reason === 'low_remaining'
  ).length;
  const replacementSlots = Math.min(lowRemainingDemotionCount, activeDeficit);
  const fillSlots = Math.min(activeDeficit, healthyStandbyCandidates.length);
  const promotionSlots = Math.max(replacementSlots, fillSlots);
  const promotions = healthyStandbyCandidates
    .sort((a, b) => {
      const remainingCompare = getRemainingSortValue(b) - getRemainingSortValue(a);
      return remainingCompare !== 0 ? remainingCompare : a.file.name.localeCompare(b.file.name);
    })
    .slice(0, promotionSlots)
    .map((candidate) => ({
      name: candidate.file.name,
      displayName: getDisplayName(candidate.file),
      fromPriority: standbyPriority,
      toPriority: activePriority,
      remainingPercent: Math.max(0, getRemainingSortValue(candidate)),
      role: 'promote',
      reason: 'promote_standby',
    }));
  const changes = [...demotions, ...promotions];
  const promotionNames = new Set(promotions.map((change) => change.name));
  const analysisCandidates = [
    ...skippedCandidates,
    ...candidates.map((candidate) => {
      const isActive = candidate.priority === activePriority;
      const isStandby = candidate.priority === standbyPriority;
      const tier = isActive
        ? 'active'
        : isStandby
          ? 'standby'
          : candidate.priority === reservePriority
            ? 'buffer'
            : 'other';
      const demotionReason = demotionMap.get(candidate.file.name);
      const decision =
        demotionReason === 'low_remaining'
          ? 'demote_low_remaining'
          : demotionReason === 'over_active_limit'
            ? 'demote_over_active_limit'
            : promotionNames.has(candidate.file.name)
              ? 'promote_standby'
              : 'keep';
      return {
        order: candidate.order,
        ...buildCandidateDetail({
          file: candidate.file,
          priority: candidate.priority,
          planType: candidate.planType,
          remainingPercent: candidate.remainingPercent,
          tier,
          belowThreshold:
            typeof candidate.remainingPercent === 'number'
              ? candidate.remainingPercent < threshold
              : null,
          decision,
        }),
      };
    }),
  ]
    .sort((a, b) => a.order - b.order)
    .map(stripCandidateOrder);

  if (changes.length === 0) {
    const missingAdjacentStandby = activeDeficit > 0 && healthyStandbyCandidates.length === 0;
    const missingReplacementStandby =
      lowRemainingDemotionCount > 0 && healthyStandbyCandidates.length === 0;
    const status =
      unknownCount > 0 && managedCandidates.length === 0
        ? 'quota_unknown'
        : missingAdjacentStandby || missingReplacementStandby
          ? 'no_standby'
          : 'no_changes';
    return {
      thresholdPercent: threshold,
      effectiveThresholdPercent: effectiveThreshold,
      thresholdAdjusted,
      activeSlotLimit: slotLimit,
      status,
      managedCount: managedCandidates.length,
      unknownCount,
      activePriority,
      standbyPriority,
      reservePriority,
      activeCount: activeCandidates.length,
      healthyActiveCount: healthyActiveCandidates.length,
      standbyCount: standbyCandidates.length,
      healthyStandbyCount: healthyStandbyCandidates.length,
      projectedActiveCount: activeCandidates.length,
      candidates: analysisCandidates,
      changes: [],
    };
  }

  return {
    thresholdPercent: threshold,
    effectiveThresholdPercent: effectiveThreshold,
    thresholdAdjusted,
    activeSlotLimit: slotLimit,
    status: 'ready',
    managedCount: managedCandidates.length,
    unknownCount,
    activePriority,
    standbyPriority,
    reservePriority,
    activeCount: activeCandidates.length,
    healthyActiveCount: healthyActiveCandidates.length,
    standbyCount: standbyCandidates.length,
    healthyStandbyCount: healthyStandbyCandidates.length,
    projectedActiveCount: projectedActiveCount + promotions.length,
    candidates: analysisCandidates,
    changes,
  };
}

function pickClassifiedWindows(limitInfo, options = {}) {
  const allowOrderFallback = options.allowOrderFallback ?? true;
  const primaryWindow = limitInfo?.primary_window ?? limitInfo?.primaryWindow ?? null;
  const secondaryWindow = limitInfo?.secondary_window ?? limitInfo?.secondaryWindow ?? null;
  const rawWindows = [primaryWindow, secondaryWindow];
  let fiveHourWindow = null;
  let weeklyWindow = null;

  for (const window of rawWindows) {
    if (!window) continue;
    const seconds = normalizeNumberValue(window.limit_window_seconds ?? window.limitWindowSeconds);
    if (seconds === FIVE_HOUR_SECONDS && !fiveHourWindow) {
      fiveHourWindow = window;
    } else if (seconds === WEEK_SECONDS && !weeklyWindow) {
      weeklyWindow = window;
    }
  }

  if (allowOrderFallback) {
    if (!fiveHourWindow) fiveHourWindow = primaryWindow && primaryWindow !== weeklyWindow ? primaryWindow : null;
    if (!weeklyWindow) weeklyWindow = secondaryWindow && secondaryWindow !== fiveHourWindow ? secondaryWindow : null;
  }

  return { fiveHourWindow, weeklyWindow };
}

function buildCodexQuotaWindows(payload) {
  const rateLimit = payload.rate_limit ?? payload.rateLimit ?? undefined;
  const rawLimitReached = rateLimit?.limit_reached ?? rateLimit?.limitReached;
  const rawAllowed = rateLimit?.allowed;
  const rateWindows = pickClassifiedWindows(rateLimit);
  const windows = [];
  const addWindow = (id, window, limitReached, allowed) => {
    if (!window) return;
    const usedPercentRaw = normalizeNumberValue(window.used_percent ?? window.usedPercent);
    const usedPercent = usedPercentRaw ?? (Boolean(limitReached) || allowed === false ? 100 : null);
    windows.push({ id, usedPercent });
  };
  addWindow('five-hour', rateWindows.fiveHourWindow, rawLimitReached, rawAllowed);
  addWindow('weekly', rateWindows.weeklyWindow, rawLimitReached, rawAllowed);
  return windows;
}

async function fetchCodexQuotaState(file, key) {
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  if (!authIndex) {
    return { status: 'error', windows: [], error: 'missing_auth_index' };
  }

  const requestHeader = {
    Authorization: 'Bearer $TOKEN$',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    'User-Agent': 'codex_cli_rs/0.76.0 (Debian 13.0.0; x86_64) WindowsTerminal',
  };
  const accountId = resolveCodexChatgptAccountId(file);
  if (accountId) requestHeader['Chatgpt-Account-Id'] = accountId;
  const usageUrl = new URL(CODEX_USAGE_URL);
  usageUrl.searchParams.set('_cpamc_ts', Date.now().toString());

  const result = await managementJson('/api-call', key, {
    method: 'POST',
    timeoutMs: 60_000,
    body: {
      authIndex,
      method: 'GET',
      url: usageUrl.toString(),
      header: requestHeader,
    },
  });

  const statusCode = Number(result?.status_code ?? result?.statusCode ?? 0);
  if (statusCode < 200 || statusCode >= 300) {
    return {
      status: 'error',
      windows: [],
      error: `quota_http_${statusCode || 'unknown'}`,
      errorStatus: statusCode,
    };
  }

  const body = result?.body;
  const payload =
    typeof body === 'string'
      ? JSON.parse(body)
      : body && typeof body === 'object'
        ? body
        : null;
  if (!payload) {
    return { status: 'error', windows: [], error: 'empty_quota_payload' };
  }

  return {
    status: 'success',
    planType: normalizePlanType(payload.plan_type ?? payload.planType ?? resolveCodexPlanType(file)),
    windows: buildCodexQuotaWindows(payload),
  };
}

async function buildCodexQuotaMap(files, key) {
  const quota = {};
  for (const file of files) {
    if (!isCodexFile(file) || isDisabledAuthFile(file) || isRuntimeOnlyAuthFile(file)) continue;
    const planTypeFromFile = resolveCodexPlanType(file);
    if (planTypeFromFile !== null && !MANAGED_CODEX_PLANS.has(planTypeFromFile)) continue;
    try {
      quota[file.name] = await fetchCodexQuotaState(file, key);
    } catch (error) {
      quota[file.name] = {
        status: 'error',
        windows: [],
        planType: planTypeFromFile,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
  return quota;
}

function summarizeAnalysis(analysis) {
  return {
    thresholdPercent: analysis.thresholdPercent,
    effectiveThresholdPercent: analysis.effectiveThresholdPercent,
    thresholdAdjusted: analysis.thresholdAdjusted,
    activeSlotLimit: analysis.activeSlotLimit,
    status: analysis.status,
    managedCount: analysis.managedCount,
    unknownCount: analysis.unknownCount,
    activePriority: analysis.activePriority,
    standbyPriority: analysis.standbyPriority,
    reservePriority: analysis.reservePriority,
    activeCount: analysis.activeCount,
    standbyCount: analysis.standbyCount,
    projectedActiveCount: analysis.projectedActiveCount,
    candidates: (analysis.candidates ?? []).map((candidate) => ({
      name: candidate.name,
      displayName: candidate.displayName,
      priority: candidate.priority,
      planType: candidate.planType,
      remainingPercent: candidate.remainingPercent,
      tier: candidate.tier,
      isActive: candidate.isActive,
      isStandby: candidate.isStandby,
      belowThreshold: candidate.belowThreshold,
      decision: candidate.decision,
    })),
    changes: analysis.changes.map((change) => ({
      name: change.name,
      displayName: change.displayName,
      fromPriority: change.fromPriority,
      toPriority: change.toPriority,
      remainingPercent: change.remainingPercent,
      role: change.role,
      reason: change.reason,
    })),
  };
}

function summarizeCandidateDecisions(candidates = []) {
  const decisions = {};
  let activeBelowThresholdCount = 0;
  for (const candidate of candidates) {
    const key = String(candidate.decision ?? 'unknown');
    decisions[key] = (decisions[key] ?? 0) + 1;
    if (candidate.isActive && candidate.belowThreshold === true) {
      activeBelowThresholdCount += 1;
    }
  }
  return {
    total: candidates.length,
    activeBelowThresholdCount,
    decisions,
  };
}

function nextRunIso() {
  return new Date(Date.now() + settings.checkIntervalMinutes * 60_000).toISOString();
}

export async function runPriorityRotation(options = {}) {
  if (runInFlight) return runInFlight;

  runInFlight = (async () => {
    const manual = options.manual === true;
    const dryRun = options.dryRun === true;
    const startedAt = new Date().toISOString();
    await updateState({
      running: true,
      lastStatus: 'running',
      lastRunStartedAt: startedAt,
      lastError: null,
      lastSkippedReason: null,
    });

    try {
      if (!settings.enabled && !manual) {
        await updateState({
          running: false,
          lastStatus: 'skipped',
          lastSkippedReason: 'disabled',
          lastCompletedAt: new Date().toISOString(),
          nextRunAt: nextRunIso(),
        });
        return sanitizeStateForResponse();
      }

      if (!(await hasSecretFile())) {
        await updateState({
          running: false,
          lastStatus: 'skipped',
          lastSkippedReason: 'missing_secret',
          lastCompletedAt: new Date().toISOString(),
          nextRunAt: nextRunIso(),
        });
        return sanitizeStateForResponse();
      }

      const key = await readSecret();
      const listPayload = await managementJson('/auth-files', key, { timeoutMs: 30_000 });
      const files = normalizeAuthFilesResponse(listPayload).map((file) => ({ ...file }));
      const codexQuota = await buildCodexQuotaMap(files, key);
      let analysis = analyzeCodexPriorityRotation(
        files,
        codexQuota,
        settings.thresholdPercent,
        settings.activeSlotLimit
      );
      let successCount = 0;
      let failCount = 0;
      const successfulChanges = [];
      let passCount = 0;
      if (analysis.changes.length > 0 && !dryRun) {
        while (analysis.changes.length > 0 && passCount < MAX_ROTATION_PASSES) {
          passCount += 1;
          let passSuccessCount = 0;
          for (const change of analysis.changes) {
            try {
              await managementJson('/auth-files/fields', key, {
                method: 'PATCH',
                timeoutMs: 30_000,
                body: { name: change.name, priority: change.toPriority },
              });
              successCount += 1;
              passSuccessCount += 1;
              successfulChanges.push(change);
              const file = files.find((item) => item.name === change.name);
              if (file) {
                file.priority = change.toPriority;
              }
            } catch (error) {
              failCount += 1;
              await logLine('warn', 'priority patch failed', {
                name: change.name,
                message: error instanceof Error ? error.message : String(error),
              });
            }
          }
          if (passSuccessCount === 0) break;
          analysis = analyzeCodexPriorityRotation(
            files,
            codexQuota,
            settings.thresholdPercent,
            settings.activeSlotLimit
          );
        }
      }

      const finalStatus =
        dryRun && analysis.changes.length > 0
          ? 'dry_run_ready'
          : failCount > 0 && successCount > 0
            ? 'partial'
            : failCount > 0
              ? 'failed'
              : successCount > 0
                ? 'applied'
                : analysis.status;
      const completedAt = new Date().toISOString();
      const mutationPatch =
        successCount > 0
          ? {
              lastMutationAt: completedAt,
              lastMutationAppliedChangeCount: successCount,
              lastMutationChanges: successfulChanges.map((change) => ({
                name: change.name,
                displayName: change.displayName,
                fromPriority: change.fromPriority,
                toPriority: change.toPriority,
                remainingPercent: change.remainingPercent,
                role: change.role,
                reason: change.reason,
              })),
            }
          : {};

      await updateState({
        running: false,
        lastStatus: finalStatus,
        lastSkippedReason:
          successCount > 0 ? null : analysis.changes.length === 0 ? analysis.status : null,
        lastCompletedAt: completedAt,
        lastAppliedChangeCount: successCount,
        lastFailedChangeCount: failCount,
        nextRunAt: nextRunIso(),
        lastAnalysis: summarizeAnalysis(analysis),
        ...mutationPatch,
      });
      await logLine('info', 'priority rotation completed', {
        status: finalStatus,
        changes: successfulChanges.length || analysis.changes.length,
        successCount,
        failCount,
        passCount,
        dryRun,
        manual,
        candidates: summarizeCandidateDecisions(analysis.candidates),
      });
      return sanitizeStateForResponse();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateState({
        running: false,
        lastStatus: 'error',
        lastError: message.slice(0, 500),
        lastCompletedAt: new Date().toISOString(),
        nextRunAt: nextRunIso(),
      });
      await logLine('error', 'priority rotation failed', { message: message.slice(0, 500) });
      return sanitizeStateForResponse();
    } finally {
      runInFlight = null;
    }
  })();

  return runInFlight;
}

async function persistSettings(updates) {
  const expectedRevision = Number(updates?.revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision !== settings.revision) {
    throw new HttpError(409, 'Settings revision mismatch; refresh the page and try again');
  }
  settings = normalizeSettings({ ...settings, ...updates, revision: settings.revision + 1 });
  await writeJsonAtomic(settingsPath, settings);
  if (!state.nextRunAt || updates.checkIntervalMinutes !== undefined || updates.enabled !== undefined) {
    state.nextRunAt = settings.enabled ? new Date().toISOString() : null;
  }
  await updateState({ enabled: settings.enabled, nextRunAt: state.nextRunAt });
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

  const url = new URL(req.url ?? '/', `http://${host}:${port}`);
  await refreshModelRequestActivity();
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/status')) {
    sendJson(req, res, 200, {
      ok: true,
      pid: process.pid,
      host,
      port,
      customUiDir,
      modelRequestLogsDir,
      idleShutdownMinutes,
      idleShutdownAt: getIdleShutdownAtIso(),
      settings: sanitizeSettingsForResponse(),
      state: sanitizeStateForResponse(),
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/settings') {
    sendJson(req, res, 200, {
      settings: sanitizeSettingsForResponse(),
      hasSecret: await hasSecretFile(),
      modelRequestLogsDir,
      idleShutdownMinutes,
      idleShutdownAt: getIdleShutdownAtIso(),
    });
    return;
  }

  const body = await readBody(req);
  if (req.method === 'PUT' && url.pathname === '/settings') {
    await validateControlKey(req, body);
    await persistSettings(body.settings ?? body);
    sendJson(req, res, 200, {
      settings: sanitizeSettingsForResponse(),
      state: sanitizeStateForResponse(),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/secret') {
    const key = String(body.managementKey ?? '').trim();
    if (!key) throw new HttpError(400, 'Management key is empty');
    const apiBase = normalizeApiBase(body.apiBase ?? settings.apiBase);
    await validateManagementKey(key, apiBase);
    await saveSecret(key);
    sendJson(req, res, 200, {
      saved: true,
      settings: sanitizeSettingsForResponse(),
      state: sanitizeStateForResponse(),
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/run-now') {
    await validateControlKey(req, body);
    const runState = await runPriorityRotation({ manual: true, dryRun: body.dryRun === true });
    sendJson(req, res, 200, {
      state: runState,
      settings: sanitizeSettingsForResponse(),
    });
    return;
  }

  throw new HttpError(404, 'Not found');
}

function startLoop() {
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = setInterval(() => {
    if (!settings.enabled || runInFlight) return;
    const nextRunAt = state.nextRunAt ? Date.parse(state.nextRunAt) : 0;
    if (!Number.isFinite(nextRunAt) || Date.now() < nextRunAt) return;
    runPriorityRotation().catch(() => {});
  }, 15_000);
  loopTimer.unref?.();
}

async function startServer() {
  await ensureDataDirs();
  await loadRuntimeState();
  lastModelRequestAt = Date.now();
  await refreshModelRequestActivity({ force: true });
  scheduleIdleShutdown();
  startLoop();

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error) => sendError(req, res, error));
  });
  serverRef = server;
  server.listen(port, host, async () => {
    await logLine('info', 'priority rotation sidecar started', {
      host,
      port,
      installDir,
      dataDir,
      customUiDir,
      modelRequestLogsDir,
      idleShutdownMinutes,
    });
  });
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  startServer().catch(async (error) => {
    await ensureDataDirs().catch(() => {});
    await logLine('error', 'sidecar startup failed', {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}
