import assert from 'node:assert/strict';
import test from 'node:test';

import { projectWidgetSnapshotV1 } from '../../electron/snapshotProjection.mjs';

const usage = () => ({
  fromMs: 1,
  toMs: 2,
  requests: 1,
  inputTokens: 8,
  cachedInputTokens: 3,
  outputTokens: 2,
  reasoningTokens: 1,
  totalTokens: 10,
  estimatedUsd: 0.01,
  pricedTokens: 10,
  unpricedTokens: 0,
  pricedRequests: 1,
  unpricedRequests: 0,
});

const trends = () =>
  Object.fromEntries(
    ['today', 'rolling24h', 'rolling7d', 'month', 'ledgerCoverage'].map((key) => [
      key,
      {
        fromMs: 1,
        toMs: 2,
        granularity: key === 'today' || key === 'rolling24h' ? 'hour' : 'day',
        points: [{ startMs: 1, requests: 1, totalTokens: 10, estimatedUsd: 0.01 }],
      },
    ])
  );

const view = () => ({
  statusCounts: {
    available: 1,
    pending: 0,
    unreported: 0,
    ambiguous: 0,
    parseError: 0,
    unsupported: 0,
  },
  periods: {
    today: usage(),
    rolling24h: usage(),
    rolling7d: usage(),
    month: usage(),
    ledgerCoverage: usage(),
  },
  trend60m: [{ startMs: 1, requests: 1, totalTokens: 10, estimatedUsd: 0.01 }],
  trends: trends(),
  topModels: [
    {
      model: 'gpt-5.5-codex',
      ...usage(),
    },
  ],
  recentModels: [
    {
      model: 'gpt-5.5-codex',
      timestampMs: 2,
      totalTokens: 10,
      estimatedUsd: 0.01,
    },
  ],
  latestRequest: {
    model: 'gpt-5.5-codex',
    timestampMs: 2,
    status: 'available',
    totalTokens: 10,
    estimatedUsd: 0.01,
  },
});

const snapshot = () => ({
  version: 1,
  computedAt: '2026-07-16T10:40:00.000Z',
  source: {
    status: 'live',
    installDir: 'D:\\CLIProxyAPI',
    collectorVersion: '1.0.0',
    parserVersion: '1.0.0',
    pricingVersion: '1.0.0',
    ledgerGeneratedAt: '2026-07-16T10:39:58.000Z',
    ledgerCoverageStartMs: 1,
    ledgerCoverageEndMs: 2,
    latestRequestAtMs: 2,
    lastSuccessfulScanAtMs: 2,
    lastReconcileAtMs: 2,
    pendingFiles: 0,
    parseErrors: 0,
    unsupportedFiles: 0,
    possibleCoverageGap: false,
    messageCode: null,
  },
  statusCounts: {
    available: 1,
    pending: 0,
    unreported: 0,
    ambiguous: 0,
    parseError: 0,
    unsupported: 0,
  },
  periods: {
    today: usage(),
    rolling24h: usage(),
    rolling7d: usage(),
    month: usage(),
    ledgerCoverage: usage(),
  },
  trend60m: [{ startMs: 1, requests: 1, totalTokens: 10, estimatedUsd: 0.01 }],
  trends: trends(),
  topModels: [
    {
      model: 'gpt-5.5-codex',
      ...usage(),
    },
  ],
  recentModels: [
    {
      model: 'gpt-5.5-codex',
      timestampMs: 2,
      totalTokens: 10,
      estimatedUsd: 0.01,
    },
  ],
  latestRequest: {
    model: 'gpt-5.5-codex',
    timestampMs: 2,
    status: 'available',
    totalTokens: 10,
    estimatedUsd: 0.01,
  },
  ledgerView: view(),
  unledgeredView: view(),
});

test('snapshot projection exposes only WidgetSnapshotV1 aggregate fields', () => {
  const unsafe = snapshot();
  unsafe.rawLog = 'raw-secret';
  unsafe.requestId = 'request-secret';
  unsafe.source.headers = { authorization: 'secret' };
  unsafe.periods.today.prompt = 'prompt-secret';
  unsafe.topModels[0].rawException = { stack: 'secret' };
  unsafe.recentModels[0].requestId = 'recent-request-secret';
  unsafe.recentModels[0].prompt = 'recent-prompt-secret';
  unsafe.recentModels[0].headers = { authorization: 'recent-header-secret' };
  unsafe.recentModels[0].rawLog = 'recent-log-secret';
  unsafe.latestRequest.headers = { cookie: 'secret' };

  const projected = projectWidgetSnapshotV1(unsafe, 'D:\\CLIProxyAPI');

  assert.ok(projected);
  assert.deepEqual(Object.keys(projected), [
    'version',
    'computedAt',
    'source',
    'statusCounts',
    'periods',
    'trend60m',
    'trends',
    'topModels',
    'recentModels',
    'latestRequest',
    'ledgerView',
    'unledgeredView',
  ]);
  assert.deepEqual(Object.keys(projected.recentModels[0]), [
    'model',
    'timestampMs',
    'totalTokens',
    'estimatedUsd',
  ]);
  const serialized = JSON.stringify(projected);
  for (const forbidden of [
    'raw-secret',
    'request-secret',
    'prompt-secret',
    'authorization',
    'cookie',
    'recent-request-secret',
    'recent-prompt-secret',
    'recent-header-secret',
    'recent-log-secret',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
  assert.equal(projected.source.installDir, 'D:\\CLIProxyAPI');
});

test('snapshot projection rejects invalid or unbounded aggregate payloads', () => {
  const invalidNumber = snapshot();
  invalidNumber.periods.today.totalTokens = Number.POSITIVE_INFINITY;
  assert.equal(projectWidgetSnapshotV1(invalidNumber, 'D:\\CLIProxyAPI'), null);

  const oversizedTrend = snapshot();
  oversizedTrend.trend60m = Array.from({ length: 61 }, (_, index) => ({
    startMs: index,
    requests: 1,
    totalTokens: 1,
    estimatedUsd: 0,
  }));
  assert.equal(projectWidgetSnapshotV1(oversizedTrend, 'D:\\CLIProxyAPI'), null);

  const invalidTrendSeries = snapshot();
  invalidTrendSeries.trends.month.granularity = 'minute';
  assert.equal(projectWidgetSnapshotV1(invalidTrendSeries, 'D:\\CLIProxyAPI'), null);

  const oversizedRecentModels = snapshot();
  oversizedRecentModels.recentModels = Array.from({ length: 4 }, (_, index) => ({
    model: `gpt-${index}`,
    timestampMs: index,
    totalTokens: 1,
    estimatedUsd: null,
  }));
  assert.equal(projectWidgetSnapshotV1(oversizedRecentModels, 'D:\\CLIProxyAPI'), null);
});

test('snapshot projection keeps legacy V1 snapshots usable when recentModels is absent', () => {
  const legacy = snapshot();
  delete legacy.recentModels;

  const projected = projectWidgetSnapshotV1(legacy, 'D:\\CLIProxyAPI');

  assert.ok(projected);
  assert.deepEqual(projected.recentModels, []);
  assert.equal(projected.latestRequest?.model, 'gpt-5.5-codex');
});

test('legacy V1 snapshots do not reuse the 60-minute series for unrelated periods', () => {
  const legacy = snapshot();
  delete legacy.trends;

  const projected = projectWidgetSnapshotV1(legacy, 'D:\\CLIProxyAPI');

  assert.ok(projected);
  assert.notStrictEqual(projected.trends.today, projected.trends.rolling24h);
  assert.deepEqual(projected.trends.rolling24h.points, []);
  assert.deepEqual(projected.trends.rolling7d.points, []);
  assert.equal(projected.trends.rolling24h.granularity, 'hour');
  assert.equal(projected.trends.rolling7d.granularity, 'day');
});
