import type {
  WidgetEntryStatusCounts,
  WidgetMaintenancePreviewV1,
  WidgetMaintenanceResultV1,
  WidgetRecentModel,
  WidgetSnapshotV1,
  WidgetSourceStatus,
  WidgetTrendPoint,
  WidgetUsageView,
  WidgetUsageTotals,
} from './shared/contracts';

function usage(
  fromMs: number,
  toMs: number,
  requests: number,
  inputTokens: number,
  cachedInputTokens: number,
  outputTokens: number,
  estimatedUsd: number | null,
  unpricedTokens = 0
): WidgetUsageTotals {
  const totalTokens = inputTokens + outputTokens;
  return {
    fromMs,
    toMs,
    requests,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens: Math.round(outputTokens * 0.31),
    totalTokens,
    estimatedUsd,
    pricedTokens: Math.max(0, totalTokens - unpricedTokens),
    unpricedTokens,
    pricedRequests: unpricedTokens > 0 ? Math.max(0, requests - 2) : requests,
    unpricedRequests: unpricedTokens > 0 ? 2 : 0,
  };
}

function subtractUsage(current: WidgetUsageTotals, delta: WidgetUsageTotals): WidgetUsageTotals {
  return {
    fromMs: current.fromMs,
    toMs: current.toMs,
    requests: Math.max(0, current.requests - delta.requests),
    inputTokens: Math.max(0, current.inputTokens - delta.inputTokens),
    cachedInputTokens: Math.max(0, current.cachedInputTokens - delta.cachedInputTokens),
    outputTokens: Math.max(0, current.outputTokens - delta.outputTokens),
    reasoningTokens: Math.max(0, current.reasoningTokens - delta.reasoningTokens),
    totalTokens: Math.max(0, current.totalTokens - delta.totalTokens),
    estimatedUsd:
      current.estimatedUsd === null || delta.estimatedUsd === null
        ? current.estimatedUsd
        : Math.max(0, current.estimatedUsd - delta.estimatedUsd),
    pricedTokens: Math.max(0, current.pricedTokens - delta.pricedTokens),
    unpricedTokens: Math.max(0, current.unpricedTokens - delta.unpricedTokens),
    pricedRequests: Math.max(0, current.pricedRequests - delta.pricedRequests),
    unpricedRequests: Math.max(0, current.unpricedRequests - delta.unpricedRequests),
  };
}

function usageView({
  statusCounts,
  periods,
  trend60m = [],
  topModels = [],
  recentModels = [],
  latestRequest = null,
}: WidgetUsageView): WidgetUsageView {
  return { statusCounts, periods, trend60m, topModels, recentModels, latestRequest };
}

function splitTrend(trend: WidgetTrendPoint[]): {
  ledger: WidgetTrendPoint[];
  unledgered: WidgetTrendPoint[];
} {
  const unledgered = trend.map((point, index) => {
    const liveRatio = index < trend.length - 5 ? 0 : (index - (trend.length - 6)) * 0.035;
    const totalTokens = Math.round(point.totalTokens * liveRatio);
    return {
      startMs: point.startMs,
      requests: totalTokens > 0 ? 1 : 0,
      totalTokens,
      estimatedUsd: point.estimatedUsd === null ? null : point.estimatedUsd * liveRatio,
    };
  });
  const ledger = trend.map((point, index) => ({
    startMs: point.startMs,
    requests: Math.max(0, point.requests - (unledgered[index]?.requests ?? 0)),
    totalTokens: Math.max(0, point.totalTokens - (unledgered[index]?.totalTokens ?? 0)),
    estimatedUsd:
      point.estimatedUsd === null || unledgered[index]?.estimatedUsd === null
        ? point.estimatedUsd
        : Math.max(0, point.estimatedUsd - (unledgered[index]?.estimatedUsd ?? 0)),
  }));
  return { ledger, unledgered };
}

export function createEmptySnapshot(status: WidgetSourceStatus): WidgetSnapshotV1 {
  const now = Date.now();
  const empty = usage(now, now, 0, 0, 0, 0, status === 'loading' ? null : 0);
  const statusCounts: WidgetEntryStatusCounts = {
    available: 0,
    pending: 0,
    unreported: 0,
    ambiguous: 0,
    parseError: status === 'error' ? 1 : 0,
    unsupported: 0,
  };
  const periods = {
    today: empty,
    rolling24h: empty,
    rolling7d: empty,
    month: empty,
    ledgerCoverage: empty,
  };
  const emptyView = usageView({
    statusCounts,
    periods,
    trend60m: [],
    topModels: [],
    recentModels: [],
    latestRequest: null,
  });

  const snapshot: WidgetSnapshotV1 = {
    version: 1,
    computedAt: new Date(now).toISOString(),
    source: {
      status,
      installDir: '',
      collectorVersion: '1',
      parserVersion: '1',
      pricingVersion: '1',
      ledgerGeneratedAt: null,
      ledgerCoverageStartMs: null,
      ledgerCoverageEndMs: null,
      latestRequestAtMs: null,
      lastSuccessfulScanAtMs: null,
      lastReconcileAtMs: null,
      pendingFiles: 0,
      parseErrors: status === 'error' ? 1 : 0,
      unsupportedFiles: 0,
      possibleCoverageGap: status === 'offline' || status === 'error',
      messageCode: status,
    },
    statusCounts,
    periods,
    trend60m: [],
    topModels: [],
    recentModels: [],
    latestRequest: null,
    ledgerView: emptyView,
    unledgeredView: emptyView,
  };

  return snapshot;
}

export function createPreviewSnapshot(): WidgetSnapshotV1 {
  const now = Date.now();
  const minute = 60_000;
  const trend = Array.from({ length: 30 }, (_, index) => {
    const wave = Math.sin(index * 0.7) * 4_100;
    const burst = index % 8 === 0 ? 11_000 : 0;
    const totalTokens = Math.max(800, Math.round(6_500 + wave + burst + index * 170));
    return {
      startMs: now - (29 - index) * 2 * minute,
      requests: Math.max(1, Math.round(totalTokens / 5_800)),
      totalTokens,
      estimatedUsd: totalTokens * 0.0000024,
    };
  });
  const today = usage(now - 10 * 60 * minute, now, 126, 846_320, 531_870, 438_210, 2.846, 96_410);
  const rolling24h = usage(
    now - 24 * 60 * minute,
    now,
    211,
    1_486_320,
    891_870,
    728_210,
    4.912,
    152_400
  );
  const rolling7d = usage(
    now - 7 * 24 * 60 * minute,
    now,
    1_284,
    8_846_320,
    5_311_870,
    4_238_210,
    28.416,
    604_100
  );
  const month = usage(
    now - 15 * 24 * 60 * minute,
    now,
    2_941,
    18_486_320,
    11_891_870,
    9_728_210,
    64.912,
    1_152_400
  );
  const ledger = usage(
    now - 36 * 24 * 60 * minute,
    now,
    6_322,
    40_846_320,
    25_311_870,
    21_238_210,
    141.286,
    2_604_100
  );

  const unledgeredToday = usage(
    now - 10 * 60 * minute,
    now,
    6,
    48_120,
    29_430,
    23_880,
    0.154,
    12_300
  );
  const unledgered24h = usage(
    now - 24 * 60 * minute,
    now,
    7,
    54_820,
    31_600,
    27_330,
    0.171,
    12_300
  );
  const unledgered7d = usage(
    now - 7 * 24 * 60 * minute,
    now,
    7,
    54_820,
    31_600,
    27_330,
    0.171,
    12_300
  );
  const unledgeredMonth = usage(
    now - 15 * 24 * 60 * minute,
    now,
    7,
    54_820,
    31_600,
    27_330,
    0.171,
    12_300
  );
  const unledgeredCoverage = usage(
    now - 36 * 24 * 60 * minute,
    now,
    7,
    54_820,
    31_600,
    27_330,
    0.171,
    12_300
  );
  const ledgerPeriods = {
    today: subtractUsage(today, unledgeredToday),
    rolling24h: subtractUsage(rolling24h, unledgered24h),
    rolling7d: subtractUsage(rolling7d, unledgered7d),
    month: subtractUsage(month, unledgeredMonth),
    ledgerCoverage: subtractUsage(ledger, unledgeredCoverage),
  };
  const unledgeredPeriods = {
    today: unledgeredToday,
    rolling24h: unledgered24h,
    rolling7d: unledgered7d,
    month: unledgeredMonth,
    ledgerCoverage: unledgeredCoverage,
  };
  const split = splitTrend(trend);
  const ledgerRecentModels: WidgetRecentModel[] = [
    {
      model: 'gpt-5.4-mini',
      timestampMs: now - 4 * minute,
      totalTokens: 8_640,
      estimatedUsd: 0.0276,
    },
    {
      model: 'gpt-5.6-sol',
      timestampMs: now - 11 * minute,
      totalTokens: 21_330,
      estimatedUsd: null,
    },
  ];
  const unledgeredRecentModels: WidgetRecentModel[] = [
    {
      model: 'gpt-5.4-codex',
      timestampMs: now - 19_000,
      totalTokens: 14_820,
      estimatedUsd: 0.0412,
    },
  ];
  const ledgerView = usageView({
    statusCounts: {
      available: 120,
      pending: 0,
      unreported: 0,
      ambiguous: 0,
      parseError: 0,
      unsupported: 0,
    },
    periods: ledgerPeriods,
    trend60m: split.ledger,
    topModels: [
      {
        model: 'gpt-5.4-codex',
        ...usage(now - 10 * 60 * minute, now, 70, 510_100, 360_400, 264_900, 1.62),
      },
      {
        model: 'gpt-5.4-mini',
        ...usage(now - 10 * 60 * minute, now, 32, 211_300, 108_700, 115_500, 0.591),
      },
      {
        model: 'gpt-5.6-sol',
        ...usage(now - 10 * 60 * minute, now, 18, 82_920, 36_770, 37_810, null, 120_730),
      },
    ],
    recentModels: ledgerRecentModels,
    latestRequest: {
      model: 'gpt-5.4-mini',
      timestampMs: now - 4 * minute,
      status: 'available',
      totalTokens: 8_640,
      estimatedUsd: 0.0276,
    },
  });
  const unledgeredView = usageView({
    statusCounts: {
      available: 4,
      pending: 1,
      unreported: 0,
      ambiguous: 0,
      parseError: 0,
      unsupported: 1,
    },
    periods: unledgeredPeriods,
    trend60m: split.unledgered,
    topModels: [
      {
        model: 'gpt-5.4-codex',
        ...usage(now - 10 * 60 * minute, now, 4, 32_000, 22_000, 16_000, 0.12),
      },
      {
        model: 'gpt-5.4-mini',
        ...usage(now - 10 * 60 * minute, now, 2, 10_000, 4_000, 4_000, 0.0367),
      },
    ],
    recentModels: unledgeredRecentModels,
    latestRequest: {
      model: 'gpt-5.4-codex',
      timestampMs: now - 19_000,
      status: 'available',
      totalTokens: 14_820,
      estimatedUsd: 0.0412,
    },
  });

  const snapshot: WidgetSnapshotV1 = {
    version: 1,
    computedAt: new Date(now).toISOString(),
    source: {
      status: 'degraded',
      installDir: '',
      collectorVersion: 'preview',
      parserVersion: 'preview',
      pricingVersion: 'preview',
      ledgerGeneratedAt: new Date(now - 3 * minute).toISOString(),
      ledgerCoverageStartMs: ledger.fromMs,
      ledgerCoverageEndMs: now,
      latestRequestAtMs: now - 19_000,
      lastSuccessfulScanAtMs: now - 8_000,
      lastReconcileAtMs: now - 8_000,
      pendingFiles: 1,
      parseErrors: 0,
      unsupportedFiles: 1,
      possibleCoverageGap: false,
      messageCode: 'preview-data',
    },
    statusCounts: {
      available: 124,
      pending: 1,
      unreported: 0,
      ambiguous: 0,
      parseError: 0,
      unsupported: 1,
    },
    periods: { today, rolling24h, rolling7d, month, ledgerCoverage: ledger },
    trend60m: trend,
    topModels: [
      {
        model: 'gpt-5.4-codex',
        ...usage(now - 10 * 60 * minute, now, 74, 542_100, 382_400, 280_900, 1.74),
      },
      {
        model: 'gpt-5.4-mini',
        ...usage(now - 10 * 60 * minute, now, 34, 221_300, 112_700, 119_500, 0.6277),
      },
      {
        model: 'gpt-5.6-sol',
        ...usage(now - 10 * 60 * minute, now, 18, 82_920, 36_770, 37_810, null, 120_730),
      },
    ],
    recentModels: [
      {
        model: 'gpt-5.4-codex',
        timestampMs: now - 19_000,
        totalTokens: 14_820,
        estimatedUsd: 0.0412,
      },
      {
        model: 'gpt-5.4-mini',
        timestampMs: now - 4 * minute,
        totalTokens: 8_640,
        estimatedUsd: 0.0276,
      },
      {
        model: 'gpt-5.6-sol',
        timestampMs: now - 11 * minute,
        totalTokens: 21_330,
        estimatedUsd: null,
      },
    ],
    latestRequest: {
      model: 'gpt-5.4-codex',
      timestampMs: now - 19_000,
      status: 'available',
      totalTokens: 14_820,
      estimatedUsd: 0.0412,
    },
    ledgerView,
    unledgeredView,
  };

  return snapshot;
}

export function createPreviewMaintenance(): WidgetMaintenancePreviewV1 {
  const now = Date.now();
  return {
    version: 1,
    previewId: 'synthetic-maintenance-preview',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 2 * 60_000).toISOString(),
    ledgerGeneratedAt: new Date(now - 3 * 60_000).toISOString(),
    previousLedgerEntries: 6_315,
    projectedLedgerEntries: 6_322,
    previousAvailableRequests: 6_310,
    projectedAvailableRequests: 6_320,
    newLedgerFiles: 7,
    previousTotalTokens: 61_976_380,
    projectedTotalTokens: 62_084_530,
    prune: {
      eligibleFiles: 38,
      eligibleBytes: 186_420_736,
      keptActiveFiles: 5,
      keptUnrecordedFiles: 2,
      keptIncompleteFiles: 4,
      keptFingerprintMismatchFiles: 1,
      failedFiles: 0,
    },
  };
}

export function createPreviewMaintenanceResult(
  preview: WidgetMaintenancePreviewV1
): WidgetMaintenanceResultV1 {
  return {
    version: 1,
    completedAt: new Date().toISOString(),
    ledgerGeneratedAt: new Date().toISOString(),
    ledgerEntries: preview.projectedLedgerEntries,
    availableRequests: preview.projectedAvailableRequests,
    updatedLedgerFiles: preview.newLedgerFiles,
    previousTotalTokens: preview.previousTotalTokens,
    totalTokens: preview.projectedTotalTokens,
    totalPreserved: preview.projectedTotalTokens >= preview.previousTotalTokens,
    prune: {
      ...preview.prune,
      deletedFiles: preview.prune.eligibleFiles,
      deletedBytes: preview.prune.eligibleBytes,
    },
  };
}
