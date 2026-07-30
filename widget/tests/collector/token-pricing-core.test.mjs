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

test('GPT-5.6 models use the published Standard short-context rates', () => {
  const usage = {
    input: 200_000,
    cached: 40_000,
    output: 20_000,
    total: 220_000,
  };
  const expectations = [
    ['gpt-5.6-sol', 1.42, 'gpt-5.6-sol'],
    ['gpt-5.6-sol-2026-07-30', 1.42, 'gpt-5.6-sol-*'],
    ['gpt-5.6-terra', 0.71, 'gpt-5.6-terra'],
    ['gpt-5.6-luna', 0.284, 'gpt-5.6-luna'],
    ['gpt-5.6', 1.42, 'gpt-5.6'],
  ];

  for (const [model, costUsd, pricingPattern] of expectations) {
    const estimate = estimateTokenUsageCost(model, usage);
    assert.equal(estimate.costUsd, costUsd, model);
    assert.equal(estimate.pricingPattern, pricingPattern, model);
    assert.equal(estimate.pricedTokens, usage.total, model);
    assert.equal(estimate.unpricedTokens, 0, model);
  }
  assert.equal(TOKEN_PRICING_VERSION, '1.1.0');
});

test('GPT-5.6 long-context rates apply to the whole request only above 272K input tokens', () => {
  const longContextUsage = {
    input: 300_000,
    cached: 100_000,
    output: 100_000,
    total: 400_000,
  };
  const longContextExpectations = [
    ['gpt-5.6-sol', 6.6],
    ['gpt-5.6-terra', 3.3],
    ['gpt-5.6-luna', 1.32],
    ['gpt-5.6', 6.6],
  ];

  for (const [model, costUsd] of longContextExpectations) {
    assert.equal(estimateTokenUsageCost(model, longContextUsage).costUsd, costUsd, model);
  }

  const thresholdEstimate = estimateTokenUsageCost('gpt-5.6-sol', {
    input: 272_000,
    cached: 72_000,
    output: 100_000,
    total: 372_000,
  });
  assert.equal(thresholdEstimate.costUsd, 4.036);
});

test('unknown models remain explicitly unpriced', () => {
  const estimate = estimateTokenUsageCost('gpt-6.0-unknown', {
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

test('custom GPT-5.6 overrides remain authoritative above the built-in long-context threshold', () => {
  const estimate = estimateTokenUsageCost(
    'gpt-5.6-sol',
    { input: 300_000, cached: 100_000, output: 100_000, total: 400_000 },
    [
      {
        pattern: 'gpt-5.6*',
        inputUsdPer1M: 1,
        cachedInputUsdPer1M: 0.1,
        outputUsdPer1M: 2,
        enabled: true,
      },
    ]
  );

  assert.equal(estimate.costUsd, 0.41);
  assert.equal(estimate.pricingPattern, 'gpt-5.6*');
});
