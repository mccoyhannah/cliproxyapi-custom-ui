import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

const configPage = readSource('src/pages/ConfigPage.tsx');
const sidebarNav = readSource('src/components/layout/SidebarNav.tsx');
const mainLayout = readSource('src/components/layout/MainLayout.tsx');
const authFilesPage = readSource('src/pages/AuthFilesPage.tsx');

assert.doesNotMatch(
  configPage,
  /\ballowNextNavigation\b/,
  'Config stays on the same page after save, so it must not open a temporary navigation bypass.'
);

assert.match(
  configPage,
  /useUnsavedChangesGuard\(\{[\s\S]*?hasUnsavedChanges:\s*isDirty,[\s\S]*?shouldBlock:/,
  'Config must keep the unsaved-changes guard wired to the current dirty state.'
);

assert.match(
  configPage,
  /const shouldRenderFloatingActions\s*=\s*isCurrentLayer\s*&&\s*\(\s*isDirty\s*\|\|/,
  'Config floating actions must be contextual instead of rendering throughout the clean page.'
);

assert.match(
  sidebarNav,
  /if \(event\.key === 'Escape'\) \{\s*event\.preventDefault\(\);\s*event\.stopPropagation\(\);\s*onClose\(\);/,
  'The mobile drawer must consume Escape before the event reaches page-level handlers.'
);

assert.match(
  authFilesPage,
  /const refocusFileCardsAfterListViewChange = useCallback\(\(\) => \{\s*focusFileCards\('auto', fileCardsFocusPinned\);\s*\}, \[fileCardsFocusPinned, focusFileCards\]\);/,
  'List pagination must always return to the cards area while locking only when the user kept it pinned.'
);

assert.match(
  authFilesPage,
  /const shouldPinFileCards = shouldPinAuthFilesCards\(location\);[\s\S]*?const isNewFocusIdentity = focusedFileListOnOpenRef\.current\.search !== focusIdentity;\s*if \(isNewFocusIdentity\) \{[\s\S]*?setFileCardsFocusPinned\(shouldPinFileCards\);[\s\S]*?\}/,
  'Route pin state may initialize a new focus entry, but must not overwrite an explicit unpin on same-entry rerenders.'
);

assert.match(
  authFilesPage,
  /if \(!shouldFocusAuthFilesCards\(location\)\) \{\s*focusedFileListOnOpenRef\.current = \{\s*search: focusIdentity,/,
  'An unpinned history entry must retain its focus identity so an explicit re-pin is not overwritten on the next render.'
);

assert.match(
  mainLayout,
  /dispatchAuthFilesCardsFocusEvent\(\{ pinned: true, behavior: 'smooth' \}\);\s*if \(!authFilesCardsStatePinned\) \{[\s\S]*?replace: true,[\s\S]*?state: createAuthFilesCardsFocusState\(\)/,
  'Re-pinning must replace the stale unpinned history state as well as updating the visible control.'
);

console.log('ui interaction safety invariants passed');
