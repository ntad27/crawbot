import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Timer } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FlowNodeData } from '../converters';
import type { WaitConfig } from '@/types/workflow';

export function WaitNode({ data, selected }: NodeProps & { data: FlowNodeData }) {
  const delayMs = (data.config as WaitConfig | undefined)?.delayMs ?? 0;
  const delaySec = Math.round(delayMs / 1000);

  return (
    <div
      className={cn(
        'min-w-[160px] rounded-lg border-2 bg-card text-card-foreground shadow-sm px-3 py-2 select-none',
        selected ? 'border-primary' : 'border-cyan-400 dark:border-cyan-500',
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-2">
        <Timer className="h-4 w-4 text-cyan-500 shrink-0" />
        <span className="text-sm font-medium truncate">{data.label || 'Wait'}</span>
      </div>
      <p className="text-xs text-muted-foreground mt-0.5">{delaySec}s</p>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
