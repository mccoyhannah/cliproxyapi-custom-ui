import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AUTH_FAILURE_HISTORY_TTL_MS,
  observeAuthFailureHistory,
  readAuthFailureHistoryProjection,
  simplifyObservedFailureMessage,
} from './auth-status-history-observer.mjs';

const localTime = (year, month, day, hour, minute, second = 0) =>
  new Date(year, month - 1, day, hour, minute, second, 0).getTime();

const root = await mkdtemp(path.join(tmpdir(), 'auth-status-history-observer-'));
try {
  const logsDir = path.join(root, 'logs');
  const statePath = path.join(root, 'priority-rotation', 'auth-failure-history.json');
  const mainLogPath = path.join(logsDir, 'main.log');
  await mkdir(logsDir, { recursive: true });

  await writeFile(
    mainLogPath,
    [
      '[2026-07-15 09:09:59] [abc12345] [info ] [selector.go:436] session-affinity: cache hit | session=private-session auth=Account-A.json provider=mixed model=gpt-test',
      '[2026-07-15 09:10:00] [abc12345] [info ] [selector.go:446] session-affinity: cache hit but auth unavailable, reselected | session=private-session auth=Account-B.json provider=mixed model=gpt-test',
      '[2026-07-15 09:10:01] [abc12345] [info ] [selector.go:446] session-affinity: cache hit but auth unavailable, reselected | session=private-session auth=Account-C.json provider=mixed model=gpt-test',
      '[2026-07-15 09:11:00] [feedface] [info ] [selector.go:436] session-affinity: cache hit | session=private-session auth=Account-D.json provider=mixed model=gpt-test',
      '',
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    path.join(logsDir, 'v1-responses-2026-07-15T091002-abc12345.log'),
    [
      '=== REQUEST ===',
      'Authorization: Bearer request-body-secret',
      '{"refresh_token":"request-refresh-secret"}',
      '=== RESPONSE ===',
      'Status: 200',
      'Error: Post "https://chatgpt.example/responses?access_token=query-secret": EOF Authorization: Bearer response-secret',
      'Error: context canceled refresh_token=rt-private-123456789',
      '{"ok":true}',
      '',
    ].join('\n'),
    'utf8'
  );
  const successfulResponseLogName = 'v1-responses-2026-07-15T091101-feedface.log';
  await writeFile(
    path.join(logsDir, successfulResponseLogName),
    ['=== RESPONSE ===', 'Status: 200', '{"ok":true}', ''].join('\n'),
    'utf8'
  );

  const nowMs = localTime(2026, 7, 15, 9, 12);
  const latestFailureBuckets = Array.from({ length: 20 }, (_, index) => ({
    success: 0,
    failed: index === 19 ? 8 : 0,
    ...(index === 19 ? { time: '09:10-09:20' } : {}),
  }));
  const authFiles = [
    {
      name: 'Account-D.json',
      status_message: 'context canceled customer note Alice lives at 123 Main Street',
      recent_requests: latestFailureBuckets,
    },
  ];
  const options = { logsDir, mainLogPath, statePath, nowMs, authFiles };
  const first = await observeAuthFailureHistory(options);
  const firstDiskText = await readFile(statePath, 'utf8');
  const firstProjection = await readAuthFailureHistoryProjection(statePath, nowMs);

  const firstBucketStart = localTime(2026, 7, 15, 9, 0);
  const secondBucketStart = localTime(2026, 7, 15, 9, 10);
  const accountA = firstProjection.files['account-a.json'];
  const accountB = firstProjection.files['account-b.json'];
  const accountD = firstProjection.files['account-d.json'];

  assert.equal(first.version, 1);
  assert.equal(firstProjection.version, 1);
  assert.equal(accountA[String(firstBucketStart)].startTime, firstBucketStart);
  assert.equal(accountA[String(firstBucketStart)].endTime, firstBucketStart + 10 * 60 * 1000);
  assert.deepEqual(accountA[String(firstBucketStart)].details.connection_transient, {
    category: 'connection_transient',
    message: 'EOF',
    observedAt: localTime(2026, 7, 15, 9, 9, 59),
    expiresAt: localTime(2026, 7, 15, 9, 9, 59) + AUTH_FAILURE_HISTORY_TTL_MS,
  });
  assert.deepEqual(accountB[String(secondBucketStart)].details.request_interrupted, {
    category: 'request_interrupted',
    message: 'context canceled',
    observedAt: localTime(2026, 7, 15, 9, 10, 0),
    expiresAt: localTime(2026, 7, 15, 9, 10, 0) + AUTH_FAILURE_HISTORY_TTL_MS,
  });
  assert.equal(
    firstProjection.files['account-c.json'],
    undefined,
    'The final successful credential must not inherit an earlier retry error.'
  );
  assert.deepEqual(accountD[String(secondBucketStart)].details.request_interrupted, {
    category: 'request_interrupted',
    message: 'context canceled',
    observedAt: nowMs,
    expiresAt: nowMs + AUTH_FAILURE_HISTORY_TTL_MS,
  });
  assert.deepEqual(
    first.state.responseSources[successfulResponseLogName].failures,
    [],
    'A successful response fingerprint must remain in state so the next pass skips rereading it.'
  );
  assert.equal(
    simplifyObservedFailureMessage(
      'unknown_upstream_error',
      'customer note Alice lives at 123 Main Street'
    ),
    '',
    'Unknown free-form text must fail closed instead of being persisted.'
  );
  assert.deepEqual(firstProjection.active, {});
  assert.doesNotMatch(
    firstDiskText,
    /request-body-secret|request-refresh-secret|query-secret|response-secret|rt-private|private-session|chatgpt\.example|Alice|Main Street/i,
    'Only classified and redacted failure facts may reach the state file.'
  );

  await observeAuthFailureHistory({ ...options, nowMs: nowMs + 15_000 });
  assert.equal(
    await readFile(statePath, 'utf8'),
    firstDiskText,
    'Rescanning unchanged logs must be byte-for-byte idempotent.'
  );

  const nextBucketNow = localTime(2026, 7, 15, 9, 21);
  const nextBucketAuthFiles = [
    {
      ...authFiles[0],
      recent_requests: Array.from({ length: 20 }, (_, index) => ({
        success: 0,
        failed: index === 19 ? 9 : 0,
        ...(index === 19 ? { time: '09:20-09:30' } : {}),
      })),
    },
  ];
  await observeAuthFailureHistory({
    ...options,
    nowMs: nextBucketNow,
    authFiles: nextBucketAuthFiles,
  });
  const nextBucketProjection = await readAuthFailureHistoryProjection(statePath, nextBucketNow);
  const nextStatusDetail =
    nextBucketProjection.files['account-d.json'][String(localTime(2026, 7, 15, 9, 20))].details
      .request_interrupted;
  assert.equal(nextStatusDetail.message, 'context canceled');
  assert.equal(nextStatusDetail.observedAt, nextBucketNow);

  const tampered = JSON.parse(firstDiskText);
  tampered.files['account-a.json'][String(firstBucketStart)].details.connection_transient.message =
    'Authorization: Bearer projection-secret';
  tampered.files['injected.json'] = {
    [String(firstBucketStart)]: {
      startTime: firstBucketStart,
      endTime: firstBucketStart + 10 * 60 * 1000,
      details: {
        unknown_upstream_error: {
          category: 'unknown_upstream_error',
          message: 'refresh_token=raw-projection-secret',
          observedAt: nowMs,
          expiresAt: nowMs + AUTH_FAILURE_HISTORY_TTL_MS,
        },
      },
    },
  };
  await writeFile(statePath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
  const safeProjection = await readAuthFailureHistoryProjection(statePath, nowMs);
  assert.equal(
    safeProjection.files['account-a.json'][String(firstBucketStart)].details.connection_transient
      .message,
    'EOF',
    'The read API must rebuild from sanitized observer state instead of trusting stored projection text.'
  );
  assert.equal(safeProjection.files['injected.json'], undefined);
  assert.doesNotMatch(JSON.stringify(safeProjection), /projection-secret|raw-projection/i);
  await observeAuthFailureHistory(options);
  assert.doesNotMatch(await readFile(statePath, 'utf8'), /projection-secret|raw-projection/i);

  const expiredAt = nextBucketNow + AUTH_FAILURE_HISTORY_TTL_MS + 1;
  await observeAuthFailureHistory({ ...options, nowMs: expiredAt, authFiles: [] });
  const expiredProjection = await readAuthFailureHistoryProjection(statePath, expiredAt);
  assert.deepEqual(expiredProjection.files, {}, 'Failure reasons must expire after three hours.');
  assert.doesNotMatch(
    await readFile(statePath, 'utf8'),
    /account-a\.json|account-b\.json|\bEOF\b|context canceled/i,
    'Expired failure details must be removed from the raw state file, not only hidden by projection.'
  );
} finally {
  await rm(root, { recursive: true, force: true });
}

{
  const legacyRoot = await mkdtemp(path.join(tmpdir(), 'auth-status-history-legacy-backfill-'));
  try {
    const logsDir = path.join(legacyRoot, 'logs');
    const dataDir = path.join(legacyRoot, 'priority-rotation');
    const statePath = path.join(dataDir, 'auth-failure-history.json');
    const mainLogPath = path.join(logsDir, 'main.log');
    await mkdir(logsDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(mainLogPath, '', 'utf8');

    const fixtureDate = new Date(Date.now() - 60_000);
    const pad = (value) => String(value).padStart(2, '0');
    const responseLogName = `v1-responses-${fixtureDate.getFullYear()}-${pad(fixtureDate.getMonth() + 1)}-${pad(fixtureDate.getDate())}T${pad(fixtureDate.getHours())}${pad(fixtureDate.getMinutes())}${pad(fixtureDate.getSeconds())}-deadbeef.log`;
    await writeFile(
      path.join(logsDir, responseLogName),
      '=== RESPONSE ===\nStatus: 200\n{"ok":true}\n',
      'utf8'
    );
    const watermarkMs = Date.now() + 1_000;
    await writeFile(
      statePath,
      `${JSON.stringify(
        {
          version: 1,
          generatedAt: new Date(watermarkMs).toISOString(),
          files: {},
          active: {},
          state: {
            mainLogOffset: 0,
            mainLogSize: 0,
            mainLogMtimeMs: 0,
            nextAttemptSequence: 1,
            attemptsByRequest: {},
            responseSources: {},
            statusRecords: {},
            statusEpisodes: {},
          },
        },
        null,
        2
      )}\n`,
      'utf8'
    );

    let parseCalls = 0;
    const migrated = await observeAuthFailureHistory(
      {
        logsDir,
        mainLogPath,
        statePath,
        nowMs: watermarkMs + 1_000,
        authFiles: [],
      },
      {
        classifySignal: async () => null,
        parseResponseSource: async () => {
          parseCalls += 1;
          throw new Error('legacy response log must not be parsed');
        },
      }
    );

    assert.equal(parseCalls, 0, 'Legacy success logs before the watermark must not be reread.');
    assert.equal(
      migrated.state.responseSourceBackfillCompletedAtMs,
      watermarkMs,
      'The one-time compatibility backfill must be persisted.'
    );
    assert.deepEqual(migrated.state.responseSources[responseLogName].failures, []);
  } finally {
    await rm(legacyRoot, { recursive: true, force: true });
  }
}

{
  const boundedRoot = await mkdtemp(path.join(tmpdir(), 'auth-status-history-bounded-main-log-'));
  try {
    const logsDir = path.join(boundedRoot, 'logs');
    const dataDir = path.join(boundedRoot, 'priority-rotation');
    const statePath = path.join(dataDir, 'auth-failure-history.json');
    const mainLogPath = path.join(logsDir, 'main.log');
    await mkdir(logsDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });

    const readLimitBytes = 4 * 1024 * 1024;
    const fixtureDate = new Date(Date.now() - 60_000);
    const pad = (value) => String(value).padStart(2, '0');
    const fixtureTimestamp = `${fixtureDate.getFullYear()}-${pad(fixtureDate.getMonth() + 1)}-${pad(fixtureDate.getDate())} ${pad(fixtureDate.getHours())}:${pad(fixtureDate.getMinutes())}:${pad(fixtureDate.getSeconds())}`;
    const selectionLine = `[${fixtureTimestamp}] [c0ffee00] [info ] [selector.go:436] session-affinity: cache hit | session=private auth=Bounded-A.json provider=mixed model=gpt-test\n`;
    await writeFile(
      mainLogPath,
      Buffer.concat([
        Buffer.alloc(readLimitBytes + 128, 0x78),
        Buffer.from(`\n${selectionLine}`, 'utf8'),
      ])
    );

    const first = await observeAuthFailureHistory(
      {
        logsDir,
        mainLogPath,
        statePath,
        nowMs: Date.now(),
        authFiles: [],
      },
      { classifySignal: async () => null }
    );
    assert.equal(
      first.state.mainLogOffset,
      readLimitBytes,
      'A newline-free oversized line must advance by only the bounded read size.'
    );
    assert.deepEqual(
      first.state.attemptsByRequest,
      {},
      'Selections beyond the first bounded chunk must wait for the next pass.'
    );

    const second = await observeAuthFailureHistory(
      {
        logsDir,
        mainLogPath,
        statePath,
        nowMs: Date.now() + 15_000,
        authFiles: [],
      },
      { classifySignal: async () => null }
    );
    assert.equal(second.state.attemptsByRequest.c0ffee00[0].fileName, 'Bounded-A.json');
    assert.equal(second.state.mainLogOffset, (await readFile(mainLogPath)).length);
  } finally {
    await rm(boundedRoot, { recursive: true, force: true });
  }
}

{
  const partialRoot = await mkdtemp(path.join(tmpdir(), 'auth-status-history-partial-main-log-'));
  try {
    const logsDir = path.join(partialRoot, 'logs');
    const dataDir = path.join(partialRoot, 'priority-rotation');
    const statePath = path.join(dataDir, 'auth-failure-history.json');
    const mainLogPath = path.join(logsDir, 'main.log');
    await mkdir(logsDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    const fixtureDate = new Date(Date.now() - 60_000);
    const pad = (value) => String(value).padStart(2, '0');
    const fixtureTimestamp = `${fixtureDate.getFullYear()}-${pad(fixtureDate.getMonth() + 1)}-${pad(fixtureDate.getDate())} ${pad(fixtureDate.getHours())}:${pad(fixtureDate.getMinutes())}:${pad(fixtureDate.getSeconds())}`;
    const partialLine = `[${fixtureTimestamp}] [decafbad] [info ] [selector.go:436] session-affinity: cache hit | session=private auth=Partial-A.json provider=mixed model=gpt-test`;
    await writeFile(mainLogPath, partialLine, 'utf8');

    const first = await observeAuthFailureHistory(
      { logsDir, mainLogPath, statePath, nowMs: Date.now(), authFiles: [] },
      { classifySignal: async () => null }
    );
    assert.equal(first.state.mainLogOffset, 0);
    assert.deepEqual(first.state.attemptsByRequest, {});

    await writeFile(mainLogPath, `${partialLine}\n`, 'utf8');
    const second = await observeAuthFailureHistory(
      { logsDir, mainLogPath, statePath, nowMs: Date.now() + 15_000, authFiles: [] },
      { classifySignal: async () => null }
    );
    assert.equal(second.state.attemptsByRequest.decafbad[0].fileName, 'Partial-A.json');
  } finally {
    await rm(partialRoot, { recursive: true, force: true });
  }
}

console.log('auth status history observer tests passed');
