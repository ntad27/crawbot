/**
 * Browser Panel State Store
 * Manages built-in browser tabs, panel state, and navigation
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// ── Types ──────────────────────────────────────────────────

type TabCategory = 'automation' | 'webauth';

export interface BrowserTab {
  id: string;
  url: string;
  title: string;
  favicon?: string;
  partition: string;
  category: TabCategory;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  zoomFactor: number;
}

interface BrowserState {
  // Panel
  panelOpen: boolean;
  panelWidth: number; // 0 = 50% mode, otherwise pixels
  detached: boolean;

  // Tabs
  tabs: BrowserTab[];
  activeTabId: string | null;

  // Panel actions
  togglePanel: () => void;
  openPanel: () => void;
  closePanel: () => void;
  setPanelWidth: (width: number) => void;
  setDetached: (detached: boolean) => void;

  // Tab actions
  addTab: (url?: string, partition?: string, category?: TabCategory) => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTab: (tabId: string, updates: Partial<BrowserTab>) => void;

  // Navigation (operates on active tab)
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  setZoom: (factor: number) => void;
}

// ── Navigation callbacks (set by BrowserWebview) ──────────

type NavCallback = (tabId: string, url?: string) => void;
let _navigateCb: NavCallback | null = null;
let _goBackCb: NavCallback | null = null;
let _goForwardCb: NavCallback | null = null;
let _reloadCb: NavCallback | null = null;

/** Called by BrowserWebview module to register navigation handlers */
export function registerWebviewNavCallbacks(cbs: {
  navigate: NavCallback;
  goBack: NavCallback;
  goForward: NavCallback;
  reload: NavCallback;
}): void {
  _navigateCb = cbs.navigate;
  _goBackCb = cbs.goBack;
  _goForwardCb = cbs.goForward;
  _reloadCb = cbs.reload;
}

// ── Helpers ────────────────────────────────────────────────

const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 1200;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5.0;

let tabIdCounter = 0;
function generateTabId(): string {
  return `tab-${Date.now()}-${++tabIdCounter}`;
}

function clampPanelWidth(width: number): number {
  if (width === 0) return 0; // 50% mode
  return Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, width));
}

function clampZoom(factor: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, factor));
}

function invokeIpc(channel: string, ...args: unknown[]): void {
  try {
    const result = window.electron?.ipcRenderer?.invoke(channel, ...args);
    if (result && typeof result.catch === 'function') {
      result.catch((err: Error) => {
        console.error(`[BrowserStore] IPC ${channel} failed:`, err);
      });
    }
  } catch (err) {
    console.error(`[BrowserStore] IPC ${channel} failed:`, err);
  }
}

// ── Store ──────────────────────────────────────────────────

export const useBrowserStore = create<BrowserState>()(
  persist(
    (set, get) => ({
      // ── Default state ──
      panelOpen: false,
      panelWidth: 0,
      detached: false,
      tabs: [],
      activeTabId: null,

      // ── Panel actions ──

      togglePanel: () => {
        const { panelOpen, tabs, addTab } = get();
        if (!panelOpen && tabs.length === 0) {
          addTab('https://crawbot.net');
        }
        set({ panelOpen: !panelOpen });
      },
      openPanel: () => {
        const { tabs, addTab } = get();
        if (tabs.length === 0) {
          addTab('https://crawbot.net');
        }
        set({ panelOpen: true });
      },
      closePanel: () => set({ panelOpen: false }),

      setPanelWidth: (width) => set({ panelWidth: clampPanelWidth(width) }),

      setDetached: (detached) => {
        set({ detached });
        invokeIpc(detached ? 'browser:panel:detach' : 'browser:panel:attach');
      },

      // ── Tab actions ──

      addTab: (url = 'about:blank', partition = 'persist:browser-shared', category = 'automation') => {
        const id = generateTabId();
        const tab: BrowserTab = {
          id,
          url,
          title: 'New Tab',
          partition,
          category,
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          zoomFactor: 0.6,
        };
        set((s) => ({
          tabs: [...s.tabs, tab],
          activeTabId: id,
          panelOpen: true,
        }));
        invokeIpc('browser:tab:create', { id, url, partition, category });
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
        invokeIpc('browser:tab:close', tabId);
      },

      setActiveTab: (tabId) => {
        const { tabs } = get();
        if (tabs.some((t) => t.id === tabId)) {
          set({ activeTabId: tabId });
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
        _navigateCb?.(activeTabId, url);
      },

      goBack: () => {
        const { activeTabId } = get();
        if (!activeTabId) return;
        _goBackCb?.(activeTabId);
      },

      goForward: () => {
        const { activeTabId } = get();
        if (!activeTabId) return;
        _goForwardCb?.(activeTabId);
      },

      reload: () => {
        const { activeTabId } = get();
        if (!activeTabId) return;
        _reloadCb?.(activeTabId);
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
        invokeIpc('browser:tab:setZoom', activeTabId, clamped);
      },
    }),
    {
      name: 'crawbot-browser',
      partialize: (state) => ({
        panelWidth: state.panelWidth,
        // Persist tabs so they restore on app restart
        tabs: state.tabs.map((t) => ({
          ...t,
          isLoading: false, // reset loading state
        })),
        activeTabId: state.activeTabId,
      }),
    }
  )
);
