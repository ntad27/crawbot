/**
 * Workflows Page
 * List and manage multi-step automated workflows
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Plus,
  Play,
  Edit,
  Trash2,
  RefreshCw,
  GitBranch,
  CheckCircle2,
  XCircle,
  Loader2,
  Clock,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { useWorkflowStore } from '@/stores/workflow';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime, cn } from '@/lib/utils';
import { toast } from 'sonner';
import { WorkflowEditor } from './WorkflowEditor';
import type { Workflow, WorkflowCreateInput, WorkflowUpdateInput, WorkflowStatus } from '@/types/workflow';

function statusBadgeVariant(
  status?: WorkflowStatus,
): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (status) {
    case 'completed':
      return 'default';
    case 'failed':
      return 'destructive';
    case 'running':
      return 'default';
    default:
      return 'secondary';
  }
}

function StatusIcon({ status }: { status?: WorkflowStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-3 w-3 text-green-500" />;
    case 'failed':
      return <XCircle className="h-3 w-3 text-red-500" />;
    case 'running':
      return <Loader2 className="h-3 w-3 text-blue-500 animate-spin" />;
    default:
      return null;
  }
}

interface WorkflowCardProps {
  workflow: Workflow;
  lastRunStatus?: WorkflowStatus;
  lastRunAt?: string;
  onEdit: () => void;
  onDelete: () => void;
  onRun: () => void;
  onToggle: (enabled: boolean) => void;
  onViewRuns: () => void;
}

function WorkflowCard({
  workflow,
  lastRunStatus,
  lastRunAt,
  onEdit,
  onDelete,
  onRun,
  onToggle,
  onViewRuns,
}: WorkflowCardProps) {
  const { t } = useTranslation('workflow');
  const [running, setRunning] = useState(false);

  const handleRun = async () => {
    setRunning(true);
    try {
      await onRun();
      toast.success(t('toast.started'));
    } catch (err) {
      toast.error(`${t('toast.failedStart')}: ${String(err)}`);
    } finally {
      setRunning(false);
    }
  };

  const handleDelete = () => {
    if (confirm(t('card.deleteConfirm'))) {
      onDelete();
    }
  };

  return (
    <Card className={cn('transition-colors', workflow.enabled && 'border-primary/30')}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div
              className={cn(
                'rounded-full p-2',
                workflow.enabled ? 'bg-green-100 dark:bg-green-900/30' : 'bg-muted',
              )}
            >
              <GitBranch
                className={cn(
                  'h-5 w-5',
                  workflow.enabled ? 'text-green-600' : 'text-muted-foreground',
                )}
              />
            </div>
            <div>
              <CardTitle className="text-base">{workflow.name}</CardTitle>
              {workflow.description && (
                <CardDescription className="text-xs mt-0.5">
                  {workflow.description}
                </CardDescription>
              )}
            </div>
          </div>
          <Switch checked={workflow.enabled} onCheckedChange={onToggle} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Meta row */}
        <div className="flex items-center gap-3 text-xs text-muted-foreground">
          <span>{workflow.steps.length} {t('steps')}</span>
          <span className="text-border">·</span>
          <Badge variant="outline" className="text-xs">
            {workflow.errorStrategy === 'fail-fast'
              ? t('errorStrategy.failFast')
              : workflow.errorStrategy === 'continue'
                ? t('errorStrategy.continue')
                : t('errorStrategy.saga')}
          </Badge>
          {lastRunStatus && (
            <>
              <span className="text-border">·</span>
              <div className="flex items-center gap-1">
                <StatusIcon status={lastRunStatus} />
                <Badge variant={statusBadgeVariant(lastRunStatus)} className="text-xs">
                  {t(`status.${lastRunStatus}`)}
                </Badge>
              </div>
            </>
          )}
          {lastRunAt && (
            <>
              <span className="text-border">·</span>
              <div className="flex items-center gap-1">
                <Clock className="h-3 w-3" />
                <span>{formatRelativeTime(lastRunAt)}</span>
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            disabled={running || !workflow.enabled}
            onClick={handleRun}
          >
            {running ? (
              <Loader2 className="h-3 w-3 mr-1 animate-spin" />
            ) : (
              <Play className="h-3 w-3 mr-1" />
            )}
            {t('card.run')}
          </Button>
          <Button size="sm" variant="outline" onClick={onViewRuns}>
            {t('card.viewRuns')}
          </Button>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            <Edit className="h-3 w-3" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={handleDelete}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function Workflows() {
  const { t } = useTranslation('workflow');
  const navigate = useNavigate();
  const workflows = useWorkflowStore((s) => s.workflows);
  const instances = useWorkflowStore((s) => s.instances);
  const loading = useWorkflowStore((s) => s.loading);
  const fetchWorkflows = useWorkflowStore((s) => s.fetchWorkflows);
  const createWorkflow = useWorkflowStore((s) => s.createWorkflow);
  const updateWorkflow = useWorkflowStore((s) => s.updateWorkflow);
  const deleteWorkflow = useWorkflowStore((s) => s.deleteWorkflow);
  const toggleWorkflow = useWorkflowStore((s) => s.toggleWorkflow);
  const startWorkflow = useWorkflowStore((s) => s.startWorkflow);

  const [showEditor, setShowEditor] = useState(false);
  const [editingWorkflow, setEditingWorkflow] = useState<Workflow | undefined>();

  useEffect(() => {
    fetchWorkflows();
  }, [fetchWorkflows]);

  const handleSave = async (data: WorkflowCreateInput | WorkflowUpdateInput) => {
    try {
      if (editingWorkflow) {
        await updateWorkflow(editingWorkflow.id, data as WorkflowUpdateInput);
        toast.success(t('toast.updated'));
      } else {
        await createWorkflow(data as WorkflowCreateInput);
        toast.success(t('toast.created'));
      }
      setShowEditor(false);
      setEditingWorkflow(undefined);
    } catch (err) {
      toast.error(String(err));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteWorkflow(id);
      toast.success(t('toast.deleted'));
    } catch (err) {
      toast.error(String(err));
    }
  };

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await toggleWorkflow(id, enabled);
      toast.success(enabled ? t('toast.enabled') : t('toast.disabled'));
    } catch (err) {
      toast.error(String(err));
    }
  };

  const getLastRun = (workflowId: string) => {
    const wfInstances = instances[workflowId] ?? [];
    if (wfInstances.length === 0) return undefined;
    return wfInstances.sort(
      (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    )[0];
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b p-4 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => fetchWorkflows()}
            disabled={loading}
          >
            <RefreshCw className={cn('h-4 w-4 mr-1', loading && 'animate-spin')} />
            {t('refresh')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setEditingWorkflow(undefined);
              setShowEditor(true);
            }}
          >
            <Plus className="h-4 w-4 mr-1" />
            {t('newWorkflow')}
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-4">
        {loading && workflows.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : workflows.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 text-center gap-3">
            <GitBranch className="h-12 w-12 text-muted-foreground/40" />
            <div>
              <p className="font-medium">{t('empty.title')}</p>
              <p className="text-sm text-muted-foreground mt-1">{t('empty.description')}</p>
            </div>
            <Button
              onClick={() => {
                setEditingWorkflow(undefined);
                setShowEditor(true);
              }}
            >
              <Plus className="h-4 w-4 mr-2" />
              {t('empty.create')}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {workflows.map((wf) => {
              const lastRun = getLastRun(wf.id);
              return (
                <WorkflowCard
                  key={wf.id}
                  workflow={wf}
                  lastRunStatus={lastRun?.status}
                  lastRunAt={lastRun?.startedAt}
                  onEdit={() => {
                    setEditingWorkflow(wf);
                    setShowEditor(true);
                  }}
                  onDelete={() => handleDelete(wf.id)}
                  onRun={() => startWorkflow(wf.id)}
                  onToggle={(enabled) => handleToggle(wf.id, enabled)}
                  onViewRuns={() => navigate(`/workflows/${wf.id}/runs`)}
                />
              );
            })}
          </div>
        )}
      </div>

      {/* Editor overlay */}
      {showEditor && (
        <WorkflowEditor
          workflow={editingWorkflow}
          onSave={handleSave}
          onClose={() => {
            setShowEditor(false);
            setEditingWorkflow(undefined);
          }}
        />
      )}
    </div>
  );
}

export default Workflows;
