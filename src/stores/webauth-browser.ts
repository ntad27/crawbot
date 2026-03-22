/**
 * WebAuth Browser Panel State Store
 * Completely independent from useBrowserStore (Chat browser)
 * Manages webauth-specific browser tabs with own IPC channels
 */
import { create } from 'zustand';

// ── Types ──────────────────────────────────────────────────

export interface WebAuthBrowserTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  partition: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
}

/** Google login state — when set, renderer shows <webview> overlay */
export interface GoogleLoginState {
  tabId: string;
  googleUrl: string;
  partition: string;
}

interface WebAuthBrowserState {
  tabs: WebAuthBrowserTab[];
  activeTabId: string | null;

  /** When non-null, show <webview> for Google login instead of native view */
  googleLogin: GoogleLoginState | null;
  setGoogleLogin: (state: GoogleLoginState | null) => void;

  // Tab actions
  addTab: (url: string, partition: string) => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<WebAuthBrowserTab>) => void;

  // Navigation (operates on active tab)
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  setZoom: (factor: number) => void;
}

// ── Helpers ────────────────────────────────────────────────

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5.0;

let tabIdCounter = 0;
function generateTabId(): string {
  return `webauth-tab-${Date.now()}-${++tabIdCounter}`;
}

function clampZoom(factor: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, factor));
}

function invokeIpc(channel: string, ...args: unknown[]): void {
  try {
    const result = window.electron?.ipcRenderer?.invoke(channel, ...args);
    if (result && typeof result.catch === 'function') {
      result.catch((err: Error) => {
        console.error(`[WebAuthBrowserStore] IPC ${channel} failed:`, err);
      });
    }
  } catch (err) {
    console.error(`[WebAuthBrowserStore] IPC ${channel} failed:`, err);
  }
}

// ── Store ──────────────────────────────────────────────────

export const useWebAuthBrowserStore = create<WebAuthBrowserState>()(
  (set, get) => ({
    // ── Default state ──
    tabs: [],
    activeTabId: null,
    googleLogin: null,
    setGoogleLogin: (state) => set({ googleLogin: state }),

    // ── Tab actions ──

    addTab: (url: string, partition: string) => {
      // Prevent duplicate tabs for the same partition
      const existing = get().tabs.find((t) => t.partition === partition);
      if (existing) {
        set({ activeTabId: existing.id });
        invokeIpc('webauth:browser:tab:setActive', existing.id);
        return existing.id;
      }

      const id = generateTabId();
      const tab: WebAuthBrowserTab = {
        id,
        url,
        title: 'New Tab',
        partition,
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        zoomFactor: 0.6,
      };
      set((s) => ({
        tabs: [...s.tabs, tab],
        activeTabId: id,
      }));
      invokeIpc('webauth:browser:tab:create', { id, url, partition });
      return id;
    },

    closeTab: (tabId) => {
      const { tabs, activeTabId } = get();
      const idx = tabs.findIndex((t) => t.id === tabId);
      if (idx === -1) return;

      const newTabs = tabs.filter((t) => t.id !== tabId);
      let newActiveId = activeTabId;

      if (activeTabId === tabId) {
        if (newTabs.length === 0) {
          newActiveId = null;
        } else if (idx >= newTabs.length) {
          newActiveId = newTabs[newTabs.length - 1].id;
        } else {
          newActiveId = newTabs[idx].id;
        }
      }

      set({ tabs: newTabs, activeTabId: newActiveId });
      invokeIpc('webauth:browser:tab:close', tabId);
    },

    setActiveTab: (tabId) => {
      const { tabs } = get();
      if (tabs.some((t) => t.id === tabId)) {
        set({ activeTabId: tabId });
        invokeIpc('webauth:browser:tab:setActive', tabId);
      }
    },

    updateTab: (tabId, updates) => {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...updates } : t)),
      }));
    },

    // ── Navigation ──

    navigate: (url) => {
      const { activeTabId } = get();
      if (!activeTabId) return;
      invokeIpc('webauth:browser:tab:navigate', activeTabId, url);
    },

    goBack: () => {
      const { activeTabId } = get();
      if (!activeTabId) return;
      invokeIpc('webauth:browser:tab:goBack', activeTabId);
    },

    goForward: () => {
      const { activeTabId } = get();
      if (!activeTabId) return;
      invokeIpc('webauth:browser:tab:goForward', activeTabId);
    },

    reload: () => {
      const { activeTabId } = get();
      if (!activeTabId) return;
      invokeIpc('webauth:browser:tab:reload', activeTabId);
    },

    setZoom: (factor) => {
      const { activeTabId } = get();
      if (!activeTabId) return;
      const clamped = clampZoom(factor);
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === activeTabId ? { ...t, zoomFactor: clamped } : t
        ),
      }));
      invokeIpc('webauth:browser:tab:setZoom', activeTabId, clamped);
    },
  })
);

// ── Listen for tab updates from main process (WebAuthViewManager) ──

if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
  // When main process creates a tab
  window.electron.ipcRenderer.on('webauth:browser:tab:created', (tabData: unknown) => {
    if (tabData && typeof tabData === 'object') {
      const data = tabData as WebAuthBrowserTab;
      const { tabs } = useWebAuthBrowserStore.getState();
      // Only add if not already in store (avoid duplicates)
      if (!tabs.some((t) => t.id === data.id)) {
        useWebAuthBrowserStore.setState((s) => ({
          tabs: [...s.tabs, data],
          activeTabId: data.id,
        }));
      }
    }
  });

  window.electron.ipcRenderer.on('webauth:browser:tab:updated', (tabId: unknown, updates: unknown) => {
    if (typeof tabId === 'string' && updates && typeof updates === 'object') {
      useWebAuthBrowserStore.getState().updateTab(tabId, updates as Partial<WebAuthBrowserTab>);
    }
  });

  // When main process activates a tab
  window.electron.ipcRenderer.on('webauth:browser:tab:activated', (tabId: unknown) => {
    if (typeof tabId === 'string') {
      const { tabs } = useWebAuthBrowserStore.getState();
      if (tabs.some((t) => t.id === tabId)) {
        useWebAuthBrowserStore.setState({ activeTabId: tabId });
      }
    }
  });

  // When main process closes a tab
  window.electron.ipcRenderer.on('webauth:browser:tab:closed', (tabId: unknown) => {
    if (typeof tabId === 'string') {
      const { tabs, activeTabId } = useWebAuthBrowserStore.getState();
      const newTabs = tabs.filter((t) => t.id !== tabId);
      const newActiveId = activeTabId === tabId
        ? (newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null)
        : activeTabId;
      useWebAuthBrowserStore.setState({ tabs: newTabs, activeTabId: newActiveId });
    }
  });

  // Google login intercept — main process detected Google OAuth redirect
  // and tells renderer to show a <webview> tag instead (which is NOT
  // affected by --remote-debugging-port)
  window.electron.ipcRenderer.on(
    'webauth:browser:google-login',
    (tabId: unknown, googleUrl: unknown, partition: unknown) => {
      if (typeof tabId === 'string' && typeof googleUrl === 'string' && typeof partition === 'string') {
        useWebAuthBrowserStore.setState({
          googleLogin: { tabId, googleUrl, partition },
        });
      }
    }
  );
}
