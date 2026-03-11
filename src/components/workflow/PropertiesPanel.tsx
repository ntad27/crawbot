/**
 * PropertiesPanel — right sidebar for editing selected node properties
 */
import { useTranslation } from 'react-i18next';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select } from '@/components/ui/select';
import type { FlowNode, FlowNodeData } from './converters';
import type {
  TaskConfig,
  ConditionConfig,
  ParallelConfig,
  WaitConfig,
  WorkflowStep,
} from '@/types/workflow';
import { useCronStore } from '@/stores/cron';

interface PropertiesPanelProps {
  node: FlowNode | null;
  onChange: (nodeId: string, data: Partial<FlowNodeData>) => void;
  disabled?: boolean;
}

export function PropertiesPanel({ node, onChange, disabled }: PropertiesPanelProps) {
  const { t } = useTranslation('workflow');
  const jobs = useCronStore((s) => s.jobs);

  if (!node || node.id === '__start__' || node.id === '__end__') {
    return (
      <div className="flex items-center justify-center p-4 border-l bg-card w-56 shrink-0">
        <p className="text-xs text-muted-foreground text-center">{t('visual.selectNode')}</p>
      </div>
    );
  }

  const data = node.data;

  const updateData = (partial: Partial<FlowNodeData>) => {
    onChange(node.id, partial);
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateConfig = (partial: Record<string, any>) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateData({ config: { ...(data.config as Record<string, any>), ...partial } as WorkflowStep['config'] });
  };

  return (
    <div className="flex flex-col gap-3 p-3 border-l bg-card w-56 shrink-0 overflow-y-auto">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {t('visual.properties')}
      </p>

      {/* Label */}
      <div className="space-y-1">
        <Label className="text-xs">{t('editor.stepLabel')}</Label>
        <Input
          value={data.label}
          disabled={disabled}
          placeholder={t('editor.stepLabelPlaceholder')}
          onChange={(e) => updateData({ label: e.target.value })}
        />
      </div>

      {/* Type-specific */}
      {node.type === 'task' && (
        <div className="space-y-1">
          <Label className="text-xs">{t('editor.taskJob')}</Label>
          <Select
            value={(data.config as TaskConfig | undefined)?.jobId ?? ''}
            disabled={disabled}
            onChange={(e) => updateConfig({ jobId: e.target.value })}
          >
            <option value="">{t('editor.taskJobPlaceholder')}</option>
            {jobs.map((job) => (
              <option key={job.id} value={job.id}>
                {job.name}
              </option>
            ))}
          </Select>
        </div>
      )}

      {node.type === 'condition' && (
        <div className="space-y-1">
          <Label className="text-xs">{t('editor.conditionExpr')}</Label>
          <Textarea
            className="font-mono text-xs resize-none"
            rows={3}
            disabled={disabled}
            value={(data.config as ConditionConfig | undefined)?.expression ?? ''}
            placeholder={t('editor.conditionExprPlaceholder')}
            onChange={(e) => updateConfig({ expression: e.target.value })}
          />
          <p className="text-xs text-muted-foreground">{t('editor.conditionExprHelp')}</p>
        </div>
      )}

      {node.type === 'parallel' && (
        <div className="space-y-1">
          <Label className="text-xs">{t('editor.parallelJoin')}</Label>
          <Select
            value={(data.config as ParallelConfig | undefined)?.join ?? 'all'}
            disabled={disabled}
            onChange={(e) => updateConfig({ join: e.target.value as 'all' | 'any' })}
          >
            <option value="all">{t('editor.parallelJoinAll')}</option>
            <option value="any">{t('editor.parallelJoinAny')}</option>
          </Select>
        </div>
      )}

      {node.type === 'wait' && (
        <div className="space-y-1">
          <Label className="text-xs">{t('editor.waitDelay')}</Label>
          <Input
            type="number"
            min={1}
            disabled={disabled}
            value={Math.round(((data.config as WaitConfig | undefined)?.delayMs ?? 0) / 1000)}
            onChange={(e) => updateConfig({ delayMs: Number(e.target.value) * 1000 })}
          />
        </div>
      )}

      {/* Error strategy */}
      {!disabled && (
        <>
          <div className="space-y-1">
            <Label className="text-xs">{t('onError.label')}</Label>
            <Select
              value={data.onError ?? 'fail'}
              onChange={(e) =>
                updateData({ onError: e.target.value as WorkflowStep['onError'] })
              }
            >
              <option value="fail">{t('onError.fail')}</option>
              <option value="retry">{t('onError.retry')}</option>
              <option value="skip">{t('onError.skip')}</option>
              <option value="compensate">{t('onError.compensate')}</option>
            </Select>
          </div>

          {data.onError === 'retry' && (
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-xs">{t('editor.maxRetries')}</Label>
                <Input
                  type="number"
                  min={1}
                  max={10}
                  value={data.retryPolicy?.maxRetries ?? 3}
                  onChange={(e) =>
                    updateData({
                      retryPolicy: {
                        maxRetries: Number(e.target.value),
                        backoffMs: data.retryPolicy?.backoffMs ?? 1000,
                      },
                    })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('editor.backoffMs')}</Label>
                <Input
                  type="number"
                  min={100}
                  step={100}
                  value={data.retryPolicy?.backoffMs ?? 1000}
                  onChange={(e) =>
                    updateData({
                      retryPolicy: {
                        maxRetries: data.retryPolicy?.maxRetries ?? 3,
                        backoffMs: Number(e.target.value),
                      },
                    })
                  }
                />
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
