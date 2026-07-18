import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_LOG_READ_LIMIT_BYTES,
  readBoundedResponseLog,
} from '../../electron/collector/logReader.mjs';

test('bounded reader ignores request body and finds response usage without reading a huge file fully', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-log-'));
  const filePath = path.join(root, 'v1-responses-2026-07-16T101112-synthetic01.log');
  const raw = [
    '=== REQUEST BODY ===',
    '{"model":"gpt-fake","usage":{"input_tokens":999,"output_tokens":1,"total_tokens":1000}}',
    '=== API RESPONSE 1 ===',
    '汉'.repeat(400_000),
    '{"model":"gpt-5.4","usage":{"input_tokens":20,"output_tokens":4,"total_tokens":24,"input_tokens_details":{"cached_tokens":8}}}',
    '',
  ].join('\n');

  try {
    await fs.writeFile(filePath, raw, 'utf8');
    const stats = await fs.stat(filePath);
    const result = await readBoundedResponseLog(filePath, stats, { stable: true });

    assert.equal(result.parsed.status, 'available');
    assert.equal(result.parsed.model, 'gpt-5.4');
    assert.equal(result.parsed.tokenUsage.total, 24);
    assert.equal(result.parsed.tokenUsage.cached, 8);
    assert.ok(result.bytesRead <= DEFAULT_LOG_READ_LIMIT_BYTES);
    assert.ok(stats.size > result.bytesRead);
    assert.deepEqual(Object.keys(result).sort(), ['bytesRead', 'parsed']);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bounded reader recovers a response marker that moved into the skipped middle of a large log', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-log-middle-marker-'));
  const filePath = path.join(root, 'v1-responses-2026-07-16T101113-synthetic03.log');
  const raw = [
    '=== REQUEST BODY ===',
    '{"model":"gpt-fake","usage":{"input_tokens":999,"output_tokens":1,"total_tokens":1000}}',
    'r'.repeat(700 * 1024),
    '=== API RESPONSE 1 ===',
    's'.repeat(700 * 1024),
    '{"model":"gpt-5.4","usage":{"input_tokens":200,"output_tokens":18,"total_tokens":218,"input_tokens_details":{"cached_tokens":80}}}',
    '=== END API RESPONSE ===',
    '',
  ].join('\n');

  try {
    await fs.writeFile(filePath, raw, 'utf8');
    const stats = await fs.stat(filePath);
    const result = await readBoundedResponseLog(filePath, stats, { stable: false });

    assert.equal(result.parsed.status, 'available');
    assert.equal(result.parsed.model, 'gpt-5.4');
    assert.equal(result.parsed.tokenUsage.total, 218);
    assert.equal(result.parsed.tokenUsage.cached, 80);
    assert.ok(stats.size > DEFAULT_LOG_READ_LIMIT_BYTES);
    assert.ok(result.bytesRead < stats.size + 16 * 1024);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('bounded reader joins a head response marker to a tail end marker before stability', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-log-split-end-'));
  const filePath = path.join(root, 'v1-responses-2026-07-16T101114-synthetic04.log');
  const raw = [
    '=== RESPONSE ===',
    's'.repeat(700 * 1024),
    '{"model":"gpt-5.4-mini","usage":{"input_tokens":30,"output_tokens":6,"total_tokens":36}}',
    '=== END RESPONSE ===',
    '',
  ].join('\n');

  try {
    await fs.writeFile(filePath, raw, 'utf8');
    const result = await readBoundedResponseLog(filePath, await fs.stat(filePath), {
      stable: false,
    });

    assert.equal(result.parsed.status, 'available');
    assert.equal(result.parsed.model, 'gpt-5.4-mini');
    assert.equal(result.parsed.tokenUsage.total, 36);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('explicit response end marker permits a complete parse before a second stability pass', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'token-pulse-log-end-'));
  const filePath = path.join(root, 'v1-responses-2026-07-16T111213-synthetic02.log');
  try {
    await fs.writeFile(
      filePath,
      [
        '=== RESPONSE ===',
        '{"model":"gpt-5.4-mini","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}',
        '=== END RESPONSE ===',
        '',
      ].join('\n'),
      'utf8'
    );
    const result = await readBoundedResponseLog(filePath, await fs.stat(filePath), {
      stable: false,
    });

    assert.equal(result.parsed.status, 'available');
    assert.equal(result.parsed.tokenUsage.total, 4);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
