/**
 * BrowserPanel — Resizable right panel for built-in browser
 * Follows WorkspacePanel pattern (drag-to-resize, toggle)
 */
import { useRef, useCallback, useEffect, useState } from 'react';
import { PanelRightClose } from 'lucide-react';
import { useBrowserStore } from '@/stores/browser';
import { BrowserTabBar } from './BrowserTabBar';
import { BrowserToolbar } from './BrowserToolbar';
import { BrowserWebview } from './BrowserWebview';

export function BrowserPanel() {
  const panelOpen = useBrowserStore((s) => s.panelOpen);
  const panelWidth = useBrowserStore((s) => s.panelWidth);
  const setPanelWidth = useBrowserStore((s) => s.setPanelWidth);
  const closePanel = useBrowserStore((s) => s.closePanel);
  const closeTab = useBrowserStore((s) => s.closeTab);
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;

  const addTab = useBrowserStore((s) => s.addTab);

  // Ctrl+W close tab, Ctrl+T new tab (only when panel is open)
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
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, setPanelWidth]);

  const resolvedWidth = panelWidth === 0 ? '50%' : `${panelWidth}px`;

  return (
    <div
      className="relative flex flex-col border-l border-border bg-background"
      style={panelOpen ? {
        width: resolvedWidth,
        minWidth: 320,
        maxWidth: 1200,
      } : {
        // Hidden but webviews stay fully active (not throttled)
        // Use fixed position offscreen instead of width:0 so Chromium
        // doesn't suspend the renderer process
        position: 'fixed',
        left: -9999,
        top: 0,
        width: 800,
        height: '100vh',
        visibility: 'hidden' as const,
        pointerEvents: 'none' as const,
      }}
    >
      {/* Drag handle — wider hit area for easier grabbing */}
      <div
        className="absolute left-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-primary/20 active:bg-primary/30 z-20"
        onMouseDown={handleMouseDown}
      />

      {/*
        Drag overlay — covers the entire panel (including webview) during drag
        to prevent webview from stealing mouse events.
        Without this, dragging over a webview/iframe causes mousemove/mouseup
        to not fire on the document, making the drag "stuck".
      */}
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

      {/* Webview content area */}
      <div className="flex-1 relative min-h-0">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="absolute inset-0"
            style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
          >
            <BrowserWebview tab={tab} />
          </div>
        ))}

        {tabs.length === 0 && (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            No tabs open. Click + to add a tab.
          </div>
        )}
      </div>
    </div>
  );
}
