/**
 * Automation / Event Trigger Type Definitions
 * Types for event-driven task automation
 */

export type TriggerSource = 'gateway' | 'file' | 'job_completion';

export interface EventFilter {
  eventType?: string; // GatewayEventType value
  channelId?: string; // specific channel
  pattern?: string; // regex for message content / glob for files
  jobId?: string; // for job_completion source
  statusMatch?: string; // 'ok' | 'error' for job_completion
}

export interface EventTrigger {
  id: string;
  jobId: string; // linked cron job to execute
  source: TriggerSource;
  filter: EventFilter;
  debounceMs: number; // 0 = no debounce
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface EventTriggerCreateInput {
  jobId: string;
  source: TriggerSource;
  filter: EventFilter;
  debounceMs?: number;
  enabled?: boolean;
}

export interface EventTriggerUpdateInput {
  source?: TriggerSource;
  filter?: EventFilter;
  debounceMs?: number;
  enabled?: boolean;
}
