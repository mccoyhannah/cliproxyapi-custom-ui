import type { ReactNode } from 'react';
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

    return null;
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
