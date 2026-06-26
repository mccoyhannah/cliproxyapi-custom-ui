import { useNotificationStore } from '@/stores/useNotificationStore';
import type { ApiError } from '@/types';

interface NotifyApiErrorOptions {
  message?: string;
  dedupeKey?: string;
  dedupeMs?: number;
}

const getApiErrorLabel = (error: ApiError) => {
  if (error.status === 401) return 'Unauthorized';
  if (error.status) return `HTTP ${error.status}`;
  if (error.code === 'ECONNABORTED') return 'Timeout';
  if (error.code) return error.code;
  return 'Request failed';
};

export function notifyApiError(error: ApiError, options: NotifyApiErrorOptions = {}) {
  const label = getApiErrorLabel(error);
  const message = options.message
    ? `${options.message}${error.message ? `: ${error.message}` : ''}`
    : `${label}: ${error.message}`;

  useNotificationStore.getState().showNotification(message, 'error', undefined, {
    dedupeKey: options.dedupeKey ?? `api-error:${error.status ?? error.code ?? error.message}`,
    dedupeMs: options.dedupeMs ?? 4000,
  });
}
