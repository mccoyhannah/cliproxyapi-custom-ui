import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { promotePortableArtifact } from './portableArtifact.mjs';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.dirname(scriptsDirectory);
const builderOutputDirectory =
  'D:\\Tools\\Cache\\CPA-Token-Pulse\\builder-output\\current';
const deliveryDirectory = 'D:\\apps\\CPA-Token-Pulse';
const builderEntry = path.join(
  widgetRoot,
  'node_modules',
  'electron-builder',
  'out',
  'cli',
  'cli.js'
);

const child = spawn(
  process.execPath,
  [builderEntry, '--config', 'electron-builder.yml', '--win', 'portable', '--x64'],
  {
    cwd: widgetRoot,
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
      ELECTRON_BUILDER_CACHE:
        process.env.ELECTRON_BUILDER_CACHE ?? 'D:\\Tools\\Cache\\electron-builder',
      ELECTRON_CACHE: process.env.ELECTRON_CACHE ?? 'D:\\Tools\\Cache\\Electron',
      npm_config_cache: process.env.npm_config_cache ?? 'D:\\Tools\\Cache\\npm',
    },
    stdio: 'inherit',
  }
);

const exitCode = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolve(code));
});

if (exitCode !== 0) {
  throw new Error(`electron-builder-exit:${exitCode ?? 'null'}`);
}

const artifactPath = await promotePortableArtifact({
  builderOutput: builderOutputDirectory,
  deliveryDirectory,
});
process.stdout.write(`portable-artifact-installed: ${artifactPath}\n`);
