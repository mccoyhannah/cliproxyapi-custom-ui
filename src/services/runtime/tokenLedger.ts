import type { TokenLedgerSnapshot } from '@/types/usageStatistics';

const TOKEN_LEDGER_URLS = ['/token-ledger.json', '/static/token-ledger.json'];
const MANAGEMENT_HTML_URL = '/management.html';
const EMBEDDED_LEDGER_ID = 'cpamc-token-ledger';

interface TokenLedgerLoadOptions {
  forceNetwork?: boolean;
}

const parseLedgerText = (text: string | null | undefined): TokenLedgerSnapshot | null => {
  if (!text?.trim()) return null;

  try {
    return JSON.parse(text) as TokenLedgerSnapshot;
  } catch {
    return null;
  }
};

const readEmbeddedLedger = (): TokenLedgerSnapshot | null => {
  if (typeof document === 'undefined') return null;
  const element = document.getElementById(EMBEDDED_LEDGER_ID);
  return parseLedgerText(element?.textContent);
};

const readEmbeddedLedgerFromHtml = (html: string): TokenLedgerSnapshot | null => {
  const pattern = new RegExp(
    `<script[^>]*id=["']${EMBEDDED_LEDGER_ID}["'][^>]*>([\\s\\S]*?)<\\/script>`,
    'i'
  );
  const match = html.match(pattern);
  return parseLedgerText(match?.[1]);
};

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

const fetchEmbeddedLedger = async (): Promise<TokenLedgerSnapshot | null> => {
  const cacheBuster = Date.now();
  const response = await fetch(`${MANAGEMENT_HTML_URL}?ledger=${cacheBuster}`, {
    cache: 'no-store',
  });

  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Token ledger page load failed: ${response.status}`);
  }

  return readEmbeddedLedgerFromHtml(await response.text());
};

export const tokenLedgerApi = {
  async getLedger(options: TokenLedgerLoadOptions = {}): Promise<TokenLedgerSnapshot | null> {
    if (!options.forceNetwork) {
      const embedded = readEmbeddedLedger();
      if (embedded) return embedded;
    }

    return (await fetchJsonLedger()) ?? (await fetchEmbeddedLedger()) ?? readEmbeddedLedger();
  },
};
