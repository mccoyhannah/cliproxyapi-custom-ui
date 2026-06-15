import assert from 'node:assert/strict';
import {
  isCliProxyApiProcessPath,
  isLocalBackendApiBaseValue,
  isOriginAllowedValue,
  normalizeApiBase,
  normalizeTimeoutMs,
  resolvePwshPath,
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

assert.equal(
  resolvePwshPath({}, (candidate) =>
    ['D:\\Tools\\PowerShell\\7\\pwsh.exe', 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'].includes(
      candidate
    )
  ),
  'D:\\Tools\\PowerShell\\7\\pwsh.exe'
);
assert.equal(
  resolvePwshPath(
    { ProgramFiles: 'C:\\Program Files', WINDIR: 'C:\\Windows' },
    (candidate) =>
      candidate === 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' ||
      candidate === 'D:\\Tools\\PowerShell\\7\\pwsh.exe'
  ),
  'D:\\Tools\\PowerShell\\7\\pwsh.exe'
);
assert.equal(
  resolvePwshPath(
    { ProgramFiles: 'D:\\Program Files', WINDIR: 'C:\\Windows' },
    (candidate) => candidate === 'D:\\Program Files\\PowerShell\\7\\pwsh.exe'
  ),
  'D:\\Program Files\\PowerShell\\7\\pwsh.exe'
);
assert.equal(
  resolvePwshPath(
    { ProgramFiles: 'D:\\Missing', WINDIR: 'C:\\Windows' },
    (candidate) => candidate === 'D:\\Tools\\PowerShell\\7\\pwsh.exe'
  ),
  'D:\\Tools\\PowerShell\\7\\pwsh.exe'
);
assert.equal(
  resolvePwshPath(
    { ProgramFiles: 'D:\\Missing', WINDIR: 'C:\\Windows' },
    (candidate) => candidate === 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  ),
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
);
assert.equal(resolvePwshPath({ ProgramFiles: 'D:\\Missing', WINDIR: 'C:\\Missing' }, () => false), 'pwsh.exe');

assert.equal(normalizeTimeoutMs(undefined, 75_000, 5_000, 180_000), 75_000);
assert.equal(normalizeTimeoutMs('not-a-number', 75_000, 5_000, 180_000), 75_000);
assert.equal(normalizeTimeoutMs(Number.POSITIVE_INFINITY, 75_000, 5_000, 180_000), 75_000);
assert.equal(normalizeTimeoutMs('1000', 75_000, 5_000, 180_000), 5_000);
assert.equal(normalizeTimeoutMs('120000', 75_000, 5_000, 180_000), 120_000);
assert.equal(normalizeTimeoutMs('300000', 75_000, 5_000, 180_000), 180_000);

console.log('cliproxyapi-control-sidecar tests passed');
