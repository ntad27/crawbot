/**
 * File Browser Store
 * Manages state for the workspace file browser panel in the Chat page
 */
import { create } from 'zustand';
import { getFileViewMode, type FileViewMode } from '@/utils/file-type';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

/** Result from office document conversion (file:convertOffice IPC). */
export type OfficeConvertResult =
  | { format: 'document'; html: string }
  | { format: 'spreadsheet'; sheets: { name: string; html: string }[] }
  | { format: 'presentation'; slides: { index: number; text: string }[] }
  | { format: 'error'; error: string };

interface FileBrowserState {
  panelOpen: boolean;
  panelWidth: number;
  treeWidth: number;
  rootPath: string | null;
  entries: Record<string, FileEntry[]>; // dirPath → children
  expandedDirs: Set<string>;
  selectedFile: string | null;
  selectedPaths: Set<string>; // multi-select for bulk operations
  lastClickedPath: string | null; // anchor for shift+click range select
  fileContent: string | null;
  fileViewMode: FileViewMode | null; // current view mode for selected file
  fileUrl: string | null; // local-file:// URL for binary file viewing
  fileSize: number | null; // file size in bytes
  fileOfficeData: OfficeConvertResult | null; // converted office document data
  fileDirty: boolean;
  loading: boolean;
  fileLoading: boolean;

  togglePanel: () => void;
  setPanelWidth: (w: number) => void;
  setTreeWidth: (w: number) => void;
  setRootPath: (path: string) => void;
  openFolder: () => Promise<void>;
  loadDirectory: (dirPath: string) => Promise<void>;
  toggleDir: (dirPath: string) => void;
  selectFile: (filePath: string) => Promise<void>;
  updateContent: (content: string) => void;
  saveFile: () => Promise<void>;
  refreshTree: () => Promise<void>;
  closeFile: () => void;
  openFileExternal: (filePath?: string) => void;
  setSelectedPaths: (paths: Set<string>) => void;
  clearSelection: () => void;
}

export const useFileBrowserStore = create<FileBrowserState>((set, get) => ({
  panelOpen: false,
  panelWidth: 480,
  treeWidth: 200,
  rootPath: null,
  entries: {},
  expandedDirs: new Set<string>(),
  selectedFile: null,
  selectedPaths: new Set<string>(),
  lastClickedPath: null,
  fileContent: null,
  fileViewMode: null,
  fileUrl: null,
  fileSize: null,
  fileOfficeData: null,
  fileDirty: false,
  loading: false,
  fileLoading: false,

  togglePanel: () => {
    const { panelOpen, rootPath } = get();
    const opening = !panelOpen;
    set({ panelOpen: opening });
    // Auto-load root when opening for the first time
    if (opening && rootPath && !get().entries[rootPath]) {
      get().loadDirectory(rootPath);
    }
  },

  setPanelWidth: (w: number) => set({ panelWidth: w }),
  setTreeWidth: (w: number) => set({ treeWidth: w }),

  setRootPath: (path: string) => {
    const prev = get().rootPath;
    if (prev === path) return;
    set({
      rootPath: path,
      entries: {},
      expandedDirs: new Set<string>(),
      selectedFile: null,
      selectedPaths: new Set<string>(),
      lastClickedPath: null,
      fileContent: null,
      fileViewMode: null,
      fileUrl: null,
      fileSize: null,
      fileOfficeData: null,
      fileDirty: false,
    });
    if (get().panelOpen) {
      get().loadDirectory(path);
    }
    // Start watching new directory for changes
    window.electron.ipcRenderer.invoke('file:watch', path);
  },

  openFolder: async () => {
    try {
      const result = (await window.electron.ipcRenderer.invoke('dialog:open', {
        properties: ['openDirectory'],
      })) as { canceled: boolean; filePaths: string[] };

      if (!result.canceled && result.filePaths[0]) {
        get().setRootPath(result.filePaths[0]);
      }
    } catch (error) {
      console.error('Failed to open folder dialog:', error);
    }
  },

  loadDirectory: async (dirPath: string) => {
    set({ loading: true });
    try {
      const result = (await window.electron.ipcRenderer.invoke('file:listDir', dirPath)) as {
        success: boolean;
        files?: FileEntry[];
        error?: string;
      };

      if (result.success && result.files) {
        set((state) => ({
          entries: { ...state.entries, [dirPath]: result.files! },
          loading: false,
        }));
      } else {
        set({ loading: false });
      }
    } catch (error) {
      console.error('Failed to load directory:', error);
      set({ loading: false });
    }
  },

  toggleDir: (dirPath: string) => {
    const { expandedDirs } = get();
    const next = new Set(expandedDirs);
    if (next.has(dirPath)) {
      next.delete(dirPath);
    } else {
      next.add(dirPath);
      // Lazy-load children if not yet loaded
      if (!get().entries[dirPath]) {
        get().loadDirectory(dirPath);
      }
    }
    set({ expandedDirs: next });
  },

  selectFile: async (filePath: string) => {
    // Prompt save if dirty
    if (get().fileDirty) {
      await get().saveFile();
    }

    const viewMode = getFileViewMode(filePath);
    set({
      fileLoading: true,
      selectedFile: filePath,
      fileViewMode: viewMode,
      fileUrl: null,
      fileSize: null,
      fileOfficeData: null,
      fileContent: null,
      fileDirty: false,
    });

    try {
      if (viewMode === 'editor') {
        // Text file: read as text
        const result = (await window.electron.ipcRenderer.invoke('file:readAny', filePath)) as {
          success: boolean;
          content?: string;
          truncated?: boolean;
          error?: string;
        };
        if (result.success) {
          set({ fileContent: result.content ?? '', fileDirty: false, fileLoading: false });
        } else {
          set({ fileContent: null, fileLoading: false });
        }
      } else if (viewMode === 'office') {
        // Office files: convert to HTML for inline viewing
        const result = (await window.electron.ipcRenderer.invoke('file:convertOffice', filePath)) as {
          success: boolean;
          html?: string;
          sheets?: { name: string; html: string }[];
          slides?: { index: number; text: string }[];
          format?: string;
          error?: string;
        };
        if (result.success) {
          let officeData: OfficeConvertResult;
          if (result.format === 'document' && result.html) {
            officeData = { format: 'document', html: result.html };
          } else if (result.format === 'spreadsheet' && result.sheets) {
            officeData = { format: 'spreadsheet', sheets: result.sheets };
          } else if (result.format === 'presentation' && result.slides) {
            officeData = { format: 'presentation', slides: result.slides };
          } else {
            officeData = { format: 'error', error: 'Unknown format' };
          }
          set({ fileOfficeData: officeData, fileLoading: false });
        } else {
          set({
            fileOfficeData: { format: 'error', error: result.error ?? 'Conversion failed' },
            fileLoading: false,
          });
        }
      } else {
        // Binary viewable file (image, pdf, audio, video): get local-file:// URL
        const result = (await window.electron.ipcRenderer.invoke('file:getLocalUrl', filePath)) as {
          success: boolean;
          url?: string;
          size?: number;
          error?: string;
        };
        if (result.success && result.url) {
          set({
            fileUrl: result.url,
            fileSize: result.size ?? null,
            fileLoading: false,
          });
        } else {
          set({ fileLoading: false });
        }
      }
    } catch (error) {
      console.error('Failed to read file:', error);
      set({ fileContent: null, fileUrl: null, fileOfficeData: null, fileLoading: false });
    }
  },

  updateContent: (content: string) => {
    set({ fileContent: content, fileDirty: true });
  },

  saveFile: async () => {
    const { selectedFile, fileContent } = get();
    if (!selectedFile || fileContent === null) return;

    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'file:writeAny',
        selectedFile,
        fileContent,
      )) as { success: boolean; error?: string };

      if (result.success) {
        set({ fileDirty: false });
      }
    } catch (error) {
      console.error('Failed to save file:', error);
    }
  },

  refreshTree: async () => {
    const { rootPath, expandedDirs } = get();
    if (!rootPath) return;

    // Reload root
    await get().loadDirectory(rootPath);

    // Reload expanded directories
    for (const dir of expandedDirs) {
      await get().loadDirectory(dir);
    }
  },

  closeFile: () => {
    set({
      selectedFile: null,
      fileContent: null,
      fileViewMode: null,
      fileUrl: null,
      fileSize: null,
      fileOfficeData: null,
      fileDirty: false,
    });
  },

  openFileExternal: (filePath?: string) => {
    const target = filePath ?? get().selectedFile;
    if (target) {
      window.electron.ipcRenderer.invoke('shell:openPath', target);
    }
  },

  setSelectedPaths: (paths: Set<string>) => {
    set({ selectedPaths: paths });
  },

  clearSelection: () => {
    set({ selectedPaths: new Set<string>(), lastClickedPath: null });
  },
}));

// Listen for file system changes from the main process watcher and auto-refresh the tree.
window.electron.ipcRenderer.on('file:changed', () => {
  const { rootPath, panelOpen } = useFileBrowserStore.getState();
  if (rootPath && panelOpen) {
    useFileBrowserStore.getState().refreshTree();
  }
});
