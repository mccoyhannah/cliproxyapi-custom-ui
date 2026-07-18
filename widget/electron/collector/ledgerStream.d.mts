export interface StreamLedgerOptions {
  highWaterMark?: number;
  maxEntryChars?: number;
  onEntry?: (entry: Record<string, unknown>) => void;
}

export interface StreamLedgerResult {
  version: number | null;
  generatedAt: string | null;
  coverageStartMs: number | null;
  coverageEndMs: number | null;
  entriesRead: number;
  parseErrors: number;
  bytesRead: number;
}

export function streamLedgerEntries(
  filePath: string,
  options?: StreamLedgerOptions
): Promise<StreamLedgerResult>;
