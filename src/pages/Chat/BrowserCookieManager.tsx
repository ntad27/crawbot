/**
 * BrowserCookieManager — Dialog for viewing/clearing cookies per domain
 */
import { useEffect, useState } from 'react';
import { Cookie, Trash2, Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useBrowserStore } from '@/stores/browser';

interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  expirationDate?: number;
}

export function BrowserCookieManager({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const activeTabId = useBrowserStore((s) => s.activeTabId);
  const tabs = useBrowserStore((s) => s.tabs);
  const activeTab = tabs.find((t) => t.id === activeTabId);

  const [cookies, setCookies] = useState<CookieEntry[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !activeTab) return;
    const fetchCookies = async () => {
      setLoading(true);
      try {
        const result = await window.electron.ipcRenderer.invoke(
          'browser:cookies:get',
          activeTab.partition,
          activeTab.url
        ) as { success?: boolean; cookies?: CookieEntry[] };
        if (result?.success) {
          setCookies(result.cookies || []);
        }
      } catch {
        // ignore
      }
      setLoading(false);
    };
    fetchCookies();
  }, [open, activeTab]);

  const handleClearAll = async () => {
    if (!activeTab) return;
    await window.electron.ipcRenderer.invoke('browser:cookies:clear', activeTab.partition);
    setCookies([]);
  };

  const handleExport = async () => {
    if (!activeTab) return;
    const result = await window.electron.ipcRenderer.invoke('browser:cookies:export', activeTab.partition) as { success?: boolean; cookies?: CookieEntry[] };
    if (result?.success) {
      const blob = new Blob([JSON.stringify(result.cookies, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cookies-${new URL(activeTab.url).hostname}.json`;
      a.click();
      URL.revokeObjectURL(url);
    }
  };

  const handleRemoveCookie = async (name: string) => {
    if (!activeTab) return;
    await window.electron.ipcRenderer.invoke(
      'browser:cookies:remove',
      activeTab.partition,
      activeTab.url,
      name
    );
    setCookies((prev) => prev.filter((c) => c.name !== name));
  };

  if (!open) return null;

  return (
    <div className="absolute bottom-0 left-0 right-0 bg-background border-t border-border z-20 max-h-[50%] overflow-hidden flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border shrink-0">
        <div className="flex items-center gap-2 text-xs font-medium">
          <Cookie className="h-3.5 w-3.5" />
          Cookies ({cookies.length})
          {activeTab && (
            <span className="text-muted-foreground">— {new URL(activeTab.url).hostname}</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={handleExport} title="Export">
            <Download className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={handleClearAll} title="Clear all">
            <Trash2 className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      {/* Cookie list */}
      <div className="overflow-y-auto flex-1">
        {loading ? (
          <p className="text-xs text-muted-foreground p-3">Loading...</p>
        ) : cookies.length === 0 ? (
          <p className="text-xs text-muted-foreground p-3">No cookies for this domain</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-muted/50 sticky top-0">
              <tr>
                <th className="text-left px-2 py-1 font-medium">Name</th>
                <th className="text-left px-2 py-1 font-medium">Value</th>
                <th className="text-left px-2 py-1 font-medium">Domain</th>
                <th className="w-8"></th>
              </tr>
            </thead>
            <tbody>
              {cookies.map((cookie) => (
                <tr key={cookie.name} className="border-t border-border/50 hover:bg-muted/30">
                  <td className="px-2 py-1 font-mono">{cookie.name}</td>
                  <td className="px-2 py-1 font-mono truncate max-w-[200px]">{cookie.value}</td>
                  <td className="px-2 py-1 text-muted-foreground">{cookie.domain}</td>
                  <td className="px-1">
                    <button
                      onClick={() => handleRemoveCookie(cookie.name)}
                      className="p-0.5 rounded hover:bg-destructive/20 hover:text-destructive"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
