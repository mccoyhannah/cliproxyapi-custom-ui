import modelNameRules from './modelNameRules.json';

const MODEL_VALUE_PATTERN = '[A-Za-z0-9._:/+-]+';
const blockedModelWords = new Set(modelNameRules.blockedWords.map((item) => item.toLowerCase()));
const validModelPatterns = modelNameRules.validModelPatterns.map(
  (pattern) => new RegExp(pattern, 'i')
);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeModelName = (value: unknown): string | null => {
  if (value === undefined || value === null || typeof value === 'boolean') return null;
  const trimmed = String(value).trim().replace(/^["'`]+|["'`,;}\]]+$/g, '');
  if (!trimmed || trimmed === '-') return null;
  if (/\s/.test(trimmed)) return null;

  const lower = trimmed.toLowerCase();
  if (blockedModelWords.has(lower)) return null;
  return validModelPatterns.some((pattern) => pattern.test(trimmed)) ? trimmed : null;
};

const buildJsonFieldPatterns = (keys: string[]): RegExp[] =>
  keys.map((key) => new RegExp(`"${escapeRegExp(key)}"\\s*:\\s*"([^"]+)"`, 'i'));

const extractFirstModel = (raw: string, patterns: RegExp[]): string | null => {
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const value = normalizeModelName(match?.[1]);
    if (value) return value;
  }
  return null;
};

const configuredJsonPatterns = buildJsonFieldPatterns(modelNameRules.configuredModelKeys);
const actualJsonPatterns = buildJsonFieldPatterns(modelNameRules.actualModelKeys);

const configuredTextPatterns = [
  new RegExp(`\\b(?:configured|requested)\\s+model\\s*[:=]\\s*(${MODEL_VALUE_PATTERN})`, 'i'),
];

const actualTextPatterns = [
  new RegExp(
    `\\b(?:actual|upstream|routed|selected|target|response)\\s+model\\s*[:=]\\s*(${MODEL_VALUE_PATTERN})`,
    'i'
  ),
];

export const extractConfiguredModel = (raw: string): string | null =>
  extractFirstModel(raw, [...configuredJsonPatterns, ...configuredTextPatterns]);

export const extractActualModel = (raw: string): string | null =>
  extractFirstModel(raw, [...actualJsonPatterns, ...actualTextPatterns]);

export const isRecognizedModelName = (value: unknown): boolean => normalizeModelName(value) !== null;
