/**
 * BrowserManager — Tab lifecycle, target categorization, user-agent management
 *
 * Manages the mapping between renderer-side browser tabs (by tab ID)
 * and Electron webContents (by webContents ID). Tracks which targets
 * are exposed to the CDP proxy for OpenClaw browser tool automation.
 */

import { session } from 'electron';

// ── Types ──────────────────────────────────────────────────

export type TabCategory = 'automation' | 'webauth';

export interface ManagedTab {
  tabId: string;
  url: string;
  partition: string;
  category: TabCategory;
  webContentsId?: number; // set once webview attaches
}

// ── BrowserManager ─────────────────────────────────────────

export class BrowserManager {
  /** All managed tabs by tabId */
  private tabs = new Map<string, ManagedTab>();

  /** webContents IDs exposed to CDP (only automation tabs) */
  private exposedTargets = new Set<number>();

  /** webContents IDs that belong to webauth (hidden from CDP) */
  private webauthTargets = new Set<number>();

  /** Main window webContents ID (always hidden from CDP) */
  private mainWindowId: number | null = null;

  // ── Main window ──

  setMainWindowId(id: number): void {
    this.mainWindowId = id;
  }

  // ── Tab lifecycle ──

  createTab(tabId: string, url: string, partition: string, category: TabCategory): ManagedTab {
    const tab: ManagedTab = { tabId, url, partition, category };
    this.tabs.set(tabId, tab);
    this.ensureSessionConfig(partition);
    return tab;
  }

  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    if (tab.webContentsId != null) {
      this.exposedTargets.delete(tab.webContentsId);
      this.webauthTargets.delete(tab.webContentsId);
    }
    this.tabs.delete(tabId);
  }

  getTab(tabId: string): ManagedTab | undefined {
    return this.tabs.get(tabId);
  }

  getAllTabs(): ManagedTab[] {
    return [...this.tabs.values()];
  }

  /** Called when a webview's webContents becomes available (guest-attached) */
  attachWebContents(tabId: string, webContentsId: number): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    tab.webContentsId = webContentsId;

    if (tab.category === 'automation') {
      this.exposedTargets.add(webContentsId);
      this.webauthTargets.delete(webContentsId);
    } else {
      this.webauthTargets.add(webContentsId);
      this.exposedTargets.delete(webContentsId);
    }
  }

  // ── CDP target categorization ──

  /** Returns the set of webContents IDs visible to OpenClaw via CDP proxy */
  getExposedTargetIds(): Set<number> {
    return new Set(this.exposedTargets);
  }

  /** Check if a target ID should be visible in CDP /json/list */
  isTargetExposed(webContentsId: number): boolean {
    return this.exposedTargets.has(webContentsId);
  }

  /** Check if a webContents is tracked by this manager (any category) */
  isKnownTarget(webContentsId: number): boolean {
    if (webContentsId === this.mainWindowId) return true;
    return this.exposedTargets.has(webContentsId) || this.webauthTargets.has(webContentsId);
  }

  /**
   * Handle a new webContents created by CDP (e.g., Target.createTarget).
   * If it's not already tracked, treat it as a new automation tab.
   * Returns the new tabId if created, or null if already tracked.
   */
  handleExternalWebContents(webContentsId: number, url: string): string | null {
    if (this.isKnownTarget(webContentsId)) return null;

    const tabId = `cdp-${Date.now()}-${webContentsId}`;
    const tab: ManagedTab = {
      tabId,
      url,
      partition: 'persist:browser-shared',
      category: 'automation',
      webContentsId,
    };
    this.tabs.set(tabId, tab);
    this.exposedTargets.add(webContentsId);
    return tabId;
  }

  // ── User-Agent ──

  private configuredPartitions = new Set<string>();

  private ensureSessionConfig(partition: string): void {
    if (this.configuredPartitions.has(partition)) return;
    this.configuredPartitions.add(partition);

    try {
      const ses = session.fromPartition(partition);
      const chromeVersion = process.versions.chrome || '130.0.0.0';
      const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
      ses.setUserAgent(ua);

      // Remove "Electron" from client hints and headers that Google checks
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = { ...details.requestHeaders };
        // Remove Electron-specific headers
        delete headers['X-Electron-Version'];
        // Ensure sec-ch-ua doesn't contain "Electron"
        if (headers['sec-ch-ua']) {
          headers['sec-ch-ua'] = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not-A.Brand";v="99"`;
        }
        callback({ requestHeaders: headers });
      });
    } catch (err) {
      console.error(`[BrowserManager] Failed to configure session for partition ${partition}:`, err);
    }
  }

  // ── Cleanup ──

  dispose(): void {
    this.tabs.clear();
    this.exposedTargets.clear();
    this.webauthTargets.clear();
    this.configuredPartitions.clear();
  }
}

/** Singleton instance */
export const browserManager = new BrowserManager();
