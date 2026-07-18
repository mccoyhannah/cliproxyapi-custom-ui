import type { CoreEntryStatus, CoreTokenUsage } from '../../../scripts/lib/token-log-core.mjs';

export const DEFAULT_LOG_READ_LIMIT_BYTES: number;

export interface BoundedLogResult {
  bytesRead: number;
  parsed: {
    status: CoreEntryStatus;
    model: string | null;
    tokenUsage: CoreTokenUsage;
  };
}

export function readBoundedResponseLog(
  filePath: string,
  stats: { size: number },
  options?: { maxBytes?: number; headBytes?: number; stable?: boolean }
): Promise<BoundedLogResult>;
