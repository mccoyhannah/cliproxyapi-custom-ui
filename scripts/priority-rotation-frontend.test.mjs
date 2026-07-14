import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(repoRoot, 'src', 'features', 'authFiles', 'priorityRotation.ts');
const classifierPath = path.join(
  repoRoot,
  'src',
  'features',
  'authFiles',
  'statusClassification.ts'
);
const [source, classifierSource] = await Promise.all([
  fs.readFile(sourcePath, 'utf8'),
  fs.readFile(classifierPath, 'utf8'),
]);
const withoutImports = source.replace(/import[\s\S]*?from\s+['"][^'"]+['"];\s*/g, '');
const testHarness = `
const getCodexFiveHourRemainingPercent = (quota) => {
  if (!quota || quota.status !== 'success') return null;
  const window = quota.windows?.find((item) => item.id === 'five-hour') ?? quota.windows?.[0];
  return typeof window?.usedPercent === 'number' ? Math.max(0, 100 - window.usedPercent) : null;
};
const isCodexFile = (file) => String(file?.type ?? '').toLowerCase() === 'codex';
const isDisabledAuthFile = (file) => file?.disabled === true;
const isRuntimeOnlyAuthFile = () => false;
const normalizePlanType = (value) => {
  const text = String(value ?? '').trim().toLowerCase();
  return text || null;
};
const resolveCodexPlanType = (file) => normalizePlanType(file?.planType);
const parsePriorityValue = (value) => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric) : undefined;
};
`;
const transpiled = ts.transpileModule(`${classifierSource}\n${testHarness}\n${withoutImports}`, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const module = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`
);

const codexFile = (name, priority) => ({ name, type: 'codex', priority });

{
  const files = [
    codexFile('cloudflare.json', 2),
    codexFile('model-restricted.json', 2),
    codexFile('unknown.json', 2),
    codexFile('authentication-timeout.json', 2),
    codexFile('authentication-wrapper.json', 2),
  ];
  const quota = {
    'cloudflare.json': {
      status: 'error',
      planType: 'team',
      windows: [],
      error: 'cloudflare challenge',
      errorStatus: 403,
    },
    'model-restricted.json': {
      status: 'error',
      planType: 'team',
      windows: [],
      error: 'The model is not supported when using Codex with a ChatGPT account.',
      errorStatus: 500,
    },
    'unknown.json': {
      status: 'error',
      planType: 'team',
      windows: [],
      error: 'provider returned an unfamiliar failure',
    },
    'authentication-timeout.json': {
      status: 'error',
      planType: 'team',
      windows: [],
      error: 'authentication failed: EOF',
    },
    'authentication-wrapper.json': {
      status: 'error',
      planType: 'team',
      windows: [],
      error: 'authentication_error: EOF',
    },
  };
  const result = module.analyzeCodexPriorityRotation(files, quota, 50, 1);
  assert.equal(result.status, 'quota_unknown');
  assert.deepEqual(
    result.changes,
    [],
    'Retryable global/upstream failures must never be trimmed by the active-slot limit.'
  );
}

{
  const result = module.analyzeCodexPriorityRotation(
    [codexFile('invalid-token.json', 2)],
    {
      'invalid-token.json': {
        status: 'error',
        planType: 'team',
        windows: [],
        errorKind: 'credential_invalid',
        retryable: false,
      },
    },
    50,
    1
  );
  assert.deepEqual(
    result.changes.map((change) => [change.name, change.reason, change.toPriority]),
    [['invalid-token.json', 'credential_invalid', 0]],
    'Only a confirmed credential failure may demote an account to the buffer tier.'
  );
}

{
  const result = module.analyzeCodexPriorityRotation(
    [codexFile('active-global-failure.json', 2), codexFile('active-healthy.json', 2)],
    {
      'active-global-failure.json': {
        status: 'error',
        planType: 'team',
        windows: [],
        error: 'cloudflare challenge',
        errorStatus: 403,
      },
      'active-healthy.json': {
        status: 'success',
        planType: 'team',
        windows: [{ id: 'five-hour', usedPercent: 10 }],
      },
    },
    50,
    1
  );
  assert.equal(result.status, 'quota_unknown');
  assert.deepEqual(
    result.changes,
    [],
    'A protected global failure must not consume the slot and push a healthy account down.'
  );
}

console.log('frontend priority-rotation safety cases passed');
