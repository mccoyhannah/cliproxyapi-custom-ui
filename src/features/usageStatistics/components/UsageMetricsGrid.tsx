import { Card } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  IconChartLine,
  IconCheck,
  IconEye,
  IconInfo,
  IconTimer,
} from '@/components/ui/icons';
import {
  formatLatency,
  formatPercent,
  type AggregateTotals,
  type RequestMetrics,
} from '../lib';
import styles from '@/pages/UsageStatisticsPage.module.scss';

interface UsageMetricsGridProps {
  aggregateTotals: AggregateTotals;
  loading: boolean;
  rangeLabel: string;
  requestMetrics: RequestMetrics;
}

export function UsageMetricsGrid({
  aggregateTotals,
  loading,
  rangeLabel,
  requestMetrics,
}: UsageMetricsGridProps) {
  if (loading) {
    return (
      <div className={styles.metricsGrid}>
        {Array.from({ length: 5 }).map((_, index) => (
          <Card className={styles.metricCard} key={index}>
            <Skeleton variant="metric" rows={3} />
          </Card>
        ))}
      </div>
    );
  }

  return (
    <div className={styles.metricsGrid}>
      <Card className={styles.metricCard}>
        <div className={styles.metricIcon}>
          <IconChartLine size={18} />
        </div>
        <div>
          <div className={styles.metricLabel}>模型请求</div>
          <div className={styles.metricValue}>{requestMetrics.total}</div>
          <div className={styles.metricHint}>
            {rangeLabel}里一共发起 {requestMetrics.total} 次模型请求。
          </div>
        </div>
      </Card>
      <Card className={styles.metricCard}>
        <div className={styles.metricIcon}>
          <IconCheck size={18} />
        </div>
        <div>
          <div className={styles.metricLabel}>成功 / 错误</div>
          <div className={styles.metricValue}>
            {requestMetrics.success}
            <span> / {requestMetrics.failure}</span>
          </div>
          <div className={styles.metricHint}>
            成功 {requestMetrics.success} 次，错误 {requestMetrics.failure} 次，成功率{' '}
            {formatPercent(requestMetrics.successRate)}。
          </div>
        </div>
      </Card>
      <Card className={styles.metricCard}>
        <div className={styles.metricIcon}>
          <IconTimer size={18} />
        </div>
        <div>
          <div className={styles.metricLabel}>慢请求参考 / 平均速度</div>
          <div className={styles.metricValue}>
            {formatLatency(requestMetrics.p95Latency)}
            <span> / {formatLatency(requestMetrics.avgLatency)}</span>
          </div>
          <div className={styles.metricHint}>P95 表示 100 次里最慢那 5 次大概多慢。</div>
        </div>
      </Card>
      <Card className={styles.metricCard}>
        <div className={styles.metricIcon}>
          <IconEye size={18} />
        </div>
        <div>
          <div className={styles.metricLabel}>已确认是否被改写</div>
          <div className={styles.metricValue}>
            {requestMetrics.verified}
            <span> / {requestMetrics.mismatch} 被改写</span>
          </div>
          <div className={styles.metricHint}>
            拉到详情日志后，才能知道配置模型和实际模型是否一致。
          </div>
        </div>
      </Card>
      <Card className={styles.metricCard}>
        <div className={styles.metricIcon}>
          <IconInfo size={18} />
        </div>
        <div>
          <div className={styles.metricLabel}>后端总账</div>
          <div className={styles.metricValue}>{aggregateTotals.total}</div>
          <div className={styles.metricHint}>
            后端保存的总成功/失败，不一定等于当前时间筛选。
          </div>
        </div>
      </Card>
    </div>
  );
}
