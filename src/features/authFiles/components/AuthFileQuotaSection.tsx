import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
} from '@/components/quota';
import { useNotificationStore, useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import {
  formatCodexSubscriptionShortDate,
  getStatusFromError,
  normalizePlanType,
  resolveCodexPlanType,
  type CodexSubscriptionSnapshot,
} from '@/utils/quota';
import {
  isRuntimeOnlyAuthFile,
  resolveQuotaErrorMessage,
  type QuotaProviderType,
} from '@/features/authFiles/constants';
import { QuotaProgressBar } from '@/features/authFiles/components/QuotaProgressBar';
import styles from '@/pages/AuthFilesPage.module.scss';

type QuotaState = { status?: string; error?: string; errorStatus?: number } | undefined;

const getQuotaConfig = (type: QuotaProviderType) => {
  if (type === 'antigravity') return ANTIGRAVITY_CONFIG;
  if (type === 'claude') return CLAUDE_CONFIG;
  if (type === 'codex') return CODEX_CONFIG;
  if (type === 'kimi') return KIMI_CONFIG;
  return GEMINI_CLI_CONFIG;
};

export type AuthFileQuotaSectionProps = {
  file: AuthFileItem;
  quotaType: QuotaProviderType;
  disableControls: boolean;
  compact?: boolean;
  summaryOnly?: boolean;
  codexSubscriptionSnapshot?: CodexSubscriptionSnapshot | null;
};

export function AuthFileQuotaSection(props: AuthFileQuotaSectionProps) {
  const {
    file,
    quotaType,
    disableControls,
    compact = false,
    summaryOnly = false,
    codexSubscriptionSnapshot,
  } = props;
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const [referenceTimeMs] = useState(() => Date.now());

  const quota = useQuotaStore((state) => {
    if (quotaType === 'antigravity') return state.antigravityQuota[file.name] as QuotaState;
    if (quotaType === 'claude') return state.claudeQuota[file.name] as QuotaState;
    if (quotaType === 'codex') return state.codexQuota[file.name] as QuotaState;
    if (quotaType === 'kimi') return state.kimiQuota[file.name] as QuotaState;
    return state.geminiCliQuota[file.name] as QuotaState;
  });

  const updateQuotaState = useQuotaStore((state) => {
    if (quotaType === 'antigravity')
      return state.setAntigravityQuota as unknown as (updater: unknown) => void;
    if (quotaType === 'claude')
      return state.setClaudeQuota as unknown as (updater: unknown) => void;
    if (quotaType === 'codex') return state.setCodexQuota as unknown as (updater: unknown) => void;
    if (quotaType === 'kimi') return state.setKimiQuota as unknown as (updater: unknown) => void;
    return state.setGeminiCliQuota as unknown as (updater: unknown) => void;
  });

  const refreshQuotaForFile = useCallback(async () => {
    if (disableControls) return;
    if (isRuntimeOnlyAuthFile(file)) return;
    if (file.disabled) return;
    if (quota?.status === 'loading') return;

    const config = getQuotaConfig(quotaType) as unknown as {
      i18nPrefix: string;
      fetchQuota: (file: AuthFileItem, t: TFunction) => Promise<unknown>;
      buildLoadingState: () => unknown;
      buildSuccessState: (data: unknown) => unknown;
      buildErrorState: (message: string, status?: number) => unknown;
      renderQuotaItems: (quota: unknown, t: TFunction, helpers: unknown) => unknown;
    };

    updateQuotaState((prev: Record<string, unknown>) => ({
      ...prev,
      [file.name]: config.buildLoadingState(),
    }));

    try {
      const data = await config.fetchQuota(file, t);
      updateQuotaState((prev: Record<string, unknown>) => ({
        ...prev,
        [file.name]: config.buildSuccessState(data),
      }));
      showNotification(t('auth_files.quota_refresh_success', { name: file.name }), 'success');
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      const status = getStatusFromError(err);
      updateQuotaState((prev: Record<string, unknown>) => ({
        ...prev,
        [file.name]: config.buildErrorState(message, status),
      }));
      showNotification(t('auth_files.quota_refresh_failed', { name: file.name, message }), 'error');
    }
  }, [disableControls, file, quota?.status, quotaType, showNotification, t, updateQuotaState]);

  const config = getQuotaConfig(quotaType) as unknown as {
    i18nPrefix: string;
    renderQuotaItems: (quota: unknown, t: TFunction, helpers: unknown) => unknown;
  };

  const quotaStatus = quota?.status ?? 'idle';
  const canRefreshQuota = !disableControls && !file.disabled;
  const quotaErrorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  const quotaSectionToneClass =
    quotaStatus === 'loading'
      ? styles.quotaSectionLoading
      : quotaStatus === 'error'
        ? styles.quotaSectionError
        : quotaStatus === 'success'
          ? styles.quotaSectionReady
          : styles.quotaSectionIdle;
  const compactCodexExpiry =
    compact &&
    quotaType === 'codex' &&
    normalizePlanType(resolveCodexPlanType(file)) !== 'free' &&
    codexSubscriptionSnapshot?.subscriptionStatus === 'found' &&
    codexSubscriptionSnapshot.subscriptionActiveUntil
      ? codexSubscriptionSnapshot
      : null;

  if ((compact || summaryOnly) && quotaType === 'codex') {
    if (quotaStatus === 'success' && quota) {
      const content = config.renderQuotaItems(quota, t, {
        styles,
        QuotaProgressBar,
        displayMode: 'auth-card-compact',
        compactAuthCard: compact,
        codexSubscriptionSnapshot,
      }) as ReactNode;

      if (!content) return null;

      return (
        <div
          className={`${styles.quotaSection} ${styles.quotaSectionCompact} ${quotaSectionToneClass}`}
        >
          {content}
        </div>
      );
    }

    if (!compactCodexExpiry) return null;

    const expiryMs = compactCodexExpiry.subscriptionActiveUntilMs;
    const warningMs = 7 * 24 * 60 * 60 * 1000;
    const expiryClass =
      expiryMs !== null && expiryMs !== undefined && expiryMs <= referenceTimeMs
        ? styles.codexSubscriptionExpired
        : expiryMs !== null && expiryMs !== undefined && expiryMs - referenceTimeMs <= warningMs
          ? styles.codexSubscriptionWarning
          : styles.codexSubscriptionHealthy;

    return (
      <div
        className={`${styles.quotaSection} ${styles.quotaSectionCompact} ${styles.quotaSectionReady}`}
      >
        <div className={`${styles.codexInfoGrid} ${styles.codexInfoGridCompact}`}>
          <div className={`${styles.codexInfoItem} ${styles.codexInfoItemCompact}`}>
            <span className={styles.codexPlanLabel}>
              {t('auth_files.subscription_expiry_short_label')}
            </span>
            <span
              className={`${styles.codexPlanDateValue} ${styles.codexSubscriptionValue} ${expiryClass}`}
              title={compactCodexExpiry.subscriptionActiveUntil || undefined}
            >
              {formatCodexSubscriptionShortDate(
                compactCodexExpiry.subscriptionActiveUntilMs,
                compactCodexExpiry.subscriptionActiveUntil
              )}
            </span>
          </div>
        </div>
      </div>
    );
  }

  if (compact) return null;

  return (
    <div className={`${styles.quotaSection} ${quotaSectionToneClass}`}>
      {quotaStatus === 'loading' ? (
        <div className={styles.quotaMessage}>{t(`${config.i18nPrefix}.loading`)}</div>
      ) : quotaStatus === 'idle' ? (
        <button
          type="button"
          className={`${styles.quotaMessage} ${styles.quotaMessageAction}`}
          onClick={() => void refreshQuotaForFile()}
          disabled={!canRefreshQuota}
        >
          {t(`${config.i18nPrefix}.idle`)}
        </button>
      ) : quotaStatus === 'error' ? (
        <div className={styles.quotaError}>
          {t(`${config.i18nPrefix}.load_failed`, {
            message: quotaErrorMessage,
          })}
        </div>
      ) : quota ? (
        (config.renderQuotaItems(quota, t, {
          styles,
          QuotaProgressBar,
          displayMode: 'auth-card',
          codexSubscriptionSnapshot,
        }) as ReactNode)
      ) : (
        <div className={styles.quotaMessage}>{t(`${config.i18nPrefix}.idle`)}</div>
      )}
    </div>
  );
}
