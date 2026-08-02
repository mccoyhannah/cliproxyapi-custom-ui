import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getBottomRightBounds,
  normalizePersistedPlacement,
  resolveDockedBounds,
  resolveDockDisplay,
  serializePlacement,
} from '../../electron/windowPlacement.mjs';

const primaryDisplay = {
  id: 1,
  workArea: { x: 0, y: 0, width: 1920, height: 1040 },
};
const leftDisplay = {
  id: 42,
  workArea: { x: -1920, y: 0, width: 1920, height: 1080 },
};

test('bottom-right bounds honor work area taskbar and negative secondary coordinates', () => {
  assert.deepEqual(
    getBottomRightBounds({ width: 340, height: 190 }, leftDisplay.workArea, 12),
    { x: -352, y: 878, width: 340, height: 190 }
  );
  assert.deepEqual(
    getBottomRightBounds({ width: 460, height: 600 }, primaryDisplay.workArea, 12),
    { x: 1448, y: 428, width: 460, height: 600 }
  );
});

test('dock display prefers the remembered monitor and safely falls back by proximity', () => {
  assert.equal(
    resolveDockDisplay([primaryDisplay, leftDisplay], 42, { x: 100, y: 100, width: 340, height: 190 }, 1)
      .id,
    42
  );
  assert.equal(
    resolveDockDisplay([primaryDisplay, leftDisplay], 999, { x: -1600, y: 100, width: 340, height: 190 }, 1)
      .id,
    42
  );
  assert.equal(
    resolveDockDisplay([primaryDisplay, leftDisplay], 999, { x: 3000, y: 100, width: 340, height: 190 }, 1)
      .id,
    1
  );
});

test('a manual move while fixed resolves back to the remembered display corner', () => {
  const draggedBounds = { x: -760, y: 90, width: 340, height: 190 };
  const resolved = resolveDockedBounds({
    displays: [primaryDisplay, leftDisplay],
    preferredDisplayId: 42,
    currentBounds: draggedBounds,
    primaryDisplayId: 1,
    size: { width: 340, height: 190 },
    margin: 12,
  });

  assert.deepEqual(resolved, {
    displayId: 42,
    bounds: { x: -352, y: 878, width: 340, height: 190 },
  });
  assert.notDeepEqual(resolved.bounds, draggedBounds);
});

test('persisted placement round-trips display identity and accepts legacy positions', () => {
  const persisted = serializePlacement({ x: -352.4, y: 878.6, width: 340, height: 190 }, 42);
  assert.deepEqual(persisted, { x: -352, y: 879, displayId: 42 });
  assert.deepEqual(normalizePersistedPlacement(JSON.parse(JSON.stringify(persisted))), persisted);
  assert.deepEqual(normalizePersistedPlacement({ x: 10.4, y: 20.6 }), {
    x: 10,
    y: 21,
    displayId: null,
  });
  assert.equal(normalizePersistedPlacement({ x: 10, y: Number.NaN }), null);
});
