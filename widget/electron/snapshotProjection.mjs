const SOURCE_STATUSES = new Set(['loading', 'live', 'degraded', 'offline', 'error']);
const LATEST_STATUSES = new Set(['available', 'unpriced', 'pending']);
const MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER;
const MAX_TREND_POINTS = 60;
const MAX_TOP_MODELS = 20;
const MAX_RECENT_MODELS = 3;

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const asCount = (value) =>
  Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_COUNT ? value : null;

const asMoney = (value) =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000
    ? value
    : null;

const asNullableMoney = (value) => {
  if (value === null) return null;
  const money = asMoney(value);
  return money === null ? undefined : money;
};

const asTimestamp = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);

const asNullableTimestamp = (value) => {
  if (value === null) return null;
  const timestamp = asTimestamp(value);
  return timestamp === null ? undefined : timestamp;
};

const asIsoDate = (value) => {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    return null;
  }
  return value;
};

const asNullableIsoDate = (value) => {
  if (value === null) return null;
  const isoDate = asIsoDate(value);
  return isoDate === null ? undefined : isoDate;
};

const asSafeString = (value, maxLength) => {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) return null;
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
};

const asVersion = (value) => {
  const version = asSafeString(value, 40);
  return version && /^[a-z0-9._+-]+$/i.test(version) ? version : null;
};

const asMessageCode = (value) => {
  if (value === null) return null;
  return typeof value === 'string' && /^[a-z0-9._-]{1,80}$/i.test(value) ? value : undefined;
};

const projectCostSummary = (value) => {
  if (!isRecord(value)) return null;
  const estimatedUsd = asNullableMoney(value.estimatedUsd);
  const pricedTokens = asCount(value.pricedTokens);
  const unpricedTokens = asCount(value.unpricedTokens);
  const pricedRequests = asCount(value.pricedRequests);
  const unpricedRequests = asCount(value.unpricedRequests);
  if (
    estimatedUsd === undefined ||
    pricedTokens === null ||
    unpricedTokens === null ||
    pricedRequests === null ||
    unpricedRequests === null
  ) {
    return null;
  }
  return { estimatedUsd, pricedTokens, unpricedTokens, pricedRequests, unpricedRequests };
};

const projectUsage = (value) => {
  if (!isRecord(value)) return null;
  const cost = projectCostSummary(value);
  const fromMs = asNullableTimestamp(value.fromMs);
  const toMs = asNullableTimestamp(value.toMs);
  const requests = asCount(value.requests);
  const inputTokens = asCount(value.inputTokens);
  const cachedInputTokens = asCount(value.cachedInputTokens);
  const outputTokens = asCount(value.outputTokens);
  const reasoningTokens = asCount(value.reasoningTokens);
  const totalTokens = asCount(value.totalTokens);
  if (
    !cost ||
    fromMs === undefined ||
    toMs === undefined ||
    requests === null ||
    inputTokens === null ||
    cachedInputTokens === null ||
    outputTokens === null ||
    reasoningTokens === null ||
    totalTokens === null
  ) {
    return null;
  }
  return {
    fromMs,
    toMs,
    requests,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    ...cost,
  };
};

const projectSource = (value, expectedInstallDir) => {
  if (!isRecord(value) || !SOURCE_STATUSES.has(value.status)) return null;
  const collectorVersion = asVersion(value.collectorVersion);
  const parserVersion = asVersion(value.parserVersion);
  const pricingVersion = asVersion(value.pricingVersion);
  const ledgerGeneratedAt = asNullableIsoDate(value.ledgerGeneratedAt);
  const ledgerCoverageStartMs = asNullableTimestamp(value.ledgerCoverageStartMs);
  const ledgerCoverageEndMs = asNullableTimestamp(value.ledgerCoverageEndMs);
  const latestRequestAtMs = asNullableTimestamp(value.latestRequestAtMs);
  const lastSuccessfulScanAtMs = asNullableTimestamp(value.lastSuccessfulScanAtMs);
  const lastReconcileAtMs = asNullableTimestamp(value.lastReconcileAtMs);
  const pendingFiles = asCount(value.pendingFiles);
  const parseErrors = asCount(value.parseErrors);
  const unsupportedFiles = asCount(value.unsupportedFiles);
  const messageCode = asMessageCode(value.messageCode);
  if (
    !collectorVersion ||
    !parserVersion ||
    !pricingVersion ||
    ledgerGeneratedAt === undefined ||
    ledgerCoverageStartMs === undefined ||
    ledgerCoverageEndMs === undefined ||
    latestRequestAtMs === undefined ||
    lastSuccessfulScanAtMs === undefined ||
    lastReconcileAtMs === undefined ||
    pendingFiles === null ||
    parseErrors === null ||
    unsupportedFiles === null ||
    typeof value.possibleCoverageGap !== 'boolean' ||
    messageCode === undefined
  ) {
    return null;
  }
  return {
    status: value.status,
    installDir: expectedInstallDir,
    collectorVersion,
    parserVersion,
    pricingVersion,
    ledgerGeneratedAt,
    ledgerCoverageStartMs,
    ledgerCoverageEndMs,
    latestRequestAtMs,
    lastSuccessfulScanAtMs,
    lastReconcileAtMs,
    pendingFiles,
    parseErrors,
    unsupportedFiles,
    possibleCoverageGap: value.possibleCoverageGap,
    messageCode,
  };
};

const projectStatusCounts = (value) => {
  if (!isRecord(value)) return null;
  const fields = ['available', 'pending', 'unreported', 'ambiguous', 'parseError', 'unsupported'];
  const projected = {};
  for (const field of fields) {
    const count = asCount(value[field]);
    if (count === null) return null;
    projected[field] = count;
  }
  return projected;
};

const projectPeriods = (value) => {
  if (!isRecord(value)) return null;
  const keys = ['today', 'rolling24h', 'rolling7d', 'month', 'ledgerCoverage'];
  const projected = {};
  for (const key of keys) {
    const usage = projectUsage(value[key]);
    if (!usage) return null;
    projected[key] = usage;
  }
  return projected;
};

const projectTrendPoint = (value) => {
  if (!isRecord(value)) return null;
  const startMs = asTimestamp(value.startMs);
  const requests = asCount(value.requests);
  const totalTokens = asCount(value.totalTokens);
  const estimatedUsd = asNullableMoney(value.estimatedUsd);
  if (startMs === null || requests === null || totalTokens === null || estimatedUsd === undefined) {
    return null;
  }
  return { startMs, requests, totalTokens, estimatedUsd };
};

const projectModelUsage = (value) => {
  if (!isRecord(value)) return null;
  const model = asSafeString(value.model, 120);
  const cost = projectCostSummary(value);
  const requests = asCount(value.requests);
  const inputTokens = asCount(value.inputTokens);
  const cachedInputTokens = asCount(value.cachedInputTokens);
  const outputTokens = asCount(value.outputTokens);
  const reasoningTokens = asCount(value.reasoningTokens);
  const totalTokens = asCount(value.totalTokens);
  if (
    !model ||
    !cost ||
    requests === null ||
    inputTokens === null ||
    cachedInputTokens === null ||
    outputTokens === null ||
    reasoningTokens === null ||
    totalTokens === null
  ) {
    return null;
  }
  return {
    model,
    requests,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    ...cost,
  };
};

const projectLatestRequest = (value) => {
  if (value === null) return null;
  if (!isRecord(value) || !LATEST_STATUSES.has(value.status)) return undefined;
  const model = asSafeString(value.model, 120);
  const timestampMs = asTimestamp(value.timestampMs);
  const totalTokens = asCount(value.totalTokens);
  const estimatedUsd = asNullableMoney(value.estimatedUsd);
  if (!model || timestampMs === null || totalTokens === null || estimatedUsd === undefined) {
    return undefined;
  }
  return { model, timestampMs, status: value.status, totalTokens, estimatedUsd };
};

const projectRecentModel = (value) => {
  if (!isRecord(value)) return null;
  const model = asSafeString(value.model, 120);
  const timestampMs = asTimestamp(value.timestampMs);
  const totalTokens = asCount(value.totalTokens);
  const estimatedUsd = asNullableMoney(value.estimatedUsd);
  if (!model || timestampMs === null || totalTokens === null || estimatedUsd === undefined) {
    return null;
  }
  return { model, timestampMs, totalTokens, estimatedUsd };
};

const projectUsageView = (value) => {
  if (!isRecord(value)) return null;
  const statusCounts = projectStatusCounts(value.statusCounts);
  const periods = projectPeriods(value.periods);
  if (
    !statusCounts ||
    !periods ||
    !Array.isArray(value.trend60m) ||
    value.trend60m.length > MAX_TREND_POINTS ||
    !Array.isArray(value.topModels) ||
    value.topModels.length > MAX_TOP_MODELS ||
    !Array.isArray(value.recentModels) ||
    value.recentModels.length > MAX_RECENT_MODELS
  ) {
    return null;
  }

  const trend60m = value.trend60m.map(projectTrendPoint);
  const topModels = value.topModels.map(projectModelUsage);
  const recentModels = value.recentModels.map(projectRecentModel);
  const latestRequest = projectLatestRequest(value.latestRequest);
  if (
    trend60m.some((item) => item === null) ||
    topModels.some((item) => item === null) ||
    recentModels.some((item) => item === null) ||
    latestRequest === undefined
  ) {
    return null;
  }

  return { statusCounts, periods, trend60m, topModels, recentModels, latestRequest };
};

export const projectWidgetSnapshotV1 = (value, expectedInstallDir) => {
  if (!isRecord(value) || value.version !== 1) return null;
  const installDir = asSafeString(expectedInstallDir, 260);
  const computedAt = asIsoDate(value.computedAt);
  const source = installDir ? projectSource(value.source, installDir) : null;
  const statusCounts = projectStatusCounts(value.statusCounts);
  const periods = projectPeriods(value.periods);
  const ledgerView = projectUsageView(value.ledgerView);
  const unledgeredView = projectUsageView(value.unledgeredView);
  if (
    !computedAt ||
    !source ||
    !statusCounts ||
    !periods ||
    !ledgerView ||
    !unledgeredView ||
    !Array.isArray(value.trend60m) ||
    value.trend60m.length > MAX_TREND_POINTS ||
    !Array.isArray(value.topModels) ||
    value.topModels.length > MAX_TOP_MODELS ||
    (value.recentModels !== undefined && !Array.isArray(value.recentModels)) ||
    (Array.isArray(value.recentModels) && value.recentModels.length > MAX_RECENT_MODELS)
  ) {
    return null;
  }

  const trend60m = value.trend60m.map(projectTrendPoint);
  const topModels = value.topModels.map(projectModelUsage);
  const recentModels = (value.recentModels ?? []).map(projectRecentModel);
  const latestRequest = projectLatestRequest(value.latestRequest);
  if (
    trend60m.some((item) => item === null) ||
    topModels.some((item) => item === null) ||
    recentModels.some((item) => item === null)
  ) {
    return null;
  }
  if (latestRequest === undefined) return null;

  return {
    version: 1,
    computedAt,
    source,
    statusCounts,
    periods,
    trend60m,
    topModels,
    recentModels,
    latestRequest,
    ledgerView,
    unledgeredView,
  };
};
