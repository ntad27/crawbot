/**
 * BrowserTabBar — Tab strip with add/close/switch
 */
import { Plus, X, Globe } from 'lucide-react';
import { useBrowserStore, type BrowserTab } from '@/stores/browser';

export function BrowserTabBar() {
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const setActiveTab = useBrowserStore((s) => s.setActiveTab);
  const addTab = useBrowserStore((s) => s.addTab);
  const closeTab = useBrowserStore((s) => s.closeTab);

  return (
    <div className="flex items-center border-b border-border bg-muted/30 shrink-0 overflow-x-auto">
      {tabs
        .filter((t) => t.category === 'automation')
        .map((tab) => (
          <TabItem
            key={tab.id}
            tab={tab}
            isActive={tab.id === activeTabId}
            onActivate={() => setActiveTab(tab.id)}
            onClose={() => closeTab(tab.id)}
          />
        ))}

      {/* Add tab button */}
      <button
        onClick={() => addTab()}
        className="shrink-0 p-1.5 mx-0.5 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
        title="New tab"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function TabItem({
  tab,
  isActive,
  onActivate,
  onClose,
}: {
  tab: BrowserTab;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const displayTitle = tab.title || 'New Tab';
  const truncatedTitle =
    displayTitle.length > 20 ? displayTitle.slice(0, 20) + '...' : displayTitle;

  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1.5 cursor-pointer border-r border-border max-w-[160px] min-w-[80px] text-xs ${
        isActive
          ? 'bg-background text-foreground'
          : 'bg-muted/50 text-muted-foreground hover:bg-muted'
      }`}
      onClick={onActivate}
      title={tab.url}
    >
      {tab.isLoading ? (
        <div className="h-3 w-3 shrink-0 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      ) : tab.favicon ? (
        <img src={tab.favicon} className="h-3 w-3 shrink-0" alt="" />
      ) : (
        <Globe className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}

      <span className="truncate flex-1">{truncatedTitle}</span>

      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
        className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-destructive/20 hover:text-destructive"
        title="Close tab"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  );
}
