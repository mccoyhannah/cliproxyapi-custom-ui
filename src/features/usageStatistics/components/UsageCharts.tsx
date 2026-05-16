import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import type { UsageStatsFilters } from '@/types/usageStatistics';
import {
  formatLatency,
  formatPercent,
  formatTokenCount,
  UNPARSED_MODEL_LABEL,
  type ModelMatrixDatum,
  type ModelUsageDatum,
  type RequestMetrics,
  type TimelineBucket,
  type TokenUsageMetrics,
} from '../lib';
import styles from '@/pages/UsageStatisticsPage.module.scss';

interface UsageChartsProps {
  latencyMax: number;
  loading: boolean;
  modelMatrix: ModelMatrixDatum[];
  modelUsage: ModelUsageDatum[];
  normalizedFilters: UsageStatsFilters;
  onModelUsageClick: (model: string) => void;
  rangeLabel: string;
  requestMetrics: RequestMetrics;
  tokenMetrics: TokenUsageMetrics;
  timelineBuckets: TimelineBucket[];
  timelineMax: number;
}

const renderChartSkeleton = () => <Skeleton variant="card" rows={4} />;

export function UsageCharts({
  latencyMax,
  loading,
  modelMatrix,
  modelUsage,
  normalizedFilters,
  onModelUsageClick,
  rangeLabel,
  requestMetrics,
  tokenMetrics,
  timelineBuckets,
  timelineMax,
}: UsageChartsProps) {
  const tokenSegments = [
    {
      label: '新输入',
      value: Math.max(tokenMetrics.input - tokenMetrics.cached, 0),
      className: styles.tokenSegmentInput,
    },
    { label: '缓存', value: tokenMetrics.cached, className: styles.tokenSegmentCached },
    {
      label: '输出',
      value: Math.max(tokenMetrics.output - tokenMetrics.reasoning, 0),
      className: styles.tokenSegmentOutput,
    },
    { label: '推理', value: tokenMetrics.reasoning, className: styles.tokenSegmentReasoning },
  ].filter((item) => item.value > 0);
  const tokenSegmentTotal = Math.max(
    tokenSegments.reduce((total, item) => total + item.value, 0),
    tokenMetrics.total,
    1
  );

  return (
    <div className={styles.chartGrid}>
      <Card className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <h2>模型用量柱状图</h2>
            <p>看这段时间主要在用哪个模型。点柱子可以直接筛选。</p>
          </div>
          <span>Top {modelUsage.length || 0}</span>
        </div>
        {loading ? (
          renderChartSkeleton()
        ) : modelUsage.length === 0 ? (
          <EmptyState title="暂无模型用量" description="换个时间范围，或发起一次模型请求。" />
        ) : (
          <div className={styles.modelBars}>
            {modelUsage.map((item) => {
              const active =
                item.model === UNPARSED_MODEL_LABEL
                  ? normalizedFilters.onlyUnparsed
                  : normalizedFilters.model === item.model;
              return (
                <button
                  key={item.model}
                  type="button"
                  className={`${styles.modelBarRow} ${active ? styles.modelBarRowActive : ''}`}
                  onClick={() => onModelUsageClick(item.model)}
                  aria-pressed={active}
                >
                  <span className={styles.modelBarName} title={item.model}>
                    {item.model}
                  </span>
                  <span className={styles.modelBarTrack}>
                    <span className={styles.modelBarFill} style={{ width: `${item.percent}%` }} />
                  </span>
                  <span className={styles.modelBarMeta}>
                    {item.total} 次 · {formatTokenCount(item.tokenTotal)} Token
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Card>

      <Card className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <h2>Token 消耗结构</h2>
            <p>只统计已解析并上报 usage 的请求；缓存和推理 Token 单独拆出。</p>
          </div>
          <span>{formatPercent(tokenMetrics.coverageRate)} 覆盖</span>
        </div>
        {loading ? (
          renderChartSkeleton()
        ) : tokenMetrics.knownRequests === 0 ? (
          <EmptyState title="暂无 Token 数据" description="解析详情后会显示 Token 消耗结构。" />
        ) : (
          <div className={styles.tokenUsagePanel}>
            <div className={styles.tokenTotalRow}>
              <strong>{formatTokenCount(tokenMetrics.total)}</strong>
              <span>
                已知 {tokenMetrics.knownRequests} / {tokenMetrics.totalRequests} 条 · 未上报{' '}
                {tokenMetrics.unreportedRequests} 条
              </span>
            </div>
            <div className={styles.tokenStack} aria-label="Token 消耗结构">
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
                {formatTokenCount(tokenMetrics.input)}
              </span>
              <span>
                <b>缓存</b>
                {formatTokenCount(tokenMetrics.cached)}
              </span>
              <span>
                <b>输出</b>
                {formatTokenCount(tokenMetrics.output)}
              </span>
              <span>
                <b>推理</b>
                {formatTokenCount(tokenMetrics.reasoning)}
              </span>
            </div>
          </div>
        )}
      </Card>

      <Card className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <h2>成功 / 错误时间分布</h2>
            <p>看请求是在什么时候集中爆发，红色越多说明错误越集中。</p>
          </div>
          <span>{rangeLabel}</span>
        </div>
        {loading ? (
          renderChartSkeleton()
        ) : (
          <>
            <div className={styles.stackedBars} aria-label="成功和错误时间分布">
              {timelineBuckets.map((bucket) => {
                const height =
                  bucket.total > 0 ? Math.max(8, (bucket.total / timelineMax) * 100) : 2;
                const successHeight = bucket.total > 0 ? (bucket.success / bucket.total) * 100 : 0;
                const failureHeight = bucket.total > 0 ? (bucket.failure / bucket.total) * 100 : 0;
                const unknownHeight = bucket.total > 0 ? (bucket.unknown / bucket.total) * 100 : 0;
                return (
                  <div
                    key={bucket.key}
                    className={styles.stackedBarColumn}
                    title={`${bucket.label}: 成功 ${bucket.success} / 错误 ${bucket.failure} / 未知 ${bucket.unknown}`}
                  >
                    <div className={styles.stackedBarTrack}>
                      <div className={styles.stackedBarFill} style={{ height: `${height}%` }}>
                        {unknownHeight > 0 && (
                          <span
                            className={styles.segmentUnknown}
                            style={{ height: `${unknownHeight}%` }}
                          />
                        )}
                        {failureHeight > 0 && (
                          <span
                            className={styles.segmentFailure}
                            style={{ height: `${failureHeight}%` }}
                          />
                        )}
                        {successHeight > 0 && (
                          <span
                            className={styles.segmentSuccess}
                            style={{ height: `${successHeight}%` }}
                          />
                        )}
                      </div>
                    </div>
                    <span>{bucket.label}</span>
                  </div>
                );
              })}
            </div>
            <div className={styles.chartLegend}>
              <span className={styles.legendSuccess}>成功</span>
              <span className={styles.legendFailure}>错误</span>
              <span className={styles.legendUnknown}>未知</span>
            </div>
          </>
        )}
      </Card>

      <Card className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <h2>耗时趋势</h2>
            <p>浅色是平均速度，深色是慢请求参考；柱子越高越慢。</p>
          </div>
          <span>P95 / 平均</span>
        </div>
        {loading ? (
          renderChartSkeleton()
        ) : (
          <>
            <div className={styles.latencyBars} aria-label="耗时趋势">
              {timelineBuckets.map((bucket) => {
                const avgHeight = bucket.avgLatency
                  ? Math.max(5, (bucket.avgLatency / latencyMax) * 100)
                  : 0;
                const p95Height = bucket.p95Latency
                  ? Math.max(5, (bucket.p95Latency / latencyMax) * 100)
                  : 0;
                return (
                  <div
                    key={bucket.key}
                    className={styles.latencyColumn}
                    title={`${bucket.label}: P95 ${formatLatency(bucket.p95Latency)} / 平均 ${formatLatency(
                      bucket.avgLatency
                    )}`}
                  >
                    <div className={styles.latencyTrack}>
                      {avgHeight > 0 && (
                        <span className={styles.latencyAvg} style={{ height: `${avgHeight}%` }} />
                      )}
                      {p95Height > 0 && (
                        <span className={styles.latencyP95} style={{ height: `${p95Height}%` }} />
                      )}
                    </div>
                    <span>{bucket.label}</span>
                  </div>
                );
              })}
            </div>
            <div className={styles.chartLegend}>
              <span className={styles.legendAvg}>平均速度</span>
              <span className={styles.legendP95}>慢请求参考</span>
            </div>
          </>
        )}
      </Card>

      <Card className={styles.chartCard}>
        <div className={styles.chartHeader}>
          <div>
            <h2>模型改写概览</h2>
            <p>看“你配置的模型”最后有没有被代理改成别的模型。</p>
          </div>
          <span>{requestMetrics.mismatch} 条被改写</span>
        </div>
        {loading ? (
          renderChartSkeleton()
        ) : modelMatrix.length === 0 ? (
          <EmptyState title="还没有可核验模型" description="详情解析完成后会显示模型是否被改写。" />
        ) : (
          <div className={styles.rewriteBars}>
            {modelMatrix.slice(0, 6).map((item) => (
              <div
                key={`${item.configuredModel}-${item.actualModel}`}
                className={`${styles.rewriteRow} ${item.changed ? styles.rewriteRowChanged : ''}`}
              >
                <div className={styles.rewriteModels}>
                  <span title={item.configuredModel}>{item.configuredModel}</span>
                  <strong title={item.actualModel}>{item.actualModel}</strong>
                </div>
                <div className={styles.rewriteTrack}>
                  <span style={{ width: `${item.percent}%` }} />
                </div>
                <div className={styles.rewriteMeta}>
                  <b>{item.total}</b>
                  <small>{item.changed ? '被改写' : '没改写'}</small>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
