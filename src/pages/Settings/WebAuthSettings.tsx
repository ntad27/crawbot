/**
 * WebAuth Settings Component
 * Split layout: provider list (left) + browser panel (right)
 *
 * Uses the independent useWebAuthBrowserStore for tab management.
 * No references to useBrowserStore (Chat browser).
 */
import { useState, useEffect } from 'react';
import {
  Globe, Plus, RefreshCw, Trash2, ExternalLink, CheckCircle2, AlertCircle, Clock, Circle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import {
  useWebAuthStore,
  AVAILABLE_PROVIDERS,
  type WebAuthProviderState,
  type WebAuthStatus,
} from '@/stores/webauth';
import { useWebAuthBrowserStore } from '@/stores/webauth-browser';
import { WebAuthBrowserPanel } from './WebAuthBrowserPanel';

// ── Status helpers ──

const STATUS_CONFIG: Record<WebAuthStatus, { icon: React.ReactNode; color: string; label: string }> = {
  valid: { icon: <CheckCircle2 className="h-4 w-4 text-green-500" />, color: 'bg-green-500', label: 'Valid' },
  expiring: { icon: <Clock className="h-4 w-4 text-yellow-500" />, color: 'bg-yellow-500', label: 'Expiring' },
  expired: { icon: <AlertCircle className="h-4 w-4 text-red-500" />, color: 'bg-red-500', label: 'Expired' },
  'not-configured': { icon: <Circle className="h-4 w-4 text-muted-foreground" />, color: 'bg-muted', label: 'Not configured' },
};

export function WebAuthSettings() {
  const providers = useWebAuthStore((s) => s.providers);
  const addProvider = useWebAuthStore((s) => s.addProvider);
  const removeProvider = useWebAuthStore((s) => s.removeProvider);
  const loginProvider = useWebAuthStore((s) => s.loginProvider);
  const proxyRunning = useWebAuthStore((s) => s.proxyRunning);
  const proxyPort = useWebAuthStore((s) => s.proxyPort);

  const addTab = useWebAuthBrowserStore((s) => s.addTab);
  const setActiveTab = useWebAuthBrowserStore((s) => s.setActiveTab);
  const closeTab = useWebAuthBrowserStore((s) => s.closeTab);
  const tabs = useWebAuthBrowserStore((s) => s.tabs);

  const [showAddDialog, setShowAddDialog] = useState(false);

  const configuredIds = new Set(providers.map((p) => p.id));
  const availableToAdd = AVAILABLE_PROVIDERS.filter((p) => !configuredIds.has(p.id));

  // Auto-create tabs for all configured providers when Settings page mounts
  // Each provider gets its own tab pointing to its loginUrl with its partition
  useEffect(() => {
    for (const provider of providers) {
      const exists = tabs.some((t) => t.partition === provider.partition);
      if (!exists) {
        addTab(provider.loginUrl, provider.partition);
      }
    }
    // Only run on mount and when providers list changes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length]);

  const handleLogin = (provider: WebAuthProviderState) => {
    // Create or activate webauth tab in the Settings browser panel
    const existingTab = tabs.find(
      (t) => t.partition === provider.partition
    );
    if (existingTab) {
      // Tab exists — just activate it
      setActiveTab(existingTab.id);
    } else {
      // Create new webauth tab
      addTab(provider.loginUrl, provider.partition);
    }
    loginProvider(provider.id);
    toast.info(`Opening ${provider.name} login page...`);
  };

  const handleRemove = (provider: WebAuthProviderState) => {
    // Close matching webauth tab by partition
    const matchingTab = tabs.find((t) => t.partition === provider.partition);
    if (matchingTab) {
      closeTab(matchingTab.id);
    }
    removeProvider(provider.id);
    toast.success(`Removed ${provider.name}`);
  };

  const handleAddProvider = (providerId: string) => {
    addProvider(providerId);
    setShowAddDialog(false);
    const reg = AVAILABLE_PROVIDERS.find((p) => p.id === providerId);
    if (reg) {
      toast.success(`Added ${reg.name}`);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Globe className="h-5 w-5" />
              WebAuth Providers
            </CardTitle>
            <CardDescription>
              Use web login sessions as LLM API — no API key needed
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={() => setShowAddDialog(!showAddDialog)}>
            <Plus className="h-4 w-4 mr-1" />
            Add
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {/* Split layout: provider list + browser panel */}
        <div className="flex gap-4" style={{ minHeight: tabs.length > 0 ? 500 : undefined }}>
          {/* Left: Provider list */}
          <div className="w-[280px] shrink-0 space-y-3">
            {/* Provider list */}
            {providers.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">
                No providers. Click &quot;Add&quot; to get started.
              </p>
            ) : (
              providers.map((provider) => (
                <ProviderRow
                  key={provider.id}
                  provider={provider}
                  onLogin={() => handleLogin(provider)}
                  onRemove={() => handleRemove(provider)}
                />
              ))
            )}

            {/* Add provider dialog (inline) */}
            {showAddDialog && (
              <div className="border rounded-lg p-3 bg-muted/30 space-y-2">
                <p className="text-xs font-medium">Select a provider:</p>
                <div className="grid grid-cols-2 gap-1.5">
                  {availableToAdd.map((p) => (
                    <Button
                      key={p.id}
                      variant="outline"
                      size="sm"
                      className="h-auto py-1.5 flex flex-col items-center gap-0.5 text-[10px]"
                      onClick={() => handleAddProvider(p.id)}
                    >
                      <Globe className="h-3 w-3" />
                      <span>{p.name}</span>
                    </Button>
                  ))}
                  {availableToAdd.length === 0 && (
                    <p className="text-xs text-muted-foreground col-span-2 text-center py-1">
                      All added
                    </p>
                  )}
                </div>
                <Button variant="ghost" size="sm" className="w-full" onClick={() => setShowAddDialog(false)}>
                  Cancel
                </Button>
              </div>
            )}

            {/* Proxy status */}
            <div className="flex items-center gap-2 pt-2 border-t text-xs text-muted-foreground">
              <div className={`h-2 w-2 rounded-full ${proxyRunning ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
              {proxyRunning ? `Proxy :${proxyPort}` : 'Proxy off'}
              {providers.length > 0 && (
                <span className="ml-auto">
                  {providers.filter((p) => p.status === 'valid').length}/{providers.length}
                </span>
              )}
            </div>
          </div>

          {/* Right: Browser panel for webauth login */}
          <div className="flex-1 min-w-0">
            <WebAuthBrowserPanel />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Provider Row ──

function ProviderRow({
  provider,
  onLogin,
  onRemove,
}: {
  provider: WebAuthProviderState;
  onLogin: () => void;
  onRemove: () => void;
}) {
  const status = STATUS_CONFIG[provider.status];

  return (
    <div className="flex items-center gap-2 p-2 rounded-lg border bg-card hover:bg-muted/30 transition-colors">
      {status.icon}

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium truncate">{provider.name}</span>
          <Badge variant="outline" className="text-[9px] px-1 py-0">
            {status.label}
          </Badge>
        </div>
        {provider.user && (
          <p className="text-[10px] text-muted-foreground truncate">{provider.user}</p>
        )}
      </div>

      <div className="flex items-center gap-0.5 shrink-0">
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onLogin}
          title={provider.status === 'not-configured' ? 'Login' : 'Re-login'}
        >
          {provider.status === 'not-configured' ? (
            <ExternalLink className="h-3.5 w-3.5" />
          ) : (
            <RefreshCw className="h-3.5 w-3.5" />
          )}
        </Button>
        <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive/60 hover:text-destructive"
          onClick={onRemove} title="Remove"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
