import { hash as cryptoHash } from 'node:crypto';

import MODEL_NAME_RULES from '../../src/features/usageStatistics/lib/modelNameRules.json' with { type: 'json' };

export const TOKEN_LOG_CORE_VERSION = '1.3.0';

export const LOG_FILE_PATTERN =
  /^v1-(responses|chat-completions|messages)-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})-([A-Za-z0-9_-]+)\.log$/;

const MODEL_VALUE_PATTERN = '[A-Za-z0-9._:/+-]+';
const BLOCKED_MODEL_WORDS = new Set(
  MODEL_NAME_RULES.blockedWords.map((item) => item.toLowerCase())
);
const VALID_MODEL_PATTERNS = MODEL_NAME_RULES.validModelPatterns.map(
  (pattern) => new RegExp(pattern, 'i')
);
const CONFIGURED_MODEL_KEYS = MODEL_NAME_RULES.configuredModelKeys;
const ACTUAL_MODEL_KEYS = MODEL_NAME_RULES.actualModelKeys;

const SECTION_MARKER_PATTERN = /^===\s*(.+?)\s*===\s*$/gm;

export const emptyTokenUsage = (status = 'unreported') => ({
  input: 0,
  output: 0,
  cached: 0,
  reasoning: 0,
  total: 0,
  status,
});

const recordValue = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? value : null;

const toTokenCount = (value) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

const firstTokenCount = (values) => {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const parsed = typeof value === 'number' ? value : Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return null;
};

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const normalizeModelName = (value) => {
  if (value === undefined || value === null || typeof value === 'boolean') return null;
  const trimmed = String(value)
    .trim()
    .replace(/^["'`]+|["'`,;}\]]+$/g, '');
  if (!trimmed || trimmed === '-' || /\s/.test(trimmed)) return null;
  if (BLOCKED_MODEL_WORDS.has(trimmed.toLowerCase())) return null;
  return VALID_MODEL_PATTERNS.some((pattern) => pattern.test(trimmed)) ? trimmed : null;
};

const buildJsonFieldPatterns = (keys) =>
  keys.map((key) => new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([^"]+)"`, 'gi'));

const CONFIGURED_JSON_PATTERNS = buildJsonFieldPatterns(CONFIGURED_MODEL_KEYS);
const ACTUAL_JSON_PATTERNS = buildJsonFieldPatterns(ACTUAL_MODEL_KEYS);
const CONFIGURED_TEXT_PATTERNS = [
  new RegExp(`\\b(?:configured|requested)\\s+model\\s*[:=]\\s*(${MODEL_VALUE_PATTERN})`, 'gi'),
];
const ACTUAL_TEXT_PATTERNS = [
  new RegExp(
    `\\b(?:actual|upstream|routed|selected|target|response)\\s+model\\s*[:=]\\s*(${MODEL_VALUE_PATTERN})`,
    'gi'
  ),
];

const extractLastModel = (raw, patterns) => {
  let selected = null;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      selected = normalizeModelName(match[1]) ?? selected;
    }
  }
  return selected;
};

const extractResponseEventModel = (raw) => {
  let completed = null;
  let completeResponse = null;
  let inProgress = null;
  let created = null;
  let cursor = 0;
  while (cursor < raw.length) {
    const start = raw.indexOf('{', cursor);
    if (start < 0) break;
    const jsonText = extractJsonObjectAt(raw, start);
    if (!jsonText) {
      cursor = start + 1;
      continue;
    }
    cursor = start + jsonText.length;
    try {
      const event = JSON.parse(jsonText);
      const eventModel = normalizeModelName(event.response?.model);
      if (event?.type === 'response.completed') completed = eventModel ?? completed;
      else if (event?.type === 'response.in_progress') inProgress = eventModel ?? inProgress;
      else if (event?.type === 'response.created') created = eventModel ?? created;
      else if (
        recordValue(event.usage) &&
        (event?.object === 'response' ||
          event?.object === 'chat.completion' ||
          event?.type === 'message')
      ) {
        completeResponse = normalizeModelName(event.model) ?? completeResponse;
      }
    } catch {
      // Fall back to the conservative text patterns below.
    }
  }
  return completed ?? completeResponse ?? inProgress ?? created;
};

export const extractConfiguredModel = (raw) =>
  extractLastModel(raw, [...CONFIGURED_JSON_PATTERNS, ...CONFIGURED_TEXT_PATTERNS]);

export const extractActualModel = (raw) =>
  extractResponseEventModel(raw) ??
  extractLastModel(raw, [...ACTUAL_JSON_PATTERNS, ...ACTUAL_TEXT_PATTERNS]);

function extractJsonObjectAt(text, start) {
  if (text[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

export const extractUsageObjects = (text) => {
  const results = [];
  const usagePattern = /"usage"\s*:\s*\{/gi;
  let match;
  let sawUsageField = false;

  while ((match = usagePattern.exec(text)) !== null) {
    sawUsageField = true;
    const objectStart = match.index + match[0].lastIndexOf('{');
    const rawObject = extractJsonObjectAt(text, objectStart);
    if (!rawObject) continue;
    try {
      const parsed = recordValue(JSON.parse(rawObject));
      if (parsed) results.push(parsed);
    } catch {
      // A later complete usage object may still be present in a streamed response.
    }
  }

  return { objects: results, sawUsageField };
};

export const normalizeTokenUsage = (usage) => {
  const inputDetails =
    recordValue(usage.input_tokens_details) ?? recordValue(usage.prompt_tokens_details);
  const outputDetails =
    recordValue(usage.output_tokens_details) ?? recordValue(usage.completion_tokens_details);
  const input = firstTokenCount([usage.input_tokens, usage.prompt_tokens]) ?? 0;
  const output = firstTokenCount([usage.output_tokens, usage.completion_tokens]) ?? 0;
  const cachedCandidate =
    firstTokenCount([
      usage.cached_tokens,
      usage.input_cached_tokens,
      inputDetails?.cached_tokens,
      inputDetails?.cache_read_input_tokens,
    ]) ?? 0;
  const reasoningCandidate =
    firstTokenCount([
      usage.reasoning_tokens,
      usage.output_reasoning_tokens,
      outputDetails?.reasoning_tokens,
    ]) ?? 0;
  const cached = Math.min(cachedCandidate, input);
  const reasoning = Math.min(reasoningCandidate, output);
  const explicitTotal = firstTokenCount([usage.total_tokens]);
  const total = explicitTotal ?? input + output;
  const hasUsage = total > 0 || input > 0 || output > 0 || cached > 0 || reasoning > 0;

  return {
    input,
    output,
    cached,
    reasoning,
    total: toTokenCount(total),
    status: hasUsage ? 'available' : 'unreported',
  };
};

export const extractTokenUsage = (text) => {
  const extracted = extractUsageObjects(text);
  const candidates = extracted.objects.map(normalizeTokenUsage);
  const usable = candidates.filter((item) => item.status === 'available');
  return {
    usage: usable.at(-1) ?? emptyTokenUsage('unreported'),
    parseError: extracted.sawUsageField && extracted.objects.length === 0,
  };
};

const classifySection = (rawName) => {
  const name = rawName.trim().toUpperCase();
  if (/^(?:END (?:API )?RESPONSE|(?:API )?RESPONSE END)$/.test(name)) return 'response-end';
  if (/^(?:API )?RESPONSE(?: \d+)?$/.test(name)) return 'response';
  if (/^(?:API )?REQUEST(?: BODY)?(?: \d+)?$/.test(name)) return 'request';
  return 'other';
};

export const parseLogSectionMarkerLine = (line) => {
  const match = String(line).match(/^===\s*(.+?)\s*===\s*$/);
  return match ? classifySection(match[1]) : null;
};

const listSectionMarkers = (text) => {
  const markers = [];
  SECTION_MARKER_PATTERN.lastIndex = 0;
  let match;
  while ((match = SECTION_MARKER_PATTERN.exec(text)) !== null) {
    markers.push({
      index: match.index,
      end: SECTION_MARKER_PATTERN.lastIndex,
      kind: parseLogSectionMarkerLine(match[0]),
    });
  }
  return markers;
};

const collectCompleteResponseSegments = (text, stable) => {
  const markers = listSectionMarkers(text);
  const segments = [];
  let pending = false;
  let explicitEnd = false;

  markers.forEach((marker, index) => {
    if (marker.kind === 'response-end') explicitEnd = true;
    if (marker.kind !== 'response') return;
    const next = markers[index + 1] ?? null;
    const complete = stable || next?.kind === 'response-end';
    if (!complete) {
      pending = true;
      return;
    }
    segments.push(text.slice(marker.end, next?.index ?? text.length));
  });

  return { markers, segments, pending, explicitEnd };
};

export const extractResponsePayload = ({
  fullText = null,
  headText = '',
  tailText = '',
  stable = false,
} = {}) => {
  if (typeof fullText === 'string') {
    const result = collectCompleteResponseSegments(fullText, stable);
    if (result.segments.length > 0 && !result.pending) {
      return {
        status: 'complete',
        text: result.segments.join('\n'),
        segments: result.segments,
        explicitEnd: result.explicitEnd,
      };
    }
    return {
      status: result.pending ? 'pending' : 'unsupported',
      text: '',
      segments: [],
      explicitEnd: result.explicitEnd,
    };
  }

  const head = collectCompleteResponseSegments(headText, false);
  const tail = collectCompleteResponseSegments(tailText, stable);
  const segments = [...head.segments, ...tail.segments];
  const lastHeadMarker = head.markers.at(-1);
  const firstTailMarker = tail.markers[0];
  const tailHasMarker = tail.markers.length > 0;
  const responseClosedInTail = firstTailMarker?.kind === 'response-end';

  if (lastHeadMarker?.kind === 'response' && (stable || responseClosedInTail)) {
    const responseHead = headText.slice(lastHeadMarker.end);
    const responseTail = tailHasMarker ? tailText.slice(0, tail.markers[0].index) : tailText;
    segments.push(`${responseHead}\n${responseTail}`);
  }

  if (segments.length > 0) {
    return {
      status: 'complete',
      text: segments.join('\n'),
      segments,
      explicitEnd: head.explicitEnd || tail.explicitEnd,
    };
  }

  const sawResponse = [...head.markers, ...tail.markers].some(
    (marker) => marker.kind === 'response'
  );
  return {
    status: sawResponse ? 'pending' : 'unsupported',
    text: '',
    segments: [],
    explicitEnd: head.explicitEnd || tail.explicitEnd,
  };
};

const sameUsage = (left, right) =>
  left.input === right.input &&
  left.output === right.output &&
  left.cached === right.cached &&
  left.reasoning === right.reasoning &&
  left.total === right.total;

export const parseExtractedResponsePayload = (response) => {
  if (response.status === 'pending') {
    return { status: 'pending', model: null, tokenUsage: emptyTokenUsage('pending') };
  }
  if (response.status === 'unsupported') {
    return { status: 'unsupported', model: null, tokenUsage: emptyTokenUsage('unsupported') };
  }

  const candidates = [];
  let sawParseError = false;
  for (const segment of response.segments ?? [response.text]) {
    const tokenResult = extractTokenUsage(segment);
    sawParseError ||= tokenResult.parseError;
    if (tokenResult.usage.status !== 'available') continue;
    candidates.push({
      model: extractActualModel(segment) ?? extractConfiguredModel(segment),
      tokenUsage: tokenResult.usage,
    });
  }

  if (sawParseError) {
    return { status: 'parse-error', model: null, tokenUsage: emptyTokenUsage('parse-error') };
  }

  if (candidates.length === 0) {
    return {
      status: 'unreported',
      model: extractActualModel(response.text) ?? extractConfiguredModel(response.text),
      tokenUsage: emptyTokenUsage('unreported'),
    };
  }

  let selected = candidates[0];
  for (const candidate of candidates.slice(1)) {
    const modelConflict =
      selected.model !== null && candidate.model !== null && selected.model !== candidate.model;
    if (!sameUsage(selected.tokenUsage, candidate.tokenUsage) || modelConflict) {
      return {
        status: 'ambiguous',
        model: candidate.model ?? selected.model,
        tokenUsage: emptyTokenUsage('ambiguous'),
      };
    }
    if (!selected.model && candidate.model) selected = candidate;
  }

  return {
    status: 'available',
    model: selected.model,
    tokenUsage: selected.tokenUsage,
  };
};

export const parseResponseLogText = (text, { stable = false } = {}) =>
  parseExtractedResponsePayload(extractResponsePayload({ fullText: text, stable }));

export const parseLogFilename = (fileName, fallbackTimestampMs = null) => {
  const match = String(fileName).match(LOG_FILE_PATTERN);
  if (!match) {
    return {
      fileType: 'unknown',
      timestampMs: Number.isFinite(fallbackTimestampMs) ? Math.floor(fallbackTimestampMs) : null,
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
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : fallbackTimestampMs,
    requestId,
  };
};

export const hashPrivateIdentifier = (value) => cryptoHash('sha256', String(value), 'hex');

export const buildRequestDedupeKey = ({ fileType, timestampMs, requestId, sourceIdentity }) => {
  if (requestId && Number.isFinite(timestampMs) && fileType && fileType !== 'unknown') {
    return `request:${hashPrivateIdentifier(`${fileType}|${timestampMs}|${requestId}`)}`;
  }
  return `source:${hashPrivateIdentifier(sourceIdentity ?? '')}`;
};

const usageSignature = (entry) => {
  const usage = entry.tokenUsage ?? emptyTokenUsage();
  return [
    entry.status,
    entry.model ?? '',
    usage.input,
    usage.output,
    usage.cached,
    usage.reasoning,
    usage.total,
  ].join('|');
};

export const dedupeTokenEntries = (entries) => {
  const groups = new Map();
  for (const entry of entries) {
    const current = groups.get(entry.dedupeKey);
    if (!current) {
      groups.set(entry.dedupeKey, entry);
      continue;
    }
    if (current.status === 'ambiguous') continue;
    if (current.status === 'available' && entry.status === 'available') {
      const usageMatches = sameUsage(current.tokenUsage, entry.tokenUsage);
      const modelConflict =
        current.model !== null && entry.model !== null && current.model !== entry.model;
      if (usageMatches && !modelConflict) {
        const preferred =
          entry.model && !current.model
            ? entry
            : (entry.lastModifiedMs ?? 0) >= (current.lastModifiedMs ?? 0)
              ? entry
              : current;
        groups.set(entry.dedupeKey, preferred);
        continue;
      }
      groups.set(entry.dedupeKey, {
        ...entry,
        status: 'ambiguous',
        model: entry.model ?? current.model ?? null,
        tokenUsage: emptyTokenUsage('ambiguous'),
      });
      continue;
    }

    const statusRank = {
      available: 5,
      unreported: 4,
      pending: 3,
      'parse-error': 2,
      unsupported: 1,
      ambiguous: 0,
    };
    const currentRank = statusRank[current.status] ?? 0;
    const entryRank = statusRank[entry.status] ?? 0;
    if (entryRank > currentRank) {
      groups.set(entry.dedupeKey, entry);
      continue;
    }
    if (entryRank === currentRank && usageSignature(current) === usageSignature(entry)) {
      if ((entry.lastModifiedMs ?? 0) >= (current.lastModifiedMs ?? 0)) {
        groups.set(entry.dedupeKey, entry);
      }
    }
  }
  return [...groups.values()];
};

const tokenUsageScore = (entry) => {
  if (entry.tokenUsage?.status === 'available') return 2;
  if (entry.tokenUsage?.status === 'unreported') return 1;
  return 0;
};

const detailStatusScore = (entry) => {
  if (entry.detailStatus === 'ready') return 2;
  if (entry.detailStatus === 'missing-fields') return 1;
  return 0;
};

const sourcePriority = (entry) => {
  const normalized = String(entry.sourceDir ?? '')
    .replace(/\\/g, '/')
    .toLowerCase();
  return normalized.endsWith('/auths/logs') ? 1 : 0;
};

const numericScore = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export const preferredLedgerEntry = (left, right) => {
  const rankers = [
    tokenUsageScore,
    detailStatusScore,
    (entry) => numericScore(entry.timestampMs),
    sourcePriority,
    (entry) => numericScore(entry.lastModifiedMs),
    (entry) => numericScore(entry.fileSize),
  ];

  for (const ranker of rankers) {
    const leftScore = ranker(left);
    const rightScore = ranker(right);
    if (leftScore !== rightScore) return leftScore > rightScore ? left : right;
  }

  return String(left.sourceKey ?? left.fileName).localeCompare(
    String(right.sourceKey ?? right.fileName)
  ) <= 0
    ? left
    : right;
};

export const dedupeLedgerEntries = (entries) => {
  const groups = new Map();
  for (const entry of entries) {
    const key = buildRequestDedupeKey({
      fileType: entry.fileType ?? 'unknown',
      timestampMs: entry.timestampMs ?? null,
      requestId: entry.requestId ?? null,
      sourceIdentity: entry.sourceKey ?? entry.fileName ?? '',
    });
    const current = groups.get(key);
    if (!current) {
      groups.set(key, entry);
      continue;
    }
    if (current.tokenUsage?.status === 'ambiguous') continue;
    if (current.tokenUsage?.status === 'available' && entry.tokenUsage?.status === 'available') {
      const currentModel = current.actualModel ?? current.configuredModel ?? null;
      const entryModel = entry.actualModel ?? entry.configuredModel ?? null;
      const modelConflict =
        currentModel !== null && entryModel !== null && currentModel !== entryModel;
      if (!sameUsage(current.tokenUsage, entry.tokenUsage) || modelConflict) {
        const preferred = preferredLedgerEntry(current, entry);
        groups.set(key, {
          ...preferred,
          detailStatus: 'ambiguous',
          tokenUsage: emptyTokenUsage('ambiguous'),
          errorCode: 'ambiguous-request',
        });
        continue;
      }
    }
    groups.set(key, preferredLedgerEntry(current, entry));
  }
  return [...groups.values()];
};
