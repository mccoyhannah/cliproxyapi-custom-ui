import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  normalizeWatcherOptions,
  runWatcherOnce,
  shouldWakeForActivity,
} from './priority-rotation-wake-watcher.mjs';

{
  assert.deepEqual(
    shouldWakeForActivity({
      latestRequestAtMs: 2_000,
      lastSeenRequestAtMs: null,
      settingsEnabled: true,
    }),
    { wake: false, reason: 'bootstrap', nextLastSeenRequestAtMs: 2_000 }
  );

  assert.equal(
    shouldWakeForActivity({
      latestRequestAtMs: 2_000,
      lastSeenRequestAtMs: 1_000,
      settingsEnabled: false,
    }).reason,
    'disabled'
  );

  assert.equal(
    shouldWakeForActivity({
      latestRequestAtMs: 2_000,
      lastSeenRequestAtMs: 1_000,
      settingsEnabled: true,
      sidecarRunning: true,
    }).reason,
    'already_running'
  );

  assert.equal(
    shouldWakeForActivity({
      latestRequestAtMs: 2_000,
      lastSeenRequestAtMs: 1_000,
      lastWakeAttemptAtMs: 1_900,
      nowMs: 2_000,
      cooldownSeconds: 30,
      settingsEnabled: true,
    }).reason,
    'cooldown'
  );

  assert.equal(
    shouldWakeForActivity({
      latestRequestAtMs: 2_000,
      lastSeenRequestAtMs: 1_000,
      lastWakeAttemptAtMs: 1_000,
      nowMs: 40_000,
      cooldownSeconds: 30,
      settingsEnabled: true,
    }).wake,
    true
  );
}

{
  let launched = 0;
  let persisted = null;
  const result = await runWatcherOnce({
    options: normalizeWatcherOptions({
      installDir: 'D:\\CLIProxyAPI',
      customUiDir: 'D:\\CLIProxyAPI_Maintenance\\custom-ui',
    }),
    state: { lastSeenRequestAtMs: 1_000, wakeCount: 0 },
    dependencies: {
      now: () => 40_000,
      readLatestRequestAtMs: async () => 2_000,
      readSettingsEnabled: async () => true,
      isSidecarReachable: async () => false,
      launchSidecar: async () => {
        launched += 1;
      },
      waitForSidecar: async () => true,
      logLine: async () => {},
      persistState: async (state) => {
        persisted = state;
      },
    },
  });

  assert.equal(result.decision.wake, true);
  assert.equal(result.state.lastWakeResult, 'started');
  assert.equal(result.state.wakeCount, 1);
  assert.equal(launched, 1);
  assert.equal(persisted.lastSeenRequestAtMs, 2_000);
}

{
  let launched = 0;
  const result = await runWatcherOnce({
    options: normalizeWatcherOptions({}),
    state: { lastSeenRequestAtMs: 1_000, wakeCount: 0 },
    dependencies: {
      now: () => 40_000,
      readLatestRequestAtMs: async () => 2_000,
      readSettingsEnabled: async () => true,
      isSidecarReachable: async () => true,
      launchSidecar: async () => {
        launched += 1;
      },
      logLine: async () => {},
      persistState: async () => {},
    },
  });

  assert.equal(result.decision.reason, 'already_running');
  assert.equal(launched, 0);
}

{
  const root = await mkdtemp(path.join(tmpdir(), 'priority-rotation-wake-watcher-'));
  try {
    const installDir = path.join(root, 'install');
    const logsDir = path.join(installDir, 'logs');
    const dataDir = path.join(installDir, 'priority-rotation');
    await mkdir(logsDir, { recursive: true });
    await mkdir(dataDir, { recursive: true });
    await writeFile(path.join(dataDir, 'settings.json'), '{"enabled":true}\n', 'utf8');
    await writeFile(
      path.join(logsDir, 'v1-responses-2026-05-20T080000-real.log'),
      'historical request',
      'utf8'
    );

    const options = normalizeWatcherOptions({
      installDir,
      dataDir,
      modelRequestLogsDir: logsDir,
      watcherLogsDir: path.join(dataDir, 'logs'),
      statePath: path.join(dataDir, 'wake-watcher-state.json'),
      settingsPath: path.join(dataDir, 'settings.json'),
      cooldownSeconds: 1,
    });
    let launched = 0;

    const first = await runWatcherOnce({
      options,
      dependencies: {
        now: () => 1_000_000,
        launchSidecar: async () => {
          launched += 1;
        },
        logLine: async () => {},
      },
    });
    assert.equal(first.decision.reason, 'bootstrap');
    assert.equal(launched, 0);

    await writeFile(
      path.join(logsDir, 'v1-images-generations-2026-05-20T080100-real.log'),
      'new image request',
      'utf8'
    );
    const second = await runWatcherOnce({
      options,
      dependencies: {
        now: () => 1_100_000,
        isSidecarReachable: async () => false,
        launchSidecar: async () => {
          launched += 1;
        },
        waitForSidecar: async () => true,
        logLine: async () => {},
      },
    });
    const persisted = JSON.parse(await readFile(options.statePath, 'utf8'));

    assert.equal(second.decision.wake, true);
    assert.equal(second.state.lastWakeResult, 'started');
    assert.equal(launched, 1);
    assert.equal(persisted.lastSeenRequestAt, '2026-05-20T00:01:00.000Z');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
