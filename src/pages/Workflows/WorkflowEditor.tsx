/**
 * WorkflowEditor
 * Full-screen visual workflow editor overlay built on React Flow
 */
import type { Workflow, WorkflowCreateInput, WorkflowUpdateInput } from '@/types/workflow';
import { VisualEditor } from '@/components/workflow/VisualEditor';

interface WorkflowEditorProps {
  workflow?: Workflow;
  onSave: (data: WorkflowCreateInput | WorkflowUpdateInput) => void;
  onClose: () => void;
}

export function WorkflowEditor({ workflow, onSave, onClose }: WorkflowEditorProps) {
  return (
    <div className="fixed inset-0 z-50 bg-background flex flex-col" onClick={(e) => e.stopPropagation()}>
      <VisualEditor workflow={workflow} onSave={onSave} onCancel={onClose} />
    </div>
  );
}
