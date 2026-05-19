import {
  useCallback,
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { animate } from 'motion/mini';
import type { AnimationPlaybackControlsWithThen } from 'motion-dom';
import { useInterval } from '@/hooks/useInterval';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  IconFilterAll,
  IconInfo,
  IconMinus,
  IconPlus,
  IconRefreshCw,
  IconSlidersHorizontal,
  IconUploadCloud,
} from '@/components/ui/icons';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { copyToClipboard } from '@/utils/clipboard';
import {
  MAX_CARD_PAGE_SIZE,
  MIN_CARD_PAGE_SIZE,
  QUOTA_PROVIDER_TYPES,
  clampCardPageSize,
  getAuthFileIcon,
  getTypeColor,
  getTypeLabel,
  hasAuthFileStatusMessage,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  parsePriorityValue,
  type QuotaProviderType,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { AuthFileCard } from '@/features/authFiles/components/AuthFileCard';
import { AuthFileModelsModal } from '@/features/authFiles/components/AuthFileModelsModal';
import { AuthFilesPrefixProxyEditorModal } from '@/features/authFiles/components/AuthFilesPrefixProxyEditorModal';
import { OAuthExcludedCard } from '@/features/authFiles/components/OAuthExcludedCard';
import { OAuthModelAliasCard } from '@/features/authFiles/components/OAuthModelAliasCard';
import { useAuthFilesData } from '@/features/authFiles/hooks/useAuthFilesData';
import { useAuthFilesModels } from '@/features/authFiles/hooks/useAuthFilesModels';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { useAuthFilesPrefixProxyEditor } from '@/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';
import { useAuthFilesStatusBarCache } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import { useCodexAuthFileSnapshots } from '@/features/authFiles/hooks/useCodexAuthFileSnapshots';
import {
  isAuthFilesSortMode,
  readAuthFilesUiState,
  readPersistedAuthFilesCompactMode,
  writeAuthFilesUiState,
  writePersistedAuthFilesCompactMode,
  type AuthFilesSortMode,
} from '@/features/authFiles/uiState';
import {
  bootstrapAuthFilesManualExpiry,
  formatDateInputValue,
  formatManualExpiryFullDate,
  formatTimeInputValue,
  getDefaultManualExpiryMs,
  getManualExpiryMs,
  parseManualExpiryInput,
  readAuthFilesManualExpiry,
  writeAuthFilesManualExpiry,
  type AuthFilesManualExpiryMap,
} from '@/features/authFiles/manualExpiry';
import {
  analyzeCodexPriorityRotation,
  normalizePriorityRotationActiveSlotLimit,
  normalizePriorityRotationThresholdPercent,
  type PriorityRotationAnalysis,
  type PriorityRotationChange,
} from '@/features/authFiles/priorityRotation';
import {
  priorityRotationSidecarApi,
  type PriorityRotationSidecarSettings,
  type PriorityRotationSidecarStatus,
} from '@/services/api/priorityRotationSidecar';
import { useAuthStore, useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import {
  compareCodexMinRemainingPercentAsc,
  getCodexFiveHourRemainingPercent,
  getCodexMinRemainingPercent,
  isCodexFile,
  isDisabledAuthFile,
  normalizePlanType,
  resolveCodexPlanType,
} from '@/utils/quota';
import { normalizeApiBase } from '@/utils/connection';
import styles from './AuthFilesPage.module.scss';

const easePower3Out = (progress: number) => 1 - (1 - progress) ** 4;
const easePower2In = (progress: number) => progress ** 3;
const BATCH_BAR_BASE_TRANSFORM = 'translateX(-50%)';
const BATCH_BAR_HIDDEN_TRANSFORM = 'translateX(-50%) translateY(56px)';
const DEFAULT_REGULAR_PAGE_SIZE = 9;
const DEFAULT_COMPACT_PAGE_SIZE = 12;
const PRIORITY_ROTATION_THRESHOLD_STEP = 5;
const PRIORITY_ROTATION_SLOT_STEP = 1;
const PRIORITY_ROTATION_SIDECAR_INTERVAL_STEP = 1;

const escapeWildcardSearchSegment = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildWildcardSearch = (value: string): RegExp | null => {
  if (!value.includes('*')) return null;
  const pattern = value.split('*').map(escapeWildcardSearchSegment).join('.*');
  return new RegExp(pattern, 'i');
};

const comparePriorityThenName = (a: AuthFileItem, b: AuthFileItem): number => {
  const pa = parsePriorityValue(a.priority ?? a['priority']) ?? 0;
  const pb = parsePriorityValue(b.priority ?? b['priority']) ?? 0;
  const priorityCompare = pb - pa;
  return priorityCompare !== 0 ? priorityCompare : a.name.localeCompare(b.name);
};

const getPrioritySortValue = (file: AuthFileItem): number =>
  parsePriorityValue(file.priority ?? file['priority']) ?? 0;

const formatPriorityRotationPercent = (value: number): string => `${Math.round(value)}%`;
const formatPriorityRotationPriority = (value: number | null): string =>
  value === null ? '-' : `P${value}`;
const getAuthFileDisplayName = (file: AuthFileItem): string => {
  const note = typeof file.note === 'string' ? file.note.trim() : '';
  return note || file.name;
};
const formatNullableDateTime = (value: string | null | undefined): string => {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString();
};
const normalizePriorityRotationSidecarInterval = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 5;
  return Math.max(1, Math.min(180, Math.round(numeric)));
};
type AuthFilePriorityTier = 'active' | 'standby' | 'buffer';
type PriorityRotationTierDetailItem = {
  name: string;
  displayName: string;
  priorityLabel: string;
  planLabel: string;
  fiveHourRemaining: number | null;
  fiveHourRemainingLabel: string;
  minRemaining: number | null;
  minRemainingLabel: string;
  resetLabel: string;
  subscriptionLabel: string;
  quotaStatusLabel: string;
  quotaStatusTone: 'ready' | 'warning' | 'muted';
};
type PriorityRotationSidecarDraftSettings = Pick<
  PriorityRotationSidecarSettings,
  'enabled' | 'thresholdPercent' | 'activeSlotLimit' | 'checkIntervalMinutes'
>;
type PriorityRotationSidecarSaveOptions = {
  notifyError?: boolean;
  committedDraftOnly?: boolean;
  forceDraft?: boolean;
  autoSave?: boolean;
};

const DEFAULT_PRIORITY_ROTATION_SIDECAR_DRAFT: PriorityRotationSidecarDraftSettings = {
  enabled: false,
  thresholdPercent: 50,
  activeSlotLimit: 5,
  checkIntervalMinutes: 5,
};

const pickPriorityRotationSidecarDraft = (
  settings: PriorityRotationSidecarSettings
): PriorityRotationSidecarDraftSettings => ({
  enabled: settings.enabled === true,
  thresholdPercent: normalizePriorityRotationThresholdPercent(settings.thresholdPercent),
  activeSlotLimit: normalizePriorityRotationActiveSlotLimit(settings.activeSlotLimit),
  checkIntervalMinutes: normalizePriorityRotationSidecarInterval(settings.checkIntervalMinutes),
});

const isPriorityRotationSidecarDraftDirty = (
  draft: PriorityRotationSidecarDraftSettings,
  saved: PriorityRotationSidecarSettings | null | undefined
): boolean => {
  if (!saved) return false;
  return (
    draft.enabled !== saved.enabled ||
    draft.thresholdPercent !== saved.thresholdPercent ||
    draft.activeSlotLimit !== saved.activeSlotLimit ||
    draft.checkIntervalMinutes !== saved.checkIntervalMinutes
  );
};

export function AuthFilesPage() {
  const { t } = useTranslation();
  const showNotification = useNotificationStore((state) => state.showNotification);
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const resolvedTheme: ResolvedTheme = useThemeStore((state) => state.resolvedTheme);
  const codexQuota = useQuotaStore((state) => state.codexQuota);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;
  const navigate = useNavigate();

  const [filter, setFilter] = useState<'all' | string>('all');
  const [problemOnly, setProblemOnly] = useState(false);
  const [disabledOnly, setDisabledOnly] = useState(false);
  const [enabledOnly, setEnabledOnly] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSizeByMode, setPageSizeByMode] = useState({
    regular: DEFAULT_REGULAR_PAGE_SIZE,
    compact: DEFAULT_COMPACT_PAGE_SIZE,
  });
  const [pageSizeInput, setPageSizeInput] = useState('9');
  const [viewMode, setViewMode] = useState<'diagram' | 'list'>('list');
  const [sortMode, setSortMode] = useState<AuthFilesSortMode>('default');
  const [batchActionBarVisible, setBatchActionBarVisible] = useState(false);
  const [batchPriorityInput, setBatchPriorityInput] = useState('');
  const [manualExpiryByFile, setManualExpiryByFile] = useState<AuthFilesManualExpiryMap>(() =>
    readAuthFilesManualExpiry()
  );
  const [manualExpiryEditorFile, setManualExpiryEditorFile] = useState<AuthFileItem | null>(null);
  const [manualExpiryDateInput, setManualExpiryDateInput] = useState('');
  const [manualExpiryTimeInput, setManualExpiryTimeInput] = useState('');
  const [priorityRotationSettings, setPriorityRotationSettings] =
    useState<PriorityRotationSidecarDraftSettings>(DEFAULT_PRIORITY_ROTATION_SIDECAR_DRAFT);
  const [priorityRotationThresholdInput, setPriorityRotationThresholdInput] = useState(() =>
    String(priorityRotationSettings.thresholdPercent)
  );
  const [priorityRotationSlotsInput, setPriorityRotationSlotsInput] = useState(() =>
    String(priorityRotationSettings.activeSlotLimit)
  );
  const [priorityRotationPreview, setPriorityRotationPreview] =
    useState<PriorityRotationAnalysis | null>(null);
  const [priorityRotationDetailTier, setPriorityRotationDetailTier] =
    useState<AuthFilePriorityTier | null>(null);
  const [priorityRotationSidecarStatus, setPriorityRotationSidecarStatus] =
    useState<PriorityRotationSidecarStatus | null>(null);
  const [priorityRotationSidecarLoading, setPriorityRotationSidecarLoading] = useState(false);
  const [priorityRotationSidecarSaving, setPriorityRotationSidecarSaving] = useState(false);
  const [priorityRotationSidecarAutoSaving, setPriorityRotationSidecarAutoSaving] = useState(false);
  const [priorityRotationSidecarIntervalInput, setPriorityRotationSidecarIntervalInput] =
    useState('5');
  const [priorityRotationSidecarError, setPriorityRotationSidecarError] = useState('');
  const [uploadDropActive, setUploadDropActive] = useState(false);
  const [uiStateHydrated, setUiStateHydrated] = useState(false);
  const floatingBatchActionsRef = useRef<HTMLDivElement>(null);
  const batchActionAnimationRef = useRef<AnimationPlaybackControlsWithThen | null>(null);
  const previousSelectionCountRef = useRef(0);
  const selectionCountRef = useRef(0);
  const loadedFilesOnceRef = useRef(false);
  const filesLengthRef = useRef(0);
  const priorityRotationSidecarDraftTouchedRef = useRef(false);
  const priorityRotationSidecarAutoSaveSignatureRef = useRef('');
  const priorityRotationSidecarAutoSaveFailedAtRef = useRef(0);
  const priorityRotationSidecarStatusRequestIdRef = useRef(0);

  const {
    files,
    selectedFiles,
    selectionCount,
    loading,
    error,
    uploading,
    uploadProgress,
    deleting,
    deletingAll,
    statusUpdating,
    batchStatusUpdating,
    priorityUpdating,
    batchPriorityUpdating,
    noteUpdating,
    fileInputRef,
    loadFiles,
    uploadAuthFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDeleteAll,
    handleDownload,
    handleStatusToggle,
    handlePriorityChange: saveAuthFilePriority,
    handleDisplayNameChange,
    toggleSelect,
    selectAllVisible,
    invertVisibleSelection,
    deselectAll,
    batchDownload,
    batchSetStatus,
    batchSetPriority,
    batchSetPriorities,
    batchDelete,
  } = useAuthFilesData();

  const statusBarCache = useAuthFilesStatusBarCache(files);

  useEffect(() => {
    filesLengthRef.current = files.length;
  }, [files.length]);

  const {
    excluded,
    excludedError,
    modelAlias,
    modelAliasError,
    allProviderModels,
    loadExcluded,
    loadModelAlias,
    deleteExcluded,
    deleteModelAlias,
    handleMappingUpdate,
    handleDeleteLink,
    handleToggleFork,
    handleRenameAlias,
    handleDeleteAlias,
  } = useAuthFilesOauth({ viewMode, files });

  const {
    modelsModalOpen,
    modelsLoading,
    modelsList,
    modelsFileName,
    modelsFileType,
    modelsError,
    showModels,
    closeModelsModal,
  } = useAuthFilesModels();

  const {
    prefixProxyEditor,
    prefixProxyUpdatedText,
    prefixProxyDirty,
    openPrefixProxyEditor,
    closePrefixProxyEditor,
    handlePrefixProxyChange,
    handlePrefixProxySave,
  } = useAuthFilesPrefixProxyEditor({
    disableControls: connectionStatus !== 'connected',
    loadFiles,
  });

  const disableControls = connectionStatus !== 'connected';
  const uploadDropDisabled = disableControls || uploading;
  const normalizedFilter = normalizeProviderKey(String(filter));
  const quotaFilterType: QuotaProviderType | null = QUOTA_PROVIDER_TYPES.has(
    normalizedFilter as QuotaProviderType
  )
    ? (normalizedFilter as QuotaProviderType)
    : null;
  const pageSize = compactMode ? pageSizeByMode.compact : pageSizeByMode.regular;
  const priorityRotationEffectiveThresholdPercent = priorityRotationThresholdInput.trim()
    ? normalizePriorityRotationThresholdPercent(priorityRotationThresholdInput)
    : priorityRotationSettings.thresholdPercent;
  const priorityRotationEffectiveActiveSlotLimit = priorityRotationSlotsInput.trim()
    ? normalizePriorityRotationActiveSlotLimit(priorityRotationSlotsInput)
    : priorityRotationSettings.activeSlotLimit;
  const priorityRotationAnalysis = useMemo(
    () =>
      analyzeCodexPriorityRotation(
        files,
        codexQuota,
        priorityRotationEffectiveThresholdPercent,
        priorityRotationEffectiveActiveSlotLimit
      ),
    [
      codexQuota,
      files,
      priorityRotationEffectiveActiveSlotLimit,
      priorityRotationEffectiveThresholdPercent,
    ]
  );
  const priorityRotationSidecarSettings = priorityRotationSidecarStatus?.settings ?? null;
  const priorityRotationSidecarCommittedDraftDirty = useMemo(() => {
    if (!priorityRotationSidecarSettings) return false;
    if (isPriorityRotationSidecarDraftDirty(priorityRotationSettings, priorityRotationSidecarSettings)) {
      return true;
    }
    return normalizeApiBase(apiBase) !== normalizeApiBase(priorityRotationSidecarSettings.apiBase);
  }, [apiBase, priorityRotationSettings, priorityRotationSidecarSettings]);
  const priorityRotationSidecarInputDraftDirty = useMemo(() => {
    if (!priorityRotationSidecarSettings) return false;
    return (
      priorityRotationThresholdInput.trim() !==
        String(priorityRotationSettings.thresholdPercent) ||
      priorityRotationSlotsInput.trim() !==
        String(priorityRotationSettings.activeSlotLimit) ||
      priorityRotationSidecarIntervalInput.trim() !==
        String(priorityRotationSettings.checkIntervalMinutes)
    );
  }, [
    priorityRotationSettings,
    priorityRotationSidecarIntervalInput,
    priorityRotationSidecarSettings,
    priorityRotationSlotsInput,
    priorityRotationThresholdInput,
  ]);
  const priorityRotationSidecarDraftDirty =
    priorityRotationSidecarCommittedDraftDirty || priorityRotationSidecarInputDraftDirty;

  useEffect(() => {
    if (priorityRotationSidecarSettings && !priorityRotationSidecarDraftDirty) {
      priorityRotationSidecarDraftTouchedRef.current = false;
    }
  }, [priorityRotationSidecarDraftDirty, priorityRotationSidecarSettings]);
  const priorityTierByFile = useMemo(() => {
    const tiers = new Map<string, AuthFilePriorityTier>();
    files.forEach((file) => {
      const priority = parsePriorityValue(file.priority ?? file['priority']) ?? 0;
      if (priorityRotationAnalysis.activePriority === priority) {
        tiers.set(file.name, 'active');
      } else if (priorityRotationAnalysis.standbyPriority === priority) {
        tiers.set(file.name, 'standby');
      } else if (priorityRotationAnalysis.reservePriority === priority) {
        tiers.set(file.name, 'buffer');
      }
    });
    return tiers;
  }, [
    files,
    priorityRotationAnalysis.activePriority,
    priorityRotationAnalysis.reservePriority,
    priorityRotationAnalysis.standbyPriority,
  ]);

  const stopUploadDropEvent = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const hasDraggedFiles = (event: DragEvent<HTMLElement>) =>
    Array.from(event.dataTransfer.types).includes('Files');

  const handleUploadPoolClick = useCallback(() => {
    if (uploadDropDisabled) return;
    handleUploadClick();
  }, [handleUploadClick, uploadDropDisabled]);

  const handleUploadPoolKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (uploadDropDisabled || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      handleUploadClick();
    },
    [handleUploadClick, uploadDropDisabled]
  );

  const handleUploadPoolDragEnter = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      stopUploadDropEvent(event);
      if (!uploadDropDisabled && hasDraggedFiles(event)) {
        setUploadDropActive(true);
      }
    },
    [uploadDropDisabled]
  );

  const handleUploadPoolDragOver = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      stopUploadDropEvent(event);
      event.dataTransfer.dropEffect = uploadDropDisabled ? 'none' : 'copy';
      if (!uploadDropDisabled && hasDraggedFiles(event)) {
        setUploadDropActive(true);
      }
    },
    [uploadDropDisabled]
  );

  const handleUploadPoolDragLeave = useCallback((event: DragEvent<HTMLDivElement>) => {
    stopUploadDropEvent(event);
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setUploadDropActive(false);
  }, []);

  const handleUploadPoolDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      stopUploadDropEvent(event);
      setUploadDropActive(false);
      if (uploadDropDisabled) return;

      const droppedFiles = Array.from(event.dataTransfer.files);
      await uploadAuthFiles(droppedFiles);
    },
    [uploadAuthFiles, uploadDropDisabled]
  );

  useEffect(() => {
    setManualExpiryByFile(bootstrapAuthFilesManualExpiry());

    const persistedCompactMode = readPersistedAuthFilesCompactMode();
    if (typeof persistedCompactMode === 'boolean') {
      setCompactMode(persistedCompactMode);
    }

    const persisted = readAuthFilesUiState();
    if (persisted) {
      if (typeof persisted.filter === 'string' && persisted.filter.trim()) {
        setFilter(persisted.filter);
      }
      if (typeof persisted.problemOnly === 'boolean') {
        setProblemOnly(persisted.problemOnly);
      }
      const persistedDisabledOnly = persisted.disabledOnly === true;
      const persistedEnabledOnly = persisted.enabledOnly === true && !persistedDisabledOnly;
      setDisabledOnly(persistedDisabledOnly);
      setEnabledOnly(persistedEnabledOnly);
      if (typeof persistedCompactMode !== 'boolean' && typeof persisted.compactMode === 'boolean') {
        setCompactMode(persisted.compactMode);
      }
      if (typeof persisted.search === 'string') {
        setSearch(persisted.search);
      }
      if (typeof persisted.page === 'number' && Number.isFinite(persisted.page)) {
        setPage(Math.max(1, Math.round(persisted.page)));
      }
      const legacyPageSize =
        typeof persisted.pageSize === 'number' && Number.isFinite(persisted.pageSize)
          ? clampCardPageSize(persisted.pageSize)
          : null;
      const regularPageSize =
        typeof persisted.regularPageSize === 'number' && Number.isFinite(persisted.regularPageSize)
          ? clampCardPageSize(persisted.regularPageSize)
          : (legacyPageSize ?? DEFAULT_REGULAR_PAGE_SIZE);
      const compactPageSize =
        typeof persisted.compactPageSize === 'number' && Number.isFinite(persisted.compactPageSize)
          ? clampCardPageSize(persisted.compactPageSize)
          : (legacyPageSize ?? DEFAULT_COMPACT_PAGE_SIZE);
      setPageSizeByMode({
        regular: regularPageSize,
        compact: compactPageSize,
      });
      if (isAuthFilesSortMode(persisted.sortMode)) {
        setSortMode(persisted.sortMode);
      }
    }

    setUiStateHydrated(true);
  }, []);

  useEffect(() => {
    if (!uiStateHydrated) return;

    writeAuthFilesUiState({
      filter,
      problemOnly,
      disabledOnly,
      enabledOnly,
      compactMode,
      search,
      page,
      pageSize,
      regularPageSize: pageSizeByMode.regular,
      compactPageSize: pageSizeByMode.compact,
      sortMode,
    });
    writePersistedAuthFilesCompactMode(compactMode);
  }, [
    compactMode,
    disabledOnly,
    enabledOnly,
    filter,
    page,
    pageSize,
    pageSizeByMode,
    problemOnly,
    search,
    sortMode,
    uiStateHydrated,
  ]);

  useEffect(() => {
    setPageSizeInput(String(pageSize));
  }, [pageSize]);

  const setCurrentModePageSize = useCallback(
    (next: number) => {
      setPageSizeByMode((current) =>
        compactMode ? { ...current, compact: next } : { ...current, regular: next }
      );
    },
    [compactMode]
  );

  const commitPageSizeInput = (rawValue: string) => {
    const trimmed = rawValue.trim();
    if (!trimmed) {
      setPageSizeInput(String(pageSize));
      return;
    }

    const value = Number(trimmed);
    if (!Number.isFinite(value)) {
      setPageSizeInput(String(pageSize));
      return;
    }

    const next = clampCardPageSize(value);
    setCurrentModePageSize(next);
    setPageSizeInput(String(next));
    setPage(1);
  };

  const handlePageSizeChange = (event: ChangeEvent<HTMLInputElement>) => {
    const rawValue = event.currentTarget.value;
    setPageSizeInput(rawValue);

    const trimmed = rawValue.trim();
    if (!trimmed) return;

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return;

    const rounded = Math.round(parsed);
    if (rounded < MIN_CARD_PAGE_SIZE || rounded > MAX_CARD_PAGE_SIZE) return;

    setCurrentModePageSize(rounded);
    setPage(1);
  };

  const handleSortModeChange = useCallback(
    (value: string) => {
      if (!isAuthFilesSortMode(value) || value === sortMode) return;
      setSortMode(value);
      setPage(1);
    },
    [sortMode]
  );

  const handleHeaderRefresh = useCallback(async () => {
    await Promise.all([
      loadFiles({ preserveExisting: true, silent: files.length > 0 }),
      loadExcluded(),
      loadModelAlias(),
    ]);
  }, [files.length, loadFiles, loadExcluded, loadModelAlias]);

  useHeaderRefresh(handleHeaderRefresh);

  useEffect(() => {
    if (!isCurrentLayer) return;
    const preserveExisting = loadedFilesOnceRef.current || filesLengthRef.current > 0;
    loadedFilesOnceRef.current = true;
    loadFiles({ preserveExisting, silent: preserveExisting });
    loadExcluded();
    loadModelAlias();
  }, [isCurrentLayer, loadFiles, loadExcluded, loadModelAlias]);

  useInterval(
    () => {
      void loadFiles({ preserveExisting: true, silent: true }).catch(() => {});
    },
    isCurrentLayer ? 240_000 : null
  );

  const existingTypes = useMemo(() => {
    const types = new Set<string>(['all']);
    files.forEach((file) => {
      if (file.type) {
        types.add(file.type);
      }
    });
    return Array.from(types);
  }, [files]);

  const filesMatchingStatusFilters = useMemo(
    () =>
      files.filter((file) => {
        if (problemOnly && !hasAuthFileStatusMessage(file)) return false;
        if (disabledOnly && file.disabled !== true) return false;
        if (enabledOnly && file.disabled === true) return false;
        return true;
      }),
    [disabledOnly, enabledOnly, files, problemOnly]
  );

  const sortOptions = useMemo(
    () => [
      { value: 'default', label: t('auth_files.sort_default') },
      { value: 'az', label: t('auth_files.sort_az') },
      { value: 'priority', label: t('auth_files.sort_priority') },
      { value: 'expiry_soon', label: t('auth_files.sort_expiry_soon') },
      { value: 'expiry_long', label: t('auth_files.sort_expiry_long') },
    ],
    [t]
  );

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: filesMatchingStatusFilters.length };
    filesMatchingStatusFilters.forEach((file) => {
      if (!file.type) return;
      counts[file.type] = (counts[file.type] || 0) + 1;
    });
    return counts;
  }, [filesMatchingStatusFilters]);

  const normalizedSearch = search.trim();
  const wildcardSearch = useMemo(() => buildWildcardSearch(normalizedSearch), [normalizedSearch]);

  const filtered = useMemo(() => {
    const normalizedTerm = normalizedSearch.toLowerCase();

    return filesMatchingStatusFilters.filter((item) => {
      const matchType = filter === 'all' || item.type === filter;
      const matchSearch =
        !normalizedSearch ||
        [item.name, item.type, item.provider, item.note].some((value) => {
          const content = (value || '').toString();
          return wildcardSearch
            ? wildcardSearch.test(content)
            : content.toLowerCase().includes(normalizedTerm);
        });
      return matchType && matchSearch;
    });
  }, [filesMatchingStatusFilters, filter, normalizedSearch, wildcardSearch]);
  const codexSnapshotFiles = priorityRotationDetailTier ? files : filtered;
  const { authTokenSnapshots, subscriptionSnapshots: codexSubscriptionSnapshots } =
    useCodexAuthFileSnapshots(codexSnapshotFiles);

  const priorityRotationTierDetailGroups = useMemo(() => {
    const groups: Record<AuthFilePriorityTier, PriorityRotationTierDetailItem[]> = {
      active: [],
      standby: [],
      buffer: [],
    };

    const getPlanLabel = (planType: string | null): string => {
      if (!planType) {
        return t('common.unknown', { defaultValue: '未知' });
      }
      return planType === 'team' ? 'Team' : planType === 'plus' ? 'Plus' : planType.toUpperCase();
    };

    const getQuotaStatusTone = (
      status: CodexQuotaState['status']
    ): PriorityRotationTierDetailItem['quotaStatusTone'] =>
      status === 'success' ? 'ready' : status === 'error' ? 'warning' : 'muted';

    files.forEach((file) => {
      if (!isCodexFile(file) || isDisabledAuthFile(file) || isRuntimeOnlyAuthFile(file)) {
        return;
      }

      const tier = priorityTierByFile.get(file.name);
      if (!tier) return;

      const quota = codexQuota[file.name] as CodexQuotaState | undefined;
      const planType = normalizePlanType(
        quota?.status === 'success'
          ? (quota.planType ?? resolveCodexPlanType(file))
          : resolveCodexPlanType(file)
      );
      const fiveHourRemaining = getCodexFiveHourRemainingPercent(quota);
      const minRemaining = getCodexMinRemainingPercent(quota);
      const fiveHourWindow = quota?.windows.find((window) => window.id === 'five-hour');
      const subscription = codexSubscriptionSnapshots.get(file.name);

      groups[tier].push({
        name: file.name,
        displayName: getAuthFileDisplayName(file),
        priorityLabel: formatPriorityRotationPriority(
          parsePriorityValue(file.priority ?? file['priority']) ?? 0
        ),
        planLabel: getPlanLabel(planType),
        fiveHourRemaining,
        fiveHourRemainingLabel:
          fiveHourRemaining === null
            ? t('auth_files.priority_rotation_detail_quota_unknown', { defaultValue: '额度未知' })
            : formatPriorityRotationPercent(fiveHourRemaining),
        minRemaining,
        minRemainingLabel:
          minRemaining === null
            ? t('auth_files.priority_rotation_detail_quota_unknown', { defaultValue: '额度未知' })
            : formatPriorityRotationPercent(minRemaining),
        resetLabel: fiveHourWindow?.resetLabel ?? '-',
        subscriptionLabel:
          subscription?.subscriptionStatus === 'found'
            ? (subscription.subscriptionActiveUntil ??
              t('common.unknown', { defaultValue: '未知' }))
            : subscription?.subscriptionStatus === 'read_error'
              ? t('auth_files.priority_rotation_detail_subscription_error', {
                  defaultValue: '订阅读取失败',
                })
              : t('auth_files.priority_rotation_detail_subscription_missing', {
                  defaultValue: '未读取',
                }),
        quotaStatusLabel:
          quota?.status === 'loading'
            ? t('common.loading')
            : quota?.status === 'error'
              ? t('common.error')
              : quota?.status === 'success'
                ? t('auth_files.priority_rotation_detail_quota_ready', {
                    defaultValue: '额度就绪',
                  })
                : t('auth_files.priority_rotation_detail_quota_missing', {
                    defaultValue: '未读取',
                  }),
        quotaStatusTone: getQuotaStatusTone(quota?.status ?? 'idle'),
      });
    });

    (Object.keys(groups) as AuthFilePriorityTier[]).forEach((tier) => {
      groups[tier].sort((a, b) => {
        const remainingCompare = compareCodexMinRemainingPercentAsc(a.minRemaining, b.minRemaining);
        if (remainingCompare !== 0) return remainingCompare;
        const priorityCompare = Number(b.priorityLabel.slice(1)) - Number(a.priorityLabel.slice(1));
        if (Number.isFinite(priorityCompare) && priorityCompare !== 0) return priorityCompare;
        return a.name.localeCompare(b.name);
      });
    });

    return groups;
  }, [codexQuota, codexSubscriptionSnapshots, files, priorityTierByFile, t]);

  const sorted = useMemo(() => {
    const originalIndexMap = new Map(filtered.map((file, index) => [file.name, index]));

    const getEffectiveSubscriptionExpiry = (file: AuthFileItem) => {
      const authTokenSnapshot = authTokenSnapshots.get(file.name);
      if (authTokenSnapshot?.hasRefreshToken === false) {
        return authTokenSnapshot.accessTokenExpiresAtMs ?? 0;
      }

      const manualExpiryMs = getManualExpiryMs(manualExpiryByFile, file.name);
      if (manualExpiryMs !== null) return manualExpiryMs;

      const quota = codexQuota[file.name] as CodexQuotaState | undefined;
      const currentPlanType =
        quota?.status === 'success' ? normalizePlanType(quota.planType) : null;
      if (currentPlanType === 'free') return null;
      return codexSubscriptionSnapshots.get(file.name)?.subscriptionActiveUntilMs ?? null;
    };

    const getOriginalIndex = (file: AuthFileItem) =>
      originalIndexMap.get(file.name) ?? Number.MAX_SAFE_INTEGER;

    const compareExpiryTie = (a: AuthFileItem, b: AuthFileItem) => {
      const priorityCompare = getPrioritySortValue(b) - getPrioritySortValue(a);
      if (priorityCompare !== 0) return priorityCompare;

      const remainingCompare = compareCodexMinRemainingPercentAsc(
        getCodexMinRemainingPercent(codexQuota[a.name] as CodexQuotaState | undefined),
        getCodexMinRemainingPercent(codexQuota[b.name] as CodexQuotaState | undefined)
      );
      if (remainingCompare !== 0) return remainingCompare;

      const originalCompare = getOriginalIndex(a) - getOriginalIndex(b);
      return originalCompare !== 0 ? originalCompare : a.name.localeCompare(b.name);
    };

    const copy = [...filtered];
    if (sortMode === 'default') {
      copy.sort((a, b) => {
        const providerA = normalizeProviderKey(String(a.provider ?? a.type ?? 'unknown'));
        const providerB = normalizeProviderKey(String(b.provider ?? b.type ?? 'unknown'));
        const providerCompare = providerA.localeCompare(providerB);
        if (providerCompare !== 0) return providerCompare;
        return a.name.localeCompare(b.name);
      });
    } else if (sortMode === 'az') {
      copy.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === 'priority') {
      copy.sort(comparePriorityThenName);
    } else if (sortMode === 'expiry_soon' || sortMode === 'expiry_long') {
      const direction = sortMode === 'expiry_soon' ? 1 : -1;
      copy.sort((a, b) => {
        const expiryA = getEffectiveSubscriptionExpiry(a);
        const expiryB = getEffectiveSubscriptionExpiry(b);

        if (expiryA === null && expiryB === null) return compareExpiryTie(a, b);
        if (expiryA === null) return 1;
        if (expiryB === null) return -1;

        const expiryCompare = (expiryA - expiryB) * direction;
        return expiryCompare !== 0 ? expiryCompare : compareExpiryTie(a, b);
      });
    }
    return copy;
  }, [
    authTokenSnapshots,
    codexQuota,
    codexSubscriptionSnapshots,
    filtered,
    manualExpiryByFile,
    sortMode,
  ]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const pageItems = sorted.slice(start, start + pageSize);
  const selectablePageItems = useMemo(
    () => pageItems.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [pageItems]
  );
  const selectableFilteredItems = useMemo(
    () => sorted.filter((file) => !isRuntimeOnlyAuthFile(file)),
    [sorted]
  );
  const selectedNames = useMemo(() => Array.from(selectedFiles), [selectedFiles]);
  const selectedHasStatusUpdating = useMemo(
    () => selectedNames.some((name) => statusUpdating[name] === true),
    [selectedNames, statusUpdating]
  );
  const selectedHasPriorityUpdating = useMemo(
    () => selectedNames.some((name) => priorityUpdating[name] === true),
    [priorityUpdating, selectedNames]
  );
  const batchStatusButtonsDisabled =
    disableControls ||
    selectedNames.length === 0 ||
    batchStatusUpdating ||
    selectedHasStatusUpdating;
  const batchPriorityButtonDisabled =
    disableControls ||
    selectedNames.length === 0 ||
    batchPriorityUpdating ||
    selectedHasPriorityUpdating;

  const handlePriorityInvalid = useCallback(() => {
    showNotification(t('auth_files.priority_invalid'), 'error');
  }, [showNotification, t]);

  const handlePriorityChange = useCallback(
    async (item: AuthFileItem, priority: number) => {
      await saveAuthFilePriority(item, priority);
    },
    [saveAuthFilePriority]
  );

  const openManualExpiryEditor = useCallback(
    (file: AuthFileItem) => {
      const expiresAtMs =
        getManualExpiryMs(manualExpiryByFile, file.name) ?? getDefaultManualExpiryMs();
      setManualExpiryEditorFile(file);
      setManualExpiryDateInput(formatDateInputValue(expiresAtMs));
      setManualExpiryTimeInput(formatTimeInputValue(expiresAtMs));
    },
    [manualExpiryByFile]
  );

  const closeManualExpiryEditor = useCallback(() => {
    setManualExpiryEditorFile(null);
    setManualExpiryDateInput('');
    setManualExpiryTimeInput('');
  }, []);

  const saveManualExpiry = useCallback(() => {
    if (!manualExpiryEditorFile) return;

    const expiresAtMs = parseManualExpiryInput(manualExpiryDateInput, manualExpiryTimeInput);
    if (expiresAtMs === null) {
      showNotification(
        t('auth_files.manual_expiry_invalid', { defaultValue: '有效期时间无效' }),
        'error'
      );
      return;
    }

    setManualExpiryByFile((current) => {
      const next = { ...current, [manualExpiryEditorFile.name]: expiresAtMs };
      writeAuthFilesManualExpiry(next);
      return next;
    });
    showNotification(
      t('auth_files.manual_expiry_saved', {
        name: manualExpiryEditorFile.name,
        time: formatManualExpiryFullDate(expiresAtMs),
        defaultValue: '已保存手动有效期',
      }),
      'success'
    );
    closeManualExpiryEditor();
  }, [
    closeManualExpiryEditor,
    manualExpiryDateInput,
    manualExpiryEditorFile,
    manualExpiryTimeInput,
    showNotification,
    t,
  ]);

  const clearManualExpiry = useCallback(() => {
    if (!manualExpiryEditorFile) return;

    setManualExpiryByFile((current) => {
      const next = { ...current };
      delete next[manualExpiryEditorFile.name];
      writeAuthFilesManualExpiry(next);
      return next;
    });
    showNotification(
      t('auth_files.manual_expiry_cleared', {
        name: manualExpiryEditorFile.name,
        defaultValue: '已清除手动有效期',
      }),
      'success'
    );
    closeManualExpiryEditor();
  }, [closeManualExpiryEditor, manualExpiryEditorFile, showNotification, t]);

  useEffect(() => {
    setPriorityRotationThresholdInput(String(priorityRotationSettings.thresholdPercent));
    setPriorityRotationSlotsInput(String(priorityRotationSettings.activeSlotLimit));
  }, [priorityRotationSettings.activeSlotLimit, priorityRotationSettings.thresholdPercent]);

  const updatePriorityRotationSettings = useCallback(
    (updates: Partial<PriorityRotationSidecarDraftSettings>) => {
      priorityRotationSidecarDraftTouchedRef.current = true;
      priorityRotationSidecarAutoSaveSignatureRef.current = '';
      priorityRotationSidecarAutoSaveFailedAtRef.current = 0;
      setPriorityRotationSettings((current) => {
        const nextSettings = {
          ...current,
          ...updates,
        };
        return nextSettings;
      });
      setPriorityRotationPreview(null);
    },
    []
  );

  const commitPriorityRotationThresholdInput = useCallback(
    (value: string) => {
      const thresholdPercent = normalizePriorityRotationThresholdPercent(value);
      setPriorityRotationThresholdInput(String(thresholdPercent));
      updatePriorityRotationSettings({ thresholdPercent });
    },
    [updatePriorityRotationSettings]
  );

  const commitPriorityRotationSlotsInput = useCallback(
    (value: string) => {
      const activeSlotLimit = normalizePriorityRotationActiveSlotLimit(value);
      setPriorityRotationSlotsInput(String(activeSlotLimit));
      updatePriorityRotationSettings({ activeSlotLimit });
    },
    [updatePriorityRotationSettings]
  );

  const commitPriorityRotationSidecarIntervalInput = useCallback(
    (value: string) => {
      const checkIntervalMinutes = normalizePriorityRotationSidecarInterval(value);
      setPriorityRotationSidecarIntervalInput(String(checkIntervalMinutes));
      updatePriorityRotationSettings({ checkIntervalMinutes });
    },
    [updatePriorityRotationSettings]
  );

  const adjustPriorityRotationSlots = useCallback(
    (delta: number) => {
      const raw = priorityRotationSlotsInput.trim();
      const base = raw
        ? normalizePriorityRotationActiveSlotLimit(raw)
        : priorityRotationSettings.activeSlotLimit;
      const activeSlotLimit = normalizePriorityRotationActiveSlotLimit(base + delta);
      setPriorityRotationSlotsInput(String(activeSlotLimit));
      updatePriorityRotationSettings({ activeSlotLimit });
    },
    [
      priorityRotationSettings.activeSlotLimit,
      priorityRotationSlotsInput,
      updatePriorityRotationSettings,
    ]
  );

  const adjustPriorityRotationSidecarInterval = useCallback(
    (delta: number) => {
      const raw = priorityRotationSidecarIntervalInput.trim();
      const base = raw
        ? normalizePriorityRotationSidecarInterval(raw)
        : priorityRotationSettings.checkIntervalMinutes;
      const checkIntervalMinutes = normalizePriorityRotationSidecarInterval(base + delta);
      setPriorityRotationSidecarIntervalInput(String(checkIntervalMinutes));
      updatePriorityRotationSettings({ checkIntervalMinutes });
    },
    [
      priorityRotationSettings.checkIntervalMinutes,
      priorityRotationSidecarIntervalInput,
      updatePriorityRotationSettings,
    ]
  );

  const syncPriorityRotationDraftSettings = useCallback(
    (settings: PriorityRotationSidecarSettings) => {
      const nextDraft = pickPriorityRotationSidecarDraft(settings);
      priorityRotationSidecarDraftTouchedRef.current = false;
      setPriorityRotationSettings(nextDraft);
      setPriorityRotationThresholdInput(String(nextDraft.thresholdPercent));
      setPriorityRotationSlotsInput(String(nextDraft.activeSlotLimit));
      setPriorityRotationSidecarIntervalInput(String(nextDraft.checkIntervalMinutes));
      setPriorityRotationPreview(null);
    },
    []
  );

  const hydratePriorityRotationSidecarStatus = useCallback(
    (status: PriorityRotationSidecarStatus, options: { forceDraft?: boolean } = {}) => {
      setPriorityRotationSidecarStatus(status);
      setPriorityRotationSidecarError('');

      const shouldSyncDraft = options.forceDraft || !priorityRotationSidecarDraftTouchedRef.current;

      if (shouldSyncDraft) {
        syncPriorityRotationDraftSettings(status.settings);
      }
    },
    [syncPriorityRotationDraftSettings]
  );

  const loadPriorityRotationSidecarStatus = useCallback(
    async (silent = false) => {
      const requestId = priorityRotationSidecarStatusRequestIdRef.current + 1;
      priorityRotationSidecarStatusRequestIdRef.current = requestId;
      if (!silent) {
        setPriorityRotationSidecarLoading(true);
      }
      try {
        const status = await priorityRotationSidecarApi.getStatus();
        if (requestId !== priorityRotationSidecarStatusRequestIdRef.current) {
          return;
        }
        hydratePriorityRotationSidecarStatus(status);
      } catch (err) {
        if (requestId !== priorityRotationSidecarStatusRequestIdRef.current) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setPriorityRotationSidecarError(message);
      } finally {
        if (!silent && requestId === priorityRotationSidecarStatusRequestIdRef.current) {
          setPriorityRotationSidecarLoading(false);
        }
      }
    },
    [hydratePriorityRotationSidecarStatus]
  );

  const buildPriorityRotationSidecarSettings = useCallback(
    (
      updates: Partial<PriorityRotationSidecarSettings> = {},
      options: Pick<PriorityRotationSidecarSaveOptions, 'committedDraftOnly'> = {}
    ): Partial<PriorityRotationSidecarSettings> => ({
      enabled: priorityRotationSettings.enabled,
      apiBase: normalizeApiBase(apiBase),
      thresholdPercent: options.committedDraftOnly
        ? priorityRotationSettings.thresholdPercent
        : priorityRotationThresholdInput.trim()
          ? normalizePriorityRotationThresholdPercent(priorityRotationThresholdInput)
          : priorityRotationSettings.thresholdPercent,
      activeSlotLimit: options.committedDraftOnly
        ? priorityRotationSettings.activeSlotLimit
        : priorityRotationSlotsInput.trim()
          ? normalizePriorityRotationActiveSlotLimit(priorityRotationSlotsInput)
          : priorityRotationSettings.activeSlotLimit,
      checkIntervalMinutes: options.committedDraftOnly
        ? priorityRotationSettings.checkIntervalMinutes
        : priorityRotationSidecarIntervalInput.trim()
          ? normalizePriorityRotationSidecarInterval(priorityRotationSidecarIntervalInput)
          : priorityRotationSettings.checkIntervalMinutes,
      ...updates,
    }),
    [
      apiBase,
      priorityRotationSettings.activeSlotLimit,
      priorityRotationSettings.checkIntervalMinutes,
      priorityRotationSettings.enabled,
      priorityRotationSettings.thresholdPercent,
      priorityRotationSidecarIntervalInput,
      priorityRotationSlotsInput,
      priorityRotationThresholdInput,
    ]
  );

  const mergePriorityRotationSidecarResult = useCallback(
    (
      settings: PriorityRotationSidecarSettings,
      state: PriorityRotationSidecarStatus['state'],
      forceDraft = false
    ) => {
      hydratePriorityRotationSidecarStatus(
        {
          ok: true,
          pid: priorityRotationSidecarStatus?.pid ?? 0,
          host: priorityRotationSidecarStatus?.host ?? '127.0.0.1',
          port: priorityRotationSidecarStatus?.port ?? 8318,
          settings,
          state,
        },
        { forceDraft }
      );
    },
    [
      hydratePriorityRotationSidecarStatus,
      priorityRotationSidecarStatus?.host,
      priorityRotationSidecarStatus?.pid,
      priorityRotationSidecarStatus?.port,
    ]
  );

  const savePriorityRotationSidecarSettings = useCallback(
    async (
      updates: Partial<PriorityRotationSidecarSettings> = {},
      notify = true,
      options: PriorityRotationSidecarSaveOptions = {}
    ) => {
      if (!managementKey) {
        showNotification(t('auth_files.priority_rotation_sidecar_missing_login'), 'error');
        return false;
      }
      const setSavingState = options.autoSave
        ? setPriorityRotationSidecarAutoSaving
        : setPriorityRotationSidecarSaving;
      setSavingState(true);
      try {
        const settings = buildPriorityRotationSidecarSettings(updates, {
          committedDraftOnly: options.committedDraftOnly,
        });
        const result = await priorityRotationSidecarApi.updateSettings(settings, managementKey);
        mergePriorityRotationSidecarResult(result.settings, result.state, options.forceDraft ?? true);
        if (notify) {
          showNotification(t('auth_files.priority_rotation_sidecar_settings_saved'), 'success');
        }
        return result.state;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setPriorityRotationSidecarError(message);
        if (options.notifyError !== false) {
          showNotification(
            t('auth_files.priority_rotation_sidecar_settings_failed', { message }),
            'error'
          );
        }
        return false;
      } finally {
        setSavingState(false);
      }
    },
    [
      buildPriorityRotationSidecarSettings,
      managementKey,
      mergePriorityRotationSidecarResult,
      showNotification,
      t,
    ]
  );

  const savePriorityRotationSidecarSecret = useCallback(async () => {
    if (!managementKey) {
      showNotification(t('auth_files.priority_rotation_sidecar_missing_login'), 'error');
      return;
    }
    setPriorityRotationSidecarSaving(true);
    try {
      const result = await priorityRotationSidecarApi.saveSecret(
        managementKey,
        normalizeApiBase(apiBase)
      );
      mergePriorityRotationSidecarResult(result.settings, result.state);
      showNotification(t('auth_files.priority_rotation_sidecar_secret_saved'), 'success');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPriorityRotationSidecarError(message);
      showNotification(
        t('auth_files.priority_rotation_sidecar_secret_failed', { message }),
        'error'
      );
    } finally {
      setPriorityRotationSidecarSaving(false);
    }
  }, [apiBase, managementKey, mergePriorityRotationSidecarResult, showNotification, t]);

  useEffect(() => {
    if (!priorityRotationSidecarCommittedDraftDirty) {
      priorityRotationSidecarAutoSaveSignatureRef.current = '';
      return;
    }
    if (!managementKey) return;
    if (!priorityRotationSidecarStatus) return;
    if (priorityRotationSidecarError) return;
    if (priorityRotationSidecarSaving || priorityRotationSidecarAutoSaving) {
      return;
    }

    const autoSaveSignature = JSON.stringify(
      buildPriorityRotationSidecarSettings({}, { committedDraftOnly: true })
    );
    if (priorityRotationSidecarAutoSaveSignatureRef.current === autoSaveSignature) {
      const failedAt = priorityRotationSidecarAutoSaveFailedAtRef.current;
      if (!failedAt || Date.now() - failedAt < 5_000) return;
    }

    const timeoutId = window.setTimeout(() => {
      priorityRotationSidecarAutoSaveSignatureRef.current = autoSaveSignature;
      void (async () => {
        const saved = await savePriorityRotationSidecarSettings({}, false, {
          autoSave: true,
          committedDraftOnly: true,
          forceDraft: false,
          notifyError: false,
        });
        priorityRotationSidecarAutoSaveFailedAtRef.current = saved ? 0 : Date.now();
      })();
    }, 900);

    return () => window.clearTimeout(timeoutId);
  }, [
    buildPriorityRotationSidecarSettings,
    managementKey,
    priorityRotationSidecarCommittedDraftDirty,
    priorityRotationSidecarError,
    priorityRotationSidecarAutoSaving,
    priorityRotationSidecarSaving,
    priorityRotationSidecarStatus,
    savePriorityRotationSidecarSettings,
  ]);

  useEffect(() => {
    void loadPriorityRotationSidecarStatus(true);
  }, [loadPriorityRotationSidecarStatus]);

  useInterval(
    () => {
      void loadPriorityRotationSidecarStatus(true);
    },
    isCurrentLayer ? 15_000 : null
  );

  const getPriorityRotationNoChangeMessage = useCallback(
    (analysis: PriorityRotationAnalysis): { message: string; tone: 'info' | 'warning' } => {
      if (analysis.status === 'quota_unknown') {
        return {
          message: t('auth_files.priority_rotation_quota_unknown'),
          tone: 'warning',
        };
      }
      if (analysis.status === 'insufficient_layers') {
        return {
          message: t('auth_files.priority_rotation_insufficient_layers'),
          tone: 'info',
        };
      }
      if (analysis.status === 'no_standby') {
        return {
          message: t('auth_files.priority_rotation_no_standby'),
          tone: 'warning',
        };
      }
      return {
        message: t('auth_files.priority_rotation_no_changes'),
        tone: 'info',
      };
    },
    [t]
  );

  const openPriorityRotationPreview = useCallback(() => {
    if (priorityRotationAnalysis.changes.length === 0) {
      const { message, tone } = getPriorityRotationNoChangeMessage(priorityRotationAnalysis);
      showNotification(message, tone);
      return;
    }

    setPriorityRotationPreview(priorityRotationAnalysis);
  }, [getPriorityRotationNoChangeMessage, priorityRotationAnalysis, showNotification]);

  const closePriorityRotationPreview = useCallback(() => {
    setPriorityRotationPreview(null);
  }, []);

  const applyPriorityRotationAnalysis = useCallback(
    async (
      analysis: PriorityRotationAnalysis | null,
      options: { closePreviewOnSuccess?: boolean } = {}
    ) => {
      if (!analysis || analysis.changes.length === 0) {
        if (analysis) {
          const { message, tone } = getPriorityRotationNoChangeMessage(analysis);
          showNotification(message, tone);
        }
        return;
      }

      const result = await batchSetPriorities(
        analysis.changes.map((change) => ({
          name: change.name,
          priority: change.toPriority,
        }))
      );

      if (result.successCount > 0) {
        await loadFiles({ preserveExisting: true, silent: true });
      }

      if (options.closePreviewOnSuccess && result.failCount === 0) {
        closePriorityRotationPreview();
      }
    },
    [
      batchSetPriorities,
      closePriorityRotationPreview,
      getPriorityRotationNoChangeMessage,
      loadFiles,
      showNotification,
    ]
  );

  const applyCurrentPriorityRotation = useCallback(async () => {
    await applyPriorityRotationAnalysis(priorityRotationAnalysis);
  }, [applyPriorityRotationAnalysis, priorityRotationAnalysis]);

  const applyPriorityRotation = useCallback(async () => {
    await applyPriorityRotationAnalysis(priorityRotationPreview, {
      closePreviewOnSuccess: true,
    });
  }, [applyPriorityRotationAnalysis, priorityRotationPreview]);

  const commitBatchPriority = useCallback(() => {
    const trimmed = batchPriorityInput.trim();
    const priority = trimmed ? parsePriorityValue(trimmed) : 0;
    if (priority === undefined) {
      handlePriorityInvalid();
      return;
    }

    void batchSetPriority(selectedNames, priority).then(() => setBatchPriorityInput(''));
  }, [batchPriorityInput, batchSetPriority, handlePriorityInvalid, selectedNames]);

  const copyTextWithNotification = useCallback(
    async (text: string) => {
      const copied = await copyToClipboard(text);
      showNotification(
        copied
          ? t('notification.link_copied', { defaultValue: 'Copied to clipboard' })
          : t('notification.copy_failed', { defaultValue: 'Copy failed' }),
        copied ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );

  const openExcludedEditor = useCallback(
    (provider?: string) => {
      const providerValue = (provider || (filter !== 'all' ? String(filter) : '')).trim();
      const params = new URLSearchParams();
      if (providerValue) {
        params.set('provider', providerValue);
      }
      const nextSearch = params.toString();
      navigate(`/auth-files/oauth-excluded${nextSearch ? `?${nextSearch}` : ''}`, {
        state: { fromAuthFiles: true },
      });
    },
    [filter, navigate]
  );

  const openModelAliasEditor = useCallback(
    (provider?: string) => {
      const providerValue = (provider || (filter !== 'all' ? String(filter) : '')).trim();
      const params = new URLSearchParams();
      if (providerValue) {
        params.set('provider', providerValue);
      }
      const nextSearch = params.toString();
      navigate(`/auth-files/oauth-model-alias${nextSearch ? `?${nextSearch}` : ''}`, {
        state: { fromAuthFiles: true },
      });
    },
    [filter, navigate]
  );

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;

    const actionsEl = floatingBatchActionsRef.current;
    if (!actionsEl) {
      document.documentElement.style.removeProperty('--auth-files-action-bar-height');
      return;
    }

    const updatePadding = () => {
      const height = actionsEl.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--auth-files-action-bar-height', `${height}px`);
    };

    updatePadding();
    window.addEventListener('resize', updatePadding);

    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePadding);
    ro?.observe(actionsEl);

    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', updatePadding);
      document.documentElement.style.removeProperty('--auth-files-action-bar-height');
    };
  }, [batchActionBarVisible, selectionCount]);

  useEffect(() => {
    selectionCountRef.current = selectionCount;
    if (selectionCount > 0) {
      setBatchActionBarVisible(true);
    }
  }, [selectionCount]);

  useLayoutEffect(() => {
    if (!batchActionBarVisible) return;
    const currentCount = selectionCount;
    const previousCount = previousSelectionCountRef.current;
    const actionsEl = floatingBatchActionsRef.current;
    if (!actionsEl) return;

    batchActionAnimationRef.current?.stop();
    batchActionAnimationRef.current = null;

    if (currentCount > 0 && previousCount === 0) {
      batchActionAnimationRef.current = animate(
        actionsEl,
        {
          transform: [BATCH_BAR_HIDDEN_TRANSFORM, BATCH_BAR_BASE_TRANSFORM],
          opacity: [0, 1],
        },
        {
          duration: 0.28,
          ease: easePower3Out,
          onComplete: () => {
            actionsEl.style.transform = BATCH_BAR_BASE_TRANSFORM;
            actionsEl.style.opacity = '1';
          },
        }
      );
    } else if (currentCount === 0 && previousCount > 0) {
      batchActionAnimationRef.current = animate(
        actionsEl,
        {
          transform: [BATCH_BAR_BASE_TRANSFORM, BATCH_BAR_HIDDEN_TRANSFORM],
          opacity: [1, 0],
        },
        {
          duration: 0.22,
          ease: easePower2In,
          onComplete: () => {
            if (selectionCountRef.current === 0) {
              setBatchActionBarVisible(false);
            }
          },
        }
      );
    }

    previousSelectionCountRef.current = currentCount;
  }, [batchActionBarVisible, selectionCount]);

  useEffect(
    () => () => {
      batchActionAnimationRef.current?.stop();
      batchActionAnimationRef.current = null;
    },
    []
  );

  const renderFilterTags = () => (
    <div className={styles.filterRail}>
      <div className={styles.filterTags}>
        {existingTypes.map((type) => {
          const isActive = filter === type;
          const iconSrc = getAuthFileIcon(type, resolvedTheme);
          const color =
            type === 'all'
              ? { bg: 'var(--bg-tertiary)', text: 'var(--text-primary)' }
              : getTypeColor(type, resolvedTheme);
          const buttonStyle = {
            '--filter-color': color.text,
            '--filter-surface': color.bg,
            '--filter-active-text': resolvedTheme === 'dark' ? '#111827' : '#ffffff',
          } as CSSProperties;

          return (
            <button
              key={type}
              className={`${styles.filterTag} ${isActive ? styles.filterTagActive : ''}`}
              style={buttonStyle}
              onClick={() => {
                setFilter(type);
                setPage(1);
              }}
            >
              <span className={styles.filterTagLabel}>
                {type === 'all' ? (
                  <span className={`${styles.filterTagIconWrap} ${styles.filterAllIconWrap}`}>
                    <IconFilterAll className={styles.filterAllIcon} size={16} />
                  </span>
                ) : (
                  <span className={styles.filterTagIconWrap}>
                    {iconSrc ? (
                      <img src={iconSrc} alt="" className={styles.filterTagIcon} />
                    ) : (
                      <span className={styles.filterTagIconFallback}>
                        {getTypeLabel(t, type).slice(0, 1).toUpperCase()}
                      </span>
                    )}
                  </span>
                )}
                <span className={styles.filterTagText}>{getTypeLabel(t, type)}</span>
              </span>
              <span className={styles.filterTagCount}>{typeCounts[type] ?? 0}</span>
            </button>
          );
        })}
      </div>
    </div>
  );

  const titleNode = (
    <div className={styles.titleWrapper}>
      <span>{t('auth_files.title_section')}</span>
      {files.length > 0 && <span className={styles.countBadge}>{files.length}</span>}
    </div>
  );

  const deleteAllButtonLabel = (() => {
    if (disabledOnly || enabledOnly) {
      return t('auth_files.delete_filtered_result_button');
    }
    if (problemOnly) {
      return filter === 'all'
        ? t('auth_files.delete_problem_button')
        : t('auth_files.delete_problem_button_with_type', { type: getTypeLabel(t, filter) });
    }
    return filter === 'all'
      ? t('auth_files.delete_all_button')
      : `${t('common.delete')} ${getTypeLabel(t, filter)}`;
  })();
  const manualExpiryEditorDisplayName = manualExpiryEditorFile
    ? typeof manualExpiryEditorFile.note === 'string' && manualExpiryEditorFile.note.trim()
      ? manualExpiryEditorFile.note.trim()
      : manualExpiryEditorFile.name
    : '';
  const manualExpiryEditorExistingMs = manualExpiryEditorFile
    ? getManualExpiryMs(manualExpiryByFile, manualExpiryEditorFile.name)
    : null;
  const uploadDropPoolClass = [
    styles.uploadDropPool,
    uploadDropActive ? styles.uploadDropPoolActive : '',
    uploadDropDisabled ? styles.uploadDropPoolDisabled : '',
  ]
    .filter(Boolean)
    .join(' ');
  const uploadDropStatusLabel = uploading
    ? t(`auth_files.upload_stage_${uploadProgress.stage}`)
    : disableControls
      ? t('auth_files.upload_pool_disconnected')
      : t('auth_files.upload_pool_ready');
  const uploadDropProgressPercent =
    uploadProgress.stage === 'validating'
      ? 24
      : uploadProgress.stage === 'uploading'
        ? 64
        : uploadProgress.stage === 'refreshing'
          ? 88
          : 0;
  const uploadDropProgressMeta = uploading
    ? t('auth_files.upload_progress_meta', {
        total: uploadProgress.total,
        accepted: uploadProgress.accepted,
        rejected: uploadProgress.rejected,
        uploaded: uploadProgress.uploaded,
      })
    : '';
  const priorityRotationStatusLabel =
    priorityRotationAnalysis.changes.length > 0
      ? t('auth_files.priority_rotation_status_ready', {
          count: priorityRotationAnalysis.changes.length,
        })
      : priorityRotationAnalysis.status === 'quota_unknown'
        ? t('auth_files.priority_rotation_status_unknown')
        : priorityRotationAnalysis.status === 'no_standby'
          ? t('auth_files.priority_rotation_status_no_standby')
          : t('auth_files.priority_rotation_status_idle');
  const priorityRotationSlotLabel = t('auth_files.priority_rotation_status_slots', {
    current: priorityRotationAnalysis.projectedActiveCount,
    limit: priorityRotationAnalysis.activeSlotLimit,
  });
  const priorityRotationNoStandbyLabel =
    priorityRotationAnalysis.changes.length > 0 &&
    priorityRotationAnalysis.healthyStandbyCount === 0
      ? t('auth_files.priority_rotation_status_no_healthy_standby')
      : '';
  const priorityRotationEffectiveThresholdLabel = priorityRotationAnalysis.thresholdAdjusted
    ? t('auth_files.priority_rotation_status_effective_threshold', {
        threshold: priorityRotationAnalysis.effectiveThresholdPercent,
      })
    : '';
  const priorityRotationStatusClass =
    priorityRotationAnalysis.changes.length > 0
      ? styles.priorityRotationStatusReady
      : priorityRotationAnalysis.status === 'quota_unknown' ||
          priorityRotationAnalysis.status === 'no_standby'
        ? styles.priorityRotationStatusWarning
        : styles.priorityRotationStatusMuted;
  const priorityRotationPendingSaveLabel = t('auth_files.priority_rotation_sidecar_unsaved');
  const priorityRotationInputPendingLabel = t('auth_files.priority_rotation_sidecar_input_pending');
  const priorityRotationDraftStatusLabel = priorityRotationSidecarCommittedDraftDirty
    ? priorityRotationPendingSaveLabel
    : priorityRotationSidecarInputDraftDirty
      ? priorityRotationInputPendingLabel
      : '';
  const priorityRotationLayerLabel = t('auth_files.priority_rotation_layers_short');
  const priorityRotationLayerTitle = t('auth_files.priority_rotation_layers_title');
  const priorityRotationTierLabels: Record<AuthFilePriorityTier, string> = {
    active: t('auth_files.priority_rotation_tier_active'),
    standby: t('auth_files.priority_rotation_tier_standby'),
    buffer: t('auth_files.priority_rotation_tier_buffer'),
  };
  const priorityRotationTierPriorityMap: Record<AuthFilePriorityTier, number | null> = {
    active: priorityRotationAnalysis.activePriority,
    standby: priorityRotationAnalysis.standbyPriority,
    buffer: priorityRotationAnalysis.reservePriority,
  };
  const priorityRotationTierItems: Array<{
    key: AuthFilePriorityTier;
    label: string;
    value: string;
    className: string;
    count: number;
    ariaLabel: string;
  }> = [
    {
      key: 'active',
      label: priorityRotationTierLabels.active,
      value: formatPriorityRotationPriority(priorityRotationTierPriorityMap.active),
      className: styles.priorityRotationTierActive,
      count: priorityRotationTierDetailGroups.active.length,
      ariaLabel: t('auth_files.priority_rotation_detail_open_aria', {
        tier: priorityRotationTierLabels.active,
        count: priorityRotationTierDetailGroups.active.length,
        defaultValue: `查看${priorityRotationTierLabels.active}详情（${priorityRotationTierDetailGroups.active.length} 个）`,
      }),
    },
    {
      key: 'standby',
      label: priorityRotationTierLabels.standby,
      value: formatPriorityRotationPriority(priorityRotationTierPriorityMap.standby),
      className: styles.priorityRotationTierStandby,
      count: priorityRotationTierDetailGroups.standby.length,
      ariaLabel: t('auth_files.priority_rotation_detail_open_aria', {
        tier: priorityRotationTierLabels.standby,
        count: priorityRotationTierDetailGroups.standby.length,
        defaultValue: `查看${priorityRotationTierLabels.standby}详情（${priorityRotationTierDetailGroups.standby.length} 个）`,
      }),
    },
    {
      key: 'buffer',
      label: priorityRotationTierLabels.buffer,
      value: formatPriorityRotationPriority(priorityRotationTierPriorityMap.buffer),
      className: styles.priorityRotationTierBuffer,
      count: priorityRotationTierDetailGroups.buffer.length,
      ariaLabel: t('auth_files.priority_rotation_detail_open_aria', {
        tier: priorityRotationTierLabels.buffer,
        count: priorityRotationTierDetailGroups.buffer.length,
        defaultValue: `查看${priorityRotationTierLabels.buffer}详情（${priorityRotationTierDetailGroups.buffer.length} 个）`,
      }),
    },
  ];
  const getPriorityRotationChangeReason = (
    change: PriorityRotationChange,
    analysis: PriorityRotationAnalysis = priorityRotationAnalysis
  ) => {
    if (change.reason === 'low_remaining') {
      return t('auth_files.priority_rotation_reason_demote_low', {
        threshold: analysis.effectiveThresholdPercent,
      });
    }
    if (change.reason === 'over_active_limit') {
      return t('auth_files.priority_rotation_reason_demote_over_limit', {
        limit: analysis.activeSlotLimit,
      });
    }
    return t('auth_files.priority_rotation_reason_promote', {
      threshold: analysis.effectiveThresholdPercent,
    });
  };
  const priorityRotationPreviewSummaryItems = priorityRotationPreview
    ? [
        {
          key: 'threshold',
          label: t('auth_files.priority_rotation_summary_threshold_label'),
          value: t('auth_files.priority_rotation_summary_threshold_value', {
            threshold: priorityRotationPreview.thresholdPercent,
          }),
        },
        ...(priorityRotationPreview.thresholdAdjusted
          ? [
              {
                key: 'effectiveThreshold',
                label: t('auth_files.priority_rotation_summary_effective_threshold_label'),
                value: t('auth_files.priority_rotation_summary_effective_threshold_value', {
                  threshold: priorityRotationPreview.effectiveThresholdPercent,
                }),
              },
            ]
          : []),
        {
          key: 'slots',
          label: t('auth_files.priority_rotation_summary_slots_label'),
          value: t('auth_files.priority_rotation_summary_slots_value', {
            current: priorityRotationPreview.projectedActiveCount,
            limit: priorityRotationPreview.activeSlotLimit,
          }),
        },
        {
          key: 'tiers',
          label: t('auth_files.priority_rotation_summary_tiers_label'),
          value: t('auth_files.priority_rotation_summary_tiers_value', {
            active: formatPriorityRotationPriority(priorityRotationPreview.activePriority),
            standby: formatPriorityRotationPriority(priorityRotationPreview.standbyPriority),
            buffer: formatPriorityRotationPriority(priorityRotationPreview.reservePriority),
          }),
        },
        {
          key: 'count',
          label: t('auth_files.priority_rotation_summary_count_label'),
          value: t('auth_files.priority_rotation_summary_count_value', {
            count: priorityRotationPreview.changes.length,
          }),
        },
      ]
    : [];
  const priorityRotationSidecarState = priorityRotationSidecarStatus?.state ?? null;
  const priorityRotationSidecarOnline =
    Boolean(priorityRotationSidecarStatus) && !priorityRotationSidecarError;
  const priorityRotationSidecarSavedEnabled = priorityRotationSidecarSettings?.enabled === true;
  const priorityRotationSidecarEnabled = priorityRotationSettings.enabled === true;
  const priorityRotationSidecarHasSecret = priorityRotationSidecarState?.hasSecret === true;
  const priorityRotationSidecarStatusTone =
    priorityRotationSidecarError || !priorityRotationSidecarOnline
      ? styles.priorityRotationStatusWarning
      : priorityRotationSidecarState?.running
        ? styles.priorityRotationStatusReady
        : styles.priorityRotationStatusMuted;
  const priorityRotationSidecarLiveStatusLabel = priorityRotationSidecarLoading
    ? t('auth_files.priority_rotation_sidecar_loading')
    : priorityRotationSidecarError || !priorityRotationSidecarOnline
      ? t('auth_files.priority_rotation_sidecar_offline')
      : priorityRotationSidecarState?.running
        ? t('auth_files.priority_rotation_sidecar_running')
        : t('auth_files.priority_rotation_sidecar_waiting');
  const priorityRotationSidecarSecretLabel = priorityRotationSidecarHasSecret
    ? t('auth_files.priority_rotation_sidecar_secret_ready')
    : t('auth_files.priority_rotation_sidecar_secret_missing');
  const priorityRotationSidecarSecretToneClass = priorityRotationSidecarHasSecret
    ? styles.priorityRotationBackgroundMetaSuccess
    : styles.priorityRotationBackgroundMetaWarning;
  const priorityRotationSidecarLastRunLabel = t('auth_files.priority_rotation_sidecar_last_run', {
    time: formatNullableDateTime(priorityRotationSidecarState?.lastCompletedAt),
  });
  const priorityRotationSidecarNextRunLabel = t('auth_files.priority_rotation_sidecar_next_run', {
    time: priorityRotationSidecarSavedEnabled
      ? formatNullableDateTime(priorityRotationSidecarState?.nextRunAt)
      : '-',
  });
  const priorityRotationDetailTierLabel = priorityRotationDetailTier
    ? priorityRotationTierLabels[priorityRotationDetailTier]
    : '';
  const priorityRotationDetailPriority = priorityRotationDetailTier
    ? priorityRotationTierPriorityMap[priorityRotationDetailTier]
    : null;
  const priorityRotationDetailItems = priorityRotationDetailTier
    ? priorityRotationTierDetailGroups[priorityRotationDetailTier]
    : [];
  const priorityRotationDetailTitle = priorityRotationDetailTier
    ? t('auth_files.priority_rotation_detail_title', {
        tier: priorityRotationDetailTierLabel,
        priority: formatPriorityRotationPriority(priorityRotationDetailPriority),
        defaultValue: `${priorityRotationDetailTierLabel} ${formatPriorityRotationPriority(priorityRotationDetailPriority)}`,
      })
    : '';

  return (
    <div className={styles.container}>
      <div className={styles.pageHeader}>
        <h1 className={styles.pageTitle}>{t('auth_files.title')}</h1>
        <p className={styles.description}>{t('auth_files.description')}</p>
      </div>

      <Card
        className={styles.authFilesPanel}
        title={titleNode}
        extra={
          <div className={styles.headerActions}>
            <Button variant="secondary" size="sm" onClick={handleHeaderRefresh} disabled={loading}>
              {t('common.refresh')}
            </Button>
            <Button
              size="sm"
              onClick={handleUploadClick}
              disabled={disableControls || uploading}
              loading={uploading}
            >
              {t('auth_files.upload_button')}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() =>
                handleDeleteAll({
                  filter,
                  problemOnly,
                  disabledOnly,
                  enabledOnly,
                  onResetFilterToAll: () => setFilter('all'),
                  onResetProblemOnly: () => setProblemOnly(false),
                  onResetDisabledOnly: () => setDisabledOnly(false),
                  onResetEnabledOnly: () => setEnabledOnly(false),
                })
              }
              disabled={disableControls || loading || deletingAll}
              loading={deletingAll}
            >
              {deleteAllButtonLabel}
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              multiple
              style={{ display: 'none' }}
              onChange={handleFileChange}
            />
          </div>
        }
      >
        {error && (
          <EmptyState
            title={t('common.error')}
            description={error}
            variant="error"
            className={`${styles.authFilesEmptyState} ${styles.authFilesEmptyStateError}`}
            compact
          />
        )}

        <div className={styles.filterSection}>
          {renderFilterTags()}

          <div
            className={uploadDropPoolClass}
            role="button"
            tabIndex={uploadDropDisabled ? -1 : 0}
            aria-disabled={uploadDropDisabled}
            onClick={handleUploadPoolClick}
            onKeyDown={handleUploadPoolKeyDown}
            onDragEnter={handleUploadPoolDragEnter}
            onDragOver={handleUploadPoolDragOver}
            onDragLeave={handleUploadPoolDragLeave}
            onDrop={handleUploadPoolDrop}
          >
            <span className={styles.uploadDropPoolIcon} aria-hidden="true">
              <IconUploadCloud size={20} />
            </span>
            <span className={styles.uploadDropPoolCopy}>
              <span className={styles.uploadDropPoolTitle}>
                {t('auth_files.upload_pool_title')}
              </span>
              <span className={styles.uploadDropPoolHint}>
                {uploadDropProgressMeta || t('auth_files.upload_pool_hint')}
              </span>
              {uploading && (
                <span className={styles.uploadDropProgressTrack} aria-hidden="true">
                  <span
                    className={styles.uploadDropProgressBar}
                    style={{ width: `${uploadDropProgressPercent}%` }}
                  />
                </span>
              )}
            </span>
            <span className={styles.uploadDropPoolStatus}>{uploadDropStatusLabel}</span>
          </div>

          <div className={styles.filterContent}>
            <div className={styles.priorityRotationBar}>
              <div className={styles.priorityRotationMain}>
                <span className={styles.priorityRotationIcon} aria-hidden="true">
                  <IconSlidersHorizontal size={19} />
                </span>
                <span className={styles.priorityRotationCopy}>
                  <span className={styles.priorityRotationTitle}>
                    {t('auth_files.priority_rotation_title')}
                  </span>
                  <span className={styles.priorityRotationMeta} title={priorityRotationLayerTitle}>
                    {priorityRotationLayerLabel}
                  </span>
                  <span
                    className={styles.priorityRotationTiers}
                    aria-label={t('auth_files.priority_rotation_tiers_aria')}
                  >
                    {priorityRotationTierItems.map((tier) => (
                      <button
                        type="button"
                        className={`${styles.priorityRotationTier} ${styles.priorityRotationTierButton} ${tier.className}`}
                        key={tier.key}
                        onClick={() => setPriorityRotationDetailTier(tier.key)}
                        aria-label={tier.ariaLabel}
                        title={tier.ariaLabel}
                      >
                        <span className={styles.priorityRotationTierLabel}>{tier.label}</span>
                        <span className={styles.priorityRotationTierValue}>{tier.value}</span>
                        <span className={styles.priorityRotationTierCount}>{tier.count}</span>
                      </button>
                    ))}
                  </span>
                </span>
              </div>
              <div className={styles.priorityRotationActions}>
                <div className={styles.priorityRotationStatusGroup}>
                  <span
                    className={`${styles.priorityRotationStatus} ${priorityRotationStatusClass}`}
                  >
                    {priorityRotationStatusLabel}
                  </span>
                  <span
                    className={`${styles.priorityRotationStatus} ${styles.priorityRotationStatusInfo}`}
                  >
                    {priorityRotationSlotLabel}
                  </span>
                  {priorityRotationNoStandbyLabel && (
                    <span
                      className={`${styles.priorityRotationStatus} ${styles.priorityRotationStatusWarning}`}
                    >
                      {priorityRotationNoStandbyLabel}
                    </span>
                  )}
                  {priorityRotationEffectiveThresholdLabel && (
                    <span
                      className={`${styles.priorityRotationStatus} ${styles.priorityRotationStatusInfo}`}
                    >
                      {priorityRotationEffectiveThresholdLabel}
                    </span>
                  )}
                </div>
                <div className={styles.priorityRotationButtonGroup}>
                  <Button
                    className={styles.priorityRotationButton}
                    variant="secondary"
                    size="sm"
                    leftIcon={<IconRefreshCw size={16} />}
                    onClick={openPriorityRotationPreview}
                    disabled={disableControls || loading || batchPriorityUpdating}
                    aria-label={t('auth_files.priority_rotation_button_aria')}
                  >
                    {t('auth_files.priority_rotation_button')}
                  </Button>
                  <Button
                    className={`${styles.priorityRotationButton} ${styles.priorityRotationDirectButton}`}
                    variant="primary"
                    size="sm"
                    leftIcon={<IconSlidersHorizontal size={16} />}
                    onClick={() => void applyCurrentPriorityRotation()}
                    disabled={
                      disableControls ||
                      loading ||
                      batchPriorityUpdating ||
                      priorityRotationAnalysis.changes.length === 0
                    }
                    loading={batchPriorityUpdating}
                    aria-label={t('auth_files.priority_rotation_direct_apply_aria')}
                  >
                    {batchPriorityUpdating
                      ? t('auth_files.priority_rotation_direct_applying')
                      : t('auth_files.priority_rotation_direct_apply')}
                  </Button>
                </div>
              </div>
            </div>

            <div className={styles.priorityRotationBackgroundPanel}>
              <div className={styles.priorityRotationBackgroundHeader}>
                <span className={styles.priorityRotationBackgroundIcon} aria-hidden="true">
                  <IconRefreshCw size={16} />
                </span>
                <span className={styles.priorityRotationBackgroundCopy}>
                  <span className={styles.priorityRotationBackgroundTitleRow}>
                    <span className={styles.priorityRotationBackgroundTitle}>
                      {t('auth_files.priority_rotation_sidecar_title')}
                    </span>
                    <span
                      className={`${styles.priorityRotationStatus} ${priorityRotationSidecarStatusTone}`}
                    >
                      {priorityRotationSidecarLiveStatusLabel}
                    </span>
                    {priorityRotationDraftStatusLabel && (
                      <span
                        className={`${styles.priorityRotationStatus} ${styles.priorityRotationStatusWarning}`}
                      >
                        {priorityRotationDraftStatusLabel}
                      </span>
                    )}
                  </span>
                  <span className={styles.priorityRotationBackgroundMetaLine}>
                    <span
                      className={`${styles.priorityRotationBackgroundMetaItem} ${priorityRotationSidecarSecretToneClass}`}
                    >
                      {priorityRotationSidecarSecretLabel}
                    </span>
                    <span className={styles.priorityRotationBackgroundMetaItem}>
                      {priorityRotationSidecarLastRunLabel}
                    </span>
                    <span className={styles.priorityRotationBackgroundMetaItem}>
                      {priorityRotationSidecarNextRunLabel}
                    </span>
                  </span>
                </span>
                <div className={styles.priorityRotationRelayControl}>
                  <span className={styles.priorityRotationRelayCopy}>
                    <strong>{t('auth_files.priority_rotation_sidecar_enable')}</strong>
                    <span>
                      {priorityRotationSidecarEnabled
                        ? t('auth_files.priority_rotation_auto_status_on')
                        : t('auth_files.priority_rotation_auto_status_off')}
                    </span>
                  </span>
                  <button
                    type="button"
                    className={`${styles.priorityRotationRelaySwitch} ${
                      priorityRotationSidecarEnabled ? styles.priorityRotationRelaySwitchOn : ''
                    }`}
                    role="switch"
                    aria-checked={priorityRotationSidecarEnabled}
                    aria-label={t('auth_files.priority_rotation_sidecar_enable')}
                    disabled={priorityRotationSidecarSaving}
                    onClick={() => {
                      updatePriorityRotationSettings({ enabled: !priorityRotationSidecarEnabled });
                    }}
                  >
                    <span className={styles.priorityRotationRelayTrack} aria-hidden="true">
                      <span className={styles.priorityRotationRelayThumb} />
                    </span>
                  </button>
                </div>
              </div>
              <div className={styles.priorityRotationBackgroundControls}>
                <div className={styles.priorityRotationBackgroundRules}>
                  <label className={styles.priorityRotationSetting}>
                    <span className={styles.priorityRotationSettingHeader}>
                      <span>{t('auth_files.priority_rotation_threshold_label')}</span>
                      <span className={styles.priorityRotationThresholdValue}>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={priorityRotationThresholdInput}
                          disabled={priorityRotationSidecarSaving}
                          aria-label={t('auth_files.priority_rotation_threshold_label')}
                          onChange={(event) => {
                            priorityRotationSidecarDraftTouchedRef.current = true;
                            setPriorityRotationThresholdInput(event.currentTarget.value);
                          }}
                          onBlur={(event) =>
                            commitPriorityRotationThresholdInput(event.currentTarget.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.currentTarget.blur();
                            }
                          }}
                        />
                        <span>%</span>
                      </span>
                    </span>
                    <span className={styles.priorityRotationThresholdControl}>
                      <input
                        className={styles.priorityRotationSlider}
                        type="range"
                        min={0}
                        max={100}
                        step={PRIORITY_ROTATION_THRESHOLD_STEP}
                        value={priorityRotationEffectiveThresholdPercent}
                        disabled={priorityRotationSidecarSaving}
                        aria-label={t('auth_files.priority_rotation_threshold_label')}
                        style={
                          {
                            '--priority-rotation-slider-progress': `${priorityRotationEffectiveThresholdPercent}%`,
                          } as CSSProperties
                        }
                        onChange={(event) =>
                          commitPriorityRotationThresholdInput(event.currentTarget.value)
                        }
                      />
                    </span>
                  </label>
                  <label className={styles.priorityRotationSetting}>
                    <span className={styles.priorityRotationSettingHeader}>
                      <span>{t('auth_files.priority_rotation_slots_label')}</span>
                    </span>
                    <span
                      className={`${styles.priorityRotationStepper} ${styles.priorityRotationSlotStepper}`}
                    >
                      <button
                        type="button"
                        className={styles.priorityRotationStepperButton}
                        disabled={priorityRotationSidecarSaving}
                        aria-label={t('auth_files.priority_rotation_slots_decrease')}
                        onClick={() => adjustPriorityRotationSlots(-PRIORITY_ROTATION_SLOT_STEP)}
                      >
                        <IconMinus size={16} />
                      </button>
                      <span className={styles.priorityRotationStepperValue}>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={priorityRotationSlotsInput}
                          disabled={priorityRotationSidecarSaving}
                          aria-label={t('auth_files.priority_rotation_slots_label')}
                          onChange={(event) => {
                            priorityRotationSidecarDraftTouchedRef.current = true;
                            setPriorityRotationSlotsInput(event.currentTarget.value);
                          }}
                          onBlur={(event) =>
                            commitPriorityRotationSlotsInput(event.currentTarget.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.currentTarget.blur();
                            }
                          }}
                        />
                      </span>
                      <button
                        type="button"
                        className={styles.priorityRotationStepperButton}
                        disabled={priorityRotationSidecarSaving}
                        aria-label={t('auth_files.priority_rotation_slots_increase')}
                        onClick={() => adjustPriorityRotationSlots(PRIORITY_ROTATION_SLOT_STEP)}
                      >
                        <IconPlus size={16} />
                      </button>
                    </span>
                  </label>
                  <label className={styles.priorityRotationSetting}>
                    <span className={styles.priorityRotationSettingHeader}>
                      <span>{t('auth_files.priority_rotation_sidecar_interval')}</span>
                    </span>
                    <span
                      className={`${styles.priorityRotationStepper} ${styles.priorityRotationIntervalStepper}`}
                    >
                      <button
                        type="button"
                        className={styles.priorityRotationStepperButton}
                        disabled={priorityRotationSidecarSaving}
                        aria-label={t('auth_files.priority_rotation_sidecar_interval_decrease')}
                        onClick={() =>
                          adjustPriorityRotationSidecarInterval(
                            -PRIORITY_ROTATION_SIDECAR_INTERVAL_STEP
                          )
                        }
                      >
                        <IconMinus size={16} />
                      </button>
                      <span className={styles.priorityRotationStepperValue}>
                        <input
                          type="text"
                          inputMode="numeric"
                          pattern="[0-9]*"
                          value={priorityRotationSidecarIntervalInput}
                          disabled={priorityRotationSidecarSaving}
                          aria-label={t('auth_files.priority_rotation_sidecar_interval')}
                          onChange={(event) => {
                            priorityRotationSidecarDraftTouchedRef.current = true;
                            setPriorityRotationSidecarIntervalInput(event.currentTarget.value);
                          }}
                          onBlur={(event) =>
                            commitPriorityRotationSidecarIntervalInput(event.currentTarget.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.currentTarget.blur();
                            }
                          }}
                        />
                        <span>{t('auth_files.priority_rotation_sidecar_interval_unit')}</span>
                      </span>
                      <button
                        type="button"
                        className={styles.priorityRotationStepperButton}
                        disabled={priorityRotationSidecarSaving}
                        aria-label={t('auth_files.priority_rotation_sidecar_interval_increase')}
                        onClick={() =>
                          adjustPriorityRotationSidecarInterval(
                            PRIORITY_ROTATION_SIDECAR_INTERVAL_STEP
                          )
                        }
                      >
                        <IconPlus size={16} />
                      </button>
                    </span>
                  </label>
                </div>
                <div className={styles.priorityRotationBackgroundButtons}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void savePriorityRotationSidecarSecret()}
                    disabled={!managementKey || priorityRotationSidecarSaving}
                    loading={priorityRotationSidecarSaving}
                  >
                    {t('auth_files.priority_rotation_sidecar_save_secret')}
                  </Button>
                </div>
              </div>
              {priorityRotationSidecarError && (
                <div className={styles.priorityRotationBackgroundError}>
                  {priorityRotationSidecarError}
                </div>
              )}
            </div>

            <div className={styles.filterControlsPanel}>
              <div className={styles.filterControls}>
                <div className={styles.filterItem}>
                  <label>{t('auth_files.search_label')}</label>
                  <Input
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                    placeholder={t('auth_files.search_placeholder')}
                  />
                </div>
                <div className={styles.filterItem}>
                  <label>{t('auth_files.page_size_label')}</label>
                  <input
                    className={styles.pageSizeSelect}
                    type="number"
                    min={MIN_CARD_PAGE_SIZE}
                    max={MAX_CARD_PAGE_SIZE}
                    step={1}
                    value={pageSizeInput}
                    onChange={handlePageSizeChange}
                    onBlur={(e) => commitPageSizeInput(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.currentTarget.blur();
                      }
                    }}
                  />
                </div>
                <div className={styles.filterItem}>
                  <label>{t('auth_files.sort_label')}</label>
                  <Select
                    className={styles.sortSelect}
                    value={sortMode}
                    options={sortOptions}
                    onChange={handleSortModeChange}
                    ariaLabel={t('auth_files.sort_label')}
                    fullWidth
                  />
                </div>
                <div className={`${styles.filterItem} ${styles.filterToggleItem}`}>
                  <label>{t('auth_files.display_options_label')}</label>
                  <div className={styles.filterToggleGroup}>
                    <div className={styles.filterToggleCard}>
                      <ToggleSwitch
                        checked={problemOnly}
                        onChange={(value) => {
                          setProblemOnly(value);
                          setPage(1);
                        }}
                        ariaLabel={t('auth_files.problem_filter_only')}
                        label={
                          <span className={styles.filterToggleLabel}>
                            {t('auth_files.problem_filter_only')}
                          </span>
                        }
                      />
                    </div>
                    <div className={styles.filterToggleCard}>
                      <ToggleSwitch
                        checked={enabledOnly}
                        onChange={(value) => {
                          setEnabledOnly(value);
                          if (value) {
                            setDisabledOnly(false);
                          }
                          setPage(1);
                        }}
                        ariaLabel={t('auth_files.enabled_filter_only')}
                        label={
                          <span className={styles.filterToggleLabel}>
                            {t('auth_files.enabled_filter_only')}
                          </span>
                        }
                      />
                    </div>
                    <div className={styles.filterToggleCard}>
                      <ToggleSwitch
                        checked={disabledOnly}
                        onChange={(value) => {
                          setDisabledOnly(value);
                          if (value) {
                            setEnabledOnly(false);
                          }
                          setPage(1);
                        }}
                        ariaLabel={t('auth_files.disabled_filter_only')}
                        label={
                          <span className={styles.filterToggleLabel}>
                            {t('auth_files.disabled_filter_only')}
                          </span>
                        }
                      />
                    </div>
                    <div className={styles.filterToggleCard}>
                      <ToggleSwitch
                        checked={compactMode}
                        onChange={(value) => setCompactMode(value)}
                        ariaLabel={t('auth_files.compact_mode_label')}
                        label={
                          <span className={styles.filterToggleLabel}>
                            {t('auth_files.compact_mode_label')}
                          </span>
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {loading && files.length === 0 ? (
              <EmptyState
                title={t('common.loading')}
                description={t('auth_files.loading_desc', {
                  defaultValue: '正在读取本地认证文件与运行状态。',
                })}
                variant="loading"
                className={`${styles.authFilesEmptyState} ${styles.authFilesEmptyStateLoading}`}
                compact
              />
            ) : pageItems.length === 0 ? (
              <EmptyState
                title={t('auth_files.search_empty_title')}
                description={t('auth_files.search_empty_desc')}
                className={styles.authFilesEmptyState}
              />
            ) : (
              <div
                className={`${styles.fileGrid} ${quotaFilterType ? styles.fileGridQuotaManaged : ''} ${compactMode ? styles.fileGridCompact : ''}`}
              >
                {pageItems.map((file) => (
                  <AuthFileCard
                    key={file.name}
                    file={file}
                    compact={compactMode}
                    selected={selectedFiles.has(file.name)}
                    resolvedTheme={resolvedTheme}
                    disableControls={disableControls}
                    deleting={deleting}
                    statusUpdating={statusUpdating}
                    quotaFilterType={quotaFilterType}
                    statusBarCache={statusBarCache}
                    authTokenSnapshot={authTokenSnapshots.get(file.name)}
                    codexSubscriptionSnapshot={codexSubscriptionSnapshots.get(file.name)}
                    manualExpiryMs={getManualExpiryMs(manualExpiryByFile, file.name)}
                    priorityTier={priorityTierByFile.get(file.name) ?? null}
                    priorityUpdating={priorityUpdating}
                    noteUpdating={noteUpdating}
                    onShowModels={showModels}
                    onDownload={handleDownload}
                    onOpenPrefixProxyEditor={openPrefixProxyEditor}
                    onManualExpiryEdit={openManualExpiryEditor}
                    onDelete={handleDelete}
                    onToggleStatus={handleStatusToggle}
                    onPriorityChange={handlePriorityChange}
                    onDisplayNameChange={handleDisplayNameChange}
                    onPriorityInvalid={handlePriorityInvalid}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </div>
            )}

            {sorted.length > pageSize && (
              <div className={styles.pagination}>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.max(1, currentPage - 1))}
                  disabled={currentPage <= 1}
                >
                  {t('auth_files.pagination_prev')}
                </Button>
                <div className={styles.pageInfo}>
                  {t('auth_files.pagination_info', {
                    current: currentPage,
                    total: totalPages,
                    count: sorted.length,
                  })}
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                  disabled={currentPage >= totalPages}
                >
                  {t('auth_files.pagination_next')}
                </Button>
              </div>
            )}
          </div>
        </div>
      </Card>

      <OAuthExcludedCard
        disableControls={disableControls}
        excludedError={excludedError}
        excluded={excluded}
        onAdd={() => openExcludedEditor()}
        onEdit={openExcludedEditor}
        onDelete={deleteExcluded}
      />

      <OAuthModelAliasCard
        disableControls={disableControls}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onAdd={() => openModelAliasEditor()}
        onEditProvider={openModelAliasEditor}
        onDeleteProvider={deleteModelAlias}
        modelAliasError={modelAliasError}
        modelAlias={modelAlias}
        allProviderModels={allProviderModels}
        onUpdate={handleMappingUpdate}
        onDeleteLink={handleDeleteLink}
        onToggleFork={handleToggleFork}
        onRenameAlias={handleRenameAlias}
        onDeleteAlias={handleDeleteAlias}
      />

      <AuthFileModelsModal
        open={modelsModalOpen}
        fileName={modelsFileName}
        fileType={modelsFileType}
        loading={modelsLoading}
        error={modelsError}
        models={modelsList}
        excluded={excluded}
        onClose={closeModelsModal}
        onCopyText={copyTextWithNotification}
      />

      <AuthFilesPrefixProxyEditorModal
        disableControls={disableControls}
        editor={prefixProxyEditor}
        updatedText={prefixProxyUpdatedText}
        dirty={prefixProxyDirty}
        onClose={closePrefixProxyEditor}
        onCopyText={copyTextWithNotification}
        onSave={handlePrefixProxySave}
        onChange={handlePrefixProxyChange}
      />

      <Modal
        open={Boolean(priorityRotationDetailTier)}
        title={
          <span className={styles.priorityRotationTierDetailTitle}>
            {priorityRotationDetailTitle}
          </span>
        }
        onClose={() => setPriorityRotationDetailTier(null)}
        width={720}
        className={styles.priorityRotationTierModal}
        overlayClassName={styles.priorityRotationOverlay}
      >
        <div className={styles.priorityRotationTierDetail}>
          <div className={styles.priorityRotationTierDetailSummary}>
            <div className={styles.priorityRotationTierDetailMetric}>
              <span>
                {t('auth_files.priority_rotation_detail_accounts', { defaultValue: '账号' })}
              </span>
              <strong>{priorityRotationDetailItems.length}</strong>
            </div>
            <div className={styles.priorityRotationTierDetailMetric}>
              <span>{t('auth_files.priority_rotation_col_priority')}</span>
              <strong>{formatPriorityRotationPriority(priorityRotationDetailPriority)}</strong>
            </div>
            <div className={styles.priorityRotationTierDetailMetric}>
              <span>{t('auth_files.priority_rotation_threshold_label')}</span>
              <strong>
                {t('auth_files.priority_rotation_detail_threshold_value', {
                  threshold: priorityRotationAnalysis.effectiveThresholdPercent,
                  defaultValue: `${priorityRotationAnalysis.effectiveThresholdPercent}%`,
                })}
              </strong>
            </div>
          </div>

          {priorityRotationDetailItems.length === 0 ? (
            <div className={styles.priorityRotationTierDetailEmpty}>
              {t('auth_files.priority_rotation_detail_empty', {
                tier: priorityRotationDetailTierLabel,
                defaultValue: `这一级还没有可工作的 ${priorityRotationDetailTierLabel} 账号。`,
              })}
            </div>
          ) : (
            <div className={styles.priorityRotationTierDetailList}>
              {priorityRotationDetailItems.map((item) => (
                <div className={styles.priorityRotationTierDetailRow} key={item.name}>
                  <div className={styles.priorityRotationTierDetailIdentity}>
                    <span
                      className={styles.priorityRotationTierDetailName}
                      title={item.displayName}
                    >
                      {item.displayName}
                    </span>
                    <span className={styles.priorityRotationTierDetailFile} title={item.name}>
                      {item.name}
                    </span>
                  </div>
                  <div className={styles.priorityRotationTierDetailFacts}>
                    <span className={styles.priorityRotationTierDetailFact}>
                      <span>
                        {t('auth_files.priority_rotation_detail_plan', { defaultValue: '计划' })}
                      </span>
                      <strong>{item.planLabel}</strong>
                    </span>
                    <span
                      className={`${styles.priorityRotationTierDetailFact} ${
                        item.quotaStatusTone === 'ready'
                          ? styles.priorityRotationTierDetailFactReady
                          : item.quotaStatusTone === 'warning'
                            ? styles.priorityRotationTierDetailFactWarning
                            : styles.priorityRotationTierDetailFactMuted
                      }`}
                      title={item.quotaStatusLabel}
                    >
                      <span>{t('auth_files.priority_rotation_col_remaining')}</span>
                      <strong>{item.fiveHourRemainingLabel}</strong>
                    </span>
                    <span className={styles.priorityRotationTierDetailFact}>
                      <span>
                        {t('auth_files.priority_rotation_detail_min_remaining', {
                          defaultValue: '最低',
                        })}
                      </span>
                      <strong>{item.minRemainingLabel}</strong>
                    </span>
                    <span className={styles.priorityRotationTierDetailFact}>
                      <span>
                        {t('auth_files.priority_rotation_detail_reset', { defaultValue: '重置' })}
                      </span>
                      <strong>{item.resetLabel}</strong>
                    </span>
                    <span className={styles.priorityRotationTierDetailFact}>
                      <span>
                        {t('auth_files.priority_rotation_detail_subscription', {
                          defaultValue: '订阅',
                        })}
                      </span>
                      <strong>{item.subscriptionLabel}</strong>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={Boolean(manualExpiryEditorFile)}
        title={
          <span className={styles.manualExpiryModalTitle}>
            {t('auth_files.manual_expiry_title', { defaultValue: '手动有效期' })}
          </span>
        }
        onClose={closeManualExpiryEditor}
        width={460}
        className={styles.manualExpiryModal}
        overlayClassName={styles.manualExpiryOverlay}
        footer={
          <div className={styles.manualExpiryFooter}>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearManualExpiry}
              disabled={!manualExpiryEditorExistingMs}
            >
              {t('auth_files.manual_expiry_clear', { defaultValue: '清除' })}
            </Button>
            <Button variant="secondary" size="sm" onClick={closeManualExpiryEditor}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={saveManualExpiry}>
              {t('common.save')}
            </Button>
          </div>
        }
      >
        <div className={styles.manualExpiryEditor}>
          <div className={styles.manualExpiryTarget} title={manualExpiryEditorFile?.name}>
            {manualExpiryEditorDisplayName}
          </div>
          <div className={styles.manualExpiryFields}>
            <label className={styles.manualExpiryField}>
              <span>{t('auth_files.manual_expiry_date', { defaultValue: '日期' })}</span>
              <input
                type="date"
                value={manualExpiryDateInput}
                onChange={(event) => setManualExpiryDateInput(event.currentTarget.value)}
              />
            </label>
            <label className={styles.manualExpiryField}>
              <span>{t('auth_files.manual_expiry_time', { defaultValue: '时间' })}</span>
              <input
                type="time"
                value={manualExpiryTimeInput}
                onChange={(event) => setManualExpiryTimeInput(event.currentTarget.value)}
              />
            </label>
          </div>
          <div className={styles.manualExpiryHint}>
            {t('auth_files.manual_expiry_hint', {
              defaultValue: '只保存在当前浏览器，用于卡片显示、排序和提醒，不会修改认证文件。',
            })}
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(priorityRotationPreview)}
        title={t('auth_files.priority_rotation_modal_title')}
        onClose={closePriorityRotationPreview}
        width={760}
        className={styles.priorityRotationModal}
        overlayClassName={styles.priorityRotationOverlay}
        footer={
          <div className={styles.priorityRotationFooter}>
            <div className={styles.priorityRotationFooterHint}>
              <IconInfo size={15} aria-hidden="true" />
              <span>{t('auth_files.priority_rotation_hint')}</span>
            </div>
            <div className={styles.priorityRotationFooterActions}>
              <Button variant="secondary" size="sm" onClick={closePriorityRotationPreview}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => void applyPriorityRotation()}
                disabled={!priorityRotationPreview?.changes.length || batchPriorityUpdating}
                loading={batchPriorityUpdating}
              >
                {t('auth_files.priority_rotation_apply')}
              </Button>
            </div>
          </div>
        }
      >
        {priorityRotationPreview && (
          <div className={styles.priorityRotationPreview}>
            <div className={styles.priorityRotationSummary}>
              {priorityRotationPreviewSummaryItems.map((item) => (
                <div className={styles.priorityRotationSummaryItem} key={item.key}>
                  <span className={styles.priorityRotationSummaryLabel}>{item.label}</span>
                  <span className={styles.priorityRotationSummaryValue}>{item.value}</span>
                </div>
              ))}
            </div>
            <div className={styles.priorityRotationTable} role="table">
              <div className={styles.priorityRotationHeader} role="row">
                <span>{t('auth_files.priority_rotation_col_file')}</span>
                <span>{t('auth_files.priority_rotation_col_priority')}</span>
                <span>{t('auth_files.priority_rotation_col_remaining')}</span>
                <span>{t('auth_files.priority_rotation_col_reason')}</span>
              </div>
              {priorityRotationPreview.changes.map((change) => (
                <div className={styles.priorityRotationRow} role="row" key={change.name}>
                  <span className={styles.priorityRotationName} title={change.name}>
                    {change.displayName}
                  </span>
                  <span
                    className={`${styles.priorityRotationDirection} ${
                      change.role === 'demote'
                        ? styles.priorityRotationDirectionDemote
                        : styles.priorityRotationDirectionPromote
                    }`}
                  >
                    <span>P{change.fromPriority}</span>
                    <span aria-hidden="true">→</span>
                    <span>P{change.toPriority}</span>
                  </span>
                  <span className={styles.priorityRotationRemaining}>
                    {formatPriorityRotationPercent(change.remainingPercent)}
                  </span>
                  <span className={styles.priorityRotationReason}>
                    {getPriorityRotationChangeReason(change, priorityRotationPreview)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Modal>

      {batchActionBarVisible && typeof document !== 'undefined'
        ? createPortal(
            <div className={styles.batchActionContainer} ref={floatingBatchActionsRef}>
              <div className={styles.batchActionBar}>
                <div className={styles.batchActionLeft}>
                  <span className={styles.batchSelectionText}>
                    {t('auth_files.batch_selected', { count: selectionCount })}
                  </span>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => selectAllVisible(pageItems)}
                    disabled={selectablePageItems.length === 0}
                  >
                    {t('auth_files.batch_select_page')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => selectAllVisible(sorted)}
                    disabled={selectableFilteredItems.length === 0}
                  >
                    {t('auth_files.batch_select_filtered')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => invertVisibleSelection(pageItems)}
                    disabled={selectablePageItems.length === 0}
                  >
                    {t('auth_files.batch_invert_page')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={deselectAll}>
                    {t('auth_files.batch_deselect')}
                  </Button>
                </div>
                <div className={styles.batchActionRight}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void batchDownload(selectedNames)}
                    disabled={disableControls || selectedNames.length === 0}
                  >
                    {t('auth_files.batch_download')}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => batchSetStatus(selectedNames, true)}
                    disabled={batchStatusButtonsDisabled}
                  >
                    {t('auth_files.batch_enable')}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => batchSetStatus(selectedNames, false)}
                    disabled={batchStatusButtonsDisabled}
                  >
                    {t('auth_files.batch_disable')}
                  </Button>
                  <div className={styles.batchPriorityControl}>
                    <input
                      className={styles.batchPriorityInput}
                      type="number"
                      step={1}
                      inputMode="numeric"
                      value={batchPriorityInput}
                      onChange={(event) => setBatchPriorityInput(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          commitBatchPriority();
                        }
                      }}
                      placeholder={t('auth_files.batch_priority_placeholder')}
                      aria-label={t('auth_files.batch_priority_placeholder')}
                      disabled={batchPriorityButtonDisabled}
                    />
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={commitBatchPriority}
                      disabled={batchPriorityButtonDisabled}
                      loading={batchPriorityUpdating}
                    >
                      {t('auth_files.batch_priority')}
                    </Button>
                  </div>
                  <Button
                    variant="danger"
                    size="sm"
                    onClick={() => batchDelete(selectedNames)}
                    disabled={disableControls || selectedNames.length === 0}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}
