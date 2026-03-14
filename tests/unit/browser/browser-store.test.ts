/**
 * Browser Store Tests
 * Tests for useBrowserStore Zustand store
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useBrowserStore, registerWebviewNavCallbacks } from '@/stores/browser';

// Mock navigation callbacks
const mockNavigate = vi.fn();
const mockGoBack = vi.fn();
const mockGoForward = vi.fn();
const mockReload = vi.fn();

registerWebviewNavCallbacks({
  navigate: mockNavigate,
  goBack: mockGoBack,
  goForward: mockGoForward,
  reload: mockReload,
});

describe('useBrowserStore', () => {
  beforeEach(() => {
    useBrowserStore.setState({
      panelOpen: false,
      panelWidth: 0,
      detached: false,
      tabs: [],
      activeTabId: null,
    });
    mockNavigate.mockClear();
    mockGoBack.mockClear();
    mockGoForward.mockClear();
    mockReload.mockClear();
  });

  // ── Tab Management ──

  describe('tab management', () => {
    it('addTab creates tab with unique ID and default partition', () => {
      const { addTab } = useBrowserStore.getState();
      const id = addTab();
      const { tabs } = useBrowserStore.getState();

      expect(tabs).toHaveLength(1);
      expect(tabs[0].id).toBe(id);
      expect(tabs[0].partition).toBe('persist:browser-shared');
      expect(tabs[0].category).toBe('automation');
      expect(tabs[0].url).toBe('about:blank');
      expect(tabs[0].title).toBe('New Tab');
      expect(tabs[0].zoomFactor).toBe(0.6);
    });

    it('addTab sets new tab as active and opens panel', () => {
      const { addTab } = useBrowserStore.getState();
      const id = addTab('https://example.com');
      const { activeTabId, panelOpen } = useBrowserStore.getState();

      expect(activeTabId).toBe(id);
      expect(panelOpen).toBe(true);
    });

    it('addTab accepts custom partition and category', () => {
      const { addTab } = useBrowserStore.getState();
      addTab('https://claude.ai', 'persist:webauth-claude', 'webauth');
      const { tabs } = useBrowserStore.getState();

      expect(tabs[0].partition).toBe('persist:webauth-claude');
      expect(tabs[0].category).toBe('webauth');
    });

    it('addTab generates unique IDs for multiple tabs', () => {
      const { addTab } = useBrowserStore.getState();
      const id1 = addTab();
      const id2 = addTab();
      const id3 = addTab();

      expect(id1).not.toBe(id2);
      expect(id2).not.toBe(id3);
    });

    it('closeTab removes tab and activates next', () => {
      const { addTab } = useBrowserStore.getState();
      const id1 = addTab('https://a.com');
      const id2 = addTab('https://b.com');
      const id3 = addTab('https://c.com');

      // Active is id3 (last added)
      useBrowserStore.getState().setActiveTab(id2);
      useBrowserStore.getState().closeTab(id2);

      const { tabs, activeTabId } = useBrowserStore.getState();
      expect(tabs).toHaveLength(2);
      expect(tabs.find((t) => t.id === id2)).toBeUndefined();
      // Should activate the tab at the same index (id3)
      expect(activeTabId).toBe(id3);
    });

    it('closeTab on last tab sets activeTabId to null', () => {
      const { addTab } = useBrowserStore.getState();
      const id = addTab();
      useBrowserStore.getState().closeTab(id);

      const { tabs, activeTabId } = useBrowserStore.getState();
      expect(tabs).toHaveLength(0);
      expect(activeTabId).toBeNull();
    });

    it('closeTab on non-active tab preserves activeTabId', () => {
      const { addTab } = useBrowserStore.getState();
      const id1 = addTab('https://a.com');
      const id2 = addTab('https://b.com');

      useBrowserStore.getState().setActiveTab(id2);
      useBrowserStore.getState().closeTab(id1);

      expect(useBrowserStore.getState().activeTabId).toBe(id2);
    });

    it('closeTab with unknown tabId is a no-op', () => {
      const { addTab } = useBrowserStore.getState();
      addTab();
      useBrowserStore.getState().closeTab('nonexistent');

      expect(useBrowserStore.getState().tabs).toHaveLength(1);
    });

    it('setActiveTab updates activeTabId', () => {
      const { addTab } = useBrowserStore.getState();
      const id1 = addTab();
      const id2 = addTab();

      useBrowserStore.getState().setActiveTab(id1);
      expect(useBrowserStore.getState().activeTabId).toBe(id1);
    });

    it('setActiveTab ignores unknown tabId', () => {
      const { addTab } = useBrowserStore.getState();
      const id = addTab();

      useBrowserStore.getState().setActiveTab('nonexistent');
      expect(useBrowserStore.getState().activeTabId).toBe(id);
    });

    it('updateTab merges partial updates', () => {
      const { addTab } = useBrowserStore.getState();
      const id = addTab();

      useBrowserStore.getState().updateTab(id, {
        title: 'Updated Title',
        url: 'https://updated.com',
        isLoading: true,
      });

      const tab = useBrowserStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.title).toBe('Updated Title');
      expect(tab?.url).toBe('https://updated.com');
      expect(tab?.isLoading).toBe(true);
      expect(tab?.partition).toBe('persist:browser-shared'); // unchanged
    });
  });

  // ── Navigation ──

  describe('navigation', () => {
    it('navigate calls webview callback with active tab ID', () => {
      const { addTab } = useBrowserStore.getState();
      const id = addTab();
      useBrowserStore.getState().navigate('https://example.com');

      expect(mockNavigate).toHaveBeenCalledWith(id, 'https://example.com');
    });

    it('navigate does nothing if no active tab', () => {
      useBrowserStore.getState().navigate('https://example.com');
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('goBack calls webview callback', () => {
      const { addTab } = useBrowserStore.getState();
      const id = addTab();
      useBrowserStore.getState().goBack();

      expect(mockGoBack).toHaveBeenCalledWith(id);
    });

    it('goForward calls webview callback', () => {
      const { addTab } = useBrowserStore.getState();
      const id = addTab();
      useBrowserStore.getState().goForward();

      expect(mockGoForward).toHaveBeenCalledWith(id);
    });

    it('reload calls webview callback', () => {
      const { addTab } = useBrowserStore.getState();
      const id = addTab();
      useBrowserStore.getState().reload();

      expect(mockReload).toHaveBeenCalledWith(id);
    });
  });

  // ── Panel State ──

  describe('panel state', () => {
    it('togglePanel flips panelOpen', () => {
      expect(useBrowserStore.getState().panelOpen).toBe(false);
      useBrowserStore.getState().togglePanel();
      expect(useBrowserStore.getState().panelOpen).toBe(true);
      useBrowserStore.getState().togglePanel();
      expect(useBrowserStore.getState().panelOpen).toBe(false);
    });

    it('openPanel sets panelOpen to true', () => {
      useBrowserStore.getState().openPanel();
      expect(useBrowserStore.getState().panelOpen).toBe(true);
    });

    it('closePanel sets panelOpen to false', () => {
      useBrowserStore.setState({ panelOpen: true });
      useBrowserStore.getState().closePanel();
      expect(useBrowserStore.getState().panelOpen).toBe(false);
    });

    it('setPanelWidth clamps between MIN and MAX', () => {
      useBrowserStore.getState().setPanelWidth(100);
      expect(useBrowserStore.getState().panelWidth).toBe(320); // MIN

      useBrowserStore.getState().setPanelWidth(2000);
      expect(useBrowserStore.getState().panelWidth).toBe(1200); // MAX

      useBrowserStore.getState().setPanelWidth(600);
      expect(useBrowserStore.getState().panelWidth).toBe(600);
    });

    it('setPanelWidth 0 means 50% mode', () => {
      useBrowserStore.getState().setPanelWidth(0);
      expect(useBrowserStore.getState().panelWidth).toBe(0);
    });
  });

  // ── Zoom ──

  describe('zoom', () => {
    it('setZoom updates active tab zoomFactor', () => {
      const { addTab } = useBrowserStore.getState();
      const id = addTab();

      useBrowserStore.getState().setZoom(1.5);
      const tab = useBrowserStore.getState().tabs.find((t) => t.id === id);
      expect(tab?.zoomFactor).toBe(1.5);
    });

    it('setZoom clamps between 0.25 and 5.0', () => {
      const { addTab } = useBrowserStore.getState();
      const id = addTab();

      useBrowserStore.getState().setZoom(0.1);
      expect(useBrowserStore.getState().tabs.find((t) => t.id === id)?.zoomFactor).toBe(0.25);

      useBrowserStore.getState().setZoom(10);
      expect(useBrowserStore.getState().tabs.find((t) => t.id === id)?.zoomFactor).toBe(5.0);
    });

    it('setZoom calls IPC', () => {
      const { addTab } = useBrowserStore.getState();
      addTab();
      useBrowserStore.getState().setZoom(1.5);

      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith(
        'browser:tab:setZoom',
        expect.any(String),
        1.5
      );
    });

    it('setZoom does nothing without active tab', () => {
      useBrowserStore.getState().setZoom(1.5);
      expect(window.electron.ipcRenderer.invoke).not.toHaveBeenCalledWith(
        'browser:tab:setZoom',
        expect.anything(),
        expect.anything()
      );
    });
  });

  // ── Detach/Attach ──

  describe('detach/attach', () => {
    it('setDetached updates state and calls IPC', () => {
      useBrowserStore.getState().setDetached(true);
      expect(useBrowserStore.getState().detached).toBe(true);
      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith('browser:panel:detach');

      useBrowserStore.getState().setDetached(false);
      expect(useBrowserStore.getState().detached).toBe(false);
      expect(window.electron.ipcRenderer.invoke).toHaveBeenCalledWith('browser:panel:attach');
    });
  });
});
