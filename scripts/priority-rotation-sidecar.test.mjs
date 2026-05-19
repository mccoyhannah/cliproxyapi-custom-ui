import assert from 'node:assert/strict';
import { analyzeCodexPriorityRotation } from './priority-rotation-sidecar.mjs';

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
  const files = [codexFile('active-low.json', 10), codexFile('standby-low.json', 5)];
  const result = analyzeCodexPriorityRotation(
    files,
    {
      'active-low.json': quota(80),
      'standby-low.json': quota(85),
    },
    50,
    5
  );
  assert.equal(result.status, 'no_standby');
  assert.equal(result.thresholdAdjusted, true);
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

console.log('priority-rotation-sidecar tests passed');
