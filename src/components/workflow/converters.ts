/**
 * Converters between Workflow domain model and React Flow graph model
 */
import type { Node, Edge } from '@xyflow/react';
import type {
  Workflow,
  WorkflowStep,
  WorkflowEdge,
  WorkflowCreateInput,
  WorkflowUpdateInput,
  TaskConfig,
  ConditionConfig,
  ParallelConfig,
  WaitConfig,
} from '@/types/workflow';

export type FlowNodeData = {
  stepId?: string;
  label: string;
  stepType?: WorkflowStep['type'];
  config?: TaskConfig | ConditionConfig | ParallelConfig | WaitConfig;
  onError?: WorkflowStep['onError'];
  retryPolicy?: WorkflowStep['retryPolicy'];
  compensateJobId?: string;
};

export type FlowNode = Node<FlowNodeData>;
export type FlowEdge = Edge;

const DEFAULT_X = 200;
const STEP_SPACING_Y = 140;

export function workflowToFlow(workflow: Workflow): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];

  // Virtual start node
  nodes.push({
    id: '__start__',
    type: 'start',
    position: { x: DEFAULT_X, y: 0 },
    data: { label: 'Start' },
  });

  // Step nodes
  workflow.steps.forEach((step, idx) => {
    nodes.push({
      id: step.id,
      type: step.type,
      position: step.position ?? { x: DEFAULT_X, y: (idx + 1) * STEP_SPACING_Y },
      data: {
        stepId: step.id,
        label: step.label || step.type,
        stepType: step.type,
        config: step.config,
        onError: step.onError,
        retryPolicy: step.retryPolicy,
        compensateJobId: step.compensateJobId,
      },
    });
  });

  // Virtual end node
  const endY = (workflow.steps.length + 1) * STEP_SPACING_Y;
  nodes.push({
    id: '__end__',
    type: 'end',
    position: { x: DEFAULT_X, y: endY },
    data: { label: 'End' },
  });

  // Edges
  workflow.edges.forEach((we) => {
    edges.push({
      id: `${we.from}->${we.to}`,
      source: we.from,
      target: we.to,
      label: we.condition,
      animated: false,
    });
  });

  return { nodes, edges };
}

export function flowToWorkflow(
  nodes: FlowNode[],
  edges: FlowEdge[],
  meta: {
    name: string;
    description?: string;
    errorStrategy: 'fail-fast' | 'continue' | 'saga';
    enabled?: boolean;
  },
): WorkflowCreateInput | WorkflowUpdateInput {
  const steps: WorkflowStep[] = nodes
    .filter((n) => n.id !== '__start__' && n.id !== '__end__')
    .map((n) => ({
      id: n.id,
      type: (n.data.stepType ?? n.type ?? 'task') as WorkflowStep['type'],
      label: n.data.label,
      config: (n.data.config ?? { jobId: '' }) as WorkflowStep['config'],
      onError: n.data.onError ?? 'fail',
      retryPolicy: n.data.retryPolicy,
      compensateJobId: n.data.compensateJobId,
      position: n.position,
    }));

  const workflowEdges: WorkflowEdge[] = edges.map((e) => ({
    from: e.source,
    to: e.target,
    condition: typeof e.label === 'string' ? e.label : undefined,
  }));

  return {
    name: meta.name,
    description: meta.description,
    errorStrategy: meta.errorStrategy,
    enabled: meta.enabled ?? true,
    steps,
    edges: workflowEdges,
  };
}
