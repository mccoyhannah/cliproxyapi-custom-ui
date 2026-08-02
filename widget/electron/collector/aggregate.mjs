import {
  TOKEN_LOG_CORE_VERSION,
  dedupeTokenEntries,
} from '../../../scripts/lib/token-log-core.mjs';
import {
  TOKEN_PRICING_VERSION,
  createTokenCostEstimator,
} from '../../../scripts/lib/token-pricing-core.mjs';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const MAX_TREND_POINTS = 60;
const UNRECOGNIZED_MODEL = '未识别模型';

export const TOKEN_COLLECTOR_VERSION = '1.2.0';

const finiteNumber = (value, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const emptyCost = () => ({
  estimatedUsd: null,
  pricedTokens: 0,
  unpricedTokens: 0,
  pricedRequests: 0,
  unpricedRequests: 0,
});

const emptyTotals = (fromMs, toMs) => ({
  ...emptyCost(),
  fromMs,
  toMs,
  requests: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
});

const applyAvailableEntry = (target, entry, costForEntry) => {
  const usage = entry.tokenUsage;
  target.inputTokens += finiteNumber(usage.input);
  target.cachedInputTokens += Math.min(finiteNumber(usage.cached), finiteNumber(usage.input));
  target.outputTokens += finiteNumber(usage.output);
  target.reasoningTokens += Math.min(finiteNumber(usage.reasoning), finiteNumber(usage.output));
  target.totalTokens += finiteNumber(usage.total);

  const estimate = costForEntry(entry);
  if (estimate.pricingPattern) {
    target.estimatedUsd = (target.estimatedUsd ?? 0) + estimate.costUsd;
    target.pricedTokens += estimate.pricedTokens;
    target.pricedRequests += 1;
  } else {
    target.unpricedTokens += estimate.unpricedTokens;
    target.unpricedRequests += 1;
  }
};

const buildTotals = (entries, fromMs, toMs, costForEntry) => {
  const totals = emptyTotals(fromMs, toMs);
  totals.requests = entries.filter((entry) => entry.status === 'available').length;
  for (const entry of entries) {
    if (entry.status !== 'available') continue;
    applyAvailableEntry(totals, entry, costForEntry);
  }
  return totals;
};

const entriesInRange = (entries, startMs, endMs) =>
  entries.filter(
    (entry) =>
      Number.isFinite(entry.timestampMs) &&
      entry.timestampMs >= startMs &&
      entry.timestampMs <= endMs
  );

const calculateSpan = (entries) => {
  let start = null;
  let end = null;
  for (const entry of entries) {
    if (!Number.isFinite(entry.timestampMs)) continue;
    if (start === null || entry.timestampMs < start) start = entry.timestampMs;
    if (end === null || entry.timestampMs > end) end = entry.timestampMs;
  }
  return { start, end };
};

const buildStatusCounts = (entries) => {
  const counts = {
    available: 0,
    pending: 0,
    unreported: 0,
    ambiguous: 0,
    parseError: 0,
    unsupported: 0,
  };
  for (const entry of entries) {
    if (entry.status === 'parse-error') counts.parseError += 1;
    else if (Object.hasOwn(counts, entry.status)) counts[entry.status] += 1;
  }
  return counts;
};

const buildTrend = (entries, nowMs, costForEntry) => {
  const currentMinuteStart = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS;
  const firstMinuteStart = currentMinuteStart - 59 * MINUTE_MS;
  const points = Array.from({ length: 60 }, (_, index) => ({
    startMs: firstMinuteStart + index * MINUTE_MS,
    requests: 0,
    totalTokens: 0,
    estimatedUsd: null,
  }));

  for (const entry of entries) {
    if (!Number.isFinite(entry.timestampMs)) continue;
    const bucket = Math.floor((entry.timestampMs - firstMinuteStart) / MINUTE_MS);
    if (bucket < 0 || bucket >= points.length) continue;
    if (entry.status !== 'available') continue;
    const point = points[bucket];
    point.requests += 1;
    point.totalTokens += finiteNumber(entry.tokenUsage.total);
    const estimate = costForEntry(entry);
    if (estimate.pricingPattern) {
      point.estimatedUsd = (point.estimatedUsd ?? 0) + estimate.costUsd;
    }
  }
  return points;
};

const emptyTrendPoint = (startMs) => ({
  startMs,
  requests: 0,
  totalTokens: 0,
  estimatedUsd: null,
});

const addTrendEntry = (point, entry, costForEntry) => {
  point.requests += 1;
  point.totalTokens += finiteNumber(entry.tokenUsage.total);
  const estimate = costForEntry(entry);
  if (estimate.pricingPattern) {
    point.estimatedUsd = (point.estimatedUsd ?? 0) + estimate.costUsd;
  }
};

const localHourStart = (timestampMs) => {
  const date = new Date(timestampMs);
  date.setMinutes(0, 0, 0);
  return date.getTime();
};

const localDayStart = (timestampMs) => {
  const date = new Date(timestampMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
};

const nextLocalBucketStart = (timestampMs, granularity) => {
  const date = new Date(timestampMs);
  if (granularity === 'hour') {
    date.setHours(date.getHours() + 1, 0, 0, 0);
  } else {
    date.setDate(date.getDate() + 1);
    date.setHours(0, 0, 0, 0);
  }
  return date.getTime();
};

const calendarBucketStarts = (fromMs, toMs, granularity) => {
  const starts = [];
  let cursor = granularity === 'hour' ? localHourStart(fromMs) : localDayStart(fromMs);
  const end = granularity === 'hour' ? localHourStart(toMs) : localDayStart(toMs);
  while (cursor <= end) {
    starts.push(cursor);
    const next = nextLocalBucketStart(cursor, granularity);
    if (next <= cursor) break;
    cursor = next;
  }
  return starts;
};

const downsampleTrendPoints = (points, maxPoints = MAX_TREND_POINTS) => {
  if (points.length <= maxPoints) return points;
  const groupSize = Math.ceil(points.length / maxPoints);
  const sampled = [];
  for (let index = 0; index < points.length; index += groupSize) {
    const group = points.slice(index, index + groupSize);
    const estimatedUsd = group.some((point) => point.estimatedUsd !== null)
      ? group.reduce((sum, point) => sum + (point.estimatedUsd ?? 0), 0)
      : null;
    sampled.push({
      startMs: group[0].startMs,
      requests: group.reduce((sum, point) => sum + point.requests, 0),
      totalTokens: group.reduce((sum, point) => sum + point.totalTokens, 0),
      estimatedUsd,
    });
  }
  return sampled;
};

const buildTrendSeries = ({
  entries,
  fromMs,
  toMs,
  granularity,
  fixedUnitMs = null,
  costForEntry,
}) => {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs > toMs) {
    return { fromMs: null, toMs: null, granularity, points: [] };
  }

  const starts = fixedUnitMs
    ? Array.from(
        { length: Math.max(1, Math.ceil((toMs - fromMs) / fixedUnitMs)) },
        (_, index) => fromMs + index * fixedUnitMs
      )
    : calendarBucketStarts(fromMs, toMs, granularity);
  const points = starts.map(emptyTrendPoint);

  for (const entry of entries) {
    if (entry.status !== 'available' || !Number.isFinite(entry.timestampMs)) continue;
    if (entry.timestampMs < fromMs || entry.timestampMs > toMs) continue;
    let bucket = fixedUnitMs
      ? Math.floor((entry.timestampMs - fromMs) / fixedUnitMs)
      : starts.findLastIndex((startMs) => startMs <= entry.timestampMs);
    bucket = Math.min(points.length - 1, Math.max(0, bucket));
    addTrendEntry(points[bucket], entry, costForEntry);
  }

  return {
    fromMs,
    toMs,
    granularity,
    points: downsampleTrendPoints(points),
  };
};

const buildPeriodTrends = ({
  entries,
  nowMs,
  costForEntry,
  coverageStartMs,
  coverageEndMs,
  span,
}) => {
  const todayStart = localDayStart(nowMs);
  const monthStart = new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), 1).getTime();
  const coverageStart = coverageStartMs ?? span.start;
  const coverageEnd = coverageEndMs ?? span.end;
  return {
    today: buildTrendSeries({
      entries,
      fromMs: todayStart,
      toMs: nowMs,
      granularity: 'hour',
      costForEntry,
    }),
    rolling24h: buildTrendSeries({
      entries,
      fromMs: nowMs - DAY_MS,
      toMs: nowMs,
      granularity: 'hour',
      fixedUnitMs: HOUR_MS,
      costForEntry,
    }),
    rolling7d: buildTrendSeries({
      entries,
      fromMs: nowMs - 7 * DAY_MS,
      toMs: nowMs,
      granularity: 'day',
      fixedUnitMs: DAY_MS,
      costForEntry,
    }),
    month: buildTrendSeries({
      entries,
      fromMs: monthStart,
      toMs: nowMs,
      granularity: 'day',
      costForEntry,
    }),
    ledgerCoverage: buildTrendSeries({
      entries,
      fromMs: coverageStart,
      toMs: coverageEnd,
      granularity: 'day',
      costForEntry,
    }),
  };
};

const buildTopModels = (entries, costForEntry) => {
  const groups = new Map();
  for (const entry of entries) {
    if (entry.status !== 'available') continue;
    const model = entry.model ?? UNRECOGNIZED_MODEL;
    const current = groups.get(model) ?? {
      model,
      ...emptyCost(),
      requests: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    };
    current.requests += 1;
    applyAvailableEntry(current, entry, costForEntry);
    groups.set(model, current);
  }

  return [...groups.values()]
    .sort((left, right) => right.totalTokens - left.totalTokens)
    .slice(0, 8);
};

const buildLatestRequest = (entries, costForEntry) => {
  const latest = entries
    .filter((entry) => entry.status === 'available' && Number.isFinite(entry.timestampMs))
    .sort((left, right) => right.timestampMs - left.timestampMs)[0];
  if (!latest) return null;

  const estimate = costForEntry(latest);
  return {
    model: latest.model ?? UNRECOGNIZED_MODEL,
    timestampMs: latest.timestampMs,
    status: estimate.pricingPattern ? 'available' : 'unpriced',
    totalTokens: finiteNumber(latest.tokenUsage.total),
    estimatedUsd: estimate.pricingPattern ? estimate.costUsd : null,
  };
};

const buildRecentModels = (entries, costForEntry) => {
  const models = [];
  const seenModels = new Set();
  const completed = entries
    .filter((entry) => entry.status === 'available' && Number.isFinite(entry.timestampMs))
    .sort((left, right) => right.timestampMs - left.timestampMs);

  for (const entry of completed) {
    const model = entry.model ?? UNRECOGNIZED_MODEL;
    if (seenModels.has(model)) continue;
    const estimate = costForEntry(entry);
    models.push({
      model,
      timestampMs: entry.timestampMs,
      totalTokens: finiteNumber(entry.tokenUsage.total),
      estimatedUsd: estimate.pricingPattern ? estimate.costUsd : null,
    });
    seenModels.add(model);
    if (models.length === 3) break;
  }

  return models;
};

const buildUsageView = ({
  entries,
  nowMs,
  costForEntry,
  coverageStartMs = null,
  coverageEndMs = null,
}) => {
  const deduped = dedupeTokenEntries(entries);
  const todayStart = new Date(
    new Date(nowMs).getFullYear(),
    new Date(nowMs).getMonth(),
    new Date(nowMs).getDate()
  ).getTime();
  const monthStart = new Date(
    new Date(nowMs).getFullYear(),
    new Date(nowMs).getMonth(),
    1
  ).getTime();
  const rolling24hStart = nowMs - DAY_MS;
  const rolling7dStart = nowMs - 7 * DAY_MS;
  const span = calculateSpan(deduped);
  const statusCounts = buildStatusCounts(deduped);
  const latestRequest = buildLatestRequest(deduped, costForEntry);
  const trends = buildPeriodTrends({
    entries: deduped,
    nowMs,
    costForEntry,
    coverageStartMs,
    coverageEndMs,
    span,
  });

  return {
    statusCounts,
    periods: {
      today: buildTotals(
        entriesInRange(deduped, todayStart, nowMs),
        todayStart,
        nowMs,
        costForEntry
      ),
      rolling24h: buildTotals(
        entriesInRange(deduped, rolling24hStart, nowMs),
        rolling24hStart,
        nowMs,
        costForEntry
      ),
      rolling7d: buildTotals(
        entriesInRange(deduped, rolling7dStart, nowMs),
        rolling7dStart,
        nowMs,
        costForEntry
      ),
      month: buildTotals(
        entriesInRange(deduped, monthStart, nowMs),
        monthStart,
        nowMs,
        costForEntry
      ),
      ledgerCoverage: buildTotals(
        deduped,
        coverageStartMs ?? span.start,
        coverageEndMs ?? span.end,
        costForEntry
      ),
    },
    trend60m: buildTrend(deduped, nowMs, costForEntry),
    trends,
    topModels: buildTopModels(deduped, costForEntry),
    recentModels: buildRecentModels(deduped, costForEntry),
    latestRequest,
  };
};

export function buildWidgetSnapshot({
  entries,
  ledgerEntries = entries,
  liveEntries = [],
  nowMs = Date.now(),
  installDir,
  source = {},
  pricingOverrides = [],
}) {
  const estimateCost = createTokenCostEstimator(pricingOverrides);
  const entryCostCache = new WeakMap();
  const costForEntry = (entry) => {
    const cached = entryCostCache.get(entry);
    if (cached) return cached;
    const estimate = estimateCost(entry.model ?? '', entry.tokenUsage);
    entryCostCache.set(entry, estimate);
    return estimate;
  };

  const dedupedLedger = dedupeTokenEntries(ledgerEntries);
  const ledgerDedupeKeys = new Set(dedupedLedger.map((entry) => entry.dedupeKey));
  const unledgeredEntries = dedupeTokenEntries(liveEntries).filter(
    (entry) => entry.status === 'available' && !ledgerDedupeKeys.has(entry.dedupeKey)
  );
  const currentView = buildUsageView({
    entries,
    nowMs,
    costForEntry,
    coverageStartMs: source.ledgerCoverageStartMs ?? null,
  });
  const ledgerView = buildUsageView({
    entries: dedupedLedger,
    nowMs,
    costForEntry,
    coverageStartMs: source.ledgerCoverageStartMs ?? null,
    coverageEndMs: source.ledgerCoverageEndMs ?? null,
  });
  const unledgeredView = buildUsageView({
    entries: unledgeredEntries,
    nowMs,
    costForEntry,
  });

  return {
    version: 1,
    computedAt: new Date(nowMs).toISOString(),
    source: {
      status: source.status ?? 'loading',
      installDir,
      collectorVersion: TOKEN_COLLECTOR_VERSION,
      parserVersion: TOKEN_LOG_CORE_VERSION,
      pricingVersion: TOKEN_PRICING_VERSION,
      ledgerGeneratedAt: source.ledgerGeneratedAt ?? null,
      ledgerCoverageStartMs:
        source.ledgerCoverageStartMs ?? ledgerView.periods.ledgerCoverage.fromMs,
      ledgerCoverageEndMs: source.ledgerCoverageEndMs ?? ledgerView.periods.ledgerCoverage.toMs,
      latestRequestAtMs: currentView.latestRequest?.timestampMs ?? null,
      lastSuccessfulScanAtMs: source.lastSuccessfulScanAtMs ?? null,
      lastReconcileAtMs: source.lastReconcileAtMs ?? null,
      pendingFiles: source.pendingFiles ?? currentView.statusCounts.pending,
      parseErrors: source.parseErrors ?? currentView.statusCounts.parseError,
      unsupportedFiles: source.unsupportedFiles ?? currentView.statusCounts.unsupported,
      possibleCoverageGap: source.possibleCoverageGap ?? false,
      messageCode: source.messageCode ?? null,
    },
    ...currentView,
    ledgerView,
    unledgeredView,
  };
}
