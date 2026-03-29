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
  // Tab group fields (agent session ownership)
  sessionKey?: string;
  sessionLabel?: string;
  groupColor?: string;
}

// Main agent gets a fixed warm color
const MAIN_GROUP_COLOR = '#E8590C'; // orange-red

// Subagent color palette — NO warm reds/oranges (too similar to main)
// All cool/vivid colors that are visually distinct from each other and from main
const SUBAGENT_COLORS = [
  '#2563EB', // blue
  '#7C3AED', // violet
  '#059669', // emerald
  '#DB2777', // pink
  '#0891B2', // cyan
  '#4F46E5', // indigo
  '#C026D3', // fuchsia
  '#0D9488', // teal
  '#65A30D', // lime
  '#6D28D9', // purple
];

// Counter-based assignment: each new subagent gets the next color in sequence
let _subagentColorIdx = 0;
const _sessionColorCache = new Map<string, string>();

function colorForSession(sessionKey: string): string {
  if (sessionKey === 'agent:main:main' || !sessionKey.includes('subagent:')) {
    return MAIN_GROUP_COLOR;
  }
  // Return cached color if already assigned
  const cached = _sessionColorCache.get(sessionKey);
  if (cached) return cached;
  // Assign next color in sequence (guarantees adjacent subagents get different colors)
  const color = SUBAGENT_COLORS[_subagentColorIdx % SUBAGENT_COLORS.length];
  _subagentColorIdx++;
  _sessionColorCache.set(sessionKey, color);
  return color;
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

  // Tab session grouping
  setTabSession: (tabId: string, sessionKey: string, sessionLabel?: string) => void;

  // Navigation (operates on active tab)
  navigate: (url: string) => void;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  setZoom: (factor: number) => void;
}

// Navigation now goes through IPC to main process (WebContentsView)
// No more renderer-side webview callbacks needed

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
          // User-created tabs default to "main" group
          sessionKey: 'agent:main:main',
          sessionLabel: 'main',
          groupColor: colorForSession('agent:main:main'),
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
          invokeIpc('browser:tab:setActive', tabId);
        }
      },

      updateTab: (tabId, updates) => {
        set((s) => ({
          tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, ...updates } : t)),
        }));
      },

      setTabSession: (tabId, sessionKey, sessionLabel) => {
        set((s) => ({
          tabs: s.tabs.map((t) =>
            t.id === tabId
              ? { ...t, sessionKey, sessionLabel, groupColor: colorForSession(sessionKey) }
              : t,
          ),
        }));
      },

      // ── Navigation ──

      navigate: (url) => {
        const { activeTabId } = get();
        if (!activeTabId) return;
        invokeIpc('browser:tab:navigate', activeTabId, url);
      },

      goBack: () => {
        const { activeTabId } = get();
        if (!activeTabId) return;
        invokeIpc('browser:tab:goBack', activeTabId);
      },

      goForward: () => {
        const { activeTabId } = get();
        if (!activeTabId) return;
        invokeIpc('browser:tab:goForward', activeTabId);
      },

      reload: () => {
        const { activeTabId } = get();
        if (!activeTabId) return;
        invokeIpc('browser:tab:reload', activeTabId);
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
        // Strip session fields (ephemeral per-session, not useful after restart)
        tabs: state.tabs.map(({ sessionKey: _, sessionLabel: _l, groupColor: _c, ...t }) => ({
          ...t,
          isLoading: false, // reset loading state
        })),
        activeTabId: state.activeTabId,
      }),
    }
  )
);

// ── Listen for tab updates from main process (WebContentsView navigation) ──

if (typeof window !== 'undefined' && window.electron?.ipcRenderer) {
  // Restore persisted tabs — recreate WebContentsViews in main process
  // Re-assign "main" group to restored tabs (session fields stripped from persist)
  const restoredTabs = useBrowserStore.getState().tabs;
  if (restoredTabs.length > 0) {
    useBrowserStore.setState((s) => ({
      tabs: s.tabs.map((t) => ({
        ...t,
        sessionKey: t.sessionKey || 'agent:main:main',
        sessionLabel: t.sessionLabel || 'main',
        groupColor: t.groupColor || colorForSession('agent:main:main'),
      })),
    }));
    setTimeout(() => {
      const state = useBrowserStore.getState();
      for (const tab of state.tabs) {
        invokeIpc('browser:tab:create', {
          id: tab.id,
          url: tab.url,
          partition: tab.partition,
          category: tab.category,
        });
      }
      // Set active tab
      if (state.activeTabId) {
        invokeIpc('browser:tab:setActive', state.activeTabId);
      }
    }, 500);
  }

  // When main process creates a tab (e.g., via CDP Target.createTarget)
  window.electron.ipcRenderer.on('browser:tab:created', (tabData: unknown) => {
    if (tabData && typeof tabData === 'object') {
      const data = tabData as BrowserTab;
      // Default unowned tabs to "main" group (subagent tabs will be re-tagged via session-tag IPC)
      if (!data.sessionKey) {
        data.sessionKey = 'agent:main:main';
        data.sessionLabel = 'main';
        data.groupColor = colorForSession('agent:main:main');
      }
      const { tabs } = useBrowserStore.getState();
      // Only add if not already in store (avoid duplicates from IPC addTab)
      if (!tabs.some((t) => t.id === data.id)) {
        useBrowserStore.setState((s) => ({
          tabs: [...s.tabs, data],
          activeTabId: data.id,
          panelOpen: true,
        }));
      }
    }
  });

  window.electron.ipcRenderer.on('browser:tab:updated', (tabId: unknown, updates: unknown) => {
    if (typeof tabId === 'string' && updates && typeof updates === 'object') {
      useBrowserStore.getState().updateTab(tabId, updates as Partial<BrowserTab>);
    }
  });

  // When main process activates a tab (e.g., from CDP/Playwright focus)
  window.electron.ipcRenderer.on('browser:tab:activated', (tabId: unknown) => {
    if (typeof tabId === 'string') {
      const { tabs } = useBrowserStore.getState();
      if (tabs.some((t) => t.id === tabId)) {
        useBrowserStore.setState({ activeTabId: tabId });
      }
    }
  });

  // When main process tags a tab with agent session info (tab grouping)
  window.electron.ipcRenderer.on('browser:tab:session-tagged', (data: unknown) => {
    if (data && typeof data === 'object') {
      const { tabId, sessionKey, sessionLabel } = data as {
        tabId?: string; sessionKey?: string; sessionLabel?: string;
      };
      if (typeof tabId === 'string' && typeof sessionKey === 'string') {
        useBrowserStore.getState().setTabSession(tabId, sessionKey, sessionLabel);
      }
    }
  });

  // When main process closes a tab (e.g., via CDP /json/close or webContents destroyed)
  window.electron.ipcRenderer.on('browser:tab:closed', (tabId: unknown) => {
    if (typeof tabId === 'string') {
      const { tabs, activeTabId } = useBrowserStore.getState();
      const newTabs = tabs.filter((t) => t.id !== tabId);
      const newActiveId = activeTabId === tabId
        ? (newTabs.length > 0 ? newTabs[newTabs.length - 1].id : null)
        : activeTabId;
      useBrowserStore.setState({ tabs: newTabs, activeTabId: newActiveId });
    }
  });
}
