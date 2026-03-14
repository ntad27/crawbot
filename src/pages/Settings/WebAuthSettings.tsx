/**
 * WebAuth Settings Component
 * Manages web login session providers (add, remove, login, status)
 */
import { useState } from 'react';
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
import { useBrowserStore } from '@/stores/browser';

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

  const openPanel = useBrowserStore((s) => s.openPanel);
  const addTab = useBrowserStore((s) => s.addTab);

  const [showAddDialog, setShowAddDialog] = useState(false);

  const configuredIds = new Set(providers.map((p) => p.id));
  const availableToAdd = AVAILABLE_PROVIDERS.filter((p) => !configuredIds.has(p.id));

  const handleLogin = (provider: WebAuthProviderState) => {
    // Open browser panel with the provider's login page
    addTab(provider.loginUrl, provider.partition, 'webauth');
    openPanel();
    loginProvider(provider.id);
    toast.info(`Opening ${provider.name} login page...`);
  };

  const handleRemove = (provider: WebAuthProviderState) => {
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
    <>
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
        <CardContent className="space-y-3">
          {/* Provider list */}
          {providers.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No WebAuth providers configured. Click &quot;Add&quot; to get started.
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
            <div className="border rounded-lg p-4 bg-muted/30 space-y-3">
              <p className="text-sm font-medium">Select a provider to add:</p>
              <div className="grid grid-cols-3 gap-2">
                {availableToAdd.map((p) => (
                  <Button
                    key={p.id}
                    variant="outline"
                    size="sm"
                    className="h-auto py-2 flex flex-col items-center gap-1"
                    onClick={() => handleAddProvider(p.id)}
                  >
                    <Globe className="h-4 w-4" />
                    <span className="text-xs">{p.name}</span>
                  </Button>
                ))}
                {availableToAdd.length === 0 && (
                  <p className="text-xs text-muted-foreground col-span-3 text-center py-2">
                    All providers already added
                  </p>
                )}
              </div>
              <Button variant="ghost" size="sm" onClick={() => setShowAddDialog(false)}>
                Cancel
              </Button>
            </div>
          )}

          {/* Proxy status */}
          <div className="flex items-center gap-2 pt-2 border-t text-xs text-muted-foreground">
            <div className={`h-2 w-2 rounded-full ${proxyRunning ? 'bg-green-500' : 'bg-muted-foreground/30'}`} />
            WebAuth Proxy: {proxyRunning ? `Running on port ${proxyPort}` : 'Not running'}
            {providers.length > 0 && (
              <span className="ml-auto">
                {providers.filter((p) => p.status === 'valid').length} active / {providers.length} total
              </span>
            )}
          </div>
        </CardContent>
      </Card>
    </>
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
    <div className="flex items-center gap-3 p-3 rounded-lg border bg-card hover:bg-muted/30 transition-colors">
      {/* Status indicator */}
      {status.icon}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{provider.name}</span>
          <Badge variant="outline" className="text-[10px]">
            {status.label}
          </Badge>
        </div>
        {provider.models.length > 0 && (
          <p className="text-xs text-muted-foreground truncate">
            {provider.models.map((m) => m.name).join(', ')}
          </p>
        )}
        {provider.user && (
          <p className="text-xs text-muted-foreground">{provider.user}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="sm" onClick={onLogin} title={provider.status === 'not-configured' ? 'Login' : 'Re-login'}>
          {provider.status === 'not-configured' ? (
            <><ExternalLink className="h-3.5 w-3.5 mr-1" /> Login</>
          ) : (
            <><RefreshCw className="h-3.5 w-3.5 mr-1" /> Re-login</>
          )}
        </Button>
        <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive/60 hover:text-destructive" onClick={onRemove} title="Remove">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
