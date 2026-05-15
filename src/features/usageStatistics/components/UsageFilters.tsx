import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { IconSearch } from '@/components/ui/icons';
import type { UsageStatsFilters } from '@/types/usageStatistics';
import { AUTO_DETAIL_LIMIT, RANGE_OPTIONS, REFRESH_INTERVAL_OPTIONS } from '../lib';
import styles from '@/pages/UsageStatisticsPage.module.scss';

interface UsageFiltersProps {
  autoRefresh: boolean;
  configAvailable: boolean;
  connectionStatus: string;
  enablingRequestLog: boolean;
  error: string;
  modelOptions: string[];
  normalizedFilters: UsageStatsFilters;
  onEnableRequestLog: () => void;
  refreshInterval: number;
  requestLogEnabled: boolean;
  setAutoRefresh: (value: boolean) => void;
  setFilterValue: <K extends keyof UsageStatsFilters>(
    key: K,
    value: UsageStatsFilters[K]
  ) => void;
  setRefreshInterval: (value: number) => void;
  sourceOptions: string[];
}

export function UsageFilters({
  autoRefresh,
  configAvailable,
  connectionStatus,
  enablingRequestLog,
  error,
  modelOptions,
  normalizedFilters,
  onEnableRequestLog,
  refreshInterval,
  requestLogEnabled,
  setAutoRefresh,
  setFilterValue,
  setRefreshInterval,
  sourceOptions,
}: UsageFiltersProps) {
  return (
    <Card className={styles.controlCard}>
      <div className={styles.controlTopRow}>
        <div className={styles.rangeTabs} role="tablist" aria-label="model request range">
          {RANGE_OPTIONS.map((option) => (
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
        <div className={styles.refreshControls}>
          <ToggleSwitch
            checked={autoRefresh}
            onChange={setAutoRefresh}
            label="自动刷新"
            disabled={connectionStatus !== 'connected'}
          />
          <select
            className={styles.selectControl}
            value={refreshInterval}
            onChange={(event) => setRefreshInterval(Number(event.target.value))}
            disabled={!autoRefresh}
            aria-label="刷新间隔"
          >
            {REFRESH_INTERVAL_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

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

      <div className={styles.filterGrid}>
        <Input
          className={styles.searchInput}
          value={normalizedFilters.search}
          placeholder="搜索请求 ID、模型、来源、认证或错误"
          onChange={(event) => setFilterValue('search', event.target.value)}
          rightElement={<IconSearch size={16} />}
        />
        <select
          className={styles.selectControl}
          value={normalizedFilters.status}
          onChange={(event) =>
            setFilterValue('status', event.target.value as UsageStatsFilters['status'])
          }
          aria-label="状态筛选"
        >
          <option value="all">全部状态</option>
          <option value="success">成功</option>
          <option value="failure">错误</option>
          <option value="unknown">未知</option>
        </select>
        <select
          className={styles.selectControl}
          value={normalizedFilters.model}
          onChange={(event) => setFilterValue('model', event.target.value)}
          aria-label="模型筛选"
        >
          <option value="">全部模型</option>
          {modelOptions.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
        <select
          className={styles.selectControl}
          value={normalizedFilters.source}
          onChange={(event) => setFilterValue('source', event.target.value)}
          aria-label="来源筛选"
        >
          <option value="">全部来源</option>
          {sourceOptions.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.quickFilters}>
        <label>
          <input
            type="checkbox"
            checked={normalizedFilters.onlyErrors}
            onChange={(event) => setFilterValue('onlyErrors', event.target.checked)}
          />
          只看错误
        </label>
        <label>
          <input
            type="checkbox"
            checked={normalizedFilters.onlyMismatches}
            onChange={(event) => setFilterValue('onlyMismatches', event.target.checked)}
          />
          只看被改写的请求
        </label>
        <label>
          <input
            type="checkbox"
            checked={normalizedFilters.onlyUnparsed}
            onChange={(event) => setFilterValue('onlyUnparsed', event.target.checked)}
          />
          只看还没核验的请求
        </label>
      </div>

      <div className={requestLogEnabled ? styles.logStatusOn : styles.logStatusOff}>
        <div>
          <strong>{requestLogEnabled ? '请求日志已开启' : '请求日志未开启'}</strong>
          <span>
            {requestLogEnabled
              ? `首屏自动解析最近 ${AUTO_DETAIL_LIMIT} 条详情；更多请求可以点行按需解析。`
              : '只能看到后端累计成功/失败；要核验模型路由，需要先开启请求日志。'}
          </span>
        </div>
        {!requestLogEnabled && (
          <Button
            type="button"
            variant="secondary"
            onClick={onEnableRequestLog}
            loading={enablingRequestLog}
            disabled={connectionStatus !== 'connected' || !configAvailable}
          >
            开启请求日志
          </Button>
        )}
      </div>

      {error && <div className={styles.errorBanner}>{error}</div>}
    </Card>
  );
}
