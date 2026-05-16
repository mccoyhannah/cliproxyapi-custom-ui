#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

const VERSION = 1;
const DEFAULT_INSTALL_DIR = 'D:\\CLIProxyAPI';
const LOG_FILE_PATTERN =
  /^v1-(responses|chat-completions|messages)-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})-([A-Za-z0-9_-]+)\.log$/;
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const EMBEDDED_LEDGER_ID = 'cpamc-token-ledger';

const emptyTokenUsage = (status) => ({
  input: 0,
  output: 0,
  cached: 0,
  reasoning: 0,
  total: 0,
  status,
});

const parseArgs = (argv) => {
  const result = {
    dryRun: false,
    rebuild: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      result.dryRun = true;
      continue;
    }
    if (arg === '--rebuild') {
      result.rebuild = true;
      continue;
    }
    if (arg === '--help') {
      result.help = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;

    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      result[key] = next;
      index += 1;
    } else {
      result[key] = true;
    }
  }

  return result;
};

const readJson = async (filePath) => {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const atomicWriteJson = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tempPath, filePath);
};

const atomicWriteText = async (filePath, value) => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, value, 'utf8');
  await fs.rename(tempPath, filePath);
};

const pathExists = async (filePath) => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const escapeJsonForHtml = (value) => JSON.stringify(value).replace(/</g, '\\u003c');

const buildEmbeddedLedgerScript = (projection) =>
  `<script id="${EMBEDDED_LEDGER_ID}" type="application/json">${escapeJsonForHtml(projection)}</script>`;

const embedLedgerInHtml = async (htmlPath, projection) => {
  if (!(await pathExists(htmlPath))) return false;

  const html = await fs.readFile(htmlPath, 'utf8');
  const script = buildEmbeddedLedgerScript(projection);
  const existingPattern = new RegExp(
    `\\s*<script[^>]*id=["']${EMBEDDED_LEDGER_ID}["'][^>]*>[\\s\\S]*?<\\/script>`,
    'i'
  );

  let nextHtml;
  if (existingPattern.test(html)) {
    nextHtml = html.replace(existingPattern, `\n${script}`);
  } else if (/<\/body>/i.test(html)) {
    nextHtml = html.replace(/<\/body>/i, `\n${script}\n</body>`);
  } else {
    nextHtml = `${html}\n${script}\n`;
  }

  if (nextHtml === html) return false;
  await atomicWriteText(htmlPath, nextHtml);
  return true;
};

const cleanModelValue = (value) => {
  if (!value) return null;
  const trimmed = String(value).trim().replace(/^["'`]+|["'`,;}\]]+$/g, '');
  return trimmed && trimmed !== '-' && trimmed !== 'null' ? trimmed : null;
};

const extractFirstModel = (raw, patterns) => {
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const value = cleanModelValue(match?.[1]);
    if (value) return value;
  }
  return null;
};

const extractConfiguredModel = (raw) =>
  extractFirstModel(raw, [
    /"configured[_-]?model"\s*:\s*"([^"]+)"/i,
    /"requested[_-]?model"\s*:\s*"([^"]+)"/i,
    /\b(?:configured|requested)\s+model\s*[:=]\s*([A-Za-z0-9._:/+-]+)/i,
    /"model"\s*:\s*"([^"]+)"/i,
    /\bmodel\s*[:=]\s*([A-Za-z0-9._:/+-]+)/i,
  ]);

const extractActualModel = (raw) =>
  extractFirstModel(raw, [
    /"actual[_-]?model"\s*:\s*"([^"]+)"/i,
    /"upstream[_-]?model"\s*:\s*"([^"]+)"/i,
    /"target[_-]?model"\s*:\s*"([^"]+)"/i,
    /\b(?:actual|upstream|routed|selected|target)\s+model\s*[:=]\s*([A-Za-z0-9._:/+-]+)/i,
    /\bmapped\s+(?:to|model)\s*[:=]?\s*([A-Za-z0-9._:/+-]+)/i,
    /"model"\s*:\s*"([^"]+)"/i,
  ]);

const numberValue = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, Math.floor(parsed));
  }
  return null;
};

const recordValue = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : null;

const firstNumber = (values) => {
  for (const value of values) {
    const parsed = numberValue(value);
    if (parsed !== null) return parsed;
  }
  return null;
};

const extractJsonObjectAt = (text, start) => {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }

  return null;
};

const extractUsageObjects = (text) => {
  const results = [];
  const usagePattern = /"usage"\s*:\s*\{/gi;
  let match;

  while ((match = usagePattern.exec(text)) !== null) {
    const objectStart = match.index + match[0].lastIndexOf('{');
    const rawObject = extractJsonObjectAt(text, objectStart);
    if (!rawObject) continue;

    try {
      const parsed = JSON.parse(rawObject);
      const record = recordValue(parsed);
      if (record) results.push(record);
    } catch {
      // Streaming fragments can be incomplete; keep searching later usage objects.
    }
  }

  return results;
};

const normalizeTokenUsage = (usage) => {
  const inputDetails = recordValue(usage.input_tokens_details) ?? recordValue(usage.prompt_tokens_details);
  const outputDetails =
    recordValue(usage.output_tokens_details) ?? recordValue(usage.completion_tokens_details);
  const input = firstNumber([usage.input_tokens, usage.prompt_tokens]) ?? 0;
  const output = firstNumber([usage.output_tokens, usage.completion_tokens]) ?? 0;
  const cached =
    firstNumber([
      usage.cached_tokens,
      usage.input_cached_tokens,
      inputDetails?.cached_tokens,
      inputDetails?.cache_read_input_tokens,
    ]) ?? 0;
  const reasoning =
    firstNumber([
      usage.reasoning_tokens,
      usage.output_reasoning_tokens,
      outputDetails?.reasoning_tokens,
    ]) ?? 0;
  const explicitTotal = firstNumber([usage.total_tokens]);
  const total = explicitTotal ?? input + output;

  return {
    input,
    output,
    cached,
    reasoning,
    total,
    status: total > 0 || input > 0 || output > 0 || cached > 0 || reasoning > 0 ? 'available' : 'unreported',
  };
};

const extractTokenUsage = (text) => {
  const candidates = extractUsageObjects(text).map(normalizeTokenUsage);
  const usable = candidates.filter((item) => item.status === 'available');
  return usable.length > 0 ? usable[usable.length - 1] : emptyTokenUsage('unreported');
};

const parseFilename = (fileName, stats) => {
  const match = fileName.match(LOG_FILE_PATTERN);
  if (!match) {
    return {
      fileType: 'unknown',
      timestampMs: Number.isFinite(stats.mtimeMs) ? Math.floor(stats.mtimeMs) : null,
      requestId: null,
    };
  }

  const [, fileType, year, month, day, hour, minute, second, requestId] = match;
  const timestampMs = new Date(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second)
  ).getTime();

  return {
    fileType,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : Math.floor(stats.mtimeMs),
    requestId,
  };
};

const readLogPreview = async (filePath, stats) => {
  const fileSize = stats.size;
  const headBytes = Math.min(HEAD_BYTES, fileSize);
  const tailBytes = Math.min(TAIL_BYTES, fileSize);

  if (fileSize <= headBytes + tailBytes) {
    const full = await fs.readFile(filePath, 'utf8');
    return { head: full, tail: full };
  }

  const handle = await fs.open(filePath, 'r');
  try {
    const headBuffer = Buffer.alloc(headBytes);
    const tailBuffer = Buffer.alloc(tailBytes);
    await handle.read(headBuffer, 0, headBytes, 0);
    await handle.read(tailBuffer, 0, tailBytes, fileSize - tailBytes);
    return {
      head: headBuffer.toString('utf8'),
      tail: tailBuffer.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
};

const parseLogFile = async (filePath, fileName, stats) => {
  const filenameInfo = parseFilename(fileName, stats);
  const { head, tail } = await readLogPreview(filePath, stats);
  const preview = head === tail ? head : `${head}\n${tail}`;
  const configuredModel = extractConfiguredModel(head) ?? extractConfiguredModel(tail);
  const actualModel = extractActualModel(tail) ?? extractActualModel(head);
  const tokenUsage = extractTokenUsage(preview);

  return {
    fileName,
    fileType: filenameInfo.fileType,
    timestampMs: filenameInfo.timestampMs,
    requestId: filenameInfo.requestId,
    detailStatus: configuredModel && actualModel ? 'ready' : 'missing-fields',
    configuredModel,
    actualModel,
    tokenUsage,
    fileSize: stats.size,
    lastModifiedMs: Math.floor(stats.mtimeMs),
  };
};

const errorEntry = (fileName, stats, error) => {
  const filenameInfo = parseFilename(fileName, stats);
  return {
    fileName,
    fileType: filenameInfo.fileType,
    timestampMs: filenameInfo.timestampMs,
    requestId: filenameInfo.requestId,
    detailStatus: 'error',
    configuredModel: null,
    actualModel: null,
    tokenUsage: emptyTokenUsage('error'),
    fileSize: stats.size,
    lastModifiedMs: Math.floor(stats.mtimeMs),
    error: error instanceof Error ? error.message : String(error),
  };
};

const listLogFiles = async (logsDir) => {
  const items = await fs.readdir(logsDir, { withFileTypes: true });
  return items
    .filter((item) => item.isFile() && LOG_FILE_PATTERN.test(item.name))
    .map((item) => item.name)
    .sort();
};

const calculateCoverage = (entries) => {
  const totalEntries = entries.length;
  const parsedEntries = entries.filter((entry) => entry.detailStatus !== 'error').length;
  const knownEntries = entries.filter((entry) => entry.tokenUsage?.status === 'available').length;
  const unreportedEntries = entries.filter((entry) => entry.tokenUsage?.status === 'unreported').length;
  const timestamps = entries
    .map((entry) => entry.timestampMs)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));

  return {
    totalEntries,
    parsedEntries,
    knownEntries,
    unreportedEntries,
    coverageRate: totalEntries > 0 ? (knownEntries / totalEntries) * 100 : 0,
    parsedRate: totalEntries > 0 ? (parsedEntries / totalEntries) * 100 : 0,
    earliestTimestampMs: timestamps.length > 0 ? Math.min(...timestamps) : null,
    latestTimestampMs: timestamps.length > 0 ? Math.max(...timestamps) : null,
  };
};

const buildProjection = ({ entries, generatedAt, logsDir, scannedFiles, updatedFiles, skippedFiles, errorFiles }) => ({
  version: VERSION,
  generatedAt,
  source: {
    logsDir,
    patterns: ['v1-responses-*.log', 'v1-chat-completions-*.log', 'v1-messages-*.log'],
    scannedFiles,
    updatedFiles,
    skippedFiles,
    errorFiles,
  },
  coverage: calculateCoverage(entries),
  entries,
});

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node scripts/update-token-ledger.mjs [--install-dir D:\\CLIProxyAPI] [--custom-ui-dir D:\\CLIProxyAPI_Maintenance\\custom-ui] [--rebuild] [--dry-run] [--no-embed]'
    );
    return;
  }

  const installDir = args['install-dir'] ?? DEFAULT_INSTALL_DIR;
  const logsDir = args['logs-dir'] ?? path.join(installDir, 'logs');
  const ledgerDir = args['ledger-dir'] ?? path.join(installDir, 'usage-backups', 'token-ledger');
  const staticDir = args['static-dir'] ?? path.join(installDir, 'static');
  const cwdLooksLikeCustomUi = await pathExists(path.join(process.cwd(), 'package.json'));
  const customUiDir = args['custom-ui-dir'] ?? (cwdLooksLikeCustomUi ? process.cwd() : null);
  const ledgerPath = args['ledger-path'] ?? path.join(ledgerDir, 'ledger.json');
  const projectionPath = args['projection-path'] ?? path.join(staticDir, 'token-ledger.json');
  const shouldEmbed = !args['no-embed'];

  await fs.mkdir(ledgerDir, { recursive: true });
  await fs.mkdir(staticDir, { recursive: true });

  const previous = (await readJson(ledgerPath)) ?? {};
  const previousEntries = Array.isArray(previous.entries) ? previous.entries : [];
  const entriesByFile = new Map(previousEntries.map((entry) => [entry.fileName, entry]));
  const fingerprints = { ...(previous.state?.fileFingerprints ?? {}) };

  const logFiles = await listLogFiles(logsDir);
  let updatedFiles = 0;
  let skippedFiles = 0;
  let errorFiles = 0;

  for (const fileName of logFiles) {
    const filePath = path.join(logsDir, fileName);
    const stats = await fs.stat(filePath);
    const fingerprint = `${stats.size}:${Math.floor(stats.mtimeMs)}`;

    if (!args.rebuild && fingerprints[fileName] === fingerprint && entriesByFile.has(fileName)) {
      skippedFiles += 1;
      continue;
    }

    try {
      const entry = await parseLogFile(filePath, fileName, stats);
      entriesByFile.set(fileName, entry);
      fingerprints[fileName] = fingerprint;
      updatedFiles += 1;
    } catch (error) {
      entriesByFile.set(fileName, errorEntry(fileName, stats, error));
      fingerprints[fileName] = fingerprint;
      errorFiles += 1;
    }
  }

  const entries = Array.from(entriesByFile.values()).sort((a, b) => {
    const left = b.timestampMs ?? 0;
    const right = a.timestampMs ?? 0;
    if (left !== right) return left - right;
    return a.fileName.localeCompare(b.fileName);
  });
  const generatedAt = new Date().toISOString();
  const projection = buildProjection({
    entries,
    generatedAt,
    logsDir,
    scannedFiles: logFiles.length,
    updatedFiles,
    skippedFiles,
    errorFiles,
  });
  const ledger = {
    ...projection,
    state: {
      fileFingerprints: fingerprints,
    },
  };

  const embeddedHtmlFiles = [];
  if (!args.dryRun) {
    await atomicWriteJson(ledgerPath, ledger);
    await atomicWriteJson(projectionPath, projection);

    if (shouldEmbed) {
      const htmlCandidates = [
        path.join(staticDir, 'management.html'),
        customUiDir ? path.join(customUiDir, 'dist', 'index.html') : null,
      ].filter(Boolean);

      for (const htmlPath of htmlCandidates) {
        if (await embedLedgerInHtml(htmlPath, projection)) {
          embeddedHtmlFiles.push(htmlPath);
        }
      }
    }
  }

  console.log(
    JSON.stringify(
      {
        status: args.dryRun ? 'dry-run' : 'completed',
        generatedAt,
        ledgerPath,
        projectionPath,
        embeddedHtmlFiles,
        scannedFiles: logFiles.length,
        updatedFiles,
        skippedFiles,
        errorFiles,
        coverage: projection.coverage,
      },
      null,
      2
    )
  );
};

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
