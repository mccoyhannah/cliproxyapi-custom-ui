import type {
  TokenLedgerFilters,
  TokenLedgerRangePreset,
  UsageStatsFilters,
} from '@/types/usageStatistics';

export const DEFAULT_FILTERS: UsageStatsFilters = {
  search: '',
  status: 'all',
  model: '',
  source: '',
  onlyErrors: false,
  onlyMismatches: false,
  onlyUnparsed: false,
};

export const DEFAULT_TOKEN_LEDGER_FILTERS: TokenLedgerFilters = {
  range: '30d',
  recentHours: 6,
  customStart: '',
  customEnd: '',
};

export const TOKEN_LEDGER_RANGE_OPTIONS: Array<{ value: TokenLedgerRangePreset; label: string }> = [
  { value: 'hours', label: '最近几小时' },
  { value: 'today', label: '今日' },
  { value: '7d', label: '最近 7 天' },
  { value: '30d', label: '最近 30 天' },
  { value: 'month', label: '本月' },
  { value: 'custom', label: '自定义' },
];

export const TOKEN_LEDGER_RECENT_HOUR_OPTIONS = [
  { value: 1, label: '1 小时' },
  { value: 3, label: '3 小时' },
  { value: 6, label: '6 小时' },
  { value: 12, label: '12 小时' },
  { value: 24, label: '24 小时' },
  { value: 48, label: '48 小时' },
  { value: 72, label: '72 小时' },
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
