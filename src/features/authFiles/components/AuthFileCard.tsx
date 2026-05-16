import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconDownload,
  IconInfo,
  IconModelCluster,
  IconSettings,
  IconTrash2,
} from '@/components/ui/icons';
import { ProviderStatusBar } from '@/components/providers/ProviderStatusBar';
import { useQuotaStore } from '@/stores';
import type {
  AntigravityQuotaState,
  AuthFileItem,
  ClaudeQuotaState,
  CodexQuotaState,
  GeminiCliQuotaState,
  KimiQuotaState,
} from '@/types';
import {
  formatCodexSubscriptionShortDate,
  getCodexMinRemainingPercent,
  normalizePlanType,
  resolveCodexPlanType,
  resolveAuthProvider,
  type CodexSubscriptionSnapshot,
} from '@/utils/quota';
import {
  normalizeRecentRequestAuthIndex,
  normalizeRecentRequestBuckets,
  statusBarDataFromRecentRequests,
} from '@/utils/recentRequests';
import { formatFileSize } from '@/utils/format';
import {
  QUOTA_PROVIDER_TYPES,
  formatModified,
  getAuthFileIcon,
  getAuthFileStatusMessage,
  getTypeColor,
  getTypeLabel,
  isRuntimeOnlyAuthFile,
  parsePriorityValue,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import type { AuthFileStatusBarData } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import { AuthFileQuotaSection } from '@/features/authFiles/components/AuthFileQuotaSection';
import styles from '@/pages/AuthFilesPage.module.scss';

const HEALTHY_STATUS_MESSAGES = new Set(['ok', 'healthy', 'ready', 'success', 'available']);
const QUOTA_WARNING_REMAINING_PERCENT = 30;
const QUOTA_CRITICAL_REMAINING_PERCENT = 12;
const PREMIUM_CODEX_PLAN_TYPES = new Set(['pro', 'prolite', 'pro-lite', 'pro_lite']);

type AuthCardQuotaState =
  | AntigravityQuotaState
  | ClaudeQuotaState
  | CodexQuotaState
  | GeminiCliQuotaState
  | KimiQuotaState
  | undefined;

export type AuthFileCardProps = {
  file: AuthFileItem;
  compact: boolean;
  selected: boolean;
  resolvedTheme: ResolvedTheme;
  disableControls: boolean;
  deleting: string | null;
  statusUpdating: Record<string, boolean>;
  priorityUpdating: Record<string, boolean>;
  noteUpdating: Record<string, boolean>;
  quotaFilterType: QuotaProviderType | null;
  statusBarCache: Map<string, AuthFileStatusBarData>;
  codexSubscriptionSnapshot?: CodexSubscriptionSnapshot | null;
  onShowModels: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  onOpenPrefixProxyEditor: (file: AuthFileItem) => void;
  onDelete: (name: string) => void;
  onToggleStatus: (file: AuthFileItem, enabled: boolean) => void;
  onPriorityChange: (file: AuthFileItem, priority: number) => Promise<void>;
  onDisplayNameChange: (file: AuthFileItem, note: string) => Promise<void>;
  onPriorityInvalid: () => void;
  onToggleSelect: (name: string) => void;
};

const resolveQuotaType = (file: AuthFileItem): QuotaProviderType | null => {
  const provider = resolveAuthProvider(file);
  if (!QUOTA_PROVIDER_TYPES.has(provider as QuotaProviderType)) return null;
  return provider as QuotaProviderType;
};

const clampPercent = (value: number) => Math.max(0, Math.min(100, value));

const minFiniteValue = (values: Array<number | null | undefined>): number | null => {
  const finiteValues = values.filter(
    (value): value is number => typeof value === 'number' && Number.isFinite(value)
  );
  return finiteValues.length > 0 ? Math.min(...finiteValues) : null;
};

const usedPercentToRemaining = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? clampPercent(100 - value) : null;

const quotaFractionToPercent = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? clampPercent(value * 100) : null;

const getQuotaRemainingPercent = (
  quotaType: QuotaProviderType | null,
  quota: AuthCardQuotaState
): number | null => {
  if (!quota || quota.status !== 'success') return null;

  if (quotaType === 'codex') {
    return getCodexMinRemainingPercent(quota as CodexQuotaState);
  }

  if (quotaType === 'claude') {
    const claudeQuota = quota as ClaudeQuotaState;
    return minFiniteValue([
      ...(claudeQuota.windows ?? []).map((window) => usedPercentToRemaining(window.usedPercent)),
      claudeQuota.extraUsage?.is_enabled
        ? usedPercentToRemaining(claudeQuota.extraUsage.utilization)
        : null,
    ]);
  }

  if (quotaType === 'antigravity') {
    return minFiniteValue(
      ((quota as AntigravityQuotaState).groups ?? []).map((group) =>
        quotaFractionToPercent(group.remainingFraction)
      )
    );
  }

  if (quotaType === 'gemini-cli') {
    return minFiniteValue(
      ((quota as GeminiCliQuotaState).buckets ?? []).map((bucket) =>
        quotaFractionToPercent(bucket.remainingFraction)
      )
    );
  }

  if (quotaType === 'kimi') {
    return minFiniteValue(
      ((quota as KimiQuotaState).rows ?? []).map((row) => {
        if (row.limit <= 0) return null;
        return clampPercent(((row.limit - row.used) / row.limit) * 100);
      })
    );
  }

  return null;
};

export function AuthFileCard(props: AuthFileCardProps) {
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
    quotaFilterType,
    statusBarCache,
    codexSubscriptionSnapshot,
    onShowModels,
    onDownload,
    onOpenPrefixProxyEditor,
    onDelete,
    onToggleStatus,
    onPriorityChange,
    onDisplayNameChange,
    onPriorityInvalid,
    onToggleSelect,
  } = props;

  const recentBuckets = normalizeRecentRequestBuckets(file.recent_requests ?? file.recentRequests);
  const isRuntimeOnly = isRuntimeOnlyAuthFile(file);
  const isAistudio = (file.type || '').toLowerCase() === 'aistudio';
  const showModelsButton = !isRuntimeOnly || isAistudio;
  const typeColor = getTypeColor(file.type || 'unknown', resolvedTheme);
  const typeLabel = getTypeLabel(t, file.type || 'unknown');
  const providerIcon = getAuthFileIcon(file.type || 'unknown', resolvedTheme);

  const resolvedQuotaType = resolveQuotaType(file);
  const selectedQuotaType =
    quotaFilterType && resolvedQuotaType === quotaFilterType ? quotaFilterType : null;
  const quotaType = selectedQuotaType ?? (resolvedQuotaType === 'codex' ? 'codex' : null);
  const quotaSnapshot = useQuotaStore((state) => {
    if (resolvedQuotaType === 'antigravity') return state.antigravityQuota[file.name];
    if (resolvedQuotaType === 'claude') return state.claudeQuota[file.name];
    if (resolvedQuotaType === 'codex') return state.codexQuota[file.name];
    if (resolvedQuotaType === 'gemini-cli') return state.geminiCliQuota[file.name];
    if (resolvedQuotaType === 'kimi') return state.kimiQuota[file.name];
    return undefined;
  }) as AuthCardQuotaState;
  const quotaRemainingPercent = getQuotaRemainingPercent(resolvedQuotaType, quotaSnapshot);
  const quotaPressure = file.disabled
    ? null
    : quotaSnapshot?.status === 'error'
      ? 'error'
      : quotaRemainingPercent !== null && quotaRemainingPercent <= QUOTA_CRITICAL_REMAINING_PERCENT
        ? 'critical'
        : quotaRemainingPercent !== null && quotaRemainingPercent <= QUOTA_WARNING_REMAINING_PERCENT
          ? 'warning'
          : null;
  const quotaSignalLabel =
    quotaPressure === 'error'
      ? t('auth_files.quota_signal_error', { defaultValue: '额度异常' })
      : quotaPressure === 'critical'
        ? t('auth_files.quota_signal_critical', { defaultValue: '额度紧张' })
        : quotaPressure === 'warning'
          ? t('auth_files.quota_signal_warning', { defaultValue: '额度偏低' })
          : '';
  const quotaSignalClass =
    quotaPressure === 'error' || quotaPressure === 'critical'
      ? styles.signalBadgeDanger
      : quotaPressure === 'warning'
        ? styles.signalBadgeWarning
        : '';

  const showQuotaLayout =
    Boolean(quotaType) &&
    !isRuntimeOnly &&
    (quotaType === 'codex' || (!compact && selectedQuotaType !== null));
  const showQuotaSummaryOnly = quotaType === 'codex' && (compact || selectedQuotaType !== 'codex');
  const codexQuotaPlanType = useQuotaStore((state) => {
    if (resolvedQuotaType !== 'codex') return null;
    const quota = state.codexQuota[file.name] as
      | { status?: string; planType?: string | null }
      | undefined;
    return quota?.status === 'success' ? (quota.planType ?? null) : null;
  });
  const currentCodexPlanType =
    resolvedQuotaType === 'codex' ? normalizePlanType(codexQuotaPlanType) : null;
  const effectiveCodexPlanType =
    resolvedQuotaType === 'codex'
      ? currentCodexPlanType ?? normalizePlanType(resolveCodexPlanType(file))
      : null;
  const currentCodexPlanIsFree = currentCodexPlanType === 'free';
  const compactPlanToneClass =
    compact && effectiveCodexPlanType === 'team'
      ? styles.fileCardCompactPlanTeam
      : compact && effectiveCodexPlanType === 'plus'
        ? styles.fileCardCompactPlanPlus
        : compact && effectiveCodexPlanType === 'free'
          ? styles.fileCardCompactPlanFree
          : compact && PREMIUM_CODEX_PLAN_TYPES.has(effectiveCodexPlanType ?? '')
            ? styles.fileCardCompactPlanPremium
            : '';

  const rawAuthIndex = file['auth_index'] ?? file.authIndex;
  const authIndexKey = normalizeRecentRequestAuthIndex(rawAuthIndex);
  const statusData =
    (authIndexKey && statusBarCache.get(authIndexKey)) ||
    statusBarDataFromRecentRequests(recentBuckets);
  const fileStats = {
    success: statusData.totalSuccess,
    failure: statusData.totalFailure,
  };
  const rawStatusMessage = getAuthFileStatusMessage(file);
  const hasStatusWarning =
    Boolean(rawStatusMessage) && !HEALTHY_STATUS_MESSAGES.has(rawStatusMessage.toLowerCase());

  const priorityValue = parsePriorityValue(file.priority ?? file['priority']);
  const currentPriorityText = priorityValue === undefined ? '' : String(priorityValue);
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
  const priorityInputId = `auth-priority-${file.name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
  const prioritySaving = priorityUpdating[file.name] === true;
  const displayNameSaving = noteUpdating[file.name] === true;
  const [referenceTimeMs] = useState(() => Date.now());
  const visibleCodexSubscription =
    resolvedQuotaType === 'codex' &&
    !currentCodexPlanIsFree &&
    codexSubscriptionSnapshot?.subscriptionStatus === 'found' &&
    codexSubscriptionSnapshot.subscriptionActiveUntil
      ? codexSubscriptionSnapshot
      : null;
  const subscriptionWarningMs = 7 * 24 * 60 * 60 * 1000;
  const subscriptionExpiryMs = visibleCodexSubscription?.subscriptionActiveUntilMs;
  const subscriptionExpired =
    subscriptionExpiryMs !== null &&
    subscriptionExpiryMs !== undefined &&
    subscriptionExpiryMs <= referenceTimeMs;
  const subscriptionExpiringSoon =
    !subscriptionExpired &&
    subscriptionExpiryMs !== null &&
    subscriptionExpiryMs !== undefined &&
    subscriptionExpiryMs - referenceTimeMs <= subscriptionWarningMs;
  const subscriptionExpiryClass = subscriptionExpired
    ? styles.subscriptionExpiryExpired
    : subscriptionExpiringSoon
      ? styles.subscriptionExpiryWarning
      : styles.subscriptionExpiryHealthy;
  const subscriptionSignalLabel = subscriptionExpired
    ? t('auth_files.subscription_signal_expired', { defaultValue: '订阅到期' })
    : subscriptionExpiringSoon
      ? t('auth_files.subscription_signal_warning', { defaultValue: '订阅将到期' })
      : '';
  const subscriptionSignalClass = subscriptionExpired
    ? styles.signalBadgeDanger
    : subscriptionExpiringSoon
      ? styles.signalBadgeWarning
      : '';
  const subscriptionExpiryLabel = visibleCodexSubscription?.subscriptionActiveUntil ?? '';
  const subscriptionExpiryDisplayLabel = compact
    ? formatCodexSubscriptionShortDate(
        visibleCodexSubscription?.subscriptionActiveUntilMs,
        subscriptionExpiryLabel
      )
    : subscriptionExpiryLabel;
  const showSubscriptionMeta = Boolean(visibleCodexSubscription) && !showQuotaLayout;

  const setPriorityInput = (value: string) => {
    setPriorityDraft({ fileName: file.name, value, dirty: true });
  };

  useEffect(() => {
    if (!displayNameEditing) return;
    const input = displayNameInputRef.current;
    input?.focus();
    input?.select();
  }, [displayNameEditing, file.name]);

  const startDisplayNameEdit = () => {
    if (disableControls || isRuntimeOnly || displayNameSaving) return;
    setDisplayNameDraft({ fileName: file.name, value: noteValue, editing: true });
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

  const stepPriorityInput = (delta: number) => {
    const draftPriority = parsePriorityValue(priorityInput.trim());
    const basePriority = draftPriority ?? priorityValue ?? 0;
    savePriorityValue(basePriority + delta);
  };

  const handlePriorityKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.currentTarget.blur();
    } else if (event.key === 'Escape') {
      resetPriorityInput();
      event.currentTarget.blur();
    }
  };
  const stateLabel = isRuntimeOnly
    ? t('auth_files.type_virtual') || '虚拟认证文件'
    : file.disabled
      ? t('auth_files.health_status_disabled')
      : hasStatusWarning
        ? t('auth_files.health_status_warning')
        : rawStatusMessage
          ? t('auth_files.health_status_healthy')
          : t('auth_files.status_toggle_label');
  const stateBadgeClass = isRuntimeOnly
    ? styles.stateBadgeVirtual
    : file.disabled
      ? styles.stateBadgeDisabled
      : hasStatusWarning
        ? styles.stateBadgeWarning
        : styles.stateBadgeActive;
  const cardToneClass = isRuntimeOnly ? styles.fileCardVirtual : '';

  return (
    <div
      className={`${styles.fileCard} ${compact ? styles.fileCardCompact : ''} ${compactPlanToneClass} ${cardToneClass} ${selected ? styles.fileCardSelected : ''} ${file.disabled ? styles.fileCardDisabled : ''}`}
    >
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
                <span
                  className={[
                    styles.stateBadge,
                    stateBadgeClass,
                    hasStatusWarning ? styles.stateBadgeWithInfo : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  title={hasStatusWarning ? rawStatusMessage : undefined}
                  aria-label={hasStatusWarning ? `${stateLabel}: ${rawStatusMessage}` : undefined}
                  tabIndex={hasStatusWarning ? 0 : undefined}
                >
                  {stateLabel}
                  {hasStatusWarning && (
                    <IconInfo className={styles.stateBadgeInfoIcon} size={12} aria-hidden="true" />
                  )}
                </span>
                {quotaSignalLabel && (
                  <span className={`${styles.signalBadge} ${quotaSignalClass}`}>
                    {quotaSignalLabel}
                  </span>
                )}
                {subscriptionSignalLabel && (
                  <span className={`${styles.signalBadge} ${subscriptionSignalClass}`}>
                    {subscriptionSignalLabel}
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
              {!compact && noteValue && (
                <div className={styles.fileNameSource} title={file.name}>
                  <span className={styles.noteLabel}>{t('auth_files.file_name_display')}</span>
                  <span className={styles.noteValue}>{file.name}</span>
                </div>
              )}
            </div>
          </div>

          <div className={`${styles.cardMeta} ${compact ? styles.cardMetaCompact : ''}`}>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>{t('auth_files.file_size')}</span>
              <span className={styles.metaValue}>
                {file.size ? formatFileSize(file.size) : '-'}
              </span>
            </div>
            <div className={styles.metaItem}>
              <span className={styles.metaLabel}>{t('auth_files.file_modified')}</span>
              <span className={styles.metaValue}>{formatModified(file)}</span>
            </div>
            {!isRuntimeOnly && (
              <div className={`${styles.metaItem} ${styles.priorityInlineEditor}`}>
                <label className={styles.metaLabel} htmlFor={priorityInputId}>
                  {t('auth_files.priority_display')}
                </label>
                <div className={styles.priorityStepper}>
                  <button
                    type="button"
                    className={styles.priorityStepButton}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => stepPriorityInput(-1)}
                    disabled={disableControls || prioritySaving}
                    aria-label={t('auth_files.priority_decrease')}
                    title={t('auth_files.priority_decrease')}
                  >
                    -
                  </button>
                  <input
                    id={priorityInputId}
                    className={styles.priorityStepperInput}
                    type="text"
                    inputMode="numeric"
                    value={priorityInput}
                    onChange={(event) => setPriorityInput(event.currentTarget.value)}
                    onBlur={commitPriorityInput}
                    onKeyDown={handlePriorityKeyDown}
                    disabled={disableControls || prioritySaving}
                    aria-label={t('auth_files.priority_display')}
                    title={t('auth_files.priority_hint')}
                  />
                  <button
                    type="button"
                    className={styles.priorityStepButton}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => stepPriorityInput(1)}
                    disabled={disableControls || prioritySaving}
                    aria-label={t('auth_files.priority_increase')}
                    title={t('auth_files.priority_increase')}
                  >
                    +
                  </button>
                </div>
                {prioritySaving && <LoadingSpinner size={12} />}
              </div>
            )}
            {showSubscriptionMeta && (
              <div className={`${styles.metaItem} ${styles.subscriptionExpiryMeta}`}>
                <span className={styles.metaLabel}>
                  {compact
                    ? t('auth_files.subscription_expiry_short_label')
                    : t('codex_quota.subscription_expiry_label')}
                </span>
                <span
                  className={`${styles.subscriptionExpiryPill} ${subscriptionExpiryClass}`}
                  title={subscriptionExpiryLabel || undefined}
                >
                  {subscriptionExpiryDisplayLabel}
                </span>
              </div>
            )}
          </div>

          <div className={`${styles.cardInsights} ${compact ? styles.cardInsightsCompact : ''}`}>
            <div className={`${styles.cardStats} ${compact ? styles.cardStatsCompact : ''}`}>
              <div className={`${styles.statPill} ${styles.statSuccess}`}>
                <span className={styles.statLabel}>{t('stats.recent_success')}</span>
                <span className={styles.statValue}>{fileStats.success}</span>
              </div>
              <div className={`${styles.statPill} ${styles.statFailure}`}>
                <span className={styles.statLabel}>{t('stats.recent_failure')}</span>
                <span className={styles.statValue}>{fileStats.failure}</span>
              </div>
            </div>

            <div className={`${styles.statusPanel} ${compact ? styles.statusPanelCompact : ''}`}>
              <div className={styles.statusPanelLabel}>
                <span>{t('auth_files.health_status_label')}</span>
              </div>
              <ProviderStatusBar statusData={statusData} styles={styles} />
            </div>

            {showQuotaLayout && quotaType && (
              <AuthFileQuotaSection
                file={file}
                quotaType={quotaType}
                disableControls={disableControls}
                compact={compact}
                summaryOnly={showQuotaSummaryOnly}
                codexSubscriptionSnapshot={codexSubscriptionSnapshot}
              />
            )}
          </div>

          <div className={styles.cardActions}>
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
                <div className={styles.cardUtilityActions}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onDownload(file.name)}
                    className={styles.iconButton}
                    title={t('auth_files.download_button')}
                    disabled={disableControls}
                  >
                    <IconDownload className={styles.actionIcon} size={16} />
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onOpenPrefixProxyEditor(file)}
                    className={styles.iconButton}
                    title={t('auth_files.prefix_proxy_button')}
                    disabled={disableControls}
                  >
                    <IconSettings className={styles.actionIcon} size={16} />
                  </Button>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => onDelete(file.name)}
                    className={styles.iconButton}
                    title={t('auth_files.delete_button')}
                    disabled={disableControls || deleting === file.name}
                  >
                    {deleting === file.name ? (
                      <LoadingSpinner size={14} />
                    ) : (
                      <IconTrash2 className={styles.actionIcon} size={16} />
                    )}
                  </Button>
                </div>
              )}
            </div>
            {!isRuntimeOnly && (
              <div className={styles.statusToggle}>
                <span className={styles.statusToggleLabel}>
                  {t('auth_files.status_toggle_label')}
                </span>
                <ToggleSwitch
                  ariaLabel={t('auth_files.status_toggle_label')}
                  checked={!file.disabled}
                  disabled={disableControls || statusUpdating[file.name] === true}
                  onChange={(value) => onToggleStatus(file, value)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
