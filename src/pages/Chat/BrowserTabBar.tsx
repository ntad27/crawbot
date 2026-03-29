/**
 * BrowserTabBar — Tab strip with add/close/switch + tab grouping per agent session
 */
import { useMemo } from 'react';
import { Plus, X, Globe } from 'lucide-react';
import { useBrowserStore, type BrowserTab } from '@/stores/browser';

interface TabGroupData {
  sessionKey: string | null;
  sessionLabel?: string;
  color?: string;
  tabs: BrowserTab[];
}

function groupTabsBySession(tabs: BrowserTab[]): TabGroupData[] {
  const unowned: BrowserTab[] = [];
  const groups = new Map<string, TabGroupData>();

  for (const tab of tabs) {
    if (!tab.sessionKey) {
      unowned.push(tab);
    } else {
      let group = groups.get(tab.sessionKey);
      if (!group) {
        group = {
          sessionKey: tab.sessionKey,
          sessionLabel: tab.sessionLabel,
          color: tab.groupColor,
          tabs: [],
        };
        groups.set(tab.sessionKey, group);
      }
      group.tabs.push(tab);
    }
  }

  const result: TabGroupData[] = [];
  if (unowned.length > 0) {
    result.push({ sessionKey: null, tabs: unowned });
  }
  for (const group of groups.values()) {
    result.push(group);
  }
  return result;
}

export function BrowserTabBar() {
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const setActiveTab = useBrowserStore((s) => s.setActiveTab);
  const addTab = useBrowserStore((s) => s.addTab);
  const closeTab = useBrowserStore((s) => s.closeTab);

  const automationTabs = useMemo(
    () => tabs.filter((t) => t.category === 'automation'),
    [tabs],
  );
  const grouped = useMemo(() => groupTabsBySession(automationTabs), [automationTabs]);

  return (
    <div className="flex items-center border-b border-border bg-muted/30 shrink-0 overflow-x-auto">
      {grouped.map((group) => (
        <TabGroup
          key={group.sessionKey ?? '__unowned'}
          group={group}
          activeTabId={activeTabId}
          onActivate={setActiveTab}
          onClose={closeTab}
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

function TabGroup({
  group,
  activeTabId,
  onActivate,
  onClose,
}: {
  group: TabGroupData;
  activeTabId: string | null;
  onActivate: (tabId: string) => void;
  onClose: (tabId: string) => void;
}) {
  return (
    <div className="flex items-center">
      {/* Session label badge — only for owned groups */}
      {group.sessionLabel && group.color && (
        <div
          className="px-1.5 py-0.5 text-[10px] font-medium rounded-sm mx-0.5 text-white shrink-0 max-w-[80px] truncate"
          style={{ backgroundColor: group.color }}
          title={`Agent: ${group.sessionKey}`}
        >
          {group.sessionLabel}
        </div>
      )}
      {group.tabs.map((tab) => (
        <TabItem
          key={tab.id}
          tab={tab}
          groupColor={group.color}
          isActive={tab.id === activeTabId}
          onActivate={() => onActivate(tab.id)}
          onClose={() => onClose(tab.id)}
        />
      ))}
      {/* Thin separator after owned groups */}
      {group.sessionKey && (
        <div className="w-px h-5 bg-border/60 mx-0.5 shrink-0" />
      )}
    </div>
  );
}

function TabItem({
  tab,
  groupColor,
  isActive,
  onActivate,
  onClose,
}: {
  tab: BrowserTab;
  groupColor?: string;
  isActive: boolean;
  onActivate: () => void;
  onClose: () => void;
}) {
  const displayTitle = tab.title || 'New Tab';
  const truncatedTitle =
    displayTitle.length > 20 ? displayTitle.slice(0, 20) + '...' : displayTitle;

  // Background tint: subtle transparent group color (only for non-active tabs)
  const bgTint = groupColor && !isActive ? `${groupColor}15` : undefined;

  return (
    <div
      className={`group flex items-center gap-1 px-2 py-1.5 cursor-pointer border-r border-border max-w-[160px] min-w-[80px] text-xs ${
        isActive
          ? 'bg-background text-foreground'
          : 'bg-muted/50 text-muted-foreground hover:bg-muted'
      }`}
      style={{
        borderLeft: groupColor ? `3px solid ${groupColor}` : undefined,
        backgroundColor: bgTint,
      }}
      onClick={onActivate}
      title={`${tab.url}${tab.sessionLabel ? `\nAgent: ${tab.sessionLabel}` : ''}`}
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
