import {
  DEFAULT_LOG_READ_LIMIT_BYTES,
  readTokenResponseLog,
} from '../../../scripts/lib/token-log-reader.mjs';

export { DEFAULT_LOG_READ_LIMIT_BYTES };

export async function readBoundedResponseLog(filePath, stats, options = {}) {
  const { bytesRead, parsed } = await readTokenResponseLog(filePath, stats, options);

  return {
    bytesRead,
    parsed,
  };
}
