import { useCallback, useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { authFilesApi } from '@/services/api';
import { apiClient } from '@/services/api/client';
import { useNotificationStore } from '@/stores';
import type { AuthFileItem } from '@/types';
import { formatFileSize } from '@/utils/format';
import { MAX_AUTH_FILE_SIZE } from '@/utils/constants';
import { downloadBlob } from '@/utils/download';
import {
  formatAccessTokenExpiryIso,
  readCodexAuthTokenSnapshotFromRecord,
} from '@/utils/quota';
import {
  getTypeLabel,
  hasAuthFileStatusMessage,
  isRuntimeOnlyAuthFile,
  parsePriorityValue,
} from '@/features/authFiles/constants';
import {
  buildAuthFileDisplayNameLookup,
  getRememberedAuthFileDisplayName,
  rememberAuthFileDisplayName,
  rememberAuthFileDisplayNames,
  type AuthFileDisplayNameLookup,
} from '@/features/authFiles/displayNameMemory';

type DeleteAllOptions = {
  filter: string;
  problemOnly: boolean;
  disabledOnly: boolean;
  enabledOnly: boolean;
  onResetFilterToAll: () => void;
  onResetProblemOnly: () => void;
  onResetDisabledOnly: () => void;
  onResetEnabledOnly: () => void;
};

type UploadValidationRejectReason =
  | 'invalid_extension'
  | 'oversized'
  | 'invalid_json'
  | 'sub2api_export'
  | 'unsupported_auth_shape';

type UploadValidationResult =
  | {
      file: File;
      originalName: string;
      valid: true;
      missingRefreshToken: boolean;
      accessTokenExpiryKnown: boolean;
      displayNameLookup: AuthFileDisplayNameLookup;
    }
  | { file: File; valid: false; reason: UploadValidationRejectReason };

type ValidUploadValidationResult = Extract<UploadValidationResult, { valid: true }>;

type AuthFileDeleteFailure = { name: string; error: string };
export type AuthFilePriorityBatchChange = { name: string; priority: number };
export type AuthFilePriorityBatchOptions = { notify?: boolean };
export type AuthFilePriorityBatchResult = { successCount: number; failCount: number };
export type AuthFileUploadStage = 'idle' | 'validating' | 'uploading' | 'refreshing';
export type AuthFileBatchProgressPhase = 'idle' | 'status' | 'priority';
export type AuthFileUploadProgress = {
  stage: AuthFileUploadStage;
  total: number;
  accepted: number;
  rejected: number;
  uploaded: number;
};
export type AuthFileBatchProgress = {
  phase: AuthFileBatchProgressPhase;
  total: number;
  completed: number;
  success: number;
  failed: number;
};
type ApiErrorLike = Error & {
  status?: number;
};

type RestoreAuthFileDisplayNameMode = 'missing' | 'overwrite';

export type LoadAuthFilesOptions = {
  silent?: boolean;
  preserveExisting?: boolean;
  rememberDisplayNames?: boolean;
  restoreRememberedDisplayNames?: RestoreAuthFileDisplayNameMode;
  restoreDisplayNameFilter?: (file: AuthFileItem) => boolean;
};

export type LoadAuthFilesResult = AuthFileItem[] | null;

export type UseAuthFilesDataResult = {
  files: AuthFileItem[];
  selectedFiles: Set<string>;
  selectionCount: number;
  loading: boolean;
  error: string;
  uploading: boolean;
  uploadProgress: AuthFileUploadProgress;
  batchProgress: AuthFileBatchProgress;
  deleting: string | null;
  deletingAll: boolean;
  statusUpdating: Record<string, boolean>;
  batchStatusUpdating: boolean;
  priorityUpdating: Record<string, boolean>;
  batchPriorityUpdating: boolean;
  noteUpdating: Record<string, boolean>;
  fileInputRef: RefObject<HTMLInputElement | null>;
  loadFiles: (options?: LoadAuthFilesOptions) => Promise<LoadAuthFilesResult>;
  rememberDisplayNamesForFiles: (filesToRemember: AuthFileItem[]) => void;
  uploadAuthFiles: (filesToUpload: File[]) => Promise<void>;
  handleUploadClick: () => void;
  handleFileChange: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleDelete: (name: string) => void;
  handleDeleteAll: (options: DeleteAllOptions) => void;
  handleDownload: (name: string) => Promise<void>;
  handleStatusToggle: (item: AuthFileItem, enabled: boolean) => Promise<void>;
  handlePriorityChange: (item: AuthFileItem, priority: number) => Promise<void>;
  handleDisplayNameChange: (item: AuthFileItem, note: string) => Promise<boolean>;
  toggleSelect: (name: string) => void;
  selectAllVisible: (visibleFiles: AuthFileItem[]) => void;
  invertVisibleSelection: (visibleFiles: AuthFileItem[]) => void;
  deselectAll: () => void;
  batchDownload: (names: string[]) => Promise<void>;
  batchSetStatus: (names: string[], enabled: boolean) => Promise<void>;
  batchSetPriority: (names: string[], priority: number) => Promise<void>;
  batchSetPriorities: (
    changes: AuthFilePriorityBatchChange[],
    options?: AuthFilePriorityBatchOptions
  ) => Promise<AuthFilePriorityBatchResult>;
  batchDelete: (names: string[]) => void;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const AUTH_FILE_NOT_FOUND_PATTERN = /auth file not found/i;

const isAuthFileNotFoundMessage = (value: string): boolean =>
  AUTH_FILE_NOT_FOUND_PATTERN.test(value);

const IDLE_UPLOAD_PROGRESS: AuthFileUploadProgress = {
  stage: 'idle',
  total: 0,
  accepted: 0,
  rejected: 0,
  uploaded: 0,
};

const IDLE_BATCH_PROGRESS: AuthFileBatchProgress = {
  phase: 'idle',
  total: 0,
  completed: 0,
  success: 0,
  failed: 0,
};

const AUTH_FILE_BATCH_CONCURRENCY = 5;

const runConcurrentBatch = async <TItem, TResult>(
  items: TItem[],
  worker: (item: TItem, index: number) => Promise<TResult>,
  onSettled: (result: PromiseSettledResult<TResult>, index: number) => void,
  concurrency = AUTH_FILE_BATCH_CONCURRENCY
): Promise<PromiseSettledResult<TResult>[]> => {
  const results = new Array<PromiseSettledResult<TResult>>(items.length);
  let nextIndex = 0;

  const runNext = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;

      try {
        const value = await worker(items[index] as TItem, index);
        const result: PromiseFulfilledResult<TResult> = { status: 'fulfilled', value };
        results[index] = result;
        onSettled(result, index);
      } catch (reason) {
        const result: PromiseRejectedResult = { status: 'rejected', reason };
        results[index] = result;
        onSettled(result, index);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runNext())
  );
  return results;
};

const isAuthFileNotFoundError = (err: unknown): boolean => {
  if (typeof err === 'string') return isAuthFileNotFoundMessage(err);
  if (!err || typeof err !== 'object') return false;
  const error = err as ApiErrorLike;
  return error.status === 404 || isAuthFileNotFoundMessage(error.message || '');
};

const getAuthFileNotFoundFailureNames = (failures: AuthFileDeleteFailure[]): string[] =>
  failures
    .filter((failure) => isAuthFileNotFoundMessage(failure.error))
    .map((failure) => failure.name.trim())
    .filter(Boolean);

const getRealDeleteFailures = (failures: AuthFileDeleteFailure[]): AuthFileDeleteFailure[] =>
  failures.filter((failure) => !isAuthFileNotFoundMessage(failure.error));

const hasMeaningfulText = (value: unknown): boolean =>
  typeof value === 'string' ? value.trim().length > 0 : value != null;

const hasAnyMeaningfulField = (record: Record<string, unknown>, fields: string[]): boolean =>
  fields.some((field) => hasMeaningfulText(record[field]));

const isSub2ApiExport = (record: Record<string, unknown>): boolean =>
  hasMeaningfulText(record.accounts) &&
  hasMeaningfulText(record.proxies) &&
  hasMeaningfulText(record.exported_at);

const isGoogleServiceAccountJson = (record: Record<string, unknown>): boolean =>
  record.type === 'service_account' &&
  hasMeaningfulText(record.client_email) &&
  hasMeaningfulText(record.private_key);

const isCliProxyAuthFileJson = (record: Record<string, unknown>): boolean => {
  if (isSub2ApiExport(record)) return false;
  if (isGoogleServiceAccountJson(record)) return true;

  const hasToken = hasAnyMeaningfulField(record, [
    'access_token',
    'refresh_token',
    'id_token',
    'session_token',
  ]);
  const hasIdentity = hasAnyMeaningfulField(record, [
    'account_id',
    'chatgpt_account_id',
    'email',
    'name',
    'type',
    'provider',
    'plan_type',
    'chatgpt_plan_type',
  ]);

  return hasToken && hasIdentity;
};

const validateAuthFileUpload = async (file: File): Promise<UploadValidationResult> => {
  if (!file.name.toLowerCase().endsWith('.json')) {
    return { file, valid: false, reason: 'invalid_extension' };
  }
  if (file.size > MAX_AUTH_FILE_SIZE) {
    return { file, valid: false, reason: 'oversized' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text()) as unknown;
  } catch {
    return { file, valid: false, reason: 'invalid_json' };
  }

  if (!isRecord(parsed)) {
    return { file, valid: false, reason: 'unsupported_auth_shape' };
  }
  if (isSub2ApiExport(parsed)) {
    return { file, valid: false, reason: 'sub2api_export' };
  }
  if (!isCliProxyAuthFileJson(parsed)) {
    return { file, valid: false, reason: 'unsupported_auth_shape' };
  }

  const authTokenSnapshot = readCodexAuthTokenSnapshotFromRecord(parsed, {
    assumeComplete: true,
  });
  const missingRefreshToken =
    authTokenSnapshot.hasAccessToken && authTokenSnapshot.hasRefreshToken === false;
  const accessTokenExpiresAtMs = authTokenSnapshot.accessTokenExpiresAtMs;
  const accessTokenExpiryKnown =
    accessTokenExpiresAtMs !== null && Number.isFinite(accessTokenExpiresAtMs);

  if (missingRefreshToken && accessTokenExpiryKnown) {
    const normalizedAuthJson = {
      ...parsed,
      expired: formatAccessTokenExpiryIso(accessTokenExpiresAtMs),
    };

    return {
      file: new File([JSON.stringify(normalizedAuthJson, null, 2)], file.name, {
        type: file.type || 'application/json',
        lastModified: file.lastModified,
      }),
      originalName: file.name,
      valid: true,
      missingRefreshToken,
      accessTokenExpiryKnown,
      displayNameLookup: buildAuthFileDisplayNameLookup(normalizedAuthJson, file.name),
    };
  }

  return {
    file,
    originalName: file.name,
    valid: true,
    missingRefreshToken,
    accessTokenExpiryKnown,
    displayNameLookup: buildAuthFileDisplayNameLookup(parsed, file.name),
  };
};

const summarizeFileNames = (names: string[]): string => {
  const visibleNames = names.slice(0, 3).join(', ');
  return names.length > 3 ? `${visibleNames} +${names.length - 3}` : visibleNames;
};

const readAuthFileNote = (file: AuthFileItem, noteOverride?: string): string =>
  (noteOverride ?? (typeof file.note === 'string' ? file.note : '')).trim();

const rememberAuthFileDisplayNameWithIdentity = async (
  file: AuthFileItem,
  noteOverride?: string
): Promise<boolean> => {
  const note = readAuthFileNote(file, noteOverride);

  try {
    const authJson = await authFilesApi.downloadJsonObject(file.name);
    return rememberAuthFileDisplayName(
      file,
      note,
      buildAuthFileDisplayNameLookup(authJson, file.name)
    );
  } catch {
    return rememberAuthFileDisplayName(file, note);
  }
};

const rememberExistingDisplayNamesForUpload = async (
  currentFiles: AuthFileItem[],
  acceptedFiles: ValidUploadValidationResult[]
): Promise<void> => {
  if (currentFiles.length === 0 || acceptedFiles.length === 0) return;

  const currentFilesByName = new Map(currentFiles.map((file) => [file.name, file]));
  await Promise.all(
    acceptedFiles.map(async (upload) => {
      const currentFile = currentFilesByName.get(upload.originalName);
      if (!currentFile) return;

      const note = readAuthFileNote(currentFile);
      if (!note) return;
      await rememberAuthFileDisplayNameWithIdentity(currentFile, note);
    })
  );
};

type RestoreRememberedAuthFileDisplayNamesOptions = {
  files: AuthFileItem[];
  mode: RestoreAuthFileDisplayNameMode;
  shouldRestore?: (file: AuthFileItem) => boolean;
  lookupByName?: Map<string, AuthFileDisplayNameLookup>;
};

type RestoreRememberedAuthFileDisplayNamesResult = {
  files: AuthFileItem[];
  restoredCount: number;
  failedCount: number;
  skippedExistingCount: number;
};

const restoreRememberedAuthFileDisplayNames = async ({
  files,
  mode,
  shouldRestore,
  lookupByName,
}: RestoreRememberedAuthFileDisplayNamesOptions): Promise<RestoreRememberedAuthFileDisplayNamesResult> => {
  let nextFiles = files;
  let restoredCount = 0;
  let failedCount = 0;
  let skippedExistingCount = 0;

  for (const file of files) {
    if (shouldRestore && !shouldRestore(file)) continue;

    const lookup = lookupByName?.get(file.name);
    const existingNote = readAuthFileNote(file);
    if (existingNote && mode === 'missing') {
      skippedExistingCount++;
      rememberAuthFileDisplayName(file, existingNote, lookup);
      continue;
    }

    const rememberedNote = getRememberedAuthFileDisplayName(file, lookup);
    if (!rememberedNote) continue;

    if (existingNote === rememberedNote) {
      rememberAuthFileDisplayName(file, rememberedNote, lookup);
      continue;
    }

    try {
      await authFilesApi.patchFields(file.name, { note: rememberedNote });
      restoredCount++;
      nextFiles = nextFiles.map((item) =>
        item.name === file.name ? { ...item, note: rememberedNote } : item
      );
      rememberAuthFileDisplayName({ ...file, note: rememberedNote }, rememberedNote, lookup);
    } catch {
      failedCount++;
    }
  }

  return {
    files: nextFiles,
    restoredCount,
    failedCount,
    skippedExistingCount,
  };
};

export function useAuthFilesData(): UseAuthFilesDataResult {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] =
    useState<AuthFileUploadProgress>(IDLE_UPLOAD_PROGRESS);
  const [batchProgress, setBatchProgress] =
    useState<AuthFileBatchProgress>(IDLE_BATCH_PROGRESS);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState<Record<string, boolean>>({});
  const [batchStatusUpdating, setBatchStatusUpdating] = useState(false);
  const [priorityUpdating, setPriorityUpdating] = useState<Record<string, boolean>>({});
  const [batchPriorityUpdating, setBatchPriorityUpdating] = useState(false);
  const [noteUpdating, setNoteUpdating] = useState<Record<string, boolean>>({});
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const filesRef = useRef<AuthFileItem[]>([]);
  const loadFilesRequestSeqRef = useRef(0);
  const loadFilesLoadingSeqRef = useRef(0);
  const batchProgressRunRef = useRef(0);
  const batchStatusPendingRef = useRef(false);
  const batchPriorityPendingRef = useRef(false);
  const selectionCount = selectedFiles.size;

  const beginBatchProgress = useCallback((phase: Exclude<AuthFileBatchProgressPhase, 'idle'>, total: number) => {
    const runId = batchProgressRunRef.current + 1;
    batchProgressRunRef.current = runId;
    setBatchProgress({
      phase,
      total,
      completed: 0,
      success: 0,
      failed: 0,
    });
    return runId;
  }, []);

  const updateBatchProgress = useCallback((runId: number, succeeded: boolean) => {
    setBatchProgress((prev) => {
      if (batchProgressRunRef.current !== runId || prev.phase === 'idle') return prev;
      return {
        ...prev,
        completed: Math.min(prev.total, prev.completed + 1),
        success: prev.success + (succeeded ? 1 : 0),
        failed: prev.failed + (succeeded ? 0 : 1),
      };
    });
  }, []);

  const finishBatchProgress = useCallback((runId: number) => {
    if (batchProgressRunRef.current === runId) {
      setBatchProgress(IDLE_BATCH_PROGRESS);
    }
  }, []);

  const toggleSelect = useCallback((name: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const selectAllVisible = useCallback((visibleFiles: AuthFileItem[]) => {
    const nextSelected = visibleFiles
      .filter((file) => !isRuntimeOnlyAuthFile(file))
      .map((file) => file.name);
    if (nextSelected.length === 0) return;
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      nextSelected.forEach((name) => next.add(name));
      return next;
    });
  }, []);

  const invertVisibleSelection = useCallback((visibleFiles: AuthFileItem[]) => {
    const visibleNames = visibleFiles
      .filter((file) => !isRuntimeOnlyAuthFile(file))
      .map((file) => file.name);
    if (visibleNames.length === 0) return;

    setSelectedFiles((prev) => {
      const next = new Set(prev);
      visibleNames.forEach((name) => {
        if (next.has(name)) {
          next.delete(name);
        } else {
          next.add(name);
        }
      });
      return next;
    });
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedFiles(new Set());
  }, []);

  const applyDeletedFiles = useCallback((names: string[]) => {
    const deletedNames = Array.from(
      new Set(
        names
          .map((name) => name.trim())
          .filter(Boolean)
      )
    );
    if (deletedNames.length === 0) return;

    const deletedSet = new Set(deletedNames);
    setFiles((prev) => prev.filter((file) => !deletedSet.has(file.name)));
    setSelectedFiles((prev) => {
      if (prev.size === 0) return prev;
      let changed = false;
      const next = new Set<string>();
      prev.forEach((name) => {
        if (deletedSet.has(name)) {
          changed = true;
        } else {
          next.add(name);
        }
      });
      return changed ? next : prev;
    });
  }, []);

  useEffect(() => {
    filesRef.current = files;
    if (selectedFiles.size === 0) return;
    const existingNames = new Set(files.map((file) => file.name));
    setSelectedFiles((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((name) => {
        if (existingNames.has(name)) {
          next.add(name);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [files, selectedFiles.size]);

  const loadFiles = useCallback(
    async (options: LoadAuthFilesOptions = {}) => {
      const requestSeq = loadFilesRequestSeqRef.current + 1;
      loadFilesRequestSeqRef.current = requestSeq;
      if (!options.silent) {
        loadFilesLoadingSeqRef.current = requestSeq;
        setLoading(true);
      }
      setError('');
      try {
        const data = await authFilesApi.list();
        if (requestSeq !== loadFilesRequestSeqRef.current) return null;
        const nextFiles = data?.files || [];
        const resolvedFiles =
          options.preserveExisting && filesRef.current.length > 0 && nextFiles.length === 0
            ? filesRef.current
            : nextFiles;
        const finalFiles = options.restoreRememberedDisplayNames
          ? (
              await restoreRememberedAuthFileDisplayNames({
                files: resolvedFiles,
                mode: options.restoreRememberedDisplayNames,
                shouldRestore: options.restoreDisplayNameFilter,
              })
            ).files
          : resolvedFiles;
        if (requestSeq !== loadFilesRequestSeqRef.current) return null;
        if (options.rememberDisplayNames !== false) {
          rememberAuthFileDisplayNames(finalFiles);
        }
        filesRef.current = finalFiles;
        setFiles(finalFiles);
        return finalFiles;
      } catch (err: unknown) {
        if (requestSeq !== loadFilesRequestSeqRef.current) return null;
        const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
        setError(errorMessage);
        return null;
      } finally {
        if (!options.silent && requestSeq === loadFilesLoadingSeqRef.current) {
          setLoading(false);
        }
      }
    },
    [t]
  );

  const rememberDisplayNamesForFiles = useCallback((filesToRemember: AuthFileItem[]) => {
    filesToRemember.forEach((file) => {
      rememberAuthFileDisplayName(file, readAuthFileNote(file));
    });
  }, []);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const uploadAuthFiles = useCallback(
    async (filesToUpload: File[]) => {
      if (filesToUpload.length === 0) return;

      setUploading(true);
      setUploadProgress({
        stage: 'validating',
        total: filesToUpload.length,
        accepted: 0,
        rejected: 0,
        uploaded: 0,
      });
      try {
        const validationResults = await Promise.all(filesToUpload.map(validateAuthFileUpload));
        const acceptedFiles = validationResults.filter(
          (result): result is ValidUploadValidationResult => result.valid
        );
        const validFiles = acceptedFiles.map((result) => result.file);
        const rejectedByReason = validationResults.reduce<Record<UploadValidationRejectReason, string[]>>(
          (result, item) => {
            if (!item.valid) {
              result[item.reason].push(item.file.name);
            }
            return result;
          },
          {
            invalid_extension: [],
            oversized: [],
            invalid_json: [],
            sub2api_export: [],
            unsupported_auth_shape: [],
          }
        );

        setUploadProgress({
          stage: validFiles.length > 0 ? 'uploading' : 'validating',
          total: validationResults.length,
          accepted: validFiles.length,
          rejected: validationResults.length - validFiles.length,
          uploaded: 0,
        });

        if (rejectedByReason.invalid_extension.length > 0) {
          showNotification(
            t('auth_files.upload_error_json', {
              names: summarizeFileNames(rejectedByReason.invalid_extension),
            }),
            'error'
          );
        }
        if (rejectedByReason.oversized.length > 0) {
          showNotification(
            t('auth_files.upload_error_size', {
              maxSize: formatFileSize(MAX_AUTH_FILE_SIZE),
              names: summarizeFileNames(rejectedByReason.oversized),
            }),
            'error'
          );
        }
        if (rejectedByReason.invalid_json.length > 0) {
          showNotification(
            t('auth_files.upload_error_invalid_json', {
              names: summarizeFileNames(rejectedByReason.invalid_json),
            }),
            'error'
          );
        }
        if (rejectedByReason.sub2api_export.length > 0) {
          showNotification(
            t('auth_files.upload_error_sub2api', {
              names: summarizeFileNames(rejectedByReason.sub2api_export),
            }),
            'error'
          );
        }
        if (rejectedByReason.unsupported_auth_shape.length > 0) {
          showNotification(
            t('auth_files.upload_error_auth_shape', {
              names: summarizeFileNames(rejectedByReason.unsupported_auth_shape),
            }),
            'error'
          );
        }

        if (validFiles.length === 0) {
          return;
        }

        const rejectedCount = validationResults.length - validFiles.length;
        await rememberExistingDisplayNamesForUpload(files, acceptedFiles);
        const result = await authFilesApi.uploadFiles(validFiles);
        const successCount = result.uploaded;
        setUploadProgress({
          stage: 'refreshing',
          total: validationResults.length,
          accepted: validFiles.length,
          rejected: rejectedCount,
          uploaded: successCount,
        });

        if (successCount > 0) {
          const suffix = validFiles.length > 1 ? ` (${successCount}/${validFiles.length})` : '';
          const refreshed = await authFilesApi.list();
          const refreshedFiles = refreshed?.files || [];
          const refreshedNames = new Set(refreshedFiles.map((file) => file.name));
          const uploadedNames = result.files.length > 0 ? result.files : validFiles.map((file) => file.name);
          const uploadDisplayNameLookupByName = new Map<string, AuthFileDisplayNameLookup>();
          acceptedFiles.forEach((item) => {
            uploadDisplayNameLookupByName.set(item.originalName, item.displayNameLookup);
          });
          uploadedNames.forEach((name, index) => {
            const lookup = acceptedFiles[index]?.displayNameLookup;
            if (lookup) {
              uploadDisplayNameLookupByName.set(name, lookup);
            }
          });
          const unlistedNames = uploadedNames.filter((name) => !refreshedNames.has(name));
          const uploadedNameSet = new Set(uploadedNames);
          const missingRefreshWithExpiry = acceptedFiles
            .filter(
              (item) =>
                uploadedNameSet.has(item.originalName) &&
                item.missingRefreshToken &&
                item.accessTokenExpiryKnown
            )
            .map((item) => item.originalName);
          const missingRefreshWithoutExpiry = acceptedFiles
            .filter(
              (item) =>
                uploadedNameSet.has(item.originalName) &&
                item.missingRefreshToken &&
                !item.accessTokenExpiryKnown
            )
            .map((item) => item.originalName);

          const displayNameRestore = await restoreRememberedAuthFileDisplayNames({
            files: refreshedFiles,
            mode: 'missing',
            shouldRestore: (file) => uploadedNameSet.has(file.name),
            lookupByName: uploadDisplayNameLookupByName,
          });
          const nextRefreshedFiles = displayNameRestore.files;
          const restoredDisplayNameCount = displayNameRestore.restoredCount;
          const restoreDisplayNameFailedCount = displayNameRestore.failedCount;
          const skippedExistingDisplayNameCount = displayNameRestore.skippedExistingCount;

          rememberAuthFileDisplayNames(nextRefreshedFiles);
          setFiles(nextRefreshedFiles);
          showNotification(
            `${t(rejectedCount > 0 ? 'auth_files.upload_partial_format' : 'auth_files.upload_success')}${suffix}`,
            result.failed.length || rejectedCount > 0 ? 'warning' : 'success'
          );

          if (restoredDisplayNameCount > 0 && restoreDisplayNameFailedCount === 0) {
            showNotification(
              t('auth_files.display_name_restore_success', {
                count: restoredDisplayNameCount,
              }),
              'success'
            );
          } else if (restoredDisplayNameCount > 0 || restoreDisplayNameFailedCount > 0) {
            showNotification(
              t(
                restoredDisplayNameCount > 0
                  ? 'auth_files.display_name_restore_partial'
                  : 'auth_files.display_name_restore_failed',
                {
                  success: restoredDisplayNameCount,
                  failed: restoreDisplayNameFailedCount,
                }
              ),
              restoreDisplayNameFailedCount > 0 ? 'warning' : 'success'
            );
          } else if (skippedExistingDisplayNameCount > 0) {
            showNotification(
              t('auth_files.display_name_restore_skipped_existing', {
                count: skippedExistingDisplayNameCount,
              }),
              'info'
            );
          }

          if (unlistedNames.length > 0) {
            showNotification(
              t('auth_files.upload_unlisted_warning', {
                names: summarizeFileNames(unlistedNames),
              }),
              'warning'
            );
          }
          if (missingRefreshWithExpiry.length > 0) {
            showNotification(
              t('auth_files.upload_missing_refresh_token_expiry_known', {
                names: summarizeFileNames(missingRefreshWithExpiry),
              }),
              'warning'
            );
          }
          if (missingRefreshWithoutExpiry.length > 0) {
            showNotification(
              t('auth_files.upload_missing_refresh_token_expiry_unknown', {
                names: summarizeFileNames(missingRefreshWithoutExpiry),
              }),
              'warning'
            );
          }
        }

        if (result.failed.length > 0) {
          const details = result.failed
            .map((item) => `${item.name}: ${item.error}`)
            .join('; ');
          showNotification(`${t('notification.upload_failed')}: ${details}`, 'error');
        }
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        showNotification(`${t('notification.upload_failed')}: ${errorMessage}`, 'error');
      } finally {
        setUploading(false);
        setUploadProgress(IDLE_UPLOAD_PROGRESS);
      }
    },
    [files, showNotification, t]
  );

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const fileList = event.target.files;
      if (!fileList || fileList.length === 0) return;

      try {
        await uploadAuthFiles(Array.from(fileList));
      } finally {
        event.target.value = '';
      }
    },
    [uploadAuthFiles]
  );

  const handleDelete = useCallback(
    (name: string) => {
      showConfirmation({
        title: t('auth_files.delete_title', { defaultValue: 'Delete File' }),
        message: `${t('auth_files.delete_confirm')} "${name}" ?`,
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          setDeleting(name);
          try {
            const result = await authFilesApi.deleteFile(name);
            const staleNames = getAuthFileNotFoundFailureNames(result.failed);
            const realFailures = getRealDeleteFailures(result.failed);
            const deletedNames =
              result.files.length > 0 || staleNames.length > 0 || realFailures.length > 0
                ? result.files
                : [name];

            applyDeletedFiles([...deletedNames, ...staleNames]);
            if (realFailures.length > 0) {
              showNotification(
                `${t('notification.delete_failed')}: ${realFailures[0].error}`,
                'error'
              );
            } else if (staleNames.length > 0) {
              showNotification(t('auth_files.delete_stale_removed'), 'info');
            } else {
              showNotification(t('auth_files.delete_success'), 'success');
            }
          } catch (err: unknown) {
            if (isAuthFileNotFoundError(err)) {
              applyDeletedFiles([name]);
              showNotification(t('auth_files.delete_stale_removed'), 'info');
              return;
            }
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
          } finally {
            setDeleting(null);
          }
        },
      });
    },
    [applyDeletedFiles, showConfirmation, showNotification, t]
  );

  const handleDeleteAll = useCallback(
    (deleteAllOptions: DeleteAllOptions) => {
      const {
        filter,
        problemOnly,
        disabledOnly,
        enabledOnly,
        onResetFilterToAll,
        onResetProblemOnly,
        onResetDisabledOnly,
        onResetEnabledOnly,
      } = deleteAllOptions;
      const isFiltered = filter !== 'all';
      const isProblemOnly = problemOnly === true;
      const isDisabledOnly = disabledOnly === true;
      const isEnabledOnly = enabledOnly === true;
      const isStatusFiltered = isDisabledOnly || isEnabledOnly;
      const typeLabel = isFiltered ? getTypeLabel(t, filter) : t('auth_files.filter_all');
      let confirmMessage = t('auth_files.delete_all_confirm');
      if (isStatusFiltered) {
        confirmMessage = t('auth_files.delete_filtered_result_confirm');
      } else if (isProblemOnly) {
        confirmMessage = isFiltered
          ? t('auth_files.delete_problem_filtered_confirm', { type: typeLabel })
          : t('auth_files.delete_problem_confirm');
      } else if (isFiltered) {
        confirmMessage = t('auth_files.delete_filtered_confirm', { type: typeLabel });
      }

      showConfirmation({
        title: t('auth_files.delete_all_title', { defaultValue: 'Delete All Files' }),
        message: confirmMessage,
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          setDeletingAll(true);
          try {
            if (!isFiltered && !isProblemOnly && !isStatusFiltered) {
              await authFilesApi.deleteAll();
              showNotification(t('auth_files.delete_all_success'), 'success');
              setFiles((prev) => prev.filter((file) => isRuntimeOnlyAuthFile(file)));
              deselectAll();
            } else {
              const filesToDelete = files.filter((file) => {
                if (isRuntimeOnlyAuthFile(file)) return false;
                if (isFiltered && file.type !== filter) return false;
                if (isProblemOnly && !hasAuthFileStatusMessage(file)) return false;
                if (isDisabledOnly && file.disabled !== true) return false;
                if (isEnabledOnly && file.disabled === true) return false;
                return true;
              });

              if (filesToDelete.length === 0) {
                let emptyMessage = t('auth_files.delete_filtered_none', { type: typeLabel });
                if (isStatusFiltered) {
                  emptyMessage = t('auth_files.delete_filtered_result_none');
                } else if (isProblemOnly) {
                  emptyMessage = isFiltered
                    ? t('auth_files.delete_problem_filtered_none', { type: typeLabel })
                    : t('auth_files.delete_problem_none');
                }
                showNotification(emptyMessage, 'info');
                setDeletingAll(false);
                return;
              }

              const result = await authFilesApi.deleteFiles(
                filesToDelete.map((file) => file.name)
              );
              const staleNames = getAuthFileNotFoundFailureNames(result.failed);
              const realFailures = getRealDeleteFailures(result.failed);
              const success = result.deleted + staleNames.length;
              const failed = realFailures.length;

              applyDeletedFiles([...result.files, ...staleNames]);
              if (staleNames.length > 0) {
                showNotification(
                  t('auth_files.delete_stale_removed_batch', { count: staleNames.length }),
                  'info'
                );
              }

              if (failed === 0 && isStatusFiltered) {
                showNotification(
                  t('auth_files.delete_filtered_result_success', { count: success }),
                  'success'
                );
              } else if (failed === 0 && isProblemOnly) {
                showNotification(
                  isFiltered
                    ? t('auth_files.delete_problem_filtered_success', {
                        count: success,
                        type: typeLabel,
                      })
                    : t('auth_files.delete_problem_success', { count: success }),
                  'success'
                );
              } else if (failed === 0) {
                showNotification(
                  t('auth_files.delete_filtered_success', { count: success, type: typeLabel }),
                  'success'
                );
              } else if (isStatusFiltered) {
                showNotification(
                  t('auth_files.delete_filtered_result_partial', { success, failed }),
                  'warning'
                );
              } else if (isProblemOnly) {
                showNotification(
                  isFiltered
                    ? t('auth_files.delete_problem_filtered_partial', {
                        success,
                        failed,
                        type: typeLabel,
                      })
                    : t('auth_files.delete_problem_partial', { success, failed }),
                  'warning'
                );
              } else {
                showNotification(
                  t('auth_files.delete_filtered_partial', { success, failed, type: typeLabel }),
                  'warning'
                );
              }

              if (isFiltered) {
                onResetFilterToAll();
              }
              if (isProblemOnly) {
                onResetProblemOnly();
              }
              if (isDisabledOnly) {
                onResetDisabledOnly();
              }
              if (isEnabledOnly) {
                onResetEnabledOnly();
              }
            }
          } catch (err: unknown) {
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
          } finally {
            setDeletingAll(false);
          }
        },
      });
    },
    [applyDeletedFiles, deselectAll, files, showConfirmation, showNotification, t]
  );

  const handleDownload = useCallback(
    async (name: string) => {
      try {
        const response = await apiClient.getRaw(
          `/auth-files/download?name=${encodeURIComponent(name)}`,
          { responseType: 'blob' }
        );
        const blob = new Blob([response.data]);
        downloadBlob({ filename: name, blob });
        showNotification(t('auth_files.download_success'), 'success');
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : '';
        showNotification(`${t('notification.download_failed')}: ${errorMessage}`, 'error');
      }
    },
    [showNotification, t]
  );

  const handleStatusToggle = useCallback(
    async (item: AuthFileItem, enabled: boolean) => {
      const name = item.name;
      const nextDisabled = !enabled;
      const previousDisabled = item.disabled === true;

      setStatusUpdating((prev) => ({ ...prev, [name]: true }));
      setFiles((prev) => prev.map((f) => (f.name === name ? { ...f, disabled: nextDisabled } : f)));

      try {
        const res = await authFilesApi.setStatus(name, nextDisabled);
        setFiles((prev) =>
          prev.map((f) => (f.name === name ? { ...f, disabled: res.disabled } : f))
        );
        showNotification(
          enabled
            ? t('auth_files.status_enabled_success', { name })
            : t('auth_files.status_disabled_success', { name }),
          'success'
        );
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : '';
        setFiles((prev) =>
          prev.map((f) => (f.name === name ? { ...f, disabled: previousDisabled } : f))
        );
        showNotification(`${t('notification.update_failed')}: ${errorMessage}`, 'error');
      } finally {
        setStatusUpdating((prev) => {
          if (!prev[name]) return prev;
          const next = { ...prev };
          delete next[name];
          return next;
        });
      }
    },
    [showNotification, t]
  );

  const handlePriorityChange = useCallback(
    async (item: AuthFileItem, priority: number) => {
      const name = item.name;
      const previousPriority = parsePriorityValue(item.priority ?? item['priority']);
      if ((previousPriority ?? 0) === (priority ?? 0)) return;

      setPriorityUpdating((prev) => ({ ...prev, [name]: true }));
      setFiles((prev) => prev.map((file) => (file.name === name ? { ...file, priority } : file)));

      try {
        await authFilesApi.patchFields(name, { priority });
        showNotification(t('auth_files.priority_save_success', { name, priority }), 'success');
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : '';
        setFiles((prev) =>
          prev.map((file) =>
            file.name === name ? { ...file, priority: item.priority ?? item['priority'] } : file
          )
        );
        showNotification(`${t('notification.update_failed')}: ${errorMessage}`, 'error');
      } finally {
        setPriorityUpdating((prev) => {
          if (!prev[name]) return prev;
          const next = { ...prev };
          delete next[name];
          return next;
        });
      }
    },
    [showNotification, t]
  );

  const handleDisplayNameChange = useCallback(
    async (item: AuthFileItem, note: string) => {
      const name = item.name;
      const previousNote = typeof item.note === 'string' ? item.note : '';
      const nextNote = note.trim();
      if (previousNote.trim() === nextNote) return true;

      setNoteUpdating((prev) => ({ ...prev, [name]: true }));
      setFiles((prev) =>
        prev.map((file) => (file.name === name ? { ...file, note: nextNote } : file))
      );

      try {
        await authFilesApi.patchFields(name, { note: nextNote });
        await rememberAuthFileDisplayNameWithIdentity({ ...item, note: nextNote }, nextNote);
        showNotification(
          nextNote
            ? t('auth_files.display_name_save_success', { name })
            : t('auth_files.display_name_clear_success', { name }),
          'success'
        );
        return true;
      } catch (err: unknown) {
        const errorMessage = err instanceof Error ? err.message : '';
        setFiles((prev) =>
          prev.map((file) => (file.name === name ? { ...file, note: previousNote } : file))
        );
        showNotification(`${t('notification.update_failed')}: ${errorMessage}`, 'error');
        return false;
      } finally {
        setNoteUpdating((prev) => {
          if (!prev[name]) return prev;
          const next = { ...prev };
          delete next[name];
          return next;
        });
      }
    },
    [showNotification, t]
  );

  const batchSetStatus = useCallback(
    async (names: string[], enabled: boolean) => {
      if (batchStatusPendingRef.current) return;

      const uniqueNamesSet = new Set(names);
      const uniqueNames = Array.from(uniqueNamesSet);
      if (uniqueNames.length === 0) return;
      if (uniqueNames.some((name) => statusUpdating[name] === true)) return;

      const originalDisabled = new Map(
        files
          .filter((file) => uniqueNamesSet.has(file.name))
          .map((file) => [file.name, file.disabled === true])
      );
      const targetNames = new Set(originalDisabled.keys());
      const targetNameList = Array.from(targetNames);
      if (targetNameList.length === 0) return;

      const nextDisabled = !enabled;

      batchStatusPendingRef.current = true;
      const progressRunId = beginBatchProgress('status', targetNameList.length);
      setBatchStatusUpdating(true);
      setStatusUpdating((prev) => {
        const next = { ...prev };
        targetNameList.forEach((name) => {
          next[name] = true;
        });
        return next;
      });
      setFiles((prev) =>
        prev.map((file) =>
          targetNames.has(file.name) ? { ...file, disabled: nextDisabled } : file
        )
      );

      try {
        const results = await runConcurrentBatch(
          targetNameList,
          (name) => authFilesApi.setStatus(name, nextDisabled),
          (result) => updateBatchProgress(progressRunId, result.status === 'fulfilled')
        );

        let successCount = 0;
        let failCount = 0;
        const failedNames = new Set<string>();
        const confirmedDisabled = new Map<string, boolean>();

        results.forEach((result, index) => {
          const name = targetNameList[index];
          if (result.status === 'fulfilled') {
            successCount++;
            confirmedDisabled.set(name, result.value.disabled);
          } else {
            failCount++;
            failedNames.add(name);
          }
        });

        setFiles((prev) =>
          prev.map((file) => {
            if (failedNames.has(file.name)) {
              return { ...file, disabled: originalDisabled.get(file.name) === true };
            }
            if (confirmedDisabled.has(file.name)) {
              return { ...file, disabled: confirmedDisabled.get(file.name) };
            }
            return file;
          })
        );

        if (failCount === 0) {
          showNotification(t('auth_files.batch_status_success', { count: successCount }), 'success');
        } else {
          showNotification(
            t('auth_files.batch_status_partial', { success: successCount, failed: failCount }),
            'warning'
          );
        }

        deselectAll();
      } finally {
        batchStatusPendingRef.current = false;
        setBatchStatusUpdating(false);
        finishBatchProgress(progressRunId);
        setStatusUpdating((prev) => {
          const next = { ...prev };
          targetNameList.forEach((name) => {
            delete next[name];
          });
          return next;
        });
      }
    },
    [
      beginBatchProgress,
      deselectAll,
      files,
      finishBatchProgress,
      showNotification,
      statusUpdating,
      t,
      updateBatchProgress,
    ]
  );

  const batchSetPriority = useCallback(
    async (names: string[], priority: number) => {
      if (batchPriorityPendingRef.current) return;

      const uniqueNamesSet = new Set(names);
      const originalPriorities = new Map(
        files
          .filter((file) => uniqueNamesSet.has(file.name))
          .map((file) => [file.name, file.priority ?? file['priority']])
      );
      const targetNameList = Array.from(originalPriorities.entries())
        .filter(([, rawPriority]) => (parsePriorityValue(rawPriority) ?? 0) !== priority)
        .map(([name]) => name);
      if (targetNameList.length === 0) return;
      if (targetNameList.some((name) => priorityUpdating[name] === true)) return;

      const targetNames = new Set(targetNameList);

      batchPriorityPendingRef.current = true;
      const progressRunId = beginBatchProgress('priority', targetNameList.length);
      setBatchPriorityUpdating(true);
      setPriorityUpdating((prev) => {
        const next = { ...prev };
        targetNameList.forEach((name) => {
          next[name] = true;
        });
        return next;
      });
      setFiles((prev) =>
        prev.map((file) => (targetNames.has(file.name) ? { ...file, priority } : file))
      );

      try {
        const results = await runConcurrentBatch(
          targetNameList,
          (name) => authFilesApi.patchFields(name, { priority }),
          (result) => updateBatchProgress(progressRunId, result.status === 'fulfilled')
        );

        let successCount = 0;
        let failCount = 0;
        const failedNames = new Set<string>();

        results.forEach((result, index) => {
          const name = targetNameList[index];
          if (result.status === 'fulfilled') {
            successCount++;
          } else {
            failCount++;
            failedNames.add(name);
          }
        });

        setFiles((prev) =>
          prev.map((file) =>
            failedNames.has(file.name)
              ? { ...file, priority: originalPriorities.get(file.name) }
              : file
          )
        );

        if (failCount === 0) {
          showNotification(
            t('auth_files.batch_priority_success', { count: successCount, priority }),
            'success'
          );
        } else {
          showNotification(
            t('auth_files.batch_priority_partial', {
              success: successCount,
              failed: failCount,
            }),
            'warning'
          );
        }

        deselectAll();
      } finally {
        batchPriorityPendingRef.current = false;
        setBatchPriorityUpdating(false);
        finishBatchProgress(progressRunId);
        setPriorityUpdating((prev) => {
          const next = { ...prev };
          targetNameList.forEach((name) => {
            delete next[name];
          });
          return next;
        });
      }
    },
    [
      beginBatchProgress,
      deselectAll,
      files,
      finishBatchProgress,
      priorityUpdating,
      showNotification,
      t,
      updateBatchProgress,
    ]
  );

  const batchSetPriorities = useCallback(
    async (
      changes: AuthFilePriorityBatchChange[],
      options: AuthFilePriorityBatchOptions = {}
    ): Promise<AuthFilePriorityBatchResult> => {
      if (batchPriorityPendingRef.current) return { successCount: 0, failCount: 0 };

      const changeMap = new Map<string, number>();
      changes.forEach((change) => {
        const name = change.name.trim();
        if (!name) return;
        changeMap.set(name, change.priority);
      });

      const targetNameList = Array.from(changeMap.keys());
      if (targetNameList.length === 0) return { successCount: 0, failCount: 0 };

      const targetNames = new Set(targetNameList);
      const originalPriorities = new Map(
        files
          .filter((file) => targetNames.has(file.name))
          .map((file) => [file.name, file.priority ?? file['priority']])
      );
      const existingTargetNameList = targetNameList.filter((name) => {
        if (!originalPriorities.has(name)) return false;
        const currentPriority = parsePriorityValue(originalPriorities.get(name));
        const nextPriority = changeMap.get(name) ?? 0;
        return (currentPriority ?? 0) !== nextPriority;
      });
      if (existingTargetNameList.length === 0) return { successCount: 0, failCount: 0 };
      if (existingTargetNameList.some((name) => priorityUpdating[name] === true)) {
        return { successCount: 0, failCount: existingTargetNameList.length };
      }
      const existingTargetNames = new Set(existingTargetNameList);

      batchPriorityPendingRef.current = true;
      const progressRunId = beginBatchProgress('priority', existingTargetNameList.length);
      setBatchPriorityUpdating(true);
      setPriorityUpdating((prev) => {
        const next = { ...prev };
        existingTargetNameList.forEach((name) => {
          next[name] = true;
        });
        return next;
      });
      setFiles((prev) =>
        prev.map((file) =>
          existingTargetNames.has(file.name)
            ? { ...file, priority: changeMap.get(file.name) }
            : file
        )
      );

      try {
        const results = await runConcurrentBatch(
          existingTargetNameList,
          (name) => authFilesApi.patchFields(name, { priority: changeMap.get(name) ?? 0 }),
          (result) => updateBatchProgress(progressRunId, result.status === 'fulfilled')
        );

        let successCount = 0;
        let failCount = 0;
        const failedNames = new Set<string>();

        results.forEach((result, index) => {
          const name = existingTargetNameList[index];
          if (result.status === 'fulfilled') {
            successCount++;
          } else {
            failCount++;
            failedNames.add(name);
          }
        });

        setFiles((prev) =>
          prev.map((file) =>
            failedNames.has(file.name)
              ? { ...file, priority: originalPriorities.get(file.name) }
              : file
          )
        );

        const shouldNotify = options.notify !== false;
        if (shouldNotify && successCount > 0 && failCount === 0) {
          showNotification(
            t('auth_files.priority_rotation_apply_success', { count: successCount }),
            'success'
          );
        } else if (shouldNotify && (successCount > 0 || failCount > 0)) {
          showNotification(
            t('auth_files.priority_rotation_apply_partial', {
              success: successCount,
              failed: failCount,
            }),
            failCount > 0 ? 'warning' : 'success'
          );
        }

        return { successCount, failCount };
      } finally {
        batchPriorityPendingRef.current = false;
        setBatchPriorityUpdating(false);
        finishBatchProgress(progressRunId);
        setPriorityUpdating((prev) => {
          const next = { ...prev };
          existingTargetNameList.forEach((name) => {
            delete next[name];
          });
          return next;
        });
      }
    },
    [
      beginBatchProgress,
      files,
      finishBatchProgress,
      priorityUpdating,
      showNotification,
      t,
      updateBatchProgress,
    ]
  );

  const batchDownload = useCallback(
    async (names: string[]) => {
      const uniqueNames = Array.from(new Set(names));
      if (uniqueNames.length === 0) return;

      let successCount = 0;
      let failCount = 0;

      for (const name of uniqueNames) {
        try {
          const response = await apiClient.getRaw(
            `/auth-files/download?name=${encodeURIComponent(name)}`,
            { responseType: 'blob' }
          );
          const blob = new Blob([response.data]);
          downloadBlob({ filename: name, blob });
          successCount++;
        } catch {
          failCount++;
        }
      }

      if (failCount === 0) {
        showNotification(
          t('auth_files.batch_download_success', { count: successCount }),
          'success'
        );
      } else {
        showNotification(
          t('auth_files.batch_download_partial', { success: successCount, failed: failCount }),
          'warning'
        );
      }
    },
    [showNotification, t]
  );

  const batchDelete = useCallback(
    (names: string[]) => {
      const uniqueNames = Array.from(new Set(names));
      if (uniqueNames.length === 0) return;

      showConfirmation({
        title: t('auth_files.batch_delete_title'),
        message: t('auth_files.batch_delete_confirm', { count: uniqueNames.length }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          try {
            const result = await authFilesApi.deleteFiles(uniqueNames);
            const staleNames = getAuthFileNotFoundFailureNames(result.failed);
            const realFailures = getRealDeleteFailures(result.failed);
            const clearedCount = result.deleted + staleNames.length;

            applyDeletedFiles([...result.files, ...staleNames]);
            if (staleNames.length > 0) {
              showNotification(
                t('auth_files.delete_stale_removed_batch', { count: staleNames.length }),
                'info'
              );
            }

            if (realFailures.length === 0) {
              showNotification(
                `${t('auth_files.delete_all_success')} (${clearedCount})`,
                'success'
              );
            } else {
              showNotification(
                t('auth_files.delete_filtered_partial', {
                  success: clearedCount,
                  failed: realFailures.length,
                  type: t('auth_files.filter_all'),
                }),
                'warning'
              );
            }
          } catch (err: unknown) {
            if (uniqueNames.length === 1 && isAuthFileNotFoundError(err)) {
              applyDeletedFiles(uniqueNames);
              showNotification(t('auth_files.delete_stale_removed'), 'info');
              return;
            }
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
          }
        },
      });
    },
    [applyDeletedFiles, showConfirmation, showNotification, t]
  );

  return {
    files,
    selectedFiles,
    selectionCount,
    loading,
    error,
    uploading,
    uploadProgress,
    batchProgress,
    deleting,
    deletingAll,
    statusUpdating,
    batchStatusUpdating,
    priorityUpdating,
    batchPriorityUpdating,
    noteUpdating,
    fileInputRef,
    loadFiles,
    rememberDisplayNamesForFiles,
    uploadAuthFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDeleteAll,
    handleDownload,
    handleStatusToggle,
    handlePriorityChange,
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
  };
}
