import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/Modal';
import { Select } from '@/components/ui/Select';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconCode,
  IconGithub,
  IconRefreshCw,
  IconSearch,
  IconSettings,
  IconTrash2,
} from '@/components/ui/icons';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { pluginsApi } from '@/services/api';
import { useAuthStore, useConfigStore, useNotificationStore } from '@/stores';
import type {
  PluginConfigField,
  PluginConfigObject,
  PluginListEntry,
  PluginListResponse,
} from '@/types';
import {
  buildPluginResourceRoute,
  buildRepositoryURL,
  getPluginTitle,
  notifyPluginResourcesChanged,
  resolvePluginAssetURL,
} from './pluginResources';
import {
  getErrorMessage,
  getErrorStatus,
  hasRestartRequiredError,
  isRecord,
} from './pluginErrors';
import styles from './PluginsPage.module.scss';

type PluginDraftValue = string | boolean;

interface PluginConfigDraft {
  enabled: boolean;
  priority: string;
  values: Record<string, PluginDraftValue>;
  errors: Record<string, string>;
}

const PLUGIN_ENABLE_REFRESH_DELAY_MS = 1600;

const wait = (ms: number) =>
  new Promise<void>((resolve) => {
    window.setTimeout(resolve, ms);
  });

function PluginCardLogo({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);

  return src && !failed ? (
    <img src={src} alt="" onError={() => setFailed(true)} />
  ) : (
    <IconCode size={18} />
  );
}

const normalizeFieldType = (field: PluginConfigField) => field.type.trim().toLowerCase();

const stringifyDraftValue = (field: PluginConfigField, value: unknown): PluginDraftValue => {
  const fieldType = normalizeFieldType(field);
  if (fieldType === 'boolean') return value === true;
  if (fieldType === 'array') {
    return Array.isArray(value)
      ? value
          .map((item) =>
            typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
              ? String(item)
              : JSON.stringify(item)
          )
          .join('\n')
      : '';
  }
  if (fieldType === 'object') {
    if (value === undefined || value === null) return '';
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }
  return value === undefined || value === null ? '' : String(value);
};

const buildDraft = (
  plugin: PluginListEntry,
  currentConfig: PluginConfigObject
): PluginConfigDraft => {
  const values: Record<string, PluginDraftValue> = {};
  plugin.configFields.forEach((field) => {
    values[field.name] = stringifyDraftValue(field, currentConfig[field.name]);
  });

  return {
    enabled: typeof currentConfig.enabled === 'boolean' ? currentConfig.enabled : plugin.enabled,
    priority:
      typeof currentConfig.priority === 'number' || typeof currentConfig.priority === 'string'
        ? String(currentConfig.priority)
        : '0',
    values,
    errors: {},
  };
};

const parseJSONField = (
  text: string,
  fieldType: string,
  fieldName: string,
  errors: Record<string, string>,
  t: (key: string) => string
) => {
  try {
    const parsed = JSON.parse(text);
    if (fieldType === 'array' && !Array.isArray(parsed)) {
      errors[fieldName] = t('plugin_management.expected_array');
      return undefined;
    }
    if (fieldType === 'object' && !isRecord(parsed)) {
      errors[fieldName] = t('plugin_management.expected_object');
      return undefined;
    }
    return parsed;
  } catch {
    errors[fieldName] = t('plugin_management.invalid_json');
    return undefined;
  }
};

const buildConfigPayload = (
  draft: PluginConfigDraft,
  fields: PluginConfigField[],
  currentConfig: PluginConfigObject,
  t: (key: string) => string
) => {
  const errors: Record<string, string> = {};
  const nextConfig: PluginConfigObject = { ...currentConfig };
  const priorityText = draft.priority.trim();

  nextConfig.enabled = draft.enabled;
  if (!priorityText) {
    nextConfig.priority = 0;
  } else if (!/^-?\d+$/.test(priorityText)) {
    errors.priority = t('plugin_management.invalid_priority');
  } else {
    nextConfig.priority = Number.parseInt(priorityText, 10);
  }

  fields.forEach((field) => {
    const fieldType = normalizeFieldType(field);
    const value = draft.values[field.name];

    if (fieldType === 'boolean') {
      nextConfig[field.name] = value === true;
      return;
    }

    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) {
      delete nextConfig[field.name];
      return;
    }

    if (fieldType === 'enum') {
      if (field.enumValues.length > 0 && !field.enumValues.includes(text)) {
        errors[field.name] = t('plugin_management.invalid_enum');
        return;
      }
      nextConfig[field.name] = text;
      return;
    }

    if (fieldType === 'number') {
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        errors[field.name] = t('plugin_management.invalid_number');
        return;
      }
      nextConfig[field.name] = parsed;
      return;
    }

    if (fieldType === 'integer') {
      if (!/^-?\d+$/.test(text)) {
        errors[field.name] = t('plugin_management.invalid_integer');
        return;
      }
      nextConfig[field.name] = Number.parseInt(text, 10);
      return;
    }

    if (fieldType === 'array') {
      const parsed = text.startsWith('[')
        ? parseJSONField(text, fieldType, field.name, errors, t)
        : text
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean);
      if (!errors[field.name]) nextConfig[field.name] = parsed;
      return;
    }

    if (fieldType === 'object') {
      const parsed = parseJSONField(text, fieldType, field.name, errors, t);
      if (!errors[field.name]) nextConfig[field.name] = parsed;
      return;
    }

    nextConfig[field.name] = text;
  });

  return { nextConfig, errors };
};

export function PluginsPage() {
  const { t } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const clearConfigCache = useConfigStore((state) => state.clearCache);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);

  const [data, setData] = useState<PluginListResponse | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingPlugin, setEditingPlugin] = useState<PluginListEntry | null>(null);
  const [editingConfig, setEditingConfig] = useState<PluginConfigObject>({});
  const [draft, setDraft] = useState<PluginConfigDraft | null>(null);
  const [mutatingID, setMutatingID] = useState('');
  const [deletingID, setDeletingID] = useState('');
  const [openingConfigID, setOpeningConfigID] = useState('');
  const configRequestSeq = useRef(0);

  const connected = connectionStatus === 'connected';

  const loadPlugins = useCallback(async () => {
    if (!connected) {
      setLoading(false);
      setError(t('notification.connection_required'));
      return;
    }

    setLoading(true);
    setError('');
    try {
      const plugins = await pluginsApi.list();
      setData(plugins);
    } catch (err: unknown) {
      setError(
        getErrorStatus(err) === 404
          ? t('plugin_management.unsupported_backend')
          : getErrorMessage(err, t('plugin_management.load_failed'))
      );
    } finally {
      setLoading(false);
    }
  }, [connected, t]);

  const loadPluginsAfterMutation = useCallback(
    async (waitForRegistration: boolean) => {
      if (waitForRegistration) await wait(PLUGIN_ENABLE_REFRESH_DELAY_MS);
      await loadPlugins();
    },
    [loadPlugins]
  );

  useHeaderRefresh(loadPlugins, connected);

  useEffect(() => {
    void loadPlugins();
  }, [loadPlugins]);

  const pluginStats = useMemo(() => {
    const plugins = data?.plugins ?? [];
    return {
      discovered: plugins.length,
      registered: plugins.filter((plugin) => plugin.registered).length,
      configured: plugins.filter((plugin) => plugin.configured).length,
      effective: plugins.filter((plugin) => plugin.effectiveEnabled).length,
    };
  }, [data?.plugins]);

  const visiblePlugins = useMemo(() => {
    const query = filter.trim().toLowerCase();
    const plugins = data?.plugins ?? [];
    if (!query) return plugins;

    return plugins.filter((plugin) => {
      const haystack = [
        plugin.id,
        plugin.path,
        plugin.metadata?.name,
        plugin.metadata?.author,
        plugin.metadata?.version,
        plugin.metadata?.githubRepository,
        ...plugin.menus.map((menu) => `${menu.menu} ${menu.path} ${menu.description}`),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(query);
    });
  }, [data?.plugins, filter]);

  const resolvePluginAsset = useCallback(
    (value: string) => resolvePluginAssetURL(value, apiBase),
    [apiBase]
  );

  const openConfigModal = async (plugin: PluginListEntry) => {
    if (openingConfigID || mutatingID || deletingID) return;

    const requestSeq = configRequestSeq.current + 1;
    configRequestSeq.current = requestSeq;
    setOpeningConfigID(plugin.id);
    setEditingPlugin(plugin);
    setEditingConfig({});
    setDraft(null);

    try {
      const currentConfig = await pluginsApi.getConfig(plugin.id);
      if (configRequestSeq.current !== requestSeq) return;
      setEditingConfig(currentConfig);
      setDraft(buildDraft(plugin, currentConfig));
    } catch (err: unknown) {
      if (configRequestSeq.current !== requestSeq) return;
      setEditingPlugin(null);
      setEditingConfig({});
      setDraft(null);
      showNotification(
        getErrorStatus(err) === 404
          ? t('plugin_management.config_not_found')
          : `${t('plugin_management.config_load_failed')}: ${getErrorMessage(
              err,
              t('plugin_management.config_load_failed')
            )}`,
        'error'
      );
    } finally {
      if (configRequestSeq.current === requestSeq) setOpeningConfigID('');
    }
  };

  const closeConfigModal = () => {
    if (mutatingID || openingConfigID || deletingID) return;
    setEditingPlugin(null);
    setEditingConfig({});
    setDraft(null);
  };

  const updateDraft = (updater: (current: PluginConfigDraft) => PluginConfigDraft) => {
    setDraft((current) => (current ? updater(current) : current));
  };

  const handleTogglePlugin = async (plugin: PluginListEntry, enabled: boolean) => {
    if (deletingID) return;
    setMutatingID(plugin.id);
    try {
      await pluginsApi.updateEnabled(plugin.id, enabled);
      clearConfigCache();
      await loadPluginsAfterMutation(enabled);
      notifyPluginResourcesChanged();
      showNotification(t('plugin_management.toggle_success'), 'success');
    } catch (err: unknown) {
      showNotification(
        `${t('plugin_management.toggle_failed')}: ${getErrorMessage(
          err,
          t('plugin_management.toggle_failed')
        )}`,
        'error'
      );
    } finally {
      setMutatingID('');
    }
  };

  const handleDeletePlugin = (plugin: PluginListEntry) => {
    if (!connected || mutatingID || openingConfigID || deletingID) return;
    const name = getPluginTitle(plugin);

    showConfirmation({
      title: t('plugin_management.delete_confirm_title'),
      message: t('plugin_management.delete_confirm_message', { name, id: plugin.id }),
      variant: 'danger',
      confirmText: t('plugin_management.delete_plugin'),
      onConfirm: async () => {
        setDeletingID(plugin.id);
        setMutatingID(plugin.id);
        try {
          const result = await pluginsApi.deletePlugin(plugin.id);
          clearConfigCache();
          if (editingPlugin?.id === plugin.id) closeConfigModal();
          await loadPluginsAfterMutation(false);
          notifyPluginResourcesChanged();
          showNotification(t('plugin_management.delete_success'), 'success');
          if (result.restartRequired) {
            showNotification(t('plugin_management.delete_restart_required'), 'warning');
          }
        } catch (err: unknown) {
          const restartRequired = hasRestartRequiredError(err);
          const fallback = restartRequired
            ? t('plugin_management.delete_restart_required')
            : t('plugin_management.delete_failed');
          showNotification(
            `${t('plugin_management.delete_failed')}: ${getErrorMessage(err, fallback)}`,
            restartRequired ? 'warning' : 'error'
          );
        } finally {
          setDeletingID('');
          setMutatingID('');
        }
      },
    });
  };

  const handleSaveConfig = async () => {
    if (!editingPlugin || !draft || openingConfigID || mutatingID || deletingID) return;
    const { nextConfig, errors } = buildConfigPayload(
      draft,
      editingPlugin.configFields,
      editingConfig,
      t
    );

    if (Object.keys(errors).length > 0) {
      setDraft({ ...draft, errors });
      showNotification(t('plugin_management.validation_failed'), 'warning');
      return;
    }

    setMutatingID(editingPlugin.id);
    try {
      await pluginsApi.putConfig(editingPlugin.id, nextConfig);
      clearConfigCache();
      await loadPluginsAfterMutation(nextConfig.enabled === true && editingPlugin.enabled !== true);
      notifyPluginResourcesChanged();
      closeConfigModal();
      showNotification(t('plugin_management.save_success'), 'success');
    } catch (err: unknown) {
      showNotification(
        `${t('plugin_management.save_failed')}: ${getErrorMessage(
          err,
          t('plugin_management.save_failed')
        )}`,
        'error'
      );
    } finally {
      setMutatingID('');
    }
  };

  const handleFieldTextChange =
    (fieldName: string) => (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = event.target.value;
      updateDraft((current) => ({
        ...current,
        values: { ...current.values, [fieldName]: value },
        errors: { ...current.errors, [fieldName]: '' },
      }));
    };

  const handleFieldBooleanChange = (fieldName: string, value: boolean) => {
    updateDraft((current) => ({
      ...current,
      values: { ...current.values, [fieldName]: value },
      errors: { ...current.errors, [fieldName]: '' },
    }));
  };

  const renderFieldEditor = (field: PluginConfigField) => {
    if (!draft) return null;
    const fieldType = normalizeFieldType(field);
    const value = draft.values[field.name];
    const textValue = typeof value === 'string' ? value : '';
    const errorText = draft.errors[field.name];

    if (fieldType === 'boolean') {
      return (
        <div key={field.name} className={styles.fieldRow}>
          <div className={styles.fieldText}>
            <div className={styles.fieldLabel}>{field.name}</div>
            {field.description ? (
              <div className={styles.fieldDescription}>{field.description}</div>
            ) : null}
          </div>
          <ToggleSwitch
            checked={value === true}
            onChange={(nextValue) => handleFieldBooleanChange(field.name, nextValue)}
            ariaLabel={field.name}
          />
        </div>
      );
    }

    if (fieldType === 'enum' && field.enumValues.length > 0) {
      return (
        <div key={field.name} className={styles.formField}>
          <label htmlFor={`plugin-field-${field.name}`}>{field.name}</label>
          <Select
            id={`plugin-field-${field.name}`}
            value={textValue}
            options={field.enumValues.map((item) => ({ value: item, label: item }))}
            onChange={(nextValue) =>
              updateDraft((current) => ({
                ...current,
                values: { ...current.values, [field.name]: nextValue },
                errors: { ...current.errors, [field.name]: '' },
              }))
            }
            placeholder={t('plugin_management.select_placeholder')}
          />
          {field.description ? <div className={styles.fieldHint}>{field.description}</div> : null}
          {errorText ? <div className={styles.fieldError}>{errorText}</div> : null}
        </div>
      );
    }

    const multiline = fieldType === 'array' || fieldType === 'object';
    return (
      <div key={field.name} className={styles.formField}>
        <label htmlFor={`plugin-field-${field.name}`}>{field.name}</label>
        {multiline ? (
          <textarea
            id={`plugin-field-${field.name}`}
            className={styles.textarea}
            value={textValue}
            onChange={handleFieldTextChange(field.name)}
            spellCheck={false}
          />
        ) : (
          <Input
            id={`plugin-field-${field.name}`}
            value={textValue}
            onChange={handleFieldTextChange(field.name)}
          />
        )}
        {field.description ? <div className={styles.fieldHint}>{field.description}</div> : null}
        {errorText ? <div className={styles.fieldError}>{errorText}</div> : null}
      </div>
    );
  };

  const configModalTitle = editingPlugin
    ? t('plugin_management.config_title', { name: getPluginTitle(editingPlugin) })
    : t('plugin_management.edit_config');

  return (
    <div className={styles.page}>
      <div className={styles.pageHeader}>
        <div>
          <h1 className={styles.title}>{t('plugin_management.title')}</h1>
          <p className={styles.description}>{t('plugin_management.description')}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={loadPlugins}
          disabled={!connected || loading}
          loading={loading}
          leftIcon={<IconRefreshCw size={16} />}
        >
          {t('plugin_management.refresh')}
        </Button>
      </div>

      {error ? <div className={styles.errorBox}>{error}</div> : null}
      {data && !data.pluginsEnabled ? (
        <div className={styles.warningBox}>{t('plugin_management.global_disabled_hint')}</div>
      ) : null}

      {data ? (
        <div className={styles.statusBar}>
          <div className={styles.statusPill}>
            <span
              className={`${styles.statusDot} ${
                data.pluginsEnabled ? styles.statusDotOn : styles.statusDotOff
              }`}
            />
            <span className={styles.statusLabel}>{t('plugin_management.global_status')}</span>
            <span className={styles.statusValue}>
              {data.pluginsEnabled
                ? t('plugin_management.global_enabled')
                : t('plugin_management.global_disabled')}
            </span>
          </div>
          <span className={styles.statusDivider} />
          <div className={styles.statusPill}>
            <span className={styles.statusLabel}>{t('plugin_management.plugins_dir')}</span>
            <span className={`${styles.statusValue} ${styles.statusPathValue}`}>
              {data.pluginsDir || 'plugins'}
            </span>
          </div>
          <span className={styles.statusDivider} />
          <div className={styles.statusPill}>
            <span className={styles.statusLabel}>{t('plugin_management.discovered')}</span>
            <span className={styles.statusValue}>{pluginStats.discovered}</span>
          </div>
          <div className={styles.statusPill}>
            <span className={styles.statusLabel}>{t('plugin_management.effective')}</span>
            <span className={styles.statusValue}>{pluginStats.effective}</span>
          </div>
        </div>
      ) : null}

      <div className={styles.toolbar}>
        <Input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t('plugin_management.search_placeholder')}
          aria-label={t('plugin_management.search_label')}
          rightElement={<IconSearch size={16} />}
        />
      </div>

      {loading ? (
        <div className={styles.pluginList}>
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} className={styles.skeletonRow}>
              <div className={styles.skeletonAvatar} />
              <div className={styles.skeletonText}>
                <div className={styles.skeletonLine} />
                <div className={styles.skeletonLine} />
              </div>
            </div>
          ))}
        </div>
      ) : visiblePlugins.length === 0 ? (
        !error ? (
          <EmptyState
            title={t('plugin_management.no_plugins')}
            description={t('plugin_management.no_plugins_desc')}
            action={
              <Button variant="secondary" size="sm" onClick={loadPlugins} disabled={!connected}>
                {t('plugin_management.refresh')}
              </Button>
            }
          />
        ) : null
      ) : (
        <div className={styles.pluginList}>
          {visiblePlugins.map((plugin) => {
            const title = getPluginTitle(plugin);
            const logo = resolvePluginAsset(plugin.logo || plugin.metadata?.logo || '');
            const repositoryURL = buildRepositoryURL(plugin.metadata?.githubRepository ?? '');
            const isMutating = mutatingID === plugin.id;
            const isOpeningConfig = openingConfigID === plugin.id;

            return (
              <article key={plugin.id} className={styles.pluginRow}>
                <div className={styles.logoBox} aria-hidden="true">
                  <PluginCardLogo src={logo} />
                </div>
                <div className={styles.pluginInfo}>
                  <div className={styles.pluginName}>
                    <h2>{title}</h2>
                    <span
                      className={
                        plugin.effectiveEnabled ? styles.badgeSuccess : styles.badgeMuted
                      }
                    >
                      {plugin.effectiveEnabled
                        ? t('plugin_management.status_effective')
                        : t('plugin_management.status_inactive')}
                    </span>
                  </div>
                  <div className={styles.pluginId}>{plugin.id}</div>
                  <div className={styles.pluginMeta}>
                    {plugin.metadata?.version ? (
                      <span className={styles.metaItem}>
                        <strong>{t('plugin_management.version_label')}</strong>
                        {plugin.metadata.version}
                      </span>
                    ) : null}
                    {plugin.metadata?.author ? (
                      <span className={styles.metaItem}>
                        <strong>{t('plugin_management.author_label')}</strong>
                        {plugin.metadata.author}
                      </span>
                    ) : null}
                    {plugin.path ? (
                      <span className={`${styles.metaItem} ${styles.metaPath}`}>
                        <strong>{t('plugin_management.path_label')}</strong>
                        {plugin.path}
                      </span>
                    ) : null}
                  </div>
                  <div className={styles.badgeRow}>
                    <span className={plugin.configured ? styles.badgeSuccess : styles.badgeMuted}>
                      {plugin.configured
                        ? t('plugin_management.configured')
                        : t('plugin_management.not_configured')}
                    </span>
                    <span className={plugin.registered ? styles.badgeSuccess : styles.badgeWarning}>
                      {plugin.registered
                        ? t('plugin_management.registered')
                        : t('plugin_management.not_registered')}
                    </span>
                    {plugin.supportsOAuth ? (
                      <span className={styles.badge}>{t('plugin_management.oauth')}</span>
                    ) : null}
                  </div>
                  {plugin.menus.length > 0 ? (
                    <div className={styles.resourceLinks}>
                      {plugin.menus.map((menu, index) => (
                        <a
                          key={`${plugin.id}-${index}`}
                          href={`#${buildPluginResourceRoute(plugin.id, index)}`}
                          className={styles.resourceLink}
                        >
                          {menu.menu || menu.path || t('plugin_management.open_resource')}
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className={styles.rowActions}>
                  <ToggleSwitch
                    checked={plugin.enabled}
                    disabled={!connected || Boolean(mutatingID || deletingID)}
                    onChange={(enabled) => handleTogglePlugin(plugin, enabled)}
                    ariaLabel={title}
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => openConfigModal(plugin)}
                    disabled={!connected || Boolean(mutatingID || deletingID || openingConfigID)}
                    loading={isOpeningConfig}
                    leftIcon={<IconSettings size={14} />}
                  >
                    {t('plugin_management.edit_config')}
                  </Button>
                  {repositoryURL ? (
                    <a
                      className={styles.iconLink}
                      href={repositoryURL}
                      target="_blank"
                      rel="noreferrer"
                      title={t('plugin_management.open_repository')}
                      aria-label={t('plugin_management.open_repository')}
                    >
                      <IconGithub size={14} />
                    </a>
                  ) : null}
                  <Button
                    variant="danger"
                    size="sm"
                    iconOnly
                    onClick={() => handleDeletePlugin(plugin)}
                    disabled={!connected || Boolean(mutatingID || deletingID || openingConfigID)}
                    loading={isMutating && deletingID === plugin.id}
                    title={t('plugin_management.delete_plugin')}
                    aria-label={t('plugin_management.delete_plugin')}
                  >
                    <IconTrash2 size={14} />
                  </Button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Modal
        open={Boolean(editingPlugin)}
        onClose={closeConfigModal}
        closeDisabled={Boolean(mutatingID || openingConfigID)}
        title={configModalTitle}
        width={620}
        footer={
          <div className={styles.modalFooter}>
            <Button variant="secondary" onClick={closeConfigModal} disabled={Boolean(mutatingID)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={handleSaveConfig} loading={Boolean(mutatingID)}>
              {t('common.save')}
            </Button>
          </div>
        }
      >
        {!draft || !editingPlugin ? (
          <div className={styles.loadingText}>{t('common.loading')}</div>
        ) : (
          <div className={styles.configForm}>
            <section className={styles.formSection}>
              <h3>{t('plugin_management.base_settings')}</h3>
              <div className={styles.fieldRow}>
                <div className={styles.fieldText}>
                  <div className={styles.fieldLabel}>{t('plugin_management.enabled')}</div>
                  <div className={styles.fieldDescription}>
                    {t('plugin_management.enabled_hint')}
                  </div>
                </div>
                <ToggleSwitch
                  checked={draft.enabled}
                  onChange={(enabled) =>
                    updateDraft((current) => ({ ...current, enabled }))
                  }
                  ariaLabel={t('plugin_management.enabled')}
                />
              </div>
              <Input
                label={t('plugin_management.priority')}
                value={draft.priority}
                onChange={(event) =>
                  updateDraft((current) => ({
                    ...current,
                    priority: event.target.value,
                    errors: { ...current.errors, priority: '' },
                  }))
                }
                error={draft.errors.priority}
              />
            </section>
            <section className={styles.formSection}>
              <h3>{t('plugin_management.config_fields')}</h3>
              {editingPlugin.configFields.length === 0 ? (
                <div className={styles.emptyConfig}>
                  {t('plugin_management.no_config_fields')}
                </div>
              ) : (
                editingPlugin.configFields.map((field) => renderFieldEditor(field))
              )}
            </section>
          </div>
        )}
      </Modal>
    </div>
  );
}
