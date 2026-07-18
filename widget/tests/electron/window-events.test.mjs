import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { bindWindowVisibilityRefresh } from '../../electron/windowEvents.mjs';

test('BrowserWindow show and hide events do not forward Electron event objects as tray targets', () => {
  const window = new EventEmitter();
  const calls = [];
  bindWindowVisibilityRefresh(window, (...args) => calls.push(args));

  window.emit('show', { type: 'show-event' });
  window.emit('hide', { type: 'hide-event' });

  assert.deepEqual(calls, [[], []]);
});
