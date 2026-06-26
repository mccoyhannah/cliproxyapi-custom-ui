/**
 * Amp CLI Integration (ampcode) configuration types.
 */

export interface AmpcodeModelMapping {
  from: string;
  to: string;
}

export interface AmpcodeUpstreamApiKeyMapping {
  upstreamApiKey: string;
  apiKeys: string[];
}

export interface AmpcodeConfig {
  upstreamUrl?: string;
  upstreamApiKey?: string;
  upstreamApiKeys?: AmpcodeUpstreamApiKeyMapping[];
  modelMappings?: AmpcodeModelMapping[];
  forceModelMappings?: boolean;
}
