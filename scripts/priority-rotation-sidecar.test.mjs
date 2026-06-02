import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  analyzeCodexPriorityRotation,
  buildIdleShutdownStatePatch,
  classifyUpstreamStatusText,
  getLatestModelRequestAtMs,
  isModelRequestLogName,
  parseModelRequestLogTimeMs,
  readLatestModelRequestAtMs,
  shouldStopForIdle,
  validateManagementKey,
} from './priority-rotation-sidecar.mjs';

const codexFile = (name, priority, planType = 'team') => ({
  name,
  type: 'codex',
  priority,
  plan_type: planType,
});

const quota = (usedPercent, planType = 'team') => ({
  status: 'success',
  planType,
  windows: [{ id: 'five-hour', usedPercent }],
});

const retryableQuotaError = (errorKind, error = errorKind) => ({
  status: 'error',
  planType: 'team',
  windows: [],
  error,
  errorKind,
  retryable: true,
});

const credentialQuotaError = (error = 'invalidated oauth token for this account') => ({
  status: 'error',
  planType: 'team',
  windows: [],
  error,
  errorKind: 'credential_invalid',
  retryable: false,
});

{
  assert.equal(classifyUpstreamStatusText('Post "https://example": EOF'), 'network_transient');
  assert.equal(
    classifyUpstreamStatusText('invalid_request_error context_too_large'),
    'input_too_large'
  );
  assert.equal(
    classifyUpstreamStatusText('content concealed by upstream safety policy'),
    'content_policy'
  );
  assert.equal(
    classifyUpstreamStatusText('invalidated oauth token for this account'),
    'credential_invalid'
  );
}

{
  assert.equal(isModelRequestLogName('v1-responses-2026-05-20T051955-57644c1f.log'), true);
  assert.equal(isModelRequestLogName('v1-chat-completions-2026-05-20T052001-11111111.log'), true);
  assert.equal(isModelRequestLogName('v1-images-generations-2026-05-20T052101-22222222.log'), true);
  assert.equal(isModelRequestLogName('main.log'), false);
  assert.equal(
    isModelRequestLogName('api-provider-openai-v1-responses-2026-05-20T052201.log'),
    false
  );
  assert.equal(
    getLatestModelRequestAtMs([
      'main.log',
      'v1-responses-2026-05-20T051955-57644c1f.log',
      'v1-chat-completions-2026-05-20T052001-11111111.log',
      'v1-images-generations-2026-05-20T052101-22222222.log',
    ]),
    parseModelRequestLogTimeMs('v1-images-generations-2026-05-20T052101-22222222.log')
  );
}

{
  const root = await mkdtemp(path.join(tmpdir(), 'priority-rotation-logs-'));
  const modelRequestLogsDir = path.join(root, 'logs');
  const sidecarLogsDir = path.join(root, 'priority-rotation', 'logs');
  try {
    await mkdir(modelRequestLogsDir, { recursive: true });
    await mkdir(sidecarLogsDir, { recursive: true });
    await writeFile(
      path.join(sidecarLogsDir, 'v1-responses-2026-05-20T090000-sidecar.log'),
      'not a model request log'
    );
    await writeFile(
      path.join(modelRequestLogsDir, 'v1-responses-2026-05-20T080000-real.log'),
      'real model request log'
    );

    assert.equal(
      await readLatestModelRequestAtMs(modelRequestLogsDir),
      parseModelRequestLogTimeMs('v1-responses-2026-05-20T080000-real.log')
    );
    assert.equal(await readLatestModelRequestAtMs(path.join(root, 'missing'), 1234), 1234);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

{
  const lastActivityAtMs = 1_000_000;
  assert.equal(
    shouldStopForIdle({
      nowMs: lastActivityAtMs + 9 * 60_000 + 59_999,
      lastActivityAtMs,
      idleMinutes: 10,
    }),
    false
  );
  assert.equal(
    shouldStopForIdle({
      nowMs: lastActivityAtMs + 10 * 60_000,
      lastActivityAtMs,
      idleMinutes: 10,
    }),
    true
  );
  assert.equal(
    shouldStopForIdle({
      nowMs: lastActivityAtMs + 30 * 60_000,
      lastActivityAtMs,
      idleMinutes: 10,
      running: true,
    }),
    false
  );
}

{
  const enabledPatch = buildIdleShutdownStatePatch(
    { enabled: true, apiBase: 'http://127.0.0.1:8317' },
    { nextRunAt: '2026-05-20T08:00:00.000Z' }
  );
  assert.equal(enabledPatch.enabled, true);
  assert.equal(enabledPatch.lastSkippedReason, 'idle_timeout');
  assert.equal(enabledPatch.nextRunAt, '2026-05-20T08:00:00.000Z');

  const disabledPatch = buildIdleShutdownStatePatch(
    { enabled: false, apiBase: 'http://127.0.0.1:8317' },
    { nextRunAt: '2026-05-20T08:00:00.000Z' }
  );
  assert.equal(disabledPatch.enabled, false);
  assert.equal(disabledPatch.nextRunAt, null);
}

{
  const files = [codexFile('active-low.json', 2), codexFile('standby-good.json', 1)];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-low.json': quota(70),
      'standby-good.json': quota(20),
    },
    50,
    5
  );
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    result.changes.map((change) => [change.name, change.role, change.toPriority]),
    [
      ['active-low.json', 'demote', 1],
      ['standby-good.json', 'promote', 2],
    ]
  );
}

{
  const files = [
    codexFile('active-a.json', 0),
    codexFile('active-b.json', 0),
    codexFile('standby-c.json', 0),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-a.json': quota(80),
      'active-b.json': quota(25),
      'standby-c.json': quota(20),
    },
    50,
    1
  );
  assert.equal(result.status, 'no_changes');
  assert.equal(result.managedCount, 0);
  assert.deepEqual(result.changes, []);
  assert.equal(
    result.candidates.filter((candidate) => candidate.decision === 'observe_buffer').length,
    3
  );
}

{
  const files = [
    ...Array.from({ length: 19 }, (_, index) => codexFile(`active-${index}.json`, 2)),
    ...Array.from({ length: 13 }, (_, index) => codexFile(`buffer-${index}.json`, 0)),
  ];
  const quotaMap = Object.fromEntries(files.map((file) => [file.name, quota(20)]));
  const result = analyzeCodexPriorityRotation(files, quotaMap, 50, 3);
  assert.equal(result.status, 'ready');
  assert.equal(result.activeCount, 19);
  assert.equal(result.standbyCount, 0);
  assert.equal(result.projectedActiveCount, 3);
  assert.equal(result.changes.length, 16);
  assert.equal(
    result.candidates.filter((candidate) => candidate.decision === 'observe_buffer').length,
    13
  );
}

{
  const files = [codexFile('active-eof-a.json', 2), codexFile('active-eof-b.json', 2)];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-eof-a.json': retryableQuotaError('network_transient', 'EOF'),
      'active-eof-b.json': retryableQuotaError('input_too_large', 'context_too_large'),
    },
    50,
    1
  );
  assert.equal(result.status, 'quota_unknown');
  assert.deepEqual(result.changes, []);
  assert.equal(
    result.candidates.every((candidate) => candidate.decision === 'quota_unknown_retryable'),
    true
  );
}

{
  const files = [
    codexFile('active-invalid.json', 2),
    codexFile('standby-invalid.json', 1),
    codexFile('active-healthy.json', 2),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-invalid.json': credentialQuotaError(),
      'standby-invalid.json': credentialQuotaError('403 upstream refused this credential'),
      'active-healthy.json': quota(10),
    },
    50,
    3
  );
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    result.changes
      .filter((change) => change.reason === 'credential_invalid')
      .map((change) => [change.name, change.fromPriority, change.toPriority, change.role])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    [
      ['active-invalid.json', 2, 0, 'demote'],
      ['standby-invalid.json', 1, 0, 'demote'],
    ]
  );
  assert.ok(
    result.candidates.every((candidate) =>
      candidate.name.endsWith('invalid.json')
        ? candidate.decision === 'demote_credential_invalid'
        : true
    )
  );
}

{
  const files = [
    codexFile('buffer-invalid.json', 0),
    codexFile('manual-invalid.json', 3),
    { ...codexFile('disabled-invalid.json', 2), disabled: true },
    { ...codexFile('runtime-invalid.json', 2), runtime_only: true },
    { name: 'openai-invalid.json', type: 'openai', priority: 2, plan_type: 'team' },
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    Object.fromEntries(files.map((file) => [file.name, credentialQuotaError()])),
    50,
    3
  );
  assert.equal(result.status, 'no_changes');
  assert.deepEqual(result.changes, []);
  assert.ok(result.candidates.some((candidate) => candidate.decision === 'observe_buffer'));
  assert.ok(result.candidates.some((candidate) => candidate.decision === 'manual_locked'));
  assert.ok(result.candidates.some((candidate) => candidate.decision === 'skipped_disabled'));
  assert.ok(result.candidates.some((candidate) => candidate.decision === 'skipped_runtime_only'));
}

{
  const files = [
    ...Array.from({ length: 19 }, (_, index) => codexFile(`active-${index}.json`, 2)),
    ...Array.from({ length: 17 }, (_, index) => codexFile(`standby-${index}.json`, 1)),
  ];
  const quotaMap = Object.fromEntries(files.map((file) => [file.name, quota(20)]));
  const result = analyzeCodexPriorityRotation(files, quotaMap, 50, 3);
  assert.equal(result.status, 'ready');
  assert.equal(result.activeCount, 19);
  assert.equal(result.standbyCount, 17);
  assert.equal(result.projectedActiveCount, 3);
  assert.equal(result.changes.length, 16);
  assert.equal(
    result.changes.every((change) => change.fromPriority === 2 && change.toPriority === 1),
    true
  );
}

{
  const files = [
    codexFile('manual-locked.json', 3),
    codexFile('active-a.json', 2),
    codexFile('active-b.json', 2),
    codexFile('active-c.json', 2),
    codexFile('standby-a.json', 1),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    Object.fromEntries(files.map((file) => [file.name, quota(20)])),
    50,
    2
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.changes.length, 1);
  assert.equal(
    result.changes.some((change) => change.name === 'manual-locked.json'),
    false
  );
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.name === 'manual-locked.json' &&
        candidate.tier === 'manual_locked' &&
        candidate.decision === 'manual_locked'
    )
  );
}

{
  const files = [
    codexFile('manual-active.json', 4),
    codexFile('old-active-a.json', 2),
    codexFile('old-active-b.json', 2),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'manual-active.json': quota(20),
      'old-active-a.json': quota(15),
      'old-active-b.json': quota(25),
    },
    50,
    2
  );
  assert.equal(result.status, 'no_changes');
  assert.equal(result.activePriority, 2);
  assert.equal(result.standbyPriority, 1);
  assert.deepEqual(result.changes, []);
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.name === 'manual-active.json' &&
        candidate.tier === 'manual_locked' &&
        candidate.decision === 'manual_locked'
    )
  );
}

{
  const files = [
    codexFile('active-a.json', 2),
    codexFile('active-b.json', 2),
    codexFile('standby-low.json', 1),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-a.json': quota(15),
      'active-b.json': quota(15),
      'standby-low.json': quota(30),
    },
    80,
    3
  );
  assert.equal(result.status, 'no_standby');
  assert.equal(result.activeCount, 2);
  assert.equal(result.projectedActiveCount, 2);
  assert.deepEqual(result.changes, []);
}

{
  const files = [
    codexFile('active-a.json', 2),
    codexFile('active-b.json', 2),
    codexFile('standby-low.json', 1),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-a.json': quota(15),
      'active-b.json': quota(15),
      'standby-low.json': quota(30),
    },
    80,
    3,
    20
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.thresholdAdjusted, true);
  assert.equal(result.effectiveThresholdPercent, 60);
  assert.deepEqual(
    result.changes.map((change) => [
      change.name,
      change.role,
      change.fromPriority,
      change.toPriority,
    ]),
    [['standby-low.json', 'promote', 1, 2]]
  );
}

{
  const files = [codexFile('active-soft-low.json', 2)];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-soft-low.json': quota(60),
    },
    50,
    1,
    40
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.thresholdAdjusted, true);
  assert.deepEqual(
    result.changes.map((change) => [change.name, change.role, change.reason, change.toPriority]),
    [['active-soft-low.json', 'demote', 'low_remaining', 1]]
  );
}

{
  const files = [codexFile('active-a.json', 2), codexFile('standby-empty.json', 1)];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-a.json': quota(20),
      'standby-empty.json': quota(100),
    },
    50,
    2,
    500
  );
  assert.equal(result.thresholdAdjusted, true);
  assert.equal(result.effectiveThresholdPercent, 0);
  assert.deepEqual(
    result.changes.map((change) => [change.name, change.role, change.remainingPercent]),
    [['standby-empty.json', 'promote', 0]]
  );
}

{
  const files = [codexFile('active-a.json', 2), codexFile('standby-only.json', 1)];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-a.json': quota(20),
      'standby-only.json': quota(10),
    },
    50,
    2
  );
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    result.changes.map((change) => [
      change.name,
      change.role,
      change.fromPriority,
      change.toPriority,
    ]),
    [['standby-only.json', 'promote', 1, 2]]
  );
}

{
  const files = [
    codexFile('active-a.json', 2),
    codexFile('active-b.json', 2),
    codexFile('standby-a.json', 1),
    codexFile('standby-b.json', 1),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-a.json': quota(20),
      'active-b.json': quota(25),
      'standby-a.json': quota(10),
      'standby-b.json': quota(15),
    },
    50,
    3
  );
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    result.changes.map((change) => [
      change.name,
      change.role,
      change.fromPriority,
      change.toPriority,
    ]),
    [['standby-a.json', 'promote', 1, 2]]
  );
}

{
  const files = [
    codexFile('active-a.json', 2),
    codexFile('standby-a.json', 1),
    codexFile('standby-b.json', 1),
    codexFile('standby-c.json', 1),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-a.json': quota(20),
      'standby-a.json': quota(10),
      'standby-b.json': quota(15),
      'standby-c.json': quota(25),
    },
    50,
    3
  );
  assert.equal(result.status, 'ready');
  assert.deepEqual(
    result.changes.map((change) => [
      change.name,
      change.role,
      change.fromPriority,
      change.toPriority,
    ]),
    [
      ['standby-a.json', 'promote', 1, 2],
      ['standby-b.json', 'promote', 1, 2],
    ]
  );
}

{
  const files = [codexFile('a.json', 2), codexFile('b.json', 2), codexFile('c.json', 1)];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'a.json': quota(10),
      'b.json': quota(15),
      'c.json': quota(5),
    },
    50,
    1
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.changes.filter((change) => change.reason === 'over_active_limit').length, 1);
}

{
  const files = [codexFile('active-soft-low.json', 2), codexFile('standby-low.json', 1)];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-soft-low.json': quota(65),
      'standby-low.json': quota(85),
    },
    50,
    5
  );
  assert.equal(result.status, 'ready');
  assert.equal(result.thresholdAdjusted, false);
  assert.equal(result.effectiveThresholdPercent, 50);
  assert.ok(result.changes.some((change) => change.reason === 'low_remaining'));
}

{
  const files = [codexFile('unknown.json', 2)];
  const result = analyzeCodexPriorityRotation(files, {}, 50, 5);
  assert.equal(result.status, 'quota_unknown');
}

{
  const files = [
    codexFile('active-a.json', 2),
    codexFile('active-b.json', 2),
    codexFile('active-c.json', 2),
    codexFile('active-d.json', 2),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-a.json': quota(51),
      'active-b.json': quota(20),
      'active-c.json': quota(25),
      'active-d.json': quota(30),
    },
    50,
    4
  );
  assert.equal(result.status, 'ready');
  assert.ok(
    result.changes.some(
      (change) =>
        change.name === 'active-a.json' &&
        change.role === 'demote' &&
        change.reason === 'low_remaining'
    )
  );
}

{
  const files = [
    codexFile('active-low.json', 2),
    codexFile('active-good-a.json', 2),
    codexFile('active-good-b.json', 2),
    codexFile('active-good-c.json', 2),
    codexFile('standby-good.json', 1),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-low.json': quota(51),
      'active-good-a.json': quota(20),
      'active-good-b.json': quota(25),
      'active-good-c.json': quota(30),
      'standby-good.json': quota(10),
    },
    50,
    4
  );
  assert.equal(result.status, 'ready');
  assert.ok(result.changes.some((change) => change.name === 'active-low.json'));
  assert.ok(result.changes.some((change) => change.name === 'standby-good.json'));
}

{
  const files = [codexFile('active-good.json', 2), codexFile('standby-good.json', 1)];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-good.json': quota(40),
      'standby-good.json': quota(20),
    },
    50,
    1
  );
  assert.equal(result.status, 'no_changes');
  assert.ok(Array.isArray(result.candidates));
  assert.ok(
    result.candidates.some(
      (candidate) =>
        candidate.name === 'active-good.json' &&
        candidate.tier === 'active' &&
        candidate.belowThreshold === false &&
        candidate.decision === 'keep'
    )
  );
}

{
  const files = [codexFile('free.json', 2, 'free'), codexFile('team.json', 1)];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'free.json': quota(20, 'free'),
      'team.json': quota(20, 'team'),
    },
    50,
    5
  );
  assert.equal(result.managedCount, 1);
}

{
  const files = [
    codexFile('free-active.json', 2, 'free'),
    codexFile('team-active-a.json', 2, 'team'),
    codexFile('team-active-b.json', 2, 'team'),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'free-active.json': quota(20, 'free'),
      'team-active-a.json': quota(20, 'team'),
      'team-active-b.json': quota(25, 'team'),
    },
    50,
    2
  );
  assert.equal(result.managedCount, 2);
  assert.equal(result.activeCount, 3);
  assert.equal(result.projectedActiveCount, 2);
  assert.deepEqual(
    result.changes.map((change) => [change.name, change.role, change.reason, change.toPriority]),
    [['free-active.json', 'demote', 'over_active_limit', 1]]
  );
}

{
  const files = [
    codexFile('unknown-active.json', 2, 'team'),
    codexFile('team-active-a.json', 2, 'team'),
    codexFile('team-active-b.json', 2, 'team'),
  ];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'team-active-a.json': quota(20, 'team'),
      'team-active-b.json': quota(25, 'team'),
    },
    50,
    2
  );
  assert.equal(result.managedCount, 2);
  assert.equal(result.unknownCount, 1);
  assert.equal(result.activeCount, 3);
  assert.equal(result.projectedActiveCount, 2);
  assert.deepEqual(
    result.changes.map((change) => [change.name, change.role, change.reason, change.toPriority]),
    [['unknown-active.json', 'demote', 'over_active_limit', 1]]
  );
}

{
  const files = [codexFile('business-team.json', 2, 'self_serve_business_usage_based')];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'business-team.json': quota(20, 'self_serve_business_usage_based'),
    },
    50,
    4
  );
  assert.equal(result.managedCount, 1);
  assert.equal(result.candidates[0]?.decision, 'keep');
}

{
  const originalFetch = globalThis.fetch;
  const requests = [];
  let releaseFirstRequest;
  const firstRequestStarted = new Promise((resolve) => {
    releaseFirstRequest = () => resolve();
  });
  let allowFirstRequest;
  const firstRequestCanFinish = new Promise((resolve) => {
    allowFirstRequest = resolve;
  });
  globalThis.fetch = async (url, options = {}) => {
    const authorization = String(options.headers?.Authorization ?? '');
    requests.push(`${authorization}:${String(url)}`);
    if (authorization === 'Bearer key-a') {
      releaseFirstRequest();
      await firstRequestCanFinish;
    }
    return new Response('{}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const first = validateManagementKey('key-a', 'http://127.0.0.1:9999');
    await firstRequestStarted;
    await validateManagementKey('key-b');
    allowFirstRequest();
    await first;
  } finally {
    allowFirstRequest?.();
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(requests, [
    'Bearer key-a:http://127.0.0.1:9999/v0/management/config',
    'Bearer key-b:http://127.0.0.1:8317/v0/management/config',
  ]);
}

console.log('priority-rotation-sidecar tests passed');
