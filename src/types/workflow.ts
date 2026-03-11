/**
 * Workflow / Task Chaining Type Definitions
 * Types for multi-step automated workflows
 */

export interface Workflow {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  errorStrategy: 'fail-fast' | 'continue' | 'saga';
  createdAt: string;
  updatedAt: string;
}

export type StepType = 'task' | 'condition' | 'parallel' | 'wait';

export interface WorkflowStep {
  id: string;
  type: StepType;
  label: string;
  config: TaskConfig | ConditionConfig | ParallelConfig | WaitConfig;
  onError: 'retry' | 'skip' | 'fail' | 'compensate';
  retryPolicy?: { maxRetries: number; backoffMs: number };
  compensateJobId?: string;
}

export interface WorkflowEdge {
  from: string; // step ID or '__start__'
  to: string; // step ID or '__end__'
  condition?: string; // expression: "status == 'ok'"
}

export interface TaskConfig {
  jobId: string;
}

export interface ConditionConfig {
  expression: string;
}

export interface ParallelConfig {
  join: 'all' | 'any';
}

export interface WaitConfig {
  delayMs: number;
}

export type WorkflowStatus =
  | 'pending'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StepState {
  status: StepStatus;
  startedAt?: string;
  completedAt?: string;
  output?: unknown;
  error?: string;
  retryCount: number;
}

export interface WorkflowInstance {
  id: string;
  workflowId: string;
  status: WorkflowStatus;
  stepStates: Record<string, StepState>;
  context: Record<string, unknown>;
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface WorkflowCreateInput {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  edges: WorkflowEdge[];
  errorStrategy?: 'fail-fast' | 'continue' | 'saga';
  enabled?: boolean;
}

export interface WorkflowUpdateInput {
  name?: string;
  description?: string;
  steps?: WorkflowStep[];
  edges?: WorkflowEdge[];
  errorStrategy?: 'fail-fast' | 'continue' | 'saga';
  enabled?: boolean;
}
