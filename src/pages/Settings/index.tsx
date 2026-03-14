/**
 * Settings Page
 * Application configuration
 */
import { useEffect, useState } from 'react';
import {
  Sun,
  Moon,
  Monitor,
  RefreshCw,
  Terminal,
  ExternalLink,
  Key,
  Download,
  Copy,
  FileText,
  Archive,
  Upload,
  Globe,
  FolderOpen,
  CheckCircle2,
  Server,
  Eye,
  EyeOff,
  AlertTriangle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { useSettingsStore } from '@/stores/settings';
import { useGatewayStore } from '@/stores/gateway';
import { useUpdateStore } from '@/stores/update';
import { useWebhookStore } from '@/stores/webhook';
import { ProvidersSettings } from '@/components/settings/ProvidersSettings';
import { UpdateSettings } from '@/components/settings/UpdateSettings';
import { WebAuthSettings } from './WebAuthSettings';
import { useTranslation } from 'react-i18next';
import { SUPPORTED_LANGUAGES } from '@/i18n';
type ControlUiInfo = {
  url: string;
  token: string;
  port: number;
};

export function Settings() {
  const { t } = useTranslation('settings');
  const {
    theme,
    setTheme,
    language,
    setLanguage,
    gatewayAutoStart,
    setGatewayAutoStart,
    autoCheckUpdate,
    setAutoCheckUpdate,
    autoDownloadUpdate,
    setAutoDownloadUpdate,
    devModeUnlocked,
    setDevModeUnlocked,
    launchAtStartup,
    setLaunchAtStartup,
    startMinimized,
    setStartMinimized,
    toolsAutoApprove,
    setToolsAutoApprove,
    sessionDmScope,
    setSessionDmScope,
    syncFromMain,
  } = useSettingsStore();

  const { status: gatewayStatus, restart: restartGateway } = useGatewayStore();
  const currentVersion = useUpdateStore((state) => state.currentVersion);
  const updateSetAutoDownload = useUpdateStore((state) => state.setAutoDownload);
  const [controlUiInfo, setControlUiInfo] = useState<ControlUiInfo | null>(null);
  const [openclawCliCommand, setOpenclawCliCommand] = useState('');
  const [openclawCliError, setOpenclawCliError] = useState<string | null>(null);
  const [installingCli, setInstallingCli] = useState(false);

  const { serverConfig, fetchServerConfig, updateServerConfig, getApiKey, regenerateApiKey } =
    useWebhookStore();

  const isMac = window.electron.platform === 'darwin';
  const isWindows = window.electron.platform === 'win32';
  const isLinux = window.electron.platform === 'linux';
  const isDev = window.electron.isDev;
  const showCliTools = isMac || isWindows || isLinux;
  const [showLogs, setShowLogs] = useState(false);
  const [logContent, setLogContent] = useState('');
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [includeApiKeys, setIncludeApiKeys] = useState(false);
  const [installingExtension, setInstallingExtension] = useState(false);
  const [extensionStatus, setExtensionStatus] = useState<{
    installed: boolean;
    path: string;
    chromeFound: boolean;
  } | null>(null);

  // API Server state
  const [apiKey, setApiKey] = useState('');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [apiServerPort, setApiServerPort] = useState(18790);
  const [apiServerBind, setApiServerBind] = useState('127.0.0.1');
  const [apiServerEnabled, setApiServerEnabled] = useState(false);
  const [apiServerUpdating, setApiServerUpdating] = useState(false);

  // Load API server config on mount
  useEffect(() => {
    fetchServerConfig();
    getApiKey().then(setApiKey).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync local form state when serverConfig loads
  useEffect(() => {
    if (serverConfig) {
      setApiServerPort(serverConfig.port);
      setApiServerBind(serverConfig.bindAddress);
      setApiServerEnabled(serverConfig.enabled);
    }
  }, [serverConfig]);

  const handleApiServerSave = async () => {
    setApiServerUpdating(true);
    try {
      await updateServerConfig({
        port: apiServerPort,
        bindAddress: apiServerBind,
        enabled: apiServerEnabled,
      });
      toast.success(t('apiServer.saved'));
    } catch (err) {
      toast.error(String(err));
    } finally {
      setApiServerUpdating(false);
    }
  };

  const handleRegenerateApiKey = async () => {
    if (!confirm(t('apiServer.regenerateKeyConfirm'))) return;
    try {
      const newKey = await regenerateApiKey();
      setApiKey(newKey);
      toast.success(t('apiServer.keyRegenerated'));
    } catch (err) {
      toast.error(String(err));
    }
  };

  const handleCopyApiKey = async () => {
    try {
      await navigator.clipboard.writeText(apiKey);
      toast.success(t('apiServer.keyCopied'));
    } catch {
      toast.error(t('apiServer.copyFailed'));
    }
  };

  const handleShowLogs = async () => {
    try {
      const logs = await window.electron.ipcRenderer.invoke('log:readFile', 100) as string;
      setLogContent(logs);
      setShowLogs(true);
    } catch {
      setLogContent('(Failed to load logs)');
      setShowLogs(true);
    }
  };

  const handleOpenLogDir = async () => {
    try {
      const logDir = await window.electron.ipcRenderer.invoke('log:getDir') as string;
      if (logDir) {
        await window.electron.ipcRenderer.invoke('shell:showItemInFolder', logDir);
      }
    } catch {
      // ignore
    }
  };

  // Open developer console
  const openDevConsole = async () => {
    try {
      const result = await window.electron.ipcRenderer.invoke('gateway:getControlUiUrl') as {
        success: boolean;
        url?: string;
        token?: string;
        port?: number;
        error?: string;
      };
      if (result.success && result.url && result.token && typeof result.port === 'number') {
        setControlUiInfo({ url: result.url, token: result.token, port: result.port });
        window.electron.openExternal(result.url);
      } else {
        console.error('Failed to get Dev Console URL:', result.error);
      }
    } catch (err) {
      console.error('Error opening Dev Console:', err);
    }
  };

  const refreshControlUiInfo = async () => {
    try {
      const result = await window.electron.ipcRenderer.invoke('gateway:getControlUiUrl') as {
        success: boolean;
        url?: string;
        token?: string;
        port?: number;
      };
      if (result.success && result.url && result.token && typeof result.port === 'number') {
        setControlUiInfo({ url: result.url, token: result.token, port: result.port });
      }
    } catch {
      // Ignore refresh errors
    }
  };

  const handleCopyGatewayToken = async () => {
    if (!controlUiInfo?.token) return;
    try {
      await navigator.clipboard.writeText(controlUiInfo.token);
      toast.success(t('developer.tokenCopied'));
    } catch (error) {
      toast.error(`Failed to copy token: ${String(error)}`);
    }
  };

  // Sync OpenClaw settings from main process (openclaw.json is source of truth)
  useEffect(() => {
    syncFromMain();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!showCliTools) return;
    let cancelled = false;

    const loadCliCommand = async () => {
      try {
        const result = await window.electron.ipcRenderer.invoke('openclaw:getCliCommand') as {
          success: boolean;
          command?: string;
          error?: string;
        };
        if (cancelled) return;
        if (result.success && result.command) {
          setOpenclawCliCommand(result.command);
          setOpenclawCliError(null);
        } else {
          setOpenclawCliCommand('');
          setOpenclawCliError(result.error || 'OpenClaw CLI unavailable');
        }
      } catch (error) {
        if (cancelled) return;
        setOpenclawCliCommand('');
        setOpenclawCliError(String(error));
      }
    };

    loadCliCommand();
    return () => {
      cancelled = true;
    };
  }, [devModeUnlocked, showCliTools]);

  const handleCopyCliCommand = async () => {
    if (!openclawCliCommand) return;
    try {
      await navigator.clipboard.writeText(openclawCliCommand);
      toast.success(t('developer.cmdCopied'));
    } catch (error) {
      toast.error(`Failed to copy command: ${String(error)}`);
    }
  };

  const handleInstallCliCommand = async () => {
    if (!isMac || installingCli) return;
    try {
      const confirmation = await window.electron.ipcRenderer.invoke('dialog:message', {
        type: 'question',
        title: t('developer.installTitle'),
        message: t('developer.installMessage'),
        detail: t('developer.installDetail'),
        buttons: ['Cancel', 'Install'],
        defaultId: 1,
        cancelId: 0,
      }) as { response: number };

      if (confirmation.response !== 1) return;

      setInstallingCli(true);
      const result = await window.electron.ipcRenderer.invoke('openclaw:installCliMac') as {
        success: boolean;
        path?: string;
        error?: string;
      };

      if (result.success) {
        toast.success(`Installed command at ${result.path ?? '/usr/local/bin/openclaw'}`);
      } else {
        toast.error(result.error || 'Failed to install command');
      }
    } catch (error) {
      toast.error(`Install failed: ${String(error)}`);
    } finally {
      setInstallingCli(false);
    }
  };

  const handleExport = async () => {
    try {
      setExporting(true);
      const result = await window.electron.ipcRenderer.invoke('config:export', {
        includeApiKeys,
      }) as { success: boolean; filePath?: string; fileCount?: number; error?: string };
      if (result.success) {
        toast.success(t('data.exportSuccess'));
      } else if (result.error !== 'cancelled') {
        toast.error(result.error || t('data.exportFailed'));
      }
    } catch (error) {
      toast.error(`${t('data.exportFailed')}: ${String(error)}`);
    } finally {
      setExporting(false);
    }
  };

  const handleImport = async () => {
    try {
      setImporting(true);
      const result = await window.electron.ipcRenderer.invoke('config:import') as {
        success: boolean;
        fileCount?: number;
        error?: string;
      };
      if (result.success) {
        toast.success(t('data.importSuccess', { count: result.fileCount ?? 0 }));
        const restart = await window.electron.ipcRenderer.invoke('dialog:message', {
          type: 'question',
          title: t('data.reloadTitle'),
          message: t('data.reloadMessage'),
          buttons: ['Later', 'Restart Now'],
          defaultId: 1,
          cancelId: 0,
        }) as { response: number };
        if (restart.response === 1) {
          await window.electron.ipcRenderer.invoke('app:relaunch');
        }
      } else if (result.error !== 'cancelled') {
        toast.error(result.error || t('data.importFailed'));
      }
    } catch (error) {
      toast.error(`${t('data.importFailed')}: ${String(error)}`);
    } finally {
      setImporting(false);
    }
  };

  // Load extension status on mount
  useEffect(() => {
    window.electron.ipcRenderer.invoke('extension:status').then((result: unknown) => {
      const r = result as { success: boolean; installed?: boolean; path?: string; chromeFound?: boolean };
      if (r.success) {
        setExtensionStatus({
          installed: r.installed ?? false,
          path: r.path ?? '',
          chromeFound: r.chromeFound ?? false,
        });
      }
    }).catch(() => {});
  }, []);

  const handleInstallExtension = async () => {
    try {
      setInstallingExtension(true);
      const result = await window.electron.ipcRenderer.invoke('extension:install') as {
        success: boolean;
        path?: string;
        relayPort?: number;
        error?: string;
      };
      if (result.success) {
        toast.success(`Browser extension installed to ${result.path}`);
        setExtensionStatus(prev => prev ? { ...prev, installed: true } : prev);
      } else {
        toast.error(result.error || 'Failed to install extension');
      }
    } catch (error) {
      toast.error(`Install failed: ${String(error)}`);
    } finally {
      setInstallingExtension(false);
    }
  };

  const handleOpenExtensionDir = async () => {
    try {
      await window.electron.ipcRenderer.invoke('extension:openDir');
    } catch {
      // ignore
    }
  };

  return (
    <div className="space-y-6 p-3 sm:p-6">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      {/* General */}
      <Card>
        <CardHeader>
          <CardTitle>{t('general.title')}</CardTitle>
          <CardDescription>{t('general.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('general.launchAtStartup')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('general.launchAtStartupDesc')}
              </p>
            </div>
            <Switch
              checked={launchAtStartup}
              onCheckedChange={setLaunchAtStartup}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>{t('general.startMinimized')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('general.startMinimizedDesc')}
              </p>
            </div>
            <Switch
              checked={startMinimized}
              onCheckedChange={setStartMinimized}
            />
          </div>
        </CardContent>
      </Card>

      {/* Appearance */}
      <Card>
        <CardHeader>
          <CardTitle>{t('appearance.title')}</CardTitle>
          <CardDescription>{t('appearance.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t('appearance.theme')}</Label>
            <div className="flex gap-2">
              <Button
                variant={theme === 'light' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTheme('light')}
              >
                <Sun className="h-4 w-4 mr-2" />
                {t('appearance.light')}
              </Button>
              <Button
                variant={theme === 'dark' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTheme('dark')}
              >
                <Moon className="h-4 w-4 mr-2" />
                {t('appearance.dark')}
              </Button>
              <Button
                variant={theme === 'system' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setTheme('system')}
              >
                <Monitor className="h-4 w-4 mr-2" />
                {t('appearance.system')}
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            <Label>{t('appearance.language')}</Label>
            <div className="flex gap-2">
              {SUPPORTED_LANGUAGES.map((lang) => (
                <Button
                  key={lang.code}
                  variant={language === lang.code ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setLanguage(lang.code)}
                >
                  {lang.label}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* AI Providers */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Key className="h-5 w-5" />
            {t('aiProviders.title')}
          </CardTitle>
          <CardDescription>{t('aiProviders.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ProvidersSettings />
        </CardContent>
      </Card>

      {/* WebAuth Providers */}
      <WebAuthSettings />

      {/* Gateway */}
      <Card>
        <CardHeader>
          <CardTitle>{t('gateway.title')}</CardTitle>
          <CardDescription>{t('gateway.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('gateway.status')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('gateway.port')}: {gatewayStatus.port}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  gatewayStatus.state === 'running'
                    ? 'success'
                    : gatewayStatus.state === 'error'
                      ? 'destructive'
                      : 'secondary'
                }
              >
                {gatewayStatus.state}
              </Badge>
              <Button variant="outline" size="sm" onClick={restartGateway}>
                <RefreshCw className="h-4 w-4 mr-2" />
                {t('common:actions.restart')}
              </Button>
              <Button variant="outline" size="sm" onClick={handleShowLogs}>
                <FileText className="h-4 w-4 mr-2" />
                {t('gateway.logs')}
              </Button>
            </div>
          </div>

          {showLogs && (
            <div className="mt-4 p-4 rounded-lg bg-black/10 dark:bg-black/40 border border-border">
              <div className="flex items-center justify-between mb-2">
                <p className="font-medium text-sm">{t('gateway.appLogs')}</p>
                <div className="flex gap-2">
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleOpenLogDir}>
                    <ExternalLink className="h-3 w-3 mr-1" />
                    {t('gateway.openFolder')}
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowLogs(false)}>
                    {t('common:actions.close')}
                  </Button>
                </div>
              </div>
              <pre className="text-xs text-muted-foreground bg-background/50 p-3 rounded max-h-60 overflow-auto whitespace-pre-wrap font-mono">
                {logContent || t('chat:noLogs')}
              </pre>
            </div>
          )}

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>{t('gateway.autoStart')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('gateway.autoStartDesc')}
              </p>
            </div>
            <Switch
              checked={gatewayAutoStart}
              onCheckedChange={setGatewayAutoStart}
            />
          </div>

        </CardContent>
      </Card>

      {/* Browser Extension */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Globe className="h-5 w-5" />
            Browser Extension
          </CardTitle>
          <CardDescription>
            Install the CrawBot Browser Relay extension to enable browser automation on your existing Chrome tabs.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>Extension Status</Label>
              <p className="text-sm text-muted-foreground">
                {extensionStatus?.installed
                  ? 'Extension files installed. Load it in Chrome via chrome://extensions (Developer mode → Load unpacked).'
                  : 'Click install to set up the extension with auto-configured gateway token.'}
              </p>
            </div>
            <Badge variant={extensionStatus?.installed ? 'success' : 'secondary'}>
              {extensionStatus?.installed ? 'Installed' : 'Not installed'}
            </Badge>
          </div>

          <div className="flex gap-2 flex-wrap">
            <Button
              variant={extensionStatus?.installed ? 'outline' : 'default'}
              onClick={handleInstallExtension}
              disabled={installingExtension}
            >
              {extensionStatus?.installed ? (
                <RefreshCw className="h-4 w-4 mr-2" />
              ) : (
                <Download className="h-4 w-4 mr-2" />
              )}
              {installingExtension
                ? 'Installing...'
                : extensionStatus?.installed
                  ? 'Reinstall / Update'
                  : 'Install Extension'}
            </Button>
            {extensionStatus?.installed && (
              <Button variant="outline" onClick={handleOpenExtensionDir}>
                <FolderOpen className="h-4 w-4 mr-2" />
                Open Extension Folder
              </Button>
            )}
          </div>

          {extensionStatus?.installed && (
            <details className="group">
              <summary className="cursor-pointer text-sm font-medium text-primary hover:underline list-none flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-500" />
                Setup &amp; Usage Guide
                <span className="text-xs text-muted-foreground font-normal ml-1 group-open:hidden">(click to expand)</span>
              </summary>
              <div className="space-y-3 mt-3">
                {/* Setup guide */}
                <div className="text-xs text-muted-foreground space-y-1 p-3 rounded-lg bg-muted/50">
                  <p className="font-medium">1. Load extension in Chrome</p>
                  <ol className="list-decimal ml-4 space-y-0.5">
                    <li>Open <code className="text-xs">chrome://extensions</code> in Chrome</li>
                    <li>Enable <strong>Developer mode</strong> (top-right toggle)</li>
                    <li>Click <strong>Load unpacked</strong> and select the extension folder</li>
                    <li>The extension auto-connects to CrawBot gateway — no manual config needed</li>
                  </ol>
                </div>

                {/* How it works */}
                <div className="text-xs text-muted-foreground space-y-1 p-3 rounded-lg bg-muted/50">
                  <p className="font-medium">2. How it works</p>
                  <ul className="list-disc ml-4 space-y-0.5">
                    <li>The extension automatically attaches to <strong>all browser tabs</strong> via Chrome DevTools Protocol (CDP)</li>
                    <li>Full CDP domains enabled: Page, Runtime, DOM, Network, Input, Emulation, Overlay, Log, Target</li>
                    <li>New tabs are attached automatically — no manual action needed</li>
                    <li>The relay connects your browser to OpenClaw gateway so the AI agent can see and control web pages</li>
                  </ul>
                </div>

                {/* How to prompt agent */}
                <div className="text-xs text-muted-foreground space-y-1.5 p-3 rounded-lg bg-blue-500/5 border border-blue-500/10">
                  <p className="font-medium text-blue-600 dark:text-blue-400">3. Tell the agent to use browser</p>
                  <p>Once the extension is loaded and gateway is running, ask the agent to interact with your browser. Example prompts:</p>
                  <div className="space-y-1.5 mt-1">
                    <div className="bg-background/60 rounded px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
                      Go to google.com and search for &quot;OpenClaw AI&quot;
                    </div>
                    <div className="bg-background/60 rounded px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
                      Open my current browser tab and summarize the page content
                    </div>
                    <div className="bg-background/60 rounded px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
                      Fill in the login form with username &quot;demo&quot; and click submit
                    </div>
                    <div className="bg-background/60 rounded px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
                      Take a screenshot of the current tab and describe what you see
                    </div>
                    <div className="bg-background/60 rounded px-2.5 py-1.5 font-mono text-[11px] leading-relaxed">
                      Monitor the network requests on this page and list all API calls
                    </div>
                  </div>
                  <p className="mt-1.5">The agent has a <strong>browser</strong> tool that works through this Chrome extension relay. You can also explicitly say &quot;use the browser tool&quot; in your prompt.</p>
                </div>
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      {/* OpenClaw */}
      <Card>
        <CardHeader>
          <CardTitle>{t('openclaw.title')}</CardTitle>
          <CardDescription>{t('openclaw.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('openclaw.toolsAutoApprove')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('openclaw.toolsAutoApproveDesc')}
              </p>
            </div>
            <Switch
              checked={toolsAutoApprove}
              onCheckedChange={setToolsAutoApprove}
            />
          </div>

          <Separator />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex-1 mr-4">
                <Label>{t('openclaw.dmScope')}</Label>
                <p className="text-sm text-muted-foreground">
                  {t('openclaw.dmScopeDesc')}
                </p>
              </div>
              <Select
                className="w-[220px]"
                value={sessionDmScope}
                onChange={(e) => setSessionDmScope(e.target.value as 'main' | 'per-peer' | 'per-channel-peer' | 'per-account-channel-peer')}
              >
                <option value="main">{t('openclaw.dmScopeOptions.main')}</option>
                <option value="per-peer">{t('openclaw.dmScopeOptions.perPeer')}</option>
                <option value="per-channel-peer">{t('openclaw.dmScopeOptions.perChannelPeer')}</option>
                <option value="per-account-channel-peer">{t('openclaw.dmScopeOptions.perAccountChannelPeer')}</option>
              </Select>
            </div>
            <p className="text-xs text-muted-foreground/70">
              {t(`openclaw.dmScopeHints.${sessionDmScope}`)}
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Updates */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            {t('updates.title')}
          </CardTitle>
          <CardDescription>{t('updates.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <UpdateSettings />

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label>{t('updates.autoCheck')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('updates.autoCheckDesc')}
              </p>
            </div>
            <Switch
              checked={autoCheckUpdate}
              onCheckedChange={setAutoCheckUpdate}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label>{t('updates.autoDownload')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('updates.autoDownloadDesc')}
              </p>
            </div>
            <Switch
              checked={autoDownloadUpdate}
              onCheckedChange={(value) => {
                setAutoDownloadUpdate(value);
                updateSetAutoDownload(value);
              }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Advanced */}
      <Card>
        <CardHeader>
          <CardTitle>{t('advanced.title')}</CardTitle>
          <CardDescription>{t('advanced.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('advanced.devMode')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('advanced.devModeDesc')}
              </p>
            </div>
            <Switch
              checked={devModeUnlocked}
              onCheckedChange={setDevModeUnlocked}
            />
          </div>
        </CardContent>
      </Card>

      {/* Data */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Archive className="h-5 w-5" />
            {t('data.title')}
          </CardTitle>
          <CardDescription>{t('data.description')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>{t('data.export')}</Label>
            <p className="text-sm text-muted-foreground">
              {t('data.exportDesc')}
            </p>
            <div className="flex items-center justify-between py-1">
              <div>
                <Label className="text-sm">{t('data.includeApiKeys')}</Label>
                <p className="text-xs text-muted-foreground">
                  {t('data.includeApiKeysDesc')}
                </p>
              </div>
              <Switch
                checked={includeApiKeys}
                onCheckedChange={setIncludeApiKeys}
              />
            </div>
            <Button variant="outline" onClick={handleExport} disabled={exporting}>
              <Archive className="h-4 w-4 mr-2" />
              {exporting ? t('data.exporting') : t('data.exportButton')}
            </Button>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>{t('data.import')}</Label>
            <p className="text-sm text-muted-foreground">
              {t('data.importDesc')}
            </p>
            <p className="text-xs text-destructive">
              {t('data.importWarning')}
            </p>
            <Button variant="outline" onClick={handleImport} disabled={importing}>
              <Upload className="h-4 w-4 mr-2" />
              {importing ? t('data.importing') : t('data.importButton')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Developer */}
      {devModeUnlocked && (
        <Card>
          <CardHeader>
            <CardTitle>{t('developer.title')}</CardTitle>
            <CardDescription>{t('developer.description')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label>{t('developer.console')}</Label>
              <p className="text-sm text-muted-foreground">
                {t('developer.consoleDesc')}
              </p>
              <Button variant="outline" onClick={openDevConsole}>
                <Terminal className="h-4 w-4 mr-2" />
                {t('developer.openConsole')}
                <ExternalLink className="h-3 w-3 ml-2" />
              </Button>
              <p className="text-xs text-muted-foreground">
                {t('developer.consoleNote')}
              </p>
              <div className="space-y-2 pt-2">
                <Label>{t('developer.gatewayToken')}</Label>
                <p className="text-sm text-muted-foreground">
                  {t('developer.gatewayTokenDesc')}
                </p>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={controlUiInfo?.token || ''}
                    placeholder={t('developer.tokenUnavailable')}
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={refreshControlUiInfo}
                    disabled={!devModeUnlocked}
                  >
                    <RefreshCw className="h-4 w-4 mr-2" />
                    {t('common:actions.load')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={handleCopyGatewayToken}
                    disabled={!controlUiInfo?.token}
                  >
                    <Copy className="h-4 w-4 mr-2" />
                    {t('common:actions.copy')}
                  </Button>
                </div>
              </div>
            </div>
            {showCliTools && (
              <>
                <Separator />
                <div className="space-y-2">
                  <Label>{t('developer.cli')}</Label>
                  <p className="text-sm text-muted-foreground">
                    {t('developer.cliDesc')}
                  </p>
                  {isWindows && (
                    <p className="text-xs text-muted-foreground">
                      {t('developer.cliPowershell')}
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Input
                      readOnly
                      value={openclawCliCommand}
                      placeholder={openclawCliError || t('developer.cmdUnavailable')}
                      className="font-mono"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleCopyCliCommand}
                      disabled={!openclawCliCommand}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      {t('common:actions.copy')}
                    </Button>
                  </div>
                  {isMac && !isDev && (
                    <div className="space-y-1">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleInstallCliCommand}
                        disabled={installingCli}
                      >
                        <Terminal className="h-4 w-4 mr-2" />
                        {t('developer.installCmd')}
                      </Button>
                      <p className="text-xs text-muted-foreground">
                        {t('developer.installCmdDesc')}
                      </p>
                    </div>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}

      {/* API Server */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Server className="h-5 w-5 text-primary" />
            <div>
              <CardTitle>{t('apiServer.title')}</CardTitle>
              <CardDescription className="mt-1">{t('apiServer.description')}</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Enable toggle */}
          <div className="flex items-center justify-between">
            <div>
              <Label>{t('apiServer.enable')}</Label>
              <p className="text-sm text-muted-foreground">{t('apiServer.enableDesc')}</p>
            </div>
            <Switch
              checked={apiServerEnabled}
              onCheckedChange={(v) => setApiServerEnabled(v)}
            />
          </div>

          <Separator />

          {/* Port */}
          <div className="space-y-2">
            <Label>{t('apiServer.port')}</Label>
            <Input
              type="number"
              min={1024}
              max={65535}
              value={apiServerPort}
              onChange={(e) => setApiServerPort(parseInt(e.target.value, 10) || 18790)}
              className="w-40"
            />
          </div>

          {/* Bind address */}
          <div className="space-y-2">
            <Label>{t('apiServer.bindAddress')}</Label>
            <Input
              value={apiServerBind}
              onChange={(e) => setApiServerBind(e.target.value)}
              className="w-60 font-mono"
              placeholder="127.0.0.1"
            />
            {apiServerBind && apiServerBind !== '127.0.0.1' && (
              <div className="flex items-center gap-2 text-sm text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-4 w-4" />
                {t('apiServer.bindWarning')}
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('apiServer.bindDesc')}</p>
          </div>

          {/* Save button */}
          <Button onClick={handleApiServerSave} disabled={apiServerUpdating} variant="outline">
            {apiServerUpdating ? (
              <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mr-2" />
            )}
            {t('apiServer.save')}
          </Button>

          <Separator />

          {/* API Key */}
          <div className="space-y-2">
            <Label>{t('apiServer.apiKey')}</Label>
            <p className="text-sm text-muted-foreground">{t('apiServer.apiKeyDesc')}</p>
            <div className="flex items-center gap-2">
              <Input
                readOnly
                value={apiKeyVisible ? apiKey : '•'.repeat(Math.min(apiKey.length, 32))}
                className="font-mono flex-1"
              />
              <Button
                variant="outline"
                size="icon"
                onClick={() => setApiKeyVisible((v) => !v)}
              >
                {apiKeyVisible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
              <Button variant="outline" size="icon" onClick={handleCopyApiKey} disabled={!apiKey}>
                <Copy className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={handleRegenerateApiKey}>
                <Key className="h-4 w-4 mr-2" />
                {t('apiServer.regenerateKey')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">{t('apiServer.apiKeyNote')}</p>
          </div>

          {/* Status */}
          {serverConfig && (
            <div className="flex items-center gap-2 text-sm">
              <div
                className={`h-2 w-2 rounded-full ${apiServerEnabled ? 'bg-green-500' : 'bg-muted-foreground'}`}
              />
              <span className="text-muted-foreground">
                {apiServerEnabled
                  ? t('apiServer.statusRunning', { port: serverConfig.port })
                  : t('apiServer.statusStopped')}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* About */}
      <Card>
        <CardHeader>
          <CardTitle>{t('about.title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            <strong>{t('about.appName')}</strong> - {t('about.tagline')}
          </p>
          <p>{t('about.basedOn')}</p>
          <p>{t('about.version', { version: currentVersion })}</p>
          <div className="flex gap-4 pt-2">
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => window.electron.openExternal('https://crawbot.net')}
            >
              {t('about.docs')}
            </Button>
            <Button
              variant="link"
              className="h-auto p-0"
              onClick={() => window.electron.openExternal('https://github.com/Neurons-ai/CrawBot')}
            >
              {t('about.github')}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

export default Settings;
