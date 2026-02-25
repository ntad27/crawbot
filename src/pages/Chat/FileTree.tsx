/**
 * FileTree — recursive file explorer tree for the workspace panel.
 * Lazy-loads subdirectory contents on expand.
 */
import { useCallback, useState } from 'react';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  FileCode2,
  FolderOpenDot,
  RefreshCw,
  CornerDownLeft,
} from 'lucide-react';
import { useFileBrowserStore, type FileEntry } from '@/stores/file-browser';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.py', '.rs', '.go',
  '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.zsh', '.sql', '.graphql', '.vue', '.svelte',
]);

function TreeNode({ entry, depth }: { entry: FileEntry; depth: number }) {
  const expandedDirs = useFileBrowserStore((s) => s.expandedDirs);
  const selectedFile = useFileBrowserStore((s) => s.selectedFile);
  const entries = useFileBrowserStore((s) => s.entries);
  const toggleDir = useFileBrowserStore((s) => s.toggleDir);
  const selectFile = useFileBrowserStore((s) => s.selectFile);

  const isExpanded = expandedDirs.has(entry.path);
  const isSelected = selectedFile === entry.path;
  const children = entries[entry.path];

  const handleClick = useCallback(() => {
    if (entry.isDirectory) {
      toggleDir(entry.path);
    } else {
      selectFile(entry.path);
    }
  }, [entry.path, entry.isDirectory, toggleDir, selectFile]);

  const isCodeFile = entry.name.includes('.') && CODE_EXTENSIONS.has('.' + entry.name.split('.').pop()!.toLowerCase());

  return (
    <>
      <button
        onClick={handleClick}
        className={cn(
          'flex items-center w-full text-left text-sm py-1 pr-2 rounded-sm',
          'hover:bg-accent/50 transition-colors',
          isSelected && !entry.isDirectory && 'bg-accent text-accent-foreground',
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {entry.isDirectory ? (
          isExpanded
            ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {entry.isDirectory ? (
          isExpanded
            ? <FolderOpen className="h-3.5 w-3.5 shrink-0 mx-1 text-blue-400" />
            : <Folder className="h-3.5 w-3.5 shrink-0 mx-1 text-blue-400" />
        ) : isCodeFile ? (
          <FileCode2 className="h-3.5 w-3.5 shrink-0 mx-1 text-muted-foreground" />
        ) : (
          <FileText className="h-3.5 w-3.5 shrink-0 mx-1 text-muted-foreground" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>

      {entry.isDirectory && isExpanded && children && (
        <div>
          {children.map((child) => (
            <TreeNode key={child.path} entry={child} depth={depth + 1} />
          ))}
          {children.length === 0 && (
            <div
              className="text-xs text-muted-foreground/60 italic py-0.5"
              style={{ paddingLeft: `${(depth + 1) * 12 + 4 + 18}px` }}
            >
              (empty)
            </div>
          )}
        </div>
      )}
    </>
  );
}

export function FileTree() {
  const rootPath = useFileBrowserStore((s) => s.rootPath);
  const entries = useFileBrowserStore((s) => s.entries);
  const openFolder = useFileBrowserStore((s) => s.openFolder);
  const setRootPath = useFileBrowserStore((s) => s.setRootPath);
  const refreshTree = useFileBrowserStore((s) => s.refreshTree);
  const loading = useFileBrowserStore((s) => s.loading);

  const [pathInput, setPathInput] = useState(rootPath ?? '');
  const [editingPath, setEditingPath] = useState(false);

  const rootEntries = rootPath ? entries[rootPath] : undefined;

  const handlePathSubmit = () => {
    const trimmed = pathInput.trim();
    if (trimmed) {
      setRootPath(trimmed);
    }
    setEditingPath(false);
  };

  const handlePathKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handlePathSubmit();
    } else if (e.key === 'Escape') {
      setPathInput(rootPath ?? '');
      setEditingPath(false);
    }
  };

  // Sync input when rootPath changes externally
  const displayPath = editingPath ? pathInput : (rootPath ?? '');

  return (
    <div className="flex flex-col h-full">
      {/* Header with actions */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Explorer
        </span>
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={openFolder}
              >
                <FolderOpenDot className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Open Folder</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={refreshTree}
                disabled={loading}
              >
                <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Refresh</p></TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Editable path bar */}
      <div className="flex items-center gap-1 px-1.5 py-1 border-b border-border shrink-0">
        <input
          type="text"
          value={displayPath}
          onChange={(e) => { setPathInput(e.target.value); setEditingPath(true); }}
          onFocus={() => { setPathInput(rootPath ?? ''); setEditingPath(true); }}
          onBlur={handlePathSubmit}
          onKeyDown={handlePathKeyDown}
          placeholder="/path/to/folder"
          className={cn(
            'flex-1 min-w-0 text-xs bg-transparent px-1.5 py-1 rounded-sm',
            'border border-transparent focus:border-border focus:bg-muted/50',
            'text-muted-foreground focus:text-foreground',
            'outline-none font-mono',
          )}
          style={!editingPath ? { direction: 'rtl', textAlign: 'left' } : undefined}
        />
        {editingPath && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 shrink-0"
                onClick={handlePathSubmit}
              >
                <CornerDownLeft className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Go</p></TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Tree body */}
      <div className="flex-1 overflow-y-auto py-1 text-[13px]">
        {!rootPath && (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-xs gap-2 px-4 text-center">
            <Folder className="h-8 w-8 opacity-30" />
            <p>No workspace folder</p>
            <Button variant="outline" size="sm" onClick={openFolder} className="text-xs h-7">
              Open Folder
            </Button>
          </div>
        )}
        {rootPath && !rootEntries && loading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-xs">
            Loading...
          </div>
        )}
        {rootEntries?.map((entry) => (
          <TreeNode key={entry.path} entry={entry} depth={0} />
        ))}
      </div>
    </div>
  );
}
