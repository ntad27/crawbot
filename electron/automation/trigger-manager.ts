/**
 * Event Trigger Manager
 * CRUD for EventTrigger objects + listener wiring on the AutomationEventBus
 */
import crypto from 'node:crypto';
import type { GatewayManager } from '../gateway/manager';
import type {
  EventTrigger,
  EventTriggerCreateInput,
  EventTriggerUpdateInput,
} from './types';
import { automationEventBus } from './event-bus';
import { fileWatcher } from './file-watcher';
import { logger } from '../utils/logger';
import type {
  GatewayNotificationPayload,
  FileChangePayload,
  JobCompletionPayload,
} from './event-bus';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let storeInstance: any = null;

async function getStore() {
  if (!storeInstance) {
    const Store = (await import('electron-store')).default;
    storeInstance = new Store({ name: 'automation' });
  }
  return storeInstance;
}

export class TriggerManager {
  private gatewayManager: GatewayManager | null = null;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // ---- Init / Destroy ----

  async init(gatewayManager: GatewayManager): Promise<void> {
    this.gatewayManager = gatewayManager;

    // Load persisted triggers and register listeners
    const triggers = await this.listTriggers();
    for (const trigger of triggers) {
      this._registerListener(trigger);
    }

    logger.debug(`[TriggerManager] Initialized with ${triggers.length} trigger(s)`);
  }

  destroy(): void {
    // Clear all debounce timers
    for (const [, timer] of this.debounceTimers) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // Clean up file watchers
    fileWatcher.destroy();

    // Remove all EventBus listeners added by this manager
    automationEventBus.removeAllListeners('gateway:notification');
    automationEventBus.removeAllListeners('file:change');
    automationEventBus.removeAllListeners('job:completion');

    logger.debug('[TriggerManager] Destroyed');
  }

  // ---- CRUD ----

  async listTriggers(): Promise<EventTrigger[]> {
    const store = await getStore();
    return (store.get('eventTriggers') as EventTrigger[]) ?? [];
  }

  async createTrigger(input: EventTriggerCreateInput): Promise<EventTrigger> {
    const store = await getStore();
    const triggers = await this.listTriggers();

    const now = new Date().toISOString();
    const trigger: EventTrigger = {
      id: crypto.randomUUID(),
      jobId: input.jobId,
      source: input.source,
      filter: input.filter,
      debounceMs: input.debounceMs ?? 3000,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };

    triggers.push(trigger);
    store.set('eventTriggers', triggers);

    this._registerListener(trigger);
    logger.debug(`[TriggerManager] Created trigger ${trigger.id}`);

    return trigger;
  }

  async updateTrigger(id: string, input: EventTriggerUpdateInput): Promise<EventTrigger> {
    const store = await getStore();
    const triggers = await this.listTriggers();
    const index = triggers.findIndex((t) => t.id === id);

    if (index === -1) {
      throw new Error(`Trigger ${id} not found`);
    }

    const updated: EventTrigger = {
      ...triggers[index],
      ...input,
      id,
      updatedAt: new Date().toISOString(),
    };

    triggers[index] = updated;
    store.set('eventTriggers', triggers);

    // Re-register listener with updated config
    this._unregisterListener(id);
    this._registerListener(updated);

    logger.debug(`[TriggerManager] Updated trigger ${id}`);
    return updated;
  }

  async deleteTrigger(id: string): Promise<void> {
    const store = await getStore();
    const triggers = await this.listTriggers();
    const filtered = triggers.filter((t) => t.id !== id);
    store.set('eventTriggers', filtered);

    this._unregisterListener(id);
    logger.debug(`[TriggerManager] Deleted trigger ${id}`);
  }

  async toggleTrigger(id: string, enabled: boolean): Promise<EventTrigger> {
    return this.updateTrigger(id, { enabled });
  }

  // ---- Private helpers ----

  private _registerListener(trigger: EventTrigger): void {
    // Don't register for disabled triggers
    if (!trigger.enabled) return;

    switch (trigger.source) {
      case 'gateway':
        automationEventBus.on(`gateway:notification`, (payload: GatewayNotificationPayload) => {
          this._handleGatewayNotification(trigger, payload);
        });
        break;

      case 'file': {
        const path = trigger.filter.pattern ?? '';
        if (path) {
          fileWatcher.addWatch(path, trigger.id);
        }
        automationEventBus.on('file:change', (payload: FileChangePayload) => {
          if (payload.triggerId === trigger.id) {
            this._fireTrigger(trigger);
          }
        });
        break;
      }

      case 'job_completion':
        automationEventBus.on('job:completion', (payload: JobCompletionPayload) => {
          this._handleJobCompletion(trigger, payload);
        });
        break;
    }
  }

  private _unregisterListener(triggerId: string): void {
    // Clear debounce timer if any
    const timer = this.debounceTimers.get(triggerId);
    if (timer) {
      clearTimeout(timer);
      this.debounceTimers.delete(triggerId);
    }

    // Remove file watch if exists
    fileWatcher.removeWatch(triggerId);

    // NOTE: EventEmitter doesn't support per-trigger named function removal without
    // storing references. Since we call removeAllListeners and re-register on update/delete,
    // we rebuild all listeners from scratch when needed.
    //
    // For a production system, keep per-trigger listener refs; for now this is sufficient
    // because updateTrigger/deleteTrigger re-registers surviving triggers after clear.
    this._rebuildAllListeners();
  }

  private async _rebuildAllListeners(): Promise<void> {
    // Remove all automation listeners and re-register from persisted state
    automationEventBus.removeAllListeners('gateway:notification');
    automationEventBus.removeAllListeners('file:change');
    automationEventBus.removeAllListeners('job:completion');

    const triggers = await this.listTriggers();
    for (const trigger of triggers) {
      this._registerListener(trigger);
    }
  }

  private _handleGatewayNotification(
    trigger: EventTrigger,
    payload: GatewayNotificationPayload,
  ): void {
    const { filter } = trigger;
    const { notification } = payload;

    // Check eventType filter
    if (filter.eventType && notification.method !== filter.eventType) return;

    // Check channelId filter
    if (filter.channelId) {
      const params = notification.params as Record<string, unknown> | undefined;
      if (!params || params.channelId !== filter.channelId) return;
    }

    // Check pattern filter (regex against stringified params)
    if (filter.pattern) {
      try {
        const regex = new RegExp(filter.pattern);
        const content = JSON.stringify(notification.params ?? '');
        if (!regex.test(content)) return;
      } catch {
        // invalid regex — skip match
      }
    }

    this._fireTrigger(trigger);
  }

  private _handleJobCompletion(trigger: EventTrigger, payload: JobCompletionPayload): void {
    const { filter } = trigger;

    // Check jobId filter
    if (filter.jobId && payload.jobId !== filter.jobId) return;

    // Check statusMatch filter
    if (filter.statusMatch && filter.statusMatch !== 'any' && payload.status !== filter.statusMatch)
      return;

    this._fireTrigger(trigger);
  }

  private _fireTrigger(trigger: EventTrigger): void {
    if (trigger.debounceMs > 0) {
      // Clear existing debounce timer
      const existing = this.debounceTimers.get(trigger.id);
      if (existing) clearTimeout(existing);

      const timer = setTimeout(() => {
        this.debounceTimers.delete(trigger.id);
        this._executeJob(trigger);
      }, trigger.debounceMs);

      this.debounceTimers.set(trigger.id, timer);
    } else {
      this._executeJob(trigger);
    }
  }

  private _executeJob(trigger: EventTrigger): void {
    if (!this.gatewayManager) {
      logger.warn(`[TriggerManager] Cannot execute job — gatewayManager not set`);
      return;
    }

    logger.debug(`[TriggerManager] Firing trigger ${trigger.id} → job ${trigger.jobId}`);

    this.gatewayManager
      .rpc('cron.run', { id: trigger.jobId, mode: 'force' })
      .catch((err: unknown) => {
        logger.warn(`[TriggerManager] Failed to run job ${trigger.jobId}: ${String(err)}`);
      });
  }
}

export const triggerManager = new TriggerManager();
