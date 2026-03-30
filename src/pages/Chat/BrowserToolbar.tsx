/**
 * BrowserToolbar — URL bar, navigation buttons, zoom controls
 */
import { useState, useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  ZoomIn,
  ZoomOut,
  Lock,
  Cookie,
  Loader2,
  Trash2,
} from 'lucide-react';
import { useBrowserStore, type BrowserTab } from '@/stores/browser';
import { toast } from 'sonner';

export function BrowserToolbar({ tab }: { tab: BrowserTab }) {
  const navigate = useBrowserStore((s) => s.navigate);
  const goBack = useBrowserStore((s) => s.goBack);
  const goForward = useBrowserStore((s) => s.goForward);
  const reload = useBrowserStore((s) => s.reload);
  const setZoom = useBrowserStore((s) => s.setZoom);

  const [urlInput, setUrlInput] = useState(tab.url);
  const [isEditing, setIsEditing] = useState(false);
  const justNavigatedRef = useRef(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  // Sync URL bar from tab when NOT editing (e.g., webview navigated internally)
  useEffect(() => {
    if (!isEditing) {
      setUrlInput(tab.url);
    }
  }, [tab.url, isEditing]);

  const handleNavigate = useCallback(() => {
    let url = urlInput.trim();
    if (!url) return;

    // Clean up common typos: "https//", "http//", "htps://"
    url = url.replace(/^https?\/\//i, 'https://');
    url = url.replace(/^htps:\/\//i, 'https://');
    url = url.replace(/^htp:\/\//i, 'http://');

    // Auto-add protocol if missing
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
    // Select all text for easy replacement — use setTimeout to ensure
    // React state update has flushed before selecting
    const input = e.target;
    requestAnimationFrame(() => {
      input.select();
    });
  }, []);

  const handleBlur = useCallback(() => {
    // If we just navigated, keep the typed URL visible
    if (justNavigatedRef.current) {
      justNavigatedRef.current = false;
    } else {
      // User clicked away without navigating — revert to current tab URL
      setUrlInput(tab.url);
    }
    setIsEditing(false);
  }, [tab.url]);

  const handleImportCookies = useCallback(async () => {
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
        // Reload the tab so it picks up the new cookies
        reload();
        // Trigger WebAuth pipeline refresh (updates provider status + models)
        window.electron.ipcRenderer.invoke('webauth:pipeline:refresh').catch(() => {});
      } else {
        toast.error(`Failed to import cookies: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Import cookies failed: ${String(err)}`);
    } finally {
      setIsImporting(false);
    }
  }, [isImporting, tab.url, tab.partition, reload]);

  const handleClearSiteData = useCallback(async () => {
    if (isClearing || !tab.url || tab.url === 'about:blank') return;
    setIsClearing(true);
    try {
      const result = await window.electron.ipcRenderer.invoke(
        'browser:cookies:clear-site-data',
        tab.partition,
        tab.url,
      ) as { success: boolean; error?: string };
      if (result.success) {
        toast.success('Cleared all site data (cookies, storage, cache)');
        reload();
      } else {
        toast.error(`Failed to clear: ${result.error}`);
      }
    } catch (err) {
      toast.error(`Clear failed: ${String(err)}`);
    } finally {
      setIsClearing(false);
    }
  }, [isClearing, tab.url, tab.partition, reload]);

  const isSecure = tab.url.startsWith('https://');

  return (
    <div className="flex items-center gap-1 px-2 py-1 border-b border-border bg-background shrink-0">
      {/* Navigation buttons */}
      <NavButton
        onClick={goBack}
        disabled={!tab.canGoBack}
        title="Back"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
      </NavButton>
      <NavButton
        onClick={goForward}
        disabled={!tab.canGoForward}
        title="Forward"
      >
        <ArrowRight className="h-3.5 w-3.5" />
      </NavButton>
      <NavButton onClick={reload} title="Reload">
        <RotateCw className={`h-3.5 w-3.5 ${tab.isLoading ? 'animate-spin' : ''}`} />
      </NavButton>

      {/* URL bar */}
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

      {/* Zoom controls */}
      <NavButton
        onClick={() => setZoom(tab.zoomFactor - 0.1)}
        title="Zoom out"
      >
        <ZoomOut className="h-3.5 w-3.5" />
      </NavButton>
      <span className="text-[10px] text-muted-foreground w-8 text-center">
        {Math.round(tab.zoomFactor * 100)}%
      </span>
      <NavButton
        onClick={() => setZoom(tab.zoomFactor + 0.1)}
        title="Zoom in"
      >
        <ZoomIn className="h-3.5 w-3.5" />
      </NavButton>

      {/* Import cookies from Chrome */}
      <NavButton
        onClick={handleImportCookies}
        disabled={isImporting || !tab.url || tab.url === 'about:blank'}
        title="Import cookies from Chrome"
      >
        {isImporting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Cookie className="h-3.5 w-3.5" />
        )}
      </NavButton>

      {/* Clear all site data — confirm via toast */}
      <NavButton
        onClick={() => {
          try {
            const hostname = new URL(tab.url).hostname;
            toast(`Clear all data for ${hostname}?`, {
              description: 'Cookies, storage, cache will be deleted',
              action: { label: 'Clear', onClick: handleClearSiteData },
              cancel: { label: 'Cancel', onClick: () => {} },
              duration: 10000,
            });
          } catch (_) {}
        }}
        disabled={isClearing || !tab.url || tab.url === 'about:blank'}
        title="Clear all site data (cookies, storage, cache)"
      >
        {isClearing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Trash2 className="h-3.5 w-3.5" />
        )}
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
