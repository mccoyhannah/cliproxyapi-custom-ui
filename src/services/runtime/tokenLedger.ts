import type { TokenLedgerSnapshot } from '@/types/usageStatistics';

const TOKEN_LEDGER_URLS = ['/token-ledger.json', '/static/token-ledger.json'];
const CONTROL_TOKEN_LEDGER_URL = 'http://127.0.0.1:8319/token-ledger';

interface TokenLedgerLoadOptions {
  forceNetwork?: boolean;
  controlFallback?: boolean;
  requireLedger?: boolean;
}

const fetchJsonUrl = async (url: string, timeoutMs?: number): Promise<TokenLedgerSnapshot | null> => {
  const controller = timeoutMs ? new AbortController() : null;
  const timeout = controller
    ? window.setTimeout(() => controller.abort(), timeoutMs)
    : null;

  try {
    const response = await fetch(`${url}?v=${Date.now()}`, {
      cache: 'no-store',
      signal: controller?.signal,
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Token ledger load failed: ${response.status}`);
    }

    return (await response.json()) as TokenLedgerSnapshot;
  } finally {
    if (timeout !== null) window.clearTimeout(timeout);
  }
};

const fetchStaticLedger = async (): Promise<TokenLedgerSnapshot | null> => {
  for (const url of TOKEN_LEDGER_URLS) {
    try {
      const snapshot = await fetchJsonUrl(url);
      if (snapshot) return snapshot;
    } catch {
      continue;
    }
  }

  return null;
};

const fetchControlLedger = async (): Promise<TokenLedgerSnapshot | null> =>
  fetchJsonUrl(CONTROL_TOKEN_LEDGER_URL, 30_000);

export const tokenLedgerApi = {
  async getLedger(options: TokenLedgerLoadOptions = {}): Promise<TokenLedgerSnapshot | null> {
    const staticLedger = await fetchStaticLedger();
    if (staticLedger) return staticLedger;

    let controlError: unknown = null;
    if (options.controlFallback) {
      try {
        const controlLedger = await fetchControlLedger();
        if (controlLedger) return controlLedger;
      } catch (err) {
        controlError = err;
      }
    }

    if (options.requireLedger) {
      if (controlError instanceof Error) {
        throw new Error(`长期 Token 台账读取失败: ${controlError.message}`);
      }
      throw new Error('长期 Token 台账文件没有通过 8317 或本机控制助手提供');
    }

    return null;
  },
};
