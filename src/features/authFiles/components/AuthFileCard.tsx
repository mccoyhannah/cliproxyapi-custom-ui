import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconChevronDown,
  IconDownload,
  IconDiamond,
  IconFileText,
  IconMinus,
  IconModelCluster,
  IconPlus,
  IconRefreshCw,
  IconSettings,
  IconTimer,
  IconTrash2,
} from '@/components/ui/icons';
import {
  ProviderStatusBar,
  type StatusBarFailureDetail,
} from '@/components/providers/ProviderStatusBar';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import {
  formatCodexSubscriptionShortDate,
  normalizePlanType,
  resolveCodexPlanType,
  resolveAuthProvider,
  type CodexAuthTimeSnapshot,
  type CodexAuthTokenSnapshot,
  type CodexSubscriptionSnapshot,
} from '@/utils/quota';
import {
  QUOTA_PROVIDER_TYPES,
  getAuthFileIcon,
  getAuthFileStatusProblem,
  getAuthFileStatusProblemFromText,
  getAuthFileStatusMessage,
  getTypeColor,
  getTypeLabel,
  isRuntimeOnlyAuthFile,
  parsePriorityValue,
  resolveQuotaErrorMessage,
  type AuthFileStatusCategory,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import type { AuthFileStatusBarData } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import { AuthFileQuotaSection } from '@/features/authFiles/components/AuthFileQuotaSection';
import { buildManualExpiryRenderInfo } from '@/features/authFiles/manualExpiry';
import styles from '@/pages/AuthFilesPage.module.scss';

const HEALTHY_STATUS_MESSAGES = new Set(['ok', 'healthy', 'ready', 'success', 'available']);
const PREMIUM_CODEX_PLAN_TYPES = new Set(['pro', 'prolite', 'pro-lite', 'pro_lite']);
type AuthFilePriorityTier = 'active' | 'standby' | 'buffer' | 'manualLocked';
type CodexCardQuotaState = {
  status?: string;
  planType?: string | null;
  rateLimitResetCreditsAvailableCount?: number | null;
  rateLimitResetCreditsError?: string;
  error?: string;
  errorStatus?: number;
  errorObservedAt?: number;
  errorKind?: AuthFileStatusCategory;
  retryable?: boolean;
};
type VisibleStatusProblem<T> = T & {
  visibleSinceMs: number;
  visibleUntilMs: number | null;
  visibleRemainingMs: number | null;
  visibleTtlMs: number | null;
};
type StatusProblemTooltipInfo = {
  label: string;
  message: string;
  requestWindow?: string;
  observedAt?: string;
  closeLabel?: string;
};
type StatusProblemTooltipPosition = {
  left: number;
  top: number;
  width: number;
  arrowLeft: number;
  placement: 'top' | 'bottom';
};

const AUTH_STATUS_LABEL_KEY: Record<AuthFileStatusCategory, string> = {
  credential_invalid: 'auth_files.credential_invalid_badge',
  account_model_restricted: 'auth_files.status_account_model_restricted_badge',
  upstream_access_blocked: 'auth_files.status_upstream_access_blocked_badge',
  local_proxy_unavailable: 'auth_files.status_local_proxy_unavailable_badge',
  dns_resolution_failed: 'auth_files.status_dns_resolution_failed_badge',
  tls_certificate_error: 'auth_files.status_tls_certificate_error_badge',
  oauth_flow_failure: 'auth_files.status_oauth_flow_failure_badge',
  connection_transient: 'auth_files.status_connection_transient_badge',
  request_interrupted: 'auth_files.status_request_interrupted_badge',
  input_too_large: 'auth_files.status_input_too_large_badge',
  content_policy: 'auth_files.status_content_policy_badge',
  rate_limited: 'auth_files.status_rate_limited_badge',
  invalid_request: 'auth_files.status_invalid_request_badge',
  upstream_service_error: 'auth_files.status_upstream_service_error_badge',
  unknown_upstream_error: 'auth_files.status_unknown_upstream_error_badge',
};

const AUTH_STATUS_LABEL_FALLBACK: Record<AuthFileStatusCategory, string> = {
  credential_invalid: '认证失效',
  account_model_restricted: '模型/账号不兼容',
  upstream_access_blocked: '上游访问受限',
  local_proxy_unavailable: '本地代理不可用',
  dns_resolution_failed: 'DNS 解析失败',
  tls_certificate_error: 'TLS/证书错误',
  oauth_flow_failure: '登录流程失败',
  connection_transient: '连接瞬断',
  request_interrupted: '请求中断',
  input_too_large: '上下文超限',
  content_policy: '内容策略拦截',
  rate_limited: '限流/额度不足',
  invalid_request: '请求/接口错误',
  upstream_service_error: '上游服务异常',
  unknown_upstream_error: '其他上游错误',
};

const AUTH_STATUS_TITLE_KEY: Record<AuthFileStatusCategory, string> = {
  credential_invalid: 'auth_files.credential_invalid_badge_title',
  account_model_restricted: 'auth_files.status_account_model_restricted_title',
  upstream_access_blocked: 'auth_files.status_upstream_access_blocked_title',
  local_proxy_unavailable: 'auth_files.status_local_proxy_unavailable_title',
  dns_resolution_failed: 'auth_files.status_dns_resolution_failed_title',
  tls_certificate_error: 'auth_files.status_tls_certificate_error_title',
  oauth_flow_failure: 'auth_files.status_oauth_flow_failure_title',
  connection_transient: 'auth_files.status_connection_transient_title',
  request_interrupted: 'auth_files.status_request_interrupted_title',
  input_too_large: 'auth_files.status_input_too_large_title',
  content_policy: 'auth_files.status_content_policy_title',
  rate_limited: 'auth_files.status_rate_limited_title',
  invalid_request: 'auth_files.status_invalid_request_title',
  upstream_service_error: 'auth_files.status_upstream_service_error_title',
  unknown_upstream_error: 'auth_files.status_unknown_upstream_error_title',
};

const AUTH_STATUS_BADGE_TTL_MS: Record<AuthFileStatusCategory, number | null> = {
  credential_invalid: null,
  account_model_restricted: 180_000,
  upstream_access_blocked: 180_000,
  local_proxy_unavailable: 90_000,
  dns_resolution_failed: 90_000,
  tls_certificate_error: 90_000,
  oauth_flow_failure: 180_000,
  connection_transient: 90_000,
  request_interrupted: 90_000,
  upstream_service_error: 90_000,
  input_too_large: 180_000,
  content_policy: 180_000,
  rate_limited: 180_000,
  invalid_request: 180_000,
  unknown_upstream_error: 90_000,
};
const RECENT_FAILURE_WINDOW_MAX_AGE_MS = 10 * 60 * 1000;

const getStatusProblemKey = (
  problem: { category: AuthFileStatusCategory; message: string; rawMessage: string } | null,
  resetKey: string
) => (problem ? `${problem.category}\u0000${problem.message}\u0000${problem.rawMessage}\u0000${resetKey}` : '');

function useVisibleStatusProblem<T extends { category: AuthFileStatusCategory; message: string; rawMessage: string }>(
  problem: T | null,
  resetKey: string
): VisibleStatusProblem<T> | null {
  const issueKey = getStatusProblemKey(problem, resetKey);
  const ttlMs = problem ? AUTH_STATUS_BADGE_TTL_MS[problem.category] : null;
  const [issueState, setIssueState] = useState({ key: '', firstSeenAt: 0 });
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      if (!issueKey) {
        setIssueState({ key: '', firstSeenAt: 0 });
        return;
      }

      const now = Date.now();
      setIssueState((current) =>
        current.key === issueKey ? current : { key: issueKey, firstSeenAt: now }
      );
      setNowMs(now);
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [issueKey]);

  useEffect(() => {
    if (!issueKey || ttlMs === null) return;
    if (issueState.key !== issueKey) return;

    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [issueKey, issueState, ttlMs]);

  if (!problem) return null;
  const visibleSinceMs =
    issueState.key === issueKey && issueState.firstSeenAt > 0 ? issueState.firstSeenAt : nowMs;
  if (ttlMs === null) {
    return {
      ...problem,
      visibleSinceMs,
      visibleUntilMs: null,
      visibleRemainingMs: null,
      visibleTtlMs: null,
    };
  }

  const visibleRemainingMs = Math.max(0, ttlMs - (nowMs - visibleSinceMs));
  if (issueState.key === issueKey && visibleRemainingMs <= 0) return null;

  return {
    ...problem,
    visibleSinceMs,
    visibleUntilMs: visibleSinceMs + ttlMs,
    visibleRemainingMs,
    visibleTtlMs: ttlMs,
  };
}

export type AuthFileCardProps = {
  file: AuthFileItem;
  compact: boolean;
  selected: boolean;
  resolvedTheme: ResolvedTheme;
  disableControls: boolean;
  deleting: boolean;
  statusUpdating: boolean;
  priorityUpdating: boolean;
  noteUpdating: boolean;
  quotaRefreshing: boolean;
  quotaRefreshDisabled: boolean;
  quotaResetting: boolean;
  quotaResetDisabled: boolean;
  quotaFilterType: QuotaProviderType | null;
  statusData: AuthFileStatusBarData;
  authTimeSnapshot?: CodexAuthTimeSnapshot | null;
  authTokenSnapshot?: CodexAuthTokenSnapshot | null;
  codexSubscriptionSnapshot?: CodexSubscriptionSnapshot | null;
  manualExpiryMs?: number | null;
  priorityTier?: AuthFilePriorityTier | null;
  accountMemo?: string | null;
  onShowModels: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  onOpenPrefixProxyEditor: (file: AuthFileItem) => void;
  onManualExpiryEdit: (file: AuthFileItem) => void;
  onRefreshQuota: (file: AuthFileItem) => void;
  onResetQuota: (file: AuthFileItem) => void;
  onAccountMemoOpen: (file: AuthFileItem) => void;
  onDelete: (name: string) => void;
  onToggleStatus: (file: AuthFileItem, enabled: boolean) => void;
  onPriorityChange: (file: AuthFileItem, priority: number) => Promise<void>;
  onDisplayNameChange: (file: AuthFileItem, note: string) => Promise<boolean>;
  onPriorityInvalid: () => void;
  onToggleSelect: (name: string) => void;
};

const resolveQuotaType = (file: AuthFileItem): QuotaProviderType | null => {
  const provider = resolveAuthProvider(file);
  if (!QUOTA_PROVIDER_TYPES.has(provider as QuotaProviderType)) return null;
  return provider as QuotaProviderType;
};

const formatStatusClock = (timestampMs: number, includeSeconds = false): string =>
  new Date(timestampMs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    ...(includeSeconds ? { second: '2-digit' as const } : {}),
  });

const formatStatusDuration = (durationMs: number): string => {
  const totalSeconds = Math.max(0, Math.ceil(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
};

const toHeaderDateLabel = (value: string): string => {
  const normalized = value
    .trim()
    .replace(/\u200e|\u200f/g, '')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ');
  if (!normalized) return '';
  const [datePart] = normalized.split(' ');
  return datePart || normalized;
};

const clampNumber = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

const redactSensitiveStatusText = (message: string): string =>
  message
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|credential|password|secret)["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^"'\s,}]+/gi,
      '$1[已隐藏]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(/([?&](?:key|api[_-]?key|access[_-]?token|refresh[_-]?token)=)[^&\s]+/gi, '$1[已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[已隐藏]');

const getStatusHttpCode = (message: string): number | null => {
  const explicitMatch = message.match(
    /\b(?:HTTP(?:\/\d(?:\.\d)?)?|["']?(?:status(?:\s+code)?|code)["']?)\s*[:=]?\s*([45]\d{2})\b/i
  );
  const standaloneMatch = message.trim().match(/^([45]\d{2})$/);
  const value = Number(explicitMatch?.[1] ?? standaloneMatch?.[1]);
  return Number.isInteger(value) ? value : null;
};

const simplifyStatusMessage = (
  category: AuthFileStatusCategory | null,
  message: string
): string => {
  const normalized = redactSensitiveStatusText(message)
    .replace(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+"[^"]+"\s*:\s*/gi, '')
    .replace(/upstream connect error or disconnect\/reset before headers\.?\s*/i, '')
    .replace(/transport failure reason:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return category ? AUTH_STATUS_LABEL_FALLBACK[category] : '状态异常';
  if (category === 'connection_transient' && /\b(?:unexpected\s+)?EOF\b/i.test(normalized)) {
    return /unexpected\s+EOF/i.test(normalized) ? 'unexpected EOF' : 'EOF';
  }
  if (category === 'local_proxy_unavailable' && /connection\s+refused/i.test(normalized)) {
    return 'Connection refused';
  }
  if (category === 'request_interrupted' && /context\s+cancell?ed/i.test(normalized)) {
    return /context\s+cancelled/i.test(normalized) ? 'context cancelled' : 'context canceled';
  }

  if (normalized.length <= 180) return normalized;
  return `${normalized.slice(0, 110)} ... ${normalized.slice(-52)}`;
};

const getLatestFailureWindow = (
  statusData: AuthFileStatusBarData
): { index: number; label: string } | null => {
  const now = Date.now();
  for (let index = statusData.blockDetails.length - 1; index >= 0; index -= 1) {
    const detail = statusData.blockDetails[index];
    if (detail.failure <= 0) continue;
    if (now - detail.endTime > RECENT_FAILURE_WINDOW_MAX_AGE_MS) continue;
    return {
      index,
      label: `${formatStatusClock(detail.startTime)} - ${formatStatusClock(detail.endTime)}`,
    };
  }
  return null;
};

const getLatestRecoveryWindow = (
  statusData: AuthFileStatusBarData
): { index: number; label: string } | null => {
  const now = Date.now();
  for (let index = statusData.blockDetails.length - 1; index >= 0; index -= 1) {
    const detail = statusData.blockDetails[index];
    if (detail.success <= 0 || detail.failure > 0) continue;
    if (now - detail.endTime > RECENT_FAILURE_WINDOW_MAX_AGE_MS) continue;
    return {
      index,
      label: `${formatStatusClock(detail.startTime)} - ${formatStatusClock(detail.endTime)}`,
    };
  }
  return null;
};

function StatusProblemTooltip({
  info,
  children,
  className,
  onActiveChange,
}: {
  info: StatusProblemTooltipInfo;
  children: ReactNode;
  className?: string;
  onActiveChange?: (active: boolean) => void;
}) {
  const { t } = useTranslation();
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<StatusProblemTooltipPosition | null>(null);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return;

    const rect = anchor.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const width = Math.min(420, Math.max(260, viewportWidth - 24));
    const measuredHeight = tooltipRef.current?.offsetHeight ?? 132;
    const centerX = rect.left + rect.width / 2;
    const left = clampNumber(centerX - width / 2, 12, Math.max(12, viewportWidth - width - 12));
    const canPlaceAbove = rect.top >= measuredHeight + 14;
    const canPlaceBelow = rect.bottom + measuredHeight + 14 <= viewportHeight;
    const placement = canPlaceAbove || !canPlaceBelow ? 'top' : 'bottom';
    const top =
      placement === 'top'
        ? clampNumber(rect.top - measuredHeight - 10, 12, viewportHeight - measuredHeight - 12)
        : rect.bottom + 10;
    const arrowLeft = clampNumber(centerX - left, 18, width - 18);

    setPosition({
      left,
      top,
      width,
      arrowLeft,
      placement,
    });
  }, []);

  const show = () => {
    setOpen(true);
    onActiveChange?.(true);
  };
  const hide = () => {
    setOpen(false);
    onActiveChange?.(false);
  };

  useEffect(() => {
    if (!open) return;

    updatePosition();
    const frameId = window.requestAnimationFrame(updatePosition);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.cancelAnimationFrame(frameId);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition, info.message, info.requestWindow, info.closeLabel]);

  const tooltipStyle = position
    ? ({
        left: `${position.left}px`,
        top: `${position.top}px`,
        maxWidth: `${position.width}px`,
        '--status-problem-arrow-left': `${position.arrowLeft}px`,
      } as CSSProperties)
    : undefined;

  return (
    <span
      ref={anchorRef}
      className={`${styles.statusProblemTooltipWrap} ${className ?? ''}`}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            ref={tooltipRef}
            className={`${styles.statusProblemTooltip} ${
              position?.placement === 'bottom' ? styles.statusProblemTooltipBelow : ''
            }`}
            role="tooltip"
            style={tooltipStyle}
          >
            <span className={styles.statusProblemTooltipHeader}>
              <span className={styles.statusProblemTooltipDot} aria-hidden="true" />
              <span>{info.label}</span>
            </span>
            <span className={styles.statusProblemTooltipMessage}>{info.message}</span>
            {(info.requestWindow || info.observedAt || info.closeLabel) && (
              <span className={styles.statusProblemTooltipMeta}>
                {info.requestWindow && (
                  <span>
                    <span className={styles.statusProblemTooltipMetaLabel}>
                      {t('auth_files.status_problem_window_short', { defaultValue: '时段' })}
                    </span>
                    {info.requestWindow}
                  </span>
                )}
                {!info.requestWindow && info.observedAt && (
                  <span>
                    <span className={styles.statusProblemTooltipMetaLabel}>
                      {t('auth_files.status_problem_observed_short', { defaultValue: '记录' })}
                    </span>
                    {info.observedAt}
                  </span>
                )}
                {info.closeLabel && (
                  <span>
                    <span className={styles.statusProblemTooltipMetaLabel}>
                      {t('auth_files.status_problem_close_short', { defaultValue: '关闭' })}
                    </span>
                    {info.closeLabel}
                  </span>
                )}
              </span>
            )}
          </span>,
          document.body
        )}
    </span>
  );
};

export const AuthFileCard = memo(function AuthFileCard(props: AuthFileCardProps) {
  const { t } = useTranslation();
  const {
    file,
    compact,
    selected,
    resolvedTheme,
    disableControls,
    deleting,
    statusUpdating,
    priorityUpdating,
    noteUpdating,
    quotaRefreshing,
    quotaRefreshDisabled,
    quotaResetting,
    quotaResetDisabled,
    quotaFilterType,
    statusData,
    authTimeSnapshot,
    authTokenSnapshot,
    codexSubscriptionSnapshot,
    manualExpiryMs,
    priorityTier,
    accountMemo,
    onShowModels,
    onDownload,
    onOpenPrefixProxyEditor,
    onManualExpiryEdit,
    onRefreshQuota,
    onResetQuota,
    onAccountMemoOpen,
    onDelete,
    onToggleStatus,
    onPriorityChange,
    onDisplayNameChange,
    onPriorityInvalid,
    onToggleSelect,
  } = props;
  const [highlightedStatusBlockIndex, setHighlightedStatusBlockIndex] = useState<number | null>(
    null
  );

  const isRuntimeOnly = isRuntimeOnlyAuthFile(file);
  const isAistudio = (file.type || '').toLowerCase() === 'aistudio';
  const showModelsButton = !isRuntimeOnly || isAistudio;
  const typeColor = getTypeColor(file.type || 'unknown', resolvedTheme);
  const typeLabel = getTypeLabel(t, file.type || 'unknown');
  const providerIcon = getAuthFileIcon(file.type || 'unknown', resolvedTheme);

  const resolvedQuotaType = resolveQuotaType(file);
  const codexQuotaEntry = useQuotaStore((state) => {
    if (resolvedQuotaType !== 'codex') return null;
    return (state.codexQuota[file.name] as CodexCardQuotaState | undefined) ?? null;
  });
  const selectedQuotaType =
    quotaFilterType && resolvedQuotaType === quotaFilterType ? quotaFilterType : null;
  const quotaType = selectedQuotaType ?? (resolvedQuotaType === 'codex' ? 'codex' : null);
  const showQuotaLayout =
    Boolean(quotaType) &&
    !isRuntimeOnly &&
    (quotaType === 'codex' || (!compact && selectedQuotaType !== null));
  const showQuotaSummaryOnly = quotaType === 'codex' && (compact || selectedQuotaType !== 'codex');
  const codexQuotaPlanType =
    resolvedQuotaType === 'codex' && codexQuotaEntry?.status === 'success'
      ? (codexQuotaEntry.planType ?? null)
      : null;
  const currentCodexPlanType =
    resolvedQuotaType === 'codex' ? normalizePlanType(codexQuotaPlanType) : null;
  const fileCodexPlanType =
    resolvedQuotaType === 'codex' ? normalizePlanType(resolveCodexPlanType(file)) : null;
  const effectiveCodexPlanType =
    resolvedQuotaType === 'codex'
      ? currentCodexPlanType ?? fileCodexPlanType
      : null;
  const accessTokenOnly =
    resolvedQuotaType === 'codex' && authTokenSnapshot?.hasRefreshToken === false;
  const manualExpiry = accessTokenOnly ? null : buildManualExpiryRenderInfo(manualExpiryMs);
  const hasStoredCodexSubscription =
    resolvedQuotaType === 'codex' &&
    !accessTokenOnly &&
    codexSubscriptionSnapshot?.subscriptionStatus === 'found' &&
    Boolean(codexSubscriptionSnapshot.subscriptionActiveUntil);
  const shouldAssumePlusHeaderPlan =
    resolvedQuotaType === 'codex' &&
    !effectiveCodexPlanType &&
    Boolean(accessTokenOnly || manualExpiry || hasStoredCodexSubscription);
  const headerCodexPlanType =
    effectiveCodexPlanType ?? (shouldAssumePlusHeaderPlan ? 'plus' : null);
  const headerCodexPlanLabel = (() => {
    if (resolvedQuotaType !== 'codex' || !headerCodexPlanType) return null;
    if (headerCodexPlanType === 'pro') {
      return t('codex_quota.plan_pro', { defaultValue: 'Pro 20x' });
    }
    if (
      PREMIUM_CODEX_PLAN_TYPES.has(headerCodexPlanType) &&
      headerCodexPlanType !== 'pro'
    ) {
      return t('codex_quota.plan_prolite', { defaultValue: 'Pro 5x' });
    }
    if (headerCodexPlanType === 'plus') {
      return t('codex_quota.plan_plus', { defaultValue: 'Plus' });
    }
    if (headerCodexPlanType === 'team') {
      return t('codex_quota.plan_team', { defaultValue: '团队版' });
    }
    if (headerCodexPlanType === 'free') {
      return t('codex_quota.plan_free', { defaultValue: '免费版' });
    }
    return t('codex_quota.plan_unknown', { defaultValue: '未记录' });
  })();
  const headerCodexPlanToneClass =
    headerCodexPlanType === 'team'
      ? styles.planHeaderBadgeTeam
      : headerCodexPlanType === 'plus'
        ? styles.planHeaderBadgePlus
        : headerCodexPlanType === 'free'
          ? styles.planHeaderBadgeFree
          : PREMIUM_CODEX_PLAN_TYPES.has(headerCodexPlanType ?? '')
            ? styles.planHeaderBadgePremium
            : styles.planHeaderBadgeMuted;
  const codexPlanCanHaveSubscriptionExpiry =
    resolvedQuotaType === 'codex' &&
    (effectiveCodexPlanType
      ? effectiveCodexPlanType !== 'free'
      : Boolean(accessTokenOnly || manualExpiry || hasStoredCodexSubscription));
  const accessTokenExpiryUnknownLabel = t('auth_files.access_token_expiry_unknown', {
    defaultValue: '无法识别',
  });
  const accessTokenExpiryTitle =
    authTokenSnapshot?.accessTokenExpiresAt ??
    t('auth_files.access_token_expiry_unknown_title', {
      defaultValue: '没有 refresh_token，且无法识别 access_token 到期时间',
    });

  const fileStats = {
    success: statusData.totalSuccess,
    failure: statusData.totalFailure,
  };
  const rawStatusMessage = getAuthFileStatusMessage(file);
  const parsedAuthFileStatusProblem = getAuthFileStatusProblem(file);
  const hasStatusWarning =
    Boolean(rawStatusMessage) && !HEALTHY_STATUS_MESSAGES.has(rawStatusMessage.toLowerCase());
  const authFileStatusProblem =
    !isRuntimeOnly && !file.disabled && hasStatusWarning ? parsedAuthFileStatusProblem : null;
  const latestFailureRequestWindow = getLatestFailureWindow(statusData);
  const latestRecoveryRequestWindow = getLatestRecoveryWindow(statusData);
  const codexQuotaSucceeded = resolvedQuotaType === 'codex' && codexQuotaEntry?.status === 'success';
  const credentialInvalidHasRecovery =
    authFileStatusProblem?.category === 'credential_invalid' &&
    (codexQuotaSucceeded ||
      (latestRecoveryRequestWindow !== null &&
        (latestFailureRequestWindow === null ||
          latestRecoveryRequestWindow.index > latestFailureRequestWindow.index)));
  const effectiveAuthFileStatusProblem = credentialInvalidHasRecovery
    ? null
    : authFileStatusProblem;
  const shouldShowRawStatusWarning = hasStatusWarning && !credentialInvalidHasRecovery;
  const authStatusVisibilityKey = [
    statusData.totalFailure,
    file.lastRefresh ?? '',
    file.modified ?? '',
    file['modtime'] ?? '',
    codexQuotaEntry?.status ?? '',
  ].join('|');
  const visibleAuthFileStatusProblem = useVisibleStatusProblem(
    effectiveAuthFileStatusProblem,
    authStatusVisibilityKey
  );
  const shouldShowAuthFileStatusProblem =
    visibleAuthFileStatusProblem !== null &&
    (visibleAuthFileStatusProblem.category === 'credential_invalid' ||
      latestFailureRequestWindow !== null);
  const credentialStatusProblem =
    shouldShowAuthFileStatusProblem &&
    visibleAuthFileStatusProblem?.category === 'credential_invalid'
      ? visibleAuthFileStatusProblem
      : null;
  const hasAuthFileStatusProblem = shouldShowAuthFileStatusProblem;
  const hasCredentialStatusError = credentialStatusProblem !== null;
  const getStatusBadgeLabel = (category: AuthFileStatusCategory) =>
    t(AUTH_STATUS_LABEL_KEY[category], {
      defaultValue: AUTH_STATUS_LABEL_FALLBACK[category],
    });
  const shouldShowRequestFailureDetail =
    !isRuntimeOnly &&
    !file.disabled &&
    hasStatusWarning &&
    !credentialInvalidHasRecovery;
  const errorClueLabel = t('auth_files.status_error_clue_label', {
    defaultValue: '错误线索',
  });
  const requestFailureDetail: StatusBarFailureDetail | null = shouldShowRequestFailureDetail
    ? {
        label: parsedAuthFileStatusProblem
          ? getStatusBadgeLabel(parsedAuthFileStatusProblem.category)
          : errorClueLabel,
        message: simplifyStatusMessage(
          parsedAuthFileStatusProblem?.category ?? null,
          parsedAuthFileStatusProblem?.message || rawStatusMessage
        ),
        httpStatus: getStatusHttpCode(
          parsedAuthFileStatusProblem?.rawMessage || rawStatusMessage
        ),
      }
    : null;
  const requestFailureDetailUnavailableLabel = t(
    'auth_files.status_failure_detail_unavailable',
    {
      defaultValue: '该时段有失败，但当前 CPA 只记录次数，没有可关联的具体原因',
    }
  );
  const buildStatusProblemInfo = (
    label: string,
    message: string,
    problem: VisibleStatusProblem<{
      category: AuthFileStatusCategory;
      message: string;
      rawMessage: string;
    }> | null,
    options: { observedAtMs?: number; requestWindow?: string } = {}
  ): StatusProblemTooltipInfo => {
    const requestWindow = options.requestWindow ?? latestFailureRequestWindow?.label;
    const observedAt = options.observedAtMs
      ? formatStatusClock(options.observedAtMs, true)
      : undefined;
    let closeLabel: string | undefined;

    if (problem?.visibleRemainingMs !== null && problem?.visibleRemainingMs !== undefined) {
      closeLabel = t('auth_files.status_problem_close_in', {
        time: formatStatusDuration(problem.visibleRemainingMs),
        defaultValue: '{{time}} 后关闭',
      });
    } else if (problem) {
      closeLabel = t('auth_files.status_problem_close_persistent', {
        defaultValue: '认证恢复后关闭',
      });
    }

  return {
    label,
    message: simplifyStatusMessage(problem?.category ?? null, message),
    requestWindow,
    observedAt,
    closeLabel,
  };
  };
  const credentialInvalidBadgeLabel = getStatusBadgeLabel('credential_invalid');
  const authFileStatusBadgeLabel = visibleAuthFileStatusProblem
    ? getStatusBadgeLabel(visibleAuthFileStatusProblem.category)
    : '';
  const hasQuotaError =
    !isRuntimeOnly &&
    !file.disabled &&
    resolvedQuotaType === 'codex' &&
    codexQuotaEntry?.status === 'error';
  const quotaErrorStatus =
    typeof codexQuotaEntry?.errorStatus === 'number' ? codexQuotaEntry.errorStatus : undefined;
  const quotaErrorMessage = hasQuotaError
    ? resolveQuotaErrorMessage(
        t,
        quotaErrorStatus,
        codexQuotaEntry?.error || t('common.unknown_error')
      )
    : '';
  const quotaStatusProblem = hasQuotaError
    ? getAuthFileStatusProblemFromText(
        [
          quotaErrorStatus,
          codexQuotaEntry?.errorKind,
          codexQuotaEntry?.error,
          quotaErrorMessage,
        ]
          .filter((part) => part !== undefined && part !== null && String(part).trim())
          .join(' ')
      )
    : null;
  const visibleQuotaStatusProblem = useVisibleStatusProblem(
    quotaStatusProblem,
    [codexQuotaEntry?.errorObservedAt ?? '', statusData.totalFailure].join('|')
  );
  const quotaCredentialError =
    hasQuotaError && visibleQuotaStatusProblem?.category === 'credential_invalid';
  const quotaErrorBadgeLabel = visibleQuotaStatusProblem
    ? getStatusBadgeLabel(visibleQuotaStatusProblem.category)
    : quotaCredentialError
      ? credentialInvalidBadgeLabel
      : t('auth_files.quota_error_badge', { defaultValue: '额度异常' });
  const hasVisibleQuotaError =
    hasQuotaError && (!quotaStatusProblem || visibleQuotaStatusProblem !== null);
  const hideDuplicateQuotaStatusBadge =
    hasAuthFileStatusProblem &&
    hasVisibleQuotaError &&
    visibleQuotaStatusProblem?.category === visibleAuthFileStatusProblem?.category;
  const hasVisibleStatusWarning =
    hasVisibleQuotaError ||
    hasAuthFileStatusProblem ||
    (shouldShowRawStatusWarning &&
      !effectiveAuthFileStatusProblem &&
      latestFailureRequestWindow !== null);

  const priorityValue = parsePriorityValue(file.priority ?? file['priority']);
  const currentPriorityText =
    priorityValue === undefined || priorityValue === 0 ? '0' : String(priorityValue);
  const [priorityDraft, setPriorityDraft] = useState({
    fileName: file.name,
    value: currentPriorityText,
    dirty: false,
  });
  const priorityInput =
    priorityDraft.fileName === file.name && priorityDraft.dirty
      ? priorityDraft.value
      : currentPriorityText;
  const noteValue = typeof file.note === 'string' ? file.note.trim() : '';
  const displayName = noteValue || file.name;
  const displayNameTitle = noteValue ? `${noteValue} (${file.name})` : file.name;
  const accountMemoText = typeof accountMemo === 'string' ? accountMemo.trim() : '';
  const hasAccountMemo = accountMemoText.length > 0;
  const accountMemoButtonLabel = hasAccountMemo
    ? t('auth_files.account_memo_button_filled', { defaultValue: '查看/编辑账号备注' })
    : t('auth_files.account_memo_button_empty', { defaultValue: '添加账号备注' });
  const showCardQuotaRefreshButton = resolvedQuotaType === 'codex' && !isRuntimeOnly;
  const showCardQuotaResetButton =
    showCardQuotaRefreshButton &&
    (codexQuotaEntry?.rateLimitResetCreditsAvailableCount ?? 0) > 0 &&
    !codexQuotaEntry?.rateLimitResetCreditsError?.trim();
  const cardQuotaRefreshLabel = t('auth_files.quota_refresh_single_button', {
    defaultValue: '刷新这个认证文件的额度',
  });
  const cardQuotaResetLabel = t('codex_quota.reset_button', {
    defaultValue: '消耗一次重置额度',
  });
  const visibleAuthTimeSnapshot =
    showCardQuotaRefreshButton && authTimeSnapshot?.authenticatedAtShort ? authTimeSnapshot : null;
  const authTimeTitle = visibleAuthTimeSnapshot
    ? visibleAuthTimeSnapshot.authTimeStatus === 'fallback'
      ? t('auth_files.auth_time_fallback_title', {
          time:
            visibleAuthTimeSnapshot.authenticatedAt ??
            visibleAuthTimeSnapshot.authenticatedAtShort,
          defaultValue: '未识别 token 认证时间，显示文件更新时间：{{time}}',
        })
      : t('auth_files.auth_time_title', {
          time:
            visibleAuthTimeSnapshot.authenticatedAt ??
            visibleAuthTimeSnapshot.authenticatedAtShort,
          defaultValue: '认证时间：{{time}}',
        })
    : '';
  const authTimeClassName = [
    styles.codexAuthTimeActionMeta,
    visibleAuthTimeSnapshot?.authTimeStatus === 'fallback'
      ? styles.codexAuthTimeActionMetaFallback
      : '',
  ]
    .filter(Boolean)
    .join(' ');
  const displayNameInputId = `auth-display-name-${file.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const [displayNameDraft, setDisplayNameDraft] = useState({
    fileName: file.name,
    value: noteValue,
    editing: false,
  });
  const displayNameEditing =
    displayNameDraft.fileName === file.name && displayNameDraft.editing;
  const displayNameInputRef = useRef<HTMLInputElement | null>(null);
  const skipDisplayNameBlurRef = useRef(false);
  const [utilityActionsState, setUtilityActionsState] = useState({
    fileName: file.name,
    open: false,
  });
  const utilityActionsOpen =
    utilityActionsState.fileName === file.name && utilityActionsState.open;
  const utilityActionsButtonRef = useRef<HTMLDivElement | null>(null);
  const utilityActionsMenuRef = useRef<HTMLDivElement | null>(null);
  const utilityActionsId = `auth-utility-actions-${file.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const priorityHoldDelayRef = useRef<number | null>(null);
  const priorityHoldIntervalRef = useRef<number | null>(null);
  const priorityHoldValueRef = useRef(priorityValue ?? 0);
  const priorityInputId = `auth-priority-${file.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const prioritySaving = priorityUpdating;
  const priorityToneValue = parsePriorityValue(priorityInput.trim() || '0') ?? 0;
  const priorityIsUnassigned = priorityToneValue === 0;
  const priorityEditorTitle = priorityIsUnassigned
    ? t('auth_files.priority_unassigned_hint', {
        defaultValue: '未分配优先级（已排除/P0）',
      })
    : t('auth_files.priority_hint');
  const displayNameSaving = noteUpdating;
  const showPriorityTier =
    Boolean(priorityTier) &&
    resolvedQuotaType === 'codex' &&
    (effectiveCodexPlanType === 'team' || effectiveCodexPlanType === 'plus');
  const isFreeCodexPriority = resolvedQuotaType === 'codex' && effectiveCodexPlanType === 'free';
  const priorityTierLabel =
    priorityTier === 'active'
      ? t('auth_files.priority_rotation_tier_active')
      : priorityTier === 'standby'
        ? t('auth_files.priority_rotation_tier_standby')
        : priorityTier === 'buffer'
          ? t('auth_files.priority_rotation_tier_buffer')
          : priorityTier === 'manualLocked'
            ? t('auth_files.priority_rotation_tier_manual_locked')
          : '';
  const priorityTierClass =
    priorityTier === 'active'
      ? styles.priorityBadgeEditorActive
      : priorityTier === 'standby'
        ? styles.priorityBadgeEditorStandby
        : priorityTier === 'buffer'
          ? styles.priorityBadgeEditorBuffer
          : priorityTier === 'manualLocked'
            ? styles.priorityBadgeEditorManualLocked
          : '';
  const [referenceTimeMs] = useState(() => Date.now());
  const visibleCodexSubscription =
    hasStoredCodexSubscription && codexPlanCanHaveSubscriptionExpiry
      ? codexSubscriptionSnapshot
      : null;
  const showManualExpirySetup =
    !accessTokenOnly &&
    Boolean(effectiveCodexPlanType) &&
    codexPlanCanHaveSubscriptionExpiry &&
    !manualExpiry &&
    !visibleCodexSubscription;
  const subscriptionWarningMs = 7 * 24 * 60 * 60 * 1000;
  const subscriptionExpiryMs =
    accessTokenOnly
      ? authTokenSnapshot?.accessTokenExpiresAtMs
      : (manualExpiry?.expiresAtMs ?? visibleCodexSubscription?.subscriptionActiveUntilMs);
  const subscriptionExpired =
    subscriptionExpiryMs !== null &&
    subscriptionExpiryMs !== undefined &&
    subscriptionExpiryMs <= referenceTimeMs;
  const accessTokenExpired = accessTokenOnly && subscriptionExpired;
  const subscriptionExpiringSoon =
    !subscriptionExpired &&
    subscriptionExpiryMs !== null &&
    subscriptionExpiryMs !== undefined &&
    subscriptionExpiryMs - referenceTimeMs <= subscriptionWarningMs;
  const subscriptionExpiryClass = showManualExpirySetup
    ? styles.subscriptionExpiryUnset
    : subscriptionExpired
      ? styles.subscriptionExpiryExpired
      : subscriptionExpiringSoon
        ? styles.subscriptionExpiryWarning
        : styles.subscriptionExpiryHealthy;
  const subscriptionExpiryLabel =
    accessTokenOnly
      ? accessTokenExpiryTitle
      : (manualExpiry?.title ??
        visibleCodexSubscription?.subscriptionActiveUntil ??
        t('auth_files.manual_expiry_setup_title', {
          defaultValue: '为该付费套餐手动设置有效期',
        }));
  const subscriptionExpiryDisplayLabel = compact
    ? accessTokenOnly
      ? formatCodexSubscriptionShortDate(
          authTokenSnapshot?.accessTokenExpiresAtMs,
          authTokenSnapshot?.accessTokenExpiresAt
        ) || accessTokenExpiryUnknownLabel
      : showManualExpirySetup
      ? t('auth_files.manual_expiry_setup_chip', { defaultValue: '设置有效期' })
      : manualExpiry?.label ??
      formatCodexSubscriptionShortDate(
        visibleCodexSubscription?.subscriptionActiveUntilMs,
        subscriptionExpiryLabel
      )
    : accessTokenOnly
      ? authTokenSnapshot?.accessTokenExpiresAt ?? accessTokenExpiryUnknownLabel
      : showManualExpirySetup
      ? t('auth_files.manual_expiry_setup_chip', { defaultValue: '设置有效期' })
      : subscriptionExpiryLabel;
  const accessTokenMetaLabel = accessTokenExpired
    ? t('auth_files.access_token_expired_short_label', {
        defaultValue: 'Access 已过期',
      })
    : t('auth_files.access_token_expiry_short_label', {
        defaultValue: 'Access 到期',
      });
  const credentialStatusMessage =
    credentialStatusProblem?.message || t('common.unknown_error');
  const credentialInvalidTitle =
    accessTokenOnly && !accessTokenExpired
      ? t('auth_files.credential_invalid_access_active_title', {
          expiry: subscriptionExpiryLabel || accessTokenExpiryUnknownLabel,
          message: credentialStatusMessage,
          defaultValue:
            'Access 尚未到期（{{expiry}}），但上游已拒绝此认证：{{message}}。请重新登录获取新凭证。',
        })
      : t('auth_files.credential_invalid_badge_title', {
          message: credentialStatusMessage,
          defaultValue: '上游已拒绝此认证：{{message}}。请重新登录获取新凭证。',
        });
  const authFileStatusBaseTitle = visibleAuthFileStatusProblem
    ? visibleAuthFileStatusProblem.category === 'credential_invalid'
      ? credentialInvalidTitle
      : t(AUTH_STATUS_TITLE_KEY[visibleAuthFileStatusProblem.category], {
          message: visibleAuthFileStatusProblem.message,
          defaultValue: `${authFileStatusBadgeLabel}: ${visibleAuthFileStatusProblem.message}`,
        })
    : '';
  const authFileStatusInfo = visibleAuthFileStatusProblem
    ? buildStatusProblemInfo(
        authFileStatusBadgeLabel,
        authFileStatusBaseTitle,
        visibleAuthFileStatusProblem
      )
    : null;
  const quotaErrorInfo =
    hasVisibleQuotaError && visibleQuotaStatusProblem
      ? buildStatusProblemInfo(quotaErrorBadgeLabel, visibleQuotaStatusProblem.message || quotaErrorMessage, visibleQuotaStatusProblem, {
          observedAtMs:
            typeof codexQuotaEntry?.errorObservedAt === 'number'
              ? codexQuotaEntry.errorObservedAt
              : undefined,
          requestWindow: '',
        })
      : hasVisibleQuotaError
        ? {
            label: quotaErrorBadgeLabel,
            message: quotaErrorMessage,
          }
        : null;
  const setRequestWindowHighlight = (
    active: boolean,
    info: StatusProblemTooltipInfo | null
  ) => {
    setHighlightedStatusBlockIndex(
      active && info?.requestWindow ? (latestFailureRequestWindow?.index ?? null) : null
    );
  };
  const authFileStatusBadgeClass =
    visibleAuthFileStatusProblem?.category === 'credential_invalid'
      ? `${styles.stateBadgeQuotaError} ${styles.credentialInvalidHeaderBadge}`
      : styles.stateBadgeWarning;
  const hasCredentialInvalidStatus =
    visibleAuthFileStatusProblem?.category === 'credential_invalid' ||
    visibleQuotaStatusProblem?.category === 'credential_invalid' ||
    quotaCredentialError;
  const showHeaderCodexPlan = Boolean(headerCodexPlanLabel) && !hasCredentialInvalidStatus;
  const headerSubscriptionDateLabel = accessTokenOnly
    ? formatCodexSubscriptionShortDate(
        authTokenSnapshot?.accessTokenExpiresAtMs,
        authTokenSnapshot?.accessTokenExpiresAt
      ) || accessTokenExpiryUnknownLabel
    : (manualExpiry?.label ??
      formatCodexSubscriptionShortDate(
        visibleCodexSubscription?.subscriptionActiveUntilMs,
        visibleCodexSubscription?.subscriptionActiveUntil
      ));
  const compactHeaderSubscriptionDateLabel = toHeaderDateLabel(headerSubscriptionDateLabel);
  const headerSubscriptionLabel = showManualExpirySetup
    ? t('auth_files.manual_expiry_setup_chip', { defaultValue: '设置有效期' })
    : accessTokenOnly
      ? accessTokenExpired
        ? t('auth_files.access_token_expired_header_badge', {
            date: compactHeaderSubscriptionDateLabel,
            defaultValue: 'Access 已过期 {{date}}',
          })
        : t('auth_files.access_token_expiry_header_badge', {
            date: compactHeaderSubscriptionDateLabel,
            defaultValue: 'Access 有效至 {{date}}',
          })
      : subscriptionExpired
        ? t('auth_files.subscription_expired_header_badge', {
            date: compactHeaderSubscriptionDateLabel,
            defaultValue: '已过期 {{date}}',
          })
        : subscriptionExpiringSoon
          ? t('auth_files.subscription_expiring_soon_header_badge', {
              date: compactHeaderSubscriptionDateLabel,
              defaultValue: '临期 {{date}}',
            })
          : t('auth_files.subscription_valid_until_header_badge', {
              date: compactHeaderSubscriptionDateLabel,
              defaultValue: '有效至 {{date}}',
            });
  const headerSubscriptionToneClass = showManualExpirySetup
    ? styles.subscriptionHeaderUnset
    : subscriptionExpired || accessTokenExpired
      ? styles.subscriptionHeaderExpired
      : subscriptionExpiringSoon
        ? styles.subscriptionHeaderWarning
        : styles.subscriptionHeaderHealthy;
  const showHeaderSubscriptionMeta =
    !hasCredentialInvalidStatus &&
    Boolean(accessTokenOnly || manualExpiry || visibleCodexSubscription || showManualExpirySetup);
  const headerSubscriptionEditable = !accessTokenOnly && !disableControls && !isRuntimeOnly;
  const showSubscriptionMeta =
    !hasCredentialInvalidStatus &&
    !showHeaderSubscriptionMeta &&
    Boolean(accessTokenOnly || manualExpiry || visibleCodexSubscription || showManualExpirySetup) &&
    !showQuotaLayout;

  const setPriorityInput = (value: string) => {
    setPriorityDraft({ fileName: file.name, value, dirty: true });
  };

  useEffect(() => {
    if (!displayNameEditing) return;
    const input = displayNameInputRef.current;
    input?.focus();
    input?.select();
  }, [displayNameEditing, file.name]);

  useEffect(() => {
    if (!utilityActionsOpen) return;

    const closeUtilityActions = () => {
      setUtilityActionsState({ fileName: file.name, open: false });
    };

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        closeUtilityActions();
        return;
      }
      if (
        utilityActionsButtonRef.current?.contains(target) ||
        utilityActionsMenuRef.current?.contains(target)
      ) {
        return;
      }
      closeUtilityActions();
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeUtilityActions();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [file.name, utilityActionsOpen]);

  const startDisplayNameEdit = () => {
    if (disableControls || isRuntimeOnly || displayNameSaving) return;
    setDisplayNameDraft({ fileName: file.name, value: noteValue, editing: true });
  };

  const closeUtilityActions = () => {
    setUtilityActionsState({ fileName: file.name, open: false });
  };

  const cancelDisplayNameEdit = () => {
    setDisplayNameDraft({ fileName: file.name, value: noteValue, editing: false });
  };

  const commitDisplayNameInput = async () => {
    if (!displayNameEditing || displayNameSaving) return;

    const nextNote = displayNameDraft.value.trim();
    if (nextNote === noteValue) {
      cancelDisplayNameEdit();
      return;
    }

    await onDisplayNameChange(file, nextNote);
    setDisplayNameDraft({ fileName: file.name, value: nextNote, editing: false });
  };

  const handleDisplayNameBlur = () => {
    if (skipDisplayNameBlurRef.current) {
      skipDisplayNameBlurRef.current = false;
      return;
    }
    void commitDisplayNameInput();
  };

  const handleDisplayNameKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      skipDisplayNameBlurRef.current = true;
      cancelDisplayNameEdit();
      event.currentTarget.blur();
    }
  };

  const resetPriorityInput = () => {
    setPriorityDraft({ fileName: file.name, value: currentPriorityText, dirty: false });
  };

  const savePriorityValue = (nextPriority: number) => {
    const currentPriority = priorityValue ?? 0;
    if (nextPriority === currentPriority) {
      resetPriorityInput();
      return;
    }

    setPriorityDraft({ fileName: file.name, value: String(nextPriority), dirty: false });
    void onPriorityChange(file, nextPriority);
  };

  const commitPriorityInput = () => {
    const trimmed = priorityInput.trim();
    const nextPriority = trimmed ? parsePriorityValue(trimmed) : 0;

    if (nextPriority === undefined) {
      onPriorityInvalid();
      resetPriorityInput();
      return;
    }

    savePriorityValue(nextPriority);
  };

  const stepPriorityInput = (delta: number, baseOverride?: number) => {
    const draftPriority = parsePriorityValue(priorityInput.trim());
    const basePriority = baseOverride ?? draftPriority ?? priorityValue ?? 0;
    const nextPriority = Math.max(0, basePriority + delta);
    savePriorityValue(nextPriority);
    return nextPriority;
  };

  const stopPriorityHold = () => {
    if (priorityHoldDelayRef.current !== null) {
      window.clearTimeout(priorityHoldDelayRef.current);
      priorityHoldDelayRef.current = null;
    }
    if (priorityHoldIntervalRef.current !== null) {
      window.clearInterval(priorityHoldIntervalRef.current);
      priorityHoldIntervalRef.current = null;
    }
  };

  const startPriorityHold = (delta: number) => {
    if (disableControls || prioritySaving) return;
    stopPriorityHold();
    priorityHoldValueRef.current = stepPriorityInput(delta);
    priorityHoldDelayRef.current = window.setTimeout(() => {
      priorityHoldIntervalRef.current = window.setInterval(() => {
        priorityHoldValueRef.current = stepPriorityInput(delta, priorityHoldValueRef.current);
      }, 120);
    }, 360);
  };

  const handlePriorityKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      resetPriorityInput();
      event.currentTarget.blur();
    }
  };

  useEffect(
    () => () => {
      if (priorityHoldDelayRef.current !== null) {
        window.clearTimeout(priorityHoldDelayRef.current);
      }
      if (priorityHoldIntervalRef.current !== null) {
        window.clearInterval(priorityHoldIntervalRef.current);
      }
    },
    []
  );

  const stateLabel = isRuntimeOnly
    ? t('auth_files.type_virtual') || '虚拟认证文件'
    : file.disabled
      ? t('auth_files.health_status_disabled')
      : hasVisibleQuotaError
        ? t('auth_files.health_status_quota_error', { defaultValue: '额度异常' })
      : hasAuthFileStatusProblem
        ? authFileStatusBadgeLabel
      : shouldShowRawStatusWarning &&
          !effectiveAuthFileStatusProblem &&
          latestFailureRequestWindow !== null
        ? t('auth_files.health_status_warning')
        : rawStatusMessage
          ? t('auth_files.health_status_healthy')
          : t('auth_files.status_toggle_label');
  const stateBadgeClass = isRuntimeOnly
    ? styles.stateBadgeVirtual
    : file.disabled
      ? styles.stateBadgeDisabled
      : hasVisibleQuotaError
        ? styles.stateBadgeQuotaError
      : hasVisibleStatusWarning
        ? styles.stateBadgeWarning
        : styles.stateBadgeActive;
  const cardPlanToneClass =
    hasCredentialInvalidStatus || file.disabled || isRuntimeOnly
      ? ''
      : headerCodexPlanType === 'team'
        ? styles.fileCardCompactPlanTeam
        : headerCodexPlanType === 'plus'
          ? styles.fileCardCompactPlanPlus
          : headerCodexPlanType === 'free'
            ? styles.fileCardCompactPlanFree
            : PREMIUM_CODEX_PLAN_TYPES.has(headerCodexPlanType ?? '')
              ? styles.fileCardCompactPlanPremium
              : '';
  const cardToneClass = [
    cardPlanToneClass,
    isRuntimeOnly ? styles.fileCardVirtual : '',
    hasVisibleQuotaError ? styles.fileCardQuotaError : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={`${styles.fileCard} ${compact ? styles.fileCardCompact : ''} ${cardToneClass} ${selected ? styles.fileCardSelected : ''} ${file.disabled ? styles.fileCardDisabled : ''}`}
    >
      {isRuntimeOnly && (
        <div className={styles.runtimeLockRibbon}>
          {t('auth_files.table_status_runtime', { defaultValue: '只读 / Runtime' })}
        </div>
      )}
      <div className={styles.fileCardLayout}>
        <div className={styles.fileCardMain}>
          <div className={styles.cardHeader}>
            {!isRuntimeOnly && (
              <SelectionCheckbox
                checked={selected}
                onChange={() => onToggleSelect(file.name)}
                className={styles.cardSelection}
                aria-label={
                  selected ? t('auth_files.batch_deselect') : t('auth_files.batch_select_all')
                }
                title={selected ? t('auth_files.batch_deselect') : t('auth_files.batch_select_all')}
              />
            )}
            <div
              className={styles.providerAvatar}
              style={{
                backgroundColor: typeColor.bg,
                color: typeColor.text,
                ...(typeColor.border ? { border: typeColor.border } : {}),
              }}
            >
              {providerIcon ? (
                <img src={providerIcon} alt="" className={styles.providerAvatarImage} />
              ) : (
                <span className={styles.providerAvatarFallback}>
                  {typeLabel.slice(0, 1).toUpperCase()}
                </span>
              )}
            </div>
            <div className={styles.cardHeaderContent}>
              <div className={styles.cardBadgeRow}>
                <span
                  className={styles.typeBadge}
                  style={{
                    backgroundColor: typeColor.bg,
                    color: typeColor.text,
                    ...(typeColor.border ? { border: typeColor.border } : {}),
                  }}
                >
                  {typeLabel}
                </span>
                {showHeaderCodexPlan && (
                  <span
                    className={`${styles.planHeaderBadge} ${headerCodexPlanToneClass}`}
                    title={`${t('codex_quota.plan_label', { defaultValue: '套餐' })} ${headerCodexPlanLabel}`}
                  >
                    {headerCodexPlanLabel}
                  </span>
                )}
                {showHeaderSubscriptionMeta &&
                  (headerSubscriptionEditable ? (
                    <button
                      type="button"
                      className={`${styles.subscriptionHeaderBadge} ${headerSubscriptionToneClass}`}
                      title={subscriptionExpiryLabel || undefined}
                      onClick={() => onManualExpiryEdit(file)}
                    >
                      <span>{headerSubscriptionLabel}</span>
                    </button>
                  ) : (
                    <span
                      className={`${styles.subscriptionHeaderBadge} ${headerSubscriptionToneClass}`}
                      title={subscriptionExpiryLabel || undefined}
                    >
                      <span>{headerSubscriptionLabel}</span>
                    </span>
                  ))}
                {!isRuntimeOnly && (
                  <button
                    type="button"
                    className={`${styles.accountMemoButton} ${
                      hasAccountMemo ? styles.accountMemoButtonActive : ''
                    }`}
                    onClick={() => onAccountMemoOpen(file)}
                    aria-label={accountMemoButtonLabel}
                    title={accountMemoButtonLabel}
                  >
                    <IconFileText size={14} />
                  </button>
                )}
                {(isRuntimeOnly ||
                  hasAuthFileStatusProblem ||
                  (accessTokenOnly && !hasCredentialStatusError) ||
                  (hasVisibleQuotaError && !hideDuplicateQuotaStatusBadge)) && (
                  <span className={styles.cardHeaderStatusBadges}>
                    {isRuntimeOnly && (
                      <span className={`${styles.stateBadge} ${stateBadgeClass}`}>
                        {stateLabel}
                      </span>
                    )}
                    {hasAuthFileStatusProblem && authFileStatusInfo && (
                      <StatusProblemTooltip
                        info={authFileStatusInfo}
                        onActiveChange={(active) =>
                          setRequestWindowHighlight(active, authFileStatusInfo)
                        }
                      >
                        <span
                          className={`${styles.stateBadge} ${authFileStatusBadgeClass}`}
                          tabIndex={0}
                        >
                          {authFileStatusBadgeLabel}
                        </span>
                      </StatusProblemTooltip>
                    )}
                    {accessTokenOnly && !hasCredentialStatusError && (
                      <span
                        className={`${styles.stateBadge} ${styles.refreshTokenWarningBadge}`}
                        title={t('auth_files.missing_refresh_token_badge_title', {
                          defaultValue: '没有 refresh_token，过期后需要重新登录获取新凭证',
                        })}
                      >
                        {t('auth_files.missing_refresh_token_badge', {
                          defaultValue: '临时凭证',
                        })}
                      </span>
                    )}
                    {hasVisibleQuotaError && !hideDuplicateQuotaStatusBadge && quotaErrorInfo && (
                      <StatusProblemTooltip info={quotaErrorInfo}>
                        <span
                          className={`${styles.stateBadge} ${
                            visibleQuotaStatusProblem &&
                            visibleQuotaStatusProblem.category !== 'credential_invalid'
                              ? styles.stateBadgeWarning
                              : `${styles.stateBadgeQuotaError} ${styles.credentialInvalidHeaderBadge}`
                          }`}
                          tabIndex={0}
                        >
                          {quotaErrorBadgeLabel}
                        </span>
                      </StatusProblemTooltip>
                    )}
                  </span>
                )}
              </div>
              {displayNameEditing ? (
                <input
                  ref={displayNameInputRef}
                  id={displayNameInputId}
                  className={styles.displayNameInput}
                  type="text"
                  value={displayNameDraft.value}
                  placeholder={file.name}
                  onChange={(event) =>
                    setDisplayNameDraft({
                      fileName: file.name,
                      value: event.currentTarget.value,
                      editing: true,
                    })
                  }
                  onBlur={handleDisplayNameBlur}
                  onKeyDown={handleDisplayNameKeyDown}
                  disabled={disableControls || displayNameSaving}
                  aria-label={t('auth_files.display_name_edit')}
                  title={file.name}
                />
              ) : (
                <button
                  type="button"
                  className={`${styles.fileName} ${styles.displayNameButton}`}
                  title={displayNameTitle}
                  onClick={startDisplayNameEdit}
                  disabled={disableControls || isRuntimeOnly || displayNameSaving}
                  aria-label={t('auth_files.display_name_edit')}
                >
                  <span className={styles.displayNameText}>{displayName}</span>
                  {displayNameSaving && <LoadingSpinner size={12} />}
                </button>
              )}
            </div>
          </div>

          <div className={styles.fileNameSource} title={file.name}>
            <span className={styles.noteLabel}>
              {t('auth_files.file_name_display', { defaultValue: '真实文件名' })}
            </span>
            <span className={styles.noteValue}>{file.name}</span>
          </div>

          <div className={`${styles.cardMeta} ${compact ? styles.cardMetaCompact : ''}`}>
            {!isRuntimeOnly && (
              <div
                className={`${styles.priorityBadgeEditor} ${
                  showPriorityTier ? priorityTierClass : ''
                } ${isFreeCodexPriority ? styles.priorityBadgeEditorFree : ''} ${
                  priorityIsUnassigned ? styles.priorityBadgeEditorUnassigned : ''
                }`}
                title={priorityEditorTitle}
              >
                <button
                  type="button"
                  className={styles.priorityBadgeStepButton}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    startPriorityHold(-1);
                  }}
                  onPointerUp={stopPriorityHold}
                  onPointerLeave={stopPriorityHold}
                  onPointerCancel={stopPriorityHold}
                  onClick={(event) => {
                    if (event.detail === 0) stepPriorityInput(-1);
                  }}
                  disabled={disableControls || prioritySaving}
                  aria-label={t('auth_files.priority_decrease')}
                  title={t('auth_files.priority_decrease')}
                >
                  <IconMinus size={15} />
                </button>
                <label className={styles.priorityBadgeMain} htmlFor={priorityInputId}>
                  <span className={styles.priorityBadgeLabel}>
                    {t('auth_files.priority_display')}
                  </span>
                  <span className={styles.priorityBadgeValueShell}>
                    <span aria-hidden="true" className={styles.priorityBadgePrefix}>
                      P
                    </span>
                    <input
                      id={priorityInputId}
                      className={styles.priorityBadgeInput}
                      type="text"
                      inputMode="numeric"
                      value={priorityInput}
                      placeholder="0"
                      onChange={(event) => setPriorityInput(event.currentTarget.value)}
                      onBlur={commitPriorityInput}
                      onKeyDown={handlePriorityKeyDown}
                      disabled={disableControls || prioritySaving}
                      aria-label={t('auth_files.priority_display')}
                      title={priorityEditorTitle}
                    />
                  </span>
                  {showPriorityTier && (
                    <span className={styles.priorityBadgeTier}>{priorityTierLabel}</span>
                  )}
                </label>
                <button
                  type="button"
                  className={styles.priorityBadgeStepButton}
                  onPointerDown={(event) => {
                    event.preventDefault();
                    startPriorityHold(1);
                  }}
                  onPointerUp={stopPriorityHold}
                  onPointerLeave={stopPriorityHold}
                  onPointerCancel={stopPriorityHold}
                  onClick={(event) => {
                    if (event.detail === 0) stepPriorityInput(1);
                  }}
                  disabled={disableControls || prioritySaving}
                  aria-label={t('auth_files.priority_increase')}
                  title={t('auth_files.priority_increase')}
                >
                  <IconPlus size={15} />
                </button>
                {prioritySaving && (
                  <span className={styles.priorityBadgeSpinner}>
                    <LoadingSpinner size={12} />
                  </span>
                )}
              </div>
            )}
            {showSubscriptionMeta && (
              <div className={`${styles.metaItem} ${styles.subscriptionExpiryMeta}`}>
                <span className={styles.metaLabel}>
                  {accessTokenOnly
                    ? accessTokenMetaLabel
                    : compact
                    ? t('auth_files.subscription_expiry_short_label')
                    : t('codex_quota.subscription_expiry_label')}
                </span>
                <span
                  className={`${styles.subscriptionExpiryPill} ${subscriptionExpiryClass} ${accessTokenOnly ? styles.subscriptionExpiryAccessTokenOnly : ''}`}
                  title={subscriptionExpiryLabel || undefined}
                  role={accessTokenOnly ? undefined : 'button'}
                  tabIndex={accessTokenOnly ? undefined : 0}
                  onClick={() => {
                    if (!accessTokenOnly) {
                      onManualExpiryEdit(file);
                    }
                  }}
                  onKeyDown={(event) => {
                    if (accessTokenOnly) return;
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onManualExpiryEdit(file);
                    }
                  }}
                >
                  {manualExpiry && (
                    <span className={styles.localExpiryMarker}>
                      {t('auth_files.local_override_short', { defaultValue: '本地' })}
                    </span>
                  )}
                  <span>{subscriptionExpiryDisplayLabel}</span>
                </span>
              </div>
            )}
          </div>

          <div className={`${styles.cardInsights} ${compact ? styles.cardInsightsCompact : ''}`}>
            <div className={`${styles.statusPanel} ${compact ? styles.statusPanelCompact : ''}`}>
              <div className={styles.statusPanelLabel}>
                <span>{t('auth_files.health_status_label')}</span>
              </div>
              <ProviderStatusBar
                statusData={statusData}
                styles={styles}
                highlightedBlockIndex={highlightedStatusBlockIndex}
                failureDetail={requestFailureDetail}
                failureDetailBlockIndex={latestFailureRequestWindow?.index ?? null}
                failureDetailUnavailableLabel={requestFailureDetailUnavailableLabel}
              />
              <div
                className={`${styles.statusPanelStats} ${compact ? styles.statusPanelStatsCompact : ''}`}
                title={`${t('stats.recent_success')}: ${fileStats.success} · ${t('stats.recent_failure')}: ${fileStats.failure}`}
              >
                <span>
                  {t('stats.recent_success')}
                  <strong>{fileStats.success}</strong>
                </span>
                <span>
                  {t('stats.recent_failure')}
                  <strong>{fileStats.failure}</strong>
                </span>
              </div>
            </div>

            {showQuotaLayout && quotaType && (
              <AuthFileQuotaSection
                file={file}
                quotaType={quotaType}
                disableControls={disableControls}
                compact={compact}
                summaryOnly={showQuotaSummaryOnly}
                codexSubscriptionSnapshot={codexSubscriptionSnapshot}
                authTokenSnapshot={authTokenSnapshot}
                manualExpiry={manualExpiry}
                onManualExpiryEdit={() => onManualExpiryEdit(file)}
              />
            )}
          </div>

          <div className={styles.cardActions}>
            <div className={styles.cardActionsTop}>
              <div className={styles.cardActionsMain}>
                {showModelsButton && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onShowModels(file)}
                    className={`${styles.primaryActionButton} ${styles.modelsActionButton}`}
                    title={t('auth_files.models_button', { defaultValue: '模型' })}
                    disabled={disableControls}
                  >
                    <>
                      <span className={styles.modelsActionIconWrap}>
                        <IconModelCluster className={styles.actionIcon} size={16} />
                      </span>
                      <span className={styles.actionButtonLabel}>
                        {t('auth_files.models_button', { defaultValue: '模型' })}
                      </span>
                    </>
                  </Button>
                )}
                {!isRuntimeOnly && (
                  <div ref={utilityActionsButtonRef} className={styles.cardUtilityActionsWrap}>
                    <Button
                      variant="secondary"
                      size="sm"
                      className={styles.cardMoreButton}
                      onClick={() =>
                        setUtilityActionsState((current) => ({
                          fileName: file.name,
                          open: current.fileName === file.name ? !current.open : true,
                        }))
                      }
                      aria-controls={utilityActionsId}
                      aria-expanded={utilityActionsOpen}
                      aria-label={t('auth_files.more_actions', { defaultValue: '更多操作' })}
                      title={t('auth_files.more_actions', { defaultValue: '更多操作' })}
                    >
                      <IconChevronDown
                        className={`${styles.actionIcon} ${
                          utilityActionsOpen ? styles.cardMoreIconOpen : ''
                        }`}
                        size={16}
                      />
                    </Button>
                  </div>
                )}
                {showCardQuotaRefreshButton && (
                  <span className={styles.codexAuthTimeRefreshGroup}>
                    {visibleAuthTimeSnapshot && (
                      <span className={authTimeClassName} title={authTimeTitle}>
                        <span className={styles.codexAuthTimeActionLabel}>
                          {t('auth_files.auth_time_short_label', { defaultValue: '认证' })}
                        </span>
                        <span className={styles.codexAuthTimeActionValue}>
                          {visibleAuthTimeSnapshot.authenticatedAtShort}
                        </span>
                      </span>
                    )}
                    <button
                      type="button"
                      className={`${styles.cardQuotaRefreshButton} ${
                        quotaRefreshing ? styles.cardQuotaRefreshButtonLoading : ''
                      }`}
                      onClick={() => onRefreshQuota(file)}
                      disabled={
                        disableControls || file.disabled || quotaRefreshDisabled || quotaRefreshing
                      }
                      aria-label={cardQuotaRefreshLabel}
                      title={cardQuotaRefreshLabel}
                    >
                      {quotaRefreshing ? (
                        <LoadingSpinner size={12} />
                      ) : (
                        <IconRefreshCw size={13} />
                      )}
                    </button>
                    {showCardQuotaResetButton && (
                      <button
                        type="button"
                        className={`${styles.cardQuotaRefreshButton} ${styles.cardQuotaResetButton} ${
                          quotaResetting ? styles.cardQuotaResetButtonLoading : ''
                        }`}
                        onClick={() => onResetQuota(file)}
                        disabled={
                          disableControls || file.disabled || quotaResetDisabled || quotaResetting
                        }
                        aria-label={cardQuotaResetLabel}
                        title={cardQuotaResetLabel}
                      >
                        {quotaResetting ? (
                          <LoadingSpinner size={12} />
                        ) : (
                          <IconDiamond size={13} />
                        )}
                      </button>
                    )}
                  </span>
                )}
              </div>
              {!isRuntimeOnly && (
                <div
                  className={`${styles.statusToggle} ${
                    file.disabled
                      ? styles.statusToggleDisabled
                      : hasVisibleStatusWarning
                        ? styles.statusToggleWarning
                        : styles.statusToggleActive
                  }`}
                >
                  <span className={styles.statusToggleStateDot} aria-hidden="true" />
                  <span className={styles.statusToggleLabel}>
                    {t('auth_files.status_toggle_label')}
                  </span>
                  <ToggleSwitch
                    ariaLabel={t('auth_files.status_toggle_label')}
                    checked={!file.disabled}
                    disabled={disableControls || statusUpdating}
                    onChange={(value) => onToggleStatus(file, value)}
                  />
                </div>
              )}
            </div>
            {!isRuntimeOnly && (
              <div
                ref={utilityActionsMenuRef}
                id={utilityActionsId}
                role="group"
                aria-hidden={!utilityActionsOpen}
                className={`${styles.cardUtilityActions} ${
                  utilityActionsOpen ? styles.cardUtilityActionsOpen : ''
                }`}
              >
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    closeUtilityActions();
                    onDownload(file.name);
                  }}
                  className={styles.iconButton}
                  aria-label={t('auth_files.download_button')}
                  title={t('auth_files.download_button')}
                  disabled={disableControls}
                >
                  <IconDownload className={styles.actionIcon} size={16} />
                  <span className={styles.actionButtonLabel}>
                    {t('auth_files.download_button')}
                  </span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    closeUtilityActions();
                    onOpenPrefixProxyEditor(file);
                  }}
                  className={styles.iconButton}
                  aria-label={t('auth_files.prefix_proxy_button')}
                  title={t('auth_files.prefix_proxy_button')}
                  disabled={disableControls}
                >
                  <IconSettings className={styles.actionIcon} size={16} />
                  <span className={styles.actionButtonLabel}>
                    {t('auth_files.prefix_proxy_short', { defaultValue: '代理' })}
                  </span>
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    closeUtilityActions();
                    onManualExpiryEdit(file);
                  }}
                  className={`${styles.iconButton} ${manualExpiry ? styles.manualExpiryActionActive : ''}`}
                  aria-label={t('auth_files.manual_expiry_button', {
                    defaultValue: '手动有效期',
                  })}
                  title={t('auth_files.manual_expiry_button', {
                    defaultValue: '手动有效期',
                  })}
                >
                  <IconTimer className={styles.actionIcon} size={16} />
                  <span className={styles.actionButtonLabel}>
                    {t('auth_files.manual_expiry_short', { defaultValue: '有效期' })}
                  </span>
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => {
                    closeUtilityActions();
                    onDelete(file.name);
                  }}
                  className={`${styles.iconButton} ${styles.deleteActionButton}`}
                  aria-label={t('auth_files.delete_button')}
                  title={t('auth_files.delete_button')}
                  disabled={disableControls || deleting}
                >
                  {deleting ? (
                    <LoadingSpinner size={14} />
                  ) : (
                    <IconTrash2 className={styles.actionIcon} size={16} />
                  )}
                  <span className={styles.actionButtonLabel}>
                    {t('auth_files.delete_button')}
                  </span>
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
