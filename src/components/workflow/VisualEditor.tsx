/**
 * VisualEditor — React Flow-based visual workflow editor/viewer
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useNodesState,
  useEdgesState,
  useReactFlow,
  BackgroundVariant,
  type Connection,
  type OnConnect,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

import type { Workflow, WorkflowInstance, WorkflowCreateInput, WorkflowUpdateInput } from '@/types/workflow';
import type { FlowNode, FlowEdge, FlowNodeData } from './converters';
import { workflowToFlow, flowToWorkflow } from './converters';
import { autoLayout } from './layout';
import { validateWorkflow } from './validation';
import { NodePalette } from './NodePalette';
import { PropertiesPanel } from './PropertiesPanel';
import { Toolbar } from './Toolbar';

import { StartNode } from './nodes/StartNode';
import { EndNode } from './nodes/EndNode';
import { TaskNode } from './nodes/TaskNode';
import { ConditionNode } from './nodes/ConditionNode';
import { ParallelNode } from './nodes/ParallelNode';
import { WaitNode } from './nodes/WaitNode';

const nodeTypes = {
  start: StartNode,
  end: EndNode,
  task: TaskNode,
  condition: ConditionNode,
  parallel: ParallelNode,
  wait: WaitNode,
};

let idCounter = 1;
function genId(): string {
  return `node_${Date.now()}_${idCounter++}`;
}

function defaultConfig(type: string): Record<string, unknown> {
  switch (type) {
    case 'task':
      return { jobId: '' };
    case 'condition':
      return { expression: '' };
    case 'parallel':
      return { join: 'all' };
    case 'wait':
      return { delayMs: 5000 };
    default:
      return {};
  }
}

export interface VisualEditorProps {
  workflow?: Workflow;
  instance?: WorkflowInstance;
  onSave?: (data: WorkflowCreateInput | WorkflowUpdateInput) => void;
  onCancel?: () => void;
}

interface MetaFormProps {
  name: string;
  description: string;
  errorStrategy: 'fail-fast' | 'continue' | 'saga';
  enabled: boolean;
  onChange: (meta: {
    name: string;
    description: string;
    errorStrategy: 'fail-fast' | 'continue' | 'saga';
    enabled: boolean;
  }) => void;
  disabled?: boolean;
}

function MetaForm({ name, description, errorStrategy, enabled, onChange, disabled }: MetaFormProps) {
  const { t } = useTranslation('workflow');
  return (
    <div className="flex items-end gap-3 px-3 py-2 border-b bg-card shrink-0 flex-wrap">
      <div className="flex flex-col gap-1 min-w-[180px]">
        <Label className="text-xs">{t('editor.name')}</Label>
        <Input
          value={name}
          disabled={disabled}
          placeholder={t('editor.namePlaceholder')}
          onChange={(e) => onChange({ name: e.target.value, description, errorStrategy, enabled })}
        />
      </div>
      <div className="flex flex-col gap-1 min-w-[200px]">
        <Label className="text-xs">{t('editor.description')}</Label>
        <Textarea
          className="resize-none text-xs h-8 py-1"
          rows={1}
          disabled={disabled}
          placeholder={t('editor.descriptionPlaceholder')}
          value={description}
          onChange={(e) => onChange({ name, description: e.target.value, errorStrategy, enabled })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label className="text-xs">{t('errorStrategy.label')}</Label>
        <Select
          value={errorStrategy}
          disabled={disabled}
          onChange={(e) =>
            onChange({ name, description, errorStrategy: e.target.value as typeof errorStrategy, enabled })
          }
        >
          <option value="fail-fast">{t('errorStrategy.failFast')}</option>
          <option value="continue">{t('errorStrategy.continue')}</option>
          <option value="saga">{t('errorStrategy.saga')}</option>
        </Select>
      </div>
    </div>
  );
}

function VisualEditorInner({ workflow, instance, onSave, onCancel }: VisualEditorProps) {
  const { t } = useTranslation('workflow');
  const { screenToFlowPosition } = useReactFlow();

  const readOnly = !!instance;

  const [name, setName] = useState(workflow?.name ?? '');
  const [description, setDescription] = useState(workflow?.description ?? '');
  const [errorStrategy, setErrorStrategy] = useState<'fail-fast' | 'continue' | 'saga'>(
    workflow?.errorStrategy ?? 'fail-fast',
  );
  const [enabled, setEnabled] = useState(workflow?.enabled ?? true);

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  // Initialize from workflow
  useEffect(() => {
    if (workflow) {
      const { nodes: n, edges: e } = workflowToFlow(workflow);
      const laid = autoLayout(n, e);
      setNodes(laid);
      setEdges(e);
    } else {
      // New workflow: start + end nodes
      const startNode: FlowNode = {
        id: '__start__',
        type: 'start',
        position: { x: 200, y: 0 },
        data: { label: 'Start' },
      };
      const endNode: FlowNode = {
        id: '__end__',
        type: 'end',
        position: { x: 200, y: 280 },
        data: { label: 'End' },
      };
      setNodes([startNode, endNode]);
      setEdges([]);
    }
  }, [workflow, setNodes, setEdges]);

  // Apply execution status overlay when instance provided
  useEffect(() => {
    if (!instance) return;
    setNodes((nds) =>
      nds.map((n) => {
        const state = instance.stepStates[n.id];
        if (!state) return n;
        return {
          ...n,
          data: { ...n.data, executionStatus: state.status },
        };
      }),
    );
  }, [instance, setNodes]);

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => addEdge(connection, eds));
    },
    [setEdges],
  );

  const handleAutoLayout = useCallback(() => {
    setNodes((nds) => autoLayout(nds, edges));
  }, [edges, setNodes]);

  const handleSave = useCallback(() => {
    if (!name.trim()) {
      toast.error(t('toast.nameRequired'));
      return;
    }
    const result = validateWorkflow(nodes, edges);
    if (!result.valid) {
      toast.error(
        <div className="space-y-1">
          <p className="font-medium">{t('visual.validationFailed')}</p>
          {result.errors.map((err, i) => (
            <p key={i} className="text-xs">
              • {err}
            </p>
          ))}
        </div>,
      );
      return;
    }
    const data = flowToWorkflow(nodes, edges, {
      name: name.trim(),
      description: description.trim() || undefined,
      errorStrategy,
      enabled,
    });
    onSave?.(data);
  }, [name, description, errorStrategy, enabled, nodes, edges, onSave, t]);

  const handleDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;

      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      const newNode: FlowNode = {
        id: genId(),
        type,
        position,
        data: {
          label: type.charAt(0).toUpperCase() + type.slice(1),
          stepType: type as FlowNode['data']['stepType'],
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          config: defaultConfig(type) as any,
          onError: 'fail',
        },
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [screenToFlowPosition, setNodes],
  );

  const handleNodeDataChange = useCallback(
    (nodeId: string, data: Partial<FlowNodeData>) => {
      setNodes((nds) =>
        nds.map((n) =>
          n.id === nodeId ? { ...n, data: { ...n.data, ...data } } : n,
        ),
      );
    },
    [setNodes],
  );

  const handleImport = useCallback(
    (json: string) => {
      try {
        const parsed = JSON.parse(json) as { nodes?: FlowNode[]; edges?: FlowEdge[] };
        if (!parsed.nodes || !parsed.edges) {
          toast.error(t('visual.importError'));
          return;
        }
        setNodes(parsed.nodes);
        setEdges(parsed.edges);
      } catch {
        toast.error(t('visual.importError'));
      }
    },
    [setNodes, setEdges, t],
  );

  const selectedNode = selectedNodeId ? nodes.find((n) => n.id === selectedNodeId) ?? null : null;

  return (
    <div className="flex flex-col h-full w-full">
      {/* Toolbar */}
      <Toolbar
        nodes={nodes}
        edges={edges}
        onAutoLayout={handleAutoLayout}
        onSave={handleSave}
        onCancel={onCancel ?? (() => {})}
        onImport={handleImport}
        readOnly={readOnly}
      />

      {/* Meta form (edit mode only) */}
      {!readOnly && (
        <MetaForm
          name={name}
          description={description}
          errorStrategy={errorStrategy}
          enabled={enabled}
          onChange={({ name: n, description: d, errorStrategy: es, enabled: en }) => {
            setName(n);
            setDescription(d);
            setErrorStrategy(es);
            setEnabled(en);
          }}
        />
      )}

      {/* Main content area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Node palette */}
        {!readOnly && <NodePalette />}

        {/* React Flow canvas */}
        <div className="flex-1 relative" onDragOver={handleDragOver} onDrop={handleDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={readOnly ? undefined : onNodesChange}
            onEdgesChange={readOnly ? undefined : onEdgesChange}
            onConnect={readOnly ? undefined : onConnect}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            nodeTypes={nodeTypes}
            fitView
            deleteKeyCode={readOnly ? null : 'Backspace'}
          >
            <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
            <Controls />
            <MiniMap nodeStrokeWidth={3} zoomable pannable />
          </ReactFlow>
        </div>

        {/* Properties panel */}
        {!readOnly && (
          <PropertiesPanel
            node={selectedNode}
            onChange={handleNodeDataChange}
            disabled={readOnly}
          />
        )}
      </div>
    </div>
  );
}

export function VisualEditor(props: VisualEditorProps) {
  return (
    <ReactFlowProvider>
      <VisualEditorInner {...props} />
    </ReactFlowProvider>
  );
}
