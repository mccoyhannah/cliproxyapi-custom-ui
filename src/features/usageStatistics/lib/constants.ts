import type { UsageStatsFilters, UsageStatsRangePreset } from '@/types/usageStatistics';

export const DEFAULT_FILTERS: UsageStatsFilters = {
  range: '24h',
  customStart: '',
  customEnd: '',
  search: '',
  status: 'all',
  model: '',
  source: '',
  onlyErrors: false,
  onlyMismatches: false,
  onlyUnparsed: false,
};

export const RANGE_OPTIONS: Array<{ value: UsageStatsRangePreset; label: string }> = [
  { value: '1h', label: '最近 1 小时' },
  { value: '24h', label: '最近 24 小时' },
  { value: '7d', label: '最近 7 天' },
  { value: 'custom', label: '自定义' },
];

export const REFRESH_INTERVAL_OPTIONS = [
  { value: 8000, label: '8 秒' },
  { value: 15000, label: '15 秒' },
  { value: 30000, label: '30 秒' },
];

export const MODEL_REQUEST_PATHS = ['/v1/responses', '/v1/chat/completions', '/v1/messages'];
export const MAX_INDEX_LINES = 800;
export const PAGE_SIZE = 50;
export const AUTO_DETAIL_LIMIT = 24;
export const DETAIL_CONCURRENCY = 2;
export const MATRIX_ROW_LIMIT = 10;
export const UNPARSED_MODEL_LABEL = '还没核验';
