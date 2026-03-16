/**
 * WebAuth Store Tests
 * Tests for useWebAuthStore Zustand store
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWebAuthStore, AVAILABLE_PROVIDERS } from '@/stores/webauth';

describe('useWebAuthStore', () => {
  beforeEach(() => {
    useWebAuthStore.setState({
      providers: [],
      proxyPort: null,
      proxyRunning: false,
    });
    vi.clearAllMocks();
  });

  // ── AVAILABLE_PROVIDERS Registry ──

  describe('AVAILABLE_PROVIDERS', () => {
    it('contains 12 providers', () => {
      expect(AVAILABLE_PROVIDERS).toHaveLength(12);
    });

    it('each provider has id, name, loginUrl, partition', () => {
      for (const provider of AVAILABLE_PROVIDERS) {
        expect(provider.id).toBeTruthy();
        expect(provider.name).toBeTruthy();
        expect(provider.loginUrl).toMatch(/^https:\/\//);
        expect(provider.partition).toMatch(/^persist:webauth-/);
      }
    });

    it('all provider IDs are unique', () => {
      const ids = AVAILABLE_PROVIDERS.map((p) => p.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it('all partitions are unique', () => {
      const partitions = AVAILABLE_PROVIDERS.map((p) => p.partition);
      expect(new Set(partitions).size).toBe(partitions.length);
    });

    it('includes expected providers', () => {
      const ids = AVAILABLE_PROVIDERS.map((p) => p.id);
      expect(ids).toContain('claude-web');
      expect(ids).toContain('deepseek-web');
      expect(ids).toContain('chatgpt-web');
      expect(ids).toContain('gemini-web');
      expect(ids).toContain('grok-web');
      expect(ids).toContain('manus-api');
    });
  });

  // ── addProvider ──

  describe('addProvider', () => {
    it('adds a provider from AVAILABLE_PROVIDERS by ID', () => {
      useSt().addProvider('claude-web');
      const { providers } = useSt();

      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('claude-web');
      expect(providers[0].name).toBe('Claude Web');
      expect(providers[0].status).toBe('not-configured');
      expect(providers[0].models).toEqual([]);
      expect(providers[0].partition).toBe('persist:webauth-claude');
      expect(providers[0].loginUrl).toBe('https://claude.ai');
    });

    it('calls IPC webauth:provider:add', () => {
      useSt().addProvider('deepseek-web');

      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
        'webauth:provider:add',
        'deepseek-web',
      );
    });

    it('does nothing for unknown provider ID', () => {
      useSt().addProvider('nonexistent-provider');
      const { providers } = useSt();

      expect(providers).toHaveLength(0);
      expect(window.electron.ipcRenderer.invoke).not.toHaveBeenCalled();
    });

    it('does not add duplicate provider', () => {
      useSt().addProvider('claude-web');
      useSt().addProvider('claude-web');
      const { providers } = useSt();

      expect(providers).toHaveLength(1);
      // IPC only called once (first add)
      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledTimes(1);
    });

    it('can add multiple different providers', () => {
      useSt().addProvider('claude-web');
      useSt().addProvider('deepseek-web');
      useSt().addProvider('chatgpt-web');
      const { providers } = useSt();

      expect(providers).toHaveLength(3);
      expect(providers.map((p) => p.id)).toEqual([
        'claude-web',
        'deepseek-web',
        'chatgpt-web',
      ]);
    });
  });

  // ── removeProvider ──

  describe('removeProvider', () => {
    it('removes a provider by ID', () => {
      useSt().addProvider('claude-web');
      useSt().addProvider('deepseek-web');
      vi.clearAllMocks();

      useSt().removeProvider('claude-web');
      const { providers } = useSt();

      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('deepseek-web');
    });

    it('calls IPC webauth:provider:remove', () => {
      useSt().addProvider('claude-web');
      vi.clearAllMocks();

      useSt().removeProvider('claude-web');

      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
        'webauth:provider:remove',
        'claude-web',
      );
    });

    it('removing non-existent provider is a no-op on state', () => {
      useSt().addProvider('claude-web');
      vi.clearAllMocks();

      useSt().removeProvider('nonexistent');
      const { providers } = useSt();

      expect(providers).toHaveLength(1);
      // IPC is still called (fire and forget)
      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
        'webauth:provider:remove',
        'nonexistent',
      );
    });
  });

  // ── updateProvider ──

  describe('updateProvider', () => {
    it('updates provider status', () => {
      useSt().addProvider('claude-web');
      useSt().updateProvider('claude-web', { status: 'valid' });

      const provider = useSt().providers.find((p) => p.id === 'claude-web');
      expect(provider?.status).toBe('valid');
    });

    it('updates provider user info', () => {
      useSt().addProvider('claude-web');
      useSt().updateProvider('claude-web', { user: 'test@example.com' });

      const provider = useSt().providers.find((p) => p.id === 'claude-web');
      expect(provider?.user).toBe('test@example.com');
    });

    it('updates provider models', () => {
      useSt().addProvider('deepseek-web');
      const models = [
        { id: 'webauth-deepseek-chat', name: 'DeepSeek Chat' },
        { id: 'webauth-deepseek-reasoner', name: 'DeepSeek Reasoner' },
      ];
      useSt().updateProvider('deepseek-web', { models });

      const provider = useSt().providers.find((p) => p.id === 'deepseek-web');
      expect(provider?.models).toEqual(models);
    });

    it('updates lastChecked timestamp', () => {
      useSt().addProvider('claude-web');
      const now = Date.now();
      useSt().updateProvider('claude-web', { lastChecked: now });

      const provider = useSt().providers.find((p) => p.id === 'claude-web');
      expect(provider?.lastChecked).toBe(now);
    });

    it('does not affect other providers', () => {
      useSt().addProvider('claude-web');
      useSt().addProvider('deepseek-web');
      useSt().updateProvider('claude-web', { status: 'valid' });

      const deepseek = useSt().providers.find((p) => p.id === 'deepseek-web');
      expect(deepseek?.status).toBe('not-configured');
    });

    it('updating non-existent provider is a no-op', () => {
      useSt().addProvider('claude-web');
      useSt().updateProvider('nonexistent', { status: 'valid' });

      expect(useSt().providers).toHaveLength(1);
      expect(useSt().providers[0].status).toBe('not-configured');
    });

    it('merges partial updates, preserving other fields', () => {
      useSt().addProvider('claude-web');
      useSt().updateProvider('claude-web', { status: 'valid', user: 'alice' });
      useSt().updateProvider('claude-web', { status: 'expiring' });

      const provider = useSt().providers.find((p) => p.id === 'claude-web');
      expect(provider?.status).toBe('expiring');
      expect(provider?.user).toBe('alice'); // preserved from earlier update
    });
  });

  // ── setProviders ──

  describe('setProviders', () => {
    it('replaces entire providers array', () => {
      useSt().addProvider('claude-web');
      useSt().addProvider('deepseek-web');

      const newProviders = [
        {
          id: 'chatgpt-web',
          name: 'ChatGPT Web',
          status: 'valid' as const,
          models: [],
          partition: 'persist:webauth-chatgpt',
          loginUrl: 'https://chatgpt.com',
        },
      ];

      useSt().setProviders(newProviders);
      expect(useSt().providers).toHaveLength(1);
      expect(useSt().providers[0].id).toBe('chatgpt-web');
    });

    it('can set empty providers array', () => {
      useSt().addProvider('claude-web');
      useSt().setProviders([]);
      expect(useSt().providers).toHaveLength(0);
    });
  });

  // ── setProxyStatus ──

  describe('setProxyStatus', () => {
    it('sets proxy as running with port', () => {
      useSt().setProxyStatus(true, 8080);

      expect(useSt().proxyRunning).toBe(true);
      expect(useSt().proxyPort).toBe(8080);
    });

    it('sets proxy as stopped with null port', () => {
      useSt().setProxyStatus(true, 8080);
      useSt().setProxyStatus(false, null);

      expect(useSt().proxyRunning).toBe(false);
      expect(useSt().proxyPort).toBeNull();
    });
  });

  // ── IPC Actions ──

  describe('loginProvider', () => {
    it('calls IPC webauth:provider:login', () => {
      useSt().loginProvider('claude-web');

      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
        'webauth:provider:login',
        'claude-web',
      );
    });
  });

  describe('checkAuth', () => {
    it('calls IPC webauth:provider:check', () => {
      useSt().checkAuth('deepseek-web');

      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
        'webauth:provider:check',
        'deepseek-web',
      );
    });
  });

  describe('checkAllAuth', () => {
    it('calls IPC webauth:provider:check-all', () => {
      useSt().checkAllAuth();

      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
        'webauth:provider:check-all',
      );
    });
  });

  // ── IPC error handling ──

  describe('IPC error handling', () => {
    it('addProvider catches IPC rejection silently', () => {
      (window.electron.ipcRenderer.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('IPC failed'),
      );

      // Should not throw
      expect(() => useSt().addProvider('claude-web')).not.toThrow();
      expect(useSt().providers).toHaveLength(1); // state still updated
    });

    it('removeProvider catches IPC rejection silently', () => {
      useSt().addProvider('claude-web');
      vi.clearAllMocks();

      (window.electron.ipcRenderer.invoke as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('IPC failed'),
      );

      expect(() => useSt().removeProvider('claude-web')).not.toThrow();
      expect(useSt().providers).toHaveLength(0); // state still updated
    });
  });

  // ── Persist middleware ──

  describe('persist middleware', () => {
    it('store name is crawbot-webauth', () => {
      // The persist middleware uses 'crawbot-webauth' as the storage key.
      // We can verify by checking that the store rehydrates from this key.
      const storeData = {
        state: {
          providers: [
            {
              id: 'claude-web',
              name: 'Claude Web',
              status: 'valid',
              models: [],
              partition: 'persist:webauth-claude',
              loginUrl: 'https://claude.ai',
            },
          ],
        },
        version: 0,
      };
      localStorage.setItem('crawbot-webauth', JSON.stringify(storeData));

      // Trigger rehydration
      useWebAuthStore.persist.rehydrate();
      const { providers } = useSt();

      expect(providers).toHaveLength(1);
      expect(providers[0].id).toBe('claude-web');
      expect(providers[0].status).toBe('valid');
    });

    it('persisted state does not include proxyPort or proxyRunning', () => {
      useSt().addProvider('claude-web');
      useSt().setProxyStatus(true, 9090);

      const stored = localStorage.getItem('crawbot-webauth');
      expect(stored).toBeTruthy();

      const parsed = JSON.parse(stored!);
      expect(parsed.state.proxyPort).toBeUndefined();
      expect(parsed.state.proxyRunning).toBeUndefined();
    });

    it('persisted provider does not include lastChecked or user', () => {
      useSt().addProvider('claude-web');
      useSt().updateProvider('claude-web', {
        user: 'test@example.com',
        lastChecked: Date.now(),
      });

      const stored = localStorage.getItem('crawbot-webauth');
      const parsed = JSON.parse(stored!);
      const provider = parsed.state.providers[0];

      // partialize strips user and lastChecked
      expect(provider.user).toBeUndefined();
      expect(provider.lastChecked).toBeUndefined();
      // But keeps these
      expect(provider.id).toBe('claude-web');
      expect(provider.name).toBe('Claude Web');
      expect(provider.status).toBe('not-configured');
      expect(provider.models).toEqual([]);
      expect(provider.partition).toBe('persist:webauth-claude');
      expect(provider.loginUrl).toBe('https://claude.ai');
    });
  });
});

/** Helper — shorthand for useWebAuthStore.getState() */
function useSt() {
  return useWebAuthStore.getState();
}
