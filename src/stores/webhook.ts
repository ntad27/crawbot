/**
 * Webhook Store (Renderer)
 * Manages webhook configs, logs, and HTTP server settings via IPC.
 */
import { create } from 'zustand';
import type { WebhookConfig, WebhookLogEntry, WebhookCreateInput, HttpServerConfig } from '../types/webhook';

interface WebhookState {
  webhooks: WebhookConfig[];
  logs: Record<string, WebhookLogEntry[]>;
  serverConfig: HttpServerConfig | null;
  loading: boolean;
  error: string | null;

  fetchWebhooks: () => Promise<void>;
  createWebhook: (input: WebhookCreateInput) => Promise<WebhookConfig>;
  deleteWebhook: (id: string) => Promise<void>;
  regenerateSecret: (id: string) => Promise<string>;
  toggleWebhook: (id: string, enabled: boolean) => Promise<void>;
  fetchLogs: (webhookId: string) => Promise<void>;
  fetchServerConfig: () => Promise<void>;
  updateServerConfig: (config: Partial<HttpServerConfig>) => Promise<void>;
  getApiKey: () => Promise<string>;
  regenerateApiKey: () => Promise<string>;
}

export const useWebhookStore = create<WebhookState>((set) => ({
  webhooks: [],
  logs: {},
  serverConfig: null,
  loading: false,
  error: null,

  fetchWebhooks: async () => {
    set({ loading: true, error: null });
    try {
      const result = (await window.electron.ipcRenderer.invoke('webhook:list')) as WebhookConfig[];
      set({ webhooks: result, loading: false });
    } catch (error) {
      set({ error: String(error), loading: false });
    }
  },

  createWebhook: async (input) => {
    try {
      const webhook = (await window.electron.ipcRenderer.invoke(
        'webhook:create',
        input.jobId,
        input.rateLimit,
      )) as WebhookConfig;
      set((state) => ({ webhooks: [...state.webhooks, webhook] }));
      return webhook;
    } catch (error) {
      console.error('Failed to create webhook:', error);
      throw error;
    }
  },

  deleteWebhook: async (id) => {
    try {
      await window.electron.ipcRenderer.invoke('webhook:delete', id);
      set((state) => ({ webhooks: state.webhooks.filter((w) => w.id !== id) }));
    } catch (error) {
      console.error('Failed to delete webhook:', error);
      throw error;
    }
  },

  regenerateSecret: async (id) => {
    try {
      const secret = (await window.electron.ipcRenderer.invoke(
        'webhook:regenerate-secret',
        id,
      )) as string;
      set((state) => ({
        webhooks: state.webhooks.map((w) => (w.id === id ? { ...w, secret } : w)),
      }));
      return secret;
    } catch (error) {
      console.error('Failed to regenerate secret:', error);
      throw error;
    }
  },

  toggleWebhook: async (id, enabled) => {
    try {
      const updated = (await window.electron.ipcRenderer.invoke(
        'webhook:toggle',
        id,
        enabled,
      )) as WebhookConfig;
      set((state) => ({
        webhooks: state.webhooks.map((w) => (w.id === id ? updated : w)),
      }));
    } catch (error) {
      console.error('Failed to toggle webhook:', error);
      throw error;
    }
  },

  fetchLogs: async (webhookId) => {
    try {
      const logs = (await window.electron.ipcRenderer.invoke(
        'webhook:logs',
        webhookId,
      )) as WebhookLogEntry[];
      set((state) => ({
        logs: { ...state.logs, [webhookId]: logs },
      }));
    } catch (error) {
      console.error('Failed to fetch logs:', error);
      throw error;
    }
  },

  fetchServerConfig: async () => {
    try {
      const config = (await window.electron.ipcRenderer.invoke(
        'webhook:server-config',
      )) as HttpServerConfig;
      set({ serverConfig: config });
    } catch (error) {
      console.error('Failed to fetch server config:', error);
    }
  },

  updateServerConfig: async (config) => {
    try {
      const updated = (await window.electron.ipcRenderer.invoke(
        'webhook:update-server-config',
        config,
      )) as HttpServerConfig;
      set({ serverConfig: updated });
    } catch (error) {
      console.error('Failed to update server config:', error);
      throw error;
    }
  },

  getApiKey: async () => {
    return (await window.electron.ipcRenderer.invoke('webhook:api-key')) as string;
  },

  regenerateApiKey: async () => {
    return (await window.electron.ipcRenderer.invoke('webhook:regenerate-api-key')) as string;
  },
}));
