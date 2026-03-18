/**
 * WebAuthViewManager — WebContentsView-based browser tabs for WebAuth sessions
 *
 * Completely independent from AutomationViewManager (automation-views.ts).
 * Uses anti-detection preload for Google OAuth and other services that
 * block embedded browsers / Electron apps.
 *
 * These views are embedded inside the main BrowserWindow and positioned
 * in the Settings page browser panel area. The renderer communicates tab
 * bounds via IPC so main process can setBounds() correctly.
 */

import { WebContentsView, session } from 'electron';
import type { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { logger } from '../utils/logger';

const LOG_TAG = '[WebAuthViews]';

// Anti-detection preload script path (CommonJS, runs at document_start)
const ANTI_DETECTION_PRELOAD = join(__dirname, '..', 'browser', 'anti-detection-preload.cjs');

export interface WebAuthTab {
  id: string;
  view: WebContentsView;
  url: string;
  title: string;
  partition: string;
}

class WebAuthViewManager {
  private mainWindow: BrowserWindow | null = null;
  private tabs = new Map<string, WebAuthTab>();
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
    // Apply bounds to ALL tabs — show active, hide others
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

  /** Create a new webauth tab with WebContentsView + anti-detection */
  createTab(tabId: string, url: string, partition = 'persist:webauth-default'): WebAuthTab {
    if (!this.mainWindow) throw new Error('Main window not set');

    const ses = session.fromPartition(partition);

    // Set user-agent to match real Chrome
    const chromeVersion = process.versions.chrome || '130.0.0.0';
    const majorVersion = chromeVersion.split('.')[0];
    const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
    ses.setUserAgent(ua);

    // Remove ALL Electron/embedded-browser fingerprints from headers
    ses.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = { ...details.requestHeaders };

      // Remove Electron-specific headers
      delete headers['X-Electron-Version'];

      // sec-ch-ua family — must match real Chrome exactly
      headers['sec-ch-ua'] = `"Chromium";v="${majorVersion}", "Google Chrome";v="${majorVersion}", "Not-A.Brand";v="99"`;
      headers['sec-ch-ua-platform'] = '"macOS"';
      headers['sec-ch-ua-mobile'] = '?0';
      if (headers['sec-ch-ua-full-version-list'] !== undefined) {
        headers['sec-ch-ua-full-version-list'] = `"Chromium";v="${chromeVersion}", "Google Chrome";v="${chromeVersion}", "Not-A.Brand";v="99.0.0.0"`;
      }

      // Fix Sec-Fetch-Dest — Electron may send "webview" instead of "document"
      if (headers['Sec-Fetch-Dest'] === 'webview') {
        headers['Sec-Fetch-Dest'] = 'document';
      }

      // Ensure Sec-Fetch-Site is correct for Google OAuth redirects
      // Google checks this to detect embedded browsers
      if (details.url.includes('accounts.google.com') && headers['Sec-Fetch-Site'] === 'none') {
        // Keep as 'none' for direct navigation — this is correct
      }

      callback({ requestHeaders: headers });
    });

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        nodeIntegration: false,
        contextIsolation: false,
        sandbox: false,
        preload: ANTI_DETECTION_PRELOAD,
      },
    });

    const tab: WebAuthTab = { id: tabId, view, url, title: 'New Tab', partition };
    this.tabs.set(tabId, tab);

    // Add to main window — start hidden until panel reports valid bounds
    this.mainWindow.contentView.addChildView(view);
    if (this.panelBounds.width <= 0 || this.panelBounds.height <= 0 || this.panelBounds.x < -9000) {
      view.setVisible(false);
    }

    // Notify renderer to add tab to store
    this.notifyRenderer('webauth:browser:tab:created', {
      id: tabId, url, title: 'New Tab', partition,
      isLoading: true,
      canGoBack: false, canGoForward: false, zoomFactor: 0.8,
    });

    // Track navigation and loading events
    view.webContents.on('did-start-loading', () => {
      this.notifyRenderer('webauth:browser:tab:updated', tabId, { isLoading: true });
      // Auto-activate tab when it starts loading
      if (this.activeTabId !== tabId) {
        this.setActiveTab(tabId);
        this.notifyRenderer('webauth:browser:tab:activated', tabId);
      }
    });

    view.webContents.on('did-stop-loading', () => {
      tab.url = view.webContents.getURL();
      tab.title = view.webContents.getTitle();
      this.notifyRenderer('webauth:browser:tab:updated', tabId, {
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
      this.notifyRenderer('webauth:browser:tab:updated', tabId, {
        url: tab.url,
        title: tab.title,
        canGoBack: view.webContents.canGoBack(),
        canGoForward: view.webContents.canGoForward(),
      });
    });

    view.webContents.on('did-navigate-in-page', () => {
      tab.url = view.webContents.getURL();
      this.notifyRenderer('webauth:browser:tab:updated', tabId, { url: tab.url });
    });

    view.webContents.on('page-title-updated', (_, title) => {
      tab.title = title;
      this.notifyRenderer('webauth:browser:tab:updated', tabId, { title: `[WebAuth] ${title}` });
    });

    view.webContents.on('page-favicon-updated', (_, favicons) => {
      if (favicons.length > 0) {
        this.notifyRenderer('webauth:browser:tab:updated', tabId, { favicon: favicons[0] });
      }
    });

    // Enhanced anti-detection injected at dom-ready (supplements preload)
    view.webContents.on('dom-ready', () => {
      view.webContents.executeJavaScript(`
        try {
          // Ensure navigator.webdriver is undefined
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined, configurable: true });

          // Realistic navigator.plugins (PluginArray-like objects)
          const fakePlugins = {
            0: { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1, 0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' } },
            1: { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: '', length: 1, 0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: '' } },
            2: { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1, 0: { type: 'application/pdf', suffixes: 'pdf', description: '' } },
            3: { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2, 0: { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' }, 1: { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' } },
            4: { name: 'Chromium PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1, 0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' } },
            length: 5,
            item(i) { return this[i] || null; },
            namedItem(n) { for (let i = 0; i < this.length; i++) { if (this[i] && this[i].name === n) return this[i]; } return null; },
            refresh() {},
            [Symbol.iterator]: function*() { for (let i = 0; i < this.length; i++) if (this[i]) yield this[i]; },
          };
          Object.defineProperty(navigator, 'plugins', { get: () => fakePlugins, configurable: true });

          // window.chrome object with runtime, csi, loadTimes
          if (!window.chrome) window.chrome = {};
          if (!window.chrome.runtime) {
            window.chrome.runtime = {
              connect() {
                return {
                  onMessage: { addListener() {} },
                  postMessage() {},
                  onDisconnect: { addListener() {} },
                };
              },
              sendMessage() {},
              id: undefined,
            };
          }
          if (!window.chrome.csi) {
            window.chrome.csi = function() {
              return { onloadT: Date.now(), pageT: performance.now(), startE: Date.now(), tran: 15 };
            };
          }
          if (!window.chrome.loadTimes) {
            window.chrome.loadTimes = function() {
              return {
                commitLoadTime: Date.now() / 1000, connectionInfo: 'h2',
                finishDocumentLoadTime: Date.now() / 1000, finishLoadTime: Date.now() / 1000,
                firstPaintAfterLoadTime: 0, firstPaintTime: Date.now() / 1000,
                navigationType: 'Other', npnNegotiatedProtocol: 'h2',
                requestTime: Date.now() / 1000, startLoadTime: Date.now() / 1000,
                wasAlternateProtocolAvailable: false, wasFetchedViaSpdy: true, wasNpnNegotiated: true,
              };
            };
          }

          // navigator.userAgentData override
          const chromeVer = navigator.userAgent.match(/Chrome\\/(\\d+)/)?.[1] || '130';
          const fullVer = navigator.userAgent.match(/Chrome\\/([\\d.]+)/)?.[1] || '130.0.0.0';
          const fakeUAData = {
            brands: [
              { brand: 'Chromium', version: chromeVer },
              { brand: 'Google Chrome', version: chromeVer },
              { brand: 'Not-A.Brand', version: '99' },
            ],
            mobile: false,
            platform: 'macOS',
            getHighEntropyValues(hints) {
              return Promise.resolve({
                brands: this.brands, mobile: false, platform: 'macOS',
                platformVersion: '15.3.0', architecture: 'arm', bitness: '64', model: '',
                uaFullVersion: fullVer,
                fullVersionList: [
                  { brand: 'Chromium', version: fullVer },
                  { brand: 'Google Chrome', version: fullVer },
                  { brand: 'Not-A.Brand', version: '99.0.0.0' },
                ],
                wow64: false,
              });
            },
            toJSON() { return { brands: this.brands, mobile: this.mobile, platform: this.platform }; },
          };
          Object.defineProperty(navigator, 'userAgentData', { get: () => fakeUAData, configurable: true });

          Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
        } catch(e) {}
      `).catch(() => {});
    });

    // ── Google OAuth workaround ──
    // Google blocks sign-in from WebContentsView because the main process has
    // --remote-debugging-port=9222 enabled. We detect Google login redirects and
    // notify the renderer to show a <webview> tag instead (which runs in a
    // separate renderer process NOT affected by the CDP port flag).
    view.webContents.on('will-navigate', (event, navUrl) => {
      if (navUrl.includes('accounts.google.com')) {
        event.preventDefault();
        logger.info(`${LOG_TAG} Google login detected for tab ${tabId}, switching to webview mode`);
        // Tell renderer to use <webview> for this tab's login
        this.notifyRenderer('webauth:browser:google-login', tabId, navUrl, tab.partition);
      }
    });

    view.webContents.on('will-redirect', (event, navUrl) => {
      if (navUrl.includes('accounts.google.com')) {
        event.preventDefault();
        logger.info(`${LOG_TAG} Google login redirect for tab ${tabId}, switching to webview mode`);
        this.notifyRenderer('webauth:browser:google-login', tabId, navUrl, tab.partition);
      }
    });

    // Prevent popups — navigate in the same view instead of opening new window
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (url && url !== 'about:blank') {
        view.webContents.loadURL(url).catch(() => {});
      }
      return { action: 'deny' };
    });

    // Auto-cleanup when webContents is destroyed externally
    view.webContents.on('destroyed', () => {
      if (this.tabs.has(tabId)) {
        logger.info(`${LOG_TAG} webContents destroyed externally for tab ${tabId}, cleaning up`);
        this.tabs.delete(tabId);
        if (this.activeTabId === tabId) {
          this.activeTabId = null;
          const remaining = [...this.tabs.keys()];
          if (remaining.length > 0) {
            this.setActiveTab(remaining[remaining.length - 1]);
          }
        }
        if (this.mainWindow) {
          try { this.mainWindow.contentView.removeChildView(view); } catch { /* already removed */ }
        }
        this.notifyRenderer('webauth:browser:tab:closed', tabId);
      }
    });

    // Navigate
    if (url && url !== 'about:blank') {
      view.webContents.loadURL(url).catch((err) => {
        logger.error(`${LOG_TAG} Failed to load ${url}:`, err);
      });
    }

    // Set as active
    this.setActiveTab(tabId);

    logger.info(`${LOG_TAG} Created tab ${tabId} -> ${url}`);
    return tab;
  }

  /** Close and remove a tab */
  closeTab(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;

    if (this.mainWindow) {
      try { this.mainWindow.contentView.removeChildView(tab.view); } catch { /* already removed */ }
    }

    // Destroy the webContents
    try {
      if (!tab.view.webContents.isDestroyed()) {
        (tab.view.webContents as { destroy?: () => void })?.destroy?.();
      }
    } catch { /* already destroyed */ }
    this.tabs.delete(tabId);

    if (this.activeTabId === tabId) {
      this.activeTabId = null;
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

  /** Navigate a tab */
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

  getTab(tabId: string): WebAuthTab | undefined {
    return this.tabs.get(tabId);
  }

  getAllTabs(): WebAuthTab[] {
    return [...this.tabs.values()];
  }

  getActiveTabId(): string | null {
    return this.activeTabId;
  }

  /** Find existing tab by partition */
  getViewForPartition(partition: string): WebAuthTab | undefined {
    for (const tab of this.tabs.values()) {
      if (tab.partition === partition) return tab;
    }
    return undefined;
  }

  /** Notify renderer of tab state changes */
  private notifyRenderer(channel: string, ...args: unknown[]): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(channel, ...args);
    }
  }

  private updateActiveViewBounds(): void {
    if (this.activeTabId) {
      const tab = this.tabs.get(this.activeTabId);
      if (tab && this.panelBounds.width > 0 && this.panelBounds.height > 0) {
        tab.view.setBounds(this.panelBounds);
      }
    }
  }

  /**
   * Called from renderer after Google login completes in <webview>.
   * Reloads the WebContentsView with the provider URL — cookies from
   * the webview's partition are shared, so the view will be authenticated.
   */
  reloadAfterGoogleLogin(tabId: string, providerUrl: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return;

    logger.info(`${LOG_TAG} Reloading tab ${tabId} after Google login → ${providerUrl}`);
    tab.view.webContents.loadURL(providerUrl).catch(() => {});
    this.notifyRenderer('webauth:browser:tab:updated', tabId, {
      url: providerUrl, title: '[WebAuth] Logged in',
    });
  }

  dispose(): void {
    for (const [id] of this.tabs) {
      this.closeTab(id);
    }
  }
}

export const webauthViews = new WebAuthViewManager();
