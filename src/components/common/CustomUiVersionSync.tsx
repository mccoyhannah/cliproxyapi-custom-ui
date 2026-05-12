import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

const CHECK_INTERVAL_MS = 30_000;
const AUTO_RELOAD_DELAY_MS = 1_200;

type UpdateState = {
  buildId: string;
  autoReloading: boolean;
};

const getCurrentBuildId = () => {
  const metaBuildId =
    typeof document === 'undefined'
      ? ''
      : document
          .querySelector<HTMLMetaElement>('meta[name="custom-ui-build-id"]')
          ?.content.trim();
  return metaBuildId || __CUSTOM_UI_BUILD_ID__ || '';
};

const getManagementHtmlUrl = () => {
  const path = window.location.pathname.endsWith('.html')
    ? window.location.pathname
    : '/management.html';
  const url = new URL(path, window.location.origin);
  url.searchParams.set('custom_ui_check', String(Date.now()));
  return url.toString();
};

const readBuildIdFromHtml = (html: string) => {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return (
    doc.querySelector<HTMLMetaElement>('meta[name="custom-ui-build-id"]')?.content.trim() || ''
  );
};

const isSafeToAutoReload = () => {
  if (document.visibilityState !== 'visible') return false;
  if (window.location.hash.includes('/oauth')) return false;

  const activeElement = document.activeElement as HTMLElement | null;
  if (!activeElement) return true;
  const tagName = activeElement.tagName.toLowerCase();
  return !(
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    activeElement.isContentEditable
  );
};

export function CustomUiVersionSync() {
  const { t } = useTranslation();
  const currentBuildIdRef = useRef(getCurrentBuildId());
  const reloadTimerRef = useRef<number | null>(null);
  const updateDetectedRef = useRef(false);
  const [updateState, setUpdateState] = useState<UpdateState | null>(null);

  useEffect(() => {
    const checkForUpdate = async () => {
      if (updateDetectedRef.current || !currentBuildIdRef.current) return;

      try {
        const response = await fetch(getManagementHtmlUrl(), {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!response.ok) return;

        const nextBuildId = readBuildIdFromHtml(await response.text());
        if (!nextBuildId || nextBuildId === currentBuildIdRef.current) return;

        updateDetectedRef.current = true;
        const autoReloading = isSafeToAutoReload();
        setUpdateState({ buildId: nextBuildId, autoReloading });

        if (autoReloading) {
          reloadTimerRef.current = window.setTimeout(() => {
            window.location.reload();
          }, AUTO_RELOAD_DELAY_MS);
        }
      } catch {
        // 版本检测只做轻量保鲜，失败时保持当前页面不打扰用户。
      }
    };

    void checkForUpdate();
    const interval = window.setInterval(checkForUpdate, CHECK_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
      if (reloadTimerRef.current !== null) {
        window.clearTimeout(reloadTimerRef.current);
      }
    };
  }, []);

  if (!updateState) return null;

  return (
    <div className="custom-ui-sync-banner" role="status" aria-live="polite">
      <div className="custom-ui-sync-copy">
        <strong>{t('custom_ui_sync.title')}</strong>
        <span>
          {updateState.autoReloading
            ? t('custom_ui_sync.auto_reload')
            : t('custom_ui_sync.manual_reload')}
        </span>
      </div>
      <button
        type="button"
        className="custom-ui-sync-button"
        onClick={() => window.location.reload()}
        title={updateState.buildId}
      >
        {t('custom_ui_sync.reload_now')}
      </button>
    </div>
  );
}
