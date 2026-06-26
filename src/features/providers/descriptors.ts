import type { ProviderBrand } from './types';
import type { ProviderDescriptor } from './types';

export const PROVIDER_BRAND_ORDER: ProviderBrand[] = [
  'gemini',
  'codex',
  'claude',
  'vertex',
  'openaiCompatibility',
];

export const PROVIDER_DESCRIPTORS: Record<ProviderBrand, ProviderDescriptor> = {
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    description: 'Gemini API key resources',
    supportsModelDiscovery: true,
    supportsConnectivityTest: false,
    supportsDisableCooling: true,
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    description: 'Codex Responses API resources',
    supportsModelDiscovery: true,
    supportsConnectivityTest: true,
    supportsDisableCooling: true,
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    description: 'Claude Messages API resources',
    supportsModelDiscovery: true,
    supportsConnectivityTest: false,
    supportsDisableCooling: true,
  },
  vertex: {
    id: 'vertex',
    label: 'Vertex',
    description: 'Vertex AI resources',
    supportsModelDiscovery: false,
    supportsConnectivityTest: false,
    supportsDisableCooling: false,
  },
  openaiCompatibility: {
    id: 'openaiCompatibility',
    label: 'OpenAI Compatible',
    description: 'OpenAI-compatible upstream resources',
    supportsModelDiscovery: true,
    supportsConnectivityTest: false,
    supportsDisableCooling: true,
  },
};
