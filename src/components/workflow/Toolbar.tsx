/**
 * Toolbar — top bar for the visual workflow editor
 */
import { useRef } from 'react';
import { Layout, CheckCircle2, Download, Upload, Save, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { validateWorkflow } from './validation';
import type { FlowNode, FlowEdge } from './converters';
import { toast } from 'sonner';

interface ToolbarProps {
  nodes: FlowNode[];
  edges: FlowEdge[];
  onAutoLayout: () => void;
  onSave: () => void;
  onCancel: () => void;
  onImport: (json: string) => void;
  readOnly?: boolean;
}

export function Toolbar({
  nodes,
  edges,
  onAutoLayout,
  onSave,
  onCancel,
  onImport,
  readOnly,
}: ToolbarProps) {
  const { t } = useTranslation('workflow');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleValidate = () => {
    const result = validateWorkflow(nodes, edges);
    if (result.valid) {
      toast.success(t('visual.validationPassed'));
    } else {
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
    }
  };

  const handleExport = () => {
    const json = JSON.stringify({ nodes, edges }, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'workflow.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result;
      if (typeof text === 'string') {
        onImport(text);
      }
    };
    reader.readAsText(file);
    // Reset file input so same file can be re-imported
    e.target.value = '';
  };

  return (
    <div className="flex items-center gap-2 px-3 py-2 border-b bg-card shrink-0">
      {!readOnly && (
        <>
          <Button variant="outline" size="sm" onClick={onAutoLayout}>
            <Layout className="h-3.5 w-3.5 mr-1.5" />
            {t('visual.autoLayout')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleValidate}>
            <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
            {t('visual.validate')}
          </Button>
          <Button variant="outline" size="sm" onClick={handleImportClick}>
            <Upload className="h-3.5 w-3.5 mr-1.5" />
            {t('visual.import')}
          </Button>
        </>
      )}
      <Button variant="outline" size="sm" onClick={handleExport}>
        <Download className="h-3.5 w-3.5 mr-1.5" />
        {t('visual.export')}
      </Button>
      <div className="flex-1" />
      <Button variant="ghost" size="sm" onClick={onCancel}>
        <X className="h-3.5 w-3.5 mr-1.5" />
        {t('editor.cancel')}
      </Button>
      {!readOnly && (
        <Button size="sm" onClick={onSave}>
          <Save className="h-3.5 w-3.5 mr-1.5" />
          {t('editor.save')}
        </Button>
      )}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}
