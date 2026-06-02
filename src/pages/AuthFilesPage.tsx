import {
  useCallback,
  type CSSProperties,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent as ReactClipboardEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { useInterval } from '@/hooks/useInterval';
import { useHeaderRefresh } from '@/hooks/useHeaderRefresh';
import { usePageTransitionLayer } from '@/components/common/PageTransitionLayer';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import {
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconEye,
  IconExternalLink,
  IconFilterAll,
  IconMinus,
  IconPlus,
  IconRefreshCw,
  IconSlidersHorizontal,
  IconTrash2,
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
import {
  useAuthFilesStatusBarCache,
  type AuthFileStatusBarData,
} from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
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
  AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES,
  getAuthFileAccountMemo,
  readAuthFilesAccountMemos,
  writeAuthFilesAccountMemos,
  type AuthFileAccountMemoImage,
  type AuthFilesAccountMemoMap,
} from '@/features/authFiles/accountMemos';
import {
  analyzeCodexPriorityRotation,
  normalizePriorityRotationActiveSlotLimit,
  normalizePriorityRotationNoStandbyThresholdDropPercent,
  normalizePriorityRotationThresholdPercent,
  PRIORITY_ROTATION_ACTIVE_PRIORITY,
  PRIORITY_ROTATION_BUFFER_PRIORITY,
  PRIORITY_ROTATION_MANUAL_LOCKED_MIN_PRIORITY,
  PRIORITY_ROTATION_STANDBY_PRIORITY,
} from '@/features/authFiles/priorityRotation';
import {
  clearAuthFilesTemporaryPriorityLock,
  readAuthFilesTemporaryPriorityLock,
  writeAuthFilesTemporaryPriorityLock,
  type AuthFilesTemporaryPriorityLockSnapshot,
} from '@/features/authFiles/temporaryPriorityLock';
import {
  launchPriorityRotationSidecar,
  priorityRotationSidecarApi,
  type PriorityRotationSidecarRequestError,
  type PriorityRotationSidecarSettings,
  type PriorityRotationSidecarStatus,
} from '@/services/api/priorityRotationSidecar';
import { oauthApi } from '@/services/api/oauth';
import { CODEX_CONFIG, useQuotaLoader } from '@/components/quota';
import { useAuthStore, useNotificationStore, useQuotaStore, useThemeStore } from '@/stores';
import type { AuthFileItem, CodexQuotaState } from '@/types';
import {
  normalizeRecentRequestAuthIndex,
  normalizeRecentRequestBuckets,
  statusBarDataFromRecentRequests,
} from '@/utils/recentRequests';
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
import { downloadBlob } from '@/utils/download';
import styles from './AuthFilesPage.module.scss';

const DEFAULT_REGULAR_PAGE_SIZE = 9;
const DEFAULT_COMPACT_PAGE_SIZE = 12;
const PRIORITY_ROTATION_THRESHOLD_STEP = 1;
const PRIORITY_ROTATION_NO_STANDBY_THRESHOLD_DROP_STEP = 1;
const PRIORITY_ROTATION_SLOT_STEP = 1;
const PRIORITY_ROTATION_SIDECAR_INTERVAL_STEP = 1;
const PRIORITY_ROTATION_WAKE_ATTEMPTS = 18;
const PRIORITY_ROTATION_WAKE_INTERVAL_MS = 900;
const ACCOUNT_MEMO_IMAGE_MAX_EDGE = 1200;
const ACCOUNT_MEMO_IMAGE_MAX_STORAGE_CHARS = 900 * 1024;
const ACCOUNT_MEMO_STORAGE_SOFT_LIMIT_CHARS = 4_000_000;
const ACCOUNT_MEMO_IMAGE_QUALITIES = [0.86, 0.78, 0.68, 0.58, 0.48] as const;
const ACCOUNT_MEMO_LINK_LIMIT = 8;
const CARD_FOCUS_BOTTOM_GAP = 8;
const CARD_FOCUS_HEADER_COMFORT_GAP = 28;
const CARD_FOCUS_HEADER_TUCK_LIMIT = 24;
const CARD_FOCUS_PREVIOUS_LINE_CLEARANCE = 2;
const CARD_FOCUS_HEADER_LINE_CLEARANCE = 2;
const AUTH_FILES_FOCUS_CARDS_EVENT = 'cpamc:auth-files-focus-cards';
const CODEX_OAUTH_SHORTCUT_WAIT_MS = 8 * 60 * 1000;
const CODEX_OAUTH_SHORTCUT_POLL_INTERVAL_MS = 3000;

const formatCodexOAuthShortcutRemaining = (remainingMs: number) => {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
};

const escapeHtml = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const htmlClosingTag = (tagName: string) => `<${['/', tagName].join('')}>`;

const writeExternalWaitingPage = (target: Window | null, title: string, description: string) => {
  if (!target || target.closed) return;

  try {
    target.document.open();
    target.document.write(`<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f8fafc; color: #0f172a; }
      main { width: min(420px, calc(100vw - 40px)); padding: 28px; border: 1px solid #dbeafe; border-radius: 18px; background: rgba(255,255,255,.9); box-shadow: 0 20px 55px rgba(15,23,42,.12); }
      h1 { margin: 0 0 10px; font-size: 18px; line-height: 1.3; }
      p { margin: 0; color: #475569; font-size: 14px; line-height: 1.7; }
      .bar { height: 4px; margin-top: 18px; overflow: hidden; border-radius: 999px; background: #e2e8f0; }
      .bar::before { content: ""; display: block; width: 38%; height: 100%; border-radius: inherit; background: linear-gradient(90deg, #0ea5e9, #14b8a6); animation: move 1.1s ease-in-out infinite alternate; }
      @keyframes move { from { transform: translateX(0); } to { transform: translateX(165%); } }
      @media (prefers-color-scheme: dark) {
        body { background: #020617; color: #e2e8f0; }
        main { border-color: #1e293b; background: rgba(15,23,42,.92); box-shadow: 0 20px 55px rgba(0,0,0,.28); }
        p { color: #94a3b8; }
        .bar { background: #1e293b; }
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(description)}</p>
      <div class="bar" aria-hidden="true"></div>
    </main>
  ${htmlClosingTag('body')}
${htmlClosingTag('html')}`);
    target.document.close();
  } catch {
    // Best effort only: cross-browser popup documents may be inaccessible.
  }
};
const ACCOUNT_MEMO_URL_PATTERN = /\b((?:https?:\/\/|www\.)[^\s<>"']+)/gi;
const ACCOUNT_MEMO_TRAILING_URL_PUNCTUATION = /[),.;:!?，。！？、；：）】》]+$/u;

const wait = (delayMs: number) => new Promise((resolve) => window.setTimeout(resolve, delayMs));

type AccountMemoImageMimeType = 'image/png' | 'image/jpeg';
type AccountMemoImageCandidate = {
  dataUrl: string;
  mimeType: AccountMemoImageMimeType;
  size: number;
  storageChars: number;
  width: number;
  height: number;
};
type AccountMemoLink = {
  label: string;
  href: string;
};
type AccountMemoPreviewBlock = {
  link: AccountMemoLink;
  copyText: string;
  startIndex: number;
};

const normalizeAccountMemoUrlCandidate = (value: string): AccountMemoLink | null => {
  let label = value.trim();
  while (ACCOUNT_MEMO_TRAILING_URL_PUNCTUATION.test(label)) {
    label = label.slice(0, -1);
  }
  if (!label) return null;

  const href = /^https?:\/\//i.test(label) ? label : `https://${label}`;
  try {
    const parsed = new URL(href);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return { label, href: parsed.href };
  } catch {
    return null;
  }
};

const parseAccountMemoPreviewBlocks = (text: string): AccountMemoPreviewBlock[] => {
  const matches = Array.from(text.matchAll(ACCOUNT_MEMO_URL_PATTERN)).map((match) => ({
    raw: match[1] ?? match[0],
    index: match.index ?? 0,
  }));
  const blocks: AccountMemoPreviewBlock[] = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const link = normalizeAccountMemoUrlCandidate(match.raw);
    if (!link) continue;
    const nextMatch = matches[index + 1];
    const contentStart = match.index + match.raw.length;
    const contentEnd = nextMatch?.index ?? text.length;
    const copyText = text.slice(contentStart, contentEnd).trim();
    blocks.push({
      link,
      copyText,
      startIndex: match.index,
    });
    if (blocks.length >= ACCOUNT_MEMO_LINK_LIMIT) break;
  }

  return blocks;
};

const createAccountMemoImageId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const estimateDataUrlBytes = (dataUrl: string): number => {
  const base64 = dataUrl.split(',')[1] ?? '';
  return Math.ceil((base64.length * 3) / 4);
};

const getAccountMemoImageExtension = (mimeType: string): 'png' | 'jpg' =>
  mimeType === 'image/jpeg' || mimeType === 'image/jpg' ? 'jpg' : 'png';

const getAccountMemoImageMimeType = (image: AuthFileAccountMemoImage): string => {
  const [, dataUrlMimeType = ''] =
    /^data:([^;,]+)[;,]/.exec(image.dataUrl) ?? ([] as unknown as [string, string]);
  return dataUrlMimeType || image.mimeType;
};

const isAccountMemoCompatibleImage = (image: AuthFileAccountMemoImage): boolean => {
  const mimeType = getAccountMemoImageMimeType(image);
  return mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/jpg';
};

const sanitizeAccountMemoImageName = (
  name: string,
  fallbackIndex: number,
  mimeType: string
): string => {
  const baseName = name.replace(/\.[^.]+$/, '').trim() || `account-memo-${fallbackIndex + 1}`;
  const safeBaseName =
    baseName
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || `account-memo-${fallbackIndex + 1}`;
  return `${safeBaseName}.${getAccountMemoImageExtension(mimeType)}`;
};

const loadImageFromFile = (file: File): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const objectUrl = window.URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      window.URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      window.URL.revokeObjectURL(objectUrl);
      reject(new Error('image-load-failed'));
    };
    image.src = objectUrl;
  });

const loadImageFromDataUrl = (dataUrl: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image-load-failed'));
    image.src = dataUrl;
  });

const drawAccountMemoImage = (
  source: HTMLImageElement,
  maxEdge: number
): { canvas: HTMLCanvasElement; width: number; height: number } => {
  const sourceWidth = source.naturalWidth || source.width;
  const sourceHeight = source.naturalHeight || source.height;
  if (sourceWidth <= 0 || sourceHeight <= 0) {
    throw new Error('image-load-failed');
  }

  const scale = Math.min(1, maxEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('image-load-failed');
  }

  context.drawImage(source, 0, 0, width, height);
  return { canvas, width, height };
};

const createAccountMemoJpegCanvas = (source: HTMLCanvasElement): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('image-load-failed');
  }

  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(source, 0, 0);
  return canvas;
};

const buildAccountMemoImageCandidate = (
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  mimeType: AccountMemoImageMimeType,
  quality?: number
): AccountMemoImageCandidate => {
  const dataUrl = canvas.toDataURL(mimeType, quality);
  const size = estimateDataUrlBytes(dataUrl);
  return {
    dataUrl,
    mimeType,
    size,
    storageChars: dataUrl.length,
    width,
    height,
  };
};

const toAccountMemoImage = (
  candidate: AccountMemoImageCandidate,
  name: string,
  fallbackIndex: number,
  options: Partial<Pick<AuthFileAccountMemoImage, 'id' | 'createdAt'>> = {}
): AuthFileAccountMemoImage => ({
  id: options.id || createAccountMemoImageId(),
  name: sanitizeAccountMemoImageName(name, fallbackIndex, candidate.mimeType),
  mimeType: candidate.mimeType,
  dataUrl: candidate.dataUrl,
  size: candidate.size,
  width: candidate.width,
  height: candidate.height,
  createdAt: options.createdAt || Date.now(),
});

const encodeAccountMemoImageSource = (source: HTMLImageElement): AccountMemoImageCandidate => {
  let maxEdge = ACCOUNT_MEMO_IMAGE_MAX_EDGE;
  let best: AccountMemoImageCandidate | null = null;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const { canvas, width, height } = drawAccountMemoImage(source, maxEdge);
    const pngCandidate = buildAccountMemoImageCandidate(canvas, width, height, 'image/png');
    if (!best || pngCandidate.storageChars < best.storageChars) {
      best = pngCandidate;
    }
    if (pngCandidate.storageChars <= ACCOUNT_MEMO_IMAGE_MAX_STORAGE_CHARS) {
      return pngCandidate;
    }

    const jpegCanvas = createAccountMemoJpegCanvas(canvas);
    for (const quality of ACCOUNT_MEMO_IMAGE_QUALITIES) {
      const jpegCandidate = buildAccountMemoImageCandidate(
        jpegCanvas,
        width,
        height,
        'image/jpeg',
        quality
      );

      if (!best || jpegCandidate.storageChars < best.storageChars) {
        best = jpegCandidate;
      }
      if (jpegCandidate.storageChars <= ACCOUNT_MEMO_IMAGE_MAX_STORAGE_CHARS) {
        return jpegCandidate;
      }
    }

    maxEdge = Math.max(420, Math.round(maxEdge * 0.76));
  }

  if (!best || best.storageChars > ACCOUNT_MEMO_IMAGE_MAX_STORAGE_CHARS) {
    throw new Error('image-too-large');
  }

  return best;
};

const compressAccountMemoImageFile = async (
  file: File,
  fallbackIndex: number
): Promise<AuthFileAccountMemoImage> => {
  if (!file.type.startsWith('image/')) {
    throw new Error('image-not-supported');
  }

  const source = await loadImageFromFile(file);
  return toAccountMemoImage(encodeAccountMemoImageSource(source), file.name, fallbackIndex);
};

const normalizeAccountMemoImageForDraft = async (
  image: AuthFileAccountMemoImage,
  fallbackIndex: number
): Promise<AuthFileAccountMemoImage> => {
  const mimeType = getAccountMemoImageMimeType(image);
  if (isAccountMemoCompatibleImage(image)) {
    return {
      ...image,
      mimeType: mimeType === 'image/jpg' ? 'image/jpeg' : mimeType,
      name: sanitizeAccountMemoImageName(image.name, fallbackIndex, mimeType),
    };
  }

  const source = await loadImageFromDataUrl(image.dataUrl);
  return toAccountMemoImage(encodeAccountMemoImageSource(source), image.name, fallbackIndex, {
    id: image.id,
    createdAt: image.createdAt || Date.now(),
  });
};

const dataUrlToFile = (image: AuthFileAccountMemoImage): File => {
  const [, mimeType = image.mimeType] =
    /^data:([^;,]+)[;,]/.exec(image.dataUrl) ?? ([] as unknown as [string, string]);
  const base64 = image.dataUrl.split(',')[1] ?? '';
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return new File([bytes], image.name, {
    type: mimeType,
    lastModified: image.createdAt || Date.now(),
  });
};

const escapeHtmlAttribute = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

const setAccountMemoImageDragData = (
  event: ReactDragEvent<HTMLElement>,
  image: AuthFileAccountMemoImage
) => {
  event.dataTransfer.effectAllowed = 'copy';
  let file: File | null = null;

  try {
    file = dataUrlToFile(image);
    event.dataTransfer.items.add(file);
  } catch {
    // Some drag targets only accept DownloadURL/text fallbacks.
  }

  const mimeType = file?.type || getAccountMemoImageMimeType(image) || image.mimeType;
  const name = file?.name || image.name;
  event.dataTransfer.setData('DownloadURL', `${mimeType}:${name}:${image.dataUrl}`);
  event.dataTransfer.setData('text/uri-list', image.dataUrl);
  event.dataTransfer.setData('text/plain', image.dataUrl);
  event.dataTransfer.setData(
    'text/html',
    `<img src="${escapeHtmlAttribute(image.dataUrl)}" alt="${escapeHtmlAttribute(name)}">`
  );
};

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
const formatRelativeDateTime = (
  value: string | null | undefined,
  options: { immediatePast?: string; immediateFuture?: string; pastFallback?: string } = {}
): string => {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';

  const diffMs = date.getTime() - Date.now();
  if (diffMs < 0 && options.pastFallback) return options.pastFallback;

  const absoluteMs = Math.abs(diffMs);
  if (absoluteMs < 60 * 1000) {
    return diffMs < 0
      ? (options.immediatePast ?? '1分钟前')
      : (options.immediateFuture ?? '1分钟后');
  }

  const units: Array<{ label: string; ms: number }> = [
    { label: '天', ms: 24 * 60 * 60 * 1000 },
    { label: '小时', ms: 60 * 60 * 1000 },
    { label: '分钟', ms: 60 * 1000 },
  ];
  const unit = units.find((item) => absoluteMs >= item.ms) ?? units[units.length - 1];
  const amount = Math.max(1, Math.round(absoluteMs / unit.ms));
  return `${amount}${unit.label}${diffMs < 0 ? '前' : '后'}`;
};
const normalizePriorityRotationSidecarInterval = (value: unknown): number => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 5;
  return Math.max(1, Math.min(180, Math.round(numeric)));
};
type AuthFilePriorityTier = 'active' | 'standby' | 'buffer' | 'manualLocked';
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
  | 'enabled'
  | 'thresholdPercent'
  | 'noStandbyThresholdDropPercent'
  | 'activeSlotLimit'
  | 'checkIntervalMinutes'
>;
type PriorityRotationSidecarSaveOptions = {
  notifyError?: boolean;
  committedDraftOnly?: boolean;
  forceDraft?: boolean;
  autoSave?: boolean;
  quietSaving?: boolean;
};
type PriorityRotationSidecarWakeOptions = {
  force?: boolean;
  notify?: boolean;
};

const DEFAULT_PRIORITY_ROTATION_SIDECAR_DRAFT: PriorityRotationSidecarDraftSettings = {
  enabled: false,
  thresholdPercent: 50,
  noStandbyThresholdDropPercent: 0,
  activeSlotLimit: 5,
  checkIntervalMinutes: 5,
};

const pickPriorityRotationSidecarDraft = (
  settings: PriorityRotationSidecarSettings
): PriorityRotationSidecarDraftSettings => ({
  enabled: settings.enabled === true,
  thresholdPercent: normalizePriorityRotationThresholdPercent(settings.thresholdPercent),
  noStandbyThresholdDropPercent: normalizePriorityRotationNoStandbyThresholdDropPercent(
    settings.noStandbyThresholdDropPercent
  ),
  activeSlotLimit: normalizePriorityRotationActiveSlotLimit(settings.activeSlotLimit),
  checkIntervalMinutes: normalizePriorityRotationSidecarInterval(settings.checkIntervalMinutes),
});

const isPriorityRotationSidecarOfflineError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  const normalized = message.toLowerCase();
  return (
    normalized.includes('failed to fetch') ||
    normalized.includes('fetch failed') ||
    normalized.includes('networkerror') ||
    normalized.includes('network request failed') ||
    normalized.includes('load failed') ||
    normalized.includes('connection refused') ||
    normalized.includes('err_connection_refused')
  );
};

const getPriorityRotationSidecarErrorStatus = (err: unknown): number | undefined =>
  err && typeof err === 'object'
    ? (err as Partial<PriorityRotationSidecarRequestError>).status
    : undefined;

const isPriorityRotationSidecarRevisionMismatchError = (err: unknown): boolean => {
  const message = err instanceof Error ? err.message : String(err);
  return (
    getPriorityRotationSidecarErrorStatus(err) === 409 &&
    message.toLowerCase().includes('revision mismatch')
  );
};

const isPriorityRotationSidecarDraftDirty = (
  draft: PriorityRotationSidecarDraftSettings,
  saved: PriorityRotationSidecarSettings | null | undefined
): boolean => {
  if (!saved) return false;
  return (
    draft.enabled !== saved.enabled ||
    draft.thresholdPercent !== saved.thresholdPercent ||
    draft.noStandbyThresholdDropPercent !==
      normalizePriorityRotationNoStandbyThresholdDropPercent(saved.noStandbyThresholdDropPercent) ||
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
  const { loadQuota: loadCodexQuota } = useQuotaLoader(CODEX_CONFIG);
  const pageTransitionLayer = usePageTransitionLayer();
  const isCurrentLayer = pageTransitionLayer ? pageTransitionLayer.status === 'current' : true;
  const navigate = useNavigate();
  const location = useLocation();

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
  const [accountMemosByFile, setAccountMemosByFile] = useState<AuthFilesAccountMemoMap>(() =>
    readAuthFilesAccountMemos()
  );
  const [accountMemoEditorFile, setAccountMemoEditorFile] = useState<AuthFileItem | null>(null);
  const [accountMemoDraft, setAccountMemoDraft] = useState('');
  const [accountMemoImagesDraft, setAccountMemoImagesDraft] = useState<AuthFileAccountMemoImage[]>(
    []
  );
  const [accountMemoImageProcessing, setAccountMemoImageProcessing] = useState(false);
  const [accountMemoPreviewImage, setAccountMemoPreviewImage] =
    useState<AuthFileAccountMemoImage | null>(null);
  const accountMemoImageSessionRef = useRef(0);
  const accountMemoImageProcessingRef = useRef(false);
  const [priorityRotationSettings, setPriorityRotationSettings] =
    useState<PriorityRotationSidecarDraftSettings>(DEFAULT_PRIORITY_ROTATION_SIDECAR_DRAFT);
  const [priorityRotationThresholdInput, setPriorityRotationThresholdInput] = useState(() =>
    String(priorityRotationSettings.thresholdPercent)
  );
  const [
    priorityRotationNoStandbyThresholdDropInput,
    setPriorityRotationNoStandbyThresholdDropInput,
  ] = useState(() => String(priorityRotationSettings.noStandbyThresholdDropPercent));
  const [priorityRotationSlotsInput, setPriorityRotationSlotsInput] = useState(() =>
    String(priorityRotationSettings.activeSlotLimit)
  );
  const [priorityRotationDetailTier, setPriorityRotationDetailTier] =
    useState<AuthFilePriorityTier | null>(null);
  const [priorityRotationPreviewOpen, setPriorityRotationPreviewOpen] = useState(false);
  const [priorityRotationPreviewApplying, setPriorityRotationPreviewApplying] = useState(false);
  const [temporaryPriorityLockSnapshot, setTemporaryPriorityLockSnapshot] =
    useState<AuthFilesTemporaryPriorityLockSnapshot | null>(() =>
      readAuthFilesTemporaryPriorityLock()
    );
  const [allPriorityP2Applying, setAllPriorityP2Applying] = useState(false);
  const [temporaryPriorityLockApplying, setTemporaryPriorityLockApplying] = useState(false);
  const [priorityRotationSidecarStatus, setPriorityRotationSidecarStatus] =
    useState<PriorityRotationSidecarStatus | null>(null);
  const [priorityRotationSidecarLoading, setPriorityRotationSidecarLoading] = useState(false);
  const [priorityRotationSidecarSaving, setPriorityRotationSidecarSaving] = useState(false);
  const [priorityRotationSidecarWaking, setPriorityRotationSidecarWaking] = useState(false);
  const [priorityRotationSidecarSecretSaving, setPriorityRotationSidecarSecretSaving] =
    useState(false);
  const [priorityRotationSidecarRunSaving, setPriorityRotationSidecarRunSaving] = useState(false);
  const [priorityRotationSidecarAutoSaving, setPriorityRotationSidecarAutoSaving] = useState(false);
  const [codexQuotaRefreshing, setCodexQuotaRefreshing] = useState(false);
  const [codexOAuthOpening, setCodexOAuthOpening] = useState(false);
  const [codexOAuthAttemptExpiresAt, setCodexOAuthAttemptExpiresAt] = useState<number | null>(
    null
  );
  const [codexOAuthNowMs, setCodexOAuthNowMs] = useState(() => Date.now());
  const [priorityRotationSidecarIntervalInput, setPriorityRotationSidecarIntervalInput] =
    useState('5');
  const [priorityRotationSidecarError, setPriorityRotationSidecarError] = useState('');
  const [uploadDropActive, setUploadDropActive] = useState(false);
  const [uiStateHydrated, setUiStateHydrated] = useState(false);
  const floatingBatchActionsRef = useRef<HTMLDivElement>(null);
  const fileListHeaderRef = useRef<HTMLDivElement>(null);
  const fileGridRef = useRef<HTMLDivElement>(null);
  const focusedFileListOnOpenRef = useRef('');
  const pageDragDepthRef = useRef(0);
  const loadedFilesOnceRef = useRef(false);
  const filesLengthRef = useRef(0);
  const priorityRotationSidecarDraftTouchedRef = useRef(false);
  const priorityRotationSidecarAutoSaveSignatureRef = useRef('');
  const priorityRotationSidecarAutoSaveFailedAtRef = useRef(0);
  const priorityRotationSidecarStatusRequestIdRef = useRef(0);
  const priorityRotationSidecarLastMutationRef = useRef('');
  const codexOAuthPollTimerRef = useRef<number | null>(null);
  const codexOAuthAttemptIdRef = useRef(0);
  const codexOAuthOpenRequestIdRef = useRef(0);

  const {
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

  const clearCodexOAuthPollTimer = useCallback(() => {
    if (codexOAuthPollTimerRef.current !== null) {
      window.clearInterval(codexOAuthPollTimerRef.current);
      codexOAuthPollTimerRef.current = null;
    }
  }, []);

  const finishCodexOAuthAttempt = useCallback(() => {
    clearCodexOAuthPollTimer();
    setCodexOAuthAttemptExpiresAt(null);
    setCodexOAuthNowMs(Date.now());
  }, [clearCodexOAuthPollTimer]);

  useEffect(() => {
    filesLengthRef.current = files.length;
  }, [files.length]);

  useEffect(() => {
    if (codexOAuthAttemptExpiresAt === null) return;

    const tick = () => setCodexOAuthNowMs(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [codexOAuthAttemptExpiresAt]);

  useEffect(() => {
    if (codexOAuthAttemptExpiresAt !== null && codexOAuthAttemptExpiresAt <= codexOAuthNowMs) {
      codexOAuthAttemptIdRef.current += 1;
      finishCodexOAuthAttempt();
    }
  }, [codexOAuthAttemptExpiresAt, codexOAuthNowMs, finishCodexOAuthAttempt]);

  useEffect(() => {
    return () => clearCodexOAuthPollTimer();
  }, [clearCodexOAuthPollTimer]);

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
  const codexOAuthRemainingMs = codexOAuthAttemptExpiresAt
    ? Math.max(0, codexOAuthAttemptExpiresAt - codexOAuthNowMs)
    : 0;
  const codexOAuthCountdownActive =
    codexOAuthAttemptExpiresAt !== null && codexOAuthRemainingMs > 0;
  const codexOAuthCountdownText = formatCodexOAuthShortcutRemaining(codexOAuthRemainingMs);
  const codexOAuthButtonLabel = codexOAuthCountdownActive
    ? t('auth_files.codex_oauth_reauth_countdown', {
        time: codexOAuthCountdownText,
        defaultValue: `重新认证 ${codexOAuthCountdownText}`,
      })
    : t('auth_files.codex_oauth_shortcut_compact', { defaultValue: '登录' });
  const codexOAuthButtonTitle = codexOAuthCountdownActive
    ? t('auth_files.codex_oauth_reauth_title', {
        time: codexOAuthCountdownText,
        defaultValue: `认证倒计时 ${codexOAuthCountdownText}，点击可重新认证`,
      })
    : t('auth_files.codex_oauth_shortcut_title', {
        defaultValue: '生成 Codex OAuth 授权链接并打开登录页',
      });
  const codexQuotaRefreshTargets = useMemo(
    () => files.filter((file) => CODEX_CONFIG.filterFn(file) && !isRuntimeOnlyAuthFile(file)),
    [files]
  );
  const setCodexQuotaRefreshLoading = useCallback((isLoading: boolean) => {
    setCodexQuotaRefreshing(isLoading);
  }, []);

  const startCodexOAuthPolling = useCallback(
    (state: string, attemptId: number) => {
      clearCodexOAuthPollTimer();

      const poll = async () => {
        try {
          const result = await oauthApi.getAuthStatus(state);
          if (codexOAuthAttemptIdRef.current !== attemptId) return;

          if (result.status === 'ok') {
            finishCodexOAuthAttempt();
            showNotification(
              t('auth_files.codex_oauth_success', { defaultValue: 'Codex 认证成功。' }),
              'success'
            );
            return;
          }

          if (result.status === 'error') {
            finishCodexOAuthAttempt();
            showNotification(
              t('auth_files.codex_oauth_status_error', {
                message: result.error || '',
                defaultValue: result.error
                  ? `Codex 认证失败：${result.error}`
                  : 'Codex 认证失败。',
              }),
              'error'
            );
          }
        } catch (err) {
          if (codexOAuthAttemptIdRef.current !== attemptId) return;
          const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
          finishCodexOAuthAttempt();
          showNotification(
            t('auth_files.codex_oauth_status_error', {
              message,
              defaultValue: message ? `Codex 认证失败：${message}` : 'Codex 认证失败。',
            }),
            'error'
          );
        }
      };

      codexOAuthPollTimerRef.current = window.setInterval(
        () => void poll(),
        CODEX_OAUTH_SHORTCUT_POLL_INTERVAL_MS
      );
    },
    [clearCodexOAuthPollTimer, finishCodexOAuthAttempt, showNotification, t]
  );

  const handleCancelCodexOAuth = useCallback(() => {
    codexOAuthOpenRequestIdRef.current += 1;
    codexOAuthAttemptIdRef.current += 1;
    setCodexOAuthOpening(false);
    finishCodexOAuthAttempt();
  }, [finishCodexOAuthAttempt]);

  const handleRefreshCodexQuota = useCallback(async () => {
    if (disableControls || codexQuotaRefreshing) return;

    if (codexQuotaRefreshTargets.length === 0) {
      showNotification(
        t('auth_files.quota_refresh_all_none', {
          defaultValue: '没有可刷新额度的 Codex 认证文件。',
        }),
        'info'
      );
      return;
    }

    const started = await loadCodexQuota(
      codexQuotaRefreshTargets,
      'all',
      setCodexQuotaRefreshLoading,
      { preserveExisting: true }
    );

    if (!started) {
      showNotification(
        t('auth_files.quota_refresh_all_busy', {
          defaultValue: '额度正在刷新，请稍等。',
        }),
        'info'
      );
      return;
    }

    const latestQuota = useQuotaStore.getState().codexQuota;
    const failed = codexQuotaRefreshTargets.filter(
      (file) => latestQuota[file.name]?.status === 'error'
    ).length;
    const success = codexQuotaRefreshTargets.length - failed;

    showNotification(
      t('auth_files.quota_refresh_all_done', {
        success,
        failed,
        defaultValue:
          failed > 0
            ? '额度刷新完成：{{success}} 个成功，{{failed}} 个失败。'
            : '已刷新 {{success}} 个 Codex 额度。',
      }),
      failed > 0 ? 'warning' : 'success'
    );
  }, [
    codexQuotaRefreshTargets,
    codexQuotaRefreshing,
    disableControls,
    loadCodexQuota,
    setCodexQuotaRefreshLoading,
    showNotification,
    t,
  ]);

  const handleOpenCodexOAuth = useCallback(async () => {
    if (disableControls || codexOAuthOpening) return;

    const openRequestId = codexOAuthOpenRequestIdRef.current + 1;
    codexOAuthOpenRequestIdRef.current = openRequestId;
    let authWindow: Window | null = null;
    if (typeof window !== 'undefined') {
      authWindow = window.open('about:blank', '_blank');
      if (authWindow) {
        authWindow.opener = null;
        writeExternalWaitingPage(
          authWindow,
          t('auth_files.codex_oauth_waiting_page_title', {
            defaultValue: '正在打开 Codex 登录...',
          }),
          t('auth_files.codex_oauth_waiting_page_desc', {
            defaultValue: '授权链接生成后会自动跳转，请稍候。',
          })
        );
      }
    }

    setCodexOAuthOpening(true);
    try {
      const response = await oauthApi.startAuth('codex');
      if (codexOAuthOpenRequestIdRef.current !== openRequestId) {
        if (authWindow && !authWindow.closed) {
          authWindow.close();
        }
        return;
      }
      if (!response.url) {
        throw new Error(t('auth_files.codex_oauth_missing_url', { defaultValue: '未返回授权链接' }));
      }

      let openedAuthPage = false;
      if (authWindow && !authWindow.closed) {
        try {
          authWindow.location.replace(response.url);
        } catch {
          authWindow.location.href = response.url;
        }
        openedAuthPage = true;
      } else {
        const opened = window.open(response.url, '_blank', 'noopener,noreferrer');
        if (!opened) {
          const copied = await copyToClipboard(response.url);
          showNotification(
            t('auth_files.codex_oauth_popup_blocked', {
              defaultValue: copied
                ? '浏览器拦截了新标签页，已复制 Codex 登录链接。'
                : '浏览器拦截了新标签页，请到 OAuth 登录页手动打开链接。',
            }),
            'warning'
          );
          return;
        }
        openedAuthPage = true;
      }

      if (openedAuthPage) {
        const now = Date.now();
        const attemptId = codexOAuthAttemptIdRef.current + 1;
        codexOAuthAttemptIdRef.current = attemptId;
        if (response.state) {
          startCodexOAuthPolling(response.state, attemptId);
        } else {
          clearCodexOAuthPollTimer();
        }
        setCodexOAuthNowMs(now);
        setCodexOAuthAttemptExpiresAt(now + CODEX_OAUTH_SHORTCUT_WAIT_MS);
      }

      showNotification(
        t('auth_files.codex_oauth_opened', { defaultValue: '已打开 Codex 登录页。' }),
        'success'
      );
    } catch (err) {
      if (codexOAuthOpenRequestIdRef.current !== openRequestId) return;
      if (authWindow && !authWindow.closed) {
        authWindow.close();
      }
      const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
      showNotification(
        t('auth_files.codex_oauth_open_failed', {
          message,
          defaultValue: message ? `打开 Codex 登录失败：${message}` : '打开 Codex 登录失败。',
        }),
        'error'
      );
    } finally {
      if (codexOAuthOpenRequestIdRef.current === openRequestId) {
        setCodexOAuthOpening(false);
      }
    }
  }, [
    clearCodexOAuthPollTimer,
    codexOAuthOpening,
    disableControls,
    showNotification,
    startCodexOAuthPolling,
    t,
  ]);

  const handleOpenAccountMemoLink = useCallback(
    async (href: string) => {
      if (typeof window === 'undefined') return;

      const externalWindow = window.open('about:blank', '_blank');
      if (externalWindow) {
        externalWindow.opener = null;
        writeExternalWaitingPage(
          externalWindow,
          t('auth_files.account_memo_external_waiting_page_title', {
            defaultValue: '正在打开链接...',
          }),
          t('auth_files.account_memo_external_waiting_page_desc', {
            defaultValue: '链接会自动跳转，请稍候。',
          })
        );
        try {
          externalWindow.location.replace(href);
        } catch {
          externalWindow.location.href = href;
        }
        return;
      }

      const opened = window.open(href, '_blank', 'noopener,noreferrer');
      if (!opened) {
        const copied = await copyToClipboard(href);
        showNotification(
          t('auth_files.account_memo_link_popup_blocked', {
            defaultValue: copied
              ? '浏览器拦截了新标签页，已复制链接。'
              : '浏览器拦截了新标签页，请手动复制链接。',
          }),
          'warning'
        );
      }
    },
    [showNotification, t]
  );
  const handleCopyAccountMemoPreviewText = useCallback(
    async (text: string) => {
      const copyText = text.trim();
      if (!copyText) return;

      const copied = await copyToClipboard(copyText);
      showNotification(
        copied
          ? t('auth_files.account_memo_copy_success', {
              defaultValue: '已复制可粘贴内容',
            })
          : t('auth_files.account_memo_copy_failed', {
              defaultValue: '复制失败',
            }),
        copied ? 'success' : 'error'
      );
    },
    [showNotification, t]
  );
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
  const priorityRotationEffectiveNoStandbyThresholdDropPercent =
    priorityRotationNoStandbyThresholdDropInput.trim()
      ? normalizePriorityRotationNoStandbyThresholdDropPercent(
          priorityRotationNoStandbyThresholdDropInput
        )
      : priorityRotationSettings.noStandbyThresholdDropPercent;
  const priorityRotationEffectiveActiveSlotLimit = priorityRotationSlotsInput.trim()
    ? normalizePriorityRotationActiveSlotLimit(priorityRotationSlotsInput)
    : priorityRotationSettings.activeSlotLimit;
  const priorityRotationAnalysis = useMemo(
    () =>
      analyzeCodexPriorityRotation(
        files,
        codexQuota,
        priorityRotationEffectiveThresholdPercent,
        priorityRotationEffectiveActiveSlotLimit,
        priorityRotationEffectiveNoStandbyThresholdDropPercent
      ),
    [
      codexQuota,
      files,
      priorityRotationEffectiveActiveSlotLimit,
      priorityRotationEffectiveNoStandbyThresholdDropPercent,
      priorityRotationEffectiveThresholdPercent,
    ]
  );
  const priorityRotationSidecarSettings = priorityRotationSidecarStatus?.settings ?? null;
  const priorityRotationSidecarCommittedDraftDirty = useMemo(() => {
    if (!priorityRotationSidecarSettings) return false;
    if (
      isPriorityRotationSidecarDraftDirty(priorityRotationSettings, priorityRotationSidecarSettings)
    ) {
      return true;
    }
    return normalizeApiBase(apiBase) !== normalizeApiBase(priorityRotationSidecarSettings.apiBase);
  }, [apiBase, priorityRotationSettings, priorityRotationSidecarSettings]);
  const priorityRotationSidecarInputDraftDirty = useMemo(() => {
    if (!priorityRotationSidecarSettings) return false;
    return (
      priorityRotationThresholdInput.trim() !== String(priorityRotationSettings.thresholdPercent) ||
      priorityRotationNoStandbyThresholdDropInput.trim() !==
        String(priorityRotationSettings.noStandbyThresholdDropPercent) ||
      priorityRotationSlotsInput.trim() !== String(priorityRotationSettings.activeSlotLimit) ||
      priorityRotationSidecarIntervalInput.trim() !==
        String(priorityRotationSettings.checkIntervalMinutes)
    );
  }, [
    priorityRotationSettings,
    priorityRotationNoStandbyThresholdDropInput,
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
      if (priority >= PRIORITY_ROTATION_MANUAL_LOCKED_MIN_PRIORITY) {
        tiers.set(file.name, 'manualLocked');
      } else if (priority === PRIORITY_ROTATION_ACTIVE_PRIORITY) {
        tiers.set(file.name, 'active');
      } else if (priority === PRIORITY_ROTATION_STANDBY_PRIORITY) {
        tiers.set(file.name, 'standby');
      } else if (priority === PRIORITY_ROTATION_BUFFER_PRIORITY) {
        tiers.set(file.name, 'buffer');
      }
    });
    return tiers;
  }, [files]);
  const temporaryPriorityLockTargetFiles = useMemo(
    () => files.filter((file) => !isRuntimeOnlyAuthFile(file) && file.disabled !== true),
    [files]
  );
  const temporaryPriorityLockActive = temporaryPriorityLockSnapshot !== null;
  const temporaryPriorityLockSnapshotCount = temporaryPriorityLockSnapshot
    ? Object.keys(temporaryPriorityLockSnapshot.priorities).length
    : 0;

  const stopUploadDropEvent = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const hasDraggedFiles = (event: ReactDragEvent<HTMLElement>) =>
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
    (event: ReactDragEvent<HTMLDivElement>) => {
      stopUploadDropEvent(event);
      if (!uploadDropDisabled && hasDraggedFiles(event)) {
        setUploadDropActive(true);
      }
    },
    [uploadDropDisabled]
  );

  const handleUploadPoolDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      stopUploadDropEvent(event);
      event.dataTransfer.dropEffect = uploadDropDisabled ? 'none' : 'copy';
      if (!uploadDropDisabled && hasDraggedFiles(event)) {
        setUploadDropActive(true);
      }
    },
    [uploadDropDisabled]
  );

  const handleUploadPoolDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    stopUploadDropEvent(event);
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setUploadDropActive(false);
  }, []);

  const handleUploadPoolDrop = useCallback(
    async (event: ReactDragEvent<HTMLDivElement>) => {
      stopUploadDropEvent(event);
      setUploadDropActive(false);
      if (uploadDropDisabled) return;

      const droppedFiles = Array.from(event.dataTransfer.files);
      await uploadAuthFiles(droppedFiles);
    },
    [uploadAuthFiles, uploadDropDisabled]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const hasGlobalDraggedFiles = (event: globalThis.DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files');

    const stopGlobalDropEvent = (event: globalThis.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
    };

    const handleWindowDragEnter = (event: globalThis.DragEvent) => {
      if (!hasGlobalDraggedFiles(event)) return;
      stopGlobalDropEvent(event);
      pageDragDepthRef.current += 1;
      if (!uploadDropDisabled) {
        setUploadDropActive(true);
      }
    };

    const handleWindowDragOver = (event: globalThis.DragEvent) => {
      if (!hasGlobalDraggedFiles(event)) return;
      stopGlobalDropEvent(event);
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = uploadDropDisabled ? 'none' : 'copy';
      }
      if (!uploadDropDisabled) {
        setUploadDropActive(true);
      }
    };

    const handleWindowDragLeave = (event: globalThis.DragEvent) => {
      if (!hasGlobalDraggedFiles(event)) return;
      stopGlobalDropEvent(event);
      pageDragDepthRef.current = Math.max(0, pageDragDepthRef.current - 1);
      if (pageDragDepthRef.current === 0) {
        setUploadDropActive(false);
      }
    };

    const handleWindowDrop = (event: globalThis.DragEvent) => {
      if (!hasGlobalDraggedFiles(event)) return;
      stopGlobalDropEvent(event);
      pageDragDepthRef.current = 0;
      setUploadDropActive(false);
      if (uploadDropDisabled) return;
      void uploadAuthFiles(Array.from(event.dataTransfer?.files ?? []));
    };

    window.addEventListener('dragenter', handleWindowDragEnter);
    window.addEventListener('dragover', handleWindowDragOver);
    window.addEventListener('dragleave', handleWindowDragLeave);
    window.addEventListener('drop', handleWindowDrop);

    return () => {
      window.removeEventListener('dragenter', handleWindowDragEnter);
      window.removeEventListener('dragover', handleWindowDragOver);
      window.removeEventListener('dragleave', handleWindowDragLeave);
      window.removeEventListener('drop', handleWindowDrop);
      pageDragDepthRef.current = 0;
    };
  }, [uploadAuthFiles, uploadDropDisabled]);

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
      const accountMemoText = getAuthFileAccountMemo(accountMemosByFile, item.name)?.text ?? '';
      const matchSearch =
        !normalizedSearch ||
        [item.name, item.type, item.provider, item.note, accountMemoText].some((value) => {
          const content = (value || '').toString();
          return wildcardSearch
            ? wildcardSearch.test(content)
            : content.toLowerCase().includes(normalizedTerm);
        });
      return matchType && matchSearch;
    });
  }, [accountMemosByFile, filesMatchingStatusFilters, filter, normalizedSearch, wildcardSearch]);

  const isExpirySortMode = sortMode === 'expiry_soon' || sortMode === 'expiry_long';
  const baseSorted = useMemo(() => {
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
    }
    return copy;
  }, [filtered, sortMode]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const start = (currentPage - 1) * pageSize;
  const codexSnapshotFiles = priorityRotationDetailTier
    ? files
    : isExpirySortMode
      ? filtered
      : baseSorted.slice(start, start + pageSize);
  const { authTokenSnapshots, subscriptionSnapshots: codexSubscriptionSnapshots } =
    useCodexAuthFileSnapshots(codexSnapshotFiles);

  const priorityRotationTierDetailGroups = useMemo(() => {
    const groups: Record<AuthFilePriorityTier, PriorityRotationTierDetailItem[]> = {
      active: [],
      standby: [],
      buffer: [],
      manualLocked: [],
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
    if (!isExpirySortMode) return baseSorted;

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
    return copy;
  }, [
    authTokenSnapshots,
    baseSorted,
    codexQuota,
    codexSubscriptionSnapshots,
    filtered,
    isExpirySortMode,
    manualExpiryByFile,
    sortMode,
  ]);

  const pageItems = useMemo(() => sorted.slice(start, start + pageSize), [sorted, start, pageSize]);
  const statusDataByFileName = useMemo(() => {
    const next = new Map<string, AuthFileStatusBarData>();

    pageItems.forEach((file) => {
      const rawAuthIndex = file['auth_index'] ?? file.authIndex;
      const authIndexKey = normalizeRecentRequestAuthIndex(rawAuthIndex);
      next.set(
        file.name,
        (authIndexKey && statusBarCache.get(authIndexKey)) ||
          statusBarDataFromRecentRequests(
            normalizeRecentRequestBuckets(file.recent_requests ?? file.recentRequests)
          )
      );
    });

    return next;
  }, [pageItems, statusBarCache]);
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
  const batchProgressLabel =
    batchProgress.phase === 'idle'
      ? ''
      : t('auth_files.batch_progress', {
          completed: batchProgress.completed,
          total: batchProgress.total,
          success: batchProgress.success,
          failed: batchProgress.failed,
          defaultValue: `${batchProgress.completed}/${batchProgress.total}`,
        });

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

  const openAccountMemoEditor = useCallback(
    (file: AuthFileItem) => {
      const memo = getAuthFileAccountMemo(accountMemosByFile, file.name);
      const images = memo?.images ?? [];
      accountMemoImageSessionRef.current += 1;
      const sessionId = accountMemoImageSessionRef.current;
      accountMemoImageProcessingRef.current = false;
      setAccountMemoImageProcessing(false);
      setAccountMemoEditorFile(file);
      setAccountMemoDraft(memo?.text ?? '');
      setAccountMemoImagesDraft(images);
      setAccountMemoPreviewImage(null);

      if (images.some((image) => !isAccountMemoCompatibleImage(image))) {
        accountMemoImageProcessingRef.current = true;
        setAccountMemoImageProcessing(true);
        void Promise.all(
          images.map(async (image, index) => {
            try {
              return await normalizeAccountMemoImageForDraft(image, index);
            } catch {
              return image;
            }
          })
        ).then((nextImages) => {
          if (accountMemoImageSessionRef.current !== sessionId) return;
          accountMemoImageProcessingRef.current = false;
          setAccountMemoImageProcessing(false);
          setAccountMemoImagesDraft(nextImages);
        });
      }
    },
    [accountMemosByFile]
  );

  const closeAccountMemoEditor = useCallback(() => {
    accountMemoImageSessionRef.current += 1;
    accountMemoImageProcessingRef.current = false;
    setAccountMemoEditorFile(null);
    setAccountMemoDraft('');
    setAccountMemoImagesDraft([]);
    setAccountMemoImageProcessing(false);
    setAccountMemoPreviewImage(null);
  }, []);

  const addAccountMemoImageFiles = useCallback(
    async (files: File[]) => {
      const imageFiles = files.filter((file) => file.type.startsWith('image/'));
      if (imageFiles.length === 0) return;

      if (accountMemoImageProcessingRef.current) {
        showNotification(
          t('auth_files.account_memo_image_processing', { defaultValue: '正在处理图片' }),
          'warning'
        );
        return;
      }

      const availableSlots = AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES - accountMemoImagesDraft.length;
      if (availableSlots <= 0) {
        showNotification(
          t('auth_files.account_memo_image_limit', {
            count: AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES,
            defaultValue: `每个账号备注最多保存 ${AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES} 张图片`,
          }),
          'warning'
        );
        return;
      }

      const sessionId = accountMemoImageSessionRef.current;
      accountMemoImageProcessingRef.current = true;
      setAccountMemoImageProcessing(true);
      const acceptedFiles = imageFiles.slice(0, availableSlots);
      const nextImages: AuthFileAccountMemoImage[] = [];
      let failed = false;

      for (const [index, file] of acceptedFiles.entries()) {
        try {
          nextImages.push(
            await compressAccountMemoImageFile(file, accountMemoImagesDraft.length + index)
          );
        } catch {
          failed = true;
        }

        if (accountMemoImageSessionRef.current !== sessionId) {
          return;
        }
      }

      if (accountMemoImageSessionRef.current !== sessionId) {
        return;
      }
      accountMemoImageProcessingRef.current = false;
      setAccountMemoImageProcessing(false);

      if (nextImages.length > 0) {
        setAccountMemoImagesDraft((current) =>
          [...current, ...nextImages].slice(0, AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES)
        );
      }

      if (imageFiles.length > availableSlots) {
        showNotification(
          t('auth_files.account_memo_image_limit', {
            count: AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES,
            defaultValue: `每个账号备注最多保存 ${AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES} 张图片`,
          }),
          'warning'
        );
      } else if (failed) {
        showNotification(
          t('auth_files.account_memo_image_add_failed', {
            defaultValue: '有图片无法处理，请换一张较小的图片再试',
          }),
          'error'
        );
      }
    },
    [accountMemoImagesDraft.length, showNotification, t]
  );

  const handleAccountMemoPaste = useCallback(
    (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData.items)
        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));

      if (files.length === 0) return;

      event.preventDefault();
      void addAccountMemoImageFiles(files);
    },
    [addAccountMemoImageFiles]
  );

  const removeAccountMemoImage = useCallback((imageId: string) => {
    setAccountMemoImagesDraft((current) => current.filter((image) => image.id !== imageId));
    setAccountMemoPreviewImage((current) => (current?.id === imageId ? null : current));
  }, []);

  const downloadAccountMemoImage = useCallback((image: AuthFileAccountMemoImage) => {
    try {
      downloadBlob({ filename: image.name, blob: dataUrlToFile(image) });
    } catch {
      showNotification(
        t('auth_files.account_memo_image_download_failed', {
          defaultValue: '图片数据已损坏，无法下载',
        }),
        'error'
      );
    }
  }, [showNotification, t]);

  const saveAccountMemo = useCallback(() => {
    if (!accountMemoEditorFile) return;

    const nextText = accountMemoDraft.trim();
    const nextImages = accountMemoImagesDraft.slice(0, AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES);
    const updatedAt = Date.now();
    const next = { ...accountMemosByFile };
    if (nextText || nextImages.length > 0) {
      next[accountMemoEditorFile.name] = { text: nextText, images: nextImages, updatedAt };
    } else {
      delete next[accountMemoEditorFile.name];
    }

    if (JSON.stringify(next).length > ACCOUNT_MEMO_STORAGE_SOFT_LIMIT_CHARS) {
      showNotification(
        t('auth_files.account_memo_save_failed', {
          defaultValue: '账号备注保存失败，可能是浏览器本地存储空间不足',
        }),
        'error'
      );
      return;
    }

    if (!writeAuthFilesAccountMemos(next)) {
      showNotification(
        t('auth_files.account_memo_save_failed', {
          defaultValue: '账号备注保存失败，可能是浏览器本地存储空间不足',
        }),
        'error'
      );
      return;
    }

    setAccountMemosByFile(next);
    showNotification(
      nextText || nextImages.length > 0
        ? t('auth_files.account_memo_saved', {
            name: accountMemoEditorFile.name,
            defaultValue: '已保存账号备注',
          })
        : t('auth_files.account_memo_cleared', {
            name: accountMemoEditorFile.name,
            defaultValue: '已清除账号备注',
          }),
      'success'
    );
    closeAccountMemoEditor();
  }, [
    accountMemoDraft,
    accountMemoEditorFile,
    accountMemoImagesDraft,
    accountMemosByFile,
    closeAccountMemoEditor,
    showNotification,
    t,
  ]);

  const clearAccountMemo = useCallback(() => {
    if (!accountMemoEditorFile) return;

    const next = { ...accountMemosByFile };
    delete next[accountMemoEditorFile.name];
    if (!writeAuthFilesAccountMemos(next)) {
      showNotification(
        t('auth_files.account_memo_save_failed', {
          defaultValue: '账号备注保存失败，可能是浏览器本地存储空间不足',
        }),
        'error'
      );
      return;
    }

    setAccountMemosByFile(next);
    showNotification(
      t('auth_files.account_memo_cleared', {
        name: accountMemoEditorFile.name,
        defaultValue: '已清除账号备注',
      }),
      'success'
    );
    closeAccountMemoEditor();
  }, [accountMemoEditorFile, accountMemosByFile, closeAccountMemoEditor, showNotification, t]);

  useEffect(() => {
    setPriorityRotationThresholdInput(String(priorityRotationSettings.thresholdPercent));
    setPriorityRotationNoStandbyThresholdDropInput(
      String(priorityRotationSettings.noStandbyThresholdDropPercent)
    );
    setPriorityRotationSlotsInput(String(priorityRotationSettings.activeSlotLimit));
  }, [
    priorityRotationSettings.activeSlotLimit,
    priorityRotationSettings.noStandbyThresholdDropPercent,
    priorityRotationSettings.thresholdPercent,
  ]);

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

  const commitPriorityRotationNoStandbyThresholdDropInput = useCallback(
    (value: string) => {
      const noStandbyThresholdDropPercent =
        normalizePriorityRotationNoStandbyThresholdDropPercent(value);
      setPriorityRotationNoStandbyThresholdDropInput(String(noStandbyThresholdDropPercent));
      updatePriorityRotationSettings({ noStandbyThresholdDropPercent });
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

  const handlePriorityRotationThresholdInputChange = useCallback(
    (value: string) => {
      setPriorityRotationThresholdInput(value);
      const trimmed = value.trim();
      if (!trimmed || !Number.isFinite(Number(trimmed))) {
        priorityRotationSidecarDraftTouchedRef.current = true;
        return;
      }
      updatePriorityRotationSettings({
        thresholdPercent: normalizePriorityRotationThresholdPercent(trimmed),
      });
    },
    [updatePriorityRotationSettings]
  );

  const handlePriorityRotationNoStandbyThresholdDropInputChange = useCallback(
    (value: string) => {
      setPriorityRotationNoStandbyThresholdDropInput(value);
      const trimmed = value.trim();
      if (!trimmed || !Number.isFinite(Number(trimmed))) {
        priorityRotationSidecarDraftTouchedRef.current = true;
        return;
      }
      updatePriorityRotationSettings({
        noStandbyThresholdDropPercent:
          normalizePriorityRotationNoStandbyThresholdDropPercent(trimmed),
      });
    },
    [updatePriorityRotationSettings]
  );

  const handlePriorityRotationSlotsInputChange = useCallback(
    (value: string) => {
      setPriorityRotationSlotsInput(value);
      const trimmed = value.trim();
      if (!trimmed || !Number.isFinite(Number(trimmed))) {
        priorityRotationSidecarDraftTouchedRef.current = true;
        return;
      }
      updatePriorityRotationSettings({
        activeSlotLimit: normalizePriorityRotationActiveSlotLimit(trimmed),
      });
    },
    [updatePriorityRotationSettings]
  );

  const handlePriorityRotationSidecarIntervalInputChange = useCallback(
    (value: string) => {
      setPriorityRotationSidecarIntervalInput(value);
      const trimmed = value.trim();
      if (!trimmed || !Number.isFinite(Number(trimmed))) {
        priorityRotationSidecarDraftTouchedRef.current = true;
        return;
      }
      updatePriorityRotationSettings({
        checkIntervalMinutes: normalizePriorityRotationSidecarInterval(trimmed),
      });
    },
    [updatePriorityRotationSettings]
  );

  const adjustPriorityRotationNoStandbyThresholdDrop = useCallback(
    (delta: number) => {
      const raw = priorityRotationNoStandbyThresholdDropInput.trim();
      const base = raw
        ? normalizePriorityRotationNoStandbyThresholdDropPercent(raw)
        : priorityRotationSettings.noStandbyThresholdDropPercent;
      const noStandbyThresholdDropPercent = normalizePriorityRotationNoStandbyThresholdDropPercent(
        base + delta
      );
      setPriorityRotationNoStandbyThresholdDropInput(String(noStandbyThresholdDropPercent));
      updatePriorityRotationSettings({ noStandbyThresholdDropPercent });
    },
    [
      priorityRotationNoStandbyThresholdDropInput,
      priorityRotationSettings.noStandbyThresholdDropPercent,
      updatePriorityRotationSettings,
    ]
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
      setPriorityRotationNoStandbyThresholdDropInput(
        String(nextDraft.noStandbyThresholdDropPercent)
      );
      setPriorityRotationSlotsInput(String(nextDraft.activeSlotLimit));
      setPriorityRotationSidecarIntervalInput(String(nextDraft.checkIntervalMinutes));
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
        setPriorityRotationSidecarStatus(null);
        setPriorityRotationSidecarError(silent ? '' : message);
      } finally {
        if (!silent && requestId === priorityRotationSidecarStatusRequestIdRef.current) {
          setPriorityRotationSidecarLoading(false);
        }
      }
    },
    [hydratePriorityRotationSidecarStatus]
  );

  const wakePriorityRotationSidecar = useCallback(
    async (options: PriorityRotationSidecarWakeOptions = {}) => {
      const notify = options.notify !== false;
      if (!options.force && priorityRotationSidecarStatus && !priorityRotationSidecarError) {
        return priorityRotationSidecarStatus;
      }

      setPriorityRotationSidecarWaking(true);
      setPriorityRotationSidecarError('');

      try {
        const launched = launchPriorityRotationSidecar();
        if (!launched) {
          const message = t('auth_files.priority_rotation_sidecar_wake_unavailable');
          setPriorityRotationSidecarError(message);
          if (notify) {
            showNotification(message, 'error');
          }
          return null;
        }

        let lastError = '';
        for (let attempt = 0; attempt < PRIORITY_ROTATION_WAKE_ATTEMPTS; attempt += 1) {
          await wait(attempt === 0 ? 650 : PRIORITY_ROTATION_WAKE_INTERVAL_MS);
          try {
            const status = await priorityRotationSidecarApi.getStatus();
            hydratePriorityRotationSidecarStatus(status);
            if (notify) {
              showNotification(t('auth_files.priority_rotation_sidecar_wake_success'), 'success');
            }
            return status;
          } catch (err) {
            lastError = err instanceof Error ? err.message : String(err);
          }
        }

        const message = t('auth_files.priority_rotation_sidecar_wake_failed', {
          message: lastError,
        });
        setPriorityRotationSidecarStatus(null);
        setPriorityRotationSidecarError(message);
        if (notify) {
          showNotification(message, 'error');
        }
        return null;
      } finally {
        setPriorityRotationSidecarWaking(false);
      }
    },
    [
      hydratePriorityRotationSidecarStatus,
      priorityRotationSidecarError,
      priorityRotationSidecarStatus,
      showNotification,
      t,
    ]
  );

  const requestPriorityRotationSidecarWithWakeRetry = useCallback(
    async <T,>(request: () => Promise<T>): Promise<T> => {
      try {
        return await request();
      } catch (err) {
        if (!isPriorityRotationSidecarOfflineError(err)) {
          throw err;
        }
        const status = await wakePriorityRotationSidecar({ force: true, notify: false });
        if (!status) {
          throw err;
        }
        return request();
      }
    },
    [wakePriorityRotationSidecar]
  );

  const buildPriorityRotationSidecarSettings = useCallback(
    (
      updates: Partial<PriorityRotationSidecarSettings> = {},
      options: Pick<PriorityRotationSidecarSaveOptions, 'committedDraftOnly'> & {
        revision?: number;
      } = {}
    ): Partial<PriorityRotationSidecarSettings> => ({
      enabled: priorityRotationSettings.enabled,
      apiBase: normalizeApiBase(apiBase),
      thresholdPercent: options.committedDraftOnly
        ? priorityRotationSettings.thresholdPercent
        : priorityRotationThresholdInput.trim()
          ? normalizePriorityRotationThresholdPercent(priorityRotationThresholdInput)
          : priorityRotationSettings.thresholdPercent,
      noStandbyThresholdDropPercent: options.committedDraftOnly
        ? priorityRotationSettings.noStandbyThresholdDropPercent
        : priorityRotationNoStandbyThresholdDropInput.trim()
          ? normalizePriorityRotationNoStandbyThresholdDropPercent(
              priorityRotationNoStandbyThresholdDropInput
            )
          : priorityRotationSettings.noStandbyThresholdDropPercent,
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
      revision: options.revision ?? priorityRotationSidecarSettings?.revision ?? 0,
    }),
    [
      apiBase,
      priorityRotationSettings.activeSlotLimit,
      priorityRotationSettings.checkIntervalMinutes,
      priorityRotationSettings.enabled,
      priorityRotationSettings.noStandbyThresholdDropPercent,
      priorityRotationSettings.thresholdPercent,
      priorityRotationNoStandbyThresholdDropInput,
      priorityRotationSidecarSettings?.revision,
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
        : options.quietSaving
          ? null
          : setPriorityRotationSidecarSaving;
      setSavingState?.(true);
      try {
        if (!priorityRotationSidecarStatus || priorityRotationSidecarError) {
          const status = await wakePriorityRotationSidecar();
          if (!status) return false;
        }
        const settings = buildPriorityRotationSidecarSettings(updates, {
          committedDraftOnly: options.committedDraftOnly,
        });
        const saveWithRevision = (revision?: number) =>
          priorityRotationSidecarApi.updateSettings(
            {
              ...settings,
              revision: revision ?? settings.revision,
            },
            managementKey
          );
        let result: Awaited<ReturnType<typeof saveWithRevision>>;
        try {
          result = await saveWithRevision();
        } catch (err) {
          let freshStatus: PriorityRotationSidecarStatus | null = null;
          if (isPriorityRotationSidecarOfflineError(err)) {
            freshStatus = await wakePriorityRotationSidecar({ force: true, notify: false });
          } else if (isPriorityRotationSidecarRevisionMismatchError(err)) {
            try {
              freshStatus = await priorityRotationSidecarApi.getStatus();
              hydratePriorityRotationSidecarStatus(freshStatus);
            } catch {
              freshStatus = null;
            }
          }

          if (!freshStatus) {
            throw err;
          }
          result = await saveWithRevision(freshStatus.settings.revision);
        }
        mergePriorityRotationSidecarResult(
          result.settings,
          result.state,
          options.forceDraft ?? true
        );
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
        setSavingState?.(false);
      }
    },
    [
      buildPriorityRotationSidecarSettings,
      hydratePriorityRotationSidecarStatus,
      managementKey,
      mergePriorityRotationSidecarResult,
      priorityRotationSidecarError,
      priorityRotationSidecarStatus,
      showNotification,
      t,
      wakePriorityRotationSidecar,
    ]
  );

  const savePriorityRotationSidecarSecret = useCallback(async () => {
    if (!managementKey) {
      showNotification(t('auth_files.priority_rotation_sidecar_missing_login'), 'error');
      return;
    }
    setPriorityRotationSidecarSecretSaving(true);
    try {
      if (!priorityRotationSidecarStatus || priorityRotationSidecarError) {
        const status = await wakePriorityRotationSidecar();
        if (!status) return;
      }
      const result = await requestPriorityRotationSidecarWithWakeRetry(() =>
        priorityRotationSidecarApi.saveSecret(managementKey, normalizeApiBase(apiBase))
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
      setPriorityRotationSidecarSecretSaving(false);
    }
  }, [
    apiBase,
    managementKey,
    mergePriorityRotationSidecarResult,
    priorityRotationSidecarError,
    priorityRotationSidecarStatus,
    requestPriorityRotationSidecarWithWakeRetry,
    showNotification,
    t,
    wakePriorityRotationSidecar,
  ]);

  const runPriorityRotationSidecarNow = useCallback(async () => {
    if (!managementKey) {
      showNotification(t('auth_files.priority_rotation_sidecar_missing_login'), 'error');
      return;
    }

    setPriorityRotationSidecarRunSaving(true);
    try {
      let status = priorityRotationSidecarStatus;
      if (!status || priorityRotationSidecarError) {
        status = await wakePriorityRotationSidecar();
        if (!status) return;
      }
      let hasSecret = status.state.hasSecret === true;
      const savedDraftBeforeRun = priorityRotationSidecarDraftDirty;
      if (savedDraftBeforeRun) {
        const savedState = await savePriorityRotationSidecarSettings({}, false, {
          forceDraft: true,
          notifyError: true,
          quietSaving: true,
        });
        if (!savedState) return;
        hasSecret = savedState.hasSecret === true;
      }

      if (!hasSecret) {
        showNotification(
          savedDraftBeforeRun
            ? t('auth_files.priority_rotation_sidecar_auto_apply_missing_secret')
            : t('auth_files.priority_rotation_sidecar_check_missing_secret'),
          'warning'
        );
        return;
      }

      const result = await requestPriorityRotationSidecarWithWakeRetry(() =>
        priorityRotationSidecarApi.runNow(managementKey)
      );
      mergePriorityRotationSidecarResult(result.settings, result.state, true);
      if ((result.state.lastAppliedChangeCount ?? 0) > 0) {
        await loadFiles({ preserveExisting: true, silent: true });
      }
      showNotification(
        t(
          savedDraftBeforeRun
            ? 'auth_files.priority_rotation_sidecar_auto_applied'
            : 'auth_files.priority_rotation_sidecar_run_complete'
        ),
        'success'
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPriorityRotationSidecarError(message);
      showNotification(t('auth_files.priority_rotation_sidecar_run_failed', { message }), 'error');
    } finally {
      setPriorityRotationSidecarRunSaving(false);
    }
  }, [
    loadFiles,
    managementKey,
    mergePriorityRotationSidecarResult,
    priorityRotationSidecarDraftDirty,
    priorityRotationSidecarError,
    priorityRotationSidecarStatus,
    requestPriorityRotationSidecarWithWakeRetry,
    savePriorityRotationSidecarSettings,
    showNotification,
    t,
    wakePriorityRotationSidecar,
  ]);

  const applyPriorityRotationPreview = useCallback(async () => {
    const changes = priorityRotationAnalysis.changes;
    if (changes.length === 0) {
      showNotification(t('auth_files.priority_rotation_no_changes'), 'info');
      setPriorityRotationPreviewOpen(false);
      return;
    }

    setPriorityRotationPreviewApplying(true);
    try {
      const result = await batchSetPriorities(
        changes.map((change) => ({
          name: change.name,
          priority: change.toPriority,
        }))
      );
      if (result.successCount > 0) {
        await loadFiles({ preserveExisting: true, silent: true });
      }
      if (result.failCount === 0) {
        setPriorityRotationPreviewOpen(false);
      }
    } finally {
      setPriorityRotationPreviewApplying(false);
    }
  }, [batchSetPriorities, loadFiles, priorityRotationAnalysis.changes, showNotification, t]);

  const clearTemporaryPriorityLockState = useCallback(() => {
    clearAuthFilesTemporaryPriorityLock();
    setTemporaryPriorityLockSnapshot(null);
  }, []);

  const saveTemporaryPriorityLockState = useCallback(
    (snapshot: AuthFilesTemporaryPriorityLockSnapshot) => {
      writeAuthFilesTemporaryPriorityLock(snapshot);
      setTemporaryPriorityLockSnapshot(snapshot);
    },
    []
  );

  const handleSetAllPriorityP2 = useCallback(async () => {
    if (allPriorityP2Applying || batchPriorityUpdating) return;

    if (temporaryPriorityLockTargetFiles.length === 0) {
      showNotification(t('auth_files.priority_rotation_all_p2_none'), 'info');
      return;
    }

    setAllPriorityP2Applying(true);
    try {
      const result = await batchSetPriorities(
        temporaryPriorityLockTargetFiles.map((file) => ({
          name: file.name,
          priority: PRIORITY_ROTATION_ACTIVE_PRIORITY,
        })),
        { notify: false }
      );
      if (result.successCount > 0) {
        await loadFiles({ preserveExisting: true, silent: true });
      }

      if (result.successCount > 0 && result.failCount === 0) {
        showNotification(
          t('auth_files.priority_rotation_all_p2_success', {
            count: result.successCount,
          }),
          'success'
        );
      } else if (result.successCount > 0) {
        showNotification(
          t('auth_files.priority_rotation_all_p2_partial', {
            success: result.successCount,
            failed: result.failCount,
          }),
          'warning'
        );
      } else if (result.failCount > 0) {
        showNotification(
          t('auth_files.priority_rotation_all_p2_failed', {
            failed: result.failCount,
          }),
          'warning'
        );
      } else {
        showNotification(t('auth_files.priority_rotation_all_p2_already'), 'info');
      }
    } finally {
      setAllPriorityP2Applying(false);
    }
  }, [
    allPriorityP2Applying,
    batchPriorityUpdating,
    batchSetPriorities,
    loadFiles,
    showNotification,
    t,
    temporaryPriorityLockTargetFiles,
  ]);

  const handleTemporaryPriorityLockToggle = useCallback(async () => {
    if (temporaryPriorityLockApplying || batchPriorityUpdating) return;

    setTemporaryPriorityLockApplying(true);
    try {
      if (temporaryPriorityLockSnapshot) {
        const restoreChanges = Object.entries(temporaryPriorityLockSnapshot.priorities).map(
          ([name, priority]) => ({ name, priority })
        );

        if (restoreChanges.length === 0) {
          clearTemporaryPriorityLockState();
          return;
        }

        const result = await batchSetPriorities(restoreChanges, { notify: false });
        if (result.successCount > 0) {
          await loadFiles({ preserveExisting: true, silent: true });
        }

        if (result.failCount === 0) {
          clearTemporaryPriorityLockState();
          showNotification(
            t('auth_files.priority_rotation_temp_p3_restore_success', {
              count: restoreChanges.length,
            }),
            'success'
          );
        } else {
          showNotification(
            t('auth_files.priority_rotation_temp_p3_restore_partial', {
              success: result.successCount,
              failed: result.failCount,
            }),
            'warning'
          );
        }
        return;
      }

      if (temporaryPriorityLockTargetFiles.length === 0) {
        showNotification(t('auth_files.priority_rotation_temp_p3_none'), 'info');
        return;
      }

      const snapshot: AuthFilesTemporaryPriorityLockSnapshot = {
        version: 1,
        createdAt: Date.now(),
        targetPriority: PRIORITY_ROTATION_MANUAL_LOCKED_MIN_PRIORITY,
        priorities: Object.fromEntries(
          temporaryPriorityLockTargetFiles.map((file) => [
            file.name,
            parsePriorityValue(file.priority ?? file['priority']) ?? 0,
          ])
        ),
      };
      saveTemporaryPriorityLockState(snapshot);

      const result = await batchSetPriorities(
        temporaryPriorityLockTargetFiles.map((file) => ({
          name: file.name,
          priority: PRIORITY_ROTATION_MANUAL_LOCKED_MIN_PRIORITY,
        })),
        { notify: false }
      );
      if (result.successCount > 0) {
        await loadFiles({ preserveExisting: true, silent: true });
      }

      if (result.failCount === 0) {
        showNotification(
          t('auth_files.priority_rotation_temp_p3_success', {
            count: temporaryPriorityLockTargetFiles.length,
          }),
          'success'
        );
      } else if (result.successCount > 0) {
        showNotification(
          t('auth_files.priority_rotation_temp_p3_partial', {
            success: result.successCount,
            failed: result.failCount,
          }),
          'warning'
        );
      } else {
        clearTemporaryPriorityLockState();
        showNotification(
          t('auth_files.priority_rotation_temp_p3_failed', {
            failed: result.failCount,
          }),
          'warning'
        );
      }
    } finally {
      setTemporaryPriorityLockApplying(false);
    }
  }, [
    batchPriorityUpdating,
    batchSetPriorities,
    clearTemporaryPriorityLockState,
    loadFiles,
    saveTemporaryPriorityLockState,
    showNotification,
    t,
    temporaryPriorityLockApplying,
    temporaryPriorityLockSnapshot,
    temporaryPriorityLockTargetFiles,
  ]);

  const togglePriorityRotationSidecarEnabled = useCallback(async () => {
    if (connectionStatus !== 'connected') {
      showNotification(
        t('auth_files.priority_rotation_sidecar_connection_required', {
          defaultValue: '管理接口未连接，自动接力设置未更新。',
        }),
        'error'
      );
      return;
    }
    if (!managementKey) {
      showNotification(t('auth_files.priority_rotation_sidecar_missing_login'), 'error');
      return;
    }

    const previousEnabled = priorityRotationSettings.enabled === true;
    const nextEnabled = !previousEnabled;
    priorityRotationSidecarDraftTouchedRef.current = true;
    priorityRotationSidecarAutoSaveSignatureRef.current = '';
    priorityRotationSidecarAutoSaveFailedAtRef.current = 0;
    setPriorityRotationSettings((current) => ({ ...current, enabled: nextEnabled }));

    const saved = await savePriorityRotationSidecarSettings({ enabled: nextEnabled }, true, {
      forceDraft: true,
    });
    if (!saved) {
      setPriorityRotationSettings((current) => ({ ...current, enabled: previousEnabled }));
    }
  }, [
    connectionStatus,
    managementKey,
    priorityRotationSettings.enabled,
    savePriorityRotationSidecarSettings,
    showNotification,
    t,
  ]);

  useEffect(() => {
    if (!priorityRotationSidecarCommittedDraftDirty) {
      priorityRotationSidecarAutoSaveSignatureRef.current = '';
      return;
    }
    if (!managementKey) return;
    if (!priorityRotationSidecarStatus) return;
    if (priorityRotationSidecarError) return;
    if (!isCurrentLayer) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    if (
      priorityRotationSidecarSaving ||
      priorityRotationSidecarAutoSaving ||
      priorityRotationSidecarRunSaving ||
      priorityRotationSidecarWaking
    ) {
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
    isCurrentLayer,
    priorityRotationSidecarCommittedDraftDirty,
    priorityRotationSidecarError,
    priorityRotationSidecarAutoSaving,
    priorityRotationSidecarRunSaving,
    priorityRotationSidecarSaving,
    priorityRotationSidecarStatus,
    priorityRotationSidecarWaking,
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

  useEffect(() => {
    const mutationAt = priorityRotationSidecarStatus?.state.lastMutationAt ?? '';
    const mutationCount = priorityRotationSidecarStatus?.state.lastMutationAppliedChangeCount ?? 0;
    if (!mutationAt || mutationCount <= 0) return;
    if (priorityRotationSidecarLastMutationRef.current === mutationAt) return;

    priorityRotationSidecarLastMutationRef.current = mutationAt;
    void loadFiles({ preserveExisting: true, silent: true });
  }, [
    loadFiles,
    priorityRotationSidecarStatus?.state.lastMutationAppliedChangeCount,
    priorityRotationSidecarStatus?.state.lastMutationAt,
  ]);

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

  const scrollToFileCards = useCallback((behavior: ScrollBehavior = 'auto') => {
    if (typeof window === 'undefined') return;

    const header = fileListHeaderRef.current;
    const grid = fileGridRef.current;
    if (!header) return;

    const container = header.closest('.content') as HTMLElement | null;
    if (!container) {
      header.scrollIntoView({ block: 'start', inline: 'nearest', behavior });
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const headerRect = header.getBoundingClientRect();
    const gridRect = (grid ?? header).getBoundingClientRect();
    const previousSectionBottom = (() => {
      let section = header.previousElementSibling;
      let bottom = Number.NEGATIVE_INFINITY;
      while (section) {
        bottom = Math.max(bottom, section.getBoundingClientRect().bottom);
        section = section.previousElementSibling;
      }
      return Number.isFinite(bottom) ? bottom : null;
    })();
    const maxScrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    const headerComfortScroll =
      container.scrollTop + headerRect.top - containerRect.top - CARD_FOCUS_HEADER_COMFORT_GAP;
    const gridBottomScroll =
      container.scrollTop +
      gridRect.bottom -
      containerRect.top -
      container.clientHeight +
      CARD_FOCUS_BOTTOM_GAP;
    const verticalSpan = gridRect.bottom - headerRect.top;
    const canPreserveBottomGap =
      Boolean(grid) &&
      verticalSpan + CARD_FOCUS_HEADER_COMFORT_GAP + CARD_FOCUS_BOTTOM_GAP <=
        container.clientHeight;
    const preferredScrollTop = canPreserveBottomGap
      ? Math.max(headerComfortScroll, gridBottomScroll)
      : grid
        ? Math.min(gridBottomScroll, headerComfortScroll + CARD_FOCUS_HEADER_TUCK_LIMIT)
        : headerComfortScroll;
    const previousLineHiddenScroll =
      previousSectionBottom === null
        ? 0
        : container.scrollTop +
          previousSectionBottom -
          containerRect.top +
          CARD_FOCUS_PREVIOUS_LINE_CLEARANCE;
    const headerLineHiddenScroll =
      container.scrollTop + headerRect.top - containerRect.top + CARD_FOCUS_HEADER_LINE_CLEARANCE;
    const targetScrollTop = Math.max(
      0,
      Math.min(
        maxScrollTop,
        Math.max(preferredScrollTop, previousLineHiddenScroll, headerLineHiddenScroll)
      )
    );

    container.scrollTo({ top: targetScrollTop, behavior });
  }, []);

  const scheduleFileCardsScroll = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      if (typeof window === 'undefined') return () => undefined;

      const frames: number[] = [];
      const timers: number[] = [];
      const runScroll = () => scrollToFileCards(behavior);

      runScroll();
      frames.push(window.requestAnimationFrame(runScroll));
      frames.push(
        window.requestAnimationFrame(() => {
          frames.push(window.requestAnimationFrame(runScroll));
        })
      );
      timers.push(window.setTimeout(runScroll, 120));
      timers.push(window.setTimeout(runScroll, 360));
      timers.push(window.setTimeout(runScroll, 700));

      return () => {
        frames.forEach((frame) => window.cancelAnimationFrame(frame));
        timers.forEach((timer) => window.clearTimeout(timer));
      };
    },
    [scrollToFileCards]
  );

  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;

    const shouldFocusCards = new URLSearchParams(location.search).get('focus') === 'cards';
    if (!shouldFocusCards) {
      focusedFileListOnOpenRef.current = '';
      return;
    }
    const focusSignature = location.search;
    if (focusedFileListOnOpenRef.current === focusSignature || loading) return;

    const target = fileListHeaderRef.current;
    const needsRenderedGrid = pageItems.length > 0;
    if (!target || (needsRenderedGrid && !fileGridRef.current)) return;

    focusedFileListOnOpenRef.current = focusSignature;
    return scheduleFileCardsScroll('auto');
  }, [loading, location.search, pageItems.length, scheduleFileCardsScroll]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handleFocusCards = () => {
      scheduleFileCardsScroll('auto');
    };
    window.addEventListener(AUTH_FILES_FOCUS_CARDS_EVENT, handleFocusCards);
    return () => window.removeEventListener(AUTH_FILES_FOCUS_CARDS_EVENT, handleFocusCards);
  }, [scheduleFileCardsScroll]);

  useEffect(() => {
    setBatchActionBarVisible(selectionCount > 0);
  }, [selectionCount]);

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
  const accountMemoEditorDisplayName = accountMemoEditorFile
    ? getAuthFileDisplayName(accountMemoEditorFile)
    : '';
  const accountMemoEditorFileName = accountMemoEditorFile?.name ?? '';
  const accountMemoEditorExistingMemo = accountMemoEditorFile
    ? getAuthFileAccountMemo(accountMemosByFile, accountMemoEditorFile.name)
    : null;
  const accountMemoEditorExistingText = accountMemoEditorExistingMemo?.text ?? '';
  const accountMemoEditorHasExisting =
    Boolean(accountMemoEditorExistingText) ||
    (accountMemoEditorExistingMemo?.images.length ?? 0) > 0;
  const accountMemoHasDraftContent =
    Boolean(accountMemoDraft.trim()) || accountMemoImagesDraft.length > 0;
  const accountMemoPreviewBlocks = useMemo(
    () => parseAccountMemoPreviewBlocks(accountMemoDraft),
    [accountMemoDraft]
  );
  const accountMemoImageSlotsRemaining =
    AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES - accountMemoImagesDraft.length;
  const accountMemoShouldShowImagePanel =
    accountMemoImagesDraft.length > 0 || accountMemoImageProcessing;
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
  const priorityRotationHasPreviewChanges = priorityRotationAnalysis.changes.length > 0;
  const priorityRotationVisibleActiveCount =
    priorityRotationAnalysis.changes.length > 0
      ? priorityRotationAnalysis.projectedActiveCount
      : priorityRotationAnalysis.activeCount;
  const priorityRotationActiveDeficit = Math.max(
    0,
    priorityRotationAnalysis.activeSlotLimit - priorityRotationVisibleActiveCount
  );
  const priorityRotationStatusLabel = priorityRotationHasPreviewChanges
    ? t('auth_files.priority_rotation_status_ready', {
        count: priorityRotationAnalysis.changes.length,
      })
    : priorityRotationAnalysis.status === 'quota_unknown'
      ? t('auth_files.priority_rotation_status_unknown')
      : priorityRotationAnalysis.status === 'no_standby'
        ? priorityRotationActiveDeficit > 0
          ? t('auth_files.priority_rotation_status_no_standby_deficit', {
              count: priorityRotationActiveDeficit,
              defaultValue: `缺 ${priorityRotationActiveDeficit} 个，无健康备用`,
            })
          : t('auth_files.priority_rotation_status_no_standby')
        : t('auth_files.priority_rotation_status_idle');
  const priorityRotationSlotLabel = t(
    priorityRotationHasPreviewChanges
      ? 'auth_files.priority_rotation_status_projected_slots'
      : 'auth_files.priority_rotation_status_slots',
    {
      current: priorityRotationVisibleActiveCount,
      limit: priorityRotationAnalysis.activeSlotLimit,
      defaultValue: priorityRotationHasPreviewChanges
        ? `接力后 ${priorityRotationVisibleActiveCount}/${priorityRotationAnalysis.activeSlotLimit}`
        : `主力 ${priorityRotationVisibleActiveCount}/${priorityRotationAnalysis.activeSlotLimit}`,
    }
  );
  const priorityRotationThresholdSummaryValue = priorityRotationAnalysis.thresholdAdjusted
    ? t('auth_files.priority_rotation_summary_threshold_with_fallback_value', {
        threshold: priorityRotationAnalysis.thresholdPercent,
        effective: priorityRotationAnalysis.effectiveThresholdPercent,
        defaultValue: `健康线 ${priorityRotationAnalysis.thresholdPercent}% / 无备用接力线 ${priorityRotationAnalysis.effectiveThresholdPercent}%`,
      })
    : t('auth_files.priority_rotation_summary_threshold_value', {
        threshold: priorityRotationAnalysis.thresholdPercent,
      });
  const priorityRotationFallbackSettingLabel =
    priorityRotationEffectiveNoStandbyThresholdDropPercent > 0
      ? t('auth_files.priority_rotation_no_standby_drop_active_value', {
          drop: priorityRotationEffectiveNoStandbyThresholdDropPercent,
          effective: Math.max(
            0,
            priorityRotationEffectiveThresholdPercent -
              priorityRotationEffectiveNoStandbyThresholdDropPercent
          ),
          defaultValue: `无健康备用时下调 ${priorityRotationEffectiveNoStandbyThresholdDropPercent}%，接力线 ${Math.max(
            0,
            priorityRotationEffectiveThresholdPercent -
              priorityRotationEffectiveNoStandbyThresholdDropPercent
          )}%`,
        })
      : t('auth_files.priority_rotation_no_standby_drop_inactive', {
          defaultValue: '无健康备用时不下调',
        });
  const priorityRotationStatusClass = priorityRotationHasPreviewChanges
    ? styles.priorityRotationStatusReady
    : priorityRotationAnalysis.status === 'quota_unknown' ||
        priorityRotationAnalysis.status === 'no_standby'
      ? styles.priorityRotationStatusWarning
      : styles.priorityRotationStatusMuted;
  const priorityRotationPreviewDisabled =
    !priorityRotationHasPreviewChanges ||
    disableControls ||
    batchPriorityUpdating ||
    allPriorityP2Applying ||
    temporaryPriorityLockApplying ||
    priorityRotationPreviewApplying;
  const temporaryPriorityLockButtonDisabled =
    disableControls ||
    batchPriorityUpdating ||
    allPriorityP2Applying ||
    temporaryPriorityLockApplying ||
    (temporaryPriorityLockActive
      ? temporaryPriorityLockSnapshotCount === 0
      : temporaryPriorityLockTargetFiles.length === 0);
  const allPriorityP2ButtonDisabled =
    disableControls ||
    batchPriorityUpdating ||
    temporaryPriorityLockApplying ||
    priorityRotationPreviewApplying ||
    allPriorityP2Applying;
  const priorityRotationPreviewSummaryItems = [
    {
      key: 'threshold',
      label: t('auth_files.priority_rotation_summary_threshold_label'),
      value: priorityRotationThresholdSummaryValue,
    },
    {
      key: 'slots',
      label: t('auth_files.priority_rotation_summary_slots_label'),
      value: t('auth_files.priority_rotation_summary_slots_value', {
        current: priorityRotationAnalysis.projectedActiveCount,
        limit: priorityRotationAnalysis.activeSlotLimit,
      }),
    },
    {
      key: 'tiers',
      label: t('auth_files.priority_rotation_summary_tiers_label'),
      value: t('auth_files.priority_rotation_summary_tiers_value', {
        active: formatPriorityRotationPriority(priorityRotationAnalysis.activePriority),
        standby: formatPriorityRotationPriority(priorityRotationAnalysis.standbyPriority),
        buffer: formatPriorityRotationPriority(priorityRotationAnalysis.reservePriority),
        locked: t('auth_files.priority_rotation_tier_manual_locked_value', {
          defaultValue: 'P3+',
        }),
      }),
    },
    {
      key: 'count',
      label: t('auth_files.priority_rotation_summary_count_label'),
      value: t('auth_files.priority_rotation_summary_count_value', {
        count: priorityRotationAnalysis.changes.length,
      }),
    },
  ];
  const priorityRotationPendingSaveLabel = t('auth_files.priority_rotation_sidecar_unsaved');
  const priorityRotationInputPendingLabel = t('auth_files.priority_rotation_sidecar_input_pending');
  const priorityRotationSavingLabel = t('auth_files.priority_rotation_sidecar_saving', {
    defaultValue: '保存中',
  });
  const priorityRotationDraftStatusLabel =
    priorityRotationSidecarSaving || priorityRotationSidecarAutoSaving
      ? priorityRotationSavingLabel
      : priorityRotationSidecarCommittedDraftDirty
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
    manualLocked: t('auth_files.priority_rotation_tier_manual_locked'),
  };
  const priorityRotationTierPriorityLabels: Record<AuthFilePriorityTier, string> = {
    active: formatPriorityRotationPriority(priorityRotationAnalysis.activePriority),
    standby: formatPriorityRotationPriority(priorityRotationAnalysis.standbyPriority),
    buffer: formatPriorityRotationPriority(priorityRotationAnalysis.reservePriority),
    manualLocked: t('auth_files.priority_rotation_tier_manual_locked_value', {
      defaultValue: 'P3+',
    }),
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
      value: priorityRotationTierPriorityLabels.active,
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
      value: priorityRotationTierPriorityLabels.standby,
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
      value: priorityRotationTierPriorityLabels.buffer,
      className: styles.priorityRotationTierBuffer,
      count: priorityRotationTierDetailGroups.buffer.length,
      ariaLabel: t('auth_files.priority_rotation_detail_open_aria', {
        tier: priorityRotationTierLabels.buffer,
        count: priorityRotationTierDetailGroups.buffer.length,
        defaultValue: `查看${priorityRotationTierLabels.buffer}详情（${priorityRotationTierDetailGroups.buffer.length} 个）`,
      }),
    },
    {
      key: 'manualLocked',
      label: priorityRotationTierLabels.manualLocked,
      value: priorityRotationTierPriorityLabels.manualLocked,
      className: styles.priorityRotationTierManualLocked,
      count: priorityRotationTierDetailGroups.manualLocked.length,
      ariaLabel: t('auth_files.priority_rotation_detail_open_aria', {
        tier: priorityRotationTierLabels.manualLocked,
        count: priorityRotationTierDetailGroups.manualLocked.length,
        defaultValue: `查看${priorityRotationTierLabels.manualLocked}详情（${priorityRotationTierDetailGroups.manualLocked.length} 个）`,
      }),
    },
  ];
  const priorityRotationSidecarState = priorityRotationSidecarStatus?.state ?? null;
  const priorityRotationSidecarOnline =
    Boolean(priorityRotationSidecarStatus) && !priorityRotationSidecarError;
  const priorityRotationSidecarSavedEnabled =
    priorityRotationSidecarOnline && priorityRotationSidecarSettings?.enabled === true;
  const temporaryPriorityLockStatusLabel = temporaryPriorityLockActive
    ? t('auth_files.priority_rotation_temp_p3_active', {
        count: temporaryPriorityLockSnapshotCount,
        defaultValue: `临时 P3：${temporaryPriorityLockSnapshotCount} 个可恢复`,
      })
    : '';
  const priorityRotationSidecarDraftEnabled = priorityRotationSettings.enabled === true;
  const priorityRotationSidecarEnabled = priorityRotationSidecarDraftEnabled;
  const priorityRotationSidecarHasSecret = priorityRotationSidecarState?.hasSecret === true;
  const priorityRotationSidecarStatusTone = priorityRotationSidecarWaking
    ? styles.priorityRotationStatusReady
    : priorityRotationSidecarError || !priorityRotationSidecarOnline
      ? styles.priorityRotationStatusWarning
      : priorityRotationSidecarState?.running
        ? styles.priorityRotationStatusReady
        : styles.priorityRotationStatusMuted;
  const priorityRotationSidecarLiveStatusLabel = priorityRotationSidecarLoading
    ? t('auth_files.priority_rotation_sidecar_loading')
    : priorityRotationSidecarWaking
      ? t('auth_files.priority_rotation_sidecar_waking')
      : priorityRotationSidecarError || !priorityRotationSidecarOnline
        ? t('auth_files.priority_rotation_sidecar_offline')
        : priorityRotationSidecarState?.running
          ? t('auth_files.priority_rotation_sidecar_running')
          : t('auth_files.priority_rotation_sidecar_waiting');
  const priorityRotationSidecarSecretLabel = !priorityRotationSidecarOnline
    ? t('auth_files.priority_rotation_sidecar_secret_unknown')
    : priorityRotationSidecarHasSecret
      ? t('auth_files.priority_rotation_sidecar_secret_ready')
      : t('auth_files.priority_rotation_sidecar_secret_missing');
  const priorityRotationSidecarSecretToneClass = priorityRotationSidecarHasSecret
    ? styles.priorityRotationBackgroundMetaSuccess
    : priorityRotationSidecarOnline
      ? styles.priorityRotationBackgroundMetaWarning
      : styles.priorityRotationBackgroundMetaUnknown;
  const priorityRotationSidecarLastRunLabel = t('auth_files.priority_rotation_sidecar_last_run', {
    time: formatRelativeDateTime(priorityRotationSidecarState?.lastCompletedAt, {
      immediatePast: t('auth_files.priority_rotation_sidecar_last_run_recent', {
        defaultValue: '1分钟前',
      }),
    }),
  });
  const priorityRotationSidecarNextRunLabel = t('auth_files.priority_rotation_sidecar_next_run', {
    time: priorityRotationSidecarSavedEnabled
      ? formatRelativeDateTime(priorityRotationSidecarState?.nextRunAt, {
          pastFallback: t('auth_files.priority_rotation_sidecar_next_run_due', {
            defaultValue: '1分钟后',
          }),
          immediatePast: t('auth_files.priority_rotation_sidecar_next_run_due', {
            defaultValue: '1分钟后',
          }),
          immediateFuture: t('auth_files.priority_rotation_sidecar_next_run_soon', {
            defaultValue: '1分钟后',
          }),
        })
      : '-',
  });
  const priorityRotationSidecarResultValue = (() => {
    const lastStatus = priorityRotationSidecarState?.lastStatus ?? 'idle';
    const skippedReason = priorityRotationSidecarState?.lastSkippedReason;
    if (priorityRotationSidecarState?.running || lastStatus === 'running') {
      return t('auth_files.priority_rotation_sidecar_result_running');
    }
    if (lastStatus === 'applied') {
      return t('auth_files.priority_rotation_sidecar_result_applied', {
        count: priorityRotationSidecarState?.lastAppliedChangeCount ?? 0,
      });
    }
    if (lastStatus === 'partial') {
      return t('auth_files.priority_rotation_sidecar_result_partial');
    }
    if (lastStatus === 'failed') {
      return t('auth_files.priority_rotation_sidecar_result_failed');
    }
    if (lastStatus === 'error') {
      return t('auth_files.priority_rotation_sidecar_result_error');
    }
    if (lastStatus === 'dry_run_ready') {
      return t('auth_files.priority_rotation_sidecar_result_dry_run_ready');
    }
    if (lastStatus === 'skipped' && skippedReason === 'missing_secret') {
      return t('auth_files.priority_rotation_sidecar_result_missing_secret');
    }
    if (lastStatus === 'skipped' && skippedReason === 'disabled') {
      return t('auth_files.priority_rotation_sidecar_result_disabled');
    }
    if (lastStatus === 'skipped' && skippedReason === 'idle_timeout') {
      return t('auth_files.priority_rotation_sidecar_result_idle_timeout');
    }
    if (lastStatus === 'quota_unknown' || skippedReason === 'quota_unknown') {
      return t('auth_files.priority_rotation_sidecar_result_quota_unknown');
    }
    if (lastStatus === 'no_standby' || skippedReason === 'no_standby') {
      return t('auth_files.priority_rotation_sidecar_result_no_standby');
    }
    if (lastStatus === 'no_changes' || skippedReason === 'no_changes') {
      return t('auth_files.priority_rotation_sidecar_result_no_changes');
    }
    if (lastStatus === 'skipped') {
      return t('auth_files.priority_rotation_sidecar_result_skipped');
    }
    return t('auth_files.priority_rotation_sidecar_result_idle');
  })();
  const priorityRotationSidecarResultLabel = t('auth_files.priority_rotation_sidecar_last_result', {
    result: priorityRotationSidecarResultValue,
  });
  const priorityRotationSidecarHint = priorityRotationSidecarWaking
    ? t('auth_files.priority_rotation_sidecar_wake_pending')
    : !priorityRotationSidecarOnline
      ? t('auth_files.priority_rotation_sidecar_sleep_hint')
      : priorityRotationSidecarState?.lastSkippedReason === 'idle_timeout'
        ? t('auth_files.priority_rotation_sidecar_idle_hint')
        : '';
  const priorityRotationSidecarHasAnomalousNoChanges =
    priorityRotationSidecarState?.lastStatus === 'no_changes' &&
    (priorityRotationSidecarState.lastAnalysis?.candidates ?? []).some(
      (candidate) => candidate.isActive && candidate.belowThreshold === true
    );
  const priorityRotationDetailTierLabel = priorityRotationDetailTier
    ? priorityRotationTierLabels[priorityRotationDetailTier]
    : '';
  const priorityRotationDetailPriorityLabel = priorityRotationDetailTier
    ? priorityRotationTierPriorityLabels[priorityRotationDetailTier]
    : '-';
  const priorityRotationDetailItems = priorityRotationDetailTier
    ? priorityRotationTierDetailGroups[priorityRotationDetailTier]
    : [];
  const priorityRotationDetailTitle = priorityRotationDetailTier
    ? t('auth_files.priority_rotation_detail_title', {
        tier: priorityRotationDetailTierLabel,
        priority: priorityRotationDetailPriorityLabel,
        defaultValue: `${priorityRotationDetailTierLabel} ${priorityRotationDetailPriorityLabel}`,
      })
    : '';
  const manageableFileCount = files.filter((file) => !isRuntimeOnlyAuthFile(file)).length;
  const enabledFileCount = files.filter(
    (file) => !isRuntimeOnlyAuthFile(file) && file.disabled !== true
  ).length;
  const disabledFileCount = files.filter(
    (file) => !isRuntimeOnlyAuthFile(file) && file.disabled === true
  ).length;
  const problemFileCount = files.filter(hasAuthFileStatusMessage).length;
  const runtimeOnlyFileCount = files.length - manageableFileCount;
  const currentProviderLabel =
    filter === 'all'
      ? t('auth_files.summary_provider_all', { defaultValue: '全部渠道' })
      : getTypeLabel(t, filter);
  const visibleRangeLabel =
    sorted.length === 0
      ? t('auth_files.summary_visible_empty', { defaultValue: '无匹配凭证' })
      : t('auth_files.summary_visible_range', {
          shown: pageItems.length,
          total: sorted.length,
          defaultValue: `本页 ${pageItems.length} / 筛选 ${sorted.length}`,
        });
  const summaryChipItems = [
    {
      key: 'total',
      label: t('auth_files.summary_total', { defaultValue: '认证文件' }),
      value: files.length,
      meta: visibleRangeLabel,
    },
    {
      key: 'enabled',
      label: t('auth_files.summary_enabled', { defaultValue: '启用中' }),
      value: enabledFileCount,
      meta: t('auth_files.summary_manageable', {
        count: manageableFileCount,
        defaultValue: `${manageableFileCount} 个可管理`,
      }),
    },
    {
      key: 'problem',
      label: t('auth_files.summary_problem', { defaultValue: '需关注' }),
      value: problemFileCount,
      meta:
        problemFileCount > 0
          ? t('auth_files.summary_problem_hint', { defaultValue: '有状态提示' })
          : t('auth_files.summary_problem_clear', { defaultValue: '状态平稳' }),
    },
    {
      key: 'disabled',
      label: t('auth_files.summary_disabled', { defaultValue: '已停用' }),
      value: disabledFileCount,
      meta:
        runtimeOnlyFileCount > 0
          ? t('auth_files.summary_runtime_only', {
              count: runtimeOnlyFileCount,
              defaultValue: `${runtimeOnlyFileCount} 个运行态`,
            })
          : t('auth_files.summary_runtime_none', { defaultValue: '无运行态占位' }),
    },
  ];
  const titleSummaryItems = summaryChipItems.filter((item) => item.key !== 'total');
  const titleNode = (
    <div className={styles.authFilesTitleBlock}>
      <div className={styles.authFilesTitleMain}>
        <span className={styles.authFilesTitleText}>{t('auth_files.title_section')}</span>
        {files.length > 0 && <span className={styles.countBadge}>{files.length}</span>}
        <span className={styles.authFilesTitleScope}>{currentProviderLabel}</span>
        <span className={styles.authFilesTitleMeta}>{visibleRangeLabel}</span>
      </div>
      <div
        className={styles.authFilesTitleStats}
        aria-label={t('auth_files.summary_chips_label', {
          defaultValue: '认证文件摘要',
        })}
      >
        {titleSummaryItems.map((item) => (
          <span
            className={`${styles.authFilesTitleChip} ${
              item.key === 'problem' && Number(item.value) > 0
                ? styles.authFilesTitleChipAttention
                : ''
            }`}
            key={item.key}
            title={`${item.label}: ${item.value} · ${item.meta}`}
          >
            <span className={styles.authFilesTitleChipLabel}>{item.label}</span>
            <strong className={styles.authFilesTitleChipValue}>{item.value}</strong>
          </span>
        ))}
      </div>
    </div>
  );
  const listHeaderTitle = t('auth_files.list_header_title', {
    provider: currentProviderLabel,
    defaultValue: `${currentProviderLabel}认证文件`,
  });
  const listHeaderMeta = t('auth_files.list_header_meta', {
    shown: pageItems.length,
    total: sorted.length,
    page: currentPage,
    totalPages,
    defaultValue: `${pageItems.length}/${sorted.length} 项，第 ${currentPage}/${totalPages} 页`,
  });
  const showListPaginationControls = sorted.length > pageSize;
  const advancedControlSummary = t('auth_files.advanced_control_summary', {
    status: priorityRotationStatusLabel,
    slots: priorityRotationSlotLabel,
    sidecar: priorityRotationSidecarLiveStatusLabel,
    defaultValue: `${priorityRotationStatusLabel} · ${priorityRotationSlotLabel} · ${priorityRotationSidecarLiveStatusLabel}`,
  });
  const advancedControlConnectionLabel = priorityRotationSidecarOnline
    ? t('auth_files.advanced_control_connected', { defaultValue: '已连接' })
    : priorityRotationSidecarWaking
      ? t('auth_files.advanced_control_connecting', { defaultValue: '连接中' })
      : t('auth_files.advanced_control_disconnected', { defaultValue: '未连接' });
  const advancedControlConnectionTitle = [
    priorityRotationSidecarLiveStatusLabel,
    priorityRotationSidecarSecretLabel,
    priorityRotationDraftStatusLabel,
  ]
    .filter(Boolean)
    .join(' · ');
  const advancedControlSignals: Array<{
    key: string;
    label: string;
    className: string;
    title?: string;
  }> = [];
  if (priorityRotationDraftStatusLabel) {
    advancedControlSignals.push({
      key: 'draft',
      label: priorityRotationDraftStatusLabel,
      className: styles.advancedControlsSignalWarning,
    });
  }
  if (priorityRotationSidecarError) {
    advancedControlSignals.push({
      key: 'error',
      label: t('auth_files.advanced_control_signal_error', {
        defaultValue: '接力异常',
      }),
      className: styles.advancedControlsSignalDanger,
      title: priorityRotationSidecarError,
    });
  }
  if (priorityRotationSidecarHasAnomalousNoChanges) {
    advancedControlSignals.push({
      key: 'anomaly',
      label: t('auth_files.advanced_control_signal_anomaly', {
        defaultValue: '疑似未接力',
      }),
      className: styles.advancedControlsSignalWarning,
    });
  }
  if (priorityRotationSidecarOnline && !priorityRotationSidecarHasSecret) {
    advancedControlSignals.push({
      key: 'secret',
      label: priorityRotationSidecarSecretLabel,
      className: styles.advancedControlsSignalWarning,
    });
  }
  if (
    priorityRotationSidecarWaking ||
    priorityRotationSidecarSaving ||
    priorityRotationSidecarSecretSaving ||
    priorityRotationSidecarRunSaving
  ) {
    advancedControlSignals.push({
      key: 'busy',
      label: t('auth_files.advanced_control_signal_busy', {
        defaultValue: '处理中',
      }),
      className: styles.advancedControlsSignalInfo,
    });
  }
  const getPriorityRotationReasonLabel = (
    reason: (typeof priorityRotationAnalysis.changes)[number]['reason']
  ): string => {
    switch (reason) {
      case 'low_remaining':
        return t('auth_files.priority_rotation_reason_demote_low');
      case 'over_active_limit':
        return t('auth_files.priority_rotation_reason_demote_over_limit', {
          limit: priorityRotationAnalysis.activeSlotLimit,
        });
      case 'promote_standby':
        return t('auth_files.priority_rotation_reason_promote');
      case 'credential_invalid':
        return t('auth_files.priority_rotation_reason_credential_invalid', {
          defaultValue: '认证失效，降至缓冲',
        });
      default:
        return String(reason);
    }
  };

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
            <details className={styles.advancedControls}>
              <summary className={styles.advancedControlsSummary}>
                <span className={styles.advancedControlsTitle}>
                  {t('auth_files.advanced_control_title', { defaultValue: '接力设置' })}
                </span>
                <span className={styles.advancedControlsMeta}>{advancedControlSummary}</span>
                <span
                  className={styles.advancedControlsSignals}
                  aria-label={t('auth_files.advanced_control_signals', {
                    defaultValue: '接力状态',
                  })}
                >
                  {advancedControlSignals.map((signal) => (
                    <span
                      className={`${styles.advancedControlsSignal} ${signal.className}`}
                      key={signal.key}
                      title={signal.title || signal.label}
                    >
                      {signal.label}
                    </span>
                  ))}
                  <span
                    className={`${styles.advancedControlsConnection} ${
                      priorityRotationSidecarOnline
                        ? styles.advancedControlsConnectionConnected
                        : styles.advancedControlsConnectionDisconnected
                    }`}
                    title={advancedControlConnectionTitle}
                  >
                    <span className={styles.advancedControlsConnectionDot} aria-hidden="true" />
                    <span className={styles.advancedControlsConnectionText}>
                      {advancedControlConnectionLabel}
                    </span>
                  </span>
                </span>
                <span className={styles.advancedControlsToggle} aria-hidden="true">
                  <IconChevronDown size={15} />
                </span>
              </summary>
              <div className={styles.advancedControlsBody}>
                <div className={styles.priorityRotationBar}>
                  <div className={styles.priorityRotationMain}>
                    <span className={styles.priorityRotationIcon} aria-hidden="true">
                      <IconSlidersHorizontal size={19} />
                    </span>
                    <span className={styles.priorityRotationCopy}>
                      <span className={styles.priorityRotationTitle}>
                        {t('auth_files.priority_rotation_title')}
                      </span>
                      <span
                        className={styles.priorityRotationMeta}
                        title={priorityRotationLayerTitle}
                      >
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
                      {temporaryPriorityLockStatusLabel && (
                        <span
                          className={`${styles.priorityRotationStatus} ${styles.priorityRotationStatusManualLock}`}
                        >
                          {temporaryPriorityLockStatusLabel}
                        </span>
                      )}
                    </div>
                    <div className={styles.priorityRotationButtonGroup}>
                      <Button
                        variant="secondary"
                        size="sm"
                        className={`${styles.priorityRotationButton} ${
                          temporaryPriorityLockActive
                            ? styles.temporaryPriorityLockButtonActive
                            : ''
                        }`}
                        leftIcon={
                          temporaryPriorityLockActive ? (
                            <IconRefreshCw size={15} />
                          ) : (
                            <IconSlidersHorizontal size={15} />
                          )
                        }
                        onClick={() => void handleTemporaryPriorityLockToggle()}
                        disabled={temporaryPriorityLockButtonDisabled}
                        loading={temporaryPriorityLockApplying}
                        aria-label={
                          temporaryPriorityLockActive
                            ? t('auth_files.priority_rotation_temp_p3_restore_aria')
                            : t('auth_files.priority_rotation_temp_p3_aria')
                        }
                      >
                        {temporaryPriorityLockActive
                          ? t('auth_files.priority_rotation_temp_p3_restore_button')
                          : t('auth_files.priority_rotation_temp_p3_button')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        className={styles.priorityRotationButton}
                        leftIcon={<IconSlidersHorizontal size={15} />}
                        onClick={() => void handleSetAllPriorityP2()}
                        disabled={allPriorityP2ButtonDisabled}
                        loading={allPriorityP2Applying}
                        aria-label={t('auth_files.priority_rotation_all_p2_aria')}
                      >
                        {t('auth_files.priority_rotation_all_p2_button')}
                      </Button>
                      <Button
                        variant="primary"
                        size="sm"
                        className={`${styles.priorityRotationButton} ${styles.priorityRotationPreviewButton}`}
                        onClick={() => setPriorityRotationPreviewOpen(true)}
                        disabled={priorityRotationPreviewDisabled}
                        loading={priorityRotationPreviewApplying}
                        aria-label={t('auth_files.priority_rotation_button_aria')}
                      >
                        {t('auth_files.priority_rotation_button')}
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
                        <span
                          className={`${styles.priorityRotationBackgroundMetaItem} ${
                            priorityRotationSidecarHasAnomalousNoChanges
                              ? styles.priorityRotationBackgroundMetaWarning
                              : ''
                          }`}
                        >
                          {priorityRotationSidecarResultLabel}
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
                        } ${priorityRotationSidecarWaking ? styles.priorityRotationRelaySwitchWaking : ''}`}
                        role="switch"
                        aria-checked={priorityRotationSidecarEnabled}
                        aria-label={t('auth_files.priority_rotation_sidecar_enable')}
                        disabled={priorityRotationSidecarSaving || priorityRotationSidecarWaking}
                        onClick={() => void togglePriorityRotationSidecarEnabled()}
                      >
                        <span className={styles.priorityRotationRelayTrack} aria-hidden="true">
                          <span className={styles.priorityRotationRelayThumb} />
                        </span>
                      </button>
                    </div>
                  </div>
                  <div className={styles.priorityRotationBackgroundControls}>
                    {priorityRotationSidecarHint && (
                      <div className={styles.priorityRotationBackgroundHint}>
                        {priorityRotationSidecarHint}
                      </div>
                    )}
                    <div className={styles.priorityRotationBackgroundRules}>
                      <div
                        className={styles.priorityRotationSetting}
                        role="group"
                        aria-label={t('auth_files.priority_rotation_threshold_label')}
                      >
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
                              onChange={(event) =>
                                handlePriorityRotationThresholdInputChange(
                                  event.currentTarget.value
                                )
                              }
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
                          <span
                            className={styles.priorityRotationSliderShell}
                            style={
                              {
                                '--priority-rotation-slider-progress': `${priorityRotationEffectiveThresholdPercent}%`,
                              } as CSSProperties
                            }
                          >
                            <span className={styles.priorityRotationSliderRail} aria-hidden="true">
                              <span className={styles.priorityRotationSliderFill} />
                              <span className={styles.priorityRotationSliderMarker} />
                            </span>
                            <input
                              className={styles.priorityRotationSlider}
                              type="range"
                              min={0}
                              max={100}
                              step={PRIORITY_ROTATION_THRESHOLD_STEP}
                              value={priorityRotationEffectiveThresholdPercent}
                              disabled={priorityRotationSidecarSaving}
                              aria-label={t('auth_files.priority_rotation_threshold_label')}
                              onChange={(event) =>
                                commitPriorityRotationThresholdInput(event.currentTarget.value)
                              }
                            />
                          </span>
                        </span>
                        <span className={styles.priorityRotationFallbackControl}>
                          <span className={styles.priorityRotationFallbackHeader}>
                            <span>{t('auth_files.priority_rotation_no_standby_drop_label')}</span>
                            <span>{priorityRotationFallbackSettingLabel}</span>
                          </span>
                          <span
                            className={`${styles.priorityRotationStepper} ${styles.priorityRotationFallbackStepper}`}
                          >
                            <button
                              type="button"
                              className={styles.priorityRotationStepperButton}
                              disabled={priorityRotationSidecarSaving}
                              aria-label={t(
                                'auth_files.priority_rotation_no_standby_drop_decrease'
                              )}
                              onClick={() =>
                                adjustPriorityRotationNoStandbyThresholdDrop(
                                  -PRIORITY_ROTATION_NO_STANDBY_THRESHOLD_DROP_STEP
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
                                value={priorityRotationNoStandbyThresholdDropInput}
                                disabled={priorityRotationSidecarSaving}
                                aria-label={t('auth_files.priority_rotation_no_standby_drop_label')}
                                onChange={(event) =>
                                  handlePriorityRotationNoStandbyThresholdDropInputChange(
                                    event.currentTarget.value
                                  )
                                }
                                onBlur={(event) =>
                                  commitPriorityRotationNoStandbyThresholdDropInput(
                                    event.currentTarget.value
                                  )
                                }
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.currentTarget.blur();
                                  }
                                }}
                              />
                              <span>%</span>
                            </span>
                            <button
                              type="button"
                              className={styles.priorityRotationStepperButton}
                              disabled={priorityRotationSidecarSaving}
                              aria-label={t(
                                'auth_files.priority_rotation_no_standby_drop_increase'
                              )}
                              onClick={() =>
                                adjustPriorityRotationNoStandbyThresholdDrop(
                                  PRIORITY_ROTATION_NO_STANDBY_THRESHOLD_DROP_STEP
                                )
                              }
                            >
                              <IconPlus size={16} />
                            </button>
                          </span>
                        </span>
                      </div>
                      <div
                        className={styles.priorityRotationSetting}
                        role="group"
                        aria-label={t('auth_files.priority_rotation_slots_label')}
                      >
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
                            onClick={() =>
                              adjustPriorityRotationSlots(-PRIORITY_ROTATION_SLOT_STEP)
                            }
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
                              onChange={(event) =>
                                handlePriorityRotationSlotsInputChange(event.currentTarget.value)
                              }
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
                      </div>
                      <div
                        className={styles.priorityRotationSetting}
                        role="group"
                        aria-label={t('auth_files.priority_rotation_sidecar_interval')}
                      >
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
                              onChange={(event) =>
                                handlePriorityRotationSidecarIntervalInputChange(
                                  event.currentTarget.value
                                )
                              }
                              onBlur={(event) =>
                                commitPriorityRotationSidecarIntervalInput(
                                  event.currentTarget.value
                                )
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
                      </div>
                    </div>
                    <div className={styles.priorityRotationBackgroundButtons}>
                      {!priorityRotationSidecarOnline && (
                        <Button
                          variant="secondary"
                          size="sm"
                          leftIcon={<IconRefreshCw size={15} />}
                          onClick={() => void wakePriorityRotationSidecar()}
                          disabled={priorityRotationSidecarWaking}
                          loading={priorityRotationSidecarWaking}
                        >
                          {t('auth_files.priority_rotation_sidecar_wake_button')}
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => void savePriorityRotationSidecarSecret()}
                        disabled={
                          !managementKey ||
                          priorityRotationSidecarWaking ||
                          priorityRotationSidecarSecretSaving
                        }
                        loading={priorityRotationSidecarSecretSaving}
                      >
                        {t('auth_files.priority_rotation_sidecar_save_secret')}
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        leftIcon={<IconRefreshCw size={15} />}
                        onClick={() => void runPriorityRotationSidecarNow()}
                        disabled={
                          !managementKey ||
                          priorityRotationSidecarWaking ||
                          priorityRotationSidecarRunSaving
                        }
                        loading={priorityRotationSidecarRunSaving}
                      >
                        {t('auth_files.priority_rotation_sidecar_run_now')}
                      </Button>
                    </div>
                  </div>
                  {priorityRotationSidecarHasAnomalousNoChanges && (
                    <div className={styles.priorityRotationBackgroundError}>
                      {t('auth_files.priority_rotation_sidecar_anomaly_warning')}
                    </div>
                  )}
                  {priorityRotationSidecarError && (
                    <div className={styles.priorityRotationBackgroundError}>
                      {priorityRotationSidecarError}
                    </div>
                  )}
                </div>
              </div>
            </details>

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

            <div className={styles.fileListHeader} ref={fileListHeaderRef}>
              <div className={styles.fileListHeaderText}>
                <span className={styles.fileListKicker}>
                  {t('auth_files.list_kicker', { defaultValue: '日常管理' })}
                </span>
                <div className={styles.fileListTitleRow}>
                  <h3 className={styles.fileListTitle}>{listHeaderTitle}</h3>
                  <Button
                    variant="secondary"
                    size="sm"
                    className={styles.fileListQuotaRefreshButton}
                    leftIcon={<IconRefreshCw size={15} />}
                    onClick={() => void handleRefreshCodexQuota()}
                    disabled={
                      disableControls ||
                      codexQuotaRefreshing ||
                      loading ||
                      codexQuotaRefreshTargets.length === 0
                    }
                    loading={codexQuotaRefreshing}
                    loadingLabel={t('codex_quota.loading')}
                    title={t('auth_files.quota_refresh_all_title', {
                      count: codexQuotaRefreshTargets.length,
                      defaultValue: '刷新 {{count}} 个 Codex 账号额度',
                    })}
                  >
                    <span>{t('codex_quota.refresh_button')}</span>
                    <span className={styles.fileListQuotaRefreshCount}>
                      {codexQuotaRefreshTargets.length}
                    </span>
                  </Button>
                </div>
              </div>
              <div
                className={`${styles.fileListPagination} ${
                  showListPaginationControls ? '' : styles.fileListPaginationSingle
                }`}
                aria-label={t('auth_files.pagination_label', {
                  defaultValue: '认证文件分页',
                })}
              >
                {showListPaginationControls && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className={styles.fileListPaginationButton}
                    onClick={() => setPage(Math.max(1, currentPage - 1))}
                    disabled={currentPage <= 1}
                  >
                    {t('auth_files.pagination_prev')}
                  </Button>
                )}
                <div className={styles.fileListPaginationInfo}>{listHeaderMeta}</div>
                {showListPaginationControls && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className={styles.fileListPaginationButton}
                    onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                    disabled={currentPage >= totalPages}
                  >
                    {t('auth_files.pagination_next')}
                  </Button>
                )}
              </div>
              <div className={styles.fileListHeaderActions}>
                <Button
                  variant="secondary"
                  size="sm"
                  className={styles.fileListCodexLoginButton}
                  leftIcon={<IconExternalLink size={15} />}
                  onClick={() => void handleOpenCodexOAuth()}
                  disabled={disableControls || codexOAuthOpening}
                  loading={codexOAuthOpening}
                  loadingLabel={t('auth_files.codex_oauth_opening', {
                    defaultValue: '打开中',
                  })}
                  title={codexOAuthButtonTitle}
                >
                  {codexOAuthButtonLabel}
                </Button>
                {codexOAuthCountdownActive && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className={styles.fileListCodexCancelButton}
                    onClick={handleCancelCodexOAuth}
                    disabled={disableControls}
                    title={t('auth_files.codex_oauth_cancel_title', {
                      defaultValue: '停止等待本次 Codex 登录',
                    })}
                  >
                    {t('auth_files.codex_oauth_cancel', { defaultValue: '取消登录' })}
                  </Button>
                )}
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
                ref={fileGridRef}
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
                    deleting={deleting === file.name}
                    statusUpdating={statusUpdating[file.name] === true}
                    quotaFilterType={quotaFilterType}
                    statusData={statusDataByFileName.get(file.name)!}
                    authTokenSnapshot={authTokenSnapshots.get(file.name)}
                    codexSubscriptionSnapshot={codexSubscriptionSnapshots.get(file.name)}
                    manualExpiryMs={getManualExpiryMs(manualExpiryByFile, file.name)}
                    priorityTier={priorityTierByFile.get(file.name) ?? null}
                    accountMemo={getAuthFileAccountMemo(accountMemosByFile, file.name)?.text ?? ''}
                    priorityUpdating={priorityUpdating[file.name] === true}
                    noteUpdating={noteUpdating[file.name] === true}
                    onShowModels={showModels}
                    onDownload={handleDownload}
                    onOpenPrefixProxyEditor={openPrefixProxyEditor}
                    onManualExpiryEdit={openManualExpiryEditor}
                    onAccountMemoOpen={openAccountMemoEditor}
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

          </div>
        </div>
      </Card>

      <section
        className={styles.oauthConfigSection}
        aria-label={t('auth_files.oauth_config_title', { defaultValue: 'OAuth 配置' })}
      >
        <div className={styles.oauthConfigHeader}>
          <div className={styles.oauthConfigHeaderText}>
            <span className={styles.oauthConfigKicker}>
              {t('auth_files.oauth_config_kicker', { defaultValue: '高级配置' })}
            </span>
            <h2 className={styles.oauthConfigTitle}>
              {t('auth_files.oauth_config_title', { defaultValue: 'OAuth 配置' })}
            </h2>
          </div>
          <p className={styles.oauthConfigCopy}>
            {t('auth_files.oauth_config_copy', {
              defaultValue: '模型禁用与别名映射保留为独立配置区，和日常认证文件管理分开阅读。',
            })}
          </p>
        </div>
        <div className={styles.oauthConfigGrid}>
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
        </div>
      </section>

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
        open={priorityRotationPreviewOpen}
        title={
          <span className={styles.priorityRotationTierDetailTitle}>
            {t('auth_files.priority_rotation_modal_title')}
          </span>
        }
        onClose={() => {
          if (!priorityRotationPreviewApplying) {
            setPriorityRotationPreviewOpen(false);
          }
        }}
        width={820}
        className={styles.priorityRotationModal}
        overlayClassName={styles.priorityRotationOverlay}
        closeDisabled={priorityRotationPreviewApplying}
        footer={
          <div className={styles.priorityRotationFooter}>
            <span className={styles.priorityRotationFooterHint}>
              <IconSlidersHorizontal size={14} />
              {t('auth_files.priority_rotation_hint')}
            </span>
            <span className={styles.priorityRotationFooterActions}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPriorityRotationPreviewOpen(false)}
                disabled={priorityRotationPreviewApplying}
              >
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={() => void applyPriorityRotationPreview()}
                disabled={priorityRotationPreviewDisabled}
                loading={priorityRotationPreviewApplying}
              >
                {t('auth_files.priority_rotation_apply')}
              </Button>
            </span>
          </div>
        }
      >
        <div className={styles.priorityRotationPreview}>
          <div className={styles.priorityRotationSummary}>
            {priorityRotationPreviewSummaryItems.map((item) => (
              <div className={styles.priorityRotationSummaryItem} key={item.key}>
                <span className={styles.priorityRotationSummaryLabel}>{item.label}</span>
                <span className={styles.priorityRotationSummaryValue}>{item.value}</span>
              </div>
            ))}
          </div>

          {priorityRotationAnalysis.changes.length === 0 ? (
            <div className={styles.priorityRotationHint}>
              {t('auth_files.priority_rotation_no_changes')}
            </div>
          ) : (
            <div className={styles.priorityRotationTable}>
              <div className={styles.priorityRotationHeader}>
                <span>{t('auth_files.priority_rotation_col_file')}</span>
                <span>{t('auth_files.priority_rotation_col_priority')}</span>
                <span>{t('auth_files.priority_rotation_col_remaining')}</span>
                <span>{t('auth_files.priority_rotation_col_reason')}</span>
              </div>
              {priorityRotationAnalysis.changes.map((change) => (
                <div className={styles.priorityRotationRow} key={change.name}>
                  <span className={styles.priorityRotationIdentity}>
                    <span className={styles.priorityRotationDisplayName} title={change.displayName}>
                      {change.displayName}
                    </span>
                    <span className={styles.priorityRotationFileName} title={change.name}>
                      {change.name}
                    </span>
                  </span>
                  <span
                    className={`${styles.priorityRotationDirection} ${
                      change.role === 'promote'
                        ? styles.priorityRotationDirectionPromote
                        : styles.priorityRotationDirectionDemote
                    }`}
                  >
                    {formatPriorityRotationPriority(change.fromPriority)}
                    <span aria-hidden="true">→</span>
                    {formatPriorityRotationPriority(change.toPriority)}
                  </span>
                  <span className={styles.priorityRotationRemaining}>
                    {formatPriorityRotationPercent(change.remainingPercent)}
                  </span>
                  <span
                    className={styles.priorityRotationReason}
                    title={getPriorityRotationReasonLabel(change.reason)}
                  >
                    {getPriorityRotationReasonLabel(change.reason)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

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
              <strong>{priorityRotationDetailPriorityLabel}</strong>
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
        open={Boolean(accountMemoEditorFile)}
        title={
          <span className={styles.accountMemoModalTitle}>
            {t('auth_files.account_memo_title', { defaultValue: '账号备注' })}
          </span>
        }
        onClose={closeAccountMemoEditor}
        closeDisabled={Boolean(accountMemoPreviewImage)}
        width={720}
        className={styles.accountMemoModal}
        overlayClassName={styles.accountMemoOverlay}
        footer={
          <div className={styles.accountMemoFooter}>
            <Button
              variant="ghost"
              size="sm"
              onClick={clearAccountMemo}
              disabled={!accountMemoEditorHasExisting && !accountMemoHasDraftContent}
            >
              {t('auth_files.account_memo_clear', { defaultValue: '清除' })}
            </Button>
            <Button variant="secondary" size="sm" onClick={closeAccountMemoEditor}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={saveAccountMemo} disabled={accountMemoImageProcessing}>
              {t('common.save')}
            </Button>
          </div>
        }
      >
        <div className={styles.accountMemoEditor}>
          <div className={styles.accountMemoTarget} title={accountMemoEditorFileName}>
            <div className={styles.accountMemoTargetHeader}>
              <span className={styles.accountMemoTargetName}>{accountMemoEditorDisplayName}</span>
              <span className={styles.accountMemoCodexActions}>
                <Button
                  variant="secondary"
                  size="sm"
                  className={`${styles.fileListCodexLoginButton} ${styles.accountMemoCodexLoginButton}`}
                  leftIcon={<IconExternalLink size={14} />}
                  onClick={() => void handleOpenCodexOAuth()}
                  disabled={disableControls || codexOAuthOpening}
                  loading={codexOAuthOpening}
                  loadingLabel={t('auth_files.codex_oauth_opening', {
                    defaultValue: '打开中',
                  })}
                  title={codexOAuthButtonTitle}
                >
                  {codexOAuthButtonLabel}
                </Button>
                {codexOAuthCountdownActive && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className={`${styles.fileListCodexCancelButton} ${styles.accountMemoCodexCancelButton}`}
                    onClick={handleCancelCodexOAuth}
                    disabled={disableControls}
                    title={t('auth_files.codex_oauth_cancel_title', {
                      defaultValue: '停止等待本次 Codex 登录',
                    })}
                  >
                    {t('auth_files.codex_oauth_cancel', { defaultValue: '取消登录' })}
                  </Button>
                )}
              </span>
            </div>
            <span className={styles.accountMemoTargetFile}>
              {t('auth_files.account_memo_file_label', { defaultValue: '文件' })}
              <strong>{accountMemoEditorFileName}</strong>
            </span>
          </div>
          <label className={styles.accountMemoField}>
            <span>{t('auth_files.account_memo_label', { defaultValue: '备注' })}</span>
            <textarea
              value={accountMemoDraft}
              onChange={(event) => setAccountMemoDraft(event.currentTarget.value)}
              onPaste={handleAccountMemoPaste}
              placeholder={t('auth_files.account_memo_placeholder', {
                defaultValue: '写下这个账号是哪家的、从哪里来、用途、注意事项等。',
              })}
              rows={8}
            />
          </label>
          {accountMemoPreviewBlocks.length > 0 && (
            <div
              className={styles.accountMemoLinksPreview}
              aria-label={t('auth_files.account_memo_links_preview', {
                defaultValue: '备注链接与复制预览',
              })}
            >
              <span className={styles.accountMemoLinksLabel}>
                {t('auth_files.account_memo_links_label', { defaultValue: '链接与复制内容' })}
              </span>
              <div className={styles.accountMemoLinks}>
                {accountMemoPreviewBlocks.map((block, index) => (
                  <div
                    className={styles.accountMemoPreviewItem}
                    key={`${block.link.href}-${block.startIndex}-${index}`}
                  >
                    <div className={styles.accountMemoPreviewItemHeader}>
                      <button
                        type="button"
                        className={styles.accountMemoLink}
                        title={block.link.href}
                        onClick={() => void handleOpenAccountMemoLink(block.link.href)}
                      >
                        <IconExternalLink size={13} />
                        <span>{block.link.label}</span>
                      </button>
                      {block.copyText && (
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          className={styles.accountMemoCopyButton}
                          leftIcon={<IconCopy size={13} />}
                          onClick={() => void handleCopyAccountMemoPreviewText(block.copyText)}
                        >
                          {t('auth_files.account_memo_copy_button', {
                            defaultValue: '复制内容',
                          })}
                        </Button>
                      )}
                    </div>
                    {block.copyText && (
                      <p className={styles.accountMemoCopyText}>{block.copyText}</p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
          {accountMemoShouldShowImagePanel && (
            <div className={styles.accountMemoImagePanel}>
              <div className={styles.accountMemoImageHeader}>
                <span>{t('auth_files.account_memo_images_label', { defaultValue: '图片' })}</span>
                <span>
                  {accountMemoImagesDraft.length}/{AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES}
                </span>
              </div>
              {accountMemoImagesDraft.length > 0 && (
                <div className={styles.accountMemoImageGrid}>
                  {accountMemoImagesDraft.map((image) => (
                    <div className={styles.accountMemoImageItem} key={image.id}>
                      <button
                        type="button"
                        className={styles.accountMemoImageThumb}
                        draggable
                        onClick={() => setAccountMemoPreviewImage(image)}
                        onDragStart={(event) => setAccountMemoImageDragData(event, image)}
                        aria-label={t('auth_files.account_memo_image_preview', {
                          name: image.name,
                          defaultValue: '预览图片',
                        })}
                        title={image.name}
                      >
                        <img src={image.dataUrl} alt={image.name} />
                      </button>
                      <div className={styles.accountMemoImageActions}>
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          iconOnly
                          leftIcon={<IconEye size={14} />}
                          onClick={() => setAccountMemoPreviewImage(image)}
                          aria-label={t('auth_files.account_memo_image_preview', {
                            name: image.name,
                            defaultValue: '预览图片',
                          })}
                          title={t('auth_files.account_memo_image_preview', {
                            name: image.name,
                            defaultValue: '预览图片',
                          })}
                        />
                        <Button
                          type="button"
                          variant="secondary"
                          size="xs"
                          iconOnly
                          leftIcon={<IconDownload size={14} />}
                          onClick={() => downloadAccountMemoImage(image)}
                          aria-label={t('auth_files.account_memo_image_download', {
                            name: image.name,
                            defaultValue: '下载图片',
                          })}
                          title={t('auth_files.account_memo_image_download', {
                            name: image.name,
                            defaultValue: '下载图片',
                          })}
                        />
                        <Button
                          type="button"
                          variant="danger"
                          size="xs"
                          iconOnly
                          leftIcon={<IconTrash2 size={14} />}
                          onClick={() => removeAccountMemoImage(image.id)}
                          aria-label={t('auth_files.account_memo_image_remove', {
                            name: image.name,
                            defaultValue: '移除图片',
                          })}
                          title={t('auth_files.account_memo_image_remove', {
                            name: image.name,
                            defaultValue: '移除图片',
                          })}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {accountMemoImageProcessing && (
                <div className={styles.accountMemoImageStatus}>
                  {t('auth_files.account_memo_image_processing', { defaultValue: '正在处理图片' })}
                </div>
              )}
              {accountMemoImageSlotsRemaining <= 0 && (
                <div className={styles.accountMemoImageStatus}>
                  {t('auth_files.account_memo_image_limit', {
                    count: AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES,
                    defaultValue: `每个账号备注最多保存 ${AUTH_FILE_ACCOUNT_MEMO_MAX_IMAGES} 张图片`,
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </Modal>

      <Modal
        open={Boolean(accountMemoPreviewImage)}
        title={accountMemoPreviewImage?.name ?? ''}
        onClose={() => setAccountMemoPreviewImage(null)}
        width={760}
        className={styles.accountMemoImagePreviewModal}
        footer={
          accountMemoPreviewImage ? (
            <div className={styles.accountMemoImagePreviewFooter}>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                leftIcon={<IconDownload size={15} />}
                onClick={() => downloadAccountMemoImage(accountMemoPreviewImage)}
              >
                {t('auth_files.account_memo_image_download', { defaultValue: '下载图片' })}
              </Button>
            </div>
          ) : null
        }
      >
        {accountMemoPreviewImage && (
          <div className={styles.accountMemoImagePreviewBody}>
            <img
              src={accountMemoPreviewImage.dataUrl}
              alt={accountMemoPreviewImage.name}
              draggable
              onDragStart={(event) =>
                setAccountMemoImageDragData(event, accountMemoPreviewImage)
              }
            />
          </div>
        )}
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

      {batchActionBarVisible && typeof document !== 'undefined'
        ? createPortal(
            <div className={styles.batchActionContainer} ref={floatingBatchActionsRef}>
              <div className={styles.batchActionBar}>
                <div className={styles.batchActionLeft}>
                  <span className={styles.batchSelectionText}>
                    {batchProgressLabel
                      ? `${t('auth_files.batch_selected', { count: selectionCount })} ${batchProgressLabel}`
                      : t('auth_files.batch_selected', { count: selectionCount })}
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
                    <span className={styles.batchPriorityLabel}>
                      {t('auth_files.batch_priority_context_label', {
                        count: selectionCount,
                        defaultValue: `设置 ${selectionCount} 文件的优先级`,
                      })}
                    </span>
                    <input
                      className={styles.batchPriorityInput}
                      type="text"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      value={batchPriorityInput}
                      onChange={(event) =>
                        setBatchPriorityInput(event.currentTarget.value.replace(/\D/g, ''))
                      }
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
      {uploadDropActive && (
        <div className={styles.globalUploadOverlay} aria-hidden={uploadDropDisabled}>
          <div className={styles.globalUploadOverlayPanel}>
            <IconUploadCloud size={34} />
            <strong>
              {uploadDropDisabled
                ? t('auth_files.upload_pool_disabled', { defaultValue: '当前无法上传' })
                : t('auth_files.upload_overlay_title', { defaultValue: '松开即可上传 JSON' })}
            </strong>
            <span>
              {uploadDropProgressMeta ||
                t('auth_files.upload_overlay_hint', {
                  defaultValue: '支持多文件拖拽，上传完成后列表会自动刷新。',
                })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
