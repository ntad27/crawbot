/**
 * WorkflowEditor
 * Overlay dialog for creating/editing workflows with sequential step builder
 */
import { useState, useEffect } from 'react';
import { Plus, Trash2, ChevronUp, ChevronDown, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { useTranslation } from 'react-i18next';
import { useCronStore } from '@/stores/cron';
import type {
  Workflow,
  WorkflowStep,
  WorkflowEdge,
  WorkflowCreateInput,
  WorkflowUpdateInput,
  StepType,
  TaskConfig,
  ConditionConfig,
  ParallelConfig,
  WaitConfig,
} from '@/types/workflow';

interface WorkflowEditorProps {
  workflow?: Workflow;
  onSave: (data: WorkflowCreateInput | WorkflowUpdateInput) => void;
  onClose: () => void;
}

function genId(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

// Build linear edges from an ordered step list
function buildLinearEdges(steps: WorkflowStep[]): WorkflowEdge[] {
  if (steps.length === 0) return [];
  const edges: WorkflowEdge[] = [];
  edges.push({ from: '__start__', to: steps[0].id });
  for (let i = 0; i < steps.length - 1; i++) {
    edges.push({ from: steps[i].id, to: steps[i + 1].id });
  }
  edges.push({ from: steps[steps.length - 1].id, to: '__end__' });
  return edges;
}

function newStep(type: StepType): WorkflowStep {
  let config: TaskConfig | ConditionConfig | ParallelConfig | WaitConfig;
  switch (type) {
    case 'task':
      config = { jobId: '' };
      break;
    case 'condition':
      config = { expression: '' };
      break;
    case 'parallel':
      config = { join: 'all' };
      break;
    case 'wait':
      config = { delayMs: 5000 };
      break;
  }
  return {
    id: genId(),
    type,
    label: '',
    config,
    onError: 'fail',
  };
}

interface StepEditorProps {
  step: WorkflowStep;
  index: number;
  total: number;
  onUpdate: (updated: WorkflowStep) => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function StepEditor({
  step,
  index,
  total,
  onUpdate,
  onDelete,
  onMoveUp,
  onMoveDown,
}: StepEditorProps) {
  const { t } = useTranslation('workflow');
  const jobs = useCronStore((s) => s.jobs);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const updateConfig = (partial: Record<string, any>) => {
    onUpdate({ ...step, config: { ...step.config, ...partial } as typeof step.config });
  };

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground font-medium w-5 shrink-0">
          {index + 1}.
        </span>

        <div className="flex-1 grid grid-cols-2 gap-2">
          <Input
            placeholder={t('editor.stepLabelPlaceholder')}
            value={step.label}
            onChange={(e) => onUpdate({ ...step, label: e.target.value })}
          />
          <Select
            value={step.type}
            onChange={(e) => {
              const newS = newStep(e.target.value as StepType);
              onUpdate({ ...newS, id: step.id, label: step.label });
            }}
          >
            <option value="task">{t('stepType.task')}</option>
            <option value="condition">{t('stepType.condition')}</option>
            <option value="parallel">{t('stepType.parallel')}</option>
            <option value="wait">{t('stepType.wait')}</option>
          </Select>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={index === 0}
            onClick={onMoveUp}
          >
            <ChevronUp className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            disabled={index === total - 1}
            onClick={onMoveDown}
          >
            <ChevronDown className="h-3 w-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Type-specific config */}
      {step.type === 'task' && (
        <div className="pl-7">
          <Label className="text-xs">{t('editor.taskJob')}</Label>
          <Select
            className="mt-1"
            value={(step.config as TaskConfig).jobId}
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

      {step.type === 'condition' && (
        <div className="pl-7">
          <Label className="text-xs">{t('editor.conditionExpr')}</Label>
          <Input
            className="mt-1 font-mono text-xs"
            placeholder={t('editor.conditionExprPlaceholder')}
            value={(step.config as ConditionConfig).expression}
            onChange={(e) => updateConfig({ expression: e.target.value })}
          />
          <p className="text-xs text-muted-foreground mt-1">{t('editor.conditionExprHelp')}</p>
        </div>
      )}

      {step.type === 'parallel' && (
        <div className="pl-7">
          <Label className="text-xs">{t('editor.parallelJoin')}</Label>
          <Select
            className="mt-1"
            value={(step.config as ParallelConfig).join}
            onChange={(e) => updateConfig({ join: e.target.value as 'all' | 'any' })}
          >
            <option value="all">{t('editor.parallelJoinAll')}</option>
            <option value="any">{t('editor.parallelJoinAny')}</option>
          </Select>
        </div>
      )}

      {step.type === 'wait' && (
        <div className="pl-7">
          <Label className="text-xs">{t('editor.waitDelay')}</Label>
          <Input
            className="mt-1"
            type="number"
            min={1}
            value={Math.round((step.config as WaitConfig).delayMs / 1000)}
            onChange={(e) => updateConfig({ delayMs: Number(e.target.value) * 1000 })}
          />
        </div>
      )}

      {/* Error strategy row */}
      <div className="pl-7 grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs">{t('onError.label')}</Label>
          <Select
            className="mt-1"
            value={step.onError}
            onChange={(e) =>
              onUpdate({ ...step, onError: e.target.value as WorkflowStep['onError'] })
            }
          >
            <option value="fail">{t('onError.fail')}</option>
            <option value="retry">{t('onError.retry')}</option>
            <option value="skip">{t('onError.skip')}</option>
            <option value="compensate">{t('onError.compensate')}</option>
          </Select>
        </div>

        {step.onError === 'retry' && (
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">{t('editor.maxRetries')}</Label>
              <Input
                className="mt-1"
                type="number"
                min={1}
                max={10}
                value={step.retryPolicy?.maxRetries ?? 3}
                onChange={(e) =>
                  onUpdate({
                    ...step,
                    retryPolicy: {
                      maxRetries: Number(e.target.value),
                      backoffMs: step.retryPolicy?.backoffMs ?? 1000,
                    },
                  })
                }
              />
            </div>
            <div>
              <Label className="text-xs">{t('editor.backoffMs')}</Label>
              <Input
                className="mt-1"
                type="number"
                min={100}
                step={100}
                value={step.retryPolicy?.backoffMs ?? 1000}
                onChange={(e) =>
                  onUpdate({
                    ...step,
                    retryPolicy: {
                      maxRetries: step.retryPolicy?.maxRetries ?? 3,
                      backoffMs: Number(e.target.value),
                    },
                  })
                }
              />
            </div>
          </div>
        )}

        {step.onError === 'compensate' && (
          <div>
            <Label className="text-xs">{t('editor.compensateJob')}</Label>
            <Select
              className="mt-1"
              value={step.compensateJobId ?? ''}
              onChange={(e) =>
                onUpdate({ ...step, compensateJobId: e.target.value || undefined })
              }
            >
              <option value="">{t('editor.compensateJobPlaceholder')}</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.name}
                </option>
              ))}
            </Select>
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkflowEditor({ workflow, onSave, onClose }: WorkflowEditorProps) {
  const { t } = useTranslation('workflow');
  const fetchJobs = useCronStore((s) => s.fetchJobs);

  const [name, setName] = useState(workflow?.name ?? '');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);
  const [errorStrategy, setErrorStrategy] = useState<'fail-fast' | 'continue' | 'saga'>(
    workflow?.errorStrategy ?? 'fail-fast',
  );
  const [steps, setSteps] = useState<WorkflowStep[]>(workflow ? [...workflow.steps] : []);

  useEffect(() => {
    fetchJobs();
  }, [fetchJobs]);

  const addStep = () => {
    setSteps((prev) => [...prev, newStep('task')]);
  };

  const updateStep = (idx: number, updated: WorkflowStep) => {
    setSteps((prev) => prev.map((s, i) => (i === idx ? updated : s)));
  };

  const deleteStep = (idx: number) => {
    setSteps((prev) => prev.filter((_, i) => i !== idx));
  };

  const moveStep = (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= steps.length) return;
    setSteps((prev) => {
      const arr = [...prev];
      [arr[idx], arr[newIdx]] = [arr[newIdx], arr[idx]];
      return arr;
    });
  };

  const handleSave = () => {
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const edges = buildLinearEdges(steps);
    onSave({
      name: trimmedName,
      description: description.trim() || undefined,
      enabled,
      errorStrategy,
      steps,
      edges,
    });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <Card
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>
              {workflow ? t('editor.editTitle') : t('editor.createTitle')}
            </CardTitle>
            <CardDescription>{t('subtitle')}</CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Name & description */}
          <div className="space-y-2">
            <Label>{t('editor.name')}</Label>
            <Input
              placeholder={t('editor.namePlaceholder')}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>{t('editor.description')}</Label>
            <Textarea
              className="resize-none"
              rows={2}
              placeholder={t('editor.descriptionPlaceholder')}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          {/* Error strategy + enabled */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label>{t('errorStrategy.label')}</Label>
              <Select
                value={errorStrategy}
                onChange={(e) =>
                  setErrorStrategy(e.target.value as 'fail-fast' | 'continue' | 'saga')
                }
              >
                <option value="fail-fast">{t('errorStrategy.failFast')}</option>
                <option value="continue">{t('errorStrategy.continue')}</option>
                <option value="saga">{t('errorStrategy.saga')}</option>
              </Select>
            </div>
            <div className="flex items-end gap-2 pb-1">
              <Switch
                id="wf-enabled"
                checked={enabled}
                onCheckedChange={setEnabled}
              />
              <Label htmlFor="wf-enabled">{t('editor.enableImmediately')}</Label>
            </div>
          </div>

          {/* Steps */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t('editor.steps')}</Label>
              <Button variant="outline" size="sm" onClick={addStep}>
                <Plus className="h-3 w-3 mr-1" />
                {t('editor.addStep')}
              </Button>
            </div>
            {steps.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4 border rounded-md">
                {t('editor.noSteps')}
              </p>
            ) : (
              <div className="space-y-2">
                {steps.map((step, idx) => (
                  <StepEditor
                    key={step.id}
                    step={step}
                    index={idx}
                    total={steps.length}
                    onUpdate={(updated) => updateStep(idx, updated)}
                    onDelete={() => deleteStep(idx)}
                    onMoveUp={() => moveStep(idx, -1)}
                    onMoveDown={() => moveStep(idx, 1)}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Footer buttons */}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={onClose}>
              {t('editor.cancel')}
            </Button>
            <Button onClick={handleSave} disabled={!name.trim()}>
              {t('editor.save')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
