import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import type { FlowNodeData } from '../converters';
import type { StepStatus } from '@/types/workflow';

interface TaskNodeData extends FlowNodeData {
  executionStatus?: StepStatus;
}

export function TaskNode({ data, selected }: NodeProps & { data: TaskNodeData }) {
  const { label, config, executionStatus } = data;
  const jobId = (config as { jobId?: string } | undefined)?.jobId;

  return (
    <div
      className={cn(
        'min-w-[180px] rounded-lg border-2 bg-card text-card-foreground shadow-sm px-3 py-2 select-none',
        selected ? 'border-primary' : 'border-border',
        executionStatus === 'running' && 'border-blue-500 animate-pulse',
        executionStatus === 'completed' && 'border-green-500',
        executionStatus === 'failed' && 'border-red-500',
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium truncate">{label || 'Task'}</span>
        {executionStatus && (
          <span
            className={cn(
              'text-xs px-1.5 py-0.5 rounded-full shrink-0',
              executionStatus === 'running' && 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
              executionStatus === 'completed' && 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
              executionStatus === 'failed' && 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',
              executionStatus === 'pending' && 'bg-muted text-muted-foreground',
              executionStatus === 'skipped' && 'bg-muted text-muted-foreground',
            )}
          >
            {executionStatus}
          </span>
        )}
      </div>
      {jobId && (
        <p className="text-xs text-muted-foreground truncate mt-0.5">{jobId}</p>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
