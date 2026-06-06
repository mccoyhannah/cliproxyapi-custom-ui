import type { TokenLedgerEntry, TokenUsage } from '@/types/usageStatistics';
import { UNPARSED_MODEL_LABEL } from './constants';

export const MODEL_PRICING_OVERRIDES_STORAGE_KEY = 'usageStatistics.modelPricingOverrides.v1';

export interface ModelPricingOverride {
  pattern: string;
  inputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  outputUsdPer1M: number;
  enabled?: boolean;
}

export interface TokenCostEstimate {
  costUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  pricingPattern: string | null;
}

export interface TokenLedgerCostSummary {
  costUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  pricedModels: number;
  unpricedModels: number;
}

type PricingRule = Required<ModelPricingOverride> & {
  source: 'builtin' | 'override';
};

type TokenUsageLike = Pick<TokenUsage, 'input' | 'output' | 'cached' | 'total'>;

const BUILTIN_MODEL_PRICING: PricingRule[] = [
  {
    pattern: 'gpt-5.4-mini-*',
    inputUsdPer1M: 0.75,
    cachedInputUsdPer1M: 0.075,
    outputUsdPer1M: 4.5,
    enabled: true,
    source: 'builtin',
  },
  {
    pattern: 'gpt-5.4-mini',
    inputUsdPer1M: 0.75,
    cachedInputUsdPer1M: 0.075,
    outputUsdPer1M: 4.5,
    enabled: true,
    source: 'builtin',
  },
  {
    pattern: 'gpt-image-2-*',
    inputUsdPer1M: 5,
    cachedInputUsdPer1M: 1.25,
    outputUsdPer1M: 30,
    enabled: true,
    source: 'builtin',
  },
  {
    pattern: 'gpt-image-2',
    inputUsdPer1M: 5,
    cachedInputUsdPer1M: 1.25,
    outputUsdPer1M: 30,
    enabled: true,
    source: 'builtin',
  },
  {
    pattern: 'gpt-5.5-*',
    inputUsdPer1M: 5,
    cachedInputUsdPer1M: 0.5,
    outputUsdPer1M: 30,
    enabled: true,
    source: 'builtin',
  },
  {
    pattern: 'gpt-5.5',
    inputUsdPer1M: 5,
    cachedInputUsdPer1M: 0.5,
    outputUsdPer1M: 30,
    enabled: true,
    source: 'builtin',
  },
  {
    pattern: 'gpt-5.4-*',
    inputUsdPer1M: 2.5,
    cachedInputUsdPer1M: 0.25,
    outputUsdPer1M: 15,
    enabled: true,
    source: 'builtin',
  },
  {
    pattern: 'gpt-5.4',
    inputUsdPer1M: 2.5,
    cachedInputUsdPer1M: 0.25,
    outputUsdPer1M: 15,
    enabled: true,
    source: 'builtin',
  },
];

const normalizePattern = (value: string): string => value.trim().toLowerCase();

const toFiniteRate = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export const isModelPricingOverrideUsable = (
  rule: Pick<ModelPricingOverride, 'pattern' | 'inputUsdPer1M' | 'cachedInputUsdPer1M' | 'outputUsdPer1M'>
): boolean =>
  Boolean(normalizePattern(rule.pattern)) &&
  rule.inputUsdPer1M >= 0 &&
  rule.cachedInputUsdPer1M >= 0 &&
  rule.outputUsdPer1M >= 0 &&
  (rule.inputUsdPer1M > 0 || rule.cachedInputUsdPer1M > 0 || rule.outputUsdPer1M > 0);

const patternSpecificity = (pattern: string): number =>
  normalizePattern(pattern).replace(/\*$/, '').length;

const matchesPattern = (model: string, pattern: string): boolean => {
  const normalizedModel = normalizePattern(model);
  const normalizedPattern = normalizePattern(pattern);
  if (!normalizedModel || !normalizedPattern) return false;
  if (normalizedPattern.endsWith('*')) {
    return normalizedModel.startsWith(normalizedPattern.slice(0, -1));
  }
  return normalizedModel === normalizedPattern;
};

export const sanitizeModelPricingOverrides = (value: unknown): ModelPricingOverride[] => {
  if (!Array.isArray(value)) return [];

  const rows: Array<ModelPricingOverride | null> = value.map((item) => {
    if (!item || typeof item !== 'object') return null;
    const raw = item as Record<string, unknown>;
    const pattern = typeof raw.pattern === 'string' ? raw.pattern : '';
    const inputUsdPer1M = toFiniteRate(raw.inputUsdPer1M);
    const cachedInputUsdPer1M = toFiniteRate(raw.cachedInputUsdPer1M);
    const outputUsdPer1M = toFiniteRate(raw.outputUsdPer1M);
    if (inputUsdPer1M === null || cachedInputUsdPer1M === null || outputUsdPer1M === null) {
      return null;
    }
    return {
      pattern,
      inputUsdPer1M,
      cachedInputUsdPer1M,
      outputUsdPer1M,
      enabled: raw.enabled !== false,
    } satisfies ModelPricingOverride;
  });

  return rows.filter((item): item is ModelPricingOverride => item !== null);
};

const resolvePricingRule = (
  model: string,
  overrides: ModelPricingOverride[] = []
): PricingRule | null => {
  const overrideRules: PricingRule[] = sanitizeModelPricingOverrides(overrides)
    .filter((rule) => rule.enabled !== false && isModelPricingOverrideUsable(rule))
    .map((rule) => ({ ...rule, enabled: true, source: 'override' }));

  const findBest = (rules: PricingRule[]) =>
    rules
      .filter((rule) => matchesPattern(model, rule.pattern))
      .sort((a, b) => patternSpecificity(b.pattern) - patternSpecificity(a.pattern))[0] ?? null;

  return findBest(overrideRules) ?? findBest(BUILTIN_MODEL_PRICING);
};

export const estimateTokenUsageCost = (
  model: string,
  usage: TokenUsageLike,
  overrides: ModelPricingOverride[] = []
): TokenCostEstimate => {
  const total = Math.max(0, usage.total);
  const rule = resolvePricingRule(model, overrides);
  if (!rule) {
    return {
      costUsd: 0,
      pricedTokens: 0,
      unpricedTokens: total,
      pricingPattern: null,
    };
  }

  const cachedInput = Math.min(Math.max(0, usage.cached), Math.max(0, usage.input));
  const uncachedInput = Math.max(0, usage.input - cachedInput);
  const output = Math.max(0, usage.output);
  const costUsd =
    (uncachedInput * rule.inputUsdPer1M +
      cachedInput * rule.cachedInputUsdPer1M +
      output * rule.outputUsdPer1M) /
    1_000_000;

  return {
    costUsd,
    pricedTokens: total,
    unpricedTokens: 0,
    pricingPattern: rule.pattern,
  };
};

export const calculateTokenLedgerCostSummary = (
  entries: TokenLedgerEntry[],
  overrides: ModelPricingOverride[] = []
): TokenLedgerCostSummary => {
  const groups = new Map<string, TokenUsageLike>();

  entries.forEach((entry) => {
    if (entry.tokenUsage.status !== 'available') return;
    const model = entry.actualModel ?? entry.configuredModel ?? UNPARSED_MODEL_LABEL;
    const current = groups.get(model) ?? { input: 0, output: 0, cached: 0, total: 0 };
    current.input += entry.tokenUsage.input;
    current.output += entry.tokenUsage.output;
    current.cached += entry.tokenUsage.cached;
    current.total += entry.tokenUsage.total;
    groups.set(model, current);
  });

  let costUsd = 0;
  let pricedTokens = 0;
  let unpricedTokens = 0;
  let pricedModels = 0;
  let unpricedModels = 0;

  groups.forEach((usage, model) => {
    const estimate = estimateTokenUsageCost(model, usage, overrides);
    costUsd += estimate.costUsd;
    pricedTokens += estimate.pricedTokens;
    unpricedTokens += estimate.unpricedTokens;
    if (estimate.pricingPattern) {
      pricedModels += 1;
    } else if (usage.total > 0) {
      unpricedModels += 1;
    }
  });

  return {
    costUsd,
    pricedTokens,
    unpricedTokens,
    pricedModels,
    unpricedModels,
  };
};

export const formatUsdCost = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '$0.00';
  if (value < 0.01) return `<$0.01`;
  const fractionDigits = value >= 100 ? 0 : 2;
  return `$${value.toLocaleString('en-US', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  })}`;
};
