import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { IconDownload, IconEye, IconSlidersHorizontal } from '@/components/ui/icons';
import type { EnrichedUsageStatsRecord } from '@/types/usageStatistics';
import {
  getDetailStatusLabel,
  getStatusLabel,
  maskSecret,
  type ModelMatrixDatum,
} from '../lib';
import styles from '@/pages/UsageStatisticsPage.module.scss';

interface UsageDetailsRailProps {
  downloadingId: string | null;
  modelMatrix: ModelMatrixDatum[];
  onDownloadLog: (requestId: string) => void;
  onParseDetails: (requestId: string) => void;
  selectedRecord: EnrichedUsageStatsRecord | null;
}

export function UsageDetailsRail({
  downloadingId,
  modelMatrix,
  onDownloadLog,
  onParseDetails,
  selectedRecord,
}: UsageDetailsRailProps) {
  return (
    <aside className={styles.sideRail}>
      <Card className={styles.detailCard}>
        <div className={styles.sideHeader}>
          <div>
            <h2>单次请求详情</h2>
            <p>只展示结构化摘要，完整内容需手动下载。</p>
          </div>
          <IconSlidersHorizontal size={18} />
        </div>

        {!selectedRecord ? (
          <EmptyState
            title="还没有选中请求"
            description="点击左侧模型请求即可解析并查看模型链路。"
          />
        ) : (
          <div className={styles.detailBody}>
            <div className={styles.detailIdentity}>
              <span>{selectedRecord.requestId ?? '-'}</span>
              <strong>{getStatusLabel(selectedRecord.status, selectedRecord.statusCode)}</strong>
            </div>

            <div className={styles.routeDiagram}>
              <div>
                <span>配置模型</span>
                <strong>{selectedRecord.configuredModel ?? '还没核验'}</strong>
              </div>
              <div>
                <span>上游模型</span>
                <strong>{selectedRecord.upstreamModel ?? '还没核验'}</strong>
              </div>
              <div>
                <span>返回模型</span>
                <strong>{selectedRecord.actualModel ?? '还没核验'}</strong>
              </div>
            </div>

            <dl className={styles.detailList}>
              <div>
                <dt>详情状态</dt>
                <dd>{getDetailStatusLabel(selectedRecord.detailStatus)}</dd>
              </div>
              <div>
                <dt>请求入口</dt>
                <dd>{selectedRecord.endpoint}</dd>
              </div>
              <div>
                <dt>耗时</dt>
                <dd>{selectedRecord.latency ?? '-'}</dd>
              </div>
              <div>
                <dt>上游状态</dt>
                <dd>{selectedRecord.detail?.upstreamStatusCode ?? '-'}</dd>
              </div>
              <div>
                <dt>Provider</dt>
                <dd>{selectedRecord.detail?.provider ?? '-'}</dd>
              </div>
              <div>
                <dt>认证</dt>
                <dd title={selectedRecord.detail?.authId ?? undefined}>
                  {selectedRecord.detail?.authLabel ??
                    (selectedRecord.detail?.authId ? maskSecret(selectedRecord.detail.authId) : '-')}
                </dd>
              </div>
              <div>
                <dt>Originator</dt>
                <dd>{selectedRecord.detail?.originator ?? '-'}</dd>
              </div>
              <div>
                <dt>上游地址</dt>
                <dd title={selectedRecord.detail?.upstreamUrl ?? undefined}>
                  {selectedRecord.detail?.upstreamUrl ?? '-'}
                </dd>
              </div>
            </dl>

            {selectedRecord.detail?.errorSummary && (
              <div className={styles.errorSummary}>
                <strong>错误摘要</strong>
                <span>{selectedRecord.detail.errorSummary}</span>
              </div>
            )}

            <div className={styles.detailActions}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!selectedRecord.requestId || selectedRecord.detailStatus === 'loading'}
                loading={selectedRecord.detailStatus === 'loading'}
                onClick={() => selectedRecord.requestId && onParseDetails(selectedRecord.requestId)}
              >
                <IconEye size={15} />
                解析详情
              </Button>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                disabled={!selectedRecord.requestId}
                loading={downloadingId === selectedRecord.requestId}
                onClick={() => selectedRecord.requestId && onDownloadLog(selectedRecord.requestId)}
              >
                <IconDownload size={15} />
                下载完整日志
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card className={styles.matrixCard}>
        <div className={styles.sideHeader}>
          <div>
            <h2>改写明细排行</h2>
            <p>同一个配置模型最后实际走到了哪里。</p>
          </div>
        </div>
        {modelMatrix.length === 0 ? (
          <EmptyState title="暂无可聚合模型" description="核验详情后会显示模型路由排行。" />
        ) : (
          <div className={styles.matrixList}>
            {modelMatrix.map((item) => (
              <div
                key={`${item.configuredModel}-${item.actualModel}`}
                className={`${styles.matrixRow} ${item.changed ? styles.matrixRowChanged : ''}`}
              >
                <div>
                  <span>{item.configuredModel}</span>
                  <strong>{item.actualModel}</strong>
                </div>
                <div>
                  <b>{item.total}</b>
                  <small>
                    {item.changed ? '被改写' : '没改写'} · 错误 {item.failure}
                  </small>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </aside>
  );
}
