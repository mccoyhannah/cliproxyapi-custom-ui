import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { providersApi } from '@/services/api';
import type {
  GeminiKeyConfig,
  OpenAIProviderConfig,
  ProviderKeyConfig,
} from '@/types';
import {
  claudeToResource,
  codexToResource,
  geminiToResource,
  openaiToResource,
  vertexToResource,
} from './adapters';
import { PROVIDER_BRAND_ORDER, PROVIDER_DESCRIPTORS } from './descriptors';
import type { ProviderGroup, ProviderResource, ProviderSnapshot } from './types';

interface ProviderLists {
  gemini: GeminiKeyConfig[];
  codex: ProviderKeyConfig[];
  claude: ProviderKeyConfig[];
  vertex: ProviderKeyConfig[];
  openaiCompatibility: OpenAIProviderConfig[];
}

export interface UseProviderWorkbenchResult {
  snapshot: ProviderSnapshot | null;
  isPending: boolean;
  isFetching: boolean;
  errorMessage: string;
  refetch: () => Promise<void>;
  setDisableCooling: (resource: ProviderResource, value: boolean) => Promise<void>;
  mutatingResourceId: string;
}

const emptyLists = (): ProviderLists => ({
  gemini: [],
  codex: [],
  claude: [],
  vertex: [],
  openaiCompatibility: [],
});

const getErrorMessage = (err: unknown): string => {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  return 'Request failed';
};

export function useProviderWorkbench(): UseProviderWorkbenchResult {
  const [lists, setLists] = useState<ProviderLists>(() => emptyLists());
  const [fetchedAt, setFetchedAt] = useState(() => new Date().toISOString());
  const [isPending, setIsPending] = useState(true);
  const [isFetching, setIsFetching] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [mutatingResourceId, setMutatingResourceId] = useState('');
  const hasLoadedRef = useRef(false);

  const refetch = useCallback(async () => {
    setIsFetching(true);
    setErrorMessage('');
    try {
      const [gemini, codex, claude, vertex, openaiCompatibility] = await Promise.all([
        providersApi.getGeminiKeys(),
        providersApi.getCodexConfigs(),
        providersApi.getClaudeConfigs(),
        providersApi.getVertexConfigs(),
        providersApi.getOpenAIProviders(),
      ]);
      setLists({ gemini, codex, claude, vertex, openaiCompatibility });
      setFetchedAt(new Date().toISOString());
    } catch (err) {
      setErrorMessage(getErrorMessage(err));
    } finally {
      setIsPending(false);
      setIsFetching(false);
    }
  }, []);

  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    void refetch();
  }, [refetch]);

  const snapshot = useMemo<ProviderSnapshot>(() => {
    const groups: ProviderGroup[] = PROVIDER_BRAND_ORDER.map((brand) => {
      let resources: ProviderResource[] = [];
      if (brand === 'gemini') {
        resources = lists.gemini.map((config, index) => geminiToResource(config, index));
      } else if (brand === 'codex') {
        resources = lists.codex.map((config, index) => codexToResource(config, index));
      } else if (brand === 'claude') {
        resources = lists.claude.map((config, index) => claudeToResource(config, index));
      } else if (brand === 'vertex') {
        resources = lists.vertex.map((config, index) => vertexToResource(config, index));
      } else {
        resources = lists.openaiCompatibility.map((config, index) =>
          openaiToResource(config, index)
        );
      }
      return {
        id: brand,
        descriptor: PROVIDER_DESCRIPTORS[brand],
        resources,
      };
    });
    return { fetchedAt, groups };
  }, [fetchedAt, lists]);

  const setDisableCooling = useCallback(
    async (resource: ProviderResource, value: boolean) => {
      if (resource.brand === 'vertex') return;
      setMutatingResourceId(resource.id);
      try {
        if (resource.brand === 'gemini') {
          const current = lists.gemini[resource.originalIndex];
          if (!current) return;
          await providersApi.updateGeminiKey(resource.originalIndex, {
            ...current,
            disableCooling: value,
          });
          setLists((prev) => {
            const next = [...prev.gemini];
            next[resource.originalIndex] = { ...current, disableCooling: value };
            return { ...prev, gemini: next };
          });
        } else if (resource.brand === 'codex') {
          const current = lists.codex[resource.originalIndex];
          if (!current) return;
          await providersApi.updateCodexConfig(resource.originalIndex, {
            ...current,
            disableCooling: value,
          });
          setLists((prev) => {
            const next = [...prev.codex];
            next[resource.originalIndex] = { ...current, disableCooling: value };
            return { ...prev, codex: next };
          });
        } else if (resource.brand === 'claude') {
          const current = lists.claude[resource.originalIndex];
          if (!current) return;
          await providersApi.updateClaudeConfig(resource.originalIndex, {
            ...current,
            disableCooling: value,
          });
          setLists((prev) => {
            const next = [...prev.claude];
            next[resource.originalIndex] = { ...current, disableCooling: value };
            return { ...prev, claude: next };
          });
        } else if (resource.brand === 'openaiCompatibility') {
          const current = lists.openaiCompatibility[resource.originalIndex];
          if (!current) return;
          await providersApi.updateOpenAIProvider(resource.originalIndex, {
            ...current,
            disableCooling: value,
          });
          setLists((prev) => {
            const next = [...prev.openaiCompatibility];
            next[resource.originalIndex] = { ...current, disableCooling: value };
            return { ...prev, openaiCompatibility: next };
          });
        }
      } finally {
        setMutatingResourceId('');
      }
    },
    [lists]
  );

  return {
    snapshot,
    isPending,
    isFetching,
    errorMessage,
    refetch,
    setDisableCooling,
    mutatingResourceId,
  };
}
