import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readSource = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), 'utf8').replace(/\r\n/g, '\n');

const configPage = readSource('src/pages/ConfigPage.tsx');
const sidebarNav = readSource('src/components/layout/SidebarNav.tsx');

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

console.log('ui interaction safety invariants passed');
