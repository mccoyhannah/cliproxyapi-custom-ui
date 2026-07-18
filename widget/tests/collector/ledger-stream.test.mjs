import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { streamLedgerEntries } from '../../electron/collector/ledgerStream.mjs';

test('ledger reader streams entries across tiny UTF-8 and JSON chunk boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-ledger-'));
  const ledgerPath = path.join(root, 'token-ledger.json');
  const entries = [
    {
      fileName: 'v1-responses-2026-07-16T010203-synthetic01.log',
      fileType: 'responses',
      timestampMs: new Date(2026, 6, 16, 1, 2, 3).getTime(),
      requestId: 'synthetic01',
      sourceDir: 'D:\\synthetic\\logs',
      sourceKey: 'synthetic-1',
      detailStatus: 'ready',
      configuredModel: 'gpt-5.4',
      actualModel: 'gpt-5.4',
      tokenUsage: {
        input: 8,
        output: 2,
        cached: 4,
        reasoning: 1,
        total: 10,
        status: 'available',
      },
      fileSize: 100,
      lastModifiedMs: 123,
      syntheticNote: '汉字边界',
    },
    {
      fileName: 'v1-responses-2026-07-16T020304-synthetic02.log',
      fileType: 'responses',
      timestampMs: new Date(2026, 6, 16, 2, 3, 4).getTime(),
      requestId: 'synthetic02',
      sourceDir: 'D:\\synthetic\\logs',
      sourceKey: 'synthetic-2',
      detailStatus: 'missing-fields',
      configuredModel: null,
      actualModel: null,
      tokenUsage: {
        input: 0,
        output: 0,
        cached: 0,
        reasoning: 0,
        total: 0,
        status: 'unreported',
      },
      fileSize: 101,
      lastModifiedMs: 124,
    },
  ];

  try {
    await fs.writeFile(
      ledgerPath,
      JSON.stringify({
        version: 1,
        generatedAt: '2026-07-16T00:00:00.000Z',
        coverage: { earliestTimestampMs: 1, latestTimestampMs: 2 },
        entries,
      }),
      'utf8'
    );
    const streamed = [];
    const result = await streamLedgerEntries(ledgerPath, {
      highWaterMark: 7,
      onEntry: (entry) => streamed.push(entry),
    });

    assert.equal(result.generatedAt, '2026-07-16T00:00:00.000Z');
    assert.equal(result.entriesRead, 2);
    assert.equal(result.parseErrors, 0);
    assert.equal(streamed[0].actualModel, 'gpt-5.4');
    assert.equal(streamed[1].tokenUsage.status, 'unreported');
    assert.ok(result.bytesRead > 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
