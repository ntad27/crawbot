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
    this.updateActiveViewBounds();
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

    // Track navigation events
    view.webContents.on('did-navigate', () => {
      tab.url = view.webContents.getURL();
      tab.title = view.webContents.getTitle();
      this.notifyRenderer('browser:tab:updated', tabId, { url: tab.url, title: tab.title });
    });

    view.webContents.on('page-title-updated', (_, title) => {
      tab.title = title;
      this.notifyRenderer('browser:tab:updated', tabId, { title });
    });

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

  /** Set active tab — shows it and hides others */
  setActiveTab(tabId: string): void {
    this.activeTabId = tabId;

    for (const [id, tab] of this.tabs) {
      if (id === tabId) {
        tab.view.setVisible(true);
        tab.view.setBounds(this.panelBounds);
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
      if (tab) {
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
