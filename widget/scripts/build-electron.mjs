import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const widgetRoot = path.dirname(scriptsDirectory);
const outputDirectory = path.join(widgetRoot, 'dist-electron');

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(path.join(outputDirectory, 'collector'), { recursive: true });
await mkdir(path.join(outputDirectory, 'maintenance'), { recursive: true });

const commonOptions = {
  bundle: true,
  legalComments: 'none',
  logLevel: 'info',
  minify: false,
  packages: 'external',
  platform: 'node',
  sourcemap: false,
  target: 'node22',
};

await Promise.all([
  build({
    ...commonOptions,
    entryPoints: [path.join(widgetRoot, 'electron', 'main.ts')],
    external: ['electron'],
    format: 'esm',
    outfile: path.join(outputDirectory, 'main.js'),
  }),
  build({
    ...commonOptions,
    entryPoints: [path.join(widgetRoot, 'electron', 'preload.ts')],
    external: ['electron'],
    format: 'cjs',
    outfile: path.join(outputDirectory, 'preload.cjs'),
  }),
  build({
    ...commonOptions,
    entryPoints: [path.join(widgetRoot, 'electron', 'collector', 'worker.ts')],
    format: 'esm',
    outfile: path.join(outputDirectory, 'collector', 'worker.js'),
  }),
  build({
    ...commonOptions,
    entryPoints: [path.join(widgetRoot, 'electron', 'maintenance', 'worker.ts')],
    format: 'esm',
    outfile: path.join(outputDirectory, 'maintenance', 'worker.js'),
  }),
]);

await writeFile(
  path.join(outputDirectory, 'collector', 'package.json'),
  '{"type":"module"}\n',
  'utf8'
);
await writeFile(
  path.join(outputDirectory, 'maintenance', 'package.json'),
  '{"type":"module"}\n',
  'utf8'
);
