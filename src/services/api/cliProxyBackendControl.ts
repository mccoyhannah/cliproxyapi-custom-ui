export type CliProxyBackendControlStatus = {
  ok: boolean;
  pid: number;
  host: string;
  port: number;
  installDir: string;
  customUiDir: string;
  backendPort: number;
  idleShutdownMinutes: number;
  restartScriptPath: string;
  backendRunning: boolean;
  backendPid: number | null;
  backendPath: string | null;
  backendStartedAt: string | null;
  backendPathMatches: boolean;
  backendError: string | null;
  restarting: boolean;
};

export type CliProxyBackendRestartResult = {
  ok: boolean;
  oldPid?: number | null;
  newPid?: number | null;
  backendPort?: number;
  startedAt?: string;
  completedAt?: string;
  logPath?: string;
  error?: string;
};

export type CliProxyBackendRestartResponse = {
  ok: boolean;
  controlPid: number;
  result: CliProxyBackendRestartResult;
  status: CliProxyBackendControlStatus;
};

export type CliProxyBackendControlRequestError = Error & {
  status?: number;
  data?: unknown;
  body?: string;
};

const CONTROL_BASE_URL = 'http://127.0.0.1:8319';
const CONTROL_WAKE_URL = 'cpamc-cliproxyapi-control://start';

export const launchCliProxyBackendControlSidecar = (): boolean => {
  if (typeof document === 'undefined') return false;

  const frame = document.createElement('iframe');
  frame.style.display = 'none';
  frame.setAttribute('aria-hidden', 'true');
  frame.src = CONTROL_WAKE_URL;
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), 5_000);
  return true;
};

const buildHeaders = (managementKey?: string): HeadersInit => ({
  'Content-Type': 'application/json',
  ...(managementKey ? { Authorization: `Bearer ${managementKey}` } : {}),
});

const requestControl = async <T>(
  path: string,
  options: RequestInit & { managementKey?: string } = {}
): Promise<T> => {
  const { managementKey, ...fetchOptions } = options;
  const response = await fetch(`${CONTROL_BASE_URL}${path}`, {
    ...fetchOptions,
    headers: {
      ...buildHeaders(managementKey),
      ...(fetchOptions.headers || {}),
    },
  });
  const text = await response.text();
  const trimmedText = text.trim();
  let data: unknown = null;
  let parseFailed = false;
  if (trimmedText) {
    try {
      data = JSON.parse(trimmedText);
    } catch {
      parseFailed = true;
    }
  }

  if (response.ok && parseFailed) {
    throw new Error(
      `Invalid control helper JSON response: ${response.status} ${trimmedText.slice(0, 160)}`
    );
  }

  if (!response.ok) {
    const rawMessage = trimmedText.slice(0, 160);
    const errorMessage =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error?: unknown }).error
        : null;
    const message =
      typeof errorMessage === 'string'
        ? errorMessage
        : rawMessage
          ? `Control helper request failed: ${response.status} ${rawMessage}`
          : `Control helper request failed: ${response.status}`;
    const error = new Error(message) as CliProxyBackendControlRequestError;
    error.status = response.status;
    error.data = data;
    error.body = trimmedText;
    throw error;
  }

  return data as T;
};

export const cliProxyBackendControlApi = {
  getStatus: () => requestControl<CliProxyBackendControlStatus>('/status'),

  restart: (payload: { apiBase: string; managementKey: string }) =>
    requestControl<CliProxyBackendRestartResponse>('/restart', {
      method: 'POST',
      managementKey: payload.managementKey,
      body: JSON.stringify(payload),
    }),
};
