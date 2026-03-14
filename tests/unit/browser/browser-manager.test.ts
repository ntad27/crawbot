/**
 * BrowserManager Tests
 * Tests for tab lifecycle, target categorization, user-agent management
 */
import { describe, it, expect, beforeEach } from 'vitest';

// Mock electron session before import
vi.mock('electron', () => ({
  session: {
    fromPartition: vi.fn().mockReturnValue({
      setUserAgent: vi.fn(),
    }),
  },
}));

import { vi } from 'vitest';
import { BrowserManager } from '@electron/browser/manager';

describe('BrowserManager', () => {
  let manager: BrowserManager;

  beforeEach(() => {
    manager = new BrowserManager();
    manager.setMainWindowId(1);
  });

  // ── Target Categorization ──

  describe('target categorization', () => {
    it('main window is never in exposed set', () => {
      expect(manager.isTargetExposed(1)).toBe(false);
      expect(manager.isKnownTarget(1)).toBe(true);
    });

    it('automation tab webContents is added to exposed set', () => {
      manager.createTab('tab-1', 'https://example.com', 'persist:browser-shared', 'automation');
      manager.attachWebContents('tab-1', 100);

      expect(manager.isTargetExposed(100)).toBe(true);
      expect(manager.getExposedTargetIds().has(100)).toBe(true);
    });

    it('webauth provider webContents is NOT in exposed set', () => {
      manager.createTab('tab-auth', 'https://claude.ai', 'persist:webauth-claude', 'webauth');
      manager.attachWebContents('tab-auth', 200);

      expect(manager.isTargetExposed(200)).toBe(false);
      expect(manager.isKnownTarget(200)).toBe(true);
    });

    it('getExposedTargetIds returns only automation tabs', () => {
      manager.createTab('tab-1', 'https://a.com', 'persist:browser-shared', 'automation');
      manager.attachWebContents('tab-1', 100);

      manager.createTab('tab-2', 'https://b.com', 'persist:browser-shared', 'automation');
      manager.attachWebContents('tab-2', 101);

      manager.createTab('tab-auth', 'https://claude.ai', 'persist:webauth-claude', 'webauth');
      manager.attachWebContents('tab-auth', 200);

      const exposed = manager.getExposedTargetIds();
      expect(exposed.size).toBe(2);
      expect(exposed.has(100)).toBe(true);
      expect(exposed.has(101)).toBe(true);
      expect(exposed.has(200)).toBe(false);
    });

    it('isTargetExposed returns false for unknown ID', () => {
      expect(manager.isTargetExposed(999)).toBe(false);
    });
  });

  // ── Tab Lifecycle ──

  describe('tab lifecycle', () => {
    it('createTab tracks tab by tabId', () => {
      const tab = manager.createTab('tab-1', 'https://example.com', 'persist:browser-shared', 'automation');
      expect(tab.tabId).toBe('tab-1');
      expect(tab.url).toBe('https://example.com');

      const retrieved = manager.getTab('tab-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.url).toBe('https://example.com');
    });

    it('closeTab removes from tracking and exposed set', () => {
      manager.createTab('tab-1', 'https://example.com', 'persist:browser-shared', 'automation');
      manager.attachWebContents('tab-1', 100);
      expect(manager.isTargetExposed(100)).toBe(true);

      manager.closeTab('tab-1');
      expect(manager.getTab('tab-1')).toBeUndefined();
      expect(manager.isTargetExposed(100)).toBe(false);
    });

    it('getAllTabs returns all managed tabs', () => {
      manager.createTab('tab-1', 'https://a.com', 'persist:browser-shared', 'automation');
      manager.createTab('tab-2', 'https://b.com', 'persist:browser-shared', 'automation');
      manager.createTab('tab-auth', 'https://claude.ai', 'persist:webauth-claude', 'webauth');

      expect(manager.getAllTabs()).toHaveLength(3);
    });

    it('attachWebContents sets webContentsId on tab', () => {
      manager.createTab('tab-1', 'https://example.com', 'persist:browser-shared', 'automation');
      manager.attachWebContents('tab-1', 100);

      const tab = manager.getTab('tab-1');
      expect(tab?.webContentsId).toBe(100);
    });

    it('attachWebContents on unknown tab is a no-op', () => {
      manager.attachWebContents('nonexistent', 100);
      expect(manager.isTargetExposed(100)).toBe(false);
    });
  });

  // ── External WebContents (CDP-created) ──

  describe('handleExternalWebContents', () => {
    it('creates new automation tab for unknown webContents', () => {
      const tabId = manager.handleExternalWebContents(300, 'https://new-page.com');

      expect(tabId).toBeTruthy();
      expect(manager.isTargetExposed(300)).toBe(true);

      const tab = manager.getTab(tabId!);
      expect(tab?.url).toBe('https://new-page.com');
      expect(tab?.category).toBe('automation');
    });

    it('returns null for already-tracked webContents', () => {
      manager.createTab('tab-1', 'https://a.com', 'persist:browser-shared', 'automation');
      manager.attachWebContents('tab-1', 100);

      const result = manager.handleExternalWebContents(100, 'https://a.com');
      expect(result).toBeNull();
    });

    it('returns null for main window ID', () => {
      const result = manager.handleExternalWebContents(1, 'file:///app/index.html');
      expect(result).toBeNull();
    });
  });

  // ── Cleanup ──

  describe('dispose', () => {
    it('clears all state', () => {
      manager.createTab('tab-1', 'https://a.com', 'persist:browser-shared', 'automation');
      manager.attachWebContents('tab-1', 100);

      manager.dispose();

      expect(manager.getAllTabs()).toHaveLength(0);
      expect(manager.getExposedTargetIds().size).toBe(0);
    });
  });
});
