import type { TokenLedgerEntry, TokenUsage } from '@/types/usageStatistics';
import {
  estimateTokenUsageCost as estimateTokenUsageCostCore,
  isModelPricingOverrideUsable as isModelPricingOverrideUsableCore,
  sanitizeModelPricingOverrides as sanitizeModelPricingOverridesCore,
} from '../../../../scripts/lib/token-pricing-core.mjs';
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

type TokenUsageLike = Pick<TokenUsage, 'input' | 'output' | 'cached' | 'total'>;

export const isModelPricingOverrideUsable = (
  rule: Pick<
    ModelPricingOverride,
    'pattern' | 'inputUsdPer1M' | 'cachedInputUsdPer1M' | 'outputUsdPer1M'
  >
): boolean => isModelPricingOverrideUsableCore(rule);

export const sanitizeModelPricingOverrides = (value: unknown): ModelPricingOverride[] =>
  sanitizeModelPricingOverridesCore(value);

export const estimateTokenUsageCost = (
  model: string,
  usage: TokenUsageLike,
  overrides: ModelPricingOverride[] = []
): TokenCostEstimate => estimateTokenUsageCostCore(model, usage, overrides);

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
