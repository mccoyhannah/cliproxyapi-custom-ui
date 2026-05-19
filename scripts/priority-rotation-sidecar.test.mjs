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
    [['standby-good.json', 'promote', 10]]
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
  const files = Array.from({ length: 6 }, (_, index) =>
    codexFile(`active-${index + 1}.json`, 10)
  );
  const quotas = Object.fromEntries(
    files.map((file, index) => [file.name, quota(10 + index)])
  );
  const result = analyzeCodexPriorityRotation(files, quotas, 50, 5);
  const overLimitChanges = result.changes.filter(
    (change) => change.reason === 'over_active_limit'
  );
  assert.equal(result.status, 'ready');
  assert.equal(overLimitChanges.length, 1);
  assert.equal(overLimitChanges[0].role, 'demote');
  assert.equal(overLimitChanges[0].toPriority, 9);
  assert.equal(result.projectedActiveCount, 5);
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
  assert.equal(result.status, 'no_standby');
  assert.equal(result.thresholdAdjusted, true);
  assert.equal(result.effectiveThresholdPercent, 30);
}

{
  const files = [codexFile('unknown.json', 10)];
  const result = analyzeCodexPriorityRotation(files, {}, 50, 5);
  assert.equal(result.status, 'quota_unknown');
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
