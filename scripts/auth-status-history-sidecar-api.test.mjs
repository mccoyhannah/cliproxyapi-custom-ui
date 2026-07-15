import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await fs.readFile(
  path.join(repoRoot, 'src', 'services', 'api', 'priorityRotationSidecar.ts'),
  'utf8'
);
const moduleSource = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const apiModule = await import(
  `data:text/javascript;base64,${Buffer.from(moduleSource).toString('base64')}`
);

const requests = [];
const payload = {
  version: 1,
  generatedAt: '2026-07-15T06:00:00.000Z',
  files: {
    'account-a.json': {
      1784072400000: {
        startTime: 1784072400000,
        endTime: 1784073000000,
        details: {
          connection_transient: {
            category: 'connection_transient',
            message: 'EOF',
            observedAt: 1784072460000,
            expiresAt: 1784083260000,
          },
        },
      },
    },
  },
  active: {},
};

globalThis.fetch = async (url, options = {}) => {
  requests.push({ url: String(url), options });
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

const result = await apiModule.priorityRotationSidecarApi.getAuthFailureHistory();
assert.deepEqual(result, payload);
assert.equal(requests.length, 1);
assert.equal(requests[0].url, 'http://127.0.0.1:8318/auth-failure-history');
assert.equal(requests[0].options.method, undefined, 'Failure history must use a read-only GET.');

console.log('auth status history sidecar API tests passed');
