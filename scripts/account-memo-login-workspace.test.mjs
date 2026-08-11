import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

const workspaceSource = readSource(
  'src/features/authFiles/accountMemoLoginWorkspace.ts'
);
const authFilesPageSource = readSource('src/pages/AuthFilesPage.tsx');
const authFilesStylesSource = readSource('src/pages/AuthFilesPage.module.scss');

const transpiled = ts.transpileModule(workspaceSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const workspace = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`
);

const wideLayout = workspace.createAccountMemoLoginWorkspaceLayout({
  availWidth: 1920,
  availHeight: 1040,
  availLeft: 0,
  availTop: 0,
});
assert.equal(wideLayout.tiled, true);
assert.ok(wideLayout.leftVisibleWidth >= 420);
assert.ok(wideLayout.popup.width >= 900);
assert.equal(
  wideLayout.popup.left + wideLayout.popup.width + wideLayout.gap,
  1920,
  'The login popup must stay aligned to the right edge while leaving the copy panel visible.'
);
assert.match(wideLayout.features, /popup=yes/);
assert.match(wideLayout.features, /resizable=yes/);
assert.match(wideLayout.features, /scrollbars=yes/);

const smallLayout = workspace.createAccountMemoLoginWorkspaceLayout({
  availWidth: 900,
  availHeight: 700,
  availLeft: 0,
  availTop: 0,
});
assert.equal(smallLayout.tiled, false);
assert.ok(smallLayout.popup.width <= 876);
assert.ok(smallLayout.popup.left >= 12);

assert.match(
  authFilesPageSource,
  /handleOpenCodexOAuth\(true\)/,
  'The login button inside account memo must request the side-by-side workspace.'
);
assert.match(
  authFilesPageSource,
  /createAccountMemoLoginWorkspaceLayout\(window\.screen\)[\s\S]*?window\.open\([\s\S]*?layout\?\.features/,
  'The OAuth window must use a desktop popup layout instead of an ordinary new tab.'
);
assert.match(authFilesPageSource, /accountMemoLoginWorkspaceActive/);
assert.match(authFilesPageSource, /styles\.accountMemoLoginWorkspaceOverlay/);
assert.match(
  authFilesPageSource,
  /styles\.accountMemoLoginWorkspaceModal/,
  'The account memo must move into its compact copy-panel layout while OAuth is open.'
);
assert.match(
  authFilesStylesSource,
  /\.accountMemoLoginWorkspaceOverlay:global\(\.modal-overlay\)[\s\S]*?justify-content:\s*flex-start/,
  'The active copy panel must stay on the left side of the screen.'
);

console.log('account memo login workspace invariants passed');
