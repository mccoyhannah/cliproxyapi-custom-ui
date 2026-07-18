export const TOKEN_PRICING_VERSION = '1.0.0';

const BUILTIN_MODEL_PRICING = [
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

const normalizePattern = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const toFiniteRate = (value) => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

export const isModelPricingOverrideUsable = (rule) =>
  Boolean(normalizePattern(rule.pattern)) &&
  rule.inputUsdPer1M >= 0 &&
  rule.cachedInputUsdPer1M >= 0 &&
  rule.outputUsdPer1M >= 0 &&
  (rule.inputUsdPer1M > 0 || rule.cachedInputUsdPer1M > 0 || rule.outputUsdPer1M > 0);

const patternSpecificity = (pattern) => normalizePattern(pattern).replace(/\*$/, '').length;

const matchesPattern = (model, pattern) => {
  const normalizedModel = normalizePattern(model);
  const normalizedPattern = normalizePattern(pattern);
  if (!normalizedModel || !normalizedPattern) return false;
  if (normalizedPattern.endsWith('*')) {
    return normalizedModel.startsWith(normalizedPattern.slice(0, -1));
  }
  return normalizedModel === normalizedPattern;
};

export const sanitizeModelPricingOverrides = (value) => {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const pattern = typeof item.pattern === 'string' ? item.pattern : '';
      const inputUsdPer1M = toFiniteRate(item.inputUsdPer1M);
      const cachedInputUsdPer1M = toFiniteRate(item.cachedInputUsdPer1M);
      const outputUsdPer1M = toFiniteRate(item.outputUsdPer1M);
      if (inputUsdPer1M === null || cachedInputUsdPer1M === null || outputUsdPer1M === null) {
        return null;
      }
      return {
        pattern,
        inputUsdPer1M,
        cachedInputUsdPer1M,
        outputUsdPer1M,
        enabled: item.enabled !== false,
      };
    })
    .filter((item) => item !== null);
};

const buildOverrideRules = (overrides = []) =>
  sanitizeModelPricingOverrides(overrides)
    .filter((rule) => rule.enabled !== false && isModelPricingOverrideUsable(rule))
    .map((rule) => ({ ...rule, enabled: true, source: 'override' }));

const findBestRule = (model, rules) =>
  rules
    .filter((rule) => matchesPattern(model, rule.pattern))
    .sort(
      (left, right) => patternSpecificity(right.pattern) - patternSpecificity(left.pattern)
    )[0] ?? null;

const resolvePricingRule = (model, overrideRules) => {
  return findBestRule(model, overrideRules) ?? findBestRule(model, BUILTIN_MODEL_PRICING);
};

const estimateWithRule = (usage, rule) => {
  const total = Math.max(0, Number(usage.total) || 0);
  if (!rule) {
    return {
      costUsd: 0,
      pricedTokens: 0,
      unpricedTokens: total,
      pricingPattern: null,
    };
  }

  const input = Math.max(0, Number(usage.input) || 0);
  const cachedInput = Math.min(Math.max(0, Number(usage.cached) || 0), input);
  const uncachedInput = Math.max(0, input - cachedInput);
  const output = Math.max(0, Number(usage.output) || 0);
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

export const createTokenCostEstimator = (overrides = []) => {
  const overrideRules = buildOverrideRules(overrides);
  const ruleCache = new Map();
  return (model, usage) => {
    const cacheKey = normalizePattern(model);
    let rule;
    if (ruleCache.has(cacheKey)) rule = ruleCache.get(cacheKey);
    else {
      rule = resolvePricingRule(model, overrideRules);
      ruleCache.set(cacheKey, rule);
    }
    return estimateWithRule(usage, rule);
  };
};

export const estimateTokenUsageCost = (model, usage, overrides = []) =>
  createTokenCostEstimator(overrides)(model, usage);
