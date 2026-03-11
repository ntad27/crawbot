/**
 * FileTree — recursive file explorer tree for the workspace panel.
 * Supports multi-select (Ctrl/Cmd+click, Shift+click), drag-and-drop
 * to move files/folders, and right-click context menu with file operations.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowUp,
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileText,
  FileCode2,
  FilePlus,
  FolderPlus,
  FolderOpenDot,
  RefreshCw,
  CornerDownLeft,
  Download,
  Upload,
  Home,
} from 'lucide-react';
import { toast } from 'sonner';
import { useFileBrowserStore, type FileEntry } from '@/stores/file-browser';
import { useChatStore } from '@/stores/chat';
import { useAgentsStore } from '@/stores/agents';
import { resolveAgentWorkspace } from '@/types/agent';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

/* ── Types ── */

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDirectory: boolean;
}

interface FileClipboard {
  paths: string[];
  mode: 'copy' | 'cut';
}

/* ── Helpers ── */

const ipc = window.electron.ipcRenderer;

const menuItemClass =
  'flex w-full items-center rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground';
const menuItemDisabledClass =
  'flex w-full items-center rounded-sm px-2 py-1.5 text-sm text-muted-foreground/50 cursor-default';
const separatorClass = 'my-1 h-px bg-border';

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.py', '.rs', '.go',
  '.css', '.scss', '.html', '.xml', '.yaml', '.yml', '.toml',
  '.sh', '.bash', '.zsh', '.sql', '.graphql', '.vue', '.svelte',
]);

/**
 * Build a flat ordered list of visible paths from the tree
 * (used for Shift+click range selection).
 */
function getVisiblePaths(
  rootEntries: FileEntry[] | undefined,
  entries: Record<string, FileEntry[]>,
  expandedDirs: Set<string>,
): string[] {
  const result: string[] = [];
  function walk(items: FileEntry[] | undefined) {
    if (!items) return;
    for (const item of items) {
      result.push(item.path);
      if (item.isDirectory && expandedDirs.has(item.path)) {
        walk(entries[item.path]);
      }
    }
  }
  walk(rootEntries);
  return result;
}

/* ── Context menu component ── */

function FileContextMenu({
  menu,
  onClose,
  fileClipboard,
  selectedCount,
  onCut,
  onCopy,
  onPaste,
  onDelete,
  onNewFile,
  onNewFolder,
}: {
  menu: ContextMenuState;
  onClose: () => void;
  fileClipboard: FileClipboard | null;
  selectedCount: number;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onDelete: () => void;
  onNewFile: () => void;
  onNewFolder: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key === 'Escape') return onClose();
      if (e instanceof MouseEvent && ref.current && !ref.current.contains(e.target as Node))
        onClose();
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', handler);
    };
  }, [onClose]);

  const copyPath = () => {
    navigator.clipboard.writeText(menu.path);
    onClose();
  };

  const revealInFileManager = () => {
    ipc.invoke('shell:showItemInFolder', menu.path);
    onClose();
  };

  const openInDefaultApp = () => {
    ipc.invoke('shell:openPath', menu.path);
    onClose();
  };

  const canPaste = menu.isDirectory && fileClipboard !== null;
  const label = selectedCount > 1 ? ` (${selectedCount})` : '';

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[180px] rounded-md border border-border bg-popover p-1 shadow-md animate-in fade-in-0 zoom-in-95"
      style={{ left: menu.x, top: menu.y }}
    >
      {menu.isDirectory && (
        <>
          <button onClick={onNewFile} className={menuItemClass}>New File</button>
          <button onClick={onNewFolder} className={menuItemClass}>New Folder</button>
          <div className={separatorClass} />
        </>
      )}
      <button onClick={onCut} className={menuItemClass}>Cut{label}</button>
      <button onClick={onCopy} className={menuItemClass}>Copy{label}</button>
      <button
        onClick={canPaste ? onPaste : undefined}
        className={canPaste ? menuItemClass : menuItemDisabledClass}
      >
        Paste
      </button>
      <div className={separatorClass} />
      <button onClick={copyPath} className={menuItemClass}>Copy Path</button>
      <button onClick={revealInFileManager} className={menuItemClass}>Reveal in File Manager</button>
      <button onClick={openInDefaultApp} className={menuItemClass}>Open in Default App</button>
      <div className={separatorClass} />
      <button onClick={onDelete} className={menuItemClass + ' text-destructive hover:text-destructive'}>
        Delete{label}
      </button>
    </div>
  );
}

/* ── Inline new-item input ── */

function NewItemInput({
  type,
  existingNames,
  onSubmit,
  onCancel,
}: {
  type: 'file' | 'folder';
  existingNames: Set<string>;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const submittedRef = useRef(false);

  const trimmed = name.trim();
  const isDuplicate = trimmed.length > 0 && existingNames.has(trimmed);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const doSubmit = () => {
    if (submittedRef.current) return;
    if (isDuplicate) return;
    if (trimmed) {
      submittedRef.current = true;
      onSubmit(trimmed);
    } else {
      onCancel();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doSubmit();
    } else if (e.key === 'Escape') {
      submittedRef.current = true;
      onCancel();
    }
  };

  const handleBlur = () => {
    doSubmit();
  };

  return (
    <div className="flex flex-col gap-0.5 px-2 py-0.5">
      <div className="flex items-center gap-1">
        {type === 'folder' ? (
          <Folder className="h-3.5 w-3.5 shrink-0 text-blue-400" />
        ) : (
          <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          placeholder={type === 'folder' ? 'folder name' : 'file name'}
          className={cn(
            'flex-1 min-w-0 text-sm bg-transparent px-1 py-0.5 border rounded-sm outline-none',
            isDuplicate ? 'border-destructive focus:border-destructive' : 'border-border focus:border-primary',
          )}
        />
      </div>
      {isDuplicate && (
        <span className="text-[11px] text-destructive pl-5">
          Already exists
        </span>
      )}
    </div>
  );
}

/* ── TreeNode component ── */

function TreeNode({
  entry,
  depth,
  selectedPaths,
  dropTargetPath,
  cutPaths,
  newItem,
  newItemDir,
  onNodeClick,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onNewItemSubmit,
  onNewItemCancel,
}: {
  entry: FileEntry;
  depth: number;
  selectedPaths: Set<string>;
  dropTargetPath: string | null;
  cutPaths: Set<string>;
  newItem: 'file' | 'folder' | null;
  newItemDir: string | null;
  onNodeClick: (e: React.MouseEvent, entry: FileEntry) => void;
  onContextMenu: (e: React.MouseEvent, entry: FileEntry) => void;
  onDragStart: (e: React.DragEvent, entry: FileEntry) => void;
  onDragOver: (e: React.DragEvent, entry: FileEntry) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, entry: FileEntry) => void;
  onNewItemSubmit: (name: string) => void;
  onNewItemCancel: () => void;
}) {
  const expandedDirs = useFileBrowserStore((s) => s.expandedDirs);
  const entries = useFileBrowserStore((s) => s.entries);
  const selectedFile = useFileBrowserStore((s) => s.selectedFile);

  const isExpanded = expandedDirs.has(entry.path);
  const isSelected = selectedPaths.has(entry.path);
  const isEditing = selectedFile === entry.path;
  const isDropTarget = dropTargetPath === entry.path;
  const isCut = cutPaths.has(entry.path);
  const children = entries[entry.path];

  const handleClick = useCallback(
    (e: React.MouseEvent) => onNodeClick(e, entry),
    [onNodeClick, entry],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => onContextMenu(e, entry),
    [onContextMenu, entry],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent) => onDragStart(e, entry),
    [onDragStart, entry],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => onDragOver(e, entry),
    [onDragOver, entry],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => onDrop(e, entry),
    [onDrop, entry],
  );

  const isCodeFile =
    entry.name.includes('.') &&
    CODE_EXTENSIONS.has('.' + entry.name.split('.').pop()!.toLowerCase());

  return (
    <>
      <button
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={onDragLeave}
        onDrop={handleDrop}
        className={cn(
          'flex items-center w-full text-left text-sm py-1 pr-2 rounded-sm',
          'hover:bg-accent/50 transition-colors',
          isEditing && !entry.isDirectory && 'bg-accent text-accent-foreground',
          isSelected && 'bg-primary/15 ring-1 ring-primary/30',
          isDropTarget && 'bg-primary/25 ring-2 ring-primary/50',
          isCut && 'opacity-50',
        )}
        style={{ paddingLeft: `${depth * 12 + 4}px` }}
      >
        {entry.isDirectory ? (
          isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="w-3.5 shrink-0" />
        )}
        {entry.isDirectory ? (
          isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 shrink-0 mx-1 text-blue-400" />
          ) : (
            <Folder className="h-3.5 w-3.5 shrink-0 mx-1 text-blue-400" />
          )
        ) : isCodeFile ? (
          <FileCode2 className="h-3.5 w-3.5 shrink-0 mx-1 text-muted-foreground" />
        ) : (
          <FileText className="h-3.5 w-3.5 shrink-0 mx-1 text-muted-foreground" />
        )}
        <span className="truncate">{entry.name}</span>
      </button>

      {entry.isDirectory && isExpanded && children && (
        <div>
          {newItem && newItemDir === entry.path && (
            <div style={{ paddingLeft: `${(depth + 1) * 12 + 4}px` }}>
              <NewItemInput
                type={newItem}
                existingNames={new Set(children?.map((c) => c.name) ?? [])}
                onSubmit={onNewItemSubmit}
                onCancel={onNewItemCancel}
              />
            </div>
          )}
          {children.map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPaths={selectedPaths}
              dropTargetPath={dropTargetPath}
              cutPaths={cutPaths}
              newItem={newItem}
              newItemDir={newItemDir}
              onNodeClick={onNodeClick}
              onContextMenu={onContextMenu}
              onDragStart={onDragStart}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onNewItemSubmit={onNewItemSubmit}
              onNewItemCancel={onNewItemCancel}
            />
          ))}
          {children.length === 0 && !newItem && (
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

/* ── Main FileTree component ── */

export function FileTree() {
  const rootPath = useFileBrowserStore((s) => s.rootPath);
  const entries = useFileBrowserStore((s) => s.entries);
  const expandedDirs = useFileBrowserStore((s) => s.expandedDirs);
  const openFolder = useFileBrowserStore((s) => s.openFolder);
  const setRootPath = useFileBrowserStore((s) => s.setRootPath);
  const refreshTree = useFileBrowserStore((s) => s.refreshTree);
  const loadDirectory = useFileBrowserStore((s) => s.loadDirectory);
  const loading = useFileBrowserStore((s) => s.loading);
  const toggleDir = useFileBrowserStore((s) => s.toggleDir);
  const selectFile = useFileBrowserStore((s) => s.selectFile);
  const selectedPaths = useFileBrowserStore((s) => s.selectedPaths);
  const setSelectedPaths = useFileBrowserStore((s) => s.setSelectedPaths);

  const [pathInput, setPathInput] = useState(rootPath ?? '');
  const [editingPath, setEditingPath] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [fileClipboard, setFileClipboard] = useState<FileClipboard | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const [newItem, setNewItem] = useState<'file' | 'folder' | null>(null);
  const [newItemDir, setNewItemDir] = useState<string | null>(null); // target dir for context-menu new file/folder

  const lastClickedRef = useRef<string | null>(null);
  const draggedPathsRef = useRef<string[]>([]);

  const rootEntries = rootPath ? entries[rootPath] : undefined;

  // Derive cut paths set for visual dimming
  const cutPaths = fileClipboard?.mode === 'cut' ? new Set(fileClipboard.paths) : new Set<string>();

  /* ── Click handler with multi-select ── */
  const handleNodeClick = useCallback(
    (e: React.MouseEvent, entry: FileEntry) => {
      const metaKey = e.metaKey || e.ctrlKey;
      const shiftKey = e.shiftKey;

      if (metaKey) {
        // Ctrl/Cmd+click: toggle individual selection
        const next = new Set(selectedPaths);
        if (next.has(entry.path)) {
          next.delete(entry.path);
        } else {
          next.add(entry.path);
        }
        setSelectedPaths(next);
        lastClickedRef.current = entry.path;
      } else if (shiftKey && lastClickedRef.current) {
        // Shift+click: range select
        const visible = getVisiblePaths(rootEntries, entries, expandedDirs);
        const anchorIdx = visible.indexOf(lastClickedRef.current);
        const currentIdx = visible.indexOf(entry.path);
        if (anchorIdx !== -1 && currentIdx !== -1) {
          const start = Math.min(anchorIdx, currentIdx);
          const end = Math.max(anchorIdx, currentIdx);
          const next = new Set(selectedPaths);
          for (let i = start; i <= end; i++) {
            next.add(visible[i]);
          }
          setSelectedPaths(next);
        }
      } else {
        // Plain click: single select + default action
        setSelectedPaths(new Set([entry.path]));
        lastClickedRef.current = entry.path;
        if (entry.isDirectory) {
          toggleDir(entry.path);
        } else {
          selectFile(entry.path);
        }
      }
    },
    [selectedPaths, setSelectedPaths, rootEntries, entries, expandedDirs, toggleDir, selectFile],
  );

  /* ── Context menu ── */
  const handleNodeContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileEntry) => {
      e.preventDefault();
      // If right-clicked item isn't in selection, select only it
      if (!selectedPaths.has(entry.path)) {
        setSelectedPaths(new Set([entry.path]));
        lastClickedRef.current = entry.path;
      }
      setCtxMenu({
        x: e.clientX,
        y: e.clientY,
        path: entry.path,
        isDirectory: entry.isDirectory,
      });
    },
    [selectedPaths, setSelectedPaths],
  );

  const getSelectedOrCurrent = useCallback((): string[] => {
    if (selectedPaths.size > 0) return Array.from(selectedPaths);
    if (ctxMenu) return [ctxMenu.path];
    return [];
  }, [selectedPaths, ctxMenu]);

  const handleCut = useCallback(() => {
    const paths = getSelectedOrCurrent();
    if (paths.length === 0) return;
    setFileClipboard({ paths, mode: 'cut' });
    setCtxMenu(null);
  }, [getSelectedOrCurrent]);

  const handleCopy = useCallback(() => {
    const paths = getSelectedOrCurrent();
    if (paths.length === 0) return;
    setFileClipboard({ paths, mode: 'copy' });
    setCtxMenu(null);
  }, [getSelectedOrCurrent]);

  const handlePaste = useCallback(async () => {
    if (!ctxMenu || !fileClipboard) return;
    const destDir = ctxMenu.path;
    const channel = fileClipboard.mode === 'cut' ? 'file:move' : 'file:copy';
    for (const srcPath of fileClipboard.paths) {
      await ipc.invoke(channel, srcPath, destDir);
    }
    if (fileClipboard.mode === 'cut') setFileClipboard(null);
    setCtxMenu(null);
    refreshTree();
  }, [ctxMenu, fileClipboard, refreshTree]);

  const handleDelete = useCallback(async () => {
    const paths = getSelectedOrCurrent();
    if (paths.length === 0) return;
    for (const p of paths) {
      await ipc.invoke('file:delete', p);
    }
    setSelectedPaths(new Set());
    setCtxMenu(null);
    refreshTree();
  }, [getSelectedOrCurrent, setSelectedPaths, refreshTree]);

  /* ── Drag and drop ── */
  const handleDragStart = useCallback(
    (e: React.DragEvent, entry: FileEntry) => {
      // If dragged item is in selection, drag all selected; otherwise drag just this one
      if (selectedPaths.has(entry.path) && selectedPaths.size > 1) {
        draggedPathsRef.current = Array.from(selectedPaths);
      } else {
        draggedPathsRef.current = [entry.path];
      }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', draggedPathsRef.current.join('\n'));
    },
    [selectedPaths],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, entry: FileEntry) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      // For files, highlight the parent directory as the drop target
      if (entry.isDirectory) {
        setDropTargetPath(entry.path);
      } else {
        const parentDir = entry.path.replace(/\/[^/]+$/, '');
        setDropTargetPath(parentDir || null);
      }
    },
    [],
  );

  const handleDragLeave = useCallback((_e: React.DragEvent) => {
    setDropTargetPath(null);
  }, []);

  /** Resolve the actual target directory for a drop */
  const resolveDropDir = useCallback(
    (entry: FileEntry): string | null => {
      if (entry.isDirectory) return entry.path;
      // Drop on a file → move to that file's parent directory
      const parentDir = entry.path.replace(/\/[^/]+$/, '');
      return parentDir || rootPath;
    },
    [rootPath],
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent, entry: FileEntry) => {
      e.preventDefault();
      setDropTargetPath(null);

      const destDir = resolveDropDir(entry);
      if (!destDir) return;

      const paths = draggedPathsRef.current;
      if (paths.length === 0) return;

      // Don't drop onto itself or a child of itself
      for (const p of paths) {
        if (destDir === p || destDir.startsWith(p + '/')) return;
      }

      for (const srcPath of paths) {
        await ipc.invoke('file:move', srcPath, destDir);
      }
      draggedPathsRef.current = [];
      setSelectedPaths(new Set());
      refreshTree();
    },
    [resolveDropDir, setSelectedPaths, refreshTree],
  );

  /** Drop on empty space in the tree body → move to root */
  const handleTreeDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!rootPath) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    },
    [rootPath],
  );

  const handleTreeDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      setDropTargetPath(null);
      if (!rootPath) return;

      const paths = draggedPathsRef.current;
      if (paths.length === 0) return;

      for (const p of paths) {
        if (rootPath === p || rootPath.startsWith(p + '/')) return;
      }

      for (const srcPath of paths) {
        await ipc.invoke('file:move', srcPath, rootPath);
      }
      draggedPathsRef.current = [];
      setSelectedPaths(new Set());
      refreshTree();
    },
    [rootPath, setSelectedPaths, refreshTree],
  );

  /* ── Navigate up ── */
  const navigateUp = useCallback(() => {
    if (!rootPath) return;
    const parent = rootPath.replace(/\/[^/]+\/?$/, '') || '/';
    if (parent !== rootPath) setRootPath(parent);
  }, [rootPath, setRootPath]);

  /* ── Navigate home (agent workspace) ── */
  const selectedAgentId = useChatStore((s) => s.selectedAgentId);
  const agents = useAgentsStore((s) => s.agents);
  const agentDefaults = useAgentsStore((s) => s.defaults);

  const navigateHome = useCallback(() => {
    const agent = agents.find((a) => a.id === selectedAgentId);
    const workspace = agent ? resolveAgentWorkspace(agent, agentDefaults) : undefined;
    if (workspace) {
      setRootPath(workspace);
    }
  }, [agents, selectedAgentId, agentDefaults, setRootPath]);

  /* ── Workspace export/import ── */

  // Find the first selected directory, or fall back to rootPath
  const getTargetDir = useCallback((): string | null => {
    if (selectedPaths.size > 0) {
      for (const p of selectedPaths) {
        // Check if this path is a directory by looking it up in the entries cache
        for (const dirEntries of Object.values(entries)) {
          const match = dirEntries.find((e) => e.path === p && e.isDirectory);
          if (match) return match.path;
        }
      }
    }
    return rootPath;
  }, [selectedPaths, entries, rootPath]);

  const handleExport = useCallback(async () => {
    const target = getTargetDir();
    if (!target) return;
    try {
      const result = (await ipc.invoke('workspace:export', { rootPath: target })) as {
        success: boolean;
        filePath?: string;
        fileCount?: number;
        error?: string;
      };
      if (result.success) {
        toast.success(`Exported ${result.fileCount} files`);
      } else if (result.error !== 'cancelled') {
        toast.error(result.error || 'Export failed');
      }
    } catch (err) {
      toast.error('Export failed: ' + String(err));
    }
  }, [getTargetDir]);

  const handleImport = useCallback(async () => {
    const target = getTargetDir();
    if (!target) return;

    try {
      const result = (await ipc.invoke('workspace:import', { targetPath: target })) as {
        success: boolean;
        fileCount?: number;
        error?: string;
      };
      if (result.success) {
        toast.success(`Imported ${result.fileCount} files to ${target.split('/').pop()}`);
        await refreshTree();
        // Also reload the target dir and expand it if it's a subfolder
        if (target !== rootPath) {
          await loadDirectory(target);
          if (!expandedDirs.has(target)) {
            toggleDir(target);
          }
        }
      } else if (result.error !== 'cancelled') {
        toast.error(result.error || 'Import failed');
      }
    } catch (err) {
      toast.error('Import failed: ' + String(err));
    }
  }, [getTargetDir, refreshTree, loadDirectory, rootPath, expandedDirs, toggleDir]);

  /* ── Create new file/folder ── */
  const handleNewItemSubmit = useCallback(async (name: string) => {
    const dir = newItemDir ?? rootPath;
    if (!dir) return;
    const fullPath = dir + '/' + name;
    const isFolder = newItem === 'folder';
    const channel = isFolder ? 'file:createDir' : 'file:create';
    await ipc.invoke(channel, fullPath);
    setNewItem(null);
    setNewItemDir(null);
    await refreshTree();
    // Auto-open newly created file in the editor
    if (!isFolder) {
      selectFile(fullPath);
    }
  }, [rootPath, newItemDir, newItem, refreshTree, selectFile]);

  const handleNewItemCancel = useCallback(() => {
    setNewItem(null);
    setNewItemDir(null);
  }, []);

  const handleCtxNewFile = useCallback(() => {
    if (!ctxMenu) return;
    setNewItemDir(ctxMenu.path);
    setNewItem('file');
    // Expand the target directory so the input is visible
    if (!expandedDirs.has(ctxMenu.path)) toggleDir(ctxMenu.path);
    setCtxMenu(null);
  }, [ctxMenu, expandedDirs, toggleDir]);

  const handleCtxNewFolder = useCallback(() => {
    if (!ctxMenu) return;
    setNewItemDir(ctxMenu.path);
    setNewItem('folder');
    if (!expandedDirs.has(ctxMenu.path)) toggleDir(ctxMenu.path);
    setCtxMenu(null);
  }, [ctxMenu, expandedDirs, toggleDir]);

  /* ── Path bar ── */
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

  const displayPath = editingPath ? pathInput : (rootPath ?? '');

  return (
    <div className="flex flex-col h-full">
      {/* Header with actions */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-border shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Explorer
        </span>
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={navigateHome}
              >
                <Home className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Agent Workspace</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={navigateUp}
                disabled={!rootPath}
              >
                <ArrowUp className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Go Up</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => { setNewItemDir(null); setNewItem('file'); }}
                disabled={!rootPath}
              >
                <FilePlus className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>New File</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={() => { setNewItemDir(null); setNewItem('folder'); }}
                disabled={!rootPath}
              >
                <FolderPlus className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>New Folder</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={openFolder}
              >
                <FolderOpenDot className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Open Folder</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={refreshTree}
                disabled={loading}
              >
                <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Refresh</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={handleExport}
                disabled={!rootPath}
              >
                <Download className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Export as ZIP</p></TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5"
                onClick={handleImport}
                disabled={!rootPath}
              >
                <Upload className="h-3 w-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom"><p>Import ZIP</p></TooltipContent>
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
      <div
        className="flex-1 overflow-y-auto py-1 text-[13px]"
        onScroll={() => setCtxMenu(null)}
        onDragOver={handleTreeDragOver}
        onDrop={handleTreeDrop}
      >
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
        {newItem && !newItemDir && (
          <NewItemInput
            type={newItem}
            existingNames={new Set(rootEntries?.map((e) => e.name) ?? [])}
            onSubmit={handleNewItemSubmit}
            onCancel={handleNewItemCancel}
          />
        )}
        {rootEntries?.map((entry) => (
          <TreeNode
            key={entry.path}
            entry={entry}
            depth={0}
            selectedPaths={selectedPaths}
            dropTargetPath={dropTargetPath}
            cutPaths={cutPaths}
            newItem={newItem}
            newItemDir={newItemDir}
            onNodeClick={handleNodeClick}
            onContextMenu={handleNodeContextMenu}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onNewItemSubmit={handleNewItemSubmit}
            onNewItemCancel={handleNewItemCancel}
          />
        ))}
      </div>

      {/* Right-click context menu */}
      {ctxMenu && (
        <FileContextMenu
          menu={ctxMenu}
          onClose={() => setCtxMenu(null)}
          fileClipboard={fileClipboard}
          selectedCount={selectedPaths.size}
          onCut={handleCut}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onDelete={handleDelete}
          onNewFile={handleCtxNewFile}
          onNewFolder={handleCtxNewFolder}
        />
      )}
    </div>
  );
}
