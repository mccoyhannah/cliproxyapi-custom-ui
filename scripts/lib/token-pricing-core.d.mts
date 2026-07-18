export const TOKEN_PRICING_VERSION: string;

export interface CoreModelPricingOverride {
  pattern: string;
  inputUsdPer1M: number;
  cachedInputUsdPer1M: number;
  outputUsdPer1M: number;
  enabled?: boolean;
}

export interface CoreTokenCostEstimate {
  costUsd: number;
  pricedTokens: number;
  unpricedTokens: number;
  pricingPattern: string | null;
}

export function isModelPricingOverrideUsable(
  rule: Pick<
    CoreModelPricingOverride,
    'pattern' | 'inputUsdPer1M' | 'cachedInputUsdPer1M' | 'outputUsdPer1M'
  >
): boolean;
export function sanitizeModelPricingOverrides(value: unknown): CoreModelPricingOverride[];
export function estimateTokenUsageCost(
  model: string,
  usage: { input: number; output: number; cached: number; total: number },
  overrides?: CoreModelPricingOverride[]
): CoreTokenCostEstimate;
export function createTokenCostEstimator(
  overrides?: CoreModelPricingOverride[]
): (
  model: string,
  usage: { input: number; output: number; cached: number; total: number }
) => CoreTokenCostEstimate;
