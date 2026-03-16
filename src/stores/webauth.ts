/**
 * WebAuth Providers State Store
 * Manages web login session providers (zero-token feature)
 *
 * WebAuth tabs auto-start on app launch for all configured providers.
 * They appear in the browser tab bar with [WebAuth] prefix and Lock icon.
 * They cannot be closed from the tab bar — only removed via Settings.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Types ──

export type WebAuthStatus = 'valid' | 'expiring' | 'expired' | 'not-configured';

export interface WebAuthProviderState {
  id: string;
  name: string;
  status: WebAuthStatus;
  user?: string;
  models: Array<{ id: string; name: string }>;
  partition: string;
  loginUrl: string;
  lastChecked?: number;
}

interface WebAuthState {
  providers: WebAuthProviderState[];
  proxyPort: number | null;
  proxyRunning: boolean;

  // Provider actions
  setProviders: (providers: WebAuthProviderState[]) => void;
  updateProvider: (id: string, updates: Partial<WebAuthProviderState>) => void;
  addProvider: (providerId: string) => void;
  removeProvider: (providerId: string) => void;

  // Proxy state
  setProxyStatus: (running: boolean, port: number | null) => void;

  // Auth actions (call IPC)
  loginProvider: (providerId: string) => void;
  checkAuth: (providerId: string) => void;
  checkAllAuth: () => void;
}

// ── Available providers registry ──

export const AVAILABLE_PROVIDERS = [
  { id: 'claude-web', name: 'Claude Web', loginUrl: 'https://claude.ai', partition: 'persist:webauth-claude' },
  { id: 'deepseek-web', name: 'DeepSeek Web', loginUrl: 'https://chat.deepseek.com', partition: 'persist:webauth-deepseek' },
  { id: 'chatgpt-web', name: 'ChatGPT Web', loginUrl: 'https://chatgpt.com', partition: 'persist:webauth-chatgpt' },
  { id: 'gemini-web', name: 'Gemini Web', loginUrl: 'https://gemini.google.com', partition: 'persist:webauth-gemini' },
  { id: 'grok-web', name: 'Grok Web', loginUrl: 'https://grok.com', partition: 'persist:webauth-grok' },
  { id: 'qwen-intl-web', name: 'Qwen International', loginUrl: 'https://chat.qwen.ai', partition: 'persist:webauth-qwen-intl' },
  { id: 'qwen-china-web', name: 'Qwen China', loginUrl: 'https://tongyi.aliyun.com', partition: 'persist:webauth-qwen-china' },
  { id: 'kimi-web', name: 'Kimi / Moonshot', loginUrl: 'https://kimi.moonshot.cn', partition: 'persist:webauth-kimi' },
  { id: 'doubao-web', name: 'Doubao', loginUrl: 'https://www.doubao.com', partition: 'persist:webauth-doubao' },
  { id: 'glm-china-web', name: 'GLM (Zhipu)', loginUrl: 'https://chatglm.cn', partition: 'persist:webauth-glm-china' },
  { id: 'glm-intl-web', name: 'GLM International', loginUrl: 'https://chat.glm.ai', partition: 'persist:webauth-glm-intl' },
  { id: 'manus-api', name: 'Manus API', loginUrl: 'https://manus.im', partition: 'persist:webauth-manus' },
] as const;

// ── Helpers ──

function invokeIpc(channel: string, ...args: unknown[]): void {
  try {
    const result = window.electron?.ipcRenderer?.invoke(channel, ...args);
    if (result && typeof result.catch === 'function') {
      result.catch((err: Error) => {
        console.error(`[WebAuthStore] IPC ${channel} failed:`, err);
      });
    }
  } catch (err) {
    console.error(`[WebAuthStore] IPC ${channel} failed:`, err);
  }
}

// ── Store ──

export const useWebAuthStore = create<WebAuthState>()(
  persist(
    (set, get) => ({
      providers: [],
      proxyPort: null,
      proxyRunning: false,
      setProviders: (providers) => set({ providers }),

      updateProvider: (id, updates) =>
        set((s) => ({
          providers: s.providers.map((p) =>
            p.id === id ? { ...p, ...updates } : p
          ),
        })),

      addProvider: (providerId) => {
        const reg = AVAILABLE_PROVIDERS.find((p) => p.id === providerId);
        if (!reg) return;

        const existing = get().providers.find((p) => p.id === providerId);
        if (existing) return;

        const newProvider: WebAuthProviderState = {
          id: reg.id,
          name: reg.name,
          status: 'not-configured',
          models: [],
          partition: reg.partition,
          loginUrl: reg.loginUrl,
        };

        set((s) => ({ providers: [...s.providers, newProvider] }));
        invokeIpc('webauth:provider:add', providerId);
      },

      removeProvider: (providerId) => {
        set((s) => ({
          providers: s.providers.filter((p) => p.id !== providerId),
        }));
        invokeIpc('webauth:provider:remove', providerId);
      },

      setProxyStatus: (running, port) =>
        set({ proxyRunning: running, proxyPort: port }),

      loginProvider: (providerId) => {
        invokeIpc('webauth:provider:login', providerId);
      },

      checkAuth: (providerId) => {
        invokeIpc('webauth:provider:check', providerId);
      },

      checkAllAuth: () => {
        invokeIpc('webauth:provider:check-all');
      },
    }),
    {
      name: 'crawbot-webauth',
      partialize: (state) => ({
        // Persist provider list (IDs, status) but not runtime state
        providers: state.providers.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          models: p.models,
          partition: p.partition,
          loginUrl: p.loginUrl,
        })),
      }),
    }
  )
);

// WebAuth tabs are NOT auto-started globally.
// They are created on-demand when the user opens Settings and clicks Login.
// Tab management is handled by useWebAuthBrowserStore (webauth-browser.ts).
