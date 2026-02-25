/**
 * FileEditor — file content viewer/editor with save support.
 * Uses a monospace textarea for editing; Ctrl/Cmd+S to save.
 */
import { useEffect, useCallback, useRef } from 'react';
import { Save, X, FileText, FileWarning } from 'lucide-react';
import { useFileBrowserStore } from '@/stores/file-browser';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.mp3', '.mp4', '.wav', '.ogg', '.webm', '.avi', '.mov',
  '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
]);

function isBinaryFile(filePath: string): boolean {
  const ext = filePath.includes('.') ? '.' + filePath.split('.').pop()!.toLowerCase() : '';
  return BINARY_EXTENSIONS.has(ext);
}

function getFileName(filePath: string): string {
  return filePath.split('/').pop() ?? filePath;
}

export function FileEditor() {
  const selectedFile = useFileBrowserStore((s) => s.selectedFile);
  const fileContent = useFileBrowserStore((s) => s.fileContent);
  const fileDirty = useFileBrowserStore((s) => s.fileDirty);
  const fileLoading = useFileBrowserStore((s) => s.fileLoading);
  const updateContent = useFileBrowserStore((s) => s.updateContent);
  const saveFile = useFileBrowserStore((s) => s.saveFile);
  const closeFile = useFileBrowserStore((s) => s.closeFile);

  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Keyboard shortcut: Ctrl/Cmd+S to save
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        if (fileDirty) saveFile();
      }
    },
    [fileDirty, saveFile],
  );

  // Also listen globally when panel is focused
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        if (selectedFile && fileDirty) {
          e.preventDefault();
          saveFile();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [selectedFile, fileDirty, saveFile]);

  // No file selected
  if (!selectedFile) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-2">
        <FileText className="h-10 w-10 opacity-20" />
        <p className="text-xs">Select a file to view</p>
      </div>
    );
  }

  // Binary file
  if (isBinaryFile(selectedFile)) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-2">
        <FileWarning className="h-10 w-10 opacity-30" />
        <p className="text-xs font-medium">{getFileName(selectedFile)}</p>
        <p className="text-xs opacity-60">Binary file — cannot preview</p>
      </div>
    );
  }

  // Loading
  if (fileLoading) {
    return (
      <div className="flex items-center justify-center h-full text-muted-foreground text-xs">
        Loading...
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" onKeyDown={handleKeyDown}>
      {/* Tab bar */}
      <div className="flex items-center justify-between px-2 py-1 border-b border-border shrink-0 bg-muted/30">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className={cn(
            'text-xs truncate max-w-[200px]',
            fileDirty && 'italic',
          )}>
            {getFileName(selectedFile)}
          </span>
          {fileDirty && (
            <span className="w-2 h-2 rounded-full bg-orange-400 shrink-0" title="Unsaved changes" />
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {fileDirty && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6"
                  onClick={saveFile}
                >
                  <Save className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom"><p>Save (Ctrl+S)</p></TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={closeFile}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Close</p></TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Editor area */}
      <textarea
        ref={textareaRef}
        value={fileContent ?? ''}
        onChange={(e) => updateContent(e.target.value)}
        className={cn(
          'flex-1 w-full resize-none p-3 bg-background text-sm',
          'font-mono leading-relaxed',
          'focus:outline-none',
          'selection:bg-primary/20',
        )}
        spellCheck={false}
      />
    </div>
  );
}
