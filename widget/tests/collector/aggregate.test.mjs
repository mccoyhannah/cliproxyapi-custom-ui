import assert from 'node:assert/strict';
import test from 'node:test';

import { buildWidgetSnapshot } from '../../electron/collector/aggregate.mjs';

const usage = (input, output, cached = 0, reasoning = 0) => ({
  input,
  output,
  cached,
  reasoning,
  total: input + output,
  status: 'available',
});

test('snapshot uses local calendar periods, subset token semantics, and explicit pricing coverage', () => {
  const nowMs = new Date(2026, 6, 16, 12, 0, 30).getTime();
  const entries = [
    {
      dedupeKey: 'one',
      timestampMs: new Date(2026, 6, 16, 11, 59, 0).getTime(),
      lastModifiedMs: 1,
      model: 'gpt-5.4',
      status: 'available',
      tokenUsage: usage(8, 2, 4, 1),
    },
    {
      dedupeKey: 'two',
      timestampMs: new Date(2026, 6, 16, 10, 0, 0).getTime(),
      lastModifiedMs: 2,
      model: 'gpt-6.0-unknown',
      status: 'available',
      tokenUsage: usage(15, 5, 5, 2),
    },
    {
      dedupeKey: 'three',
      timestampMs: new Date(2026, 6, 15, 18, 0, 0).getTime(),
      lastModifiedMs: 3,
      model: 'gpt-5.4-mini',
      status: 'available',
      tokenUsage: usage(4, 1),
    },
    {
      dedupeKey: 'four',
      timestampMs: new Date(2026, 6, 8, 12, 0, 0).getTime(),
      lastModifiedMs: 4,
      model: 'gpt-5.4',
      status: 'available',
      tokenUsage: usage(2, 1),
    },
    {
      dedupeKey: 'pending',
      timestampMs: new Date(2026, 6, 16, 12, 0, 20).getTime(),
      lastModifiedMs: 5,
      model: 'gpt-5.4',
      status: 'pending',
      tokenUsage: { ...usage(0, 0), status: 'pending' },
    },
  ];

  const snapshot = buildWidgetSnapshot({
    entries,
    nowMs,
    installDir: 'D:\\CLIProxyAPI',
    source: {
      status: 'live',
      ledgerGeneratedAt: '2026-07-16T00:00:00.000Z',
      ledgerCoverageStartMs: entries[3].timestampMs,
      ledgerCoverageEndMs: entries[0].timestampMs,
      lastSuccessfulScanAtMs: nowMs,
      lastReconcileAtMs: nowMs,
      pendingFiles: 1,
      possibleCoverageGap: false,
      messageCode: null,
    },
    pricingOverrides: [],
  });

  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.source.collectorVersion, '1.2.0');
  assert.equal(snapshot.periods.today.requests, 2);
  assert.equal(snapshot.periods.today.totalTokens, 30);
  assert.equal(snapshot.periods.today.cachedInputTokens, 9);
  assert.equal(snapshot.periods.today.reasoningTokens, 3);
  assert.equal(snapshot.periods.today.pricedTokens, 10);
  assert.equal(snapshot.periods.today.unpricedTokens, 20);
  assert.equal(snapshot.periods.today.pricedRequests, 1);
  assert.equal(snapshot.periods.today.unpricedRequests, 1);
  assert.ok(snapshot.periods.today.estimatedUsd > 0);
  assert.equal(snapshot.periods.rolling24h.totalTokens, 35);
  assert.equal(snapshot.periods.rolling7d.totalTokens, 35);
  assert.equal(snapshot.periods.month.totalTokens, 38);
  assert.equal(snapshot.statusCounts.pending, 1);
  assert.equal(snapshot.trend60m.length, 60);
  assert.equal(snapshot.trend60m.at(-1).requests, 0);
  assert.equal(snapshot.latestRequest.status, 'available');
  assert.equal(snapshot.latestRequest.model, 'gpt-5.4');
  assert.equal(snapshot.latestRequest.totalTokens, 10);
  assert.equal(snapshot.topModels[0].model, 'gpt-6.0-unknown');
});

test('period trends use their own range, granularity, empty buckets, and preserve totals', () => {
  const nowMs = new Date(2026, 6, 16, 12, 30, 0).getTime();
  const todayStart = new Date(2026, 6, 16, 0, 0, 0).getTime();
  const entries = [
    {
      dedupeKey: 'today-first',
      timestampMs: todayStart + 30 * 60_000,
      lastModifiedMs: 1,
      model: 'gpt-5.4',
      status: 'available',
      tokenUsage: usage(10, 2),
    },
    {
      dedupeKey: 'today-current-hour',
      timestampMs: new Date(2026, 6, 16, 12, 5, 0).getTime(),
      lastModifiedMs: 2,
      model: 'gpt-5.4',
      status: 'available',
      tokenUsage: usage(20, 4),
    },
    {
      dedupeKey: 'rolling24h-first',
      timestampMs: nowMs - 23 * 60 * 60_000 - 30 * 60_000,
      lastModifiedMs: 3,
      model: 'gpt-5.4-mini',
      status: 'available',
      tokenUsage: usage(30, 6),
    },
    {
      dedupeKey: 'rolling7d-first',
      timestampMs: nowMs - 6 * 24 * 60 * 60_000 - 30 * 60 * 1_000,
      lastModifiedMs: 4,
      model: 'gpt-5.4-mini',
      status: 'available',
      tokenUsage: usage(40, 8),
    },
    {
      dedupeKey: 'month-first',
      timestampMs: new Date(2026, 6, 1, 1, 0, 0).getTime(),
      lastModifiedMs: 5,
      model: 'gpt-5.4-mini',
      status: 'available',
      tokenUsage: usage(50, 10),
    },
    {
      dedupeKey: 'coverage-first',
      timestampMs: nowMs - 75 * 24 * 60 * 60_000,
      lastModifiedMs: 6,
      model: 'gpt-5.4-mini',
      status: 'available',
      tokenUsage: usage(60, 12),
    },
  ];

  const snapshot = buildWidgetSnapshot({
    entries,
    nowMs,
    installDir: 'D:\\CLIProxyAPI',
    source: {
      status: 'live',
      ledgerCoverageStartMs: entries.at(-1).timestampMs,
      ledgerCoverageEndMs: nowMs,
    },
  });
  const totalTrendTokens = (series) =>
    series.points.reduce((sum, point) => sum + point.totalTokens, 0);

  assert.equal(snapshot.trends.today.granularity, 'hour');
  assert.equal(snapshot.trends.today.fromMs, todayStart);
  assert.equal(
    snapshot.trends.today.points.at(-1).startMs,
    new Date(2026, 6, 16, 12, 0, 0).getTime()
  );
  assert.equal(snapshot.trends.rolling24h.granularity, 'hour');
  assert.equal(snapshot.trends.rolling24h.points.length, 24);
  assert.equal(snapshot.trends.rolling7d.granularity, 'day');
  assert.equal(snapshot.trends.rolling7d.points.length, 7);
  assert.equal(snapshot.trends.month.granularity, 'day');
  assert.equal(snapshot.trends.month.points.length, 16);
  assert.equal(snapshot.trends.ledgerCoverage.granularity, 'day');
  assert.ok(snapshot.trends.ledgerCoverage.points.length <= 60);
  assert.notDeepEqual(snapshot.trends.today.points, snapshot.trends.rolling24h.points);
  assert.equal(totalTrendTokens(snapshot.trends.today), snapshot.periods.today.totalTokens);
  assert.equal(
    totalTrendTokens(snapshot.trends.rolling24h),
    snapshot.periods.rolling24h.totalTokens
  );
  assert.equal(totalTrendTokens(snapshot.trends.rolling7d), snapshot.periods.rolling7d.totalTokens);
  assert.equal(totalTrendTokens(snapshot.trends.month), snapshot.periods.month.totalTokens);
  assert.equal(
    totalTrendTokens(snapshot.trends.ledgerCoverage),
    snapshot.periods.ledgerCoverage.totalTokens
  );
  assert.equal(snapshot.trends.today.points[1].requests, 0, 'empty hour buckets remain visible');
});

test('manual pricing overrides recompute previously unpriced visible history', () => {
  const nowMs = new Date(2026, 6, 16, 12, 0, 0).getTime();
  const entries = [
    {
      dedupeKey: 'unpriced',
      timestampMs: nowMs - 1000,
      lastModifiedMs: nowMs,
      model: 'gpt-6.0-unknown',
      status: 'available',
      tokenUsage: usage(10, 2, 4),
    },
  ];

  const snapshot = buildWidgetSnapshot({
    entries,
    nowMs,
    installDir: 'D:\\CLIProxyAPI',
    source: { status: 'live' },
    pricingOverrides: [
      {
        pattern: 'gpt-6.0-*',
        inputUsdPer1M: 1,
        cachedInputUsdPer1M: 0.1,
        outputUsdPer1M: 2,
        enabled: true,
      },
    ],
  });

  assert.equal(snapshot.periods.today.pricedTokens, 12);
  assert.equal(snapshot.periods.today.unpricedTokens, 0);
  assert.equal(snapshot.periods.today.estimatedUsd, 0.0000104);
});

test('recent models keep the latest completed request per model and cap the list at three', () => {
  const nowMs = new Date(2026, 6, 16, 12, 0, 0).getTime();
  const entries = [
    {
      dedupeKey: 'pending-image',
      timestampMs: nowMs - 100,
      lastModifiedMs: nowMs - 100,
      model: 'gpt-image-2',
      status: 'pending',
      tokenUsage: { ...usage(0, 0), status: 'pending' },
    },
    {
      dedupeKey: 'ambiguous-image',
      timestampMs: nowMs - 200,
      lastModifiedMs: nowMs - 200,
      model: 'gpt-image-2',
      status: 'available',
      tokenUsage: usage(50, 10),
    },
    {
      dedupeKey: 'ambiguous-image',
      timestampMs: nowMs - 150,
      lastModifiedMs: nowMs - 150,
      model: 'gpt-image-2',
      status: 'available',
      tokenUsage: usage(40, 8),
    },
    {
      dedupeKey: 'latest-gpt-5.4',
      timestampMs: nowMs - 1_000,
      lastModifiedMs: nowMs - 1_000,
      model: 'gpt-5.4',
      status: 'available',
      tokenUsage: usage(20, 4, 5),
    },
    {
      dedupeKey: 'latest-unpriced',
      timestampMs: nowMs - 2_000,
      lastModifiedMs: nowMs - 2_000,
      model: 'gpt-6.0-unknown',
      status: 'available',
      tokenUsage: usage(12, 3),
    },
    {
      dedupeKey: 'latest-mini',
      timestampMs: nowMs - 3_000,
      lastModifiedMs: nowMs - 3_000,
      model: 'gpt-5.4-mini',
      status: 'available',
      tokenUsage: usage(8, 2),
    },
    {
      dedupeKey: 'fourth-model',
      timestampMs: nowMs - 4_000,
      lastModifiedMs: nowMs - 4_000,
      model: 'gpt-5.5-codex',
      status: 'available',
      tokenUsage: usage(6, 1),
    },
    {
      dedupeKey: 'older-gpt-5.4',
      timestampMs: nowMs - 5_000,
      lastModifiedMs: nowMs - 5_000,
      model: 'gpt-5.4',
      status: 'available',
      tokenUsage: usage(2, 1),
    },
  ];

  const snapshot = buildWidgetSnapshot({
    entries,
    nowMs,
    installDir: 'D:\\CLIProxyAPI',
    source: { status: 'live' },
  });

  assert.deepEqual(
    snapshot.recentModels.map(({ model, timestampMs, totalTokens, estimatedUsd }) => ({
      model,
      timestampMs,
      totalTokens,
      estimatedUsd,
    })),
    [
      {
        model: 'gpt-5.4',
        timestampMs: nowMs - 1_000,
        totalTokens: 24,
        estimatedUsd: 0.00009875,
      },
      {
        model: 'gpt-6.0-unknown',
        timestampMs: nowMs - 2_000,
        totalTokens: 15,
        estimatedUsd: null,
      },
      {
        model: 'gpt-5.4-mini',
        timestampMs: nowMs - 3_000,
        totalTokens: 10,
        estimatedUsd: 0.000015,
      },
    ]
  );
});

test('snapshot keeps the formal ledger separate from unledgered live usage while preserving the combined total', () => {
  const nowMs = new Date(2026, 6, 16, 12, 0, 0).getTime();
  const ledgerEntry = {
    dedupeKey: 'ledger-one',
    timestampMs: nowMs - 10_000,
    lastModifiedMs: nowMs - 10_000,
    model: 'gpt-5.4',
    status: 'available',
    tokenUsage: usage(8, 2, 3),
  };
  const liveEntry = {
    dedupeKey: 'live-one',
    timestampMs: nowMs - 5_000,
    lastModifiedMs: nowMs - 5_000,
    model: 'gpt-5.6-sol',
    status: 'available',
    tokenUsage: usage(5, 1, 2),
  };

  const snapshot = buildWidgetSnapshot({
    entries: [ledgerEntry, liveEntry],
    ledgerEntries: [ledgerEntry],
    liveEntries: [liveEntry],
    nowMs,
    installDir: 'D:\\CLIProxyAPI',
    source: { status: 'live' },
  });

  assert.equal(snapshot.periods.today.totalTokens, 16, 'combined view remains real-time');
  assert.equal(snapshot.ledgerView.periods.today.totalTokens, 10);
  assert.equal(snapshot.unledgeredView.periods.today.totalTokens, 6);
  assert.equal(
    snapshot.periods.today.totalTokens,
    snapshot.ledgerView.periods.today.totalTokens +
      snapshot.unledgeredView.periods.today.totalTokens,
    'formal ledger plus unledgered delta must equal the displayed current total'
  );
  assert.deepEqual(
    snapshot.ledgerView.topModels.map((model) => model.model),
    ['gpt-5.4']
  );
  assert.deepEqual(
    snapshot.unledgeredView.topModels.map((model) => model.model),
    ['gpt-5.6-sol']
  );
});

test('unledgered view contains only stable completed usage, while current health keeps pending classifications', () => {
  const nowMs = new Date(2026, 6, 16, 12, 0, 0).getTime();
  const available = {
    dedupeKey: 'live-available',
    timestampMs: nowMs - 1_000,
    lastModifiedMs: nowMs - 1_000,
    model: 'gpt-5.6-sol',
    status: 'available',
    tokenUsage: usage(5, 1, 2),
  };
  const pending = {
    dedupeKey: 'live-pending',
    timestampMs: nowMs - 500,
    lastModifiedMs: nowMs - 500,
    model: null,
    status: 'pending',
    tokenUsage: { ...usage(0, 0, 0), status: 'pending' },
  };
  const unreported = {
    dedupeKey: 'live-unreported',
    timestampMs: nowMs - 750,
    lastModifiedMs: nowMs - 750,
    model: 'gpt-5.6-sol',
    status: 'unreported',
    tokenUsage: { ...usage(0, 0, 0), status: 'unreported' },
  };

  const snapshot = buildWidgetSnapshot({
    entries: [available, pending, unreported],
    ledgerEntries: [],
    liveEntries: [available, pending, unreported],
    nowMs,
    installDir: 'D:\\CLIProxyAPI',
    source: { status: 'live' },
  });

  assert.equal(snapshot.statusCounts.pending, 1);
  assert.equal(snapshot.statusCounts.unreported, 1);
  assert.equal(snapshot.periods.today.requests, 1);
  assert.equal(snapshot.unledgeredView.periods.today.totalTokens, 6);
  assert.equal(snapshot.unledgeredView.periods.today.requests, 1);
  assert.equal(snapshot.unledgeredView.statusCounts.available, 1);
  assert.equal(snapshot.unledgeredView.statusCounts.pending, 0);
  assert.equal(snapshot.unledgeredView.statusCounts.unreported, 0);
});
