/**
 * BrowserWebview — Wrapper around <webview> tag with event handling
 * Syncs webview state back to the browser store.
 * Listens for navigation commands from the store and executes them on the webview.
 */
import { useEffect, useRef, useCallback } from 'react';
import { useBrowserStore, type BrowserTab } from '@/stores/browser';

// Electron's webview element type (not in standard DOM types)
interface WebviewElement extends HTMLElement {
  src: string;
  partition: string;
  loadURL: (url: string) => Promise<void>;
  getURL: () => string;
  getTitle: () => string;
  goBack: () => void;
  goForward: () => void;
  reload: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  setZoomFactor: (factor: number) => void;
  getZoomFactor: () => number;
  executeJavaScript: (code: string) => Promise<unknown>;
  addEventListener: (event: string, listener: (...args: unknown[]) => void) => void;
  removeEventListener: (event: string, listener: (...args: unknown[]) => void) => void;
}

/**
 * Global registry so navigation commands can reach the right webview.
 * Key: tabId, Value: WebviewElement
 */
const webviewRegistry = new Map<string, WebviewElement>();

/** Called by store actions to perform navigation on the actual webview DOM element */
export function navigateWebview(tabId: string, url?: string): void {
  if (!url) return;
  const wv = webviewRegistry.get(tabId);
  if (wv) {
    try { wv.loadURL(url); } catch { /* webview not ready */ }
  }
}

export function goBackWebview(tabId: string): void {
  const wv = webviewRegistry.get(tabId);
  if (wv) { try { wv.goBack(); } catch { /* */ } }
}

export function goForwardWebview(tabId: string): void {
  const wv = webviewRegistry.get(tabId);
  if (wv) { try { wv.goForward(); } catch { /* */ } }
}

export function reloadWebview(tabId: string): void {
  const wv = webviewRegistry.get(tabId);
  if (wv) { try { wv.reload(); } catch { /* */ } }
}

export function BrowserWebview({ tab }: { tab: BrowserTab }) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const updateTab = useBrowserStore((s) => s.updateTab);
  const initialUrlRef = useRef(tab.url);

  // Register webview in global registry
  const setRef = useCallback((el: HTMLElement | null) => {
    const wv = el as WebviewElement | null;
    webviewRef.current = wv;
    if (wv) {
      webviewRegistry.set(tab.id, wv);
    } else {
      webviewRegistry.delete(tab.id);
    }
  }, [tab.id]);

  // Inject anti-detection script when webview is ready
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const onDomReady = () => {
      // Hide Electron/webview fingerprints so sites like Google don't block login
      webview.executeJavaScript(`
        try {
          // Hide navigator.webdriver
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          // Remove Electron from userAgent in navigator
          if (navigator.userAgent.includes('Electron')) {
            Object.defineProperty(navigator, 'userAgent', {
              get: () => navigator.userAgent.replace(/Electron\\/[\\d.]+ /, '')
            });
          }
          // Fake plugins (Chrome has plugins, Electron doesn't)
          Object.defineProperty(navigator, 'plugins', {
            get: () => [1, 2, 3, 4, 5]
          });
          // Fake languages
          Object.defineProperty(navigator, 'languages', {
            get: () => ['en-US', 'en']
          });
        } catch(e) {}
      `).catch(() => {});
    };

    webview.addEventListener('dom-ready', onDomReady);
    return () => webview.removeEventListener('dom-ready', onDomReady);
  }, [tab.id]);

  // Sync webview events → store
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const syncState = () => {
      try {
        updateTab(tab.id, {
          url: webview.getURL(),
          title: webview.getTitle(),
          canGoBack: webview.canGoBack(),
          canGoForward: webview.canGoForward(),
          isLoading: false,
        });
        webview.setZoomFactor(tab.zoomFactor);
      } catch { /* webview may not be ready */ }
    };

    const onDidStartLoading = () => updateTab(tab.id, { isLoading: true });
    const onDidStopLoading = () => syncState();
    const onDidNavigate = () => syncState();

    const onPageTitleUpdated = (e: unknown) => {
      const event = e as { title?: string };
      if (event.title) updateTab(tab.id, { title: event.title });
    };

    const onPageFaviconUpdated = (e: unknown) => {
      const event = e as { favicons?: string[] };
      if (event.favicons?.[0]) updateTab(tab.id, { favicon: event.favicons[0] });
    };

    const onDidFailLoad = (e: unknown) => {
      const event = e as { errorCode?: number };
      if (event.errorCode && event.errorCode !== -3) {
        updateTab(tab.id, { isLoading: false });
      }
    };

    webview.addEventListener('did-navigate', onDidNavigate);
    webview.addEventListener('did-navigate-in-page', onDidNavigate);
    webview.addEventListener('did-start-loading', onDidStartLoading);
    webview.addEventListener('did-stop-loading', onDidStopLoading);
    webview.addEventListener('page-title-updated', onPageTitleUpdated);
    webview.addEventListener('page-favicon-updated', onPageFaviconUpdated);
    webview.addEventListener('did-fail-load', onDidFailLoad);

    return () => {
      webview.removeEventListener('did-navigate', onDidNavigate);
      webview.removeEventListener('did-navigate-in-page', onDidNavigate);
      webview.removeEventListener('did-start-loading', onDidStartLoading);
      webview.removeEventListener('did-stop-loading', onDidStopLoading);
      webview.removeEventListener('page-title-updated', onPageTitleUpdated);
      webview.removeEventListener('page-favicon-updated', onPageFaviconUpdated);
      webview.removeEventListener('did-fail-load', onDidFailLoad);
    };
  }, [tab.id, tab.zoomFactor, updateTab]);

  // Apply zoom changes
  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    try { webview.setZoomFactor(tab.zoomFactor); } catch { /* */ }
  }, [tab.zoomFactor]);

  // Cleanup registry on unmount
  useEffect(() => {
    return () => { webviewRegistry.delete(tab.id); };
  }, [tab.id]);

  return (
    <webview
      ref={setRef as React.Ref<HTMLElement>}
      src={initialUrlRef.current}
      partition={tab.partition}
      webpreferences="contextIsolation=no, nodeIntegration=no"
      className="w-full h-full"
      style={{ display: 'flex' }}
    />
  );
}

// Note: Navigation is now handled by main process via IPC → WebContentsView
// These webview functions are only used for legacy webauth provider tabs
