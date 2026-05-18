import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconCircleAlert,
  IconDownload,
  IconModelCluster,
  IconSettings,
  IconTimer,
  IconTrash2,
} from '@/components/ui/icons';
import { ProviderStatusBar } from '@/components/providers/ProviderStatusBar';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import {
  formatCodexSubscriptionShortDate,
  normalizePlanType,
  resolveCodexPlanType,
  resolveAuthProvider,
  type CodexAuthTokenSnapshot,
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
import { buildManualExpiryRenderInfo } from '@/features/authFiles/manualExpiry';
import styles from '@/pages/AuthFilesPage.module.scss';

const HEALTHY_STATUS_MESSAGES = new Set(['ok', 'healthy', 'ready', 'success', 'available']);
const PREMIUM_CODEX_PLAN_TYPES = new Set(['pro', 'prolite', 'pro-lite', 'pro_lite']);
type AuthFilePriorityTier = 'active' | 'standby' | 'buffer';

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
  authTokenSnapshot?: CodexAuthTokenSnapshot | null;
  codexSubscriptionSnapshot?: CodexSubscriptionSnapshot | null;
  manualExpiryMs?: number | null;
  priorityTier?: AuthFilePriorityTier | null;
  onShowModels: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  onOpenPrefixProxyEditor: (file: AuthFileItem) => void;
  onManualExpiryEdit: (file: AuthFileItem) => void;
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
    authTokenSnapshot,
    codexSubscriptionSnapshot,
    manualExpiryMs,
    priorityTier,
    onShowModels,
    onDownload,
    onOpenPrefixProxyEditor,
    onManualExpiryEdit,
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
  const codexPlanCanHaveSubscriptionExpiry =
    resolvedQuotaType === 'codex' &&
    Boolean(effectiveCodexPlanType) &&
    effectiveCodexPlanType !== 'free';
  const accessTokenOnly =
    resolvedQuotaType === 'codex' && authTokenSnapshot?.hasRefreshToken === false;
  const accessTokenExpiryUnknownLabel = t('auth_files.access_token_expiry_unknown', {
    defaultValue: '无法识别',
  });
  const accessTokenExpiryTitle =
    authTokenSnapshot?.accessTokenExpiresAt ??
    t('auth_files.access_token_expiry_unknown_title', {
      defaultValue: '没有 refresh_token，且无法识别 access_token 到期时间',
    });

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
          : '';
  const priorityTierClass =
    priorityTier === 'active'
      ? styles.priorityBadgeEditorActive
      : priorityTier === 'standby'
        ? styles.priorityBadgeEditorStandby
        : priorityTier === 'buffer'
          ? styles.priorityBadgeEditorBuffer
          : '';
  const [referenceTimeMs] = useState(() => Date.now());
  const visibleCodexSubscription =
    resolvedQuotaType === 'codex' &&
    !accessTokenOnly &&
    codexPlanCanHaveSubscriptionExpiry &&
    codexSubscriptionSnapshot?.subscriptionStatus === 'found' &&
    codexSubscriptionSnapshot.subscriptionActiveUntil
      ? codexSubscriptionSnapshot
      : null;
  const manualExpiry = accessTokenOnly ? null : buildManualExpiryRenderInfo(manualExpiryMs);
  const showManualExpirySetup =
    !accessTokenOnly && codexPlanCanHaveSubscriptionExpiry && !manualExpiry && !visibleCodexSubscription;
  const subscriptionWarningMs = 7 * 24 * 60 * 60 * 1000;
  const subscriptionExpiryMs =
    accessTokenOnly
      ? authTokenSnapshot?.accessTokenExpiresAtMs
      : (manualExpiry?.expiresAtMs ?? visibleCodexSubscription?.subscriptionActiveUntilMs);
  const subscriptionExpired =
    subscriptionExpiryMs !== null &&
    subscriptionExpiryMs !== undefined &&
    subscriptionExpiryMs <= referenceTimeMs;
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
  const showSubscriptionMeta =
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
  const statusWarningLabel = t('auth_files.health_status_warning');
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
                {isRuntimeOnly && (
                  <span className={`${styles.stateBadge} ${stateBadgeClass}`}>
                    {stateLabel}
                  </span>
                )}
                {accessTokenOnly && (
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
              <div
                className={`${styles.priorityBadgeEditor} ${
                  showPriorityTier ? priorityTierClass : ''
                } ${isFreeCodexPriority ? styles.priorityBadgeEditorFree : ''}`}
              >
                <button
                  type="button"
                  className={styles.priorityBadgeStepButton}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => stepPriorityInput(-1)}
                  disabled={disableControls || prioritySaving}
                  aria-label={t('auth_files.priority_decrease')}
                  title={t('auth_files.priority_decrease')}
                >
                  -
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
                      title={t('auth_files.priority_hint')}
                    />
                  </span>
                  {showPriorityTier && (
                    <span className={styles.priorityBadgeTier}>{priorityTierLabel}</span>
                  )}
                </label>
                <button
                  type="button"
                  className={styles.priorityBadgeStepButton}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => stepPriorityInput(1)}
                  disabled={disableControls || prioritySaving}
                  aria-label={t('auth_files.priority_increase')}
                  title={t('auth_files.priority_increase')}
                >
                  +
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
                    ? t('auth_files.access_token_expiry_short_label', {
                        defaultValue: 'Access 到期',
                      })
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
                authTokenSnapshot={authTokenSnapshot}
                manualExpiry={manualExpiry}
                onManualExpiryEdit={() => onManualExpiryEdit(file)}
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
                    variant="secondary"
                    size="sm"
                    onClick={() => onManualExpiryEdit(file)}
                    className={`${styles.iconButton} ${manualExpiry ? styles.manualExpiryActionActive : ''}`}
                    title={t('auth_files.manual_expiry_button', {
                      defaultValue: '手动有效期',
                    })}
                  >
                    <IconTimer className={styles.actionIcon} size={16} />
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
              <div
                className={`${styles.statusToggle} ${
                  file.disabled
                    ? styles.statusToggleDisabled
                    : hasStatusWarning
                      ? styles.statusToggleWarning
                      : styles.statusToggleActive
                }`}
              >
                <span className={styles.statusToggleStateDot} aria-hidden="true" />
                <span className={styles.statusToggleLabel}>
                  {t('auth_files.status_toggle_label')}
                </span>
                {hasStatusWarning && (
                  <span
                    className={styles.stateWarningIconBadge}
                    title={rawStatusMessage}
                    aria-label={`${statusWarningLabel}: ${rawStatusMessage}`}
                    role="img"
                    tabIndex={0}
                  >
                    <IconCircleAlert size={14} aria-hidden="true" />
                  </span>
                )}
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
