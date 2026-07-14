import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { classifyUpstreamStatusText } from './priority-rotation-sidecar.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const classifierPath = path.join(
  repoRoot,
  'src',
  'features',
  'authFiles',
  'statusClassification.ts'
);
const classifierSource = await fs.readFile(classifierPath, 'utf8');
const transpiled = ts.transpileModule(classifierSource, {
  compilerOptions: {
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText;
const classifier = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`
);

const categoryLocaleKeys = {
  credential_invalid: [
    'credential_invalid_badge',
    'credential_invalid_badge_title',
  ],
  account_model_restricted: [
    'status_account_model_restricted_badge',
    'status_account_model_restricted_title',
  ],
  upstream_access_blocked: [
    'status_upstream_access_blocked_badge',
    'status_upstream_access_blocked_title',
  ],
  local_proxy_unavailable: [
    'status_local_proxy_unavailable_badge',
    'status_local_proxy_unavailable_title',
  ],
  dns_resolution_failed: [
    'status_dns_resolution_failed_badge',
    'status_dns_resolution_failed_title',
  ],
  tls_certificate_error: [
    'status_tls_certificate_error_badge',
    'status_tls_certificate_error_title',
  ],
  oauth_flow_failure: [
    'status_oauth_flow_failure_badge',
    'status_oauth_flow_failure_title',
  ],
  connection_transient: [
    'status_connection_transient_badge',
    'status_connection_transient_title',
  ],
  request_interrupted: [
    'status_request_interrupted_badge',
    'status_request_interrupted_title',
  ],
  input_too_large: [
    'status_input_too_large_badge',
    'status_input_too_large_title',
  ],
  content_policy: [
    'status_content_policy_badge',
    'status_content_policy_title',
  ],
  rate_limited: [
    'status_rate_limited_badge',
    'status_rate_limited_title',
  ],
  invalid_request: [
    'status_invalid_request_badge',
    'status_invalid_request_title',
  ],
  upstream_service_error: [
    'status_upstream_service_error_badge',
    'status_upstream_service_error_title',
  ],
  unknown_upstream_error: [
    'status_unknown_upstream_error_badge',
    'status_unknown_upstream_error_title',
  ],
};

const cases = [
  ['cloudflare challenge', 'upstream_access_blocked'],
  ['403 cloudflare challenge', 'upstream_access_blocked'],
  ['403 cloudflare challenge invalid_token', 'upstream_access_blocked'],
  ['403 Forbidden invalid_token', 'credential_invalid'],
  ['cloudflare challenge safety check invalid_token', 'upstream_access_blocked'],
  ['server: cloudflare\nstatus: 524', 'upstream_service_error'],
  ['cf-ray: abc123\n503 service unavailable', 'upstream_service_error'],
  [
    "The 'gpt-5.6-sol' model is not supported when using Codex with a ChatGPT account.",
    'account_model_restricted',
  ],
  ['model not supported for this account; safety policy metadata attached', 'account_model_restricted'],
  ['404 model_not_found', 'account_model_restricted'],
  ['403 invalid_token', 'credential_invalid'],
  ['refresh_token_reused', 'credential_invalid'],
  ['invalid_refresh_token', 'credential_invalid'],
  ['refresh_token_invalidated', 'credential_invalid'],
  ['token_expired', 'credential_invalid'],
  [
    'proxyconnect tcp: dial tcp 127.0.0.1:33210: connectex: target machine actively refused it',
    'local_proxy_unavailable',
  ],
  ['proxyconnect tcp 127.0.0.1:413: connection refused', 'local_proxy_unavailable'],
  ['proxyconnect tcp 127.0.0.1:33210: connection refused; context deadline exceeded', 'local_proxy_unavailable'],
  ['407 Proxy Authentication Required', 'local_proxy_unavailable'],
  ['Authentication timed out', 'oauth_flow_failure'],
  ['Authentication timed out: context deadline exceeded', 'oauth_flow_failure'],
  ['OAuth login authentication failed', 'oauth_flow_failure'],
  ['lookup chatgpt.com: no such host', 'dns_resolution_failed'],
  ['lookup chatgpt.com: no such host; context deadline exceeded', 'dns_resolution_failed'],
  ['TLS handshake timeout', 'tls_certificate_error'],
  ['remote error: tls: handshake failure', 'tls_certificate_error'],
  ['code_exchange_failed: TLS handshake timeout', 'tls_certificate_error'],
  ['TLS handshake timeout: context deadline exceeded', 'tls_certificate_error'],
  ['authentication failed: TLS handshake timeout', 'tls_certificate_error'],
  ['x509: certificate signed by unknown authority', 'tls_certificate_error'],
  ['context canceled', 'request_interrupted'],
  ['authentication failed: context deadline exceeded', 'request_interrupted'],
  ['authentication_error: context deadline exceeded', 'request_interrupted'],
  ['Post "https://example": EOF', 'connection_transient'],
  ['authentication failed: EOF', 'connection_transient'],
  ['authentication_error: EOF', 'connection_transient'],
  ['authentication error: connection timed out', 'connection_transient'],
  ['dial tcp 104.18.1.1:443: connection refused', 'connection_transient'],
  ['connection reset by peer', 'connection_transient'],
  ['wsasend: An established connection was aborted by the software in your host machine', 'connection_transient'],
  ['authentication failed', 'unknown_upstream_error'],
  ['invalid_request_error context_too_large', 'input_too_large'],
  ['413 Request Entity Too Large', 'input_too_large'],
  ['content concealed by upstream safety policy', 'content_policy'],
  ['forbidden by content policy', 'content_policy'],
  ['provider safety note without an actual policy rejection', 'unknown_upstream_error'],
  ['quota_exceeded', 'rate_limited'],
  ['access denied: quota exceeded', 'rate_limited'],
  ['400 invalid request payload', 'invalid_request'],
  ['forbidden: invalid request payload', 'invalid_request'],
  ['503 service unavailable', 'upstream_service_error'],
  ['authentication_error: service unavailable', 'upstream_service_error'],
  ['model gpt-5 is temporarily unavailable', 'upstream_service_error'],
  ['authentication_error', 'credential_invalid'],
  ['provider returned an unfamiliar failure', 'unknown_upstream_error'],
];

assert.deepEqual(
  [...new Set(cases.map(([, category]) => category))].sort(),
  Object.keys(categoryLocaleKeys).sort(),
  'The regression corpus must exercise every user-visible status category.'
);

for (const [message, expected] of cases) {
  assert.equal(
    classifier.classifyAuthFileStatusCategory(message),
    expected,
    `frontend classifier: ${message}`
  );
  assert.equal(classifyUpstreamStatusText(message), expected, `sidecar classifier: ${message}`);
}

assert.equal(classifier.classifyAuthFileStatusCategory(''), null);
assert.equal(classifyUpstreamStatusText(''), null);
assert.equal(classifier.classifyAuthFileStatusCategory('ok'), null);
assert.equal(classifyUpstreamStatusText('ok'), null);
assert.equal(classifier.classifyAuthFileStatusCategory('healthy'), null);
assert.equal(classifyUpstreamStatusText('healthy'), null);
assert.equal(classifier.classifyAuthFileStatusCategory('', 403), 'upstream_access_blocked');
assert.equal(classifyUpstreamStatusText('', 403), 'upstream_access_blocked');
assert.equal(classifier.classifyAuthFileStatusCategory('', 401), 'credential_invalid');
assert.equal(classifyUpstreamStatusText('', 401), 'credential_invalid');
assert.equal(
  classifier.classifyAuthFileStatusCategory('cloudflare challenge', 500),
  'upstream_access_blocked'
);
assert.equal(classifyUpstreamStatusText('cloudflare challenge', 500), 'upstream_access_blocked');
assert.equal(
  classifier.classifyAuthFileStatusCategory(
    "The model is not supported when using Codex with a ChatGPT account.",
    500
  ),
  'account_model_restricted'
);
assert.equal(
  classifyUpstreamStatusText(
    "The model is not supported when using Codex with a ChatGPT account.",
    500
  ),
  'account_model_restricted'
);
assert.equal(
  classifier.classifyAuthFileStatusCategory('provider returned an unfamiliar failure', 500),
  'upstream_service_error'
);
assert.equal(
  classifyUpstreamStatusText('provider returned an unfamiliar failure', 500),
  'upstream_service_error'
);
assert.equal(classifier.classifyAuthFileStatusCategory('', 502), 'upstream_service_error');
assert.equal(classifyUpstreamStatusText('', 502), 'upstream_service_error');
assert.equal(classifier.classifyAuthFileStatusCategory('', 418), 'invalid_request');
assert.equal(classifyUpstreamStatusText('', 418), 'invalid_request');
assert.equal(classifier.isAuthFileStatusSignalOnly('credential_invalid', '401'), true);
assert.equal(classifier.isAuthFileStatusSignalOnly('upstream_access_blocked', '403'), true);
assert.equal(classifier.isAuthFileStatusSignalOnly('account_model_restricted', '404'), true);
assert.equal(
  classifier.isAuthFileStatusSignalOnly('upstream_access_blocked', 'cloudflare challenge'),
  false
);
assert.equal(
  classifier.isAuthFileStatusSignalOnly('unknown_upstream_error', 'unfamiliar failure'),
  false
);

assert.equal(
  classifier.shouldShowAuthFileCardHeaderStatusBadge('credential_invalid'),
  true,
  'An invalid credential must remain visible as a serious card-header alert.'
);
for (const category of Object.keys(categoryLocaleKeys).filter(
  (value) => value !== 'credential_invalid'
)) {
  assert.equal(
    classifier.shouldShowAuthFileCardHeaderStatusBadge(category),
    false,
    `${category} must stay in status-dot details instead of adding a card-header badge.`
  );
}

const [
  authFileCardSource,
  quotaTypeSource,
  authFileConstantsSource,
  quotaConfigsSource,
  quotaCardSource,
  priorityRotationSidecarApiSource,
  ...localeSources
] = await Promise.all([
  fs.readFile(
    path.join(repoRoot, 'src', 'features', 'authFiles', 'components', 'AuthFileCard.tsx'),
    'utf8'
  ),
  fs.readFile(path.join(repoRoot, 'src', 'types', 'quota.ts'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'src', 'features', 'authFiles', 'constants.ts'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'src', 'components', 'quota', 'quotaConfigs.ts'), 'utf8'),
  fs.readFile(path.join(repoRoot, 'src', 'components', 'quota', 'QuotaCard.tsx'), 'utf8'),
  fs.readFile(
    path.join(repoRoot, 'src', 'services', 'api', 'priorityRotationSidecar.ts'),
    'utf8'
  ),
  ...['zh-CN', 'zh-TW', 'en', 'ru'].map((locale) =>
    fs.readFile(path.join(repoRoot, 'src', 'i18n', 'locales', `${locale}.json`), 'utf8')
  ),
]);

const statusCollectorSource = authFileConstantsSource.match(
  /const AUTH_FILE_STATUS_PARSE_DEPTH[\s\S]*?(?=export const getAuthFileStatusProblemFromText)/
)?.[0];
assert.ok(statusCollectorSource, 'The structured status-message collector must remain testable.');
const collectorModuleSource = statusCollectorSource.replace(
  'const collectAuthFileStatusParts =',
  'export const collectAuthFileStatusParts ='
);
const collectorModule = await import(
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(collectorModuleSource, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText
  ).toString('base64')}`
);
const tokenSafeParts = [];
collectorModule.collectAuthFileStatusParts(
  '{"error":"invalid_token","refresh_token":"rt-secret-abcdef123456"}',
  tokenSafeParts
);
assert.deepEqual(
  tokenSafeParts,
  ['invalid_token'],
  'Opaque credential fields in structured status JSON must never become tooltip text.'
);
const nestedSafeParts = [];
collectorModule.collectAuthFileStatusParts(
  '{"response":{"error":{"message":"cloudflare challenge"}},"secret":"opaque-secret"}',
  nestedSafeParts
);
assert.deepEqual(
  nestedSafeParts,
  ['cloudflare challenge'],
  'Nested error messages must remain observable while adjacent secrets stay hidden.'
);
assert.equal(
  collectorModule.getAuthFileStatusMessage({
    status_message: '{"refresh_token":"rt-secret-abcdef123456"}',
  }),
  '',
  'Structured status JSON that contains only sensitive fields must never fall back to raw text.'
);
assert.equal(
  collectorModule.getAuthFileStatusMessage({
    status_message: '{"error":"invalid_token","refresh_token":"rt-secret-abcdef123456"}',
  }),
  'invalid_token',
  'A safe error signal must remain visible when adjacent structured fields are sensitive.'
);

assert.match(
  authFileCardSource,
  /const hasVisibleStatusWarning\s*=\s*showAuthFileStatusHeaderBadge\s*\|\|\s*showQuotaStatusHeaderBadge;/,
  'Only serious status categories that qualify for a header badge may tint the card controls.'
);
assert.match(
  authFileCardSource,
  /const cardToneClass\s*=\s*\[[\s\S]*?showQuotaStatusHeaderBadge\s*\?\s*styles\.fileCardQuotaError\s*:\s*''/,
  'A quota-error card tone must be limited to a visible credential-invalid alert.'
);
assert.match(
  authFileCardSource,
  /file\.disabled[\s\S]*?hasVisibleStatusWarning[\s\S]*?styles\.statusToggleWarning/,
  'The enabled toggle may use its warning tone only through the serious-alert gate.'
);

assert.match(
  authFileConstantsSource,
  /status === 404 && category === 'invalid_request'/,
  'A model/account 404 must keep its real message instead of being rewritten as a CPA version issue.'
);
assert.match(
  quotaConfigsSource,
  /const errorKind = classifyAuthFileStatusCategory\(message, status\)/,
  'Frontend Codex quota failures must retain their error category for rotation safety.'
);
assert.match(
  quotaConfigsSource,
  /retryable:\s*errorKind !== 'credential_invalid'/,
  'Frontend Codex quota failures must protect every non-credential category from demotion.'
);
assert.match(
  quotaCardSource,
  /status === 403 && category === 'credential_invalid'/,
  'The general quota page must not describe every 403 as a credential failure.'
);
assert.match(
  priorityRotationSidecarApiSource,
  /quotaErrorKind\?:\s*CodexQuotaState\['errorKind'\]\s*\|\s*null/,
  'The sidecar API type must expose the classified error kind returned at runtime.'
);
assert.match(
  priorityRotationSidecarApiSource,
  /quotaRetryable\?:\s*boolean/,
  'The sidecar API type must expose whether a global failure is protected from demotion.'
);

for (const [category, localeKeys] of Object.entries(categoryLocaleKeys)) {
  const uiMapOccurrences = authFileCardSource.match(
    new RegExp(`\\b${category}:`, 'g')
  )?.length ?? 0;
  assert.ok(
    uiMapOccurrences >= 3,
    `${category} must define a badge label, explanatory title, and visibility TTL.`
  );
  assert.match(
    quotaTypeSource,
    new RegExp(`\\|\\s*'${category}'`),
    `${category} must be accepted by CodexQuotaState.errorKind.`
  );

  for (const [index, source] of localeSources.entries()) {
    const locale = ['zh-CN', 'zh-TW', 'en', 'ru'][index];
    const parsed = JSON.parse(source);
    for (const key of localeKeys) {
      assert.equal(
        typeof parsed.auth_files?.[key],
        'string',
        `${locale} must define auth_files.${key}.`
      );
      assert.ok(parsed.auth_files[key].trim(), `${locale} auth_files.${key} must not be empty.`);
    }
  }
}

const scannerSource = await fs.readFile(
  path.join(repoRoot, 'scripts', 'scan-response-errors.mjs'),
  'utf8'
);
assert.match(
  scannerSource,
  /const showSignals = args\['show-signals'\] === true/,
  'Unknown log samples must stay hidden unless diagnostic signal output is explicitly requested.'
);
assert.match(
  scannerSource,
  /showSignals \? signals\.slice\(0, 3\)\.map\(redactDiagnosticSignal\) : \[\]/,
  'Explicit diagnostic samples must be redacted before printing.'
);

const apiCallSource = await fs.readFile(
  path.join(repoRoot, 'src', 'services', 'api', 'apiCall.ts'),
  'utf8'
);
const apiCallErrorSource = apiCallSource.match(
  /export const redactApiCallErrorText[\s\S]*?(?=export const apiCallApi)/
)?.[0];
assert.ok(apiCallErrorSource, 'The API-call error sanitizer must remain independently testable.');
const apiCallErrors = await import(
  `data:text/javascript;base64,${Buffer.from(
    ts.transpileModule(apiCallErrorSource, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText
  ).toString('base64')}`
);
assert.equal(
  apiCallErrors.getApiCallErrorMessage({
    statusCode: 403,
    header: {},
    bodyText: '{"refresh_token":"rt-secret-abcdef123456"}',
    body: { refresh_token: 'rt-secret-abcdef123456' },
  }),
  'HTTP 403',
  'Structured bodies without a safe error message must fail closed instead of echoing raw JSON.'
);
assert.equal(
  apiCallErrors.getApiCallErrorMessage({
    statusCode: 502,
    header: {},
    bodyText: '<html>opaque-cookie-value-and-private-key</html>',
    body: '<html>opaque-cookie-value-and-private-key</html>',
  }),
  'HTTP 502',
  'Unstructured plain-text or HTML bodies must fail closed instead of being shown in the UI.'
);
const sanitizedApiError = apiCallErrors.getApiCallErrorMessage({
  statusCode: 500,
  header: {},
  bodyText: '',
  body: {
    error: {
      message: 'authentication_error: EOF refresh_token=rt-secret-abcdef123456',
    },
  },
});
assert.match(sanitizedApiError, /\[redacted\]/);
assert.doesNotMatch(sanitizedApiError, /rt-secret-abcdef123456/);

const { scanResponseLog } = await import('./scan-response-errors.mjs');
const scanFixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cpamc-response-error-scan-'));
try {
  const scanFixturePath = path.join(scanFixtureDir, 'v1-responses-test.log');
  await fs.writeFile(
    scanFixturePath,
    [
      '=== REQUEST BODY ===',
      'Status: 418',
      'Error: user text must never be classified',
      '=== API REQUEST 1 ===',
      'Error: request payload line must stay private',
      '=== API RESPONSE 1 ===',
      'Status: 503',
      'Error: EOF',
      '=== RESPONSE ===',
      'event: response.failed',
      'data: {"error":"private response body"}',
    ].join('\n'),
    'utf8'
  );
  const scanned = await scanResponseLog(scanFixturePath);
  assert.equal(scanned.statusCode, 503);
  assert.deepEqual(scanned.errors, ['EOF']);
  assert.deepEqual(scanned.events, ['response.failed']);
} finally {
  await fs.rm(scanFixtureDir, { recursive: true, force: true });
}

console.log('auth status classification cases passed');
