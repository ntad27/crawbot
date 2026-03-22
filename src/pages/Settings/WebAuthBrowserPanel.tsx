/**
 * WebAuthBrowserPanel — Browser panel embedded in Settings page
 *
 * Uses the independent useWebAuthBrowserStore (NOT useBrowserStore).
 *
 * KEY CHALLENGE: WebContentsView is a native overlay positioned absolutely
 * on the BrowserWindow. When the Settings page scrolls, the native view
 * does NOT scroll with it. We must:
 * 1. Update bounds on every scroll event
 * 2. Hide the view when the content area scrolls out of the visible viewport
 *
 * This component finds the nearest scrollable ancestor and listens to its
 * scroll events to keep the native view in sync.
 */
import { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ZoomIn,
  ZoomOut,
  Lock,
  Globe,
  Cookie,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useWebAuthBrowserStore, type WebAuthBrowserTab, type GoogleLoginState } from '@/stores/webauth-browser';

/** Find the nearest scrollable ancestor of an element */
function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  while (el) {
    const style = getComputedStyle(el);
    if (/(auto|scroll)/.test(style.overflow + style.overflowY)) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

export function WebAuthBrowserPanel() {
  const tabs = useWebAuthBrowserStore((s) => s.tabs);
  const activeTabId = useWebAuthBrowserStore((s) => s.activeTabId);
  const setActiveTab = useWebAuthBrowserStore((s) => s.setActiveTab);
  const googleLogin = useWebAuthBrowserStore((s) => s.googleLogin);
  const setGoogleLogin = useWebAuthBrowserStore((s) => s.setGoogleLogin);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const contentRef = useRef<HTMLDivElement>(null);
  const scrollParentRef = useRef<HTMLElement | null>(null);

  const reportBounds = useCallback(() => {
    if (!contentRef.current) return;
    const rect = contentRef.current.getBoundingClientRect();

    // Check if the content area is visible in the viewport
    const isVisible = rect.bottom > 0 && rect.top < window.innerHeight
      && rect.width > 10 && rect.height > 10;

    if (!isVisible) {
      window.electron?.ipcRenderer?.invoke('webauth:browser:panel:setBounds', {
        x: -9999, y: 0, width: 0, height: 0,
      });
      return;
    }

    // Clip to visible viewport
    const visibleTop = Math.max(0, rect.top);
    const visibleBottom = Math.min(window.innerHeight, rect.bottom);
    const visibleHeight = visibleBottom - visibleTop;

    if (visibleHeight < 10) {
      window.electron?.ipcRenderer?.invoke('webauth:browser:panel:setBounds', {
        x: -9999, y: 0, width: 0, height: 0,
      });
      return;
    }

    window.electron?.ipcRenderer?.invoke('webauth:browser:panel:setBounds', {
      x: Math.round(rect.x),
      y: Math.round(visibleTop),
      width: Math.round(rect.width),
      height: Math.round(visibleHeight),
    });
  }, []);

  // Find scroll parent once on mount, listen to scroll + resize
  useEffect(() => {
    if (!contentRef.current) return;
    const scrollParent = findScrollParent(contentRef.current);
    scrollParentRef.current = scrollParent;

    reportBounds();
    window.addEventListener('resize', reportBounds);

    if (scrollParent) {
      scrollParent.addEventListener('scroll', reportBounds, { passive: true });
    }

    return () => {
      window.removeEventListener('resize', reportBounds);
      if (scrollParent) {
        scrollParent.removeEventListener('scroll', reportBounds);
      }
    };
  }, [reportBounds]);

  // Report bounds with retries after tab changes
  // Hide WebContentsView when googleLogin webview is active (it would block clicks)
  useEffect(() => {
    if (googleLogin) {
      // Google login <webview> overlay is showing — hide native WebContentsView
      window.electron?.ipcRenderer?.invoke('webauth:browser:panel:setBounds', {
        x: -9999, y: 0, width: 0, height: 0,
      });
    } else if (tabs.length > 0 && activeTab) {
      const t1 = setTimeout(reportBounds, 50);
      const t2 = setTimeout(reportBounds, 200);
      const t3 = setTimeout(reportBounds, 500);
      return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    } else {
      window.electron?.ipcRenderer?.invoke('webauth:browser:panel:setBounds', {
        x: -9999, y: 0, width: 0, height: 0,
      });
    }
  }, [tabs.length, activeTab, googleLogin, reportBounds]);

  // Move views offscreen when unmounting (user navigates away from Settings)
  useEffect(() => {
    return () => {
      window.electron?.ipcRenderer?.invoke('webauth:browser:panel:setBounds', {
        x: -9999, y: 0, width: 0, height: 0,
      });
    };
  }, []);

  return (
    <div className="flex flex-col border border-border rounded-lg bg-background overflow-hidden h-[500px]">
      {/* Tab bar — webauth tabs with Lock icon */}
      <div className="flex items-center border-b border-border bg-muted/30 shrink-0 overflow-x-auto">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`group flex items-center gap-1 px-2 py-1.5 cursor-pointer border-r border-border max-w-[180px] min-w-[80px] text-xs ${
              tab.id === activeTabId
                ? 'bg-background text-foreground'
                : 'bg-muted/50 text-muted-foreground hover:bg-muted'
            }`}
            onClick={() => setActiveTab(tab.id)}
            title={tab.url}
          >
            <Lock className="h-3 w-3 shrink-0 text-amber-500" />
            {tab.isLoading ? (
              <div className="h-3 w-3 shrink-0 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            ) : tab.favicon ? (
              <img src={tab.favicon} className="h-3 w-3 shrink-0" alt="" />
            ) : (
              <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate flex-1">
              {(tab.title || 'New Tab').length > 18
                ? (tab.title || 'New Tab').slice(0, 18) + '...'
                : tab.title || 'New Tab'}
            </span>
          </div>
        ))}
        {tabs.length === 0 && (
          <div className="px-3 py-1.5 text-xs text-muted-foreground">
            No sessions
          </div>
        )}
      </div>

      {/* Toolbar */}
      {activeTab && <WebAuthToolbar tab={activeTab} />}

      {/* Content area */}
      <div
        ref={contentRef}
        className="flex-1 relative min-h-0"
      >
        {/* Google login <webview> overlay — shown when Google OAuth is detected */}
        {googleLogin && (
          <GoogleLoginWebview
            state={googleLogin}
            onComplete={(providerUrl) => {
              setGoogleLogin(null);
              // Tell main process to reload the WebContentsView with cookies
              window.electron?.ipcRenderer?.invoke(
                'webauth:browser:google-login-done',
                googleLogin.tabId,
                providerUrl
              );
            }}
            onCancel={() => setGoogleLogin(null)}
          />
        )}

        {/* Normal content (WebContentsView overlay from main process) */}
        {!googleLogin && tabs.length === 0 && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4 text-center">
            No WebAuth sessions active.<br />
            Click &quot;Login&quot; on a provider to open its login page here.
          </div>
        )}
        {!googleLogin && tabs.length > 0 && !activeTab && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            Select a tab above to view.
          </div>
        )}
      </div>
    </div>
  );
}

// ── Inline Toolbar (uses webauth-browser store) ──

function WebAuthToolbar({ tab }: { tab: WebAuthBrowserTab }) {
  const navigate = useWebAuthBrowserStore((s) => s.navigate);
  const goBack = useWebAuthBrowserStore((s) => s.goBack);
  const goForward = useWebAuthBrowserStore((s) => s.goForward);
  const reload = useWebAuthBrowserStore((s) => s.reload);
  const setZoom = useWebAuthBrowserStore((s) => s.setZoom);
  const [isImporting, setIsImporting] = useState(false);

  const [urlInput, setUrlInput] = useState(tab.url);
  const [isEditing, setIsEditing] = useState(false);
  const justNavigatedRef = useRef(false);

  useEffect(() => {
    if (!isEditing) {
      setUrlInput(tab.url);
    }
  }, [tab.url, isEditing]);

  const handleNavigate = useCallback(() => {
    let url = urlInput.trim();
    if (!url) return;

    url = url.replace(/^https?\/\//i, 'https://');
    url = url.replace(/^htps:\/\//i, 'https://');
    url = url.replace(/^htp:\/\//i, 'http://');

    if (!/^https?:\/\//i.test(url) && !url.startsWith('about:')) {
      if (url.includes('.') && !url.includes(' ')) {
        url = 'https://' + url;
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(url)}`;
      }
    }

    setUrlInput(url);
    justNavigatedRef.current = true;
    navigate(url);
  }, [urlInput, navigate]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleNavigate();
        setIsEditing(false);
        (e.target as HTMLInputElement).blur();
      } else if (e.key === 'Escape') {
        setUrlInput(tab.url);
        setIsEditing(false);
        (e.target as HTMLInputElement).blur();
      }
    },
    [handleNavigate, tab.url]
  );

  const handleFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    setIsEditing(true);
    const input = e.target;
    requestAnimationFrame(() => {
      input.select();
    });
  }, []);

  const handleBlur = useCallback(() => {
    if (justNavigatedRef.current) {
      justNavigatedRef.current = false;
    } else {
      setUrlInput(tab.url);
    }
    setIsEditing(false);
  }, [tab.url]);

  const isSecure = tab.url.startsWith('https://');

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-background shrink-0">
      <NavButton onClick={goBack} disabled={!tab.canGoBack} title="Back">
        <ArrowLeft className="h-3.5 w-3.5" />
      </NavButton>
      <NavButton onClick={goForward} disabled={!tab.canGoForward} title="Forward">
        <ArrowRight className="h-3.5 w-3.5" />
      </NavButton>
      <NavButton onClick={reload} title="Reload">
        <RotateCw className={`h-3.5 w-3.5 ${tab.isLoading ? 'animate-spin' : ''}`} />
      </NavButton>

      <div className="flex-1 flex items-center gap-1 bg-muted/50 rounded px-2 py-1 text-xs border border-transparent focus-within:border-primary/50">
        {isSecure && !isEditing && <Lock className="h-3 w-3 text-green-500 shrink-0" />}
        <input
          type="text"
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onFocus={handleFocus}
          onBlur={handleBlur}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent outline-none text-foreground placeholder:text-muted-foreground"
          placeholder="Enter URL or search..."
          spellCheck={false}
        />
      </div>

      <NavButton onClick={() => setZoom(tab.zoomFactor - 0.1)} title="Zoom out">
        <ZoomOut className="h-3.5 w-3.5" />
      </NavButton>
      <span className="text-[10px] text-muted-foreground w-8 text-center">
        {Math.round(tab.zoomFactor * 100)}%
      </span>
      <NavButton onClick={() => setZoom(tab.zoomFactor + 0.1)} title="Zoom in">
        <ZoomIn className="h-3.5 w-3.5" />
      </NavButton>

      {/* Import cookies from Chrome */}
      <NavButton
        onClick={async () => {
          if (isImporting || !tab.url || tab.url === 'about:blank') return;
          setIsImporting(true);
          try {
            const result = await window.electron.ipcRenderer.invoke(
              'browser:cookies:import-from-chrome',
              tab.partition,
              tab.url,
            ) as { success: boolean; imported?: number; error?: string };
            if (result.success) {
              toast.success(`Imported ${result.imported} cookies from Chrome`);
              reload();
              // Trigger WebAuth pipeline refresh (updates provider status + models)
              window.electron.ipcRenderer.invoke('webauth:pipeline:refresh').catch(() => {});
            } else {
              toast.error(`Failed to import cookies: ${result.error}`);
            }
          } catch (err) {
            toast.error(`Import failed: ${String(err)}`);
          }
          setIsImporting(false);
        }}
        disabled={isImporting || !tab.url || tab.url === 'about:blank'}
        title="Import cookies from Chrome"
      >
        {isImporting
          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
          : <Cookie className="h-3.5 w-3.5" />
        }
      </NavButton>
    </div>
  );
}

function NavButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title: string;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
    >
      {children}
    </button>
  );
}

// ── Google Login Webview ──
// Uses <webview> tag (renderer process) instead of WebContentsView (main process).
// <webview> is NOT affected by --remote-debugging-port, so Google allows login.

function GoogleLoginWebview({
  state,
  onComplete,
  onCancel,
}: {
  state: GoogleLoginState;
  onComplete: (providerUrl: string) => void;
  onCancel: () => void;
}) {
  const webviewRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handleNavigate = (event: any) => {
      const url = String(event?.url || '');
      if (url && !url.includes('accounts.google.com') && !url.includes('myaccount.google.com')) {
        onComplete(url);
      }
    };

    // Inject anti-detection — exact same code from working commit 7b11e7d
    const handleDomReady = () => {
      const webview = wv as unknown as { executeJavaScript: (code: string) => Promise<unknown> };
      if (!webview.executeJavaScript) return;
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

    wv.addEventListener('did-navigate', handleNavigate);
    wv.addEventListener('dom-ready', handleDomReady);
    return () => {
      wv.removeEventListener('did-navigate', handleNavigate);
      wv.removeEventListener('dom-ready', handleDomReady);
    };
  }, [onComplete]);

  return (
    <div className="absolute inset-0 z-50 bg-background flex flex-col">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/30 text-xs">
        <span className="font-medium">Google Sign-in</span>
        <button
          onClick={onCancel}
          className="px-2 py-0.5 rounded hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
        >
          Cancel
        </button>
      </div>
      <webview
        ref={webviewRef}
        src={state.googleUrl}
        partition={state.partition}
        style={{ flex: 1, width: '100%', height: '100%', display: 'flex' }}
        allowpopups={'true' as unknown as boolean}
        webpreferences="contextIsolation=no, nodeIntegration=no"
      />
    </div>
  );
}
