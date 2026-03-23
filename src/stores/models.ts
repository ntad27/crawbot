/**
 * Models State Store
 * Fetches and caches the model catalog from the Gateway's models.list RPC.
 * Provides setSelectedModel which patches the session model via sessions.patch.
 */
import { create } from 'zustand';
import { useGatewayStore } from './gateway';
import { useProviderStore } from './providers';

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
  reasoning?: boolean;
  input?: Array<'text' | 'image'>;
}

interface ModelsState {
  models: ModelCatalogEntry[];
  loading: boolean;
  error: string | null;
  selectedModel: string | null;

  fetchModels: () => Promise<void>;
  setSelectedModel: (modelId: string | null) => void;
  getModelsByProvider: (provider: string) => ModelCatalogEntry[];
}

export const useModelsStore = create<ModelsState>((set, get) => ({
  models: [],
  loading: false,
  error: null,
  selectedModel: null,

  fetchModels: async () => {
    set({ loading: true, error: null });
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'gateway:rpc',
        'models.list',
        {},
      ) as { success: boolean; result?: { models?: ModelCatalogEntry[] }; error?: string };

      if (result.success && result.result?.models) {
        // Filter to only show models from user-configured providers
        const providers = useProviderStore.getState().providers;
        const configuredTypes = new Set<string>(providers.map((p) => p.type));
        configuredTypes.add('webauth');
        // Google OAuth uses 'google-gemini-cli' provider in OpenClaw
        if (configuredTypes.has('google')) {
          configuredTypes.add('google-gemini-cli');
        }
        let filtered = configuredTypes.size > 0
          ? result.result.models.filter((m) => configuredTypes.has(m.provider))
          : result.result.models;

        // When Google provider uses OAuth (no API key), remap google/ models
        // to google-gemini-cli/ so auth profile lookup works correctly.
        const googleProvider = providers.find((p) => p.type === 'google');
        if (googleProvider && !googleProvider.hasKey) {
          filtered = filtered
            // Remove built-in google/ models (they won't have auth)
            .filter((m) => m.provider !== 'google')
            // Remap google-gemini-cli models to show as 'google' for display,
            // but keep the actual provider for correct model ref
            ;
          // If no google-gemini-cli models from catalog, create entries from google models
          const hasGeminiCliModels = filtered.some((m) => m.provider === 'google-gemini-cli');
          if (!hasGeminiCliModels) {
            const googleModels = (result.result.models ?? [])
              .filter((m) => m.provider === 'google')
              .map((m) => ({ ...m, provider: 'google-gemini-cli' }));
            filtered = [...filtered, ...googleModels];
          }
        }

        set({ models: filtered, loading: false });
      } else {
        set({ models: [], loading: false, error: result.error || 'No models returned' });
      }
    } catch (err) {
      console.warn('Failed to fetch model catalog:', err);
      set({ models: [], loading: false, error: String(err) });
    }
  },

  setSelectedModel: async (modelId) => {
    set({ selectedModel: modelId });

    // Patch the session model on the Gateway via sessions.patch
    try {
      const { useChatStore } = await import('./chat');
      const key = useChatStore.getState().currentSessionKey;
      await window.electron.ipcRenderer.invoke(
        'gateway:rpc',
        'sessions.patch',
        { key, model: modelId || null },
      );
    } catch (err) {
      console.warn('Failed to patch session model:', err);
    }
  },

  getModelsByProvider: (provider) => {
    return get().models.filter((m) => m.provider === provider);
  },
}));

// Auto-fetch models when gateway transitions to 'running'
// Ensures providers are loaded first so the filter works correctly.
async function fetchModelsAfterProviders() {
  const providerStore = useProviderStore.getState();
  if (providerStore.providers.length === 0) {
    await providerStore.fetchProviders();
  }
  await useModelsStore.getState().fetchModels();
}

let _prevGatewayState: string | undefined;
useGatewayStore.subscribe((state) => {
  const currentState = state.status.state;
  if (currentState === 'running' && _prevGatewayState !== 'running') {
    fetchModelsAfterProviders();
  }
  _prevGatewayState = currentState;
});

// Also check the current state immediately in case gateway is already running
// (subscription only fires on subsequent changes, not the initial state)
const initialState = useGatewayStore.getState().status.state;
if (initialState === 'running') {
  _prevGatewayState = 'running';
  fetchModelsAfterProviders();
}

// Re-fetch models when providers change so the filter stays in sync
let _prevProviderCount: number | undefined;
useProviderStore.subscribe((state) => {
  const count = state.providers.length;
  if (_prevProviderCount !== undefined && count !== _prevProviderCount) {
    const gwState = useGatewayStore.getState().status.state;
    if (gwState === 'running') {
      useModelsStore.getState().fetchModels();
    }
  }
  _prevProviderCount = count;
});
