/**
 * NodePalette — left sidebar with draggable node type items
 */
import { GitBranch, GitFork, Timer, CheckSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { StepType } from '@/types/workflow';

interface PaletteItem {
  type: StepType;
  icon: React.ReactNode;
  labelKey: string;
  colorClass: string;
}

const PALETTE_ITEMS: PaletteItem[] = [
  {
    type: 'task',
    icon: <CheckSquare className="h-4 w-4" />,
    labelKey: 'visual.nodeTask',
    colorClass: 'border-border hover:border-primary',
  },
  {
    type: 'condition',
    icon: <GitBranch className="h-4 w-4" />,
    labelKey: 'visual.nodeCondition',
    colorClass: 'border-amber-400 hover:border-amber-500 dark:border-amber-500',
  },
  {
    type: 'parallel',
    icon: <GitFork className="h-4 w-4" />,
    labelKey: 'visual.nodeParallel',
    colorClass: 'border-purple-400 hover:border-purple-500 dark:border-purple-500',
  },
  {
    type: 'wait',
    icon: <Timer className="h-4 w-4" />,
    labelKey: 'visual.nodeWait',
    colorClass: 'border-cyan-400 hover:border-cyan-500 dark:border-cyan-500',
  },
];

interface NodePaletteProps {
  disabled?: boolean;
}

export function NodePalette({ disabled }: NodePaletteProps) {
  const { t } = useTranslation('workflow');

  const onDragStart = (event: React.DragEvent<HTMLDivElement>, nodeType: StepType) => {
    event.dataTransfer.setData('application/reactflow', nodeType);
    event.dataTransfer.effectAllowed = 'move';
  };

  return (
    <div className="flex flex-col gap-1 p-3 border-r bg-card w-40 shrink-0">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
        {t('visual.palette')}
      </p>
      {PALETTE_ITEMS.map((item) => (
        <div
          key={item.type}
          draggable={!disabled}
          onDragStart={(e) => onDragStart(e, item.type)}
          className={cn(
            'flex items-center gap-2 rounded-md border px-3 py-2 text-sm cursor-grab select-none',
            'bg-background transition-colors',
            item.colorClass,
            disabled && 'opacity-50 cursor-not-allowed',
          )}
        >
          {item.icon}
          <span>{t(item.labelKey)}</span>
        </div>
      ))}
    </div>
  );
}
