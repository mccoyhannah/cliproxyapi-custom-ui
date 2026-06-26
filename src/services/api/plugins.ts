import { apiClient } from './client';
import type {
  PluginConfigField,
  PluginConfigObject,
  PluginDeleteResult,
  PluginListEntry,
  PluginListResponse,
  PluginMenu,
  PluginMetadata,
  PluginStoreEntry,
  PluginStoreInstallResult,
  PluginStoreResponse,
  PluginStoreSource,
} from '@/types';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asString = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return String(value);
};

const asBoolean = (value: unknown): boolean => value === true;

const pick = (source: Record<string, unknown>, snakeKey: string, camelKey: string) =>
  source[snakeKey] ?? source[camelKey];

const normalizeConfigField = (value: unknown): PluginConfigField | null => {
  if (!isRecord(value)) return null;
  const name = asString(value.name).trim();
  if (!name) return null;

  const enumValuesSource = pick(value, 'enum_values', 'enumValues');
  const enumValues = Array.isArray(enumValuesSource)
    ? enumValuesSource.map((item) => asString(item).trim()).filter(Boolean)
    : [];

  return {
    name,
    type: asString(value.type).trim() || 'string',
    enumValues,
    description: asString(value.description).trim(),
  };
};

const normalizeConfigFields = (value: unknown): PluginConfigField[] =>
  Array.isArray(value)
    ? (value.map((item) => normalizeConfigField(item)).filter(Boolean) as PluginConfigField[])
    : [];

const normalizeMetadata = (value: unknown): PluginMetadata | null => {
  if (!isRecord(value)) return null;
  const name = asString(value.name).trim();
  const version = asString(value.version).trim();
  const author = asString(value.author).trim();
  const githubRepository = asString(
    pick(value, 'github_repository', 'githubRepository')
  ).trim();
  const logo = asString(value.logo).trim();
  const configFields = normalizeConfigFields(pick(value, 'config_fields', 'configFields'));

  if (!name && !version && !author && !githubRepository && !logo && configFields.length === 0) {
    return null;
  }

  return {
    name,
    version,
    author,
    githubRepository,
    logo,
    configFields,
  };
};

const normalizeMenu = (value: unknown): PluginMenu | null => {
  if (!isRecord(value)) return null;
  const path = asString(value.path).trim();
  const menu = asString(value.menu).trim();
  if (!path && !menu) return null;

  return {
    path,
    menu,
    description: asString(value.description).trim(),
  };
};

const normalizeMenus = (value: unknown): PluginMenu[] =>
  Array.isArray(value)
    ? (value.map((item) => normalizeMenu(item)).filter(Boolean) as PluginMenu[])
    : [];

const normalizePluginEntry = (value: unknown): PluginListEntry | null => {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  if (!id) return null;

  const metadata = normalizeMetadata(value.metadata);
  const configFields = normalizeConfigFields(pick(value, 'config_fields', 'configFields'));

  return {
    id,
    path: asString(value.path).trim(),
    configured: asBoolean(value.configured),
    registered: asBoolean(value.registered),
    enabled: value.enabled !== false,
    effectiveEnabled: asBoolean(pick(value, 'effective_enabled', 'effectiveEnabled')),
    supportsOAuth: asBoolean(pick(value, 'supports_oauth', 'supportsOAuth')),
    logo: asString(value.logo || metadata?.logo).trim(),
    configFields: configFields.length > 0 ? configFields : metadata?.configFields ?? [],
    menus: normalizeMenus(value.menus),
    metadata,
  };
};

const normalizePluginList = (value: unknown): PluginListResponse => {
  const source = isRecord(value) ? value : {};
  const plugins = Array.isArray(source.plugins)
    ? (source.plugins.map((item) => normalizePluginEntry(item)).filter(Boolean) as PluginListEntry[])
    : [];

  return {
    pluginsEnabled: asBoolean(pick(source, 'plugins_enabled', 'pluginsEnabled')),
    pluginsDir: asString(pick(source, 'plugins_dir', 'pluginsDir')).trim() || 'plugins',
    plugins,
  };
};

const normalizePluginConfig = (value: unknown): PluginConfigObject =>
  isRecord(value) ? { ...value } : {};

const normalizeDeleteResult = (value: unknown): PluginDeleteResult => {
  const source = isRecord(value) ? value : {};

  return {
    status: asString(source.status).trim(),
    id: asString(source.id).trim(),
    path: asString(source.path).trim(),
    fileDeleted: asBoolean(pick(source, 'file_deleted', 'fileDeleted')),
    configuredRemoved: asBoolean(pick(source, 'configured_removed', 'configuredRemoved')),
    restartRequired: asBoolean(pick(source, 'restart_required', 'restartRequired')),
  };
};

const normalizeStoreEntry = (value: unknown): PluginStoreEntry | null => {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  if (!id) return null;

  const sourceId = asString(pick(value, 'source_id', 'sourceId')).trim();
  const storeId =
    asString(pick(value, 'store_id', 'storeId')).trim() || (sourceId ? `${sourceId}/${id}` : id);
  const tags = Array.isArray(value.tags)
    ? value.tags.map((item) => asString(item).trim()).filter(Boolean)
    : [];

  return {
    storeId,
    sourceId,
    sourceName: asString(pick(value, 'source_name', 'sourceName')).trim(),
    sourceUrl: asString(pick(value, 'source_url', 'sourceUrl')).trim(),
    id,
    name: asString(value.name).trim(),
    description: asString(value.description).trim(),
    author: asString(value.author).trim(),
    version: asString(value.version).trim(),
    repository: asString(value.repository).trim(),
    logo: asString(value.logo).trim(),
    homepage: asString(value.homepage).trim(),
    license: asString(value.license).trim(),
    tags,
    installed: asBoolean(value.installed),
    installedVersion: asString(pick(value, 'installed_version', 'installedVersion')).trim(),
    path: asString(value.path).trim(),
    configured: asBoolean(value.configured),
    registered: asBoolean(value.registered),
    enabled: asBoolean(value.enabled),
    effectiveEnabled: asBoolean(pick(value, 'effective_enabled', 'effectiveEnabled')),
    updateAvailable: asBoolean(pick(value, 'update_available', 'updateAvailable')),
  };
};

const normalizeStoreSource = (value: unknown): PluginStoreSource | null => {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  const url = asString(value.url).trim();
  if (!id && !url) return null;

  return {
    id,
    name: asString(value.name).trim(),
    url,
  };
};

const normalizeStoreList = (value: unknown): PluginStoreResponse => {
  const source = isRecord(value) ? value : {};
  const plugins = Array.isArray(source.plugins)
    ? (source.plugins.map((item) => normalizeStoreEntry(item)).filter(Boolean) as PluginStoreEntry[])
    : [];
  const sources = Array.isArray(source.sources)
    ? (source.sources.map((item) => normalizeStoreSource(item)).filter(Boolean) as PluginStoreSource[])
    : [];

  return {
    pluginsEnabled: asBoolean(pick(source, 'plugins_enabled', 'pluginsEnabled')),
    pluginsDir: asString(pick(source, 'plugins_dir', 'pluginsDir')).trim() || 'plugins',
    sources,
    plugins,
  };
};

const normalizeInstallResult = (value: unknown): PluginStoreInstallResult => {
  const source = isRecord(value) ? value : {};

  return {
    status: asString(source.status).trim(),
    sourceId: asString(pick(source, 'source_id', 'sourceId')).trim(),
    sourceName: asString(pick(source, 'source_name', 'sourceName')).trim(),
    sourceUrl: asString(pick(source, 'source_url', 'sourceUrl')).trim(),
    id: asString(source.id).trim(),
    version: asString(source.version).trim(),
    path: asString(source.path).trim(),
    pluginsEnabled: asBoolean(pick(source, 'plugins_enabled', 'pluginsEnabled')),
    restartRequired: asBoolean(pick(source, 'restart_required', 'restartRequired')),
  };
};

export const pluginsApi = {
  async list(): Promise<PluginListResponse> {
    const data = await apiClient.get('/plugins');
    return normalizePluginList(data);
  },

  updateEnabled: (id: string, enabled: boolean) =>
    apiClient.patch(`/plugins/${encodeURIComponent(id)}/enabled`, { enabled }),

  async deletePlugin(id: string): Promise<PluginDeleteResult> {
    const data = await apiClient.delete(`/plugins/${encodeURIComponent(id)}`);
    return normalizeDeleteResult(data);
  },

  async getConfig(id: string): Promise<PluginConfigObject> {
    const data = await apiClient.get(`/plugins/${encodeURIComponent(id)}/config`);
    return normalizePluginConfig(data);
  },

  putConfig: (id: string, config: PluginConfigObject) =>
    apiClient.put(`/plugins/${encodeURIComponent(id)}/config`, config),

  patchConfig: (id: string, patch: PluginConfigObject) =>
    apiClient.patch(`/plugins/${encodeURIComponent(id)}/config`, patch),
};

export const pluginStoreApi = {
  async list(): Promise<PluginStoreResponse> {
    const data = await apiClient.get('/plugin-store');
    return normalizeStoreList(data);
  },

  async install(id: string, sourceId?: string): Promise<PluginStoreInstallResult> {
    const path = `/plugin-store/${encodeURIComponent(id)}/install`;
    const query = sourceId ? `?${new URLSearchParams({ source: sourceId }).toString()}` : '';
    const data = await apiClient.post(`${path}${query}`);
    return normalizeInstallResult(data);
  },
};
