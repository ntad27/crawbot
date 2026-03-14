/**
 * BrowserPanel — Resizable right panel for built-in browser
 *
 * Browser tabs are rendered as WebContentsView (main process) overlaid
 * on top of this panel area. This component manages:
 * - Panel layout (resize, hide/show)
 * - Tab bar UI
 * - Toolbar UI (URL, nav, zoom)
 * - Reports panel bounds to main process via IPC so WebContentsView
 *   can be positioned correctly
 *
 * The actual web content is NOT rendered here — it's a native
 * WebContentsView managed by electron/browser/automation-views.ts
 */
import { useRef, useCallback, useEffect, useState } from 'react';
import { PanelRightClose } from 'lucide-react';
import { useBrowserStore } from '@/stores/browser';
import { BrowserTabBar } from './BrowserTabBar';
import { BrowserToolbar } from './BrowserToolbar';

export function BrowserPanel() {
  const panelOpen = useBrowserStore((s) => s.panelOpen);
  const panelWidth = useBrowserStore((s) => s.panelWidth);
  const setPanelWidth = useBrowserStore((s) => s.setPanelWidth);
  const closePanel = useBrowserStore((s) => s.closePanel);
  const closeTab = useBrowserStore((s) => s.closeTab);
  const addTab = useBrowserStore((s) => s.addTab);
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  // ── Panel bounds reporting ──
  // Tell main process where to position the WebContentsView
  const contentRef = useRef<HTMLDivElement>(null);

  const reportBounds = useCallback(() => {
    if (!contentRef.current || !panelOpen) return;
    const rect = contentRef.current.getBoundingClientRect();
    // Account for device pixel ratio
    const dpr = window.devicePixelRatio || 1;
    window.electron?.ipcRenderer?.invoke('browser:panel:setBounds', {
      x: Math.round(rect.x * dpr),
      y: Math.round(rect.y * dpr),
      width: Math.round(rect.width * dpr),
      height: Math.round(rect.height * dpr),
    });
  }, [panelOpen]);

  // Report bounds on mount, resize, and panel state changes
  useEffect(() => {
    reportBounds();
    window.addEventListener('resize', reportBounds);
    return () => window.removeEventListener('resize', reportBounds);
  }, [reportBounds, panelWidth, tabs.length, activeTabId]);

  // Also report after a short delay (DOM layout settling)
  useEffect(() => {
    if (panelOpen) {
      const timer = setTimeout(reportBounds, 100);
      return () => clearTimeout(timer);
    } else {
      // Hide WebContentsView when panel is hidden
      window.electron?.ipcRenderer?.invoke('browser:panel:setBounds', {
        x: -9999, y: 0, width: 0, height: 0,
      });
    }
  }, [panelOpen, reportBounds]);

  // ── Drag resize ──
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(true);
      startXRef.current = e.clientX;
      startWidthRef.current =
        panelWidth === 0 ? window.innerWidth * 0.5 : panelWidth;
    },
    [panelWidth]
  );

  useEffect(() => {
    if (!isDragging) return;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    const handleMouseMove = (e: MouseEvent) => {
      const delta = startXRef.current - e.clientX;
      setPanelWidth(startWidthRef.current + delta);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Report new bounds after resize
      setTimeout(reportBounds, 50);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, setPanelWidth, reportBounds]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!panelOpen) return;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 'w') {
        if (activeTabId) {
          e.preventDefault();
          e.stopPropagation();
          closeTab(activeTabId);
        }
      } else if (mod && e.key === 't') {
        e.preventDefault();
        e.stopPropagation();
        addTab();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [panelOpen, activeTabId, closeTab, addTab]);

  const resolvedWidth = panelWidth === 0 ? '50%' : `${panelWidth}px`;

  return (
    <div
      className="relative flex flex-col border-l border-border bg-background"
      style={panelOpen ? {
        width: resolvedWidth,
        minWidth: 320,
        maxWidth: 1200,
      } : {
        width: 0,
        minWidth: 0,
        overflow: 'hidden',
        borderLeftWidth: 0,
      }}
    >
      {/* Drag handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 z-20"
        onMouseDown={handleMouseDown}
      />

      {/* Drag overlay */}
      {isDragging && (
        <div className="absolute inset-0 z-30" style={{ cursor: 'col-resize' }} />
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Browser
        </span>
        <button
          onClick={closePanel}
          className="p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
          title="Close browser panel"
        >
          <PanelRightClose className="h-4 w-4" />
        </button>
      </div>

      {/* Tab bar */}
      <BrowserTabBar />

      {/* Toolbar */}
      {activeTab && <BrowserToolbar tab={activeTab} />}

      {/* Content area — WebContentsView is overlaid here by main process */}
      <div
        ref={contentRef}
        className="flex-1 relative min-h-0"
      >
        {tabs.length === 0 && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No tabs open. Click + to add a tab.
          </div>
        )}
        {/* Actual web content is rendered by WebContentsView (native layer)
            positioned on top of this div by main process using setBounds() */}
      </div>
    </div>
  );
}
