/**
 * File Browser Store
 * Manages state for the workspace file browser panel in the Chat page
 */
import { create } from 'zustand';

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
}

interface FileBrowserState {
  panelOpen: boolean;
  panelWidth: number;
  treeWidth: number;
  rootPath: string | null;
  entries: Record<string, FileEntry[]>; // dirPath → children
  expandedDirs: Set<string>;
  selectedFile: string | null;
  fileContent: string | null;
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
}

export const useFileBrowserStore = create<FileBrowserState>((set, get) => ({
  panelOpen: false,
  panelWidth: 480,
  treeWidth: 200,
  rootPath: null,
  entries: {},
  expandedDirs: new Set<string>(),
  selectedFile: null,
  fileContent: null,
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
      fileContent: null,
      fileDirty: false,
    });
    if (get().panelOpen) {
      get().loadDirectory(path);
    }
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

    set({ fileLoading: true, selectedFile: filePath });
    try {
      const result = (await window.electron.ipcRenderer.invoke('file:readAny', filePath)) as {
        success: boolean;
        content?: string;
        truncated?: boolean;
        error?: string;
      };

      if (result.success) {
        set({
          fileContent: result.content ?? '',
          fileDirty: false,
          fileLoading: false,
        });
      } else {
        set({
          fileContent: null,
          fileLoading: false,
        });
      }
    } catch (error) {
      console.error('Failed to read file:', error);
      set({ fileContent: null, fileLoading: false });
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
    set({ selectedFile: null, fileContent: null, fileDirty: false });
  },
}));
