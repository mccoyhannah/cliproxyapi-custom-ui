export type AuthFileStatusCategory =
  | 'credential_invalid'
  | 'account_model_restricted'
  | 'upstream_access_blocked'
  | 'local_proxy_unavailable'
  | 'dns_resolution_failed'
  | 'tls_certificate_error'
  | 'oauth_flow_failure'
  | 'connection_transient'
  | 'request_interrupted'
  | 'input_too_large'
  | 'content_policy'
  | 'rate_limited'
  | 'invalid_request'
  | 'upstream_service_error'
  | 'unknown_upstream_error';

type StatusPattern = {
  category: Exclude<AuthFileStatusCategory, 'unknown_upstream_error'>;
  pattern: RegExp;
  signalOnlyPattern: RegExp;
};

const HEALTHY_STATUS_PATTERN = /^(?:ok|healthy|ready|success|available)$/i;
const UPSTREAM_ACCESS_BLOCKED_PATTERN =
  /\b(?:cloudflare(?:\s+security)?\s+(?:challenge|verification|captcha|blocked)|cf[_\s-]?mitigated\s*:\s*challenge|cf_chl|__cf_chl_tk|challenge-platform|captcha|turnstile|challenge[_\s-]?(?:required|page)|attention\s+required|checking\s+your\s+browser|error\s*1020|unsupported[_\s-]?(?:country|region)|region[_\s-]?not[_\s-]?supported|ip\s+(?:blocked|banned))\b/i;
const GENERIC_UPSTREAM_ACCESS_BLOCKED_PATTERN =
  /\b(?:forbidden|access[_\s-]?denied)\b/i;
const CONTENT_POLICY_PATTERN =
  /\b(?:content[_\s-]?conceal(?:ed)?|content[_\s-]?(?:filter|policy)|safety[_\s-]?(?:policy|filter)|(?:blocked|rejected|concealed)\s+(?:by|under)\s+(?:the\s+)?(?:upstream\s+)?safety)\b/i;

const STATUS_PATTERNS: StatusPattern[] = [
  {
    category: 'input_too_large',
    pattern:
      /\b(?:context_too_large|context\s+window|input\s+too\s+large|request\s+entity\s+too\s+large|payload\s+too\s+large|exceeds?\s+(?:the\s+)?context)\b/i,
    signalOnlyPattern: /^(?:413|context_too_large|input_too_large)$/i,
  },
  {
    category: 'account_model_restricted',
    pattern:
      /(?:\bunsupported[_\s-]?model\b|\bmodel[_\s-]?not[_\s-]?(?:found|supported|allowed)\b|\bmodel[^\n]{0,120}\b(?:not\s+supported|unsupported|not\s+allowed)\b|\bmodel[^\n]{0,120}\bnot\s+available\s+(?:for|to)\s+(?:this|your|the)?\s*(?:account|plan)\b|\bdoes\s+not\s+have\s+access\s+to(?:\s+the)?\s+model\b|\bnot\s+supported\s+when\s+using\s+codex\s+with\s+a\s+chatgpt\s+account\b|\baccount(?:\s+type|\s+plan)?[^\n]{0,96}\b(?:not\s+supported|not\s+eligible)\b)/i,
    signalOnlyPattern: /^(?:404|model_not_found|unsupported_model|model_not_supported)$/i,
  },
  {
    category: 'upstream_access_blocked',
    pattern: UPSTREAM_ACCESS_BLOCKED_PATTERN,
    signalOnlyPattern: /^(?:403|423|451|forbidden|access_denied|cloudflare_challenge)$/i,
  },
  {
    category: 'local_proxy_unavailable',
    pattern:
      /\b(?:local_proxy_unavailable|proxy\s+authentication\s+required|proxyconnect|delayed\s+connect\s+error|127\.0\.0\.1:\d+[^\n]*(?:refused|connectex|proxyconnect|actively\s+refused)|localhost:\d+[^\n]*(?:refused|connectex|proxyconnect|actively\s+refused))\b/i,
    signalOnlyPattern: /^(?:407|local_proxy_unavailable|proxyconnect|connectex)$/i,
  },
  {
    category: 'dns_resolution_failed',
    pattern:
      /\b(?:ENOTFOUND|EAI_AGAIN|getaddrinfo|no\s+such\s+host|temporary\s+failure\s+in\s+name\s+resolution|dns(?:\s+lookup|\s+resolution)?\s+(?:failed|error))\b/i,
    signalOnlyPattern: /^(?:ENOTFOUND|EAI_AGAIN|getaddrinfo)$/i,
  },
  {
    category: 'tls_certificate_error',
    pattern:
      /\b(?:x509:|ERR_(?:TLS|SSL|CERT)[A-Z0-9_]*|CERT_[A-Z0-9_]+|TLS(?::\s*|\s+)(?:handshake\s+)?(?:failed|failure|error|timeout)|certificate\s+(?:verification\s+failed|signed\s+by\s+unknown\s+authority|has\s+expired)|self[- ]signed\s+certificate|unable\s+to\s+verify\s+the\s+first\s+certificate)\b/i,
    signalOnlyPattern: /^(?:tls_error|certificate_error|x509_error)$/i,
  },
  {
    category: 'oauth_flow_failure',
    pattern:
      /\b(?:authentication\s+timed\s+out|oauth[_\s-]?(?:flow|callback|login)[^\n]{0,64}(?:authentication\s+)?(?:failed|failure|timeout|timed\s+out)|authorization[_\s-]?code[^\n]{0,64}(?:exchange|failed|invalid)|code[_\s-]?exchange[_\s-]?failed)\b/i,
    signalOnlyPattern: /^(?:oauth_flow_failure|oauth_timeout|code_exchange_failed)$/i,
  },
  {
    category: 'content_policy',
    pattern: CONTENT_POLICY_PATTERN,
    signalOnlyPattern: /^(?:content_filter|content_policy|safety_policy|safety_filter)$/i,
  },
  {
    category: 'rate_limited',
    pattern:
      /\b(?:rate[_\s-]?limit(?:ed)?|too[_\s-]?many[_\s-]?requests|insufficient[_\s-]?quota|quota[_\s-]?exceeded)\b/i,
    signalOnlyPattern: /^(?:402|429|rate_limited|quota_exceeded|insufficient_quota)$/i,
  },
  {
    category: 'request_interrupted',
    pattern:
      /\b(?:request_interrupted|context\s+cancell?ed|context\s+deadline\s+exceeded|stream\s+error:?[^\n]*(?:internal_error|received\s+from\s+peer)|internal_error;\s*received\s+from\s+peer)\b/i,
    signalOnlyPattern: /^(?:408|request_interrupted|context_canceled|context_cancelled)$/i,
  },
  {
    category: 'connection_transient',
    pattern:
      /\b(?:connection_transient|network_transient|unexpected\s+EOF|EOF|ECONNRESET|ETIMEDOUT|socket\s+hang\s+up|fetch\s+failed|connectex|connection\s+(?:was\s+)?(?:refused|reset|aborted)|connection\s+reset\s+by\s+peer|target\s+machine\s+actively\s+refused|wsa(?:recv|send)[^\n]*(?:forcibly\s+closed|reset|aborted)|forcibly\s+closed\s+by\s+the\s+remote\s+host|aborted\s+by\s+(?:the\s+)?software|connection\s+timed\s+out)\b/i,
    signalOnlyPattern: /^(?:connection_transient|network_transient|EOF|ECONNRESET|ETIMEDOUT)$/i,
  },
  {
    category: 'invalid_request',
    pattern:
      /\b(?:invalid[_\s-]?request(?:[_\s-]?error)?|bad\s+request|not\s+found|method\s+not\s+allowed|unsupported\s+media\s+type|unprocessable\s+entity|unsupported[_\s-]?(?:endpoint|operation|method))\b/i,
    signalOnlyPattern:
      /^(?:400|404|405|409|415|422|invalid_request|invalid_request_error|bad_request)$/i,
  },
  {
    category: 'upstream_service_error',
    pattern:
      /\b(?:upstream_service_error|status[:\s]+5\d\d|http[:\s]+5\d\d|code[:\s]+5\d\d|server\s+error|service\s+unavailable|temporarily\s+unavailable|bad\s+gateway|gateway\s+timeout)\b/i,
    signalOnlyPattern: /^(?:5\d\d|upstream_service_error|server_error)$/i,
  },
  {
    category: 'credential_invalid',
    pattern:
      /\b(?:unauthorized|unauthenticated|authentication_error|invalid[_\s-]?(?:grant|token|api[_\s-]?key)|incorrect[_\s-]?api[_\s-]?key|refresh[_\s-]?token[_\s-]?(?:reused|invalidated|invalid|expired)|invalid[_\s-]?refresh[_\s-]?token|token[_\s-]?expired|invalid(?:ated)?\s+(?:oauth\s+)?token|oauth\s+token\s+invalidated|token\s+(?:is\s+)?(?:invalid|expired|revoked)|credentials?\s+(?:are\s+)?(?:invalid|expired|revoked|rejected)|(?:rejected|refused)\s+(?:this\s+)?credentials?)\b/i,
    signalOnlyPattern:
      /^(?:401|invalid_grant|invalid_token|authentication_error|auth_unavailable|refresh_token_reused|invalid_refresh_token|refresh_token_invalidated|token_expired)$/i,
  },
  {
    category: 'upstream_access_blocked',
    pattern: GENERIC_UPSTREAM_ACCESS_BLOCKED_PATTERN,
    signalOnlyPattern: /^(?:403|423|451|forbidden|access_denied)$/i,
  },
];

const classifyStatusCode = (statusCode: unknown): AuthFileStatusCategory | null => {
  const status = Number(statusCode);
  if (!Number.isFinite(status)) return null;
  if (status === 401) return 'credential_invalid';
  if (status === 402 || status === 429) return 'rate_limited';
  if (status === 403 || status === 423 || status === 451) return 'upstream_access_blocked';
  if (status === 407) return 'local_proxy_unavailable';
  if (status === 408) return 'request_interrupted';
  if (status === 413) return 'input_too_large';
  if ([400, 404, 405, 409, 415, 422].includes(status)) return 'invalid_request';
  if (status >= 400 && status <= 499) return 'invalid_request';
  if (status >= 500 && status <= 599) return 'upstream_service_error';
  if (status >= 400) return 'unknown_upstream_error';
  return null;
};

export const classifyAuthFileStatusCategory = (
  text: unknown,
  statusCode?: unknown
): AuthFileStatusCategory | null => {
  const haystack = String(text ?? '').trim();
  const explicitStatusCategory = classifyStatusCode(statusCode);
  if (haystack && HEALTHY_STATUS_PATTERN.test(haystack) && explicitStatusCategory === null) {
    return null;
  }
  if (haystack) {
    const matched = STATUS_PATTERNS.find(({ pattern }) => pattern.test(haystack));
    if (matched) return matched.category;
  }

  const standaloneStatus = haystack.match(
    /^(?:(?:http(?:\/\d(?:\.\d)?)?|status(?:\s+code)?|code)\s*[:=]?\s*)?([45]\d{2})$/i
  )?.[1];
  const inlineStatus = haystack.match(
    /\b(?:http(?:\/\d(?:\.\d)?)?|status(?:\s+code)?|code)\s*[:=]?\s*([45]\d{2})\b/i
  )?.[1];
  const statusCategory =
    explicitStatusCategory ?? classifyStatusCode(standaloneStatus ?? inlineStatus);
  if (statusCategory) return statusCategory;
  return haystack ? 'unknown_upstream_error' : null;
};

export const isAuthFileStatusSignalOnly = (
  category: AuthFileStatusCategory,
  value: string
): boolean => {
  if (category === 'unknown_upstream_error') return false;
  return STATUS_PATTERNS.filter((entry) => entry.category === category).some((entry) =>
    entry.signalOnlyPattern.test(value.trim())
  );
};

export const shouldShowAuthFileCardHeaderStatusBadge = (
  category: AuthFileStatusCategory | null | undefined
): boolean => category === 'credential_invalid';
