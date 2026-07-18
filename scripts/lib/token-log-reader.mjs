import fs from 'node:fs/promises';

import {
  extractResponsePayload,
  parseExtractedResponsePayload,
  parseLogSectionMarkerLine,
} from './token-log-core.mjs';

export const DEFAULT_LOG_READ_LIMIT_BYTES = 512 * 1024;
export const DEFAULT_LOG_HEAD_BYTES = 64 * 1024;
export const DEFAULT_MARKER_BACKSCAN_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MARKER_SCAN_CHUNK_BYTES = 64 * 1024;
export const DEFAULT_MARKER_SCAN_OVERLAP_BYTES = 256;

const SECTION_MARKER_PATTERN = /^===\s*(.+?)\s*===\s*$/gm;

const readRange = async (handle, start, length) => {
  if (length <= 0) {
    return { bytesRead: 0, buffer: Buffer.alloc(0) };
  }
  const buffer = Buffer.alloc(length);
  const result = await handle.read(buffer, 0, length, start);
  return {
    bytesRead: result.bytesRead,
    buffer: buffer.subarray(0, result.bytesRead),
  };
};

const findNearestMiddleMarker = async ({
  handle,
  start,
  end,
  maxBytes,
  chunkBytes,
  overlapBytes,
  suffixBuffer,
}) => {
  const scanStart = Math.max(start, end - maxBytes);
  let bytesRead = 0;
  let trailingBuffer = suffixBuffer.subarray(0, overlapBytes);

  for (let cursor = end; cursor > scanStart; ) {
    const chunkStart = Math.max(scanStart, cursor - chunkBytes);
    const chunk = await readRange(handle, chunkStart, cursor - chunkStart);
    bytesRead += chunk.bytesRead;
    const scanBuffer =
      trailingBuffer.length > 0
        ? Buffer.concat([chunk.buffer, trailingBuffer])
        : chunk.buffer;
    const text = scanBuffer.toString('latin1');
    SECTION_MARKER_PATTERN.lastIndex = 0;
    let match;
    let nearestMarker = null;
    while ((match = SECTION_MARKER_PATTERN.exec(text)) !== null) {
      if (match.index >= chunk.bytesRead) continue;
      const kind = parseLogSectionMarkerLine(match[0]);
      if (kind) nearestMarker = kind;
    }
    if (nearestMarker) return { bytesRead, marker: nearestMarker };

    trailingBuffer = chunk.buffer.subarray(0, Math.min(overlapBytes, chunk.bytesRead));
    cursor = chunkStart;
  }
  return { bytesRead, marker: null };
};

const normalizedPositiveInteger = (value, fallback, minimum = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.floor(parsed)) : fallback;
};

export async function readTokenResponseLog(filePath, stats, options = {}) {
  // The caller's stat is only a snapshot; append-only logs can grow before this read starts.
  void stats;
  const io = options.fsAdapter ?? fs;
  const maxBytes = normalizedPositiveInteger(
    options.maxBytes,
    DEFAULT_LOG_READ_LIMIT_BYTES,
    8 * 1024
  );
  const headBytesLimit = Math.min(
    normalizedPositiveInteger(options.headBytes, DEFAULT_LOG_HEAD_BYTES, 4 * 1024),
    maxBytes
  );
  const maxMarkerBackscanBytes = Math.min(
    normalizedPositiveInteger(
      options.maxMarkerBackscanBytes,
      DEFAULT_MARKER_BACKSCAN_BYTES
    ),
    DEFAULT_MARKER_BACKSCAN_BYTES
  );
  const markerScanChunkBytes = normalizedPositiveInteger(
    options.markerScanChunkBytes,
    DEFAULT_MARKER_SCAN_CHUNK_BYTES,
    4 * 1024
  );
  const markerScanOverlapBytes = Math.min(
    normalizedPositiveInteger(
      options.markerScanOverlapBytes,
      DEFAULT_MARKER_SCAN_OVERLAP_BYTES
    ),
    markerScanChunkBytes
  );
  const stable = options.stable === true;
  const handle = await io.open(filePath, 'r');
  try {
    const currentStats = await handle.stat();
    const fileSize = Math.max(0, Number(currentStats.size) || 0);

    if (fileSize <= maxBytes) {
      const full = await readRange(handle, 0, fileSize);
      const response = extractResponsePayload({
        fullText: full.buffer.toString('utf8'),
        stable,
      });
      return {
        bytesRead: full.bytesRead,
        response,
        parsed: parseExtractedResponsePayload(response),
      };
    }

    const headBytes = Math.min(headBytesLimit, fileSize);
    const tailBytes = Math.min(maxBytes - headBytes, fileSize - headBytes);
    const middleStart = headBytes;
    const middleEnd = fileSize - tailBytes;
    const [head, tail] = await Promise.all([
      readRange(handle, 0, headBytes),
      readRange(handle, middleEnd, tailBytes),
    ]);
    let bytesRead = head.bytesRead + tail.bytesRead;
    let response = extractResponsePayload({
      headText: head.buffer.toString('utf8'),
      tailText: tail.buffer.toString('utf8'),
      stable,
    });

    const middleBytes = middleEnd - middleStart;
    if (
      response.status === 'unsupported' &&
      middleBytes > 0 &&
      maxMarkerBackscanBytes > 0
    ) {
      const scan = await findNearestMiddleMarker({
        handle,
        start: middleStart,
        end: middleEnd,
        maxBytes: maxMarkerBackscanBytes,
        chunkBytes: markerScanChunkBytes,
        overlapBytes: markerScanOverlapBytes,
        suffixBuffer: tail.buffer,
      });
      bytesRead += scan.bytesRead;
      if (scan.marker === 'response') {
        response = extractResponsePayload({
          fullText: `=== RESPONSE ===\n${tail.buffer.toString('utf8')}`,
          stable,
        });
      }
    }

    return {
      bytesRead,
      response,
      parsed: parseExtractedResponsePayload(response),
    };
  } finally {
    await handle.close();
  }
}
