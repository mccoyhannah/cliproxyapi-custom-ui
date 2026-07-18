import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOKEN_PRICING_VERSION,
  estimateTokenUsageCost,
  sanitizeModelPricingOverrides,
} from '../../../scripts/lib/token-pricing-core.mjs';

test('built-in pricing charges uncached input, cached input, and output separately', () => {
  const estimate = estimateTokenUsageCost('gpt-5.4', {
    input: 10,
    cached: 4,
    output: 2,
    total: 12,
  });

  assert.match(TOKEN_PRICING_VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(estimate.costUsd, 0.000046);
  assert.equal(estimate.pricedTokens, 12);
  assert.equal(estimate.unpricedTokens, 0);
  assert.equal(estimate.pricingPattern, 'gpt-5.4');
});

test('unknown models remain explicitly unpriced', () => {
  const estimate = estimateTokenUsageCost('gpt-5.6-sol', {
    input: 9,
    cached: 3,
    output: 2,
    total: 11,
  });

  assert.deepEqual(estimate, {
    costUsd: 0,
    pricedTokens: 0,
    unpricedTokens: 11,
    pricingPattern: null,
  });
});

test('sanitized enabled overrides take precedence without accepting invalid rates', () => {
  const overrides = sanitizeModelPricingOverrides([
    {
      pattern: 'gpt-5.4*',
      inputUsdPer1M: 1,
      cachedInputUsdPer1M: 0.1,
      outputUsdPer1M: 2,
      enabled: true,
    },
    {
      pattern: 'bad',
      inputUsdPer1M: -1,
      cachedInputUsdPer1M: 0,
      outputUsdPer1M: 0,
    },
  ]);
  const estimate = estimateTokenUsageCost(
    'gpt-5.4-mini',
    { input: 10, cached: 4, output: 2, total: 12 },
    overrides
  );

  assert.equal(overrides.length, 1);
  assert.equal(estimate.costUsd, 0.0000104);
  assert.equal(estimate.pricingPattern, 'gpt-5.4*');
});
