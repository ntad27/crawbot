/**
 * WorkflowRunView
 * Timeline/list view of a workflow's run instances and their step states
 */
import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Clock,
  SkipForward,
  Loader2,
  Circle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { useWorkflowStore } from '@/stores/workflow';
import { useTranslation } from 'react-i18next';
import { formatRelativeTime, cn } from '@/lib/utils';
import type { WorkflowStatus, StepStatus, WorkflowInstance, Workflow } from '@/types/workflow';

function statusColor(status: WorkflowStatus | StepStatus): string {
  switch (status) {
    case 'completed':
      return 'text-green-500';
    case 'failed':
      return 'text-red-500';
    case 'running':
      return 'text-blue-500';
    case 'cancelled':
      return 'text-orange-400';
    case 'skipped':
      return 'text-muted-foreground';
    case 'pending':
    default:
      return 'text-muted-foreground';
  }
}

function statusBadgeVariant(
  status: WorkflowStatus | StepStatus,
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

function StepStatusIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-4 w-4 text-green-500" />;
    case 'failed':
      return <XCircle className="h-4 w-4 text-red-500" />;
    case 'running':
      return <Loader2 className="h-4 w-4 text-blue-500 animate-spin" />;
    case 'skipped':
      return <SkipForward className="h-4 w-4 text-muted-foreground" />;
    case 'pending':
    default:
      return <Circle className="h-4 w-4 text-muted-foreground" />;
  }
}

function durationMs(startedAt?: string, completedAt?: string): string {
  if (!startedAt) return '—';
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

interface InstanceCardProps {
  instance: WorkflowInstance;
  workflow: Workflow;
}

function InstanceCard({ instance, workflow }: InstanceCardProps) {
  const { t } = useTranslation('workflow');

  return (
    <Card className="mb-4">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {t('runView.started')}: {formatRelativeTime(instance.startedAt)}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Badge variant={statusBadgeVariant(instance.status)}>
              {t(`status.${instance.status}`)}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {t('runView.duration')}: {durationMs(instance.startedAt, instance.completedAt)}
            </span>
          </div>
        </div>
        {instance.error && (
          <p className="text-xs text-red-500 mt-1">{instance.error}</p>
        )}
      </CardHeader>
      <CardContent>
        <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
          {t('runView.stepTimeline')}
        </p>
        <div className="space-y-2">
          {workflow.steps.map((step, idx) => {
            const state = instance.stepStates[step.id];
            if (!state) return null;
            return (
              <div
                key={step.id}
                className="flex items-start gap-3 rounded-md border p-3 bg-muted/30"
              >
                <div className="mt-0.5">
                  <StepStatusIcon status={state.status} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium truncate">
                      {idx + 1}. {step.label}
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {state.retryCount > 0 && (
                        <span className="text-xs text-muted-foreground">
                          {t('runView.retries')}: {state.retryCount}
                        </span>
                      )}
                      <span className={cn('text-xs font-medium', statusColor(state.status))}>
                        {t(`status.${state.status}`)}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {durationMs(state.startedAt, state.completedAt)}
                      </span>
                    </div>
                  </div>
                  {state.error && (
                    <p className="text-xs text-red-500 mt-1 break-all">{state.error}</p>
                  )}
                  {state.output != null && state.status === 'completed' && (
                    <details className="mt-1">
                      <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                        {t('runView.output')}
                      </summary>
                      <pre className="text-xs bg-muted rounded p-2 mt-1 overflow-auto max-h-32 whitespace-pre-wrap break-all">
                        {JSON.stringify(state.output, null, 2)}
                      </pre>
                    </details>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

export function WorkflowRunView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation('workflow');
  const workflows = useWorkflowStore((s) => s.workflows);
  const instances = useWorkflowStore((s) => s.instances);
  const fetchInstances = useWorkflowStore((s) => s.fetchInstances);
  const fetchWorkflows = useWorkflowStore((s) => s.fetchWorkflows);

  const workflow = workflows.find((w) => w.id === id);
  const workflowInstances = id ? (instances[id] ?? []) : [];

  useEffect(() => {
    if (workflows.length === 0) fetchWorkflows();
    if (id) fetchInstances(id);
  }, [id, fetchWorkflows, fetchInstances, workflows.length]);

  if (!workflow) {
    return (
      <div className="flex-1 p-6">
        <Button variant="ghost" size="sm" onClick={() => navigate('/workflows')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('title')}
        </Button>
        <p className="mt-4 text-muted-foreground">Workflow not found.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="border-b p-4 flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate('/workflows')}>
          <ArrowLeft className="h-4 w-4 mr-2" />
          {t('title')}
        </Button>
        <div>
          <h1 className="text-lg font-semibold">{workflow.name}</h1>
          <p className="text-sm text-muted-foreground">{t('runView.title')}</p>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {workflowInstances.length === 0 ? (
          <p className="text-center text-muted-foreground mt-12">{t('runView.noRuns')}</p>
        ) : (
          workflowInstances.map((instance) => (
            <InstanceCard key={instance.id} instance={instance} workflow={workflow} />
          ))
        )}
      </div>
    </div>
  );
}
