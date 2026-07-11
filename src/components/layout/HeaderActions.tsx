import { useCallback, useEffect, useRef, useState } from 'react';
import type { SVGProps } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { LANGUAGE_LABEL_KEYS, LANGUAGE_ORDER } from '@/utils/constants';
import { isSupportedLanguage } from '@/utils/language';
import type { Language, Theme } from '@/types';
import { ThemeMenu } from './ThemeMenu';

interface HeaderActionsProps {
  sidebarId: string;
  sidebarOpen: boolean;
  sidebarCollapsed: boolean;
  language: Language;
  theme: Theme;
  connectionStatus: string;
  serverVersion?: string | null;
  onToggleSidebarOpen: () => void;
  onToggleSidebarCollapsed: () => void;
  onRefreshAll: () => void | Promise<void>;
  onAuthFilesQuickJump?: () => void;
  showAuthFilesQuickJump?: boolean;
  authFilesQuickJumpPinned?: boolean;
  onLanguageSelect: (language: string) => void;
  onThemeSelect: (theme: Theme) => void;
  onLogout: () => void;
}

type OpenMenu = 'language' | 'theme' | null;

const headerIconProps: SVGProps<SVGSVGElement> = {
  width: 16,
  height: 16,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
  focusable: 'false',
};

const headerIcons = {
  refresh: (
    <svg {...headerIconProps}>
      <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
    </svg>
  ),
  cards: (
    <svg {...headerIconProps}>
      <rect x="3" y="4" width="7" height="7" rx="1.5" />
      <rect x="14" y="4" width="7" height="7" rx="1.5" />
      <rect x="3" y="15" width="7" height="5" rx="1.5" />
      <rect x="14" y="15" width="7" height="5" rx="1.5" />
    </svg>
  ),
  menu: (
    <svg {...headerIconProps}>
      <path d="M4 7h16" />
      <path d="M4 12h16" />
      <path d="M4 17h16" />
    </svg>
  ),
  close: (
    <svg {...headerIconProps}>
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  ),
  chevronLeft: (
    <svg {...headerIconProps}>
      <path d="m14 18-6-6 6-6" />
    </svg>
  ),
  language: (
    <svg {...headerIconProps}>
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  ),
  sun: (
    <svg {...headerIconProps}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  ),
  moon: (
    <svg {...headerIconProps}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
    </svg>
  ),
  whiteTheme: (
    <svg {...headerIconProps}>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
    </svg>
  ),
  autoTheme: (
    <svg {...headerIconProps}>
      <defs>
        <clipPath id="mainLayoutAutoThemeSunLeftHalf">
          <rect x="0" y="0" width="12" height="24" />
        </clipPath>
      </defs>
      <circle cx="12" cy="12" r="4" />
      <circle
        cx="12"
        cy="12"
        r="4"
        clipPath="url(#mainLayoutAutoThemeSunLeftHalf)"
        fill="currentColor"
      />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="M4.93 4.93l1.41 1.41" />
      <path d="M17.66 17.66l1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="M6.34 17.66l-1.41 1.41" />
      <path d="M19.07 4.93l-1.41 1.41" />
    </svg>
  ),
  logout: (
    <svg {...headerIconProps}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  ),
};

const getThemeIcon = (theme: Theme) => {
  if (theme === 'auto') return headerIcons.autoTheme;
  if (theme === 'dark') return headerIcons.moon;
  if (theme === 'white') return headerIcons.whiteTheme;
  return headerIcons.sun;
};

export function HeaderActions({
  sidebarId,
  sidebarOpen,
  sidebarCollapsed,
  language,
  theme,
  connectionStatus,
  serverVersion,
  onToggleSidebarOpen,
  onToggleSidebarCollapsed,
  onRefreshAll,
  onAuthFilesQuickJump,
  showAuthFilesQuickJump = false,
  authFilesQuickJumpPinned = false,
  onLanguageSelect,
  onThemeSelect,
  onLogout,
}: HeaderActionsProps) {
  const { t } = useTranslation();
  const [openMenu, setOpenMenu] = useState<OpenMenu>(null);
  const languageMenuRef = useRef<HTMLDivElement | null>(null);
  const themeMenuRef = useRef<HTMLDivElement | null>(null);

  const languageMenuOpen = openMenu === 'language';
  const themeMenuOpen = openMenu === 'theme';
  const mobileSidebarToggleLabel = sidebarOpen
    ? t('sidebar.toggle_collapse', { defaultValue: 'Close navigation' })
    : t('sidebar.toggle_expand', { defaultValue: 'Open navigation' });
  const desktopSidebarToggleLabel = sidebarCollapsed
    ? t('sidebar.expand', { defaultValue: '展开' })
    : t('sidebar.collapse', { defaultValue: '收起' });
  const connectionBadgeVariant =
    connectionStatus === 'connected'
      ? 'success'
      : connectionStatus === 'connecting'
        ? 'warning'
        : 'error';
  const connectionLabel =
    connectionStatus === 'connected'
      ? t('common.connected_status')
      : connectionStatus === 'connecting'
        ? t('common.connecting')
        : t('common.disconnected_status');
  const versionLabel = serverVersion
    ? `v${serverVersion.trim().replace(/^[vV]+/, '')}`
    : t('common.unknown', { defaultValue: 'Unknown' });
  const authFilesQuickJumpLabel = authFilesQuickJumpPinned
    ? t('header.auth_files_quick_jump_unpin', { defaultValue: '解除观察位固定' })
    : t('header.auth_files_quick_jump', { defaultValue: '固定观察位' });

  useEffect(() => {
    if (!openMenu) return;

    const handlePointerDown = (event: MouseEvent) => {
      const menuRef = openMenu === 'language' ? languageMenuRef : themeMenuRef;
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpenMenu(null);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpenMenu(null);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [openMenu]);

  const toggleLanguageMenu = useCallback(() => {
    setOpenMenu((current) => (current === 'language' ? null : 'language'));
  }, []);

  const toggleThemeMenu = useCallback(() => {
    setOpenMenu((current) => (current === 'theme' ? null : 'theme'));
  }, []);

  const handleToggleSidebarOpen = useCallback(() => {
    setOpenMenu(null);
    onToggleSidebarOpen();
  }, [onToggleSidebarOpen]);

  const handleLanguageSelect = useCallback(
    (nextLanguage: string) => {
      if (!isSupportedLanguage(nextLanguage)) {
        return;
      }
      onLanguageSelect(nextLanguage);
      setOpenMenu(null);
    },
    [onLanguageSelect]
  );

  const handleThemeSelect = useCallback(
    (nextTheme: Theme) => {
      onThemeSelect(nextTheme);
      setOpenMenu(null);
    },
    [onThemeSelect]
  );

  return (
    <>
      <button
        type="button"
        className={`sidebar-toggle-floating ${sidebarCollapsed ? 'is-collapsed' : ''}`}
        onClick={onToggleSidebarCollapsed}
        aria-controls={sidebarId}
        aria-expanded={!sidebarCollapsed}
        title={desktopSidebarToggleLabel}
        aria-label={desktopSidebarToggleLabel}
      >
        <span className="sidebar-toggle-icon">{headerIcons.chevronLeft}</span>
      </button>

      <div
        className="mobile-sidebar-actions"
        aria-hidden={sidebarOpen || undefined}
        inert={sidebarOpen}
      >
        <Button
          className="mobile-menu-btn"
          variant="ghost"
          size="sm"
          onClick={handleToggleSidebarOpen}
          title={mobileSidebarToggleLabel}
          aria-label={mobileSidebarToggleLabel}
          aria-controls={sidebarId}
          aria-expanded={sidebarOpen}
        >
          {sidebarOpen ? headerIcons.close : headerIcons.menu}
        </Button>
      </div>

      <div
        className="header-actions floating-actions"
        aria-hidden={sidebarOpen || undefined}
        inert={sidebarOpen}
      >
        <div
          className="header-status-cluster"
          aria-label={t('dashboard.system_status', { defaultValue: 'System status' })}
        >
          <Badge variant={connectionBadgeVariant} size="sm" dot pulse={connectionStatus !== 'disconnected'}>
            {connectionLabel}
          </Badge>
          <Badge variant="neutral" size="sm" mono>
            {versionLabel}
          </Badge>
        </div>
        {showAuthFilesQuickJump && onAuthFilesQuickJump && (
          <Button
            variant={authFilesQuickJumpPinned ? 'secondary' : 'ghost'}
            size="sm"
            iconOnly
            onClick={onAuthFilesQuickJump}
            title={authFilesQuickJumpLabel}
            aria-label={authFilesQuickJumpLabel}
            aria-pressed={authFilesQuickJumpPinned}
          >
            {headerIcons.cards}
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={onRefreshAll}
          title={t('header.refresh_all')}
          aria-label={t('header.refresh_all')}
        >
          {headerIcons.refresh}
        </Button>
        <div className={`language-menu ${languageMenuOpen ? 'open' : ''}`} ref={languageMenuRef}>
          <Button
            variant="ghost"
            size="sm"
            onClick={toggleLanguageMenu}
            title={t('language.switch')}
            aria-label={t('language.switch')}
            aria-haspopup="menu"
            aria-expanded={languageMenuOpen}
          >
            {headerIcons.language}
          </Button>
          {languageMenuOpen && (
            <div
              className="notification entering language-menu-popover"
              role="menu"
              aria-label={t('language.switch')}
            >
              {LANGUAGE_ORDER.map((lang) => (
                <button
                  key={lang}
                  type="button"
                  className={`language-menu-option ${language === lang ? 'active' : ''}`}
                  onClick={() => handleLanguageSelect(lang)}
                  role="menuitemradio"
                  aria-checked={language === lang}
                >
                  <span>{t(LANGUAGE_LABEL_KEYS[lang])}</span>
                  {language === lang ? <span className="language-menu-check">✓</span> : null}
                </button>
              ))}
            </div>
          )}
        </div>
        <ThemeMenu
          open={themeMenuOpen}
          menuRef={themeMenuRef}
          theme={theme}
          buttonIcon={getThemeIcon(theme)}
          onToggle={toggleThemeMenu}
          onSelect={handleThemeSelect}
        />
        <Button
          variant="ghost"
          size="sm"
          onClick={onLogout}
          title={t('header.logout')}
          aria-label={t('header.logout')}
        >
          {headerIcons.logout}
        </Button>
      </div>
    </>
  );
}
