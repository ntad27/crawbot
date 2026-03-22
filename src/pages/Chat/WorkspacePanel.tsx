/**
 * WorkspacePanel — VSCode-like side panel combining FileTree + FileEditor/FileViewer.
 * Rendered on the right side of the Chat page when toggled open.
 * Both the panel width and the tree/editor split are mouse-resizable.
 * Sizes persist in the Zustand store across panel open/close.
 *
 * Switches between FileEditor (for text files) and FileViewer (for images,
 * PDF, audio, video, office documents) based on the detected file view mode.
 */
import { useCallback, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useFileBrowserStore } from '@/stores/file-browser';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { FileTree } from './FileTree';
import { FileEditor } from './FileEditor';
import { FileViewer } from './FileViewer';

const MIN_PANEL_WIDTH = 300;
const MAX_PANEL_RATIO = 0.75; // max 75% of window width
const MIN_TREE_WIDTH = 120;
const MIN_EDITOR_WIDTH = 150;

export function WorkspacePanel() {
  const togglePanel = useFileBrowserStore((s) => s.togglePanel);
  const panelWidth = useFileBrowserStore((s) => s.panelWidth);
  const treeWidth = useFileBrowserStore((s) => s.treeWidth);
  const setPanelWidth = useFileBrowserStore((s) => s.setPanelWidth);
  const setTreeWidth = useFileBrowserStore((s) => s.setTreeWidth);
  const fileViewMode = useFileBrowserStore((s) => s.fileViewMode);

  const panelRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef<'panel' | 'split' | null>(null);
  const startXRef = useRef(0);
  const startValueRef = useRef(0);

  // Shared drag handlers — stored in refs to avoid circular dependency and render-time ref access
  const handlersRef = useRef({ move: (_e: MouseEvent) => {}, up: () => {} });

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      e.preventDefault();
      const dx = e.clientX - startXRef.current;

      if (draggingRef.current === 'panel') {
        const maxPanelWidth = Math.round(window.innerWidth * MAX_PANEL_RATIO);
        const next = Math.min(maxPanelWidth, Math.max(MIN_PANEL_WIDTH, startValueRef.current - dx));
        setPanelWidth(next);
      } else {
        const maxPanelWidth = Math.round(window.innerWidth * MAX_PANEL_RATIO);
        const proposed = Math.max(MIN_TREE_WIDTH, startValueRef.current + dx);
        setTreeWidth(Math.min(proposed, maxPanelWidth - MIN_EDITOR_WIDTH));
      }
    };
    const up = () => {
      draggingRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handlersRef.current.move);
      document.removeEventListener('mouseup', handlersRef.current.up);
    };
    handlersRef.current = { move, up };
  }, [setPanelWidth, setTreeWidth]);

  const startDrag = useCallback(
    (type: 'panel' | 'split', e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = type;
      startXRef.current = e.clientX;
      // When panelWidth is 0 (50% mode), read actual rendered width
      const actualPanelWidth = panelWidth || (panelRef.current?.offsetWidth ?? 600);
      startValueRef.current = type === 'panel' ? actualPanelWidth : treeWidth;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      document.addEventListener('mousemove', handlersRef.current.move);
      document.addEventListener('mouseup', handlersRef.current.up);
    },
    [panelWidth, treeWidth],
  );

  // Clamp tree width to panel width (use default 600 for 50% mode)
  const actualPanelWidth = panelWidth || 600;
  const effectiveTreeWidth = Math.min(treeWidth, actualPanelWidth - MIN_EDITOR_WIDTH);

  // Determine which content panel to render
  const isViewer = fileViewMode && fileViewMode !== 'editor';

  return (
    <div
      ref={panelRef}
      className="flex flex-col h-full shrink-0 border-l border-border bg-background relative"
      style={{ width: panelWidth ? `${panelWidth}px` : '50%' }}
    >
      {/* Panel resize handle (left edge) */}
      <div
        className={cn(
          'absolute left-0 top-0 bottom-0 w-1 cursor-col-resize z-10',
          'hover:bg-primary/30 active:bg-primary/50 transition-colors',
        )}
        onMouseDown={(e) => startDrag('panel', e)}
      />

      {/* Panel header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/40 shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Workspace
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={togglePanel}>
              <X className="h-3.5 w-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="left"><p>Close panel</p></TooltipContent>
        </Tooltip>
      </div>

      {/* Body: tree + resize handle + editor/viewer */}
      <div className="flex-1 flex min-h-0">
        {/* File tree */}
        <div
          className="shrink-0 border-r border-border overflow-hidden"
          style={{ width: `${effectiveTreeWidth}px` }}
        >
          <FileTree />
        </div>

        {/* Split resize handle */}
        <div
          className={cn(
            'w-1 shrink-0 cursor-col-resize',
            'hover:bg-primary/30 active:bg-primary/50 transition-colors',
          )}
          onMouseDown={(e) => startDrag('split', e)}
        />

        {/* File editor or viewer */}
        <div className="flex-1 min-w-0 overflow-hidden">
          {isViewer ? <FileViewer /> : <FileEditor />}
        </div>
      </div>
    </div>
  );
}
