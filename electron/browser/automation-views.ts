/**
 * AutomationViews — WebContentsView-based browser tabs for CDP automation
 *
 * Uses WebContentsView instead of <webview> for automation tabs because:
 * - WebContentsView creates `type: "page"` CDP targets (natively!)
 * - Playwright can control "page" targets via connectOverCDP
 * - <webview> creates `type: "webview"` targets which Playwright ignores
 *
 * These views are embedded inside the main BrowserWindow and positioned
 * in the browser panel area (right side). The renderer communicates tab
 * bounds via IPC so main process can setBounds() correctly.
 */

import { BrowserWindow, WebContentsView, session } from 'electron';
import { logger } from '../utils/logger';

const LOG_TAG = '[AutomationViews]';

export interface AutomationTab {
  id: string;
  view: WebContentsView;
  url: string;
  title: string;
  partition: string;
}

class AutomationViewManager {
  private mainWindow: BrowserWindow | null = null;
  private tabs = new Map<string, AutomationTab>();
  private activeTabId: string | null = null;
  private panelBounds = { x: 0, y: 0, width: 800, height: 600 };

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;

    // Reposition views when window resizes
    win.on('resize', () => this.updateActiveViewBounds());
  }

  /** Update the panel area bounds (called from renderer via IPC) */
  setPanelBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.panelBounds = bounds;
    // Apply bounds to ALL tabs (not just active) so they're ready when switched to
    for (const [id, tab] of this.tabs) {
      if (id === this.activeTabId) {
        if (bounds.width > 0 && bounds.height > 0) {
          tab.view.setVisible(true);
          tab.view.setBounds(bounds);
        } else {
          tab.view.setVisible(false);
        }
      } else {
        tab.view.setVisible(false);
      }
    }
  }

  /** Create a new automation tab with WebContentsView */
  createTab(tabId: string, url: string, partition = 'persist:browser-shared'): AutomationTab {
    if (!this.mainWindow) throw new Error('Main window not set');

    const ses = session.fromPartition(partition);

    // Set user-agent to match real Chrome
    const chromeVersion = process.versions.chrome || '130.0.0.0';
    const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    ses.setUserAgent(ua);

    // Remove Electron from headers
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };
      delete headers['X-Electron-Version'];
      if (headers['sec-ch-ua']) {
        headers['sec-ch-ua'] = `"Chromium";v="${chromeVersion.split('.')[0]}", "Google Chrome";v="${chromeVersion.split('.')[0]}", "Not-A.Brand";v="99"`;
      }
      callback({ requestHeaders: headers });
    });

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });

    const tab: AutomationTab = { id: tabId, view, url, title: 'New Tab', partition };
    this.tabs.set(tabId, tab);

    // Add to main window
    this.mainWindow.contentView.addChildView(view);

    // Track navigation and loading events
    view.webContents.on('did-start-loading', () => {
      this.notifyRenderer('browser:tab:updated', tabId, { isLoading: true });
      // Auto-activate tab when it starts loading (e.g., agent navigated it)
      if (this.activeTabId !== tabId) {
        this.setActiveTab(tabId);
        this.notifyRenderer('browser:tab:activated', tabId);
      }
    });

    view.webContents.on('did-stop-loading', () => {
      tab.url = view.webContents.getURL();
      tab.title = view.webContents.getTitle();
      this.notifyRenderer('browser:tab:updated', tabId, {
        url: tab.url,
        title: tab.title,
        isLoading: false,
        canGoBack: view.webContents.canGoBack(),
        canGoForward: view.webContents.canGoForward(),
      });
    });

    view.webContents.on('did-navigate', () => {
      tab.url = view.webContents.getURL();
      tab.title = view.webContents.getTitle();
      this.notifyRenderer('browser:tab:updated', tabId, {
        url: tab.url,
        title: tab.title,
        canGoBack: view.webContents.canGoBack(),
        canGoForward: view.webContents.canGoForward(),
      });
    });

    view.webContents.on('did-navigate-in-page', () => {
      tab.url = view.webContents.getURL();
      this.notifyRenderer('browser:tab:updated', tabId, { url: tab.url });
    });

    view.webContents.on('page-title-updated', (_, title) => {
      tab.title = title;
      this.notifyRenderer('browser:tab:updated', tabId, { title });
    });

    view.webContents.on('page-favicon-updated', (_, favicons) => {
      if (favicons.length > 0) {
        this.notifyRenderer('browser:tab:updated', tabId, { favicon: favicons[0] });
      }
    });

    // When this tab's webContents gets focus (e.g., from CDP/Playwright bringToFront),
    // sync the active tab to renderer
    view.webContents.on('focus', () => {
      if (this.activeTabId !== tabId) {
        this.setActiveTab(tabId);
        this.notifyRenderer('browser:tab:activated', tabId);
      }
    });

  /** Activate a tab by matching its webContents ID */
  activateByWebContentsId(webContentsId: number): boolean {
    for (const [tabId, tab] of this.tabs) {
      if (tab.view.webContents.id === webContentsId) {
        if (this.activeTabId !== tabId) {
          this.setActiveTab(tabId);
          this.notifyRenderer('browser:tab:activated', tabId);
        }
        return true;
      }
    }
    return false;
  }

  /** Find webContents ID by CDP targetId (hex string from /json/list) */
  findWebContentsIdByUrl(url: string): number | null {
    for (const tab of this.tabs.values()) {
      if (tab.view.webContents.getURL() === url) {
        return tab.view.webContents.id;
      }
    }
    return null;
  }

    // Inject anti-detection
    view.webContents.on('dom-ready', () => {
      view.webContents.executeJavaScript(`
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        } catch(e) {}
      `).catch(() => {});
    });

    // Navigate
    if (url && url !== 'about:blank') {
      view.webContents.loadURL(url).catch((err) => {
        logger.error(`${LOG_TAG} Failed to load ${url}:`, err);
      });
    }

    // Set as active
    this.setActiveTab(tabId);

    logger.info(`${LOG_TAG} Created tab ${tabId} → ${url}`);
    return tab;
  }

  /** Close and remove a tab */
  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    if (this.mainWindow) {
      this.mainWindow.contentView.removeChildView(tab.view);
    }

    // Destroy the webContents
    (tab.view.webContents as { destroy?: () => void })?.destroy?.();
    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      // Activate another tab if available
      const remaining = [...this.tabs.keys()];
      if (remaining.length > 0) {
        this.setActiveTab(remaining[remaining.length - 1]);
      }
    }

    logger.info(`${LOG_TAG} Closed tab ${tabId}`);
  }

  /** Set active tab — shows it on top and hides others */
  setActiveTab(tabId: string): void {
    this.activeTabId = tabId;

    for (const [id, tab] of this.tabs) {
      if (id === tabId) {
        // Bring to front: remove and re-add so it's on top
        if (this.mainWindow) {
          try { this.mainWindow.contentView.removeChildView(tab.view); } catch { /* */ }
          this.mainWindow.contentView.addChildView(tab.view);
        }
        tab.view.setVisible(true);
        if (this.panelBounds.width > 0 && this.panelBounds.height > 0) {
          tab.view.setBounds(this.panelBounds);
        }
      } else {
        tab.view.setVisible(false);
      }
    }
  }

  /** Navigate active tab */
  navigateTab(tabId: string, url: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    tab.view.webContents.loadURL(url).catch((err) => {
      logger.error(`${LOG_TAG} Navigate failed:`, err);
    });
  }

  goBack(tabId: string): void {
    this.tabs.get(tabId)?.view.webContents.goBack();
  }

  goForward(tabId: string): void {
    this.tabs.get(tabId)?.view.webContents.goForward();
  }

  reload(tabId: string): void {
    this.tabs.get(tabId)?.view.webContents.reload();
  }

  setZoom(tabId: string, factor: number): void {
    this.tabs.get(tabId)?.view.webContents.setZoomFactor(factor);
  }

  getTab(tabId: string): AutomationTab | undefined {
    return this.tabs.get(tabId);
  }

  getAllTabs(): AutomationTab[] {
    return [...this.tabs.values()];
  }

  /** Notify renderer of tab state changes */
  private notifyRenderer(channel: string, ...args: unknown[]): void {
    this.mainWindow?.webContents.send(channel, ...args);
  }

  private updateActiveViewBounds(): void {
    if (this.activeTabId) {
      const tab = this.tabs.get(this.activeTabId);
      if (tab && this.panelBounds.width > 0 && this.panelBounds.height > 0) {
        logger.info(`${LOG_TAG} Applying bounds to tab ${this.activeTabId}: ${JSON.stringify(this.panelBounds)}`);
        tab.view.setBounds(this.panelBounds);
      }
    }
  }

  dispose(): void {
    for (const [id] of this.tabs) {
      this.closeTab(id);
    }
  }
}

export const automationViews = new AutomationViewManager();
