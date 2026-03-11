/**
 * Webhook Store (Persistence)
 * CRUD for WebhookConfig and WebhookLogEntry records.
 * Uses electron-store for persistence (same pattern as workflow-store.ts).
 */
import crypto from 'node:crypto';
import type { WebhookConfig, WebhookLogEntry } from './webhook-types';
import { logger } from '../utils/logger';

const MAX_LOGS_PER_WEBHOOK = 50;
const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let storeInstance: any = null;

async function getStore() {
  if (!storeInstance) {
    const Store = (await import('electron-store')).default;
    storeInstance = new Store({ name: 'automation' });
  }
  return storeInstance;
}

export class WebhookStore {
  // ---- Webhook CRUD ----

  async listWebhooks(): Promise<WebhookConfig[]> {
    const store = await getStore();
    return (store.get('automation.webhooks') as WebhookConfig[]) ?? [];
  }

  async getWebhook(id: string): Promise<WebhookConfig | undefined> {
    const webhooks = await this.listWebhooks();
    return webhooks.find((w) => w.id === id);
  }

  async createWebhook(jobId: string, rateLimit?: number): Promise<WebhookConfig> {
    const store = await getStore();
    const webhooks = await this.listWebhooks();

    const webhook: WebhookConfig = {
      id: crypto.randomUUID(),
      jobId,
      secret: crypto.randomBytes(32).toString('hex'),
      enabled: true,
      createdAt: new Date().toISOString(),
      rateLimit: rateLimit ?? 60,
    };

    webhooks.push(webhook);
    store.set('automation.webhooks', webhooks);
    logger.debug(`[WebhookStore] Created webhook ${webhook.id} for job ${jobId}`);
    return webhook;
  }

  async deleteWebhook(id: string): Promise<void> {
    const store = await getStore();
    const webhooks = await this.listWebhooks();
    const filtered = webhooks.filter((w) => w.id !== id);
    store.set('automation.webhooks', filtered);

    // Remove associated logs
    const logs = (store.get('automation.webhookLogs') as Record<string, WebhookLogEntry[]>) ?? {};
    delete logs[id];
    store.set('automation.webhookLogs', logs);

    logger.debug(`[WebhookStore] Deleted webhook ${id}`);
  }

  async regenerateSecret(id: string): Promise<string> {
    const store = await getStore();
    const webhooks = await this.listWebhooks();
    const index = webhooks.findIndex((w) => w.id === id);

    if (index === -1) throw new Error(`Webhook ${id} not found`);

    const newSecret = crypto.randomBytes(32).toString('hex');
    webhooks[index] = { ...webhooks[index], secret: newSecret };
    store.set('automation.webhooks', webhooks);
    logger.debug(`[WebhookStore] Regenerated secret for webhook ${id}`);
    return newSecret;
  }

  async toggleWebhook(id: string, enabled: boolean): Promise<WebhookConfig> {
    const store = await getStore();
    const webhooks = await this.listWebhooks();
    const index = webhooks.findIndex((w) => w.id === id);

    if (index === -1) throw new Error(`Webhook ${id} not found`);

    webhooks[index] = { ...webhooks[index], enabled };
    store.set('automation.webhooks', webhooks);
    logger.debug(`[WebhookStore] Toggled webhook ${id} → enabled=${enabled}`);
    return webhooks[index];
  }

  // ---- Log management ----

  async addLogEntry(entry: WebhookLogEntry): Promise<void> {
    const store = await getStore();
    const allLogs = (store.get('automation.webhookLogs') as Record<string, WebhookLogEntry[]>) ?? {};
    const entries = allLogs[entry.webhookId] ?? [];

    entries.unshift(entry); // newest first

    // Cap at MAX_LOGS_PER_WEBHOOK
    if (entries.length > MAX_LOGS_PER_WEBHOOK) {
      entries.splice(MAX_LOGS_PER_WEBHOOK);
    }

    allLogs[entry.webhookId] = entries;
    store.set('automation.webhookLogs', allLogs);
  }

  async getLogs(webhookId: string, limit = MAX_LOGS_PER_WEBHOOK): Promise<WebhookLogEntry[]> {
    const store = await getStore();
    const allLogs = (store.get('automation.webhookLogs') as Record<string, WebhookLogEntry[]>) ?? {};
    const entries = allLogs[webhookId] ?? [];
    return entries.slice(0, limit);
  }

  async purgeOldLogs(): Promise<void> {
    const store = await getStore();
    const allLogs = (store.get('automation.webhookLogs') as Record<string, WebhookLogEntry[]>) ?? {};
    const cutoff = Date.now() - LOG_TTL_MS;
    let changed = false;

    for (const [webhookId, entries] of Object.entries(allLogs)) {
      const filtered = entries.filter((e) => new Date(e.timestamp).getTime() > cutoff);
      if (filtered.length !== entries.length) {
        allLogs[webhookId] = filtered;
        changed = true;
      }
    }

    if (changed) {
      store.set('automation.webhookLogs', allLogs);
      logger.debug('[WebhookStore] Purged old log entries');
    }
  }
}

export const webhookStore = new WebhookStore();
