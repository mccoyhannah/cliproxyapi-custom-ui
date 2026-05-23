import { memo, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconCircleAlert,
  IconChevronDown,
  IconDownload,
  IconFileText,
  IconMinus,
  IconModelCluster,
  IconPlus,
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
  QUOTA_PROVIDER_TYPES,
  getAuthFileIcon,
  getAuthFileStatusMessage,
  getTypeColor,
  getTypeLabel,
  isRuntimeOnlyAuthFile,
  parsePriorityValue,
  resolveQuotaErrorMessage,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import type { AuthFileStatusBarData } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import { AuthFileQuotaSection } from '@/features/authFiles/components/AuthFileQuotaSection';
import { buildManualExpiryRenderInfo } from '@/features/authFiles/manualExpiry';
import styles from '@/pages/AuthFilesPage.module.scss';

const HEALTHY_STATUS_MESSAGES = new Set(['ok', 'healthy', 'ready', 'success', 'available']);
const PREMIUM_CODEX_PLAN_TYPES = new Set(['pro', 'prolite', 'pro-lite', 'pro_lite']);
const CREDENTIAL_QUOTA_ERROR_PATTERN =
  /(401|403|auth|authentication|unauthorized|forbidden|credential|invalid|invalidated|expired|token|signing in)/i;
type AuthFilePriorityTier = 'active' | 'standby' | 'buffer' | 'manualLocked';
type CodexCardQuotaState = {
  status?: string;
  planType?: string | null;
  error?: string;
  errorStatus?: number;
};

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
  quotaFilterType: QuotaProviderType | null;
  statusData: AuthFileStatusBarData;
  authTokenSnapshot?: CodexAuthTokenSnapshot | null;
  codexSubscriptionSnapshot?: CodexSubscriptionSnapshot | null;
  manualExpiryMs?: number | null;
  priorityTier?: AuthFilePriorityTier | null;
  accountMemo?: string | null;
  onShowModels: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  onOpenPrefixProxyEditor: (file: AuthFileItem) => void;
  onManualExpiryEdit: (file: AuthFileItem) => void;
  onAccountMemoOpen: (file: AuthFileItem) => void;
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
    quotaFilterType,
    statusData,
    authTokenSnapshot,
    codexSubscriptionSnapshot,
    manualExpiryMs,
    priorityTier,
    accountMemo,
    onShowModels,
    onDownload,
    onOpenPrefixProxyEditor,
    onManualExpiryEdit,
    onAccountMemoOpen,
    onDelete,
    onToggleStatus,
    onPriorityChange,
    onDisplayNameChange,
    onPriorityInvalid,
    onToggleSelect,
  } = props;

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

  const fileStats = {
    success: statusData.totalSuccess,
    failure: statusData.totalFailure,
  };
  const rawStatusMessage = getAuthFileStatusMessage(file);
  const hasStatusWarning =
    Boolean(rawStatusMessage) && !HEALTHY_STATUS_MESSAGES.has(rawStatusMessage.toLowerCase());
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
  const quotaCredentialError =
    hasQuotaError &&
    (quotaErrorStatus === 401 ||
      quotaErrorStatus === 403 ||
      CREDENTIAL_QUOTA_ERROR_PATTERN.test(codexQuotaEntry?.error || quotaErrorMessage));
  const quotaErrorBadgeLabel = quotaCredentialError
    ? t('auth_files.quota_credential_error_badge', { defaultValue: '认证异常' })
    : t('auth_files.quota_error_badge', { defaultValue: '额度异常' });
  const activeWarningLabel = hasQuotaError
    ? quotaErrorBadgeLabel
    : t('auth_files.health_status_warning');
  const activeWarningMessage = hasQuotaError ? quotaErrorMessage : rawStatusMessage;

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
      : hasQuotaError
        ? t('auth_files.health_status_quota_error', { defaultValue: '额度异常' })
      : hasStatusWarning
        ? t('auth_files.health_status_warning')
        : rawStatusMessage
          ? t('auth_files.health_status_healthy')
          : t('auth_files.status_toggle_label');
  const stateBadgeClass = isRuntimeOnly
    ? styles.stateBadgeVirtual
    : file.disabled
      ? styles.stateBadgeDisabled
      : hasQuotaError
        ? styles.stateBadgeQuotaError
      : hasStatusWarning
        ? styles.stateBadgeWarning
        : styles.stateBadgeActive;
  const cardToneClass = [
    isRuntimeOnly ? styles.fileCardVirtual : '',
    hasQuotaError ? styles.fileCardQuotaError : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={`${styles.fileCard} ${compact ? styles.fileCardCompact : ''} ${compactPlanToneClass} ${cardToneClass} ${selected ? styles.fileCardSelected : ''} ${file.disabled ? styles.fileCardDisabled : ''}`}
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
                {hasQuotaError && (
                  <span
                    className={`${styles.stateBadge} ${styles.stateBadgeQuotaError}`}
                    title={quotaErrorMessage}
                  >
                    {quotaErrorBadgeLabel}
                  </span>
                )}
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
              <ProviderStatusBar statusData={statusData} styles={styles} />
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
              </div>
              {!isRuntimeOnly && (
                <div
                  className={`${styles.statusToggle} ${
                    file.disabled
                      ? styles.statusToggleDisabled
                      : hasQuotaError || hasStatusWarning
                        ? styles.statusToggleWarning
                        : styles.statusToggleActive
                  }`}
                >
                  <span className={styles.statusToggleStateDot} aria-hidden="true" />
                  <span className={styles.statusToggleLabel}>
                    {t('auth_files.status_toggle_label')}
                  </span>
                  {(hasQuotaError || hasStatusWarning) && (
                    <span
                      className={styles.stateWarningIconBadge}
                      title={activeWarningMessage}
                      aria-label={`${activeWarningLabel}: ${activeWarningMessage}`}
                      role="img"
                      tabIndex={0}
                    >
                      <IconCircleAlert size={14} aria-hidden="true" />
                    </span>
                  )}
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
