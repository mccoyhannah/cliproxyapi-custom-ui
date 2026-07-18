import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, RefObject } from 'react';
import {
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  CloseIcon,
  CloudOffIcon,
  CollapseIcon,
  ExpandIcon,
  HideIcon,
  PinIcon,
  PlusIcon,
  PulseIcon,
  SlidersIcon,
  TrashIcon,
} from './icons';
import type {
  WidgetMaintenancePreviewV1,
  WidgetMaintenanceResultV1,
  WidgetModelUsage,
  WidgetPricingOverride,
  WidgetRecentModel,
  WidgetSettings,
  WidgetSnapshotV1,
  WidgetSourceStatus,
  WidgetTrendPoint,
  WidgetUsageView,
  WidgetUsageTotals,
} from './shared/contracts';
import {
  createEmptySnapshot,
  createPreviewMaintenance,
  createPreviewMaintenanceResult,
  createPreviewSnapshot,
} from './synthetic';
import { describeLedgerMaintenanceError } from './maintenanceErrors';

type PeriodKey = keyof WidgetSnapshotV1['periods'];
type PricingRuleDraft = WidgetPricingOverride & { draftId: number };
type UsageViewMode = 'combined' | 'ledger';
type MaintenanceBusyState = 'preview' | 'execute' | null;

let pricingRuleDraftSequence = 0;
const POST_VERIFICATION_PENDING_MESSAGE =
  '入账清理可能已完成，仅刷新复核失败；请勿重复执行，等待数据刷新或重新打开挂件。';

function createPricingRuleDraft(rule: WidgetPricingOverride): PricingRuleDraft {
  pricingRuleDraftSequence += 1;
  return { ...rule, draftId: pricingRuleDraftSequence };
}

const DEFAULT_SETTINGS: WidgetSettings = {
  alwaysOnTop: true,
  expanded: false,
  pricingOverrides: [],
};

const PERIODS: Array<{ key: PeriodKey; label: string; shortLabel: string }> = [
  { key: 'today', label: '今天', shortLabel: '今日' },
  { key: 'rolling24h', label: '24 小时', shortLabel: '24H' },
  { key: 'rolling7d', label: '7 天', shortLabel: '7D' },
  { key: 'month', label: '本月', shortLabel: '本月' },
  { key: 'ledgerCoverage', label: '账本覆盖期', shortLabel: '账本' },
];

const STATUS_COPY: Record<WidgetSourceStatus, { label: string; detail: string }> = {
  loading: { label: '加载中', detail: '正在读取本地汇总' },
  live: { label: '实时', detail: '本地采集器在线' },
  degraded: { label: '降级', detail: '部分记录需要关注' },
  offline: { label: '离线', detail: '暂时无法读取本地数据' },
  error: { label: '异常', detail: '采集器返回了错误状态' },
};

function formatTokens(value: number): string {
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (absolute >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (absolute >= 100_000) return `${Math.round(value / 1_000)}K`;
  if (absolute >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString('zh-CN');
}

function formatUsd(value: number | null): string {
  if (value === null) return '待设价格';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

function formatRelativeTime(timestampMs: number | null): string {
  if (!timestampMs) return '尚无记录';
  const difference = Math.max(0, Date.now() - timestampMs);
  if (difference < 10_000) return '刚刚';
  if (difference < 60_000) return `${Math.floor(difference / 1_000)} 秒前`;
  if (difference < 3_600_000) return `${Math.floor(difference / 60_000)} 分钟前`;
  if (difference < 86_400_000) return `${Math.floor(difference / 3_600_000)} 小时前`;
  return `${Math.floor(difference / 86_400_000)} 天前`;
}

function formatDate(timestampMs: number | null): string {
  if (!timestampMs) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(timestampMs);
}

function formatClock(value: string): string {
  const timestampMs = Date.parse(value);
  if (!Number.isFinite(timestampMs)) return '稍后';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestampMs);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** unitIndex;
  const digits = amount >= 100 || unitIndex === 0 ? 0 : amount >= 10 ? 1 : 2;
  return `${amount.toFixed(digits)} ${units[unitIndex]}`;
}

function formatSignedTokens(value: number): string {
  return `${value > 0 ? '+' : ''}${formatTokens(value)}`;
}

function pricingCoverage(usage: WidgetUsageTotals | WidgetModelUsage): number {
  const denominator = usage.pricedTokens + usage.unpricedTokens;
  if (denominator <= 0) return 0;
  return Math.min(100, Math.max(0, (usage.pricedTokens / denominator) * 100));
}

function formatPricingCoverage(coverage: number, hasUnpricedTokens: boolean): string {
  const bounded = Math.min(100, Math.max(0, coverage));
  if (hasUnpricedTokens && bounded >= 99.5) {
    return `${Math.min(99.9, bounded).toFixed(1)}%`;
  }
  return `${bounded.toFixed(0)}%`;
}

function getRecentModels(
  snapshot: Pick<WidgetSnapshotV1, 'recentModels' | 'latestRequest'>
): WidgetRecentModel[] {
  const recentModels = (
    snapshot as Pick<WidgetSnapshotV1, 'latestRequest'> & {
      recentModels?: WidgetRecentModel[];
    }
  ).recentModels;
  if (recentModels && recentModels.length > 0) return recentModels.slice(0, 3);

  const latest = snapshot.latestRequest?.status === 'pending' ? null : snapshot.latestRequest;
  return latest
    ? [
        {
          model: latest.model,
          timestampMs: latest.timestampMs,
          totalTokens: latest.totalTokens,
          estimatedUsd: latest.estimatedUsd,
        },
      ]
    : [];
}

function getCombinedView(snapshot: WidgetSnapshotV1): WidgetUsageView {
  return {
    statusCounts: snapshot.statusCounts,
    periods: snapshot.periods,
    trend60m: snapshot.trend60m,
    topModels: snapshot.topModels,
    recentModels: snapshot.recentModels,
    latestRequest: snapshot.latestRequest,
  };
}

function getCompatibleViews(snapshot: WidgetSnapshotV1): {
  combined: WidgetUsageView;
  ledger: WidgetUsageView;
  unledgered: WidgetUsageView;
} {
  const combined = getCombinedView(snapshot);
  const compatibleSnapshot = snapshot as WidgetSnapshotV1 & {
    ledgerView?: WidgetUsageView;
    unledgeredView?: WidgetUsageView;
  };
  const emptySnapshot = createEmptySnapshot(snapshot.source.status);
  return {
    combined,
    ledger: compatibleSnapshot.ledgerView ?? combined,
    unledgered: compatibleSnapshot.unledgeredView ?? getCombinedView(emptySnapshot),
  };
}

function mergeSnapshot(current: WidgetSnapshotV1, next: WidgetSnapshotV1): WidgetSnapshotV1 {
  const currentTime = Date.parse(current.computedAt);
  const nextTime = Date.parse(next.computedAt);
  if (Number.isNaN(currentTime) || Number.isNaN(nextTime) || nextTime >= currentTime) return next;
  return current;
}

function SourceBadge({ status, preview }: { status: WidgetSourceStatus; preview: boolean }) {
  const copy = preview ? { label: '预览', detail: '合成样本数据' } : STATUS_COPY[status];
  return (
    <span
      className={`source-badge source-badge--${preview ? 'preview' : status}`}
      title={copy.detail}
    >
      <span className="source-badge__dot" />
      {copy.label}
    </span>
  );
}

function IconButton({
  label,
  active = false,
  children,
  onClick,
}: {
  label: string;
  active?: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={active || undefined}
      className={`icon-button no-drag${active ? ' icon-button--active' : ''}`}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  );
}

function AppHeader({
  settings,
  status,
  preview,
  onTogglePin,
  onToggleExpanded,
  onHide,
}: {
  settings: WidgetSettings;
  status: WidgetSourceStatus;
  preview: boolean;
  onTogglePin: () => void;
  onToggleExpanded: () => void;
  onHide: () => void;
}) {
  return (
    <header className="app-header drag-region">
      <div className="brand-lockup">
        <span className="brand-mark">
          <PulseIcon size={17} />
        </span>
        <span className="brand-name">CPA PULSE</span>
        <SourceBadge preview={preview} status={status} />
      </div>
      <div className="window-actions">
        <IconButton active={settings.alwaysOnTop} label="切换窗口置顶" onClick={onTogglePin}>
          <PinIcon size={14} />
        </IconButton>
        <IconButton
          label={settings.expanded ? '切换到紧凑模式' : '展开详细信息'}
          onClick={onToggleExpanded}
        >
          {settings.expanded ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
        </IconButton>
        <IconButton label="隐藏到系统托盘" onClick={onHide}>
          <HideIcon size={14} />
        </IconButton>
      </div>
    </header>
  );
}

function CostSummary({ usage, compact = false }: { usage: WidgetUsageTotals; compact?: boolean }) {
  const coverage = pricingCoverage(usage);
  const hasKnownPrice = usage.estimatedUsd !== null && usage.pricedTokens > 0;
  const hasUnpricedTokens = usage.unpricedTokens > 0;
  return (
    <div className={`cost-summary${compact ? ' cost-summary--compact' : ''}`}>
      <div className="cost-summary__label">
        <span>{hasUnpricedTokens ? '已计价部分估算' : 'API 标准价估算'}</span>
        {hasUnpricedTokens && !compact && <span className="partial-pill">非完整</span>}
      </div>
      <strong className={hasKnownPrice ? '' : 'is-unpriced'}>
        {hasKnownPrice ? `≈ ${formatUsd(usage.estimatedUsd)}` : '待设价格'}
      </strong>
      {compact && hasUnpricedTokens && (
        <span className="cost-summary__unpriced">
          待设价格 {formatTokens(usage.unpricedTokens)} Token
        </span>
      )}
      <div className="coverage-line">
        <span className="coverage-track" aria-hidden="true">
          <span style={{ width: `${coverage}%` }} />
        </span>
        <span>{formatPricingCoverage(coverage, hasUnpricedTokens)} 计价覆盖</span>
      </div>
    </div>
  );
}

function TokenMix({ usage, compact = false }: { usage: WidgetUsageTotals; compact?: boolean }) {
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cached = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens));
  const output = Math.max(0, usage.outputTokens);
  const plottedTotal = Math.max(1, uncached + cached + output);
  const items = [
    { key: 'input', label: '输入', value: uncached, tone: 'input' },
    { key: 'cached', label: '缓存', value: cached, tone: 'cached' },
    { key: 'output', label: '输出', value: output, tone: 'output' },
  ];

  return (
    <div className={`token-mix${compact ? ' token-mix--compact' : ''}`}>
      <div className="token-mix__bar" aria-label="Token 构成">
        {items.map((item) => (
          <span
            className={`token-segment token-segment--${item.tone}`}
            key={item.key}
            style={{ width: `${(item.value / plottedTotal) * 100}%` }}
          />
        ))}
      </div>
      <div className="token-mix__legend">
        {items.map((item) => (
          <span className={`mix-legend mix-legend--${item.tone}`} key={item.key}>
            <i aria-hidden="true" />
            <span>{item.label}</span>
            <b>{formatTokens(item.value)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

function Sparkline({ points, compact = false }: { points: WidgetTrendPoint[]; compact?: boolean }) {
  const rawId = useId();
  const gradientId = `spark-fill-${rawId.replaceAll(':', '')}`;
  const width = compact ? 220 : 390;
  const height = compact ? 40 : 72;
  const padding = compact ? 5 : 4;
  const bottomPadding = compact ? padding : 22;
  const values = points.length > 0 ? points.map((point) => point.totalTokens) : [0, 0];
  const hasActivity = values.some((value) => value > 0);
  const maximum = Math.max(...values, 1);
  const minimum = Math.min(...values, 0);
  const range = Math.max(1, maximum - minimum);
  const coordinates = values.map((value, index) => {
    const x = padding + (index / Math.max(1, values.length - 1)) * (width - padding * 2);
    const y = hasActivity
      ? padding + ((maximum - value) / range) * (height - padding - bottomPadding)
      : height * 0.42;
    return { x, y };
  });
  const linePath = coordinates
    .map((point, index) => `${index === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(' ');
  const areaPath = `${linePath} L${coordinates.at(-1)?.x ?? width},${height} L${coordinates[0]?.x ?? 0},${height} Z`;
  const lastPoint = coordinates.at(-1) ?? { x: width, y: height };

  return (
    <svg
      aria-label="最近 60 分钟 Token 趋势"
      className={`sparkline${hasActivity ? '' : ' sparkline--idle'}`}
      preserveAspectRatio="none"
      role="img"
      viewBox={`0 0 ${width} ${height}`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="var(--teal)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--teal)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path className="sparkline__grid" d={`M0 ${height * 0.68}H${width}`} />
      {hasActivity && <path d={areaPath} fill={`url(#${gradientId})`} />}
      <path className="sparkline__line" d={linePath} />
      {hasActivity && points.length > 0 && (
        <>
          <circle className="sparkline__halo" cx={lastPoint.x} cy={lastPoint.y} r="4.5" />
          <circle className="sparkline__point" cx={lastPoint.x} cy={lastPoint.y} r="2" />
        </>
      )}
    </svg>
  );
}

function CompactDashboard({ snapshot }: { snapshot: WidgetSnapshotV1 }) {
  const usage = snapshot.periods.today;
  const latest = snapshot.latestRequest?.status === 'pending' ? null : snapshot.latestRequest;
  const isDegraded = snapshot.source.status === 'degraded';
  const attentionCount =
    snapshot.statusCounts.unreported +
    snapshot.statusCounts.ambiguous +
    snapshot.statusCounts.parseError +
    snapshot.statusCounts.unsupported;
  const healthSummary = attentionCount > 0 ? `需关注 ${attentionCount}` : '覆盖待核';
  const healthDetails = `未报告 ${snapshot.statusCounts.unreported} · 歧义 ${snapshot.statusCounts.ambiguous} · 解析错误 ${snapshot.statusCounts.parseError} · 不支持 ${snapshot.statusCounts.unsupported}`;
  return (
    <main className="compact-dashboard">
      <section className="compact-hero">
        <div className="primary-metric">
          <span className="eyebrow">今日 Token</span>
          <strong
            className={latest ? 'metric-pulse' : ''}
            key={latest?.timestampMs ?? 'initial-metric'}
          >
            {formatTokens(usage.totalTokens)}
          </strong>
          <span className="request-count">{usage.requests.toLocaleString('zh-CN')} 次完成请求</span>
        </div>
        <CostSummary compact usage={usage} />
      </section>
      <TokenMix compact usage={usage} />
      <section className={`compact-trend${isDegraded ? ' compact-trend--degraded' : ''}`}>
        <div className="trend-plot">
          <div className="trend-label">
            <span>近 60 分钟</span>
            <b>
              {formatTokens(snapshot.trend60m.reduce((sum, point) => sum + point.totalTokens, 0))}
            </b>
          </div>
          {isDegraded && (
            <span className="compact-health-summary" title={healthDetails}>
              {healthSummary}
            </span>
          )}
          <Sparkline compact points={snapshot.trend60m} />
        </div>
        <div className="latest-compact" title={latest?.model ?? '尚无完成记录'}>
          <span>最近模型</span>
          <b>{latest?.model ?? '等待记录'}</b>
          <small>
            {latest
              ? `${formatTokens(latest.totalTokens)} · ${formatRelativeTime(latest.timestampMs)}`
              : '—'}
          </small>
        </div>
      </section>
    </main>
  );
}

function PeriodTabs({
  value,
  onChange,
}: {
  value: PeriodKey;
  onChange: (period: PeriodKey) => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const currentIndex = PERIODS.findIndex((period) => period.key === value);
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (currentIndex + direction + PERIODS.length) % PERIODS.length;
    const next = PERIODS[nextIndex];
    if (!next) return;
    onChange(next.key);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons[nextIndex]?.focus();
  };

  return (
    <div
      aria-label="统计周期"
      className="period-tabs no-drag"
      onKeyDown={handleKeyDown}
      role="tablist"
    >
      {PERIODS.map((period) => (
        <button
          aria-selected={period.key === value}
          className={period.key === value ? 'is-active' : ''}
          key={period.key}
          onClick={() => onChange(period.key)}
          role="tab"
          tabIndex={period.key === value ? 0 : -1}
          type="button"
        >
          {period.shortLabel}
        </button>
      ))}
    </div>
  );
}

function UsageViewTabs({
  value,
  onChange,
}: {
  value: UsageViewMode;
  onChange: (value: UsageViewMode) => void;
}) {
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = value === 'combined' ? 'ledger' : 'combined';
    onChange(next);
    const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons[next === 'combined' ? 0 : 1]?.focus();
  };

  return (
    <div
      aria-label="账本视图"
      className="usage-view-tabs no-drag"
      onKeyDown={handleKeyDown}
      role="tablist"
    >
      <button
        aria-selected={value === 'combined'}
        className={value === 'combined' ? 'is-active' : ''}
        onClick={() => onChange('combined')}
        role="tab"
        tabIndex={value === 'combined' ? 0 : -1}
        type="button"
      >
        当前合计
      </button>
      <button
        aria-selected={value === 'ledger'}
        className={value === 'ledger' ? 'is-active' : ''}
        onClick={() => onChange('ledger')}
        role="tab"
        tabIndex={value === 'ledger' ? 0 : -1}
        type="button"
      >
        正式账本
      </button>
    </div>
  );
}

function LedgerBreakdown({
  current,
  ledger,
  unledgered,
  periodLabel,
  selectedView,
}: {
  current: WidgetUsageTotals;
  ledger: WidgetUsageTotals;
  unledgered: WidgetUsageTotals;
  periodLabel: string;
  selectedView: UsageViewMode;
}) {
  const pieces = [
    {
      key: 'current',
      label: '当前合计',
      value: current,
      tone: 'current',
      active: selectedView === 'combined',
    },
    {
      key: 'ledger',
      label: '正式账本',
      value: ledger,
      tone: 'ledger',
      active: selectedView === 'ledger',
    },
    {
      key: 'unledgered',
      label: '待入账增量',
      value: unledgered,
      tone: 'pending',
      active: false,
    },
  ];

  return (
    <section className="ledger-breakdown panel">
      <div className="ledger-breakdown__heading">
        <div>
          <span className="eyebrow">{periodLabel} · 数据组成</span>
          <h2>正式账本 + 待入账 = 当前合计</h2>
        </div>
        <span className="ledger-sync-note">
          {unledgered.requests > 0 ? `${unledgered.requests} 次等待入账` : '已全部入账'}
        </span>
      </div>
      <div className="ledger-breakdown__grid">
        {pieces.map((piece) => (
          <div
            className={`ledger-piece ledger-piece--${piece.tone}${piece.active ? ' is-active' : ''}`}
            key={piece.key}
          >
            <span>{piece.label}</span>
            <strong>{formatTokens(piece.value.totalTokens)}</strong>
            <small>{piece.value.requests.toLocaleString('zh-CN')} 次请求</small>
          </div>
        ))}
      </div>
    </section>
  );
}

function DataHealth({ snapshot }: { snapshot: WidgetSnapshotV1 }) {
  const { source, statusCounts } = snapshot;
  const copy = STATUS_COPY[source.status];
  const entries = [
    { label: '可用', value: statusCounts.available, tone: 'good' },
    { label: '等待', value: statusCounts.pending, tone: 'pending' },
    { label: '未报告', value: statusCounts.unreported, tone: 'muted' },
    { label: '歧义', value: statusCounts.ambiguous, tone: 'warn' },
    { label: '解析错误', value: statusCounts.parseError, tone: 'bad' },
    { label: '不支持', value: statusCounts.unsupported, tone: 'muted' },
  ];
  return (
    <section className="panel health-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">本地数据状态</span>
          <h2>数据健康</h2>
        </div>
        <span className={`health-state health-state--${source.status}`}>
          <i aria-hidden="true" />
          {copy.label}
        </span>
      </div>
      <p className="health-summary">
        {source.possibleCoverageGap ? '检测到可能的覆盖缺口' : copy.detail}
        <span> · 上次扫描 {formatRelativeTime(source.lastSuccessfulScanAtMs)}</span>
      </p>
      <div className="health-grid">
        {entries.map((entry) => (
          <div className={`health-count health-count--${entry.tone}`} key={entry.label}>
            <strong>{entry.value.toLocaleString('zh-CN')}</strong>
            <span>{entry.label}</span>
          </div>
        ))}
      </div>
      <div className="coverage-dates">
        <span>账本覆盖期</span>
        <b>
          {formatDate(source.ledgerCoverageStartMs)} — {formatDate(source.ledgerCoverageEndMs)}
        </b>
      </div>
    </section>
  );
}

function TopModels({ models }: { models: WidgetModelUsage[] }) {
  const maximum = Math.max(1, ...models.map((model) => model.totalTokens));
  return (
    <section className="panel models-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">模型占比</span>
          <h2>模型用量排行</h2>
        </div>
        <span className="section-meta">账本覆盖期 · 按 Token</span>
      </div>
      {models.length === 0 ? (
        <p className="empty-copy">账本覆盖期还没有模型记录</p>
      ) : (
        <div className="model-list">
          {models.slice(0, 5).map((model, index) => {
            const coverage = pricingCoverage(model);
            return (
              <div className="model-row" key={`${model.model}-${index}`}>
                <div className="model-rank">{String(index + 1).padStart(2, '0')}</div>
                <div className="model-main">
                  <div className="model-copy">
                    <b title={model.model}>{model.model}</b>
                    <span>{model.requests.toLocaleString('zh-CN')} 次</span>
                  </div>
                  <div className="model-bar" aria-hidden="true">
                    <span style={{ width: `${(model.totalTokens / maximum) * 100}%` }} />
                  </div>
                </div>
                <div className="model-value">
                  <strong>{formatTokens(model.totalTokens)} Token</strong>
                  <span className={coverage < 100 ? 'is-unpriced' : ''}>
                    {model.estimatedUsd !== null && model.pricedTokens > 0
                      ? `≈ ${formatUsd(model.estimatedUsd)}`
                      : '待设价格'}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function RecentModelsCard({
  snapshot,
}: {
  snapshot: Pick<WidgetSnapshotV1, 'recentModels' | 'latestRequest'>;
}) {
  const recentModels = getRecentModels(snapshot);
  const hasPendingPrice = recentModels.some((model) => model.estimatedUsd === null);
  return (
    <section className="panel latest-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">最近使用</span>
          <h2>最近 3 种模型</h2>
        </div>
        <span className="section-meta">按完成时间</span>
      </div>
      {recentModels.length > 0 ? (
        <div className="recent-model-list">
          {recentModels.map((model) => (
            <div className="recent-model-row" key={`${model.model}-${model.timestampMs}`}>
              <div className="recent-model-copy">
                <b title={model.model}>{model.model}</b>
                <span>{formatRelativeTime(model.timestampMs)}</span>
              </div>
              <div className="recent-model-value">
                <span>最近一次 · {formatTokens(model.totalTokens)} Token</span>
                <strong className={model.estimatedUsd === null ? 'is-unpriced' : ''}>
                  {model.estimatedUsd === null ? '待设价格' : `≈ ${formatUsd(model.estimatedUsd)}`}
                </strong>
              </div>
            </div>
          ))}
          {hasPendingPrice && <p className="unpriced-note">Token 已统计，费用未纳入估算。</p>}
        </div>
      ) : (
        <p className="empty-copy">等待已完成的模型响应</p>
      )}
    </section>
  );
}

function PricingSummary({
  usage,
  ruleCount,
  onOpen,
  buttonRef,
}: {
  usage: WidgetUsageTotals;
  ruleCount: number;
  onOpen: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const coverage = pricingCoverage(usage);
  return (
    <section
      className={`pricing-callout${usage.unpricedTokens > 0 ? ' pricing-callout--warn' : ''}`}
    >
      <div className="pricing-callout__icon">
        {usage.unpricedTokens > 0 ? <AlertIcon size={17} /> : <CheckIcon size={17} />}
      </div>
      <div className="pricing-callout__copy">
        <b>{usage.unpricedTokens > 0 ? '美元估算不是完整账单' : '当前周期已全部计价'}</b>
        <span>
          {usage.unpricedTokens > 0
            ? `${formatTokens(usage.unpricedTokens)} Token 待设价格 · 已覆盖 ${formatPricingCoverage(coverage, true)}；Token 已统计，费用未纳入估算。`
            : `${usage.pricedRequests.toLocaleString('zh-CN')} 次请求已有价格映射`}
        </span>
      </div>
      <button className="text-button no-drag" onClick={onOpen} ref={buttonRef} type="button">
        <SlidersIcon size={14} />
        价格规则{ruleCount > 0 ? ` ${ruleCount}` : ''}
        <ChevronRightIcon size={13} />
      </button>
    </section>
  );
}

function ExpandedDashboard({
  snapshot,
  settings,
  onOpenPricing,
  onOpenMaintenance,
  pricingButtonRef,
  maintenanceButtonRef,
}: {
  snapshot: WidgetSnapshotV1;
  settings: WidgetSettings;
  onOpenPricing: () => void;
  onOpenMaintenance: () => void;
  pricingButtonRef: RefObject<HTMLButtonElement | null>;
  maintenanceButtonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [period, setPeriod] = useState<PeriodKey>('today');
  const [viewMode, setViewMode] = useState<UsageViewMode>('ledger');
  const views = getCompatibleViews(snapshot);
  const activeView = viewMode === 'ledger' ? views.ledger : views.combined;
  const usage = activeView.periods[period];
  const currentUsage = views.combined.periods[period];
  const ledgerUsage = views.ledger.periods[period];
  const unledgeredUsage = views.unledgered.periods[period];
  const periodLabel = PERIODS.find((item) => item.key === period)?.label ?? '今天';
  const trendTotal = activeView.trend60m.reduce((sum, point) => sum + point.totalTokens, 0);
  const activeLabel = viewMode === 'ledger' ? '正式账本' : '当前合计';

  return (
    <main className="expanded-dashboard">
      <div className="dashboard-toolbar">
        <UsageViewTabs onChange={setViewMode} value={viewMode} />
        <button
          className="maintenance-trigger no-drag"
          onClick={onOpenMaintenance}
          ref={maintenanceButtonRef}
          type="button"
        >
          <TrashIcon size={14} />
          入账并清理
        </button>
      </div>
      <PeriodTabs onChange={setPeriod} value={period} />
      <section className="hero-panel panel">
        <div className="expanded-metric-row">
          <div className="primary-metric primary-metric--expanded">
            <span className="eyebrow">
              {periodLabel} · {activeLabel} Token
            </span>
            <strong
              className={activeView.latestRequest ? 'metric-pulse' : ''}
              key={`${viewMode}-${activeView.latestRequest?.timestampMs ?? 'initial-metric'}`}
            >
              {formatTokens(usage.totalTokens)}
            </strong>
            <span className="request-count">
              {usage.requests.toLocaleString('zh-CN')} 次完成请求 · 推理{' '}
              {formatTokens(usage.reasoningTokens)}
            </span>
          </div>
          <CostSummary usage={usage} />
        </div>
        <TokenMix usage={usage} />
        <div className={`expanded-trend${trendTotal > 0 ? '' : ' expanded-trend--idle'}`}>
          <div className="trend-caption">
            <span>最近 60 分钟</span>
            <b>{formatTokens(trendTotal)} Token</b>
          </div>
          <div className="expanded-trend__plot">
            <Sparkline points={activeView.trend60m} />
            {trendTotal === 0 && <span className="trend-empty-state">本时段暂无新增</span>}
            <div className="trend-axis">
              <span>60 分钟前</span>
              <span>现在</span>
            </div>
          </div>
        </div>
      </section>
      <LedgerBreakdown
        current={currentUsage}
        ledger={ledgerUsage}
        periodLabel={periodLabel}
        selectedView={viewMode}
        unledgered={unledgeredUsage}
      />
      <div className="detail-grid">
        <RecentModelsCard snapshot={activeView} />
        <DataHealth snapshot={snapshot} />
      </div>
      <TopModels models={activeView.topModels} />
      <PricingSummary
        buttonRef={pricingButtonRef}
        onOpen={onOpenPricing}
        ruleCount={settings.pricingOverrides.filter((rule) => rule.enabled).length}
        usage={usage}
      />
      <p className="estimate-note">
        美元金额为公开 API 标准价等值估算，不代表 OAuth、订阅或 CPA 实际账单。
      </p>
    </main>
  );
}

function LoadingState({ expanded }: { expanded: boolean }) {
  return (
    <main className={`state-view${expanded ? ' state-view--expanded' : ''}`}>
      <div className="scanner" aria-hidden="true">
        <span />
      </div>
      <div>
        <span className="eyebrow">本地账本</span>
        <h1>正在建立本地 Token 视图</h1>
        <p>读取聚合账本并接入实时响应流，不会上传日志。</p>
      </div>
      <div className="skeleton-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </main>
  );
}

function EmptyErrorState({ status, expanded }: { status: 'offline' | 'error'; expanded: boolean }) {
  return (
    <main className={`state-view state-view--error${expanded ? ' state-view--expanded' : ''}`}>
      <span className="state-icon">
        <CloudOffIcon size={26} />
      </span>
      <div>
        <span className="eyebrow">本地数据源</span>
        <h1>{status === 'offline' ? 'CPA 数据源离线' : '本地采集暂不可用'}</h1>
        <p>挂件会自动重试。没有读取 Management API，也不会消费 usage queue。</p>
      </div>
    </main>
  );
}

function PricingDialog({
  settings,
  onClose,
  onSave,
}: {
  settings: WidgetSettings;
  onClose: () => void;
  onSave: (rules: WidgetPricingOverride[]) => Promise<boolean>;
}) {
  const [rules, setRules] = useState<PricingRuleDraft[]>(() =>
    settings.pricingOverrides.map(createPricingRuleDraft)
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const formRef = useRef<HTMLFormElement>(null);

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      formRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !formRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const addRule = () => {
    setRules((current) => [
      ...current,
      createPricingRuleDraft({
        pattern: '',
        inputUsdPer1M: 0,
        cachedInputUsdPer1M: 0,
        outputUsdPer1M: 0,
        enabled: true,
      }),
    ]);
  };

  const updateRule = <Key extends keyof WidgetPricingOverride>(
    index: number,
    key: Key,
    value: WidgetPricingOverride[Key]
  ) => {
    setRules((current) =>
      current.map((rule, ruleIndex) => (ruleIndex === index ? { ...rule, [key]: value } : rule))
    );
    setError(null);
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalized: WidgetPricingOverride[] = rules.map((rule) => ({
      pattern: rule.pattern.trim(),
      inputUsdPer1M: rule.inputUsdPer1M,
      cachedInputUsdPer1M: rule.cachedInputUsdPer1M,
      outputUsdPer1M: rule.outputUsdPer1M,
      enabled: rule.enabled,
    }));
    if (normalized.some((rule) => rule.pattern.length === 0)) {
      setError('每条规则都需要模型匹配模式。');
      return;
    }
    if (normalized.some((rule) => rule.pattern.length > 120)) {
      setError('模型匹配模式不能超过 120 个字符。');
      return;
    }
    const invalidRate = normalized.some((rule) =>
      [rule.inputUsdPer1M, rule.cachedInputUsdPer1M, rule.outputUsdPer1M].some(
        (value) => !Number.isFinite(value) || value < 0
      )
    );
    if (invalidRate) {
      setError('价格必须是大于或等于 0 的数字。');
      return;
    }
    const patterns = normalized.map((rule) => rule.pattern.toLocaleLowerCase());
    if (new Set(patterns).size !== patterns.length) {
      setError('模型匹配模式不能重复。');
      return;
    }

    setSaving(true);
    const saved = await onSave(normalized);
    setSaving(false);
    if (saved) onClose();
    else setError('价格规则未能保存，请稍后重试。');
  };

  return (
    <div
      aria-labelledby={titleId}
      aria-modal="true"
      className="dialog-backdrop no-drag"
      onKeyDown={handleDialogKeyDown}
      role="dialog"
    >
      <form className="pricing-dialog" onSubmit={handleSubmit} ref={formRef}>
        <header className="dialog-header">
          <div>
            <span className="eyebrow">PRICING OVERRIDES</span>
            <h2 id={titleId}>价格覆盖规则</h2>
          </div>
          <button
            aria-label="关闭价格规则"
            autoFocus
            className="icon-button"
            onClick={onClose}
            type="button"
          >
            <CloseIcon size={15} />
          </button>
        </header>
        <p className="dialog-intro">
          仅保存模型模式和每百万 Token 的美元单价。规则会重算挂件中的可见历史周期。
        </p>
        <div className="rule-list">
          {rules.length === 0 ? (
            <div className="rules-empty">
              <SlidersIcon size={22} />
              <b>还没有手动价格</b>
              <span>只需为未定价模型添加覆盖规则。</span>
            </div>
          ) : (
            rules.map((rule, index) => (
              <fieldset className="price-rule" key={rule.draftId}>
                <legend>规则 {String(index + 1).padStart(2, '0')}</legend>
                <div className="rule-topline">
                  <label className="field field--pattern">
                    <span>模型匹配模式</span>
                    <input
                      aria-label={`规则 ${index + 1} 模型匹配模式`}
                      onChange={(event) => updateRule(index, 'pattern', event.target.value)}
                      placeholder="例如 gpt-5.6-*"
                      spellCheck={false}
                      value={rule.pattern}
                    />
                  </label>
                  <label className="rule-switch">
                    <input
                      checked={rule.enabled}
                      onChange={(event) => updateRule(index, 'enabled', event.target.checked)}
                      type="checkbox"
                    />
                    <span aria-hidden="true" />
                    启用
                  </label>
                  <button
                    aria-label={`删除规则 ${index + 1}`}
                    className="icon-button icon-button--danger"
                    onClick={() =>
                      setRules((current) => current.filter((_, itemIndex) => itemIndex !== index))
                    }
                    type="button"
                  >
                    <TrashIcon size={14} />
                  </button>
                </div>
                <div className="rate-grid">
                  {(
                    [
                      ['inputUsdPer1M', '输入'],
                      ['cachedInputUsdPer1M', '缓存输入'],
                      ['outputUsdPer1M', '输出'],
                    ] as const
                  ).map(([key, label]) => (
                    <label className="field" key={key}>
                      <span>{label} / 1M</span>
                      <div className="money-input">
                        <i>$</i>
                        <input
                          aria-label={`规则 ${index + 1} ${label}每百万 Token 美元价格`}
                          inputMode="decimal"
                          min="0"
                          onChange={(event) =>
                            updateRule(
                              index,
                              key,
                              event.target.value === '' ? 0 : event.target.valueAsNumber
                            )
                          }
                          step="0.001"
                          type="number"
                          value={rule[key]}
                        />
                      </div>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))
          )}
        </div>
        <button className="add-rule-button" onClick={addRule} type="button">
          <PlusIcon size={15} />
          添加价格规则
        </button>
        {error && (
          <p aria-live="polite" className="form-error">
            <AlertIcon size={14} />
            {error}
          </p>
        )}
        <footer className="dialog-footer">
          <button className="button button--ghost" onClick={onClose} type="button">
            取消
          </button>
          <button className="button button--primary" disabled={saving} type="submit">
            {saving ? '保存中…' : '保存并重算'}
          </button>
        </footer>
      </form>
    </div>
  );
}

function MaintenanceDialog({
  preview,
  result,
  busy,
  error,
  onClose,
  onConfirm,
  onRetry,
}: {
  preview: WidgetMaintenancePreviewV1 | null;
  result: WidgetMaintenanceResultV1 | null;
  busy: MaintenanceBusyState;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
  onRetry: () => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const isBusy = busy !== null;
  const addedRequests = preview
    ? Math.max(0, preview.projectedAvailableRequests - preview.previousAvailableRequests)
    : 0;
  const addedTokens = preview
    ? Math.max(0, preview.projectedTotalTokens - preview.previousTotalTokens)
    : 0;
  const protectedFiles = preview
    ? preview.prune.keptActiveFiles +
      preview.prune.keptUnrecordedFiles +
      preview.prune.keptIncompleteFiles +
      preview.prune.keptFingerprintMismatchFiles
    : 0;

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape' && !isBusy) {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
      ) ?? []
    ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      aria-labelledby={titleId}
      aria-modal="true"
      className="dialog-backdrop no-drag"
      onKeyDown={handleDialogKeyDown}
      role="dialog"
    >
      <div className="maintenance-dialog" ref={dialogRef}>
        <header className="dialog-header">
          <div>
            <span className="eyebrow">LEDGER MAINTENANCE</span>
            <h2 id={titleId}>入账并清理</h2>
          </div>
          <button
            aria-label="关闭入账维护"
            autoFocus
            className="icon-button"
            disabled={isBusy}
            onClick={onClose}
            type="button"
          >
            <CloseIcon size={15} />
          </button>
        </header>

        <div className="maintenance-dialog__body">
          {busy === 'preview' ? (
            <div aria-live="polite" className="maintenance-state maintenance-state--loading">
              <span className="maintenance-spinner" aria-hidden="true" />
              <div>
                <b>正在生成安全预览</b>
                <span>只检查稳定日志和正式账本，不会删除任何文件。</span>
              </div>
            </div>
          ) : busy === 'execute' ? (
            <div aria-live="polite" className="maintenance-state maintenance-state--loading">
              <span className="maintenance-spinner" aria-hidden="true" />
              <div>
                <b>正在入账、核验并清理</b>
                <span>完成前请勿退出；只有总量核验通过后才会清理已入账日志。</span>
              </div>
            </div>
          ) : result ? (
            <div aria-live="polite" className="maintenance-result">
              <div className="maintenance-result__hero">
                <span className="maintenance-result__icon">
                  {result.postVerificationPending ? <AlertIcon size={22} /> : <CheckIcon size={22} />}
                </span>
                <div>
                  <b>{result.postVerificationPending ? '入账并清理已提交' : '入账并清理完成'}</b>
                  <span>
                    {result.postVerificationPending
                      ? '权威维护流程已返回成功，挂件刷新复核仍待完成。'
                      : '正式账本总量未下降，当前合计保持连续。'}
                  </span>
                </div>
              </div>
              <div className="maintenance-result__grid">
                <div>
                  <span>正式账本</span>
                  <strong>{result.availableRequests.toLocaleString('zh-CN')} 次请求</strong>
                </div>
                <div>
                  <span>总 Token</span>
                  <strong>{formatTokens(result.totalTokens)}</strong>
                </div>
                <div>
                  <span>已清理日志</span>
                  <strong>{result.prune.deletedFiles.toLocaleString('zh-CN')} 个</strong>
                </div>
                <div>
                  <span>释放空间</span>
                  <strong>{formatBytes(result.prune.deletedBytes)}</strong>
                </div>
              </div>
              <p
                className={`maintenance-guarantee${
                  result.postVerificationPending ? '' : ' maintenance-guarantee--success'
                }`}
              >
                {result.postVerificationPending ? <AlertIcon size={14} /> : <CheckIcon size={14} />}
                {result.postVerificationPending ? (
                  POST_VERIFICATION_PENDING_MESSAGE
                ) : (
                  <>
                    核验通过：{formatTokens(result.previousTotalTokens)} →{' '}
                    {formatTokens(result.totalTokens)} Token，总量未下降。
                  </>
                )}
              </p>
            </div>
          ) : error ? (
            <div aria-live="assertive" className="maintenance-state maintenance-state--error">
              <span className="maintenance-result__icon">
                <AlertIcon size={22} />
              </span>
              <div>
                <b>本次维护没有完成</b>
                <span>{error}</span>
                <small>界面不会展示日志名、路径或底层异常内容。</small>
              </div>
            </div>
          ) : preview ? (
            <div className="maintenance-preview">
              <p className="maintenance-dialog__intro">
                顺序固定为：写入正式账本 → 核验 Token 与请求数不下降 → 清理已安全入账日志。
              </p>
              <div className="maintenance-flow" aria-label="维护执行顺序">
                <span>
                  <b>1</b>入账
                </span>
                <i aria-hidden="true" />
                <span>
                  <b>2</b>核验
                </span>
                <i aria-hidden="true" />
                <span>
                  <b>3</b>清理
                </span>
              </div>
              <div className="maintenance-preview__grid">
                <div>
                  <span>预计新增请求</span>
                  <strong>+{addedRequests.toLocaleString('zh-CN')}</strong>
                  <small>{preview.newLedgerFiles.toLocaleString('zh-CN')} 份稳定日志</small>
                </div>
                <div>
                  <span>预计新增 Token</span>
                  <strong>{formatSignedTokens(addedTokens)}</strong>
                  <small>写入同一正式账本</small>
                </div>
                <div>
                  <span>可安全删除</span>
                  <strong>{preview.prune.eligibleFiles.toLocaleString('zh-CN')} 个</strong>
                  <small>{formatBytes(preview.prune.eligibleBytes)}</small>
                </div>
                <div>
                  <span>明确保留</span>
                  <strong>{protectedFiles.toLocaleString('zh-CN')} 个</strong>
                  <small>活跃、未入账或不完整</small>
                </div>
              </div>
              <div className="maintenance-retention">
                <AlertIcon size={15} />
                <div>
                  <b>不完整日志不会删除</b>
                  <span>
                    本次保留 {preview.prune.keptIncompleteFiles.toLocaleString('zh-CN')}{' '}
                    个不完整日志、
                    {preview.prune.keptActiveFiles.toLocaleString('zh-CN')}{' '}
                    个近期活跃日志；指纹不匹配也会保留。
                  </span>
                </div>
              </div>
              <p className="maintenance-guarantee">
                正式账本预计从 {formatTokens(preview.previousTotalTokens)} 增至{' '}
                {formatTokens(preview.projectedTotalTokens)} Token。预览有效至{' '}
                {formatClock(preview.expiresAt)}。
              </p>
            </div>
          ) : null}
        </div>

        <footer className="dialog-footer maintenance-dialog__footer">
          {error ? (
            <>
              <button className="button button--ghost" onClick={onClose} type="button">
                关闭
              </button>
              <button className="button button--primary" onClick={onRetry} type="button">
                重新预览
              </button>
            </>
          ) : result ? (
            <button className="button button--primary" onClick={onClose} type="button">
              完成
            </button>
          ) : preview ? (
            <>
              <button
                className="button button--ghost"
                disabled={isBusy}
                onClick={onClose}
                type="button"
              >
                取消
              </button>
              <button
                className="button button--maintenance"
                disabled={isBusy}
                onClick={onConfirm}
                type="button"
              >
                <TrashIcon size={14} />
                确认入账并清理
              </button>
            </>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

export default function App() {
  const previewEnabled = import.meta.env.DEV && window.cpaWidget === undefined;
  const [snapshot, setSnapshot] = useState<WidgetSnapshotV1>(() =>
    window.cpaWidget
      ? createEmptySnapshot('loading')
      : previewEnabled
        ? createPreviewSnapshot()
        : createEmptySnapshot('offline')
  );
  const [settings, setSettings] = useState<WidgetSettings>(DEFAULT_SETTINGS);
  const [pricingOpen, setPricingOpen] = useState(false);
  const [maintenanceOpen, setMaintenanceOpen] = useState(false);
  const [maintenancePreview, setMaintenancePreview] = useState<WidgetMaintenancePreviewV1 | null>(
    null
  );
  const [maintenanceResult, setMaintenanceResult] = useState<WidgetMaintenanceResultV1 | null>(
    null
  );
  const [maintenanceBusy, setMaintenanceBusy] = useState<MaintenanceBusyState>(null);
  const [maintenanceError, setMaintenanceError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pricingButtonRef = useRef<HTMLButtonElement>(null);
  const maintenanceButtonRef = useRef<HTMLButtonElement>(null);
  const restorePricingFocusRef = useRef(false);
  const restoreMaintenanceFocusRef = useRef(false);
  const isPreview = previewEnabled;

  useEffect(() => {
    if (!pricingOpen && restorePricingFocusRef.current) {
      restorePricingFocusRef.current = false;
      pricingButtonRef.current?.focus();
    }
  }, [pricingOpen]);

  useEffect(() => {
    if (!maintenanceOpen && restoreMaintenanceFocusRef.current) {
      restoreMaintenanceFocusRef.current = false;
      maintenanceButtonRef.current?.focus();
    }
  }, [maintenanceOpen]);

  const closePricing = () => {
    restorePricingFocusRef.current = true;
    setPricingOpen(false);
  };

  const requestMaintenancePreview = useCallback(async () => {
    restorePricingFocusRef.current = false;
    setPricingOpen(false);
    setMaintenanceOpen(true);
    setMaintenancePreview(null);
    setMaintenanceResult(null);
    setMaintenanceError(null);
    setMaintenanceBusy('preview');

    try {
      const api = window.cpaWidget;
      const next = isPreview
        ? createPreviewMaintenance()
        : api
          ? await api.previewLedgerMaintenance()
          : null;
      if (!next) {
        setMaintenanceError('本地维护服务暂不可用。没有修改正式账本，也没有删除日志。');
      } else {
        setMaintenancePreview(next);
      }
    } catch (error) {
      setMaintenanceError(describeLedgerMaintenanceError(error, 'preview'));
    } finally {
      setMaintenanceBusy(null);
    }
  }, [isPreview]);

  const closeMaintenance = () => {
    if (maintenanceBusy !== null) return;
    restoreMaintenanceFocusRef.current = true;
    setMaintenanceOpen(false);
    setMaintenancePreview(null);
    setMaintenanceResult(null);
    setMaintenanceError(null);
  };

  const executeMaintenance = async () => {
    if (!maintenancePreview || maintenanceBusy !== null) return;
    setMaintenanceBusy('execute');
    setMaintenanceError(null);

    try {
      const api = window.cpaWidget;
      const next = isPreview
        ? createPreviewMaintenanceResult(maintenancePreview)
        : api
          ? await api.executeLedgerMaintenance(maintenancePreview.previewId)
          : null;
      if (!next) {
        setMaintenancePreview(null);
        setMaintenanceError('本地维护服务暂不可用。安全流程已停止，未执行日志清理。');
        return;
      }
      if (!next.totalPreserved || next.totalTokens < next.previousTotalTokens) {
        setMaintenancePreview(null);
        setMaintenanceError('总量核验未通过。安全流程已停止，不会继续清理日志。');
        return;
      }

      setMaintenancePreview(null);
      setMaintenanceResult(next);
      setNotice(
        next.postVerificationPending
          ? POST_VERIFICATION_PENDING_MESSAGE
          : '入账并清理完成，正式账本总量未下降'
      );

      if (api && !isPreview) {
        try {
          const refreshed = await api.getSnapshot();
          setSnapshot((current) => mergeSnapshot(current, refreshed));
        } catch {
          setNotice(
            next.postVerificationPending
              ? POST_VERIFICATION_PENDING_MESSAGE
              : '入账并清理已完成；挂件数据会在下次扫描时刷新'
          );
        }
      }
    } catch (error) {
      setMaintenancePreview(null);
      setMaintenanceError(describeLedgerMaintenanceError(error, 'execute'));
    } finally {
      setMaintenanceBusy(null);
    }
  };

  useEffect(() => {
    let active = true;
    const api = window.cpaWidget;
    if (!api) {
      return undefined;
    }

    api
      .getSnapshot()
      .then((next) => {
        if (active) setSnapshot((current) => mergeSnapshot(current, next));
      })
      .catch(() => {
        if (active) setSnapshot(createEmptySnapshot('offline'));
      });

    api
      .getSettings()
      .then((next) => {
        if (active) setSettings(next);
      })
      .catch(() => {
        if (active) setNotice('暂时无法读取已保存设置');
      });

    let unsubscribe: (() => void) | undefined;
    let unsubscribeSettings: (() => void) | undefined;
    let unsubscribeMaintenanceOpen: (() => void) | undefined;
    try {
      unsubscribe = api.subscribe((next) => {
        if (active) setSnapshot((current) => mergeSnapshot(current, next));
      });
      unsubscribeSettings = api.subscribeSettings((next) => {
        if (active) setSettings(next);
      });
      if (typeof api.subscribeMaintenanceOpen === 'function') {
        unsubscribeMaintenanceOpen = api.subscribeMaintenanceOpen(() => {
          if (!active) return;
          setSettings((current) => ({ ...current, expanded: true }));
          void api.setWindowMode(true).catch(() => undefined);
          void requestMaintenancePreview();
        });
      }
    } catch {
      unsubscribe = undefined;
      unsubscribeSettings = undefined;
      unsubscribeMaintenanceOpen = undefined;
    }

    return () => {
      active = false;
      unsubscribe?.();
      unsubscribeSettings?.();
      unsubscribeMaintenanceOpen?.();
    };
  }, [requestMaintenancePreview]);

  const hasUsage = useMemo(
    () => Object.values(snapshot.periods).some((period) => period.totalTokens > 0),
    [snapshot.periods]
  );

  const saveSettings = async (next: WidgetSettings): Promise<boolean> => {
    const previous = settings;
    setSettings(next);
    setNotice(null);
    const api = window.cpaWidget;
    if (!api) return true;
    try {
      const saved = await api.saveSettings(next);
      setSettings(saved);
      return true;
    } catch {
      setSettings(previous);
      setNotice('设置没有保存，已恢复原值');
      return false;
    }
  };

  const toggleExpanded = () => {
    const expanded = !settings.expanded;
    void saveSettings({ ...settings, expanded });
  };

  const toggleAlwaysOnTop = () => {
    const alwaysOnTop = !settings.alwaysOnTop;
    void saveSettings({ ...settings, alwaysOnTop });
  };

  const hideToTray = () => {
    void window.cpaWidget?.hideToTray();
  };

  const savePricingRules = (pricingOverrides: WidgetPricingOverride[]) =>
    saveSettings({ ...settings, pricingOverrides });

  const status = isPreview ? 'degraded' : snapshot.source.status;
  const showLoading = status === 'loading';
  const showEmptyError = !hasUsage && (status === 'offline' || status === 'error');

  return (
    <div
      className={`widget-shell widget-shell--${settings.expanded ? 'expanded' : 'compact'}`}
      data-status={status}
    >
      <AppHeader
        onHide={hideToTray}
        onToggleExpanded={toggleExpanded}
        onTogglePin={toggleAlwaysOnTop}
        preview={isPreview}
        settings={settings}
        status={status}
      />
      {showLoading ? (
        <LoadingState expanded={settings.expanded} />
      ) : showEmptyError ? (
        <EmptyErrorState expanded={settings.expanded} status={status as 'offline' | 'error'} />
      ) : settings.expanded ? (
        <ExpandedDashboard
          maintenanceButtonRef={maintenanceButtonRef}
          onOpenMaintenance={() => void requestMaintenancePreview()}
          onOpenPricing={() => setPricingOpen(true)}
          pricingButtonRef={pricingButtonRef}
          settings={settings}
          snapshot={snapshot}
        />
      ) : (
        <CompactDashboard snapshot={snapshot} />
      )}
      {notice && (
        <button className="notice-toast no-drag" onClick={() => setNotice(null)} type="button">
          <AlertIcon size={14} />
          <span>{notice}</span>
          <CloseIcon size={12} />
        </button>
      )}
      {pricingOpen && (
        <PricingDialog onClose={closePricing} onSave={savePricingRules} settings={settings} />
      )}
      {maintenanceOpen && (
        <MaintenanceDialog
          busy={maintenanceBusy}
          error={maintenanceError}
          onClose={closeMaintenance}
          onConfirm={() => void executeMaintenance()}
          onRetry={() => void requestMaintenancePreview()}
          preview={maintenancePreview}
          result={maintenanceResult}
        />
      )}
    </div>
  );
}
