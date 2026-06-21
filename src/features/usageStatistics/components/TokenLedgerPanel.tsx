import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconPlus, IconSettings, IconTrash2 } from '@/components/ui/icons';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import type {
  TokenLedgerEntry,
  TokenLedgerFilters,
  TokenLedgerSnapshot,
} from '@/types/usageStatistics';
import {
  DEFAULT_TOKEN_LEDGER_FILTERS,
  MODEL_PRICING_OVERRIDES_STORAGE_KEY,
  TOKEN_LEDGER_RECENT_HOUR_OPTIONS,
  TOKEN_LEDGER_RANGE_OPTIONS,
  type ModelPricingOverride,
  buildTokenLedgerModelUsage,
  calculateTokenLedgerCostSummary,
  calculateTokenLedgerMetrics,
  estimateTokenUsageCost,
  filterTokenLedgerEntries,
  formatDateTime,
  formatPercent,
  formatTokenCount,
  formatTokenLedgerRangeLabel,
  formatTokenLedgerSpan,
  formatUsdCost,
  getTokenLedgerEntrySpan,
  getTokenLedgerRangeWindow,
  isModelPricingOverrideUsable,
  sanitizeModelPricingOverrides,
} from '../lib';
import styles from '@/pages/UsageStatisticsPage.module.scss';

interface TokenLedgerPanelProps {
  error: string;
  filters: TokenLedgerFilters;
  ledger: TokenLedgerSnapshot | null;
  loading: boolean;
  onPruneRecordedLogs: () => void;
  pruneDisabled: boolean;
  pruning: boolean;
  setFilterValue: <K extends keyof TokenLedgerFilters>(
    key: K,
    value: TokenLedgerFilters[K]
  ) => void;
}

const EMPTY_LEDGER_ENTRIES: TokenLedgerEntry[] = [];
const TOKEN_LEDGER_RECENT_HOUR_SELECT_OPTIONS = TOKEN_LEDGER_RECENT_HOUR_OPTIONS.map((option) => ({
  value: String(option.value),
  label: option.label,
}));
const EMPTY_PRICING_OVERRIDE: ModelPricingOverride = {
  pattern: '',
  inputUsdPer1M: 0,
  cachedInputUsdPer1M: 0,
  outputUsdPer1M: 0,
  enabled: true,
};

const parseDateMs = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const parseRateInput = (value: string): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

export function TokenLedgerPanel({
  error,
  filters,
  ledger,
  loading,
  onPruneRecordedLogs,
  pruneDisabled,
  pruning,
  setFilterValue,
}: TokenLedgerPanelProps) {
  const { i18n } = useTranslation();
  const [pricingOpen, setPricingOpen] = useState(false);
  const [pricingOverrides, setPricingOverrides] = useLocalStorage<ModelPricingOverride[]>(
    MODEL_PRICING_OVERRIDES_STORAGE_KEY,
    []
  );
  const normalizedFilters = useMemo(
    () => ({ ...DEFAULT_TOKEN_LEDGER_FILTERS, ...filters }),
    [filters]
  );
  const editablePricingOverrides = useMemo(
    () => sanitizeModelPricingOverrides(pricingOverrides),
    [pricingOverrides]
  );
  const effectivePricingOverrides = useMemo(
    () =>
      editablePricingOverrides.filter(
        (rule) => rule.enabled !== false && isModelPricingOverrideUsable(rule)
      ),
    [editablePricingOverrides]
  );
  const entries = ledger?.entries ?? EMPTY_LEDGER_ENTRIES;
  const rangeWindow = useMemo(
    () => getTokenLedgerRangeWindow(normalizedFilters),
    [normalizedFilters]
  );
  const filteredEntries = useMemo(
    () => filterTokenLedgerEntries(entries, normalizedFilters),
    [entries, normalizedFilters]
  );
  const metrics = useMemo(
    () => calculateTokenLedgerMetrics(filteredEntries),
    [filteredEntries]
  );
  const modelUsage = useMemo(
    () => buildTokenLedgerModelUsage(filteredEntries),
    [filteredEntries]
  );
  const costSummary = useMemo(
    () => calculateTokenLedgerCostSummary(filteredEntries, effectivePricingOverrides),
    [effectivePricingOverrides, filteredEntries]
  );
  const modelUsageWithCosts = useMemo(
    () =>
      modelUsage.map((item) => ({
        ...item,
        cost: estimateTokenUsageCost(item.model, item, effectivePricingOverrides),
      })),
    [effectivePricingOverrides, modelUsage]
  );
  const selectedSpan = useMemo(
    () => getTokenLedgerEntrySpan(filteredEntries),
    [filteredEntries]
  );

  const generatedAtMs = parseDateMs(ledger?.generatedAt);
  const coverageStart = ledger?.coverage.earliestTimestampMs ?? null;
  const coverageEnd = ledger?.coverage.latestTimestampMs ?? null;
  const coverageSpan = formatTokenLedgerSpan(coverageStart, coverageEnd, i18n.language);
  const selectedSpanLabel = formatTokenLedgerSpan(
    selectedSpan.start,
    selectedSpan.end,
    i18n.language
  );
  const rangeLabel = formatTokenLedgerRangeLabel(normalizedFilters);
  const rangeOutsideCoverage =
    Boolean(ledger) &&
    ((rangeWindow.start !== null && coverageStart !== null && rangeWindow.start < coverageStart) ||
      (rangeWindow.end !== null && coverageEnd !== null && rangeWindow.end > coverageEnd));
  const activePricingOverrideCount = effectivePricingOverrides.length;

  const updatePricingOverride = (index: number, patch: Partial<ModelPricingOverride>) => {
    setPricingOverrides((current) => {
      const rows = sanitizeModelPricingOverrides(current);
      return rows.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row));
    });
  };

  const addPricingOverride = () => {
    setPricingOverrides((current) => [
      ...sanitizeModelPricingOverrides(current),
      { ...EMPTY_PRICING_OVERRIDE },
    ]);
    setPricingOpen(true);
  };

  const removePricingOverride = (index: number) => {
    setPricingOverrides((current) =>
      sanitizeModelPricingOverrides(current).filter((_, rowIndex) => rowIndex !== index)
    );
  };

  const tokenSegments = [
    {
      label: '新输入',
      value: Math.max(metrics.input - metrics.cached, 0),
      className: styles.tokenSegmentInput,
    },
    { label: '缓存', value: metrics.cached, className: styles.tokenSegmentCached },
    {
      label: '输出',
      value: Math.max(metrics.output - metrics.reasoning, 0),
      className: styles.tokenSegmentOutput,
    },
    { label: '推理', value: metrics.reasoning, className: styles.tokenSegmentReasoning },
  ].filter((item) => item.value > 0);
  const tokenSegmentTotal = Math.max(
    tokenSegments.reduce((sum, item) => sum + item.value, 0),
    metrics.total,
    1
  );

  return (
    <Card className={styles.ledgerCard}>
      <div className={styles.ledgerHeader}>
        <div className={styles.ledgerTitleBlock}>
          <h2>长期 Token 台账</h2>
          <p>来自本机详情日志聚合，只保存 Token 摘要和日志文件元信息。</p>
        </div>
        <div className={styles.ledgerHeaderActions}>
          <div className={styles.ledgerMeta} aria-label="Token 台账状态">
            <span>台账覆盖</span>
            <strong>{coverageSpan}</strong>
            {generatedAtMs !== null && (
              <em>更新 {formatDateTime(generatedAtMs, i18n.language)}</em>
            )}
          </div>
          <div className={styles.ledgerActionGroup}>
            <Button
              type="button"
              variant="warning"
              size="sm"
              loading={pruning}
              disabled={pruneDisabled || loading}
              onClick={onPruneRecordedLogs}
              leftIcon={<IconTrash2 size={15} />}
              className={styles.ledgerPruneButton}
            >
              清理已入账日志
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setPricingOpen((current) => !current)}
              leftIcon={<IconSettings size={15} />}
              aria-expanded={pricingOpen}
              className={styles.ledgerPricingButton}
            >
              价格设置
            </Button>
          </div>
        </div>
      </div>

      <div className={styles.ledgerControlRow}>
        <div className={styles.rangeTabs} role="tablist" aria-label="token ledger range">
          {TOKEN_LEDGER_RANGE_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`${styles.rangeTab} ${
                normalizedFilters.range === option.value ? styles.rangeTabActive : ''
              }`}
              onClick={() => setFilterValue('range', option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        {normalizedFilters.range === 'hours' && (
          <div className={styles.ledgerHourSelect}>
            <span>小时范围</span>
            <Select
              value={String(normalizedFilters.recentHours)}
              options={TOKEN_LEDGER_RECENT_HOUR_SELECT_OPTIONS}
              onChange={(value) => setFilterValue('recentHours', Number(value))}
              ariaLabel="选择长期 Token 台账最近小时范围"
              className={styles.ledgerHourSelectControl}
              fullWidth={false}
            />
          </div>
        )}
        {ledger && <span className={styles.ledgerRangeNote}>当前范围 {selectedSpanLabel}</span>}
      </div>

      {pricingOpen && (
        <div className={styles.pricingPanel}>
          <div className={styles.pricingPanelHeader}>
            <div>
              <h3>本地价格覆盖</h3>
              <span>
                {activePricingOverrideCount > 0
                  ? `${activePricingOverrideCount} 条启用`
                  : '使用内置官方价表，空价格不参与计价'}
              </span>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={addPricingOverride}
              leftIcon={<IconPlus size={14} />}
            >
              添加
            </Button>
          </div>

          {editablePricingOverrides.length === 0 ? (
            <div className={styles.pricingEmpty}>暂无本地覆盖规则</div>
          ) : (
            <div className={styles.pricingOverrideList}>
              <div className={styles.pricingOverrideHeader}>
                <span>启用</span>
                <span>模型匹配</span>
                <span>输入</span>
                <span>缓存输入</span>
                <span>输出</span>
                <span />
              </div>
              {editablePricingOverrides.map((rule, index) => (
                <div key={index} className={styles.pricingOverrideRow}>
                  <label className={styles.pricingEnabledToggle}>
                    <input
                      type="checkbox"
                      checked={rule.enabled !== false}
                      onChange={(event) =>
                        updatePricingOverride(index, { enabled: event.target.checked })
                      }
                    />
                  </label>
                  <Input
                    value={rule.pattern}
                    placeholder="gpt-5.4-custom*"
                    aria-label="模型匹配"
                    onChange={(event) =>
                      updatePricingOverride(index, { pattern: event.target.value })
                    }
                  />
                  <Input
                    type="number"
                    min="0"
                    step="0.001"
                    value={rule.inputUsdPer1M}
                    aria-label="输入 USD 每百万 Token"
                    onChange={(event) =>
                      updatePricingOverride(index, {
                        inputUsdPer1M: parseRateInput(event.target.value),
                      })
                    }
                  />
                  <Input
                    type="number"
                    min="0"
                    step="0.001"
                    value={rule.cachedInputUsdPer1M}
                    aria-label="缓存输入 USD 每百万 Token"
                    onChange={(event) =>
                      updatePricingOverride(index, {
                        cachedInputUsdPer1M: parseRateInput(event.target.value),
                      })
                    }
                  />
                  <Input
                    type="number"
                    min="0"
                    step="0.001"
                    value={rule.outputUsdPer1M}
                    aria-label="输出 USD 每百万 Token"
                    onChange={(event) =>
                      updatePricingOverride(index, {
                        outputUsdPer1M: parseRateInput(event.target.value),
                      })
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    iconOnly
                    title="删除覆盖规则"
                    aria-label="删除覆盖规则"
                    onClick={() => removePricingOverride(index)}
                  >
                    <IconTrash2 size={14} />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {normalizedFilters.range === 'custom' && (
        <div className={styles.customRange}>
          <Input
            type="datetime-local"
            label="开始时间"
            value={normalizedFilters.customStart}
            onChange={(event) => setFilterValue('customStart', event.target.value)}
          />
          <Input
            type="datetime-local"
            label="结束时间"
            value={normalizedFilters.customEnd}
            onChange={(event) => setFilterValue('customEnd', event.target.value)}
          />
        </div>
      )}

      {loading && !ledger ? (
        <Skeleton variant="card" rows={5} />
      ) : !ledger ? (
        <EmptyState
          title="暂无长期 Token 台账"
          description={error || '回填脚本生成 token-ledger.json 后，这里会显示最近 30 天和本月总量。'}
        />
      ) : (
        <>
          <div className={styles.ledgerSummaryGrid}>
            <div className={styles.ledgerSummaryPrimary}>
              <span>{rangeLabel}</span>
              <strong>{formatTokenCount(metrics.total)}</strong>
              <small>Token 总消耗</small>
            </div>
            <div className={styles.ledgerSummaryItem}>
              <span>已上报 / 已解析</span>
              <strong>
                {metrics.knownRequests} / {metrics.parsedRequests}
              </strong>
              <small>共 {metrics.totalRequests} 条日志摘要</small>
            </div>
            <div className={styles.ledgerSummaryItem}>
              <span>覆盖率 / 解析率</span>
              <strong>
                {formatPercent(metrics.coverageRate)} / {formatPercent(metrics.parsedRate)}
              </strong>
              <small>缺 usage 显示为未上报</small>
            </div>
            <div className={styles.ledgerSummaryItem}>
              <span>估算费用</span>
              <strong>{formatUsdCost(costSummary.costUsd)}</strong>
              <small>
                {costSummary.unpricedModels > 0
                  ? `${costSummary.unpricedModels} 个模型未计价`
                  : 'OpenAI Standard USD'}
              </small>
            </div>
            <div className={styles.ledgerSummaryItem}>
              <span>当前覆盖起止</span>
              <strong>{selectedSpanLabel}</strong>
              <small>
                {rangeOutsideCoverage
                  ? '当前范围超过台账历史，仅统计已有详情日志'
                  : '当前范围落在台账覆盖内'}
              </small>
            </div>
          </div>

          {filteredEntries.length === 0 ? (
            <EmptyState
              title="当前范围没有 Token 台账"
              description="换一个区间，或等待计划任务扫描新的详情日志。"
            />
          ) : (
            <div className={styles.ledgerBodyGrid}>
              <div className={styles.tokenUsagePanel}>
                <div className={styles.tokenTotalRow}>
                  <strong>{formatTokenCount(metrics.total)}</strong>
                  <span>
                    已知 {metrics.knownRequests} / {metrics.totalRequests} 条 · 未上报{' '}
                    {metrics.unreportedRequests} 条
                  </span>
                </div>
                <div className={styles.tokenStack} aria-label="长期 Token 消耗结构">
                  {tokenSegments.map((item) => (
                    <span
                      key={item.label}
                      className={`${styles.tokenSegment} ${item.className}`}
                      style={{ width: `${Math.max(4, (item.value / tokenSegmentTotal) * 100)}%` }}
                      title={`${item.label}: ${formatTokenCount(item.value)} Token`}
                    />
                  ))}
                </div>
                <div className={styles.tokenBreakdownGrid}>
                  <span>
                    <b>输入</b>
                    {formatTokenCount(metrics.input)}
                  </span>
                  <span>
                    <b>缓存</b>
                    {formatTokenCount(metrics.cached)}
                  </span>
                  <span>
                    <b>输出</b>
                    {formatTokenCount(metrics.output)}
                  </span>
                  <span>
                    <b>推理</b>
                    {formatTokenCount(metrics.reasoning)}
                  </span>
                </div>
              </div>

              <div className={styles.ledgerModelPanel}>
                <div className={styles.ledgerSubHeader}>
                  <h3>模型 Token 占比</h3>
                  <span>Top {modelUsage.length}</span>
                </div>
                {modelUsage.length === 0 ? (
                  <EmptyState title="暂无模型占比" description="当前范围没有已上报 usage 的请求。" />
                ) : (
                  <div className={styles.modelBars}>
                    {modelUsageWithCosts.map((item) => (
                      <div key={item.model} className={styles.modelBarRow}>
                        <span className={styles.modelBarName} title={item.model}>
                          {item.model}
                        </span>
                        <span className={styles.modelBarTrack}>
                          <span
                            className={styles.modelBarFill}
                            style={{ width: `${Math.max(4, item.percent)}%` }}
                          />
                        </span>
                        <span className={styles.modelBarMeta}>
                          {item.requests} 次 · {formatTokenCount(item.total)} Token ·{' '}
                          {item.cost.pricingPattern ? formatUsdCost(item.cost.costUsd) : '未计价'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
