import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { classifyUpstreamStatusText } from './priority-rotation-sidecar.mjs';

const DEFAULT_LOGS_DIR = 'D:\\CLIProxyAPI\\logs';
const DEFAULT_LIMIT = 800;
const DEFAULT_SAMPLE_LIMIT = 20;

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

function toPositiveInteger(value, fallback) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric <= 0) return fallback;
  return numeric;
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function redactDiagnosticSignal(value) {
  return String(value ?? '')
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|credential|password|secret)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^"'\s,}]+/gi,
      '$1[redacted]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/([?&](?:key|api[_-]?key|access[_-]?token|refresh[_-]?token)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .slice(0, 240);
}

export async function scanResponseLog(filePath) {
  let statusCode = null;
  const errors = [];
  const events = [];
  let section = 'unknown';
  let hasStructuredSections = false;
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of lines) {
    const sectionMatch = /^===\s*(.+?)\s*===$/.exec(line);
    if (sectionMatch) {
      const sectionName = sectionMatch[1].trim().toUpperCase();
      hasStructuredSections = true;
      section = sectionName.includes('RESPONSE')
        ? 'response'
        : sectionName.includes('REQUEST')
          ? 'request'
          : 'other';
      continue;
    }

    if (hasStructuredSections && section !== 'response') continue;

    const statusMatch = /^Status:\s*(\d+)/.exec(line);
    if (statusMatch) {
      statusCode = Number(statusMatch[1]);
      continue;
    }

    const errorMatch = /^Error:\s*(.+)/.exec(line);
    if (errorMatch) {
      errors.push(errorMatch[1].trim());
      continue;
    }

    const eventMatch = /^event:\s*(response\.(?:failed|error|incomplete))/.exec(line);
    if (eventMatch) {
      events.push(eventMatch[1].trim());
    }
  }

  return { statusCode, errors, events };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const logsDir = args['logs-dir'] ?? DEFAULT_LOGS_DIR;
  const limit = toPositiveInteger(args.limit, DEFAULT_LIMIT);
  const sampleLimit = toPositiveInteger(args.samples, DEFAULT_SAMPLE_LIMIT);
  const json = args.json === true;
  const showSignals = args['show-signals'] === true;
  const sampleSignals = (signals) =>
    showSignals ? signals.slice(0, 3).map(redactDiagnosticSignal) : [];

  const entries = await readdir(logsDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/^v1-responses-.*\.log$/i.test(entry.name)) continue;
    const fullPath = path.join(logsDir, entry.name);
    files.push({ name: entry.name, fullPath });
  }

  files.sort((a, b) => b.name.localeCompare(a.name));
  const selectedFiles = files.slice(0, limit);
  const categoryCounts = new Map();
  const statusCounts = new Map();
  const samples = [];
  const uncategorized = [];
  const unknownSamples = [];
  let unknownCount = 0;

  for (const file of selectedFiles) {
    const result = await scanResponseLog(file.fullPath);
    const hasError =
      (Number.isFinite(result.statusCode) && result.statusCode >= 400) ||
      result.errors.length > 0 ||
      result.events.length > 0;
    if (!hasError) continue;

    if (Number.isFinite(result.statusCode)) {
      increment(statusCounts, String(result.statusCode));
    }

    const signals =
      result.errors.length > 0
        ? result.errors
        : result.events.length > 0
          ? result.events
          : [`Status: ${result.statusCode}`];
    const categories = new Set();
    for (const signal of signals) {
      const category = classifyUpstreamStatusText(signal, result.statusCode);
      if (category) {
        categories.add(category);
      }
    }
    if (categories.size === 0 && Number.isFinite(result.statusCode)) {
      const category = classifyUpstreamStatusText('', result.statusCode);
      if (category) categories.add(category);
    }

    const categoryList = [...categories];
    if (categoryList.includes('unknown_upstream_error')) {
      unknownCount += 1;
      if (unknownSamples.length < sampleLimit) {
        unknownSamples.push({
          file: file.name,
          status: result.statusCode,
          signals: sampleSignals(signals),
        });
      }
    }
    if (categoryList.length === 0) {
      if (uncategorized.length < sampleLimit) {
        uncategorized.push({
          file: file.name,
          status: result.statusCode,
          signals: sampleSignals(signals),
        });
      }
    } else {
      categoryList.forEach((category) => increment(categoryCounts, category));
    }

    if (samples.length < sampleLimit) {
      samples.push({
        file: file.name,
        status: result.statusCode,
        categories: categoryList,
        signals: sampleSignals(signals),
      });
    }
  }

  const output = {
    logsDir,
    filesScanned: selectedFiles.length,
    statusCounts: Object.fromEntries([...statusCounts.entries()].sort()),
    categoryCounts: Object.fromEntries(
      [...categoryCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    ),
    samples,
    uncategorized,
    unknownCount,
    unknownSamples,
  };

  if (json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  console.log(`Logs: ${logsDir}`);
  console.log(`Files scanned: ${output.filesScanned}`);
  console.log('Status counts:');
  Object.entries(output.statusCounts).forEach(([status, count]) => {
    console.log(`  ${status}: ${count}`);
  });
  console.log('Category counts:');
  Object.entries(output.categoryCounts).forEach(([category, count]) => {
    console.log(`  ${category}: ${count}`);
  });
  if (output.uncategorized.length > 0) {
    console.log('Uncategorized samples:');
    output.uncategorized.forEach((sample) => {
      console.log(`  ${sample.file} status=${sample.status} signal=${sample.signals[0] ?? ''}`);
    });
  }
  if (output.unknownSamples.length > 0) {
    console.log(`Unknown fallback count: ${output.unknownCount}`);
    console.log('Unknown fallback samples:');
    output.unknownSamples.forEach((sample) => {
      console.log(`  ${sample.file} status=${sample.status} signal=${sample.signals[0] ?? ''}`);
    });
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
