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

const settleWithin = async (promise, timeoutMs) => {
  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: 'test-timeout' }), timeoutMs);
  });
  const settled = promise.then(
    (value) => ({ kind: 'resolved', value }),
    (error) => ({ kind: 'rejected', error })
  );
  const result = await Promise.race([settled, timeout]);
  clearTimeout(timeoutId);
  return result;
};

let capturedSignal = null;
let fetchCount = 0;
globalThis.fetch = async (_url, options = {}) => {
  fetchCount += 1;
  const signal = options.signal ?? null;
  capturedSignal = signal;
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
      { once: true }
    );
  });
};

const timedOut = await settleWithin(
  apiModule.priorityRotationSidecarApi.getAuthFailureHistory(),
  2_500
);
assert.notEqual(
  timedOut.kind,
  'test-timeout',
  'A hanging 8318 response must be aborted by the frontend request timeout.'
);
assert.equal(timedOut.kind, 'rejected');
assert.ok(capturedSignal instanceof AbortSignal);
assert.equal(capturedSignal.aborted, true);
assert.match(String(timedOut.error?.message ?? timedOut.error), /timed out|abort/i);

capturedSignal = null;
globalThis.fetch = async (_url, options = {}) => {
  fetchCount += 1;
  const signal = options.signal ?? null;
  capturedSignal = signal;
  return {
    ok: true,
    status: 200,
    text: () =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
          { once: true }
        );
      }),
  };
};
const bodyTimedOut = await settleWithin(
  apiModule.priorityRotationSidecarApi.getAuthFailureHistory(),
  2_500
);
assert.equal(
  bodyTimedOut.kind,
  'rejected',
  'The timeout must also cover a response body that never finishes.'
);
assert.equal(capturedSignal?.aborted, true);

capturedSignal = null;
globalThis.fetch = async (_url, options = {}) => {
  fetchCount += 1;
  const signal = options.signal ?? null;
  capturedSignal = signal;
  return new Promise((_resolve, reject) => {
    signal?.addEventListener(
      'abort',
      () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError')),
      { once: true }
    );
  });
};
const callerController = new AbortController();
const callerCancelledPromise = apiModule.priorityRotationSidecarApi.getAuthFailureHistory(
  callerController.signal
);
callerController.abort(new DOMException('Component unmounted', 'AbortError'));
const callerCancelled = await settleWithin(callerCancelledPromise, 250);
assert.equal(
  callerCancelled.kind,
  'rejected',
  'Component cleanup must be able to cancel an in-flight history request immediately.'
);
assert.equal(capturedSignal?.aborted, true);

const payload = { version: 1, files: {}, active: {}, generatedAt: null };
globalThis.fetch = async () =>
  new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const recovered = await apiModule.priorityRotationSidecarApi.getAuthFailureHistory();
assert.deepEqual(recovered, payload);
assert.equal(
  fetchCount,
  3,
  'The header hang, body hang, and caller-cancelled request must all reach fetch.'
);

console.log('auth status history sidecar timeout behavior passed');
