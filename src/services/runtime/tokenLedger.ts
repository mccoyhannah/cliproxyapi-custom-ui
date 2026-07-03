import type { TokenLedgerSnapshot } from '@/types/usageStatistics';

const TOKEN_LEDGER_URLS = ['/token-ledger.json', '/static/token-ledger.json'];

interface TokenLedgerLoadOptions {
  forceNetwork?: boolean;
}

const fetchJsonLedger = async (): Promise<TokenLedgerSnapshot | null> => {
  const cacheBuster = Date.now();

  for (const url of TOKEN_LEDGER_URLS) {
    const response = await fetch(`${url}?v=${cacheBuster}`, {
      cache: 'no-store',
    });

    if (response.status === 404) continue;
    if (!response.ok) {
      throw new Error(`Token ledger load failed: ${response.status}`);
    }

    try {
      return (await response.json()) as TokenLedgerSnapshot;
    } catch {
      continue;
    }
  }

  return null;
};

export const tokenLedgerApi = {
  async getLedger(_options: TokenLedgerLoadOptions = {}): Promise<TokenLedgerSnapshot | null> {
    return fetchJsonLedger();
  },
};
