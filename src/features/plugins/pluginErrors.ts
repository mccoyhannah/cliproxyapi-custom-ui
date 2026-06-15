export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export const getErrorMessage = (error: unknown, fallback = ''): string => {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (!isRecord(error)) return fallback;

  const message = error.message;
  if (typeof message === 'string' && message) return message;

  const details = error.details ?? error.data;
  if (isRecord(details)) {
    const detailMessage = details.message ?? details.error;
    if (typeof detailMessage === 'string' && detailMessage) return detailMessage;
    if (isRecord(detailMessage) && typeof detailMessage.message === 'string') {
      return detailMessage.message;
    }
  }

  return fallback;
};

export const getErrorStatus = (error: unknown): number | undefined =>
  isRecord(error) && typeof error.status === 'number' ? error.status : undefined;

const hasRestartRequired = (value: unknown): boolean =>
  isRecord(value) &&
  (value.restart_required === true ||
    value.restartRequired === true ||
    value.status === 'restart_required');

export const hasRestartRequiredError = (error: unknown): boolean =>
  isRecord(error) && (hasRestartRequired(error.details) || hasRestartRequired(error.data));
