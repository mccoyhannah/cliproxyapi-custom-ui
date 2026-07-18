import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TOKEN_LOG_CORE_VERSION,
  dedupeLedgerEntries,
  dedupeTokenEntries,
  extractResponsePayload,
  extractTokenUsage,
  parseLogFilename,
  parseResponseLogText,
} from '../../../scripts/lib/token-log-core.mjs';
import { buildWidgetSnapshot } from '../../electron/collector/aggregate.mjs';

test('response-only parser ignores request-body usage and model lookalikes', () => {
  const raw = [
    '=== REQUEST BODY ===',
    '{"model":"gpt-fake-request","usage":{"input_tokens":999,"output_tokens":1,"total_tokens":1000},"prompt":"usage model"}',
    '=== API RESPONSE 1 ===',
    '{"model":"gpt-5.4","usage":{"input_tokens":12,"output_tokens":3,"total_tokens":15}}',
    '',
  ].join('\n');

  const parsed = parseResponseLogText(raw, { stable: true });

  assert.equal(TOKEN_LOG_CORE_VERSION, '1.3.0');
  assert.equal(parsed.status, 'available');
  assert.equal(parsed.model, 'gpt-5.4');
  assert.deepEqual(parsed.tokenUsage, {
    input: 12,
    output: 3,
    cached: 0,
    reasoning: 0,
    total: 15,
    status: 'available',
  });
});

test('Responses SSE uses response.model instead of a nested tool model', () => {
  const response = (type, usage = null) =>
    `data: ${JSON.stringify({
      type,
      response: {
        model: 'gpt-5.6-sol',
        tools: [{ type: 'image_generation', model: 'gpt-image-2-codex' }],
        usage,
      },
    })}`;
  const raw = [
    '=== API RESPONSE 1 ===',
    response('response.created'),
    response('response.in_progress'),
    response('response.completed', {
      input_tokens: 120,
      output_tokens: 8,
      total_tokens: 128,
      input_tokens_details: { cached_tokens: 64 },
      output_tokens_details: { reasoning_tokens: 3 },
    }),
    'data: [DONE]',
    '',
  ].join('\n');

  const parsed = parseResponseLogText(raw, { stable: true });

  assert.equal(parsed.status, 'available');
  assert.equal(parsed.model, 'gpt-5.6-sol');
  assert.deepEqual(parsed.tokenUsage, {
    input: 120,
    output: 8,
    cached: 64,
    reasoning: 3,
    total: 128,
    status: 'available',
  });
});

test('Responses SSE prefers the completed response model over earlier phases', () => {
  const response = (type, model, usage = null) =>
    `data: ${JSON.stringify({
      type,
      response: {
        model,
        tools: [{ type: 'image_generation', model: 'gpt-image-2-codex' }],
        usage,
      },
    })}`;
  const raw = [
    '=== API RESPONSE 1 ===',
    response('response.created', 'gpt-5.6-luna'),
    response('response.in_progress', 'gpt-5.6-terra'),
    response('response.completed', 'gpt-5.6-sol', {
      input_tokens: 10,
      output_tokens: 2,
      total_tokens: 12,
    }),
    '',
  ].join('\n');

  assert.equal(parseResponseLogText(raw, { stable: true }).model, 'gpt-5.6-sol');
});

test('Responses SSE falls back to the in-progress response model', () => {
  const raw = [
    '=== API RESPONSE 1 ===',
    `data: ${JSON.stringify({
      type: 'response.created',
      response: {
        model: 'gpt-5.6-luna',
        tools: [{ type: 'image_generation', model: 'gpt-image-2-codex' }],
      },
    })}`,
    `data: ${JSON.stringify({
      type: 'response.in_progress',
      response: {
        model: 'gpt-5.6-sol',
        tools: [{ type: 'image_generation', model: 'gpt-image-2-codex' }],
      },
    })}`,
    '',
  ].join('\n');

  const parsed = parseResponseLogText(raw, { stable: true });

  assert.equal(parsed.status, 'unreported');
  assert.equal(parsed.model, 'gpt-5.6-sol');
});

test('Responses SSE falls back to the created response model', () => {
  const raw = [
    '=== API RESPONSE 1 ===',
    `data: ${JSON.stringify({
      type: 'response.created',
      response: {
        model: 'gpt-5.6-sol',
        tools: [{ type: 'image_generation', model: 'gpt-image-2-codex' }],
      },
    })}`,
    '',
  ].join('\n');

  const parsed = parseResponseLogText(raw, { stable: true });

  assert.equal(parsed.status, 'unreported');
  assert.equal(parsed.model, 'gpt-5.6-sol');
});

test('complete Responses JSON uses its top-level model instead of a nested tool model', () => {
  const raw = [
    '=== API RESPONSE 1 ===',
    JSON.stringify({
      object: 'response',
      model: 'gpt-5.6-sol',
      tools: [{ type: 'image_generation', model: 'gpt-image-2-codex' }],
      usage: {
        input_tokens: 20,
        output_tokens: 4,
        total_tokens: 24,
      },
    }),
    '',
  ].join('\n');

  const parsed = parseResponseLogText(raw, { stable: true });

  assert.equal(parsed.status, 'available');
  assert.equal(parsed.model, 'gpt-5.6-sol');
  assert.equal(parsed.tokenUsage.total, 24);
});

test('pretty-printed Responses JSON keeps the top-level model', () => {
  const raw = [
    '=== API RESPONSE 1 ===',
    JSON.stringify(
      {
        object: 'response',
        model: 'gpt-5.6-sol',
        tools: [{ type: 'image_generation', model: 'gpt-image-2-codex' }],
        usage: {
          input_tokens: 20,
          output_tokens: 4,
          total_tokens: 24,
        },
      },
      null,
      2
    ),
    '',
  ].join('\n');

  assert.equal(parseResponseLogText(raw, { stable: true }).model, 'gpt-5.6-sol');
});

test('Anthropic messages use the top-level model instead of nested tool input', () => {
  const raw = [
    '=== API RESPONSE 1 ===',
    JSON.stringify({
      type: 'message',
      model: 'claude-sonnet-4-5',
      content: [
        {
          type: 'tool_use',
          input: { model: 'gpt-image-2-codex' },
        },
      ],
      usage: { input_tokens: 20, output_tokens: 4 },
    }),
    '',
  ].join('\n');

  const parsed = parseResponseLogText(raw, { stable: true });

  assert.equal(parsed.status, 'available');
  assert.equal(parsed.model, 'claude-sonnet-4-5');
});

test('parser chooses the final complete response usage object', () => {
  const raw = [
    '=== API RESPONSE 1 ===',
    '{"model":"gpt-5.4","usage":{"input_tokens":4,"output_tokens":1,"total_tokens":5}}',
    '{"model":"gpt-5.4","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}',
    '',
  ].join('\n');

  const response = extractResponsePayload({ fullText: raw, stable: true });
  const usage = extractTokenUsage(response.text);

  assert.equal(response.status, 'complete');
  assert.equal(usage.parseError, false);
  assert.equal(usage.usage.total, 12);
});

test('token normalization enforces cached-input and reasoning-output subset invariants', () => {
  const raw = [
    '=== RESPONSE ===',
    JSON.stringify({
      model: 'gpt-5.4-mini',
      usage: {
        input_tokens: 8,
        output_tokens: 3,
        total_tokens: 11,
        input_tokens_details: { cached_tokens: 50 },
        output_tokens_details: { reasoning_tokens: 9 },
      },
    }),
    '',
  ].join('\n');

  const parsed = parseResponseLogText(raw, { stable: true });

  assert.equal(parsed.tokenUsage.cached, 8);
  assert.equal(parsed.tokenUsage.reasoning, 3);
  assert.equal(parsed.tokenUsage.total, 11);
});

test('unstructured logs are unsupported instead of scanning arbitrary JSON', () => {
  const parsed = parseResponseLogText(
    '{"model":"gpt-5.4","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}',
    { stable: true }
  );

  assert.equal(parsed.status, 'unsupported');
  assert.equal(parsed.model, null);
  assert.equal(parsed.tokenUsage.total, 0);
});

test('a following response marker does not bypass the two-pass stability requirement', () => {
  const raw = [
    '=== API RESPONSE 1 ===',
    '{"model":"gpt-5.4","usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}',
    '=== API RESPONSE 2 ===',
    '{"model":"gpt-5.4","usage":{"input_tokens":4',
    '',
  ].join('\n');

  assert.equal(parseResponseLogText(raw, { stable: false }).status, 'pending');
  assert.equal(parseResponseLogText(raw, { stable: true }).status, 'parse-error');
});

test('filename parser uses local calendar time and keeps request id internal to the core result', () => {
  const info = parseLogFilename('v1-responses-2026-07-16T123456-synthetic01.log', 0);

  assert.equal(info.fileType, 'responses');
  assert.equal(info.timestampMs, new Date(2026, 6, 16, 12, 34, 56).getTime());
  assert.equal(info.requestId, 'synthetic01');
});

test('widget snapshots expose the token log core parser version', () => {
  const snapshot = buildWidgetSnapshot({
    entries: [],
    nowMs: new Date(2026, 6, 17).getTime(),
    installDir: 'D:\\CLIProxyAPI',
  });

  assert.equal(snapshot.source.parserVersion, TOKEN_LOG_CORE_VERSION);
  assert.equal(snapshot.source.parserVersion, '1.3.0');
});

test('multiple equal response attempts collapse but conflicting complete attempts are ambiguous', () => {
  const equal = [
    '=== API RESPONSE 1 ===',
    '{"model":"gpt-5.4","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}',
    '=== API RESPONSE 2 ===',
    '{"model":"gpt-5.4","usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}',
    '',
  ].join('\n');
  const conflict = equal.replace(
    '"input_tokens":10,"output_tokens":2,"total_tokens":12}}\n',
    '"input_tokens":9,"output_tokens":2,"total_tokens":11}}\n'
  );

  assert.equal(parseResponseLogText(equal, { stable: true }).status, 'available');
  assert.equal(parseResponseLogText(conflict, { stable: true }).status, 'ambiguous');
});

test('dedupe promotes a completed entry over pending and only conflicts complete available entries', () => {
  const base = {
    dedupeKey: 'request:synthetic',
    model: null,
    lastModifiedMs: 1,
    tokenUsage: {
      input: 0,
      output: 0,
      cached: 0,
      reasoning: 0,
      total: 0,
      status: 'pending',
    },
  };
  const available = {
    ...base,
    status: 'available',
    model: 'gpt-5.4',
    lastModifiedMs: 2,
    tokenUsage: {
      input: 5,
      output: 1,
      cached: 2,
      reasoning: 1,
      total: 6,
      status: 'available',
    },
  };

  const promoted = dedupeTokenEntries([{ ...base, status: 'pending' }, available]);
  assert.equal(promoted.length, 1);
  assert.equal(promoted[0].status, 'available');

  const conflict = dedupeTokenEntries([
    available,
    {
      ...available,
      lastModifiedMs: 3,
      tokenUsage: { ...available.tokenUsage, input: 7, total: 8 },
    },
  ]);
  assert.equal(conflict[0].status, 'ambiguous');
  assert.equal(conflict[0].tokenUsage.total, 0);
});

test('ledger dedupe preserves conflicting cross-directory retries as ambiguous', () => {
  const base = {
    fileName: 'v1-responses-2026-07-17T010000-shared001.log',
    fileType: 'responses',
    timestampMs: new Date(2026, 6, 17, 1, 0, 0).getTime(),
    requestId: 'shared001',
    sourceDir: 'D:\\CLIProxyAPI\\logs',
    sourceKey: 'D:\\CLIProxyAPI\\logs::v1-responses-2026-07-17T010000-shared001.log',
    detailStatus: 'ready',
    configuredModel: 'gpt-5.6-sol',
    actualModel: 'gpt-5.6-sol',
    tokenUsage: {
      input: 10,
      output: 2,
      cached: 4,
      reasoning: 1,
      total: 12,
      status: 'available',
    },
    fileSize: 100,
    lastModifiedMs: 1,
  };
  const conflicting = {
    ...base,
    sourceDir: 'D:\\CLIProxyAPI\\auths\\logs',
    sourceKey: 'D:\\CLIProxyAPI\\auths\\logs::v1-responses-2026-07-17T010000-shared001.log',
    tokenUsage: { ...base.tokenUsage, input: 11, total: 13 },
    lastModifiedMs: 2,
  };

  const result = dedupeLedgerEntries([base, conflicting]);

  assert.equal(result.length, 1);
  assert.equal(result[0].detailStatus, 'ambiguous');
  assert.equal(result[0].tokenUsage.status, 'ambiguous');
  assert.equal(result[0].tokenUsage.total, 0);
  assert.equal(result[0].errorCode, 'ambiguous-request');
});
