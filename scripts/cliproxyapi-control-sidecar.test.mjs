import assert from 'node:assert/strict';
import {
  isCliProxyApiProcessPath,
  isLocalBackendApiBaseValue,
  isOriginAllowedValue,
  normalizeApiBase,
} from './cliproxyapi-control-sidecar.mjs';

assert.equal(normalizeApiBase('127.0.0.1:8317/v0/management'), 'http://127.0.0.1:8317');
assert.equal(normalizeApiBase('http://localhost:8317/'), 'http://localhost:8317');
assert.equal(isOriginAllowedValue('http://127.0.0.1:8317'), true);
assert.equal(isOriginAllowedValue('http://example.com:8317'), false);
assert.equal(isLocalBackendApiBaseValue('http://127.0.0.1:8317'), true);
assert.equal(isLocalBackendApiBaseValue('http://localhost:8317/v0/management'), true);
assert.equal(isLocalBackendApiBaseValue('http://127.0.0.1:9999'), false);
assert.equal(isLocalBackendApiBaseValue('http://example.com:8317'), false);
assert.equal(
  isCliProxyApiProcessPath('D:/CLIProxyAPI/cli-proxy-api.exe', 'D:\\CLIProxyAPI\\cli-proxy-api.exe'),
  true
);
assert.equal(
  isCliProxyApiProcessPath('D:\\Other\\cli-proxy-api.exe', 'D:\\CLIProxyAPI\\cli-proxy-api.exe'),
  false
);

console.log('cliproxyapi-control-sidecar tests passed');
