import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { promotePortableArtifact } from '../../scripts/portableArtifact.mjs';
import {
  PORTABLE_SMOKE_TIMEOUT_MS,
  resolvePortableSmokeResult,
} from '../../scripts/portableSmokeResult.mjs';

test('portable smoke forwards the application exit code for an existing instance', () => {
  assert.deepEqual(
    resolvePortableSmokeResult(4, 'D:\\apps\\CPA-Token-Pulse\\CPA-Token-Pulse.exe'),
    {
      exitCode: 4,
      stderr: 'portable-smoke-exit:4\n',
      stdout: '',
    }
  );
});

test('portable packaging forces a unique plugin extraction directory per launch', async () => {
  const config = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');

  assert.match(config, /^\s*unpackDirName:\s*true\s*$/m);
});

test('portable packaging bundles and unpacks the isolated ledger maintenance worker', async () => {
  const config = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  const buildScript = await readFile(
    new URL('../../scripts/build-electron.mjs', import.meta.url),
    'utf8'
  );

  assert.match(config, /^\s*-\s*dist-electron\/maintenance\/worker\.js\s*$/m);
  assert.match(config, /^\s*-\s*dist-electron\/maintenance\/package\.json\s*$/m);
  assert.match(buildScript, /electron['"],\s*['"]maintenance['"],\s*['"]worker\.ts['"]/);
  assert.match(
    buildScript,
    /outfile:\s*path\.join\(outputDirectory,\s*['"]maintenance['"],\s*['"]worker\.js['"]\)/
  );
});

test('portable builder stages in cache and promotes only the final executable', async (t) => {
  const config = await readFile(new URL('../../electron-builder.yml', import.meta.url), 'utf8');
  assert.match(
    config,
    /^\s*output:\s*D:\/Tools\/Cache\/CPA-Token-Pulse\/builder-output\/current\s*$/m
  );

  const testRoot = 'D:\\Tools\\Cache\\CPA-Token-Pulse\\tests';
  await mkdir(testRoot, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(testRoot, 'portable-artifact-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));

  const builderOutput = path.join(fixtureRoot, 'builder-output');
  const deliveryDirectory = path.join(fixtureRoot, 'delivery');
  const artifactName = 'CPA-Token-Pulse-1.0.0-portable.exe';
  await mkdir(path.join(builderOutput, 'win-unpacked'), { recursive: true });
  await mkdir(deliveryDirectory, { recursive: true });
  await writeFile(path.join(builderOutput, artifactName), 'new-portable');
  await writeFile(path.join(deliveryDirectory, artifactName), 'old-portable');

  const installedPath = await promotePortableArtifact({
    builderOutput,
    deliveryDirectory,
  });

  assert.equal(installedPath, path.join(deliveryDirectory, artifactName));
  assert.equal(await readFile(installedPath, 'utf8'), 'new-portable');
  assert.deepEqual(await readdir(deliveryDirectory), [artifactName]);
});

test('portable smoke allows enough time for an isolated Electron extraction', () => {
  assert.equal(PORTABLE_SMOKE_TIMEOUT_MS, 90_000);
});
