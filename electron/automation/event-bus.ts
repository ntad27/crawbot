/**
 * Automation Event Bus
 * Typed EventEmitter for routing automation trigger events
 */
import { EventEmitter } from 'events';
import type { JsonRpcNotification } from '../gateway/protocol';

export interface GatewayNotificationPayload {
  notification: JsonRpcNotification;
}

export interface FileChangePayload {
  path: string;
  triggerId: string;
  eventType: 'rename' | 'change';
}

export interface JobCompletionPayload {
  jobId: string;
  status: 'ok' | 'error';
  ts: number;
}

export interface AutomationEventMap {
  'gateway:notification': [GatewayNotificationPayload];
  'file:change': [FileChangePayload];
  'job:completion': [JobCompletionPayload];
}

class AutomationEventBus extends EventEmitter {
  emitGatewayNotification(payload: GatewayNotificationPayload): boolean {
    return this.emit('gateway:notification', payload);
  }

  emitFileChange(payload: FileChangePayload): boolean {
    return this.emit('file:change', payload);
  }

  emitJobCompletion(payload: JobCompletionPayload): boolean {
    return this.emit('job:completion', payload);
  }

  onGatewayNotification(listener: (payload: GatewayNotificationPayload) => void): this {
    return this.on('gateway:notification', listener);
  }

  onFileChange(listener: (payload: FileChangePayload) => void): this {
    return this.on('file:change', listener);
  }

  onJobCompletion(listener: (payload: JobCompletionPayload) => void): this {
    return this.on('job:completion', listener);
  }
}

// Singleton instance
export const automationEventBus = new AutomationEventBus();
