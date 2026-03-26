/**
 * Channels Page
 * Manage messaging channel connections with configuration UI
 */
import { useState, useEffect, useCallback, useRef } from 'react';
import {
  Plus,
  Radio,
  RefreshCw,
  Trash2,
  Power,
  PowerOff,
  QrCode,
  Loader2,
  X,
  ExternalLink,
  BookOpen,
  Eye,
  EyeOff,
  Check,
  AlertCircle,
  CheckCircle,
  ShieldCheck,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useChannelsStore } from '@/stores/channels';
import { useGatewayStore } from '@/stores/gateway';
import { useAgentsStore } from '@/stores/agents';
import { StatusBadge, type Status } from '@/components/common/StatusBadge';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import {
  CHANNEL_NAMES,
  CHANNEL_META,
  getPrimaryChannels,
  type ChannelType,
  type Channel,
  type ChannelMeta,
  type ChannelConfigField,
  type AgentBinding,
} from '@/types/channel';
import { ChannelIcon } from '@/components/ChannelIcon';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

export function Channels() {
  const { t } = useTranslation('channels');
  const { channels, bindings, loading, error, fetchChannels, fetchBindings, deleteChannel } =
    useChannelsStore();
  const gatewayStatus = useGatewayStore((state) => state.status);
  const { agents, fetchAgents } = useAgentsStore();

  const [showAddDialog, setShowAddDialog] = useState(false);
  const [selectedChannelType, setSelectedChannelType] = useState<ChannelType | null>(null);
  const [editChannel, setEditChannel] = useState<Channel | null>(null);
  const [restarting, setRestarting] = useState(false);

  // Pairing requests
  type PairingRequest = {
    id: string;
    code: string;
    createdAt: string;
    lastSeenAt: string;
    channel: string;
    meta?: Record<string, string>;
  };
  const [pairingRequests, setPairingRequests] = useState<PairingRequest[]>([]);
  const fetchPairingRequests = useCallback(async () => {
    try {
      const result = (await window.electron.ipcRenderer.invoke('pairing:list')) as {
        success: boolean;
        requests: PairingRequest[];
      };
      if (result.success) setPairingRequests(result.requests);
    } catch { /* ignore */ }
  }, []);

  // Fetch channels, bindings, and agents on mount
  useEffect(() => {
    fetchChannels();
    fetchBindings();
    fetchAgents();
  }, [fetchChannels, fetchBindings, fetchAgents]);

  // Poll pairing requests every 10s (also fetches on mount via initial interval tick)
  useEffect(() => {
    // Immediate fetch on mount + recurring poll
    const id = setTimeout(fetchPairingRequests, 0);
    const interval = setInterval(fetchPairingRequests, 10000);
    return () => { clearTimeout(id); clearInterval(interval); };
  }, [fetchPairingRequests]);

  useEffect(() => {
    const unsubscribe = window.electron.ipcRenderer.on('gateway:channel-status', () => {
      fetchChannels();
    });
    return () => {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
    };
  }, [fetchChannels]);

  // Connected/disconnected channel counts
  const connectedCount = channels.filter((c) => c.status === 'connected').length;

  // Find binding for a channel
  const findBinding = (channel: Channel): AgentBinding | undefined => {
    const acctId = channel.accountId || 'default';
    return bindings.find(
      (b) =>
        b.match.channel === channel.type && (b.match.accountId || 'default') === acctId
    );
  };

  const handleDialogClose = () => {
    setShowAddDialog(false);
    setSelectedChannelType(null);
    setEditChannel(null);
  };

  const handleChannelAdded = async (opts?: { restartGateway?: boolean }) => {
    handleDialogClose();
    if (opts?.restartGateway) {
      // Show restarting overlay, restart gateway, wait, then refresh
      setRestarting(true);
      try {
        await window.electron.ipcRenderer.invoke('gateway:restart');
      } catch {
        // ignore
      }
      // Wait for Gateway to come back up
      await new Promise((r) => setTimeout(r, 3000));
      await fetchChannels();
      setRestarting(false);
    } else {
      fetchChannels();
    }
  };

  if (loading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <LoadingSpinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={fetchChannels}>
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('refresh')}
          </Button>
          <Button
            onClick={() => {
              setEditChannel(null);
              setSelectedChannelType(null);
              setShowAddDialog(true);
            }}
          >
            <Plus className="h-4 w-4 mr-2" />
            {t('addChannel')}
          </Button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-primary/10 p-3">
                <Radio className="h-6 w-6 text-primary" />
              </div>
              <div>
                <p className="text-2xl font-bold">{channels.length}</p>
                <p className="text-sm text-muted-foreground">{t('stats.total')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-green-100 p-3 dark:bg-green-900">
                <Power className="h-6 w-6 text-green-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{connectedCount}</p>
                <p className="text-sm text-muted-foreground">{t('stats.connected')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6">
            <div className="flex items-center gap-4">
              <div className="rounded-full bg-slate-100 p-3 dark:bg-slate-800">
                <PowerOff className="h-6 w-6 text-slate-600" />
              </div>
              <div>
                <p className="text-2xl font-bold">{channels.length - connectedCount}</p>
                <p className="text-sm text-muted-foreground">{t('stats.disconnected')}</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Gateway Warning */}
      {gatewayStatus.state !== 'running' && (
        <Card className="border-yellow-500 bg-yellow-50 dark:bg-yellow-900/10">
          <CardContent className="py-4 flex items-center gap-3">
            <AlertCircle className="h-5 w-5 text-yellow-500" />
            <span className="text-yellow-700 dark:text-yellow-400">{t('gatewayWarning')}</span>
          </CardContent>
        </Card>
      )}

      {/* Error Display */}
      {error && (
        <Card className="border-destructive">
          <CardContent className="py-4 text-destructive">{error}</CardContent>
        </Card>
      )}

      {/* Configured Channels */}
      {channels.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('configured')}</CardTitle>
            <CardDescription>{t('configuredDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
              {channels.map((channel) => {
                const binding = findBinding(channel);
                const agent = binding
                  ? agents.find((a) => a.id === binding.agentId)
                  : undefined;
                return (
                  <ChannelCard
                    key={channel.id}
                    channel={channel}
                    binding={binding}
                    agentName={agent?.name || binding?.agentId}
                    onEdit={() => {
                      setEditChannel(channel);
                      setSelectedChannelType(channel.type);
                      setShowAddDialog(true);
                    }}
                    onDelete={() => {
                      const label =
                        channel.accountId && channel.accountId !== 'default'
                          ? channel.accountId
                          : channel.name;
                      if (confirm(t('account.deleteConfirm', { name: label }))) {
                        deleteChannel(channel.id);
                      }
                    }}
                    onToggleEnabled={async (enabled) => {
                      const acct = channel.accountId || 'default';
                      await window.electron.ipcRenderer.invoke(
                        'channel:setEnabled',
                        channel.type,
                        enabled,
                        acct
                      );
                      // Show restarting overlay after a short delay
                      setTimeout(() => setRestarting(true), 300);
                      try {
                        await window.electron.ipcRenderer.invoke('gateway:restart');
                      } catch {
                        // ignore
                      }
                      // Wait a bit for Gateway to come back up
                      await new Promise((r) => setTimeout(r, 2000));
                      await fetchChannels();
                      setRestarting(false);
                    }}
                  />
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pairing Requests */}
      {pairingRequests.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {t('pairing.title')}
              <Badge variant="secondary">{pairingRequests.length}</Badge>
            </CardTitle>
            <CardDescription>{t('pairing.description')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {pairingRequests.map((req) => {
                const displayName = req.meta?.name || req.meta?.firstName || req.meta?.username || req.id;
                const channelName = CHANNEL_NAMES[req.channel as ChannelType] || req.channel;
                const accountId = req.meta?.accountId || 'default';
                const timeAgo = (() => {
                  const diff = Date.now() - new Date(req.createdAt).getTime();
                  const mins = Math.floor(diff / 60000);
                  if (mins < 1) return 'just now';
                  if (mins < 60) return `${mins}m ago`;
                  return `${Math.floor(mins / 60)}h ${mins % 60}m ago`;
                })();
                // Collect all meta fields except accountId (shown separately)
                const extraMeta = req.meta
                  ? Object.entries(req.meta).filter(([k]) => k !== 'accountId' && k !== 'name' && k !== 'firstName' && k !== 'username')
                  : [];
                return (
                  <div
                    key={`${req.channel}-${req.code}`}
                    className="flex items-center justify-between p-3 rounded-lg border bg-card gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <ChannelIcon type={req.channel as ChannelType} size="sm" />
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-medium text-sm">{displayName}</p>
                        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                          <span>{t('pairing.channel')}: <span className="font-medium text-foreground">{channelName}</span></span>
                          <span>{t('pairing.account')}: <span className="font-medium text-foreground">{accountId}</span></span>
                          <span>{t('pairing.user')} ID: <span className="font-mono text-foreground">{req.id}</span></span>
                          {req.meta?.username && <span>@{req.meta.username}</span>}
                          <span>{t('pairing.code')}: <span className="font-mono font-bold text-foreground">{req.code}</span></span>
                          <span>{t('pairing.requestedAt')}: {timeAgo}</span>
                          {extraMeta.map(([k, v]) => (
                            <span key={k}>{k}: <span className="text-foreground">{v}</span></span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="outline"
                        className="text-destructive hover:text-destructive"
                        onClick={async () => {
                          const result = (await window.electron.ipcRenderer.invoke(
                            'pairing:reject', req.channel, req.code
                          )) as { success: boolean };
                          if (result.success) {
                            toast.success(t('pairing.rejected'));
                            fetchPairingRequests();
                          } else {
                            toast.error(t('pairing.error'));
                          }
                        }}
                      >
                        <X className="h-3 w-3 mr-1" />
                        {t('pairing.reject')}
                      </Button>
                      <Button
                        size="sm"
                        onClick={async () => {
                          const result = (await window.electron.ipcRenderer.invoke(
                            'pairing:approve', req.channel, req.code, accountId
                          )) as { success: boolean };
                          if (result.success) {
                            toast.success(t('pairing.approved'));
                            fetchPairingRequests();
                          } else {
                            toast.error(t('pairing.error'));
                          }
                        }}
                      >
                        <Check className="h-3 w-3 mr-1" />
                        {t('pairing.approve')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Restarting overlay */}
      {restarting && (
        <div className="fixed inset-0 z-40 bg-black/30 flex items-center justify-center">
          <Card className="px-8 py-6 flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <span className="text-sm font-medium">{t('restarting')}</span>
          </Card>
        </div>
      )}

      {/* Add / Edit Channel Dialog */}
      {showAddDialog && (
        <AddChannelDialog
          selectedType={selectedChannelType}
          onSelectType={setSelectedChannelType}
          editChannel={editChannel}
          onClose={handleDialogClose}
          onChannelAdded={handleChannelAdded}
        />
      )}
    </div>
  );
}

// ==================== Channel Card Component ====================

interface ChannelCardProps {
  channel: Channel;
  binding?: AgentBinding;
  agentName?: string;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: (enabled: boolean) => void;
}

function ChannelCard({
  channel,
  binding,
  agentName,
  onEdit,
  onDelete,
  onToggleEnabled,
}: ChannelCardProps) {
  const { t } = useTranslation('channels');
  const acctId = channel.accountId || 'default';
  const isDefault = acctId === 'default';
  const isEnabled = channel.enabled !== false;

  return (
    <Card
      className="cursor-pointer hover:border-primary/50 transition-colors"
      onClick={onEdit}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <ChannelIcon type={channel.type} size="md" />
            <div>
              <CardTitle className="text-base">{channel.name}</CardTitle>
              <CardDescription className="text-xs">
                {CHANNEL_NAMES[channel.type]}
                {!isDefault && (
                  <span className="ml-1 text-muted-foreground">&middot; {acctId}</span>
                )}
              </CardDescription>
            </div>
          </div>
          {isEnabled ? (
            <StatusBadge status={channel.status as Status} />
          ) : (
            <Badge variant="destructive" className="text-xs">
              {t('disabled')}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Account badge */}
        <div className="flex flex-wrap gap-1.5 mb-3">
          <Badge variant="outline" className="text-xs">
            {isDefault ? t('account.default') : acctId}
          </Badge>
          {binding && agentName && (
            <Badge variant="secondary" className="text-xs">
              {agentName}
            </Badge>
          )}
          {!binding && (
            <Badge variant="outline" className="text-xs text-muted-foreground">
              {t('binding.noneAssigned')}
            </Badge>
          )}
        </div>

        {isEnabled && channel.error && (
          <p className="text-xs text-destructive mb-3">{channel.error}</p>
        )}
        {/* Stop propagation so interactive elements don't trigger onEdit */}
        <div className="flex items-center justify-between" onClick={(e) => e.stopPropagation()}>
          <Switch
            checked={isEnabled}
            onCheckedChange={onToggleEnabled}
            className="data-[state=checked]:!bg-green-500 data-[state=unchecked]:!bg-red-400"
          />
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ==================== Add Channel Dialog ====================

interface AddChannelDialogProps {
  selectedType: ChannelType | null;
  onSelectType: (type: ChannelType | null) => void;
  /** When set, the dialog opens in "edit" mode for this channel account. */
  editChannel?: Channel | null;
  onClose: () => void;
  onChannelAdded: (opts?: { restartGateway?: boolean }) => void;
}

function AddChannelDialog({
  selectedType,
  onSelectType,
  editChannel,
  onClose,
  onChannelAdded,
}: AddChannelDialogProps) {
  const { t } = useTranslation('channels');
  const { addChannel, setBinding, removeBinding, fetchBindings, bindings } = useChannelsStore();
  const { agents } = useAgentsStore();
  const isEditMode = Boolean(editChannel);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [accountId, setAccountId] = useState(
    editChannel?.accountId && editChannel.accountId !== 'default' ? editChannel.accountId : ''
  );
  const [connecting, setConnecting] = useState(false);
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  } | null>(null);

  // Binding state
  const [bindingAgentId, setBindingAgentId] = useState('');

  // Refs for mutable form values so QR login callbacks stay stable
  // (prevents useEffect re-runs that cancel active QR sessions)
  const accountIdRef = useRef(accountId);
  accountIdRef.current = accountId;
  const bindingAgentIdRef = useRef(bindingAgentId);
  bindingAgentIdRef.current = bindingAgentId;
  const isEditModeRef = useRef(isEditMode);
  isEditModeRef.current = isEditMode;

  const meta: ChannelMeta | null = selectedType ? CHANNEL_META[selectedType] : null;

  // Load existing config when editing, or reset when adding new
  useEffect(() => {
    if (!selectedType) {
      setConfigValues({});
      if (!isEditMode) setAccountId('');
      window.electron.ipcRenderer.invoke('channel:cancelWhatsAppQr').catch(() => {});
      window.electron.ipcRenderer.invoke('channel:cancelOpenZaloQr').catch(() => {});
      return;
    }

    // In add mode (no editChannel), start with a blank form — don't load existing config
    if (!isEditMode) {
      setConfigValues({});
      setLoadingConfig(false);
      return;
    }

    // Edit mode: load existing config for this channel + accountId
    let cancelled = false;
    setLoadingConfig(true);

    (async () => {
      try {
        const acct = editChannel?.accountId || 'default';
        const result = (await window.electron.ipcRenderer.invoke(
          'channel:getAccountFormValues',
          selectedType,
          acct
        )) as { success: boolean; values?: Record<string, string> };

        if (cancelled) return;

        if (result.success && result.values && Object.keys(result.values).length > 0) {
          setConfigValues(result.values);
        } else {
          setConfigValues({});
        }
      } catch {
        if (!cancelled) {
          setConfigValues({});
        }
      } finally {
        if (!cancelled) setLoadingConfig(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType, isEditMode]);

  // Load existing binding when editing
  useEffect(() => {
    if (!isEditMode || !editChannel || !selectedType) return;
    const acctId = editChannel.accountId || 'default';
    const existing = bindings.find(
      (b) =>
        b.match.channel === editChannel.type &&
        (b.match.accountId || 'default') === acctId
    );
    if (existing) {
      setBindingAgentId(existing.agentId);
    } else {
      setBindingAgentId('');
    }
     
  }, [isEditMode, editChannel, selectedType, bindings]);

  // Shared post-QR-login success handler for QR-based channels (WhatsApp, Zalo Personal)
  // Uses refs for form values so the callback identity stays stable and
  // useEffect doesn't re-run (which would cancel the active QR session).
  const handleQrLoginSuccess = useCallback(async (channelType: 'whatsapp', eventAccountId?: string) => {
    const toastKey = 'toast.whatsappConnected';
    toast.success(t(toastKey));

    const acctId = eventAccountId || accountIdRef.current.trim() || 'default';
    const currentBindingAgentId = bindingAgentIdRef.current;
    const currentIsEditMode = isEditModeRef.current;

    // Save plugin config (top-level enabled + channels.<type>)
    try {
      const saveResult = (await window.electron.ipcRenderer.invoke(
        'channel:saveConfig',
        channelType,
        { enabled: true }
      )) as { success?: boolean; error?: string };
      if (!saveResult?.success) {
        console.error(`Failed to save ${channelType} config:`, saveResult?.error);
      }
    } catch (error) {
      console.error(`Failed to save ${channelType} config:`, error);
    }

    // Save account-level config (channels.<type>.accounts.<accountId>)
    try {
      await window.electron.ipcRenderer.invoke(
        'channel:saveAccountConfig',
        channelType,
        acctId,
        { enabled: true }
      );
    } catch (error) {
      console.error(`Failed to save ${channelType} account config:`, error);
    }

    // In add mode, register a local channel entry so it shows up immediately
    if (!currentIsEditMode) {
      await addChannel({
        type: channelType,
        name: CHANNEL_NAMES[channelType],
        accountId: acctId,
      });
    }

    // Save or remove agent binding
    if (currentBindingAgentId) {
      await setBinding(currentBindingAgentId, channelType, acctId === 'default' ? undefined : acctId);
    } else if (currentIsEditMode) {
      await removeBinding(channelType, acctId === 'default' ? undefined : acctId);
    }
    await fetchBindings();

    // Close dialog and restart gateway with overlay
    onChannelAdded({ restartGateway: true });
  }, [addChannel, setBinding, removeBinding, fetchBindings, onChannelAdded, t]);

  // Listen for WhatsApp QR events
  // Use ref to avoid useEffect re-running (and canceling QR session) when callback identity changes
  const handleQrLoginSuccessRefWa = useRef(handleQrLoginSuccess);
  handleQrLoginSuccessRefWa.current = handleQrLoginSuccess;

  useEffect(() => {
    if (selectedType !== 'whatsapp') return;

    const onQr = (...args: unknown[]) => {
      const data = args[0] as { qr: string; raw: string };
      setQrCode(`data:image/png;base64,${data.qr}`);
    };

    const onSuccess = async (...args: unknown[]) => {
      const data = args[0] as { accountId?: string } | undefined;
      await handleQrLoginSuccessRefWa.current('whatsapp', data?.accountId);
    };

    const onError = (...args: unknown[]) => {
      const err = args[0] as string;
      console.error('WhatsApp Login Error:', err);
      toast.error(t('toast.whatsappFailed', { error: err }));
      setQrCode(null);
      setConnecting(false);
    };

    const removeQrListener = window.electron.ipcRenderer.on('channel:whatsapp-qr', onQr);
    const removeSuccessListener = window.electron.ipcRenderer.on(
      'channel:whatsapp-success',
      onSuccess
    );
    const removeErrorListener = window.electron.ipcRenderer.on(
      'channel:whatsapp-error',
      onError
    );

    return () => {
      if (typeof removeQrListener === 'function') removeQrListener();
      if (typeof removeSuccessListener === 'function') removeSuccessListener();
      if (typeof removeErrorListener === 'function') removeErrorListener();
      window.electron.ipcRenderer.invoke('channel:cancelWhatsAppQr').catch(() => {});
    };
  }, [selectedType, t]);

  // Keep ref for QR login success handler stable
  const handleQrLoginSuccessRef = useRef(handleQrLoginSuccess);
  handleQrLoginSuccessRef.current = handleQrLoginSuccess;

  // Listen for OpenZalo QR events
  // Use refs for callbacks so useEffect only re-runs when selectedType changes
  // (prevents cleanup from killing the openzca process on every render)
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const onChannelAddedRef = useRef(onChannelAdded);
  onChannelAddedRef.current = onChannelAdded;

  useEffect(() => {
    if (selectedType !== 'openzalo') return;

    const onQr = (...args: unknown[]) => {
      const data = args[0] as { qr: string };
      const qrData = data.qr;
      setQrCode(qrData.startsWith('data:') ? qrData : `data:image/png;base64,${qrData}`);
    };

    const onSuccess = async () => {
      toast.success(t('toast.openzaloConnected'));

      const acctId = accountIdRef.current.trim() || 'default';
      const currentBindingAgentId = bindingAgentIdRef.current;
      const currentIsEditMode = isEditModeRef.current;

      // Save plugin config (enable channel + plugin entry)
      try {
        await window.electron.ipcRenderer.invoke('channel:saveConfig', 'openzalo', { enabled: true });
      } catch (err) {
        console.error('Failed to save openzalo config:', err);
      }

      // Save account-level config
      try {
        await window.electron.ipcRenderer.invoke('channel:saveAccountConfig', 'openzalo', acctId, { enabled: true });
      } catch (err) {
        console.error('Failed to save openzalo account config:', err);
      }

      // Add channel entry so it shows up immediately
      if (!currentIsEditMode) {
        await addChannel({ type: 'openzalo' as ChannelType, name: 'OpenZalo', accountId: acctId });
      }

      // Save or remove agent binding
      if (currentBindingAgentId) {
        await setBinding(currentBindingAgentId, 'openzalo', acctId === 'default' ? undefined : acctId);
      } else if (currentIsEditMode) {
        await removeBinding('openzalo', acctId === 'default' ? undefined : acctId);
      }
      await fetchBindings();

      // Close dialog and restart gateway
      onChannelAddedRef.current({ restartGateway: true });
    };

    const onError = (...args: unknown[]) => {
      const err = args[0] as string;
      console.error('OpenZalo Login Error:', err);
      toast.error(t('toast.openzaloFailed', { error: err }));
      setQrCode(null);
      setConnecting(false);
    };

    const removeQrListener = window.electron.ipcRenderer.on('channel:openzalo-qr', onQr);
    const removeSuccessListener = window.electron.ipcRenderer.on(
      'channel:openzalo-success',
      onSuccess
    );
    const removeErrorListener = window.electron.ipcRenderer.on(
      'channel:openzalo-error',
      onError
    );

    return () => {
      if (typeof removeQrListener === 'function') removeQrListener();
      if (typeof removeSuccessListener === 'function') removeSuccessListener();
      if (typeof removeErrorListener === 'function') removeErrorListener();
      window.electron.ipcRenderer.invoke('channel:cancelOpenZaloQr').catch(() => {});
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedType]);

  const handleValidate = async () => {
    if (!selectedType) return;

    setValidating(true);
    setValidationResult(null);

    try {
      const result = (await window.electron.ipcRenderer.invoke(
        'channel:validateCredentials',
        selectedType,
        configValues
      )) as {
        success: boolean;
        valid?: boolean;
        errors?: string[];
        warnings?: string[];
        details?: Record<string, string>;
      };

      const warnings = result.warnings || [];
      if (result.valid && result.details) {
        const details = result.details;
        if (details.botUsername) warnings.push(`Bot: @${details.botUsername}`);
        if (details.guildName) warnings.push(`Server: ${details.guildName}`);
        if (details.channelName) warnings.push(`Channel: #${details.channelName}`);
      }

      setValidationResult({
        valid: result.valid || false,
        errors: result.errors || [],
        warnings,
      });
    } catch (error) {
      setValidationResult({
        valid: false,
        errors: [String(error)],
        warnings: [],
      });
    } finally {
      setValidating(false);
    }
  };

  const handleConnect = async () => {
    if (!selectedType || !meta) return;

    setConnecting(true);
    setValidationResult(null);

    try {
      // For QR-based channels, request QR code
      if (meta.connectionType === 'qr') {
        const qrAccountId = accountId.trim() || 'default';
        if (selectedType === 'openzalo') {
          await window.electron.ipcRenderer.invoke('channel:requestOpenZaloQr', qrAccountId);
        } else {
          await window.electron.ipcRenderer.invoke('channel:requestWhatsAppQr', qrAccountId);
        }
        // The QR code will be set via event listener
        return;
      }

      // Step 1: Validate credentials against the actual service API
      if (meta.connectionType === 'token') {
        const validationResponse = (await window.electron.ipcRenderer.invoke(
          'channel:validateCredentials',
          selectedType,
          configValues
        )) as {
          success: boolean;
          valid?: boolean;
          errors?: string[];
          warnings?: string[];
          details?: Record<string, string>;
        };

        if (!validationResponse.valid) {
          setValidationResult({
            valid: false,
            errors: validationResponse.errors || ['Validation failed'],
            warnings: validationResponse.warnings || [],
          });
          setConnecting(false);
          return;
        }

        // Show success details (bot name, guild name, etc.) as warnings/info
        const warnings = validationResponse.warnings || [];
        if (validationResponse.details) {
          const details = validationResponse.details;
          if (details.botUsername) {
            warnings.push(`Bot: @${details.botUsername}`);
          }
          if (details.guildName) {
            warnings.push(`Server: ${details.guildName}`);
          }
          if (details.channelName) {
            warnings.push(`Channel: #${details.channelName}`);
          }
        }

        // Show validation success with details
        setValidationResult({
          valid: true,
          errors: [],
          warnings,
        });
      }

      // Step 2: Save channel configuration via account-aware IPC
      const config: Record<string, unknown> = { ...configValues };
      const acct = accountId.trim() || 'default';
      await window.electron.ipcRenderer.invoke(
        'channel:saveAccountConfig',
        selectedType,
        acct,
        config
      );

      // Step 3: In add mode, register a local channel entry for the UI
      if (!isEditMode) {
        await addChannel({
          type: selectedType,
          name: CHANNEL_NAMES[selectedType],
          token: configValues[meta.configFields[0]?.key] || undefined,
        });
      }

      // Save or remove agent binding
      if (bindingAgentId) {
        await setBinding(bindingAgentId, selectedType, acct === 'default' ? undefined : acct);
      } else if (isEditMode) {
        // Agent cleared in edit mode — remove any existing binding
        await removeBinding(selectedType, acct === 'default' ? undefined : acct);
      }
      await fetchBindings();

      toast.success(t('toast.channelSaved', { name: meta.name }));

      // Close dialog and restart gateway with overlay
      onChannelAdded({ restartGateway: true });
    } catch (error) {
      toast.error(t('toast.configFailed', { error }));
      setConnecting(false);
    }
  };

  const openDocs = () => {
    if (meta?.docsUrl) {
      const url = t(meta.docsUrl);
      try {
        if (window.electron?.openExternal) {
          window.electron.openExternal(url);
        } else {
          window.open(url, '_blank');
        }
      } catch (error) {
        console.error('Failed to open docs:', error);
        window.open(url, '_blank');
      }
    }
  };

  // Save QR channel config (allowedUsers, binding) without triggering QR login
  const handleSaveQrConfig = async () => {
    if (!selectedType || !meta) return;
    setConnecting(true);
    try {
      const acct = accountId.trim() || 'default';
      const config: Record<string, unknown> = { ...configValues, enabled: true };
      await window.electron.ipcRenderer.invoke(
        'channel:saveAccountConfig',
        selectedType,
        acct,
        config
      );
      if (bindingAgentId) {
        await setBinding(bindingAgentId, selectedType, acct === 'default' ? undefined : acct);
      } else if (isEditMode) {
        await removeBinding(selectedType, acct === 'default' ? undefined : acct);
      }
      await fetchBindings();
      toast.success(t('toast.channelSaved', { name: meta.name }));
      onChannelAdded({ restartGateway: true });
    } catch (error) {
      toast.error(t('toast.configFailed', { error }));
    } finally {
      setConnecting(false);
    }
  };

  const isFormValid = () => {
    if (!meta) return false;

    // Check all required fields are filled
    return meta.configFields
      .filter((field) => field.required)
      .every((field) => configValues[field.key]?.trim());
  };

  const updateConfigValue = (key: string, value: string) => {
    setConfigValues((prev) => ({ ...prev, [key]: value }));
  };

  const toggleSecretVisibility = (key: string) => {
    setShowSecrets((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <Card className="w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <CardHeader className="flex flex-row items-start justify-between">
          <div>
            <CardTitle>
              {selectedType
                ? isEditMode
                  ? t('dialog.updateTitle', { name: CHANNEL_NAMES[selectedType] })
                  : t('dialog.configureTitle', { name: CHANNEL_NAMES[selectedType] })
                : t('dialog.addTitle')}
            </CardTitle>
            <CardDescription>
              {selectedType && isEditMode
                ? t('dialog.existingDesc')
                : meta
                  ? t(meta.description)
                  : t('dialog.selectDesc')}
            </CardDescription>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {!selectedType ? (
            // Channel type selection
            <div className="grid grid-cols-2 gap-4">
              {getPrimaryChannels().map((type) => {
                const channelMeta = CHANNEL_META[type];
                return (
                  <button
                    key={type}
                    onClick={() => onSelectType(type)}
                    className="p-4 rounded-lg border hover:bg-accent transition-colors text-left"
                  >
                    <ChannelIcon type={channelMeta.id} size="lg" />
                    <p className="font-medium mt-2">{channelMeta.name}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {channelMeta.connectionType === 'qr' ? t('dialog.qrCode') : t('dialog.token')}
                    </p>
                  </button>
                );
              })}
            </div>
          ) : qrCode ? (
            // QR Code display
            <div className="text-center space-y-4">
              <div className="bg-white p-4 rounded-lg inline-block shadow-sm border">
                {qrCode.startsWith('data:image') ? (
                  <img
                    src={qrCode}
                    alt="Scan QR Code"
                    className="w-64 h-64 object-contain"
                  />
                ) : (
                  <div className="w-64 h-64 bg-gray-100 flex items-center justify-center">
                    <QrCode className="h-32 w-32 text-gray-400" />
                  </div>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {t('dialog.scanQR', { name: meta?.name })}
              </p>
              <div className="flex justify-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => {
                    setQrCode(null);
                    handleConnect(); // Retry
                  }}
                >
                  {t('dialog.refreshCode')}
                </Button>
              </div>
            </div>
          ) : loadingConfig ? (
            // Loading saved config
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">
                {t('dialog.loadingConfig')}
              </span>
            </div>
          ) : (
            // Connection form
            <div className="space-y-4">
              {/* Instructions */}
              <div className="bg-muted p-4 rounded-lg space-y-3">
                <div className="flex items-center justify-between">
                  <p className="font-medium text-sm">{t('dialog.howToConnect')}</p>
                  <Button variant="link" className="p-0 h-auto text-sm" onClick={openDocs}>
                    <BookOpen className="h-3 w-3 mr-1" />
                    {t('dialog.viewDocs')}
                    <ExternalLink className="h-3 w-3 ml-1" />
                  </Button>
                </div>
                <ol className="list-decimal list-inside text-sm text-muted-foreground space-y-1">
                  {meta?.instructions.map((instruction, i) => (
                    <li key={i}>{t(instruction)}</li>
                  ))}
                </ol>
              </div>

              {/* Account ID */}
              <div className="space-y-2">
                <Label htmlFor="accountId">{t('dialog.accountId')}</Label>
                <Input
                  id="accountId"
                  placeholder={t('dialog.accountIdPlaceholder')}
                  value={accountId}
                  onChange={(e) => {
                    // Normalize: lowercase, replace spaces with hyphens, remove diacritics, strip special chars
                    const raw = e.target.value;
                    const normalized = raw
                      .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove diacritics
                      .toLowerCase()
                      .replace(/\s+/g, '-')        // spaces → hyphens
                      .replace(/[^a-z0-9-]/g, '')  // keep only a-z, 0-9, hyphens
                      .replace(/-+/g, '-');         // collapse multiple hyphens
                    setAccountId(normalized);
                  }}
                  onBlur={() => {
                    // Clean up trailing/leading hyphens when user leaves the field
                    setAccountId((v) => v.replace(/^-+|-+$/g, ''));
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {t('dialog.accountIdHelp')}
                </p>
              </div>

              {/* Agent Binding */}
              <Separator />
              <div className="space-y-3">
                <Label className="text-sm font-medium">{t('dialog.binding')}</Label>

                {/* Agent dropdown */}
                <div className="space-y-2">
                  <Label htmlFor="bindingAgent" className="text-xs">
                    {t('dialog.bindingAgent')}
                  </Label>
                  <Select
                    value={bindingAgentId}
                    onChange={(e) => setBindingAgentId(e.target.value)}
                  >
                    <option value="">{t('dialog.bindingAgentNone')}</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.identity?.emoji ? `${a.identity.emoji} ` : ''}
                        {a.name || a.id}
                      </option>
                    ))}
                  </Select>
                </div>

              </div>
              <Separator />

              {/* Configuration fields */}
              {meta?.configFields.map((field) => (
                <ConfigField
                  key={field.key}
                  field={field}
                  value={configValues[field.key] || ''}
                  onChange={(value) => updateConfigValue(field.key, value)}
                  showSecret={showSecrets[field.key] || false}
                  onToggleSecret={() => toggleSecretVisibility(field.key)}
                />
              ))}

              {/* Validation Results */}
              {validationResult && (
                <div
                  className={`p-4 rounded-lg text-sm ${validationResult.valid ? 'bg-green-500/10 text-green-600 dark:text-green-400' : 'bg-destructive/10 text-destructive'}`}
                >
                  <div className="flex items-start gap-2">
                    {validationResult.valid ? (
                      <CheckCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                    )}
                    <div className="min-w-0">
                      <h4 className="font-medium mb-1">
                        {validationResult.valid
                          ? t('dialog.credentialsVerified')
                          : t('dialog.validationFailed')}
                      </h4>
                      {validationResult.errors.length > 0 && (
                        <ul className="list-disc list-inside space-y-0.5">
                          {validationResult.errors.map((err, i) => (
                            <li key={i}>{err}</li>
                          ))}
                        </ul>
                      )}
                      {validationResult.valid && validationResult.warnings.length > 0 && (
                        <div className="mt-1 text-green-600 dark:text-green-400 space-y-0.5">
                          {validationResult.warnings.map((info, i) => (
                            <p key={i} className="text-xs">
                              {info}
                            </p>
                          ))}
                        </div>
                      )}
                      {!validationResult.valid && validationResult.warnings.length > 0 && (
                        <div className="mt-2 text-yellow-600 dark:text-yellow-500">
                          <p className="font-medium text-xs uppercase mb-1">
                            {t('dialog.warnings')}
                          </p>
                          <ul className="list-disc list-inside space-y-0.5">
                            {validationResult.warnings.map((warn, i) => (
                              <li key={i}>{warn}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <Separator />

              <div className="flex justify-between">
                <Button variant="outline" onClick={() => onSelectType(null)}>
                  {t('dialog.back')}
                </Button>
                <div className="flex gap-2">
                  {/* Validation Button - Only for token-based channels for now */}
                  {meta?.connectionType === 'token' && (
                    <Button variant="secondary" onClick={handleValidate} disabled={validating}>
                      {validating ? (
                        <>
                          <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          {t('dialog.validating')}
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="h-4 w-4 mr-2" />
                          {t('dialog.validateConfig')}
                        </>
                      )}
                    </Button>
                  )}
                  {/* Save button for QR channels with config fields (e.g. allowedUsers) */}
                  {meta?.connectionType === 'qr' && meta.configFields.length > 0 && isEditMode && (
                    <Button onClick={handleSaveQrConfig} disabled={connecting}>
                      {connecting ? (
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      ) : (
                        <Check className="h-4 w-4 mr-2" />
                      )}
                      {t('dialog.updateAndReconnect')}
                    </Button>
                  )}
                  <Button
                    variant={meta?.connectionType === 'qr' && meta.configFields.length > 0 && isEditMode ? 'secondary' : 'default'}
                    onClick={handleConnect}
                    disabled={connecting || !isFormValid()}
                  >
                    {connecting ? (
                      <>
                        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                        {meta?.connectionType === 'qr'
                          ? t('dialog.generatingQR')
                          : t('dialog.validatingAndSaving')}
                      </>
                    ) : meta?.connectionType === 'qr' ? (
                      t('dialog.generateQRCode')
                    ) : (
                      <>
                        <Check className="h-4 w-4 mr-2" />
                        {isEditMode
                          ? t('dialog.updateAndReconnect')
                          : t('dialog.saveAndConnect')}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ==================== Config Field Component ====================

interface ConfigFieldProps {
  field: ChannelConfigField;
  value: string;
  onChange: (value: string) => void;
  showSecret: boolean;
  onToggleSecret: () => void;
}

function ConfigField({ field, value, onChange, showSecret, onToggleSecret }: ConfigFieldProps) {
  const { t } = useTranslation('channels');
  const isPassword = field.type === 'password';

  return (
    <div className="space-y-2">
      <Label htmlFor={field.key}>
        {t(field.label)}
        {field.required && <span className="text-destructive ml-1">*</span>}
      </Label>
      <div className="flex gap-2">
        <Input
          id={field.key}
          type={isPassword && !showSecret ? 'password' : 'text'}
          placeholder={field.placeholder ? t(field.placeholder) : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-sm"
        />
        {isPassword && (
          <Button type="button" variant="outline" size="icon" onClick={onToggleSecret}>
            {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </Button>
        )}
      </div>
      {field.description && (
        <p className="text-xs text-muted-foreground whitespace-pre-line">{t(field.description)}</p>
      )}
      {field.envVar && (
        <p className="text-xs text-muted-foreground">{t('dialog.envVar', { var: field.envVar })}</p>
      )}
    </div>
  );
}

export default Channels;
