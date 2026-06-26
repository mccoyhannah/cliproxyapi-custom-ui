import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { SensitiveValueField } from '@/components/ui/SensitiveValueField';
import { Skeleton } from '@/components/ui/Skeleton';
import {
  IconCheck,
  IconCircleAlert,
  IconRefreshCw,
  IconSearch,
  IconSlidersHorizontal,
} from '@/components/ui/icons';
import { providersApi } from '@/services/api';
import type { ProviderBrand } from '@/types';
import type { ModelInfo } from '@/utils/models';
import { PROVIDER_BRAND_ORDER } from './descriptors';
import type { ProviderGroup, ProviderResource } from './types';
import { useProviderWorkbench } from './useProviderWorkbench';
import styles from './ProvidersWorkbenchPage.module.scss';

type TestState = 'idle' | 'loading' | 'success' | 'error';

interface AsyncPanelState {
  state: TestState;
  message: string;
}

const EMPTY_PROVIDER_GROUPS: ProviderGroup[] = [];

const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Request failed';
};

const pickDefaultModel = (resource: ProviderResource): string =>
  resource.models[0] ?? (resource.brand === 'codex' ? 'gpt-5' : '');

const formatTime = (iso: string, locale: string): string => {
  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(iso));
  } catch {
    return iso;
  }
};

export function ProvidersWorkbenchPage() {
  const { t, i18n } = useTranslation();
  const workbench = useProviderWorkbench();
  const [activeBrand, setActiveBrand] = useState<ProviderBrand>('codex');
  const [filter, setFilter] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [discovery, setDiscovery] = useState<AsyncPanelState>({ state: 'idle', message: '' });
  const [connectivity, setConnectivity] = useState<AsyncPanelState>({
    state: 'idle',
    message: '',
  });

  const groups = workbench.snapshot?.groups ?? EMPTY_PROVIDER_GROUPS;
  const activeGroup =
    groups.find((group) => group.id === activeBrand) ?? groups[0] ?? null;

  const filteredResources = useMemo(() => {
    if (!activeGroup) return [];
    const normalized = filter.trim().toLowerCase();
    if (!normalized) return activeGroup.resources;
    return activeGroup.resources.filter((resource) => {
      const haystack = [
        resource.name,
        resource.identifier,
        resource.authIndex,
        resource.apiKeyPreview,
        resource.baseUrl,
        resource.prefix,
        ...resource.models,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalized);
    });
  }, [activeGroup, filter]);

  const selectedResource = useMemo(() => {
    if (!activeGroup) return null;
    return (
      activeGroup.resources.find((resource) => resource.id === selectedId) ??
      filteredResources[0] ??
      activeGroup.resources[0] ??
      null
    );
  }, [activeGroup, filteredResources, selectedId]);

  const totals = useMemo(() => {
    const resources = groups.flatMap((group) => group.resources);
    return {
      resources: resources.length,
      active: resources.filter((resource) => !resource.disabled).length,
      families: groups.filter((group) => group.resources.length > 0).length,
    };
  }, [groups]);

  const refresh = useCallback(() => {
    setModels([]);
    setDiscovery({ state: 'idle', message: '' });
    setConnectivity({ state: 'idle', message: '' });
    void workbench.refetch();
  }, [workbench]);

  const discoverModels = useCallback(async () => {
    if (!selectedResource) return;
    setDiscovery({ state: 'loading', message: '' });
    setModels([]);
    try {
      const next = await providersApi.discoverModels({
        brand: selectedResource.brand,
        baseUrl: selectedResource.baseUrl,
        apiKey: selectedResource.apiKey,
        authIndex: selectedResource.authIndex,
        headers: selectedResource.raw.headers,
      });
      setModels(next);
      setDiscovery({
        state: 'success',
        message: t('provider_workbench.models_loaded', {
          count: next.length,
          defaultValue: 'Loaded {{count}} models',
        }),
      });
    } catch (err) {
      setDiscovery({ state: 'error', message: getErrorMessage(err) });
    }
  }, [selectedResource, t]);

  const testCodex = useCallback(async () => {
    if (!selectedResource || selectedResource.brand !== 'codex') return;
    setConnectivity({ state: 'loading', message: '' });
    try {
      await providersApi.testConnectivity({
        brand: 'codex',
        baseUrl: selectedResource.baseUrl,
        apiKey: selectedResource.apiKey,
        authIndex: selectedResource.authIndex,
        headers: selectedResource.raw.headers,
        model: pickDefaultModel(selectedResource),
      });
      setConnectivity({
        state: 'success',
        message: t('provider_workbench.codex_test_success', {
          defaultValue: 'Codex connectivity test passed',
        }),
      });
    } catch (err) {
      setConnectivity({ state: 'error', message: getErrorMessage(err) });
    }
  }, [selectedResource, t]);

  const toggleDisableCooling = useCallback(async () => {
    if (!selectedResource) return;
    const nextValue = !selectedResource.disableCooling;
    try {
      await workbench.setDisableCooling(selectedResource, nextValue);
    } catch (err) {
      setConnectivity({ state: 'error', message: getErrorMessage(err) });
    }
  }, [selectedResource, workbench]);

  if (workbench.isPending && !workbench.snapshot) {
    return (
      <div className={styles.page}>
        <Skeleton style={{ minHeight: 112 }} />
        <Skeleton style={{ minHeight: 360 }} />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.titleBlock}>
          <p className={styles.eyebrow}>
            {t('provider_workbench.eyebrow', { defaultValue: 'Beta' })}
          </p>
          <h1 className={styles.title}>
            {t('provider_workbench.title', { defaultValue: 'Provider Workbench' })}
          </h1>
          <p className={styles.description}>
            {t('provider_workbench.description', {
              defaultValue:
                'Inspect provider resources, discover models, and run targeted Codex connectivity checks without replacing the existing provider pages.',
            })}
          </p>
        </div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={refresh}
          loading={workbench.isFetching}
          leftIcon={<IconRefreshCw size={16} />}
        >
          {t('common.refresh')}
        </Button>
      </header>

      <div className={styles.metaBar}>
        <Badge variant="info" icon={<IconSlidersHorizontal size={14} />}>
          {t('provider_workbench.resource_count', {
            count: totals.resources,
            defaultValue: '{{count}} resources',
          })}
        </Badge>
        <Badge variant="success" icon={<IconCheck size={14} />}>
          {t('provider_workbench.active_count', {
            count: totals.active,
            defaultValue: '{{count}} active',
          })}
        </Badge>
        <Badge variant="neutral">
          {t('provider_workbench.family_count', {
            count: totals.families,
            defaultValue: '{{count}} families',
          })}
        </Badge>
        {workbench.snapshot && (
          <Badge variant="neutral" mono>
            {formatTime(workbench.snapshot.fetchedAt, i18n.language)}
          </Badge>
        )}
      </div>

      {workbench.errorMessage && (
        <div className={`${styles.message} ${styles.messageError}`} role="alert">
          {workbench.errorMessage}
        </div>
      )}

      <div className={styles.layout}>
        <nav className={styles.brandList} aria-label="Provider families">
          {PROVIDER_BRAND_ORDER.map((brand) => {
            const group = groups.find((item) => item.id === brand);
            const descriptor = group?.descriptor;
            const active = activeBrand === brand;
            return (
              <button
                key={brand}
                type="button"
                className={`${styles.brandButton} ${active ? styles.brandButtonActive : ''}`}
                onClick={() => {
                  setActiveBrand(brand);
                  setSelectedId('');
                  setModels([]);
                  setDiscovery({ state: 'idle', message: '' });
                  setConnectivity({ state: 'idle', message: '' });
                }}
              >
                <span>
                  <span className={styles.brandName}>{descriptor?.label ?? brand}</span>
                  <span className={styles.brandDesc}>{descriptor?.description ?? brand}</span>
                </span>
                <Badge size="sm" appearance="outline">
                  {group?.resources.length ?? 0}
                </Badge>
              </button>
            );
          })}
        </nav>

        <main className={styles.mainColumn}>
          <section className={styles.resourcePanel}>
            <div className={styles.toolbar}>
              <input
                className={styles.searchInput}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder={t('provider_workbench.search', {
                  defaultValue: 'Search providers',
                })}
                aria-label={t('provider_workbench.search', {
                  defaultValue: 'Search providers',
                })}
              />
              <Badge variant={activeGroup?.descriptor.supportsModelDiscovery ? 'info' : 'neutral'}>
                {activeGroup?.descriptor.supportsModelDiscovery
                  ? t('provider_workbench.discovery_supported', {
                      defaultValue: 'Model discovery',
                    })
                  : t('provider_workbench.discovery_not_supported', {
                      defaultValue: 'Discovery unavailable',
                    })}
              </Badge>
            </div>

            {filteredResources.length ? (
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>{t('common.status')}</th>
                      <th>{t('provider_workbench.resource', { defaultValue: 'Resource' })}</th>
                      <th>{t('common.base_url')}</th>
                      <th>{t('common.prefix')}</th>
                      <th>{t('provider_workbench.models', { defaultValue: 'Models' })}</th>
                      <th>{t('provider_workbench.cooling', { defaultValue: 'Cooling' })}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredResources.map((resource) => (
                      <tr key={resource.id}>
                        <td>
                          <Badge
                            variant={resource.disabled ? 'warning' : 'success'}
                            appearance="outline"
                          >
                            {resource.disabled
                              ? t('ai_providers.config_disabled_badge')
                              : t('common.connected_status')}
                          </Badge>
                        </td>
                        <td>
                          <button
                            type="button"
                            className={styles.resourceButton}
                            onClick={() => {
                              setSelectedId(resource.id);
                              setModels([]);
                              setDiscovery({ state: 'idle', message: '' });
                              setConnectivity({ state: 'idle', message: '' });
                            }}
                          >
                            {resource.name}
                          </button>
                          {resource.apiKeyPreview && (
                            <div className={styles.mono}>{resource.apiKeyPreview}</div>
                          )}
                        </td>
                        <td className={styles.mono}>{resource.baseUrl || t('common.not_set')}</td>
                        <td>{resource.prefix || t('common.not_set')}</td>
                        <td>{resource.models.length}</td>
                        <td>
                          {resource.disableCooling
                            ? t('provider_workbench.disable_cooling_on', {
                                defaultValue: 'Disabled',
                              })
                            : t('provider_workbench.disable_cooling_off', {
                                defaultValue: 'Normal',
                              })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className={styles.empty}>
                <EmptyState
                  icon={<IconSearch size={32} />}
                  title={t('provider_workbench.empty_title', {
                    defaultValue: 'No provider resources',
                  })}
                  description={t('provider_workbench.empty_desc', {
                    defaultValue: 'Refresh or adjust the search filter.',
                  })}
                />
              </div>
            )}
          </section>

          {selectedResource && (
            <section className={styles.detailPanel}>
              <div className={styles.detailSection}>
                <h2 className={styles.sectionTitle}>
                  {t('provider_workbench.resource_detail', {
                    defaultValue: 'Resource detail',
                  })}
                </h2>
                <div className={styles.detailGrid}>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('common.base_url')}</span>
                    <span className={`${styles.fieldValue} ${styles.mono}`}>
                      {selectedResource.baseUrl || t('common.not_set')}
                    </span>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Auth index</span>
                    <span className={styles.fieldValue}>
                      {selectedResource.authIndex || t('common.not_set')}
                    </span>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>{t('common.priority')}</span>
                    <span className={styles.fieldValue}>{selectedResource.priority}</span>
                  </div>
                  <div className={styles.field}>
                    <span className={styles.fieldLabel}>Headers</span>
                    <span className={styles.fieldValue}>{selectedResource.headerCount}</span>
                  </div>
                </div>

                {selectedResource.apiKey && (
                  <SensitiveValueField
                    label={t('common.api_key')}
                    value={selectedResource.apiKey}
                    revealLabel={t('provider_workbench.reveal_secret', {
                      defaultValue: 'Reveal secret',
                    })}
                    hideLabel={t('provider_workbench.hide_secret', {
                      defaultValue: 'Hide secret',
                    })}
                    copyLabel={t('common.copy')}
                    copiedLabel={t('common.success')}
                    emptyLabel={t('common.not_set')}
                  />
                )}

                <div className={styles.modelList}>
                  {selectedResource.models.slice(0, 16).map((model) => (
                    <Badge key={model} appearance="outline" mono>
                      {model}
                    </Badge>
                  ))}
                  {selectedResource.models.length > 16 && (
                    <Badge appearance="outline">+{selectedResource.models.length - 16}</Badge>
                  )}
                </div>
              </div>

              <div className={styles.detailSection}>
                <h2 className={styles.sectionTitle}>
                  {t('provider_workbench.actions', { defaultValue: 'Actions' })}
                </h2>
                <div className={styles.actions}>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void discoverModels()}
                    loading={discovery.state === 'loading'}
                    disabled={!activeGroup?.descriptor.supportsModelDiscovery}
                  >
                    {t('provider_workbench.discover_models', {
                      defaultValue: 'Discover models',
                    })}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => void testCodex()}
                    loading={connectivity.state === 'loading'}
                    disabled={selectedResource.brand !== 'codex'}
                  >
                    {t('provider_workbench.test_codex', {
                      defaultValue: 'Test Codex',
                    })}
                  </Button>
                  <Button
                    type="button"
                    variant={selectedResource.disableCooling ? 'warning' : 'secondary'}
                    size="sm"
                    onClick={() => void toggleDisableCooling()}
                    loading={workbench.mutatingResourceId === selectedResource.id}
                    disabled={!activeGroup?.descriptor.supportsDisableCooling}
                  >
                    {selectedResource.disableCooling
                      ? t('provider_workbench.enable_cooling', {
                          defaultValue: 'Restore cooling',
                        })
                      : t('provider_workbench.disable_cooling', {
                          defaultValue: 'Disable cooling',
                        })}
                  </Button>
                </div>

                {discovery.message && (
                  <div
                    className={`${styles.message} ${
                      discovery.state === 'error' ? styles.messageError : ''
                    }`}
                    role={discovery.state === 'error' ? 'alert' : 'status'}
                  >
                    {discovery.state === 'error' && <IconCircleAlert size={15} />} {discovery.message}
                  </div>
                )}

                {models.length > 0 && (
                  <div className={styles.discoveryList}>
                    {models.map((model) => (
                      <Badge key={model.name} appearance="outline" mono>
                        {model.alias ? `${model.name} -> ${model.alias}` : model.name}
                      </Badge>
                    ))}
                  </div>
                )}

                {connectivity.message && (
                  <div
                    className={`${styles.message} ${
                      connectivity.state === 'error' ? styles.messageError : ''
                    }`}
                    role={connectivity.state === 'error' ? 'alert' : 'status'}
                  >
                    {connectivity.state === 'error' && <IconCircleAlert size={15} />}{' '}
                    {connectivity.message}
                  </div>
                )}
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
