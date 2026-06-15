import { AUTH_FILES_FOCUS_CARDS_PATH } from './authFilesFocus';

export type SidebarIconKey =
  | 'dashboard'
  | 'aiProviders'
  | 'providerWorkbench'
  | 'authFiles'
  | 'oauth'
  | 'quota'
  | 'usageStatistics'
  | 'config'
  | 'logs'
  | 'plugins'
  | 'pluginStore'
  | 'system';

export type TransitionVariant = 'vertical' | 'ios';

export interface NavItemMeta {
  key: string;
  path: string;
  navTo?: string;
  labelKey: string;
  defaultLabel?: string;
  icon: SidebarIconKey;
  requiresLoggingToFile?: boolean;
  requiresPluginSupport?: boolean;
}

interface VisibleNavOptions {
  loggingToFile?: boolean | null;
  supportsPlugin?: boolean | null;
}

interface NestedRouteOrder {
  prefix: string;
  offset: number;
}

export const NAV_ITEMS: readonly NavItemMeta[] = [
  { key: 'dashboard', path: '/dashboard', labelKey: 'nav.dashboard', icon: 'dashboard' },
  { key: 'config', path: '/config', labelKey: 'nav.config_management', icon: 'config' },
  { key: 'aiProviders', path: '/ai-providers', labelKey: 'nav.ai_providers', icon: 'aiProviders' },
  {
    key: 'providerWorkbench',
    path: '/ai-providers/workbench',
    labelKey: 'nav.provider_workbench',
    defaultLabel: 'Provider Workbench',
    icon: 'providerWorkbench',
  },
  {
    key: 'authFiles',
    path: '/auth-files',
    navTo: AUTH_FILES_FOCUS_CARDS_PATH,
    labelKey: 'nav.auth_files',
    icon: 'authFiles',
  },
  { key: 'oauth', path: '/oauth', labelKey: 'nav.oauth', defaultLabel: 'OAuth', icon: 'oauth' },
  { key: 'quota', path: '/quota', labelKey: 'nav.quota_management', icon: 'quota' },
  {
    key: 'usageStatistics',
    path: '/usage-statistics',
    labelKey: 'nav.usage_statistics',
    defaultLabel: '模型统计',
    icon: 'usageStatistics',
  },
  { key: 'logs', path: '/logs', labelKey: 'nav.logs', icon: 'logs', requiresLoggingToFile: true },
  {
    key: 'plugins',
    path: '/plugins',
    labelKey: 'nav.plugins',
    defaultLabel: '插件管理',
    icon: 'plugins',
    requiresPluginSupport: true,
  },
  {
    key: 'pluginStore',
    path: '/plugin-store',
    labelKey: 'nav.plugin_store',
    defaultLabel: '插件商店',
    icon: 'pluginStore',
    requiresPluginSupport: true,
  },
  { key: 'system', path: '/system', labelKey: 'nav.system_info', icon: 'system' },
];

const AI_PROVIDER_ROUTE_ORDER: readonly NestedRouteOrder[] = [
  { prefix: '/ai-providers/gemini', offset: 0.1 },
  { prefix: '/ai-providers/codex', offset: 0.2 },
  { prefix: '/ai-providers/claude', offset: 0.3 },
  { prefix: '/ai-providers/vertex', offset: 0.4 },
  { prefix: '/ai-providers/ampcode', offset: 0.5 },
  { prefix: '/ai-providers/openai', offset: 0.6 },
  { prefix: '/ai-providers/workbench', offset: 0.7 },
];

const AUTH_FILES_ROUTE_ORDER: readonly NestedRouteOrder[] = [
  { prefix: '/auth-files/oauth-excluded', offset: 0.1 },
  { prefix: '/auth-files/oauth-model-alias', offset: 0.2 },
];

export function getVisibleNavItems({ loggingToFile, supportsPlugin }: VisibleNavOptions = {}) {
  return NAV_ITEMS.filter(
    (item) =>
      (!item.requiresLoggingToFile || Boolean(loggingToFile)) &&
      (!item.requiresPluginSupport || supportsPlugin === true)
  );
}

export function normalizeRoutePath(pathname: string) {
  const trimmedPath = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return trimmedPath;
}

function getNestedRouteOrder(
  normalizedPath: string,
  baseIndex: number,
  basePath: string,
  nestedRoutes: readonly NestedRouteOrder[]
) {
  if (baseIndex === -1) return null;
  if (normalizedPath === basePath) return baseIndex;
  if (!normalizedPath.startsWith(`${basePath}/`)) return null;

  const nestedRoute = nestedRoutes.find((route) => normalizedPath.startsWith(route.prefix));
  return baseIndex + (nestedRoute?.offset ?? 0.05);
}

export function getRouteOrder(pathname: string, options: VisibleNavOptions = {}) {
  const normalizedPath = normalizeRoutePath(pathname);
  const navOrder = getVisibleNavItems(options).map((item) => item.path);

  const aiProvidersOrder = getNestedRouteOrder(
    normalizedPath,
    navOrder.indexOf('/ai-providers'),
    '/ai-providers',
    AI_PROVIDER_ROUTE_ORDER
  );
  if (aiProvidersOrder !== null) return aiProvidersOrder;

  const authFilesOrder = getNestedRouteOrder(
    normalizedPath,
    navOrder.indexOf('/auth-files'),
    '/auth-files',
    AUTH_FILES_ROUTE_ORDER
  );
  if (authFilesOrder !== null) return authFilesOrder;

  const exactIndex = navOrder.indexOf(normalizedPath);
  if (exactIndex !== -1) return exactIndex;

  const nestedIndex = navOrder.findIndex(
    (path) => path !== '/' && normalizedPath.startsWith(`${path}/`)
  );
  return nestedIndex === -1 ? null : nestedIndex;
}

export function getTransitionVariant(fromPathname: string, toPathname: string): TransitionVariant {
  const from = normalizeRoutePath(fromPathname);
  const to = normalizeRoutePath(toPathname);
  const isAuthFiles = (pathname: string) =>
    pathname === '/auth-files' || pathname.startsWith('/auth-files/');
  const isAiProviders = (pathname: string) =>
    pathname === '/ai-providers' || pathname.startsWith('/ai-providers/');

  if (isAuthFiles(from) && isAuthFiles(to)) return 'ios';
  if (isAiProviders(from) && isAiProviders(to)) return 'ios';
  return 'vertical';
}
