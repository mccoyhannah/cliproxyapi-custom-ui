import type {
  UsageRequestDetail,
  UsageRequestDetailStatus,
} from '@/types/usageStatistics';

export const emptyDetail = (
  requestId: string,
  detailStatus: UsageRequestDetailStatus,
  errorSummary: string | null = null
): UsageRequestDetail => ({
  requestId,
  detailStatus,
  configuredModel: null,
  upstreamModel: null,
  responseModel: null,
  actualModel: null,
  upstreamUrl: null,
  provider: null,
  authLabel: null,
  authId: null,
  originator: null,
  userAgent: null,
  upstreamStatusCode: null,
  finalStatusCode: null,
  errorSummary,
  loadedAt: detailStatus === 'loading' ? null : Date.now(),
});

const cleanModelValue = (value: string | undefined): string | null => {
  if (!value) return null;
  const trimmed = value.trim().replace(/^["'`]+|["'`,;}\]]+$/g, '');
  return trimmed && trimmed !== '-' && trimmed !== 'null' ? trimmed : null;
};

const extractFirstModel = (raw: string, patterns: RegExp[]): string | null => {
  for (const pattern of patterns) {
    const match = raw.match(pattern);
    const value = cleanModelValue(match?.[1]);
    if (value) return value;
  }
  return null;
};

const extractConfiguredModel = (raw: string): string | null =>
  extractFirstModel(raw, [
    /"configured[_-]?model"\s*:\s*"([^"]+)"/i,
    /"requested[_-]?model"\s*:\s*"([^"]+)"/i,
    /\b(?:configured|requested)\s+model\s*[:=]\s*([A-Za-z0-9._:/+-]+)/i,
    /"model"\s*:\s*"([^"]+)"/i,
    /\bmodel\s*[:=]\s*([A-Za-z0-9._:/+-]+)/i,
  ]);

const extractActualModel = (raw: string): string | null =>
  extractFirstModel(raw, [
    /"actual[_-]?model"\s*:\s*"([^"]+)"/i,
    /"upstream[_-]?model"\s*:\s*"([^"]+)"/i,
    /"target[_-]?model"\s*:\s*"([^"]+)"/i,
    /\b(?:actual|upstream|routed|selected|target)\s+model\s*[:=]\s*([A-Za-z0-9._:/+-]+)/i,
    /\bmapped\s+(?:to|model)\s*[:=]?\s*([A-Za-z0-9._:/+-]+)/i,
    /"model"\s*:\s*"([^"]+)"/i,
  ]);

const firstValue = <T,>(values: Array<T | null | undefined>): T | null =>
  values.find((value): value is T => value !== null && value !== undefined) ?? null;

const extractField = (raw: string, name: string): string | null => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = raw.match(new RegExp(`^${escaped}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() || null;
};

const extractStatusCode = (raw: string): number | null => {
  const value = extractField(raw, 'Status');
  if (value) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) return parsed;
  }

  const match = raw.match(/\bstatus\s*[:=]\s*([1-5]\d{2})\b/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
};

const splitLogSections = (text: string): Record<string, string> => {
  const regex = /^===\s*([^=\r\n]+?)\s*===\s*$/gm;
  const matches: Array<{ key: string; start: number; end: number }> = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    matches.push({
      key: match[1].trim().toUpperCase(),
      start: match.index,
      end: regex.lastIndex,
    });
  }

  return matches.reduce<Record<string, string>>((sections, item, index) => {
    const next = matches[index + 1];
    sections[item.key] = text.slice(item.end, next?.start ?? text.length).trim();
    return sections;
  }, {});
};

const parseAuthLine = (
  raw: string
): Pick<UsageRequestDetail, 'provider' | 'authLabel' | 'authId'> => {
  const line = extractField(raw, 'Auth');
  if (!line) {
    return { provider: null, authLabel: null, authId: null };
  }

  const pairs = Array.from(line.matchAll(/([a-z_]+)=([^,]+)/gi)).reduce<
    Record<string, string>
  >((result, match) => {
    result[match[1].toLowerCase()] = match[2].trim();
    return result;
  }, {});

  return {
    provider: pairs.provider ?? null,
    authLabel: pairs.label ?? null,
    authId: pairs.auth_id ?? null,
  };
};

const extractErrorSummary = (sections: string[]): string | null => {
  for (const section of sections) {
    const messageMatch = section.match(/"message"\s*:\s*"([^"]{1,260})"/i);
    if (messageMatch && !/success/i.test(messageMatch[1])) return messageMatch[1];

    const line = section
      .split(/\r?\n/)
      .map((item) => item.trim())
      .find((item) => {
        if (!item) return false;
        if (/"error"\s*:\s*null/i.test(item)) return false;
        return /\b(error|failed|failure|timeout|rate[-\s]?limit|unauthorized|forbidden)\b/i.test(
          item
        );
      });

    if (line) return line.slice(0, 260);
  }

  return null;
};

export const parseDetailLog = (requestId: string, text: string): UsageRequestDetail => {
  const sections = splitLogSections(text);
  const headers = sections.HEADERS ?? '';
  const requestBody = sections['REQUEST BODY'] ?? '';
  const apiRequestSections = Object.entries(sections)
    .filter(([key]) => key.startsWith('API REQUEST'))
    .map(([, value]) => value);
  const apiResponseSections = Object.entries(sections)
    .filter(([key]) => key.startsWith('API RESPONSE'))
    .map(([, value]) => value);
  const responseSection = sections.RESPONSE ?? '';
  const firstApiRequest = apiRequestSections[0] ?? '';
  const firstApiResponse = apiResponseSections[0] ?? '';

  const configuredModel = extractConfiguredModel(requestBody);
  const upstreamModel = firstValue(apiRequestSections.map((section) => extractConfiguredModel(section)));
  const responseModel = firstValue([
    ...apiResponseSections.map((section) => extractActualModel(section)),
    extractActualModel(responseSection),
  ]);
  const actualModel = responseModel ?? upstreamModel;
  const auth = parseAuthLine(firstApiRequest);
  const detailStatus: UsageRequestDetailStatus =
    configuredModel && actualModel ? 'ready' : 'missing-fields';

  return {
    requestId,
    detailStatus,
    configuredModel,
    upstreamModel,
    responseModel,
    actualModel,
    upstreamUrl: extractField(firstApiRequest, 'Upstream URL'),
    provider: auth.provider,
    authLabel: auth.authLabel,
    authId: auth.authId,
    originator: extractField(headers, 'Originator'),
    userAgent: extractField(headers, 'User-Agent'),
    upstreamStatusCode: extractStatusCode(firstApiResponse),
    finalStatusCode: extractStatusCode(responseSection),
    errorSummary: extractErrorSummary([firstApiResponse, responseSection]),
    loadedAt: Date.now(),
  };
};

export const responseDataToText = async (data: unknown): Promise<string> => {
  if (typeof data === 'string') return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder().decode(data);
  return JSON.stringify(data ?? '');
};

export const responseDataToBlob = (data: unknown): Blob => {
  if (typeof Blob !== 'undefined' && data instanceof Blob) return data;
  if (data instanceof ArrayBuffer) return new Blob([data], { type: 'text/plain' });
  if (typeof data === 'string') return new Blob([data], { type: 'text/plain' });
  return new Blob([JSON.stringify(data ?? '')], { type: 'text/plain' });
};
