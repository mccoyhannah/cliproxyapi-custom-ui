import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import type { EnrichedUsageStatsRecord } from '@/types/usageStatistics';
import { getDetailStatusLabel, getMatchLabel, getStatusLabel } from '../lib';
import styles from '@/pages/UsageStatisticsPage.module.scss';

interface UsageRequestsTableProps {
  filteredRecords: EnrichedUsageStatsRecord[];
  loading: boolean;
  maxIndexLines: number;
  onNextPage: () => void;
  onPreviousPage: () => void;
  onSelectRecord: (requestId: string) => void;
  pageCount: number;
  pagedRecords: EnrichedUsageStatsRecord[];
  rangeLabel: string;
  safePage: number;
  selectedRecord: EnrichedUsageStatsRecord | null;
}

export function UsageRequestsTable({
  filteredRecords,
  loading,
  maxIndexLines,
  onNextPage,
  onPreviousPage,
  onSelectRecord,
  pageCount,
  pagedRecords,
  rangeLabel,
  safePage,
  selectedRecord,
}: UsageRequestsTableProps) {
  return (
    <Card className={styles.tableCard}>
      <div className={styles.tableHeader}>
        <div>
          <h2>模型请求明细</h2>
          <p>
            当前看到的是：{rangeLabel} 的 {filteredRecords.length} 条模型请求。先读取最近{' '}
            {maxIndexLines} 行摘要，再按需核验详情；当前第 {safePage} / {pageCount} 页。
          </p>
        </div>
        <span>{filteredRecords.length} 条</span>
      </div>

      {filteredRecords.length === 0 ? (
        loading ? (
          <Skeleton variant="table" rows={8} />
        ) : (
          <EmptyState
            title="暂无模型请求"
            description="可以换个时间范围，或者开启请求日志后发起一次模型请求。"
          />
        )
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.usageTable}>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>请求 ID</th>
                  <th>来源</th>
                  <th>配置模型</th>
                  <th>实际模型</th>
                  <th>状态</th>
                  <th>延迟</th>
                  <th>是否改写</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                {pagedRecords.map((record) => (
                  <tr
                    key={record.id}
                    className={
                      selectedRecord?.id === record.id ? styles.selectedRow : styles.clickableRow
                    }
                    onClick={() => {
                      if (record.requestId) {
                        onSelectRecord(record.requestId);
                      }
                    }}
                  >
                    <td>{record.timeLabel}</td>
                    <td className={styles.monoCell}>{record.requestId ?? '-'}</td>
                    <td className={styles.sourceCell} title={`${record.endpoint} | ${record.source}`}>
                      <span>{record.endpoint}</span>
                      <small>{record.source}</small>
                    </td>
                    <td className={styles.modelCell}>{record.configuredModel ?? '还没核验'}</td>
                    <td className={styles.modelCell}>{record.actualModel ?? '还没核验'}</td>
                    <td>
                      <span className={`${styles.statusPill} ${styles[`status_${record.status}`]}`}>
                        {getStatusLabel(record.status, record.statusCode)}
                      </span>
                    </td>
                    <td>{record.latency ?? '-'}</td>
                    <td>
                      <span className={`${styles.matchPill} ${styles[`match_${record.modelMatch}`]}`}>
                        {getMatchLabel(record.modelMatch)}
                      </span>
                    </td>
                    <td>
                      <span
                        className={`${styles.detailPill} ${
                          styles[`detail_${record.detailStatus.replace('-', '_')}`]
                        }`}
                      >
                        {getDetailStatusLabel(record.detailStatus)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className={styles.pagination}>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={safePage <= 1}
              onClick={onPreviousPage}
            >
              上一页
            </Button>
            <span>
              {safePage} / {pageCount}
            </span>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={safePage >= pageCount}
              onClick={onNextPage}
            >
              下一页
            </Button>
          </div>
        </>
      )}
    </Card>
  );
}
