import { spawn } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';

import {
  PORTABLE_SMOKE_TIMEOUT_MS,
  resolvePortableSmokeResult,
} from './portableSmokeResult.mjs';

const outputDirectory = 'D:\\apps\\CPA-Token-Pulse';
const requestedArtifact = process.argv[2];

async function findArtifact() {
  if (requestedArtifact) {
    await access(requestedArtifact);
    return path.resolve(requestedArtifact);
  }

  const entries = await readdir(outputDirectory, { withFileTypes: true });
  const artifact = entries
    .filter((entry) => entry.isFile() && /portable\.exe$/i.test(entry.name))
    .sort((left, right) => right.name.localeCompare(left.name))[0];

  if (!artifact) {
    throw new Error('portable-artifact-not-found');
  }

  return path.join(outputDirectory, artifact.name);
}

const artifactPath = await findArtifact();
const child = spawn(artifactPath, ['--smoke-test'], {
  stdio: 'inherit',
  windowsHide: true,
});

const exitCode = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error('portable-smoke-timeout'));
  }, PORTABLE_SMOKE_TIMEOUT_MS);

  child.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once('exit', (code) => {
    clearTimeout(timeout);
    resolve(code);
  });
});

const result = resolvePortableSmokeResult(exitCode, artifactPath);
if (result.stdout) {
  process.stdout.write(result.stdout);
}
if (result.stderr) {
  process.stderr.write(result.stderr);
}
process.exitCode = result.exitCode;
