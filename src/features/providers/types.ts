import type {
  GeminiKeyConfig,
  OpenAIProviderConfig,
  ProviderBrand,
  ProviderKeyConfig,
} from '@/types';

export type { ProviderBrand } from '@/types';

export interface ProviderDescriptor {
  id: ProviderBrand;
  label: string;
  description: string;
  supportsModelDiscovery: boolean;
  supportsConnectivityTest: boolean;
  supportsDisableCooling: boolean;
}

export interface ProviderResource {
  id: string;
  brand: ProviderBrand;
  originalIndex: number;
  name: string;
  identifier: string;
  apiKeyPreview: string;
  apiKey: string;
  authIndex: string;
  baseUrl: string;
  proxyUrl: string;
  prefix: string;
  models: string[];
  priority: number;
  disabled: boolean;
  disableCooling: boolean;
  headerCount: number;
  apiKeyEntryCount: number;
  raw: GeminiKeyConfig | ProviderKeyConfig | OpenAIProviderConfig;
}

export interface ProviderGroup {
  id: ProviderBrand;
  descriptor: ProviderDescriptor;
  resources: ProviderResource[];
}

export interface ProviderSnapshot {
  fetchedAt: string;
  groups: ProviderGroup[];
}
