import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, '..', 'src', 'utils', 'quota', 'resetCredits.ts');
const source = await fs.readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    isolatedModules: true,
  },
});

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-reset-credits-'));
const modulePath = path.join(tmpRoot, 'resetCredits.mjs');

try {
  await fs.writeFile(modulePath, transpiled.outputText, 'utf8');
  const {
    normalizeCodexResetCreditsPayload,
    resolveCodexResetCreditsAvailableCount,
  } = await import(pathToFileURL(modulePath).href);

  const trueZero = normalizeCodexResetCreditsPayload({
    available_count: 0,
    credits: [],
  });
  assert.equal(trueZero.invalidPayload, false);
  assert.equal(
    resolveCodexResetCreditsAvailableCount({
      detailsAvailableCount: trueZero.availableCount,
      detailsCreditsCount: trueZero.credits.length,
      usageAvailableCount: 0,
      detailsError: '',
    }),
    0
  );

  assert.equal(
    resolveCodexResetCreditsAvailableCount({
      detailsAvailableCount: null,
      detailsCreditsCount: 0,
      usageAvailableCount: 0,
      detailsError: 'timeout of 15000ms exceeded',
    }),
    null
  );

  const positiveDetails = normalizeCodexResetCreditsPayload({
    credits: [
      {
        id: 'credit-1',
        reset_type: 'codex_rate_limits',
        status: 'available',
        expires_at: '2026-07-09T00:00:00Z',
      },
    ],
  });
  assert.equal(positiveDetails.invalidPayload, false);
  assert.equal(
    resolveCodexResetCreditsAvailableCount({
      detailsAvailableCount: positiveDetails.availableCount,
      detailsCreditsCount: positiveDetails.credits.length,
      usageAvailableCount: 0,
      detailsError: '',
    }),
    1
  );
} finally {
  await fs.rm(tmpRoot, { recursive: true, force: true });
}
