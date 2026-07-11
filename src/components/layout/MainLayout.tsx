import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { PageTransition } from '@/components/common/PageTransition';
import {
  AUTH_FILES_PATH,
  createAuthFilesCardsFocusState,
  createAuthFilesCardsUnpinnedState,
  dispatchAuthFilesCardsFocusEvent,
  resolveAuthFilesCardsEnterScrollTop,
  shouldPinAuthFilesCards,
} from '@/router/authFilesFocus';
import { MainRoutes } from '@/router/MainRoutes';
import { getRouteOrder, getTransitionVariant } from '@/router/navMeta';
import {
  useAuthStore,
  useConfigStore,
  useLanguageStore,
  useNotificationStore,
  useThemeStore,
} from '@/stores';
import { triggerHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { HeaderActions } from './HeaderActions';
import { SidebarNav } from './SidebarNav';

const SIDEBAR_ID = 'primary-sidebar';

export function MainLayout() {
  const { t } = useTranslation();
  const { showNotification } = useNotificationStore();
  const location = useLocation();
  const navigate = useNavigate();

  const logout = useAuthStore((state) => state.logout);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const serverVersion = useAuthStore((state) => state.serverVersion);
  const supportsPlugin = useAuthStore((state) => state.supportsPlugin);
  const updateServerCapabilities = useAuthStore((state) => state.updateServerCapabilities);
  const config = useConfigStore((state) => state.config);
  const fetchConfig = useConfigStore((state) => state.fetchConfig);
  const clearCache = useConfigStore((state) => state.clearCache);
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const language = useLanguageStore((state) => state.language);
  const setLanguage = useLanguageStore((state) => state.setLanguage);
  const isMobile = useMediaQuery('(max-width: 768px)');

  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [authFilesQuickJumpPinnedOverride, setAuthFilesQuickJumpPinnedOverride] = useState(false);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLElement | null>(null);
  const mobileToggleRestoreRef = useRef<HTMLElement | null>(null);

  const isLogsPage = location.pathname.startsWith('/logs');
  const showAuthFilesQuickJump =
    location.pathname === AUTH_FILES_PATH || location.pathname.startsWith(`${AUTH_FILES_PATH}/`);
  const authFilesCardsStatePinned = shouldPinAuthFilesCards(location);
  const authFilesQuickJumpPinned =
    showAuthFilesQuickJump && (authFilesQuickJumpPinnedOverride || authFilesCardsStatePinned);
  const mobileSidebarActive = isMobile && sidebarOpen;

  // 将顶部悬浮控制区高度写入 CSS 变量，供移动端粘性元素和浮层避让。
  useLayoutEffect(() => {
    const updateHeaderHeight = () => {
      const height = headerRef.current?.offsetHeight;
      if (height) {
        document.documentElement.style.setProperty('--header-height', `${height}px`);
      }
    };

    updateHeaderHeight();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && headerRef.current
        ? new ResizeObserver(updateHeaderHeight)
        : null;
    if (resizeObserver && headerRef.current) {
      resizeObserver.observe(headerRef.current);
    }

    window.addEventListener('resize', updateHeaderHeight);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateHeaderHeight);
    };
  }, []);

  // 将主内容区的中心点写入 CSS 变量，供底部浮层（配置面板操作栏、提供商导航）对齐到内容区。
  useLayoutEffect(() => {
    const updateContentCenter = () => {
      const el = contentRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      document.documentElement.style.setProperty('--content-center-x', `${centerX}px`);
    };

    updateContentCenter();

    const resizeObserver =
      typeof ResizeObserver !== 'undefined' && contentRef.current
        ? new ResizeObserver(updateContentCenter)
        : null;

    if (resizeObserver && contentRef.current) {
      resizeObserver.observe(contentRef.current);
    }

    window.addEventListener('resize', updateContentCenter);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updateContentCenter);
      document.documentElement.style.removeProperty('--content-center-x');
    };
  }, []);

  useEffect(() => {
    fetchConfig().catch(() => {
      // ignore initial failure; login flow会提示
    });
  }, [fetchConfig]);

  useEffect(() => {
    if (!config) return;
    updateServerCapabilities({ supportsPlugin: config.supportsPlugin === true });
  }, [config, updateServerCapabilities]);

  useEffect(() => {
    const mobileMediaQuery = window.matchMedia('(max-width: 768px)');
    const handleBreakpointChange = (event: MediaQueryListEvent) => {
      if (!event.matches) {
        setSidebarOpen(false);
      }
    };

    mobileMediaQuery.addEventListener('change', handleBreakpointChange);
    return () => mobileMediaQuery.removeEventListener('change', handleBreakpointChange);
  }, []);

  useEffect(() => {
    if (!mobileSidebarActive) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      document.body.style.overflow = previousOverflow;
      const restoreTarget = mobileToggleRestoreRef.current;
      if (restoreTarget?.getClientRects().length) {
        restoreTarget.focus();
      }
    };
  }, [mobileSidebarActive]);

  const handleToggleSidebarOpen = useCallback(() => {
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const activeToggle = activeElement?.closest<HTMLElement>(
      `button[aria-controls="${SIDEBAR_ID}"]`
    );
    const visibleToggle = Array.from(
      headerRef.current?.querySelectorAll<HTMLElement>(
        `button[aria-controls="${SIDEBAR_ID}"]`
      ) ?? []
    ).find((element) => element.getClientRects().length > 0);
    mobileToggleRestoreRef.current =
      activeToggle ??
      visibleToggle ??
      null;
    setSidebarOpen((prev) => !prev);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const handleRefreshAll = async () => {
    clearCache();
    const results = await Promise.allSettled([
      fetchConfig(undefined, true),
      triggerHeaderRefresh(),
    ]);
    const rejected = results.find((result) => result.status === 'rejected');
    if (rejected && rejected.status === 'rejected') {
      const reason = rejected.reason;
      const message =
        typeof reason === 'string' ? reason : reason instanceof Error ? reason.message : '';
      showNotification(
        `${t('notification.refresh_failed')}${message ? `: ${message}` : ''}`,
        'error'
      );
      return;
    }
    showNotification(t('notification.data_refreshed'), 'success');
  };

  const handleAuthFilesQuickJump = useCallback(() => {
    if (authFilesQuickJumpPinned) {
      setAuthFilesQuickJumpPinnedOverride(false);
      dispatchAuthFilesCardsFocusEvent({ pinned: false });
      if (authFilesCardsStatePinned) {
        navigate(`${location.pathname}${location.search}${location.hash}`, {
          replace: true,
          state: createAuthFilesCardsUnpinnedState(),
        });
      }
      return;
    }

    setAuthFilesQuickJumpPinnedOverride(true);

    if (location.pathname === AUTH_FILES_PATH) {
      dispatchAuthFilesCardsFocusEvent({ pinned: true, behavior: 'smooth' });
      return;
    }

    navigate(AUTH_FILES_PATH, { state: createAuthFilesCardsFocusState() });
  }, [
    authFilesCardsStatePinned,
    authFilesQuickJumpPinned,
    location.hash,
    location.pathname,
    location.search,
    navigate,
  ]);

  const resolveRouteOrder = useCallback(
    (pathname: string) =>
      getRouteOrder(pathname, { loggingToFile: config?.loggingToFile, supportsPlugin }),
    [config?.loggingToFile, supportsPlugin]
  );

  return (
    <div className={`app-shell ${sidebarCollapsed ? 'sidebar-is-collapsed' : ''}`}>
      <div className="top-gradient-blur" aria-hidden="true" />

      <header className="main-header" ref={headerRef}>
        <HeaderActions
          sidebarId={SIDEBAR_ID}
          sidebarOpen={sidebarOpen}
          sidebarCollapsed={sidebarCollapsed}
          language={language}
          theme={theme}
          connectionStatus={connectionStatus}
          serverVersion={serverVersion}
          onToggleSidebarOpen={handleToggleSidebarOpen}
          onToggleSidebarCollapsed={() => setSidebarCollapsed((prev) => !prev)}
          onRefreshAll={handleRefreshAll}
          onAuthFilesQuickJump={handleAuthFilesQuickJump}
          showAuthFilesQuickJump={showAuthFilesQuickJump}
          authFilesQuickJumpPinned={authFilesQuickJumpPinned}
          onLanguageSelect={setLanguage}
          onThemeSelect={setTheme}
          onLogout={logout}
        />
      </header>

      <div className="main-body">
        <button
          type="button"
          className={`sidebar-backdrop ${sidebarOpen ? 'visible' : ''}`}
          onClick={handleCloseSidebar}
          aria-label={t('common.close')}
          aria-hidden={!sidebarOpen}
          tabIndex={-1}
        />

        <SidebarNav
          id={SIDEBAR_ID}
          open={sidebarOpen}
          mobile={isMobile}
          collapsed={sidebarCollapsed}
          loggingToFile={config?.loggingToFile}
          supportsPlugin={supportsPlugin}
          onClose={handleCloseSidebar}
          onNavigate={handleCloseSidebar}
        />

        <div
          className={`content${isLogsPage ? ' content-logs' : ''}`}
          ref={contentRef}
          aria-hidden={mobileSidebarActive || undefined}
          inert={mobileSidebarActive}
        >
          <main className={`main-content${isLogsPage ? ' main-content-logs' : ''}`}>
            <PageTransition
              render={(location) => <MainRoutes location={location} />}
              getRouteOrder={resolveRouteOrder}
              getTransitionVariant={getTransitionVariant}
              scrollContainerRef={contentRef}
              resolveEnterScrollTop={resolveAuthFilesCardsEnterScrollTop}
            />
          </main>
        </div>
      </div>
    </div>
  );
}
