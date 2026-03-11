import { Handle, Position, type NodeProps } from '@xyflow/react';
import { cn } from '@/lib/utils';
import type { FlowNodeData } from '../converters';
import type { ConditionConfig } from '@/types/workflow';

export function ConditionNode({ data, selected }: NodeProps & { data: FlowNodeData }) {
  const expression = (data.config as ConditionConfig | undefined)?.expression ?? '';

  return (
    <div
      className={cn(
        'relative flex items-center justify-center select-none',
        'w-[120px] h-[120px]',
      )}
    >
      {/* Diamond shape via rotated square */}
      <div
        className={cn(
          'absolute inset-0 rounded-sm border-2 bg-amber-50 dark:bg-amber-900/20 shadow-sm',
          'rotate-45',
          selected ? 'border-primary' : 'border-amber-400 dark:border-amber-500',
        )}
      />
      {/* Content counter-rotated */}
      <div className="relative z-10 flex flex-col items-center justify-center px-2 text-center max-w-[80px]">
        <span className="text-xs font-semibold text-amber-700 dark:text-amber-300 leading-tight break-all line-clamp-3">
          {expression || 'condition'}
        </span>
      </div>

      <Handle type="target" position={Position.Top} style={{ top: 0 }} />
      {/* false branch — left */}
      <Handle
        type="source"
        position={Position.Left}
        id="false"
        style={{ left: 0 }}
      />
      {/* true branch — right */}
      <Handle
        type="source"
        position={Position.Right}
        id="true"
        style={{ right: 0 }}
      />
    </div>
  );
}
