import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  ANTIGRAVITY_CONFIG,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CLI_CONFIG,
  KIMI_CONFIG,
} from '@/components/quota';
import { useQuotaStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import type { ManualExpiryRenderInfo } from '@/features/authFiles/manualExpiry';
import {
  formatCodexSubscriptionShortDate,
  normalizePlanType,
  resolveCodexPlanType,
  type CodexAuthTokenSnapshot,
  type CodexSubscriptionSnapshot,
} from '@/utils/quota';
import {
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
  authTokenSnapshot?: CodexAuthTokenSnapshot | null;
  codexSubscriptionSnapshot?: CodexSubscriptionSnapshot | null;
  manualExpiry?: ManualExpiryRenderInfo | null;
  onManualExpiryEdit?: () => void;
};

export function AuthFileQuotaSection(props: AuthFileQuotaSectionProps) {
  const {
    file,
    quotaType,
    compact = false,
    summaryOnly = false,
    authTokenSnapshot,
    codexSubscriptionSnapshot,
    manualExpiry,
    onManualExpiryEdit,
  } = props;
  const { t } = useTranslation();
  const [referenceTimeMs] = useState(() => Date.now());

  const quota = useQuotaStore((state) => {
    if (quotaType === 'antigravity') return state.antigravityQuota[file.name] as QuotaState;
    if (quotaType === 'claude') return state.claudeQuota[file.name] as QuotaState;
    if (quotaType === 'codex') return state.codexQuota[file.name] as QuotaState;
    if (quotaType === 'kimi') return state.kimiQuota[file.name] as QuotaState;
    return state.geminiCliQuota[file.name] as QuotaState;
  });

  const config = getQuotaConfig(quotaType) as unknown as {
    i18nPrefix: string;
    renderQuotaItems: (quota: unknown, t: TFunction, helpers: unknown) => unknown;
  };

  const quotaStatus = quota?.status ?? 'idle';
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
    authTokenSnapshot?.hasRefreshToken !== false &&
    normalizePlanType(resolveCodexPlanType(file)) !== 'free' &&
    codexSubscriptionSnapshot?.subscriptionStatus === 'found' &&
    codexSubscriptionSnapshot.subscriptionActiveUntil
      ? codexSubscriptionSnapshot
      : null;
  const compactAccessTokenOnly = compact && quotaType === 'codex' && authTokenSnapshot?.hasRefreshToken === false;
  const compactCodexPlanType =
    compact && quotaType === 'codex' ? normalizePlanType(resolveCodexPlanType(file)) : null;
  const compactCanSetManualExpiry =
    compact &&
    quotaType === 'codex' &&
    !compactAccessTokenOnly &&
    Boolean(compactCodexPlanType) &&
    compactCodexPlanType !== 'free' &&
    !manualExpiry &&
    !compactCodexExpiry;

  if ((compact || summaryOnly) && quotaType === 'codex') {
    if (quotaStatus === 'error') {
      return (
        <div
          className={`${styles.quotaSection} ${styles.quotaSectionCompact} ${quotaSectionToneClass}`}
        >
          <div className={styles.quotaCompactError} title={quotaErrorMessage}>
            {t('auth_files.quota_compact_error', {
              message: quotaErrorMessage,
              defaultValue: '额度异常：{{message}}',
            })}
          </div>
        </div>
      );
    }

    if (quotaStatus === 'success' && quota) {
      const content = config.renderQuotaItems(quota, t, {
        styles,
        QuotaProgressBar,
        displayMode: 'auth-card-compact',
        compactAuthCard: compact,
        authTokenSnapshot,
        codexSubscriptionSnapshot,
        manualExpiry,
        onManualExpiryEdit,
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

    if (!compactAccessTokenOnly && !manualExpiry && !compactCodexExpiry && !compactCanSetManualExpiry) return null;

    const expiryMs = compactAccessTokenOnly
      ? authTokenSnapshot?.accessTokenExpiresAtMs
      : (manualExpiry?.expiresAtMs ?? compactCodexExpiry?.subscriptionActiveUntilMs);
    const warningMs = 7 * 24 * 60 * 60 * 1000;
    const expiryClass = compactCanSetManualExpiry
      ? styles.codexSubscriptionUnset
      : compactAccessTokenOnly && (expiryMs === null || expiryMs === undefined)
        ? styles.codexSubscriptionWarning
      : expiryMs !== null && expiryMs !== undefined && expiryMs <= referenceTimeMs
        ? styles.codexSubscriptionExpired
        : expiryMs !== null && expiryMs !== undefined && expiryMs - referenceTimeMs <= warningMs
          ? styles.codexSubscriptionWarning
          : styles.codexSubscriptionHealthy;
    const expiryTitle = compactAccessTokenOnly
      ? authTokenSnapshot?.accessTokenExpiresAt ??
        t('auth_files.access_token_expiry_unknown_title', {
          defaultValue: '没有 refresh_token，且无法识别 access_token 到期时间',
        })
      : (manualExpiry?.title ??
        compactCodexExpiry?.subscriptionActiveUntil ??
        t('auth_files.manual_expiry_setup_title', {
          defaultValue: '为该付费套餐手动设置有效期',
        }));
    const expiryLabel = compactAccessTokenOnly
      ? t('auth_files.access_token_expiry_short_label', { defaultValue: 'Access 到期' })
      : t('auth_files.subscription_expiry_short_label');
    const expiryValue = compactAccessTokenOnly
      ? formatCodexSubscriptionShortDate(expiryMs, authTokenSnapshot?.accessTokenExpiresAt) ||
        t('auth_files.access_token_expiry_unknown', { defaultValue: '无法识别' })
      : compactCanSetManualExpiry
        ? t('auth_files.manual_expiry_setup_chip', { defaultValue: '设置有效期' })
        : (manualExpiry?.label ??
          formatCodexSubscriptionShortDate(
            compactCodexExpiry?.subscriptionActiveUntilMs,
            compactCodexExpiry?.subscriptionActiveUntil
          ));

    return (
      <div
        className={`${styles.quotaSection} ${styles.quotaSectionCompact} ${styles.quotaSectionReady}`}
      >
        <div className={`${styles.codexInfoGrid} ${styles.codexInfoGridCompact}`}>
          <div className={`${styles.codexInfoItem} ${styles.codexInfoItemCompact}`}>
            <span className={styles.codexPlanLabel}>
              {expiryLabel}
            </span>
            <span
              className={`${styles.codexPlanDateValue} ${styles.codexSubscriptionValue} ${expiryClass}`}
              title={expiryTitle}
              onClick={compactAccessTokenOnly ? undefined : onManualExpiryEdit}
              role={!compactAccessTokenOnly && onManualExpiryEdit ? 'button' : undefined}
              tabIndex={!compactAccessTokenOnly && onManualExpiryEdit ? 0 : undefined}
            >
              {expiryValue}
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
        <div className={styles.quotaMessage}>
          {t('auth_files.quota_refresh_global_hint', {
            defaultValue: '使用顶部“刷新额度”按钮获取最新额度。',
          })}
        </div>
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
          authTokenSnapshot,
          codexSubscriptionSnapshot,
          manualExpiry,
          onManualExpiryEdit,
        }) as ReactNode)
      ) : (
        <div className={styles.quotaMessage}>{t(`${config.i18nPrefix}.idle`)}</div>
      )}
    </div>
  );
}
