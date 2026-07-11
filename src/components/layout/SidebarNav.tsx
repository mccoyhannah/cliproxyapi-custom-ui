import { useCallback, useEffect, useRef, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { INLINE_LOGO_JPEG } from '@/assets/logoInline';
import {
  IconCode,
  IconSidebarAuthFiles,
  IconSidebarConfig,
  IconSidebarDashboard,
  IconSidebarLogs,
  IconSidebarOauth,
  IconSidebarProviders,
  IconSidebarQuota,
  IconSidebarSystem,
  IconSidebarUsage,
  IconX,
} from '@/components/ui/icons';
import { AUTH_FILES_FOCUS_CARDS_EVENT } from '@/router/authFilesFocus';
import { createUsageStatisticsAutoMaintenanceState } from '@/features/usageStatistics';
import {
  getVisibleNavItems,
  normalizeRoutePath,
  type NavItemMeta,
  type SidebarIconKey,
} from '@/router/navMeta';

interface SidebarNavProps {
  id: string;
  open: boolean;
  mobile: boolean;
  collapsed: boolean;
  loggingToFile?: boolean | null;
  supportsPlugin?: boolean | null;
  onClose: () => void;
  onNavigate: () => void;
}

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

const sidebarIcons: Record<SidebarIconKey, ReactNode> = {
  dashboard: <IconSidebarDashboard size={18} />,
  aiProviders: <IconSidebarProviders size={18} />,
  providerWorkbench: <IconSidebarProviders size={18} />,
  authFiles: <IconSidebarAuthFiles size={18} />,
  oauth: <IconSidebarOauth size={18} />,
  quota: <IconSidebarQuota size={18} />,
  usageStatistics: <IconSidebarUsage size={18} />,
  config: <IconSidebarConfig size={18} />,
  logs: <IconSidebarLogs size={18} />,
  plugins: <IconCode size={18} />,
  pluginStore: <IconCode size={18} />,
  system: <IconSidebarSystem size={18} />,
};

const fullBrandName = 'CLI Proxy API Management Center';

const getNavLabel = (item: NavItemMeta, t: ReturnType<typeof useTranslation>['t']) =>
  item.defaultLabel ? t(item.labelKey, { defaultValue: item.defaultLabel }) : t(item.labelKey);

const isWithinRoute = (pathname: string, routePath: string) =>
  pathname === routePath || pathname.startsWith(`${routePath}/`);

const isNavItemActive = (item: NavItemMeta, pathname: string) => {
  const currentPath = normalizeRoutePath(pathname);
  const itemPath = normalizeRoutePath(item.path);

  if (!isWithinRoute(currentPath, itemPath)) return false;

  if (item.key === 'aiProviders') {
    const workbenchPath = '/ai-providers/workbench';
    return !isWithinRoute(currentPath, workbenchPath);
  }

  return true;
};

export function SidebarNav({
  id,
  open,
  mobile,
  collapsed,
  loggingToFile,
  supportsPlugin,
  onClose,
  onNavigate,
}: SidebarNavProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const abbrBrandName = t('title.abbr');
  const isVisuallyCollapsed = collapsed && !open;
  const navItems = getVisibleNavItems({ loggingToFile, supportsPlugin });
  const sidebarRef = useRef<HTMLElement | null>(null);

  const getFocusableElements = useCallback(() => {
    if (!sidebarRef.current) return [] as HTMLElement[];
    return Array.from(
      sidebarRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
    ).filter((element) => !element.hasAttribute('disabled') && element.tabIndex !== -1);
  }, []);

  useEffect(() => {
    if (!mobile || !open) return;

    const focusTimer = window.setTimeout(() => {
      const firstFocusable = getFocusableElements()[0];
      (firstFocusable ?? sidebarRef.current)?.focus();
    }, 0);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if (event.key !== 'Tab') return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        sidebarRef.current?.focus();
        return;
      }

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      const activeElement = document.activeElement as HTMLElement | null;

      if (event.shiftKey) {
        if (activeElement === firstElement || activeElement === sidebarRef.current) {
          event.preventDefault();
          lastElement.focus();
        }
        return;
      }

      if (activeElement === lastElement || !sidebarRef.current?.contains(activeElement)) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [getFocusableElements, mobile, onClose, open]);

  return (
    <aside
      ref={sidebarRef}
      id={id}
      className={`sidebar ${open ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}
      aria-label={t('nav.main_navigation', { defaultValue: 'Main navigation' })}
      aria-hidden={mobile && !open ? true : undefined}
      aria-modal={mobile && open ? true : undefined}
      inert={mobile && !open}
      role={mobile && open ? 'dialog' : undefined}
      tabIndex={mobile && open ? -1 : undefined}
    >
      <div className="sidebar-brand" title={fullBrandName}>
        <img src={INLINE_LOGO_JPEG} alt="CPAMC logo" className="sidebar-brand-logo" />
        <span className="sidebar-brand-title">{abbrBrandName}</span>
        {mobile && open ? (
          <button
            type="button"
            className="sidebar-dialog-close"
            onClick={onClose}
            aria-label={t('common.close')}
          >
            <IconX size={18} />
          </button>
        ) : null}
      </div>

      <nav className="nav-section" aria-label={t('nav.main_navigation', { defaultValue: 'Main navigation' })}>
        {navItems.map((item) => {
          const label = getNavLabel(item, t);
          const navTarget = item.navTo ?? item.path;
          const navState =
            item.key === 'usageStatistics'
              ? createUsageStatisticsAutoMaintenanceState()
              : undefined;
          const isActive = isNavItemActive(item, location.pathname);
          const handleNavigate = () => {
            onNavigate();
            if (item.key === 'authFiles' && location.pathname === item.path) {
              window.dispatchEvent(new Event(AUTH_FILES_FOCUS_CARDS_EVENT));
            }
          };

          return (
            <Link
              key={item.path}
              to={navTarget}
              state={navState}
              className={`nav-item ${isActive ? 'active' : ''}`}
              onClick={handleNavigate}
              title={isVisuallyCollapsed ? label : undefined}
              aria-current={isActive ? 'page' : undefined}
              tabIndex={mobile && !open ? -1 : undefined}
            >
              <span className="nav-icon">{sidebarIcons[item.icon]}</span>
              <span className="nav-label">{label}</span>
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
