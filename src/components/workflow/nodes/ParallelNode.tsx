import { Handle, Position, type NodeProps } from '@xyflow/react';
import { GitFork } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { FlowNodeData } from '../converters';
import type { ParallelConfig } from '@/types/workflow';
import { useTranslation } from 'react-i18next';

export function ParallelNode({ data, selected }: NodeProps & { data: FlowNodeData }) {
  const { t } = useTranslation('workflow');
  const join = (data.config as ParallelConfig | undefined)?.join ?? 'all';

  return (
    <div
      className={cn(
        'min-w-[160px] rounded-lg border-2 bg-card text-card-foreground shadow-sm px-3 py-2 select-none',
        selected ? 'border-primary' : 'border-purple-400 dark:border-purple-500',
      )}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-2">
        <GitFork className="h-4 w-4 text-purple-500 shrink-0" />
        <span className="text-sm font-medium truncate">{data.label || 'Parallel'}</span>
      </div>
      <p className="text-xs text-muted-foreground mt-0.5">
        {join === 'all' ? t('visual.joinAll') : t('visual.joinAny')}
      </p>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
