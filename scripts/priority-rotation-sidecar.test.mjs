import assert from 'node:assert/strict';
import {
  analyzeCodexPriorityRotation,
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

{
  const files = [codexFile('active-low.json', 10), codexFile('standby-good.json', 5)];
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
      ['active-low.json', 'demote', 5],
      ['standby-good.json', 'promote', 10],
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
  assert.equal(result.status, 'ready');
  assert.ok(result.changes.some((change) => change.toPriority === -1));
  assert.ok(result.changes.some((change) => change.reason === 'low_remaining'));
  assert.ok(result.changes.some((change) => change.reason === 'over_active_limit'));
}

{
  const files = [codexFile('a.json', 10), codexFile('b.json', 10), codexFile('c.json', 5)];
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
  const files = [codexFile('active-soft-low.json', 10), codexFile('standby-low.json', 5)];
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
  const files = [codexFile('unknown.json', 10)];
  const result = analyzeCodexPriorityRotation(files, {}, 50, 5);
  assert.equal(result.status, 'quota_unknown');
}

{
  const files = [
    codexFile('active-a.json', 3),
    codexFile('active-b.json', 3),
    codexFile('active-c.json', 3),
    codexFile('active-d.json', 3),
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
    codexFile('active-low.json', 3),
    codexFile('active-good-a.json', 3),
    codexFile('active-good-b.json', 3),
    codexFile('active-good-c.json', 3),
    codexFile('standby-good.json', 2),
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
  const files = [codexFile('active-good.json', 3), codexFile('standby-good.json', 2)];
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
  const files = [codexFile('free.json', 10, 'free'), codexFile('team.json', 5)];
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
  const files = [codexFile('business-team.json', 3, 'self_serve_business_usage_based')];
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
