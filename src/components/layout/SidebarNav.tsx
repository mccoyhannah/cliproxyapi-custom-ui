import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
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
} from '@/components/ui/icons';
import { AUTH_FILES_FOCUS_CARDS_EVENT } from '@/router/authFilesFocus';
import { getVisibleNavItems, type NavItemMeta, type SidebarIconKey } from '@/router/navMeta';

interface SidebarNavProps {
  id: string;
  open: boolean;
  collapsed: boolean;
  loggingToFile?: boolean | null;
  supportsPlugin?: boolean | null;
  onNavigate: () => void;
}

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

export function SidebarNav({
  id,
  open,
  collapsed,
  loggingToFile,
  supportsPlugin,
  onNavigate,
}: SidebarNavProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const abbrBrandName = t('title.abbr');
  const isVisuallyCollapsed = collapsed && !open;
  const navItems = getVisibleNavItems({ loggingToFile, supportsPlugin });

  return (
    <aside
      id={id}
      className={`sidebar ${open ? 'open' : ''} ${collapsed ? 'collapsed' : ''}`}
      aria-label={t('nav.main_navigation', { defaultValue: 'Main navigation' })}
    >
      <div className="sidebar-brand" title={fullBrandName}>
        <img src={INLINE_LOGO_JPEG} alt="CPAMC logo" className="sidebar-brand-logo" />
        <span className="sidebar-brand-title">{abbrBrandName}</span>
      </div>

      <nav className="nav-section" aria-label={t('nav.main_navigation', { defaultValue: 'Main navigation' })}>
        {navItems.map((item) => {
          const label = getNavLabel(item, t);
          const navTarget = item.navTo ?? item.path;
          const handleNavigate = () => {
            onNavigate();
            if (item.key === 'authFiles' && location.pathname === item.path) {
              window.dispatchEvent(new Event(AUTH_FILES_FOCUS_CARDS_EVENT));
            }
          };

          return (
            <NavLink
              key={item.path}
              to={navTarget}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
              onClick={handleNavigate}
              title={isVisuallyCollapsed ? label : undefined}
            >
              <span className="nav-icon">{sidebarIcons[item.icon]}</span>
              <span className="nav-label">{label}</span>
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
