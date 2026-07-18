import { createReadStream } from 'node:fs';

const DEFAULT_HIGH_WATER_MARK = 256 * 1024;
const DEFAULT_MAX_ENTRY_CHARS = 256 * 1024;
const MAX_HEADER_CHARS = 1024 * 1024;
const ENTRY_SEPARATORS = ['},{', '},\n    {', '},\r\n    {'];
const ARRAY_END_SEPARATORS = ['}],', '}]}', '}\n  ],', '}\r\n  ],'];

const findEarliest = (text, patterns, offset) => {
  let selected = null;
  for (const pattern of patterns) {
    const index = text.indexOf(pattern, offset);
    if (index < 0) continue;
    if (!selected || index < selected.index) selected = { index, pattern };
  }
  return selected;
};

const extractStringField = (text, key) => {
  const match = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(text);
  return match?.[1] ?? null;
};

const extractNumberField = (text, key) => {
  const match = new RegExp(`"${key}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`).exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
};

export async function streamLedgerEntries(filePath, options = {}) {
  const highWaterMark = Math.max(1, Number(options.highWaterMark) || DEFAULT_HIGH_WATER_MARK);
  const maxEntryChars = Math.max(1024, Number(options.maxEntryChars) || DEFAULT_MAX_ENTRY_CHARS);
  const onEntry = typeof options.onEntry === 'function' ? options.onEntry : () => {};
  const stream = createReadStream(filePath, { encoding: 'utf8', highWaterMark });

  let phase = 'header';
  let header = '';
  let pending = '';
  let searchOffset = 0;
  let activeEntrySeparator = null;
  let entriesRead = 0;
  let parseErrors = 0;
  let bytesRead = 0;
  let done = false;

  const emitCandidate = (candidate) => {
    let entry;
    try {
      entry = JSON.parse(candidate);
    } catch {
      return false;
    }
    onEntry(entry);
    entriesRead += 1;
    return true;
  };

  const consumeEntries = (text) => {
    pending += text;

    while (true) {
      const separator = activeEntrySeparator
        ? {
            index: pending.indexOf(activeEntrySeparator, searchOffset),
            pattern: activeEntrySeparator,
          }
        : findEarliest(pending, ENTRY_SEPARATORS, searchOffset);
      if (separator && separator.index >= 0 && !activeEntrySeparator) {
        activeEntrySeparator = separator.pattern;
      }
      if (!separator) break;
      if (separator.index < 0) break;
      const candidate = pending.slice(0, separator.index + 1);
      if (emitCandidate(candidate)) {
        pending = pending.slice(separator.index + separator.pattern.length - 1);
        searchOffset = 0;
      } else {
        searchOffset = separator.index + separator.pattern.length;
      }
    }

    let arrayEnd = findEarliest(pending, ARRAY_END_SEPARATORS, searchOffset);
    while (arrayEnd) {
      const candidate = pending.slice(0, arrayEnd.index + 1);
      if (emitCandidate(candidate)) {
        pending = '';
        done = true;
        return;
      }
      searchOffset = arrayEnd.index + arrayEnd.pattern.length;
      arrayEnd = findEarliest(pending, ARRAY_END_SEPARATORS, searchOffset);
    }

    if (pending.length > maxEntryChars) {
      const nextSeparator = activeEntrySeparator
        ? {
            index: pending.indexOf(activeEntrySeparator, searchOffset),
            pattern: activeEntrySeparator,
          }
        : findEarliest(pending, ENTRY_SEPARATORS, searchOffset);
      if (nextSeparator && nextSeparator.index >= 0) {
        parseErrors += 1;
        pending = pending.slice(nextSeparator.index + nextSeparator.pattern.length - 1);
        searchOffset = 0;
      } else if (pending.length > maxEntryChars * 4) {
        throw new Error('ledger-entry-too-large');
      }
    }
  };

  for await (const chunk of stream) {
    bytesRead += Buffer.byteLength(chunk, 'utf8');
    if (phase === 'header') {
      header += chunk;
      if (header.length > MAX_HEADER_CHARS) throw new Error('ledger-entries-not-found');
      const match = /"entries"\s*:\s*\[/.exec(header);
      if (!match) continue;
      const entriesStart = match.index + match[0].length;
      const remainder = header.slice(entriesStart);
      header = header.slice(0, entriesStart);
      phase = 'entries';
      consumeEntries(remainder);
    } else {
      consumeEntries(chunk);
    }
    if (done) break;
  }

  if (phase !== 'entries') throw new Error('ledger-entries-not-found');
  if (!done && pending.trim()) {
    const cleaned = pending.trim().replace(/\]\s*[,}][\s\S]*$/, '');
    if (cleaned && !emitCandidate(cleaned)) parseErrors += 1;
  }

  return {
    version: extractNumberField(header, 'version'),
    generatedAt: extractStringField(header, 'generatedAt'),
    coverageStartMs: extractNumberField(header, 'earliestTimestampMs'),
    coverageEndMs: extractNumberField(header, 'latestTimestampMs'),
    entriesRead,
    parseErrors,
    bytesRead,
  };
}
