export const TOKEN_LOG_CORE_VERSION: string;
export const LOG_FILE_PATTERN: RegExp;

export type CoreEntryStatus =
  | 'available'
  | 'pending'
  | 'unreported'
  | 'ambiguous'
  | 'parse-error'
  | 'unsupported';

export interface CoreTokenUsage {
  input: number;
  output: number;
  cached: number;
  reasoning: number;
  total: number;
  status: string;
}

export function emptyTokenUsage(status?: string): CoreTokenUsage;
export function normalizeModelName(value: unknown): string | null;
export function extractConfiguredModel(raw: string): string | null;
export function extractActualModel(raw: string): string | null;
export function extractUsageObjects(text: string): {
  objects: Array<Record<string, unknown>>;
  sawUsageField: boolean;
};
export function normalizeTokenUsage(usage: Record<string, unknown>): CoreTokenUsage;
export function extractTokenUsage(text: string): {
  usage: CoreTokenUsage;
  parseError: boolean;
};
export function extractResponsePayload(options?: {
  fullText?: string | null;
  headText?: string;
  tailText?: string;
  stable?: boolean;
}): {
  status: 'complete' | 'pending' | 'unsupported';
  text: string;
  segments: string[];
  explicitEnd: boolean;
};
export function parseExtractedResponsePayload(response: {
  status: 'complete' | 'pending' | 'unsupported';
  text: string;
  segments?: string[];
  explicitEnd?: boolean;
}): { status: CoreEntryStatus; model: string | null; tokenUsage: CoreTokenUsage };
export function parseResponseLogText(
  text: string,
  options?: { stable?: boolean }
): { status: CoreEntryStatus; model: string | null; tokenUsage: CoreTokenUsage };
export function parseLogFilename(
  fileName: string,
  fallbackTimestampMs?: number | null
): {
  fileType: string;
  timestampMs: number | null;
  requestId: string | null;
};
export function hashPrivateIdentifier(value: unknown): string;
export function buildRequestDedupeKey(value: {
  fileType: string;
  timestampMs: number | null;
  requestId: string | null;
  sourceIdentity?: string | null;
}): string;
export function dedupeTokenEntries<
  T extends {
    dedupeKey: string;
    status: CoreEntryStatus;
    model: string | null;
    tokenUsage: CoreTokenUsage;
    lastModifiedMs?: number;
  },
>(entries: T[]): T[];
export function preferredLedgerEntry<T>(left: T, right: T): T;
export function dedupeLedgerEntries<
  T extends {
    fileType?: string;
    timestampMs?: number | null;
    requestId?: string | null;
    sourceKey?: string;
    fileName?: string;
    sourceDir?: string;
    detailStatus?: string;
    tokenUsage?: CoreTokenUsage;
    lastModifiedMs?: number;
    fileSize?: number;
  },
>(entries: T[]): T[];
