/**
 * Automation type definitions for the main process
 * Keep in sync with src/types/automation.ts
 */

export type TriggerSource = 'gateway' | 'file' | 'job_completion';

export interface EventFilter {
  eventType?: string;
  channelId?: string;
  pattern?: string;
  jobId?: string;
  statusMatch?: string;
}

export interface EventTrigger {
  id: string;
  jobId: string;
  source: TriggerSource;
  filter: EventFilter;
  debounceMs: number;
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
