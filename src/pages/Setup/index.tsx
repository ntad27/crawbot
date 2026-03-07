/**
 * Setup Wizard Page
 * First-time setup experience for new users
 */
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  Eye,
  EyeOff,
  RefreshCw,
  CheckCircle2,
  XCircle,
  ExternalLink,
  BookOpen,
  Key,
  LogIn,
  Download,
} from 'lucide-react';
import { TitleBar } from '@/components/layout/TitleBar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { useGatewayStore } from '@/stores/gateway';
import { useProviderStore } from '@/stores/providers';
import { useSettingsStore } from '@/stores/settings';
import { useTranslation } from 'react-i18next';
import { useModelsStore } from '@/stores/models';
import { SUPPORTED_LANGUAGES } from '@/i18n';
import { toast } from 'sonner';
import {
  CHANNEL_META,
  getPrimaryChannels,
  type ChannelType,
  type ChannelMeta,
  type ChannelConfigField,
} from '@/types/channel';
import { ChannelIcon } from '@/components/ChannelIcon';

interface SetupStep {
  id: string;
  title: string;
  description: string;
}

const STEP = {
  WELCOME: 0,
  RUNTIME: 1,
  PROVIDER: 2,
  CHANNEL: 3,
  INSTALLING: 4,
  COMPLETE: 5,
} as const;

const steps: SetupStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to CrawBot',
    description: 'Your AI assistant is ready to be configured',
  },
  {
    id: 'runtime',
    title: 'Environment Check',
    description: 'Verifying system requirements',
  },
  {
    id: 'provider',
    title: 'AI Provider',
    description: 'Configure your AI service',
  },
  {
    id: 'channel',
    title: 'Connect a Channel',
    description: 'Connect a messaging platform (optional)',
  },
  {
    id: 'installing',
    title: 'Setting Up',
    description: 'Installing essential components',
  },
  {
    id: 'complete',
    title: 'All Set!',
    description: 'CrawBot is ready to use',
  },
];

// Default skills to auto-install (no additional API keys required)
interface DefaultSkill {
  id: string;
  name: string;
  description: string;
}

const defaultSkills: DefaultSkill[] = [
  { id: 'opencode', name: 'OpenCode', description: 'AI coding assistant backend' },
  { id: 'python-env', name: 'Python Environment', description: 'Python runtime for skills' },
  { id: 'code-assist', name: 'Code Assist', description: 'Code analysis and suggestions' },
  { id: 'file-tools', name: 'File Tools', description: 'File operations and management' },
  { id: 'terminal', name: 'Terminal', description: 'Shell command execution' },
];

import { SETUP_PROVIDERS, type ProviderTypeInfo, getProviderIconUrl, shouldInvertInDark } from '@/lib/providers';
import crawbotIcon from '@/assets/logo.svg';

// Use the shared provider registry for setup providers
const providers = SETUP_PROVIDERS;

// NOTE: Channel types moved to Settings > Channels page
// NOTE: Skill bundles moved to Settings > Skills page - auto-install essential skills during setup

export function Setup() {
  const { t } = useTranslation(['setup', 'channels']);
  const navigate = useNavigate();
  const [currentStep, setCurrentStep] = useState<number>(STEP.WELCOME);

  // Setup state
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const [providerConfigured, setProviderConfigured] = useState(false);
  const [apiKey, setApiKey] = useState('');
  // Installation state for the Installing step
  const [installedSkills, setInstalledSkills] = useState<string[]>([]);
  // Runtime check status
  const [runtimeChecksPassed, setRuntimeChecksPassed] = useState(false);

  const safeStepIndex = Number.isInteger(currentStep)
    ? Math.min(Math.max(currentStep, STEP.WELCOME), steps.length - 1)
    : STEP.WELCOME;
  const step = steps[safeStepIndex] ?? steps[STEP.WELCOME];
  const isFirstStep = safeStepIndex === STEP.WELCOME;
  const isLastStep = safeStepIndex === steps.length - 1;

  const markSetupComplete = useSettingsStore((state) => state.markSetupComplete);

  // Derive canProceed based on current step - computed directly to avoid useEffect
  const canProceed = useMemo(() => {
    switch (safeStepIndex) {
      case STEP.WELCOME:
        return true;
      case STEP.RUNTIME:
        return runtimeChecksPassed;
      case STEP.PROVIDER:
        return providerConfigured;
      case STEP.CHANNEL:
        return true; // Always allow proceeding — channel step is optional
      case STEP.INSTALLING:
        return false; // Cannot manually proceed, auto-proceeds when done
      case STEP.COMPLETE:
        return true;
      default:
        return true;
    }
  }, [safeStepIndex, providerConfigured, runtimeChecksPassed]);

  const handleNext = async () => {
    if (isLastStep) {
      // Complete setup
      markSetupComplete();
      toast.success(t('complete.title'));
      navigate('/');
    } else {
      setCurrentStep((i) => i + 1);
    }
  };

  const handleBack = () => {
    setCurrentStep((i) => Math.max(i - 1, 0));
  };

  const handleSkip = () => {
    markSetupComplete();
    navigate('/');
  };

  // Auto-proceed when installation is complete
  const handleInstallationComplete = useCallback((skills: string[]) => {
    setInstalledSkills(skills);
    // Auto-proceed to next step after a short delay
    setTimeout(() => {
      setCurrentStep((i) => i + 1);
    }, 1000);
  }, []);


  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex-1 overflow-auto">
        {/* Progress Indicator */}
        <div className="flex justify-center pt-8">
          <div className="flex items-center gap-2">
            {steps.map((s, i) => (
              <div key={s.id} className="flex items-center">
                <div
                  className={cn(
                    'flex h-8 w-8 items-center justify-center rounded-full border-2 transition-colors',
                    i < safeStepIndex
                      ? 'border-primary bg-primary text-primary-foreground'
                      : i === safeStepIndex
                        ? 'border-primary text-primary'
                        : 'border-slate-600 text-slate-600'
                  )}
                >
                  {i < safeStepIndex ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <span className="text-sm">{i + 1}</span>
                  )}
                </div>
                {i < steps.length - 1 && (
                  <div
                    className={cn(
                      'h-0.5 w-8 transition-colors',
                      i < safeStepIndex ? 'bg-primary' : 'bg-slate-600'
                    )}
                  />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Step Content */}
        <AnimatePresence mode="wait">
          <motion.div
            key={step.id}
            initial={{ opacity: 0, x: 20 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -20 }}
            className="mx-auto max-w-2xl p-4 sm:p-8"
          >
            <div className="text-center mb-8">
              <h1 className="text-3xl font-bold mb-2">{t(`steps.${step.id}.title`)}</h1>
              <p className="text-slate-400">{t(`steps.${step.id}.description`)}</p>
            </div>

            {/* Step-specific content */}
            <div className="rounded-xl bg-card text-card-foreground border shadow-sm p-4 sm:p-8 mb-4 sm:mb-8">
              {safeStepIndex === STEP.WELCOME && <WelcomeContent />}
              {safeStepIndex === STEP.RUNTIME && <RuntimeContent onStatusChange={setRuntimeChecksPassed} />}
              {safeStepIndex === STEP.PROVIDER && (
                <ProviderContent
                  providers={providers}
                  selectedProvider={selectedProvider}
                  onSelectProvider={setSelectedProvider}
                  apiKey={apiKey}
                  onApiKeyChange={setApiKey}
                  onConfiguredChange={setProviderConfigured}
                />
              )}
              {safeStepIndex === STEP.CHANNEL && <SetupChannelContent />}
              {safeStepIndex === STEP.INSTALLING && (
                <InstallingContent
                  skills={defaultSkills}
                  onComplete={handleInstallationComplete}
                  onSkip={() => setCurrentStep((i) => i + 1)}
                />
              )}
              {safeStepIndex === STEP.COMPLETE && (
                <CompleteContent
                  selectedProvider={selectedProvider}
                  installedSkills={installedSkills}
                />
              )}
            </div>

            {/* Navigation - hidden during installation step */}
            {safeStepIndex !== STEP.INSTALLING && (
              <div className="flex justify-between">
                <div>
                  {!isFirstStep && (
                    <Button variant="ghost" onClick={handleBack}>
                      <ChevronLeft className="h-4 w-4 mr-2" />
                      {t('nav.back')}
                    </Button>
                  )}
                </div>
                <div className="flex gap-2">
                  {safeStepIndex === STEP.CHANNEL && (
                    <Button variant="ghost" onClick={handleNext}>
                      {t('nav.skipStep')}
                    </Button>
                  )}
                  {!isLastStep && safeStepIndex !== STEP.RUNTIME && safeStepIndex !== STEP.CHANNEL && (
                    <Button variant="ghost" onClick={handleSkip}>
                      {t('nav.skipSetup')}
                    </Button>
                  )}
                  <Button onClick={handleNext} disabled={!canProceed}>
                    {isLastStep ? (
                      t('nav.getStarted')
                    ) : (
                      <>
                        {t('nav.next')}
                        <ChevronRight className="h-4 w-4 ml-2" />
                      </>
                    )}
                  </Button>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ==================== Step Content Components ====================

function WelcomeContent() {
  const { t } = useTranslation(['setup', 'settings']);
  const { language, setLanguage } = useSettingsStore();

  return (
    <div className="text-center space-y-4">
      <div className="mb-4 flex justify-center">
        <img src={crawbotIcon} alt="CrawBot" className="h-16 w-16" />
      </div>
      <h2 className="text-xl font-semibold">{t('welcome.title')}</h2>
      <p className="text-muted-foreground">
        {t('welcome.description')}
      </p>

      {/* Language Selector */}
      <div className="flex justify-center gap-2 py-2">
        {SUPPORTED_LANGUAGES.map((lang) => (
          <Button
            key={lang.code}
            variant={language === lang.code ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => setLanguage(lang.code)}
            className="h-7 text-xs"
          >
            {lang.label}
          </Button>
        ))}
      </div>

      <ul className="text-left space-y-2 text-muted-foreground pt-2">
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-400" />
          {t('welcome.features.noCommand')}
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-400" />
          {t('welcome.features.modernUI')}
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-400" />
          {t('welcome.features.bundles')}
        </li>
        <li className="flex items-center gap-2">
          <CheckCircle2 className="h-5 w-5 text-green-400" />
          {t('welcome.features.crossPlatform')}
        </li>
      </ul>
    </div>
  );
}

interface RuntimeContentProps {
  onStatusChange: (canProceed: boolean) => void;
}

type CheckStatus = 'pending' | 'checking' | 'installing' | 'success' | 'warning' | 'error';

interface CheckItem {
  status: CheckStatus;
  message: string;
}

interface CliToolCheck {
  name: string;
  command: string;
  status: CheckStatus;
  message: string;
}

function RuntimeContent({ onStatusChange }: RuntimeContentProps) {
  const { t } = useTranslation('setup');
  const gatewayStatus = useGatewayStore((state) => state.status);
  const startGateway = useGatewayStore((state) => state.start);

  const [checks, setChecks] = useState<{
    nodejs: CheckItem;
    python: CheckItem;
    buildtools: CheckItem;
    openclaw: CheckItem;
    gateway: CheckItem;
  }>({
    nodejs: { status: 'checking', message: '' },
    python: { status: 'pending', message: '' },
    buildtools: { status: 'pending', message: '' },
    openclaw: { status: 'checking', message: '' },
    gateway: { status: 'checking', message: '' },
  });

  const [cliTools, setCliTools] = useState<CliToolCheck[]>([
    { name: 'Claude Code', command: 'claude', status: 'pending', message: '' },
    { name: 'Gemini CLI', command: 'gemini', status: 'pending', message: '' },
    { name: 'Codex CLI', command: 'codex', status: 'pending', message: '' },
  ]);

  const [showLogs, setShowLogs] = useState(false);
  const [logContent, setLogContent] = useState('');
  const [openclawDir, setOpenclawDir] = useState('');
  const gatewayTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const nodeInstallAttempted = useRef(false);
  const cliInstallAttempted = useRef(false);

  // ─── Node.js check & auto-install ───
  const checkAndInstallNode = useCallback(async () => {
    setChecks((prev) => ({ ...prev, nodejs: { status: 'checking', message: t('runtime.status.checking') } }));

    try {
      const nodeStatus = await window.electron.ipcRenderer.invoke('nodejs:check') as {
        installed: boolean;
        version?: string;
        source?: string;
      };

      if (nodeStatus.installed) {
        setChecks((prev) => ({
          ...prev,
          nodejs: {
            status: 'success',
            message: t('runtime.status.nodeFound', { version: nodeStatus.version || '' }),
          },
        }));
        return true;
      }

      // Node.js not found — auto-install
      if (!nodeInstallAttempted.current) {
        nodeInstallAttempted.current = true;
        setChecks((prev) => ({
          ...prev,
          nodejs: { status: 'installing', message: t('runtime.status.installingNode') },
        }));

        const installResult = await window.electron.ipcRenderer.invoke('nodejs:install') as {
          success: boolean;
          version?: string;
          error?: string;
        };

        if (installResult.success) {
          setChecks((prev) => ({
            ...prev,
            nodejs: {
              status: 'success',
              message: t('runtime.status.nodeInstalled', { version: installResult.version || '' }),
            },
          }));
          return true;
        } else {
          setChecks((prev) => ({
            ...prev,
            nodejs: { status: 'error', message: installResult.error || t('runtime.status.error') },
          }));
          return false;
        }
      }

      setChecks((prev) => ({
        ...prev,
        nodejs: { status: 'error', message: t('runtime.status.notFound') },
      }));
      return false;
    } catch (error) {
      setChecks((prev) => ({
        ...prev,
        nodejs: { status: 'error', message: String(error) },
      }));
      return false;
    }
  }, [t]);

  // ─── CLI tools check & auto-install (one-by-one for live status) ───
  const checkAndInstallCliTools = useCallback(async () => {
    // First check what's already installed
    setCliTools((prev) => prev.map((tool) => ({ ...tool, status: 'checking' as CheckStatus, message: t('runtime.status.checking') })));

    try {
      const toolStatuses = await window.electron.ipcRenderer.invoke('nodejs:checkCliTools') as Array<{
        name: string;
        command: string;
        installed: boolean;
      }>;

      // Build list of tools that need installation (outside setState to avoid mutation issues)
      const needsInstall: string[] = [];
      for (const tool of toolStatuses) {
        if (!tool.installed) {
          needsInstall.push(tool.command);
        }
      }

      // Update check results
      setCliTools((prev) =>
        prev.map((tool) => {
          const status = toolStatuses.find((s) => s.command === tool.command);
          if (status?.installed) {
            return { ...tool, status: 'success' as CheckStatus, message: t('runtime.status.toolInstalled') };
          }
          return { ...tool, status: 'pending' as CheckStatus, message: '' };
        })
      );

      // Install missing tools ONE BY ONE with live status updates
      if (needsInstall.length > 0 && !cliInstallAttempted.current) {
        cliInstallAttempted.current = true;

        for (const command of needsInstall) {
          // Mark this specific tool as installing
          setCliTools((prev) =>
            prev.map((tool) =>
              tool.command === command
                ? { ...tool, status: 'installing' as CheckStatus, message: t('runtime.status.installing') }
                : tool
            )
          );

          // Install this single tool (with timeout in backend)
          const result = await window.electron.ipcRenderer.invoke('nodejs:installSingleCliTool', command) as {
            success: boolean;
            error?: string;
          };

          // Update this specific tool's status
          setCliTools((prev) =>
            prev.map((tool) => {
              if (tool.command !== command) return tool;
              if (result.success) {
                return { ...tool, status: 'success' as CheckStatus, message: t('runtime.status.toolInstalled') };
              }
              return { ...tool, status: 'error' as CheckStatus, message: result.error || t('runtime.status.toolFailed') };
            })
          );
        }
      }
    } catch (error) {
      setCliTools((prev) =>
        prev.map((tool) =>
          tool.status !== 'success'
            ? { ...tool, status: 'error' as CheckStatus, message: String(error) }
            : tool
        )
      );
    }
  }, [t]);

  // ─── Python check ───
  const checkPython = useCallback(async () => {
    setChecks((prev) => ({ ...prev, python: { status: 'checking', message: t('runtime.status.checking') } }));
    try {
      const binDir = await window.electron.ipcRenderer.invoke('python:getBinDir') as string | null;
      if (binDir) {
        setChecks((prev) => ({
          ...prev,
          python: { status: 'success', message: t('runtime.status.pythonReady') },
        }));
      } else {
        setChecks((prev) => ({
          ...prev,
          python: { status: 'error', message: t('runtime.status.pythonNotFound') },
        }));
      }
    } catch {
      setChecks((prev) => ({
        ...prev,
        python: { status: 'error', message: t('runtime.status.pythonNotFound') },
      }));
    }
  }, [t]);

  // ─── Build tools check (informational, non-blocking) ───
  const buildToolsInstallAttempted = useRef(false);

  const checkBuildToolsStatus = useCallback(async () => {
    setChecks((prev) => ({ ...prev, buildtools: { status: 'checking', message: t('runtime.status.checking') } }));
    try {
      const result = await window.electron.ipcRenderer.invoke('buildtools:check') as {
        installed: boolean;
        installHint?: string;
      };
      if (result.installed) {
        setChecks((prev) => ({
          ...prev,
          buildtools: { status: 'success', message: t('runtime.status.buildtoolsReady') },
        }));
        return;
      }

      // Not installed — attempt auto-install once
      if (!buildToolsInstallAttempted.current) {
        buildToolsInstallAttempted.current = true;
        setChecks((prev) => ({
          ...prev,
          buildtools: { status: 'installing', message: t('runtime.status.installingBuildtools') },
        }));

        const installResult = await window.electron.ipcRenderer.invoke('buildtools:install') as {
          success: boolean;
          error?: string;
        };

        if (installResult.success) {
          // Re-check after install (macOS xcode-select opens dialog, may take a while)
          const recheck = await window.electron.ipcRenderer.invoke('buildtools:check') as {
            installed: boolean;
          };
          if (recheck.installed) {
            setChecks((prev) => ({
              ...prev,
              buildtools: { status: 'success', message: t('runtime.status.buildtoolsReady') },
            }));
            return;
          }
        }

        // Install failed or tools still not detected after install
        setChecks((prev) => ({
          ...prev,
          buildtools: { status: 'warning', message: installResult.error || result.installHint || t('runtime.status.buildtoolsHint') },
        }));
      } else {
        setChecks((prev) => ({
          ...prev,
          buildtools: { status: 'warning', message: result.installHint || t('runtime.status.buildtoolsHint') },
        }));
      }
    } catch {
      setChecks((prev) => ({
        ...prev,
        buildtools: { status: 'warning', message: t('runtime.status.buildtoolsHint') },
      }));
    }
  }, [t]);

  // ─── OpenClaw & Gateway checks (existing logic) ───
  const checkOpenClawAndGateway = useCallback(async () => {
    // Check OpenClaw package status
    try {
      const openclawStatus = await window.electron.ipcRenderer.invoke('openclaw:status') as {
        packageExists: boolean;
        isBuilt: boolean;
        dir: string;
        version?: string;
      };

      setOpenclawDir(openclawStatus.dir);

      if (!openclawStatus.packageExists) {
        setChecks((prev) => ({
          ...prev,
          openclaw: { status: 'error', message: `OpenClaw package not found at: ${openclawStatus.dir}` },
        }));
      } else if (!openclawStatus.isBuilt) {
        setChecks((prev) => ({
          ...prev,
          openclaw: { status: 'error', message: 'OpenClaw package found but dist is missing' },
        }));
      } else {
        const versionLabel = openclawStatus.version ? ` v${openclawStatus.version}` : '';
        setChecks((prev) => ({
          ...prev,
          openclaw: { status: 'success', message: `OpenClaw package ready${versionLabel}` },
        }));
      }
    } catch (error) {
      setChecks((prev) => ({
        ...prev,
        openclaw: { status: 'error', message: `Check failed: ${error}` },
      }));
    }

    // Check Gateway
    const currentGateway = useGatewayStore.getState().status;
    if (currentGateway.state === 'running') {
      setChecks((prev) => ({
        ...prev,
        gateway: { status: 'success', message: `Running on port ${currentGateway.port}` },
      }));
    } else if (currentGateway.state === 'error') {
      setChecks((prev) => ({
        ...prev,
        gateway: { status: 'error', message: currentGateway.error || t('runtime.status.error') },
      }));
    } else {
      setChecks((prev) => ({
        ...prev,
        gateway: {
          status: 'checking',
          message: currentGateway.state === 'starting' ? t('runtime.status.checking') : 'Waiting for gateway...',
        },
      }));
    }
  }, [t]);

  // ─── Run all checks sequentially ───
  const runChecks = useCallback(async () => {
    // Reset
    nodeInstallAttempted.current = false;
    cliInstallAttempted.current = false;
    buildToolsInstallAttempted.current = false;
    setChecks({
      nodejs: { status: 'checking', message: '' },
      python: { status: 'pending', message: '' },
      buildtools: { status: 'pending', message: '' },
      openclaw: { status: 'checking', message: '' },
      gateway: { status: 'checking', message: '' },
    });
    setCliTools((prev) => prev.map((tool) => ({ ...tool, status: 'pending' as CheckStatus, message: '' })));

    // 1. Check/install Node.js
    const nodeReady = await checkAndInstallNode();

    // 2. Check Python availability
    await checkPython();

    // 3. Check/install CLI tools (only if Node.js is ready)
    if (nodeReady) {
      await checkAndInstallCliTools();
    }

    // 4. Check OpenClaw & Gateway (blocking — required for canProceed)
    await checkOpenClawAndGateway();

    // 5. Check build tools (fire-and-forget — non-blocking, may take minutes)
    checkBuildToolsStatus();
  }, [checkAndInstallNode, checkPython, checkAndInstallCliTools, checkBuildToolsStatus, checkOpenClawAndGateway]);

  useEffect(() => {
    runChecks();
  }, [runChecks]);

  // Update canProceed — Node.js + OpenClaw + Gateway must pass; CLI tools are best-effort
  useEffect(() => {
    const allPassed =
      checks.nodejs.status === 'success' &&
      checks.openclaw.status === 'success' &&
      (checks.gateway.status === 'success' || gatewayStatus.state === 'running');
    onStatusChange(allPassed);
  }, [checks, gatewayStatus, onStatusChange]);

  // Update gateway check when gateway status changes
  useEffect(() => {
    if (gatewayStatus.state === 'running') {
      setChecks((prev) => ({
        ...prev,
        gateway: { status: 'success', message: t('runtime.status.gatewayRunning', { port: gatewayStatus.port }) },
      }));
    } else if (gatewayStatus.state === 'error') {
      setChecks((prev) => ({
        ...prev,
        gateway: { status: 'error', message: gatewayStatus.error || 'Failed to start' },
      }));
    } else if (gatewayStatus.state === 'starting' || gatewayStatus.state === 'reconnecting') {
      setChecks((prev) => ({
        ...prev,
        gateway: { status: 'checking', message: 'Starting...' },
      }));
    }
  }, [gatewayStatus, t]);

  // Gateway startup timeout
  useEffect(() => {
    if (gatewayTimeoutRef.current) {
      clearTimeout(gatewayTimeoutRef.current);
      gatewayTimeoutRef.current = null;
    }

    if (gatewayStatus.state === 'running' || gatewayStatus.state === 'error') return;

    gatewayTimeoutRef.current = setTimeout(() => {
      setChecks((prev) => {
        if (prev.gateway.status === 'checking') {
          return { ...prev, gateway: { status: 'error', message: 'Gateway startup timed out' } };
        }
        return prev;
      });
    }, 600 * 1000);

    return () => {
      if (gatewayTimeoutRef.current) {
        clearTimeout(gatewayTimeoutRef.current);
        gatewayTimeoutRef.current = null;
      }
    };
  }, [gatewayStatus.state]);

  const handleStartGateway = async () => {
    setChecks((prev) => ({ ...prev, gateway: { status: 'checking', message: 'Starting...' } }));
    await startGateway();
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

  const ERROR_TRUNCATE_LEN = 30;

  const renderStatus = (status: CheckStatus, message: string) => {
    if (status === 'pending') {
      return (
        <span className="flex items-center gap-2 text-slate-500 whitespace-nowrap">
          <div className="h-5 w-5 rounded-full border-2 border-slate-500 flex-shrink-0" />
          {message || t('runtime.status.pending')}
        </span>
      );
    }
    if (status === 'checking') {
      return (
        <span className="flex items-center gap-2 text-yellow-400 whitespace-nowrap">
          <Loader2 className="h-5 w-5 flex-shrink-0 animate-spin" />
          {message || t('runtime.status.checking')}
        </span>
      );
    }
    if (status === 'installing') {
      return (
        <span className="flex items-center gap-2 text-blue-400 whitespace-nowrap">
          <Download className="h-5 w-5 flex-shrink-0 animate-pulse" />
          {message || t('runtime.status.installing')}
        </span>
      );
    }
    if (status === 'success') {
      return (
        <span className="flex items-center gap-2 text-green-400 whitespace-nowrap">
          <CheckCircle2 className="h-5 w-5 flex-shrink-0" />
          {message}
        </span>
      );
    }
    if (status === 'warning') {
      const isLongW = message.length > ERROR_TRUNCATE_LEN;
      const displayMsgW = isLongW ? message.slice(0, ERROR_TRUNCATE_LEN) : message;
      return (
        <span className="flex items-center gap-2 text-yellow-400 whitespace-nowrap">
          <AlertCircle className="h-5 w-5 flex-shrink-0" />
          <span>{displayMsgW}</span>
          {isLongW && (
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="cursor-pointer text-yellow-300 hover:text-yellow-200 font-medium">...</span>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-sm whitespace-normal break-words text-xs">
                {message}
              </TooltipContent>
            </Tooltip>
          )}
        </span>
      );
    }

    const isLong = message.length > ERROR_TRUNCATE_LEN;
    const displayMsg = isLong ? message.slice(0, ERROR_TRUNCATE_LEN) : message;

    return (
      <span className="flex items-center gap-2 text-red-400 whitespace-nowrap">
        <XCircle className="h-5 w-5 flex-shrink-0" />
        <span>{displayMsg}</span>
        {isLong && (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="cursor-pointer text-red-300 hover:text-red-200 font-medium">...</span>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-sm whitespace-normal break-words text-xs">
              {message}
            </TooltipContent>
          </Tooltip>
        )}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-semibold">{t('runtime.title')}</h2>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={handleShowLogs}>
            {t('runtime.viewLogs')}
          </Button>
          <Button variant="ghost" size="sm" onClick={runChecks}>
            <RefreshCw className="h-4 w-4 mr-2" />
            {t('runtime.recheck')}
          </Button>
        </div>
      </div>
      <div className="space-y-3">
        {/* Node.js Runtime */}
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 p-3 rounded-lg bg-muted/50">
          <span className="text-left">{t('runtime.nodejs')}</span>
          <div className="flex justify-end">
            {renderStatus(checks.nodejs.status, checks.nodejs.message)}
          </div>
        </div>

        {/* CLI Tools Section */}
        <div className="rounded-lg bg-muted/50 overflow-hidden">
          <div className="p-3 border-b border-border/50">
            <div className="flex items-center justify-between">
              <div>
                <span className="font-medium">{t('runtime.cliTools')}</span>
                <p className="text-xs text-muted-foreground mt-0.5">{t('runtime.cliToolsDesc')}</p>
              </div>
              {cliTools.every((ct) => ct.status === 'success') && (
                <span className="flex items-center gap-1.5 text-green-400 text-sm">
                  <CheckCircle2 className="h-4 w-4" />
                  {t('runtime.status.allToolsReady')}
                </span>
              )}
            </div>
          </div>
          <div className="divide-y divide-border/30">
            {cliTools.map((tool) => (
              <div key={tool.command} className="grid grid-cols-[1fr_auto] items-center gap-4 px-3 py-2.5">
                <span className="text-left text-sm text-muted-foreground pl-2">{tool.name}</span>
                <div className="flex justify-end">
                  {renderStatus(tool.status, tool.message)}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Python 3.12 */}
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 p-3 rounded-lg bg-muted/50">
          <span className="text-left">{t('runtime.python')}</span>
          <div className="flex justify-end">
            {renderStatus(checks.python.status, checks.python.message)}
          </div>
        </div>

        {/* Build Tools (non-blocking) */}
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 p-3 rounded-lg bg-muted/50">
          <div className="text-left min-w-0">
            <span>{t('runtime.buildtools')}</span>
            <p className="text-xs text-muted-foreground mt-0.5">{t('runtime.buildtoolsDesc')}</p>
          </div>
          <div className="flex justify-end self-start mt-0.5">
            {renderStatus(checks.buildtools.status, checks.buildtools.message)}
          </div>
        </div>

        {/* OpenClaw Package */}
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 p-3 rounded-lg bg-muted/50">
          <div className="text-left min-w-0">
            <span>{t('runtime.openclaw')}</span>
            {openclawDir && (
              <p className="text-xs text-muted-foreground mt-0.5 font-mono break-all">{openclawDir}</p>
            )}
          </div>
          <div className="flex justify-end self-start mt-0.5">
            {renderStatus(checks.openclaw.status, checks.openclaw.message)}
          </div>
        </div>

        {/* Gateway Service */}
        <div className="grid grid-cols-[1fr_auto] items-center gap-4 p-3 rounded-lg bg-muted/50">
          <div className="flex items-center gap-2 text-left">
            <span>Gateway Service</span>
            {checks.gateway.status === 'error' && (
              <Button variant="outline" size="sm" onClick={handleStartGateway}>
                Start Gateway
              </Button>
            )}
          </div>
          <div className="flex justify-end">
            {renderStatus(checks.gateway.status, checks.gateway.message)}
          </div>
        </div>
      </div>

      {/* Error panels */}
      {checks.nodejs.status === 'error' && (
        <div className="mt-4 p-4 rounded-lg bg-red-900/20 border border-red-500/20">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-5 w-5 text-red-400 mt-0.5" />
            <div>
              <p className="font-medium text-red-400">{t('runtime.issue.nodeInstallFailed')}</p>
              <a
                href="#"
                onClick={(e) => {
                  e.preventDefault();
                  window.electron?.openExternal?.('https://nodejs.org');
                }}
                className="text-sm text-blue-400 hover:text-blue-300 mt-1 inline-flex items-center gap-1"
              >
                Download from nodejs.org <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          </div>
        </div>
      )}

      {checks.openclaw.status === 'error' && (
        <div className="mt-4 p-4 rounded-lg bg-red-900/20 border border-red-500/20">
          <div className="flex items-start gap-2">
            <AlertCircle className="h-5 w-5 text-red-400 mt-0.5" />
            <div>
              <p className="font-medium text-red-400">{t('runtime.issue.title')}</p>
              <p className="text-sm text-muted-foreground mt-1">{t('runtime.issue.desc')}</p>
            </div>
          </div>
        </div>
      )}

      {/* Log viewer panel */}
      {showLogs && (
        <div className="mt-4 p-4 rounded-lg bg-black/40 border border-border">
          <div className="flex items-center justify-between mb-2">
            <p className="font-medium text-foreground text-sm">Application Logs</p>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={handleOpenLogDir}>
                <ExternalLink className="h-3 w-3 mr-1" />
                Open Log Folder
              </Button>
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setShowLogs(false)}>
                Close
              </Button>
            </div>
          </div>
          <pre className="text-xs text-slate-300 bg-black/50 p-3 rounded max-h-60 overflow-auto whitespace-pre-wrap font-mono">
            {logContent || '(No logs available yet)'}
          </pre>
        </div>
      )}
    </div>
  );
}

interface ProviderContentProps {
  providers: ProviderTypeInfo[];
  selectedProvider: string | null;
  onSelectProvider: (id: string | null) => void;
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onConfiguredChange: (configured: boolean) => void;
}

function ProviderContent({
  providers,
  selectedProvider,
  onSelectProvider,
  apiKey,
  onApiKeyChange,
  onConfiguredChange,
}: ProviderContentProps) {
  const { t } = useTranslation(['setup', 'settings']);
  const [showKey, setShowKey] = useState(false);
  const [validating, setValidating] = useState(false);
  const [keyValid, setKeyValid] = useState<boolean | null>(null);
  const [selectedProviderConfigId, setSelectedProviderConfigId] = useState<string | null>(null);
  const [baseUrl, setBaseUrl] = useState('');
  const [modelId, setModelId] = useState('');
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const providerMenuRef = useRef<HTMLDivElement | null>(null);
  const [authMethod, setAuthMethod] = useState<'apikey' | 'oauth'>('apikey');
  const allModels = useModelsStore((s) => s.models);
  const fetchModels = useModelsStore((s) => s.fetchModels);

  const { triggerOAuthLogin } = useProviderStore();

  // OAuth-only providers (supportsOAuth but no API key) skip the toggle
  const selectedProviderDataEarly = providers.find((p) => p.id === selectedProvider);
  const isOAuthOnly = selectedProviderDataEarly?.supportsOAuth && !selectedProviderDataEarly?.requiresApiKey;
  const effectiveAuthMethod = isOAuthOnly ? 'oauth' : authMethod;

  // On mount, try to restore previously configured provider
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await window.electron.ipcRenderer.invoke('provider:list') as Array<{ id: string; type: string; hasKey: boolean }>;
        const defaultId = await window.electron.ipcRenderer.invoke('provider:getDefault') as string | null;
        const setupProviderTypes = new Set<string>(providers.map((p) => p.id));
        const setupCandidates = list.filter((p) => setupProviderTypes.has(p.type));
        const preferred =
          (defaultId && setupCandidates.find((p) => p.id === defaultId))
          || setupCandidates.find((p) => p.hasKey)
          || setupCandidates[0];
        if (preferred && !cancelled) {
          onSelectProvider(preferred.type);
          setSelectedProviderConfigId(preferred.id);
          const typeInfo = providers.find((p) => p.id === preferred.type);
          const requiresKey = typeInfo?.requiresApiKey ?? false;
          onConfiguredChange(!requiresKey || preferred.hasKey);
          const storedKey = await window.electron.ipcRenderer.invoke('provider:getApiKey', preferred.id) as string | null;
          if (storedKey) {
            onApiKeyChange(storedKey);
          }
        } else if (!cancelled) {
          onConfiguredChange(false);
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load provider list:', error);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [onApiKeyChange, onConfiguredChange, onSelectProvider, providers]);

  // When provider changes, load stored key + reset base URL
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedProvider) return;
      try {
        const list = await window.electron.ipcRenderer.invoke('provider:list') as Array<{ id: string; type: string; hasKey: boolean }>;
        const defaultId = await window.electron.ipcRenderer.invoke('provider:getDefault') as string | null;
        const sameType = list.filter((p) => p.type === selectedProvider);
        const preferredInstance =
          (defaultId && sameType.find((p) => p.id === defaultId))
          || sameType.find((p) => p.hasKey)
          || sameType[0];
        const providerIdForLoad = preferredInstance?.id || selectedProvider;
        setSelectedProviderConfigId(providerIdForLoad);

        const savedProvider = await window.electron.ipcRenderer.invoke(
          'provider:get',
          providerIdForLoad
        ) as { baseUrl?: string; model?: string } | null;
        const storedKey = await window.electron.ipcRenderer.invoke('provider:getApiKey', providerIdForLoad) as string | null;
        if (!cancelled) {
          if (storedKey) {
            onApiKeyChange(storedKey);
          }

          const info = providers.find((p) => p.id === selectedProvider);
          setBaseUrl(savedProvider?.baseUrl || info?.defaultBaseUrl || '');
          setModelId(savedProvider?.model || info?.defaultModelId || '');
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load provider key:', error);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [onApiKeyChange, selectedProvider, providers]);

  useEffect(() => {
    if (!providerMenuOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      if (providerMenuRef.current && !providerMenuRef.current.contains(event.target as Node)) {
        setProviderMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProviderMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [providerMenuOpen]);

  // Fetch models from Gateway
  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const selectedProviderData = providers.find((p) => p.id === selectedProvider);
  const selectedProviderIconUrl = selectedProviderData
    ? getProviderIconUrl(selectedProviderData.id)
    : undefined;
  const showBaseUrlField = selectedProviderData?.showBaseUrl ?? false;
  const showModelIdField = selectedProviderData?.showModelId ?? false;
  const requiresKey = selectedProviderData?.requiresApiKey ?? false;

  // Models from Gateway for the selected provider
  const providerModels = useMemo(
    () => allModels.filter((m) => m.provider === selectedProvider),
    [allModels, selectedProvider],
  );

  const modelOptions = useMemo(() => {
    const result = providerModels.map((m) => ({ id: m.id, name: m.name || m.id }));
    if (modelId && !result.some((m) => m.id === modelId)) {
      result.unshift({ id: modelId, name: modelId });
    }
    return result;
  }, [providerModels, modelId]);

  const handleValidateAndSave = async () => {
    if (!selectedProvider) return;

    setValidating(true);
    setKeyValid(null);

    try {
      // OAuth: oauth2 flow (Anthropic, Google, OpenAI Codex)
      if (effectiveAuthMethod === 'oauth' && selectedProviderData?.oauthType === 'oauth2') {
        const result = await triggerOAuthLogin(selectedProvider);
        if (!result.success) {
          setKeyValid(false);
          toast.error(result.error || t('provider.invalid'));
          setValidating(false);
          return;
        }
        // Save provider config without API key, set as default
        const providerIdForSave = selectedProvider;
        const oauth2ModelId = modelId.trim() || selectedProviderData?.defaultModelId || undefined;
        const saveResult = await window.electron.ipcRenderer.invoke(
          'provider:save',
          {
            id: providerIdForSave,
            name: selectedProviderData?.name || selectedProvider,
            type: selectedProvider,
            model: oauth2ModelId,
            enabled: true,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }
        ) as { success: boolean; error?: string };

        if (!saveResult.success) {
          throw new Error(saveResult.error || 'Failed to save provider config');
        }

        await window.electron.ipcRenderer.invoke('provider:setDefault', providerIdForSave);
        setSelectedProviderConfigId(providerIdForSave);
        setKeyValid(true);
        onConfiguredChange(true);
        toast.success(t('provider.oauthConfigured'));
        setValidating(false);
        return;
      }

      // API key flow (existing logic)
      if (requiresKey && apiKey) {
        const result = await window.electron.ipcRenderer.invoke(
          'provider:validateKey',
          selectedProviderConfigId || selectedProvider,
          apiKey,
          { baseUrl: baseUrl.trim() || undefined }
        ) as { valid: boolean; error?: string };

        setKeyValid(result.valid);

        if (!result.valid) {
          toast.error(result.error || t('provider.invalid'));
          setValidating(false);
          return;
        }
      } else {
        setKeyValid(true);
      }

      const effectiveModelId =
        modelId.trim() ||
        selectedProviderData?.defaultModelId ||
        undefined;

      const providerIdForSave =
        selectedProvider === 'custom'
          ? (selectedProviderConfigId?.startsWith('custom-')
            ? selectedProviderConfigId
            : `custom-${crypto.randomUUID()}`)
          : selectedProvider;

      // Save provider config + API key, then set as default
      const saveResult = await window.electron.ipcRenderer.invoke(
        'provider:save',
        {
          id: providerIdForSave,
          name: selectedProvider === 'custom' ? t('settings:aiProviders.custom') : (selectedProviderData?.name || selectedProvider),
          type: selectedProvider,
          baseUrl: baseUrl.trim() || undefined,
          model: effectiveModelId,
          enabled: true,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        apiKey || undefined
      ) as { success: boolean; error?: string };

      if (!saveResult.success) {
        throw new Error(saveResult.error || 'Failed to save provider config');
      }

      const defaultResult = await window.electron.ipcRenderer.invoke(
        'provider:setDefault',
        providerIdForSave
      ) as { success: boolean; error?: string };

      if (!defaultResult.success) {
        throw new Error(defaultResult.error || 'Failed to set default provider');
      }

      setSelectedProviderConfigId(providerIdForSave);
      onConfiguredChange(true);
      toast.success(t('provider.valid'));
    } catch (error) {
      setKeyValid(false);
      onConfiguredChange(false);
      toast.error('Configuration failed: ' + String(error));
    } finally {
      setValidating(false);
    }
  };

  // Can the user submit?
  const canSubmit =
    selectedProvider
    && (effectiveAuthMethod === 'oauth'
      ? true
      : (requiresKey ? apiKey.length > 0 : true)
        && (showModelIdField ? modelId.trim().length > 0 : true));

  const handleSelectProvider = (providerId: string) => {
    onSelectProvider(providerId);
    setSelectedProviderConfigId(null);
    onConfiguredChange(false);
    onApiKeyChange('');
    setKeyValid(null);
    setProviderMenuOpen(false);
    setAuthMethod('apikey');
  };

  return (
    <div className="space-y-6">
      {/* Provider selector — dropdown */}
      <div className="space-y-2">
        <Label>{t('provider.label')}</Label>
        <div className="relative" ref={providerMenuRef}>
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={providerMenuOpen}
            onClick={() => setProviderMenuOpen((open) => !open)}
            className={cn(
              'w-full rounded-md border border-input bg-background px-3 py-2 text-sm',
              'flex items-center justify-between gap-2',
              'focus:outline-none focus:ring-2 focus:ring-ring'
            )}
          >
            <div className="flex items-center gap-2 min-w-0">
              {selectedProvider && selectedProviderData ? (
                selectedProviderIconUrl ? (
                  <img
                    src={selectedProviderIconUrl}
                    alt={selectedProviderData.name}
                    className={cn('h-4 w-4 shrink-0', shouldInvertInDark(selectedProviderData.id) && 'dark:invert')}
                  />
                ) : (
                  <span className="text-sm leading-none shrink-0">{selectedProviderData.icon}</span>
                )
              ) : (
                <span className="text-xs text-muted-foreground shrink-0">—</span>
              )}
              <span className={cn('truncate text-left', !selectedProvider && 'text-muted-foreground')}>
                {selectedProviderData
                  ? `${selectedProviderData.id === 'custom' ? t('settings:aiProviders.custom') : selectedProviderData.name}${selectedProviderData.model ? ` — ${selectedProviderData.model}` : ''}`
                  : t('provider.selectPlaceholder')}
              </span>
            </div>
            <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform', providerMenuOpen && 'rotate-180')} />
          </button>

          {providerMenuOpen && (
            <div
              role="listbox"
              className="absolute z-20 mt-1 w-full rounded-md border border-border bg-popover shadow-md max-h-64 overflow-auto"
            >
              {providers.map((p) => {
                const iconUrl = getProviderIconUrl(p.id);
                const isSelected = selectedProvider === p.id;

                return (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    onClick={() => handleSelectProvider(p.id)}
                    className={cn(
                      'w-full px-3 py-2 text-left text-sm flex items-center justify-between gap-2',
                      'hover:bg-accent transition-colors',
                      isSelected && 'bg-accent/60'
                    )}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      {iconUrl ? (
                        <img
                          src={iconUrl}
                          alt={p.name}
                          className={cn('h-4 w-4 shrink-0', shouldInvertInDark(p.id) && 'dark:invert')}
                        />
                      ) : (
                        <span className="text-sm leading-none shrink-0">{p.icon}</span>
                      )}
                      <span className="truncate">{p.id === 'custom' ? t('settings:aiProviders.custom') : p.name}{p.model ? ` — ${p.model}` : ''}</span>
                    </div>
                    {isSelected && <Check className="h-4 w-4 text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Dynamic config fields based on selected provider */}
      {selectedProvider && (
        <motion.div
          key={selectedProvider}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          className="space-y-4"
        >
          {/* Auth method toggle for OAuth-capable providers (hidden for OAuth-only) */}
          {selectedProviderData?.supportsOAuth && selectedProviderData?.requiresApiKey && (
            <div className="space-y-2">
              <Label>{t('provider.authMethod')}</Label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod('apikey');
                    setKeyValid(null);
                    onConfiguredChange(false);
                  }}
                  className={cn(
                    'flex items-center gap-2 p-3 rounded-lg border text-sm transition-colors',
                    effectiveAuthMethod === 'apikey'
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border hover:bg-accent text-muted-foreground'
                  )}
                >
                  <Key className="h-4 w-4" />
                  {t('provider.authApiKey')}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setAuthMethod('oauth');
                    setKeyValid(null);
                    onConfiguredChange(false);
                  }}
                  className={cn(
                    'flex items-center gap-2 p-3 rounded-lg border text-sm transition-colors',
                    effectiveAuthMethod === 'oauth'
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border hover:bg-accent text-muted-foreground'
                  )}
                >
                  <LogIn className="h-4 w-4" />
                  {selectedProvider === 'anthropic'
                    ? t('provider.signInWithClaude')
                    : selectedProvider === 'openai-codex'
                      ? t('provider.signInWithChatGPT')
                      : t('provider.signInWithGoogle')}
                </button>
              </div>
            </div>
          )}

          {/* OAuth: OAuth2 flow (Anthropic, Google, OpenAI Codex) */}
          {effectiveAuthMethod === 'oauth' && selectedProviderData?.oauthType === 'oauth2' && (
            <div className="space-y-3">
              {validating ? (
                <div className="flex items-center gap-3 p-4 rounded-lg bg-muted/50">
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                  <span className="text-sm text-muted-foreground">
                    {t('provider.waitingAuth')}
                  </span>
                </div>
              ) : null}
            </div>
          )}

          {/* API key flow fields (existing) */}
          {effectiveAuthMethod === 'apikey' && (
            <>
              {/* Base URL field (for siliconflow, ollama, custom) */}
              {showBaseUrlField && (
                <div className="space-y-2">
                  <Label htmlFor="baseUrl">{t('provider.baseUrl')}</Label>
                  <Input
                    id="baseUrl"
                    type="text"
                    placeholder="https://api.example.com/v1"
                    value={baseUrl}
                    onChange={(e) => {
                      setBaseUrl(e.target.value);
                      onConfiguredChange(false);
                    }}
                    autoComplete="off"
                    className="bg-background border-input"
                  />
                </div>
              )}

              {/* API Key field (hidden for ollama) */}
              {requiresKey && (
                <div className="space-y-2">
                  <Label htmlFor="apiKey">{t('provider.apiKey')}</Label>
                  <div className="relative">
                    <Input
                      id="apiKey"
                      type={showKey ? 'text' : 'password'}
                      placeholder={selectedProviderData?.placeholder}
                      value={apiKey}
                      onChange={(e) => {
                        onApiKeyChange(e.target.value);
                        onConfiguredChange(false);
                        setKeyValid(null);
                      }}
                      autoComplete="off"
                      className="pr-10 bg-background border-input"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey(!showKey)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      {showKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {/* Model selector — shown for all providers */}
          {(showModelIdField || selectedProviderData?.defaultModelId) && (
            <div className="space-y-2">
              <Label htmlFor="modelId">
                {showModelIdField ? t('provider.modelId') : t('provider.defaultModel')}
              </Label>
              {showModelIdField ? (
                <>
                  <Input
                    id="modelId"
                    list={`setup-model-list-${selectedProvider}`}
                    type="text"
                    placeholder={selectedProviderData?.modelIdPlaceholder || 'e.g. deepseek-ai/DeepSeek-V3'}
                    value={modelId}
                    onChange={(e) => {
                      setModelId(e.target.value);
                      onConfiguredChange(false);
                    }}
                    autoComplete="off"
                    className="bg-background border-input"
                  />
                  {providerModels.length > 0 && (
                    <datalist id={`setup-model-list-${selectedProvider}`}>
                      {providerModels.map((m) => (
                        <option key={m.id} value={m.id}>{m.name || m.id}</option>
                      ))}
                    </datalist>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t('provider.modelIdDesc')}
                  </p>
                </>
              ) : (
                <select
                  id="modelId"
                  value={modelId}
                  onChange={(e) => {
                    setModelId(e.target.value);
                    onConfiguredChange(false);
                  }}
                  className={cn(
                    'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                  )}
                >
                  {modelOptions.length === 0 && (
                    <option value={modelId || ''}>{modelId || 'Loading models...'}</option>
                  )}
                  {modelOptions.map((m) => (
                    <option key={m.id} value={m.id}>{m.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* Validate & Save */}
          <Button
            onClick={handleValidateAndSave}
            disabled={!canSubmit || validating}
            className="w-full"
          >
            {validating ? (
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
            ) : null}
            {effectiveAuthMethod === 'oauth'
              ? (selectedProvider === 'anthropic'
                ? t('provider.signInWithClaude')
                : selectedProvider === 'openai-codex'
                  ? t('provider.signInWithChatGPT')
                  : t('provider.signInWithGoogle'))
              : requiresKey ? t('provider.validateSave') : t('provider.save')}
          </Button>

          {keyValid !== null && (
            <p className={cn('text-sm text-center', keyValid ? 'text-green-400' : 'text-red-400')}>
              {keyValid ? `✓ ${t('provider.valid')}` : `✗ ${t('provider.invalid')}`}
            </p>
          )}

          <p className="text-sm text-muted-foreground text-center">
            {t('provider.storedLocally')}
          </p>
        </motion.div>
      )}
    </div>
  );
}

// ==================== Setup Channel Content ====================

function SetupChannelContent() {
  const { t } = useTranslation(['setup', 'channels']);
  const [selectedChannel, setSelectedChannel] = useState<ChannelType | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const meta: ChannelMeta | null = selectedChannel ? CHANNEL_META[selectedChannel] : null;
  const primaryChannels = getPrimaryChannels();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selectedChannel) return;
      try {
        const result = await window.electron.ipcRenderer.invoke(
          'channel:getFormValues',
          selectedChannel
        ) as { success: boolean; values?: Record<string, string> };
        if (cancelled) return;
        if (result.success && result.values) {
          setConfigValues(result.values);
        } else {
          setConfigValues({});
        }
      } catch {
        if (!cancelled) {
          setConfigValues({});
        }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedChannel]);

  const isFormValid = () => {
    if (!meta) return false;
    return meta.configFields
      .filter((f: ChannelConfigField) => f.required)
      .every((f: ChannelConfigField) => configValues[f.key]?.trim());
  };

  const handleSave = async () => {
    if (!selectedChannel || !meta || !isFormValid()) return;

    setSaving(true);
    setValidationError(null);

    try {
      // Validate credentials first
      const validation = await window.electron.ipcRenderer.invoke(
        'channel:validateCredentials',
        selectedChannel,
        configValues
      ) as { success: boolean; valid?: boolean; errors?: string[]; details?: Record<string, string> };

      if (!validation.valid) {
        setValidationError((validation.errors || ['Validation failed']).join(', '));
        setSaving(false);
        return;
      }

      // Save config
      await window.electron.ipcRenderer.invoke('channel:saveConfig', selectedChannel, { ...configValues });

      const botName = validation.details?.botUsername ? ` (@${validation.details.botUsername})` : '';
      toast.success(`${meta.name} configured${botName}`);
      setSaved(true);
    } catch (error) {
      setValidationError(String(error));
    } finally {
      setSaving(false);
    }
  };

  // Already saved — show success
  if (saved) {
    return (
      <div className="text-center space-y-4">
        <div className="text-5xl">✅</div>
        <h2 className="text-xl font-semibold">
          {t('channel.connected', { name: meta?.name || 'Channel' })}
        </h2>
        <p className="text-muted-foreground">
          {t('channel.connectedDesc')}
        </p>
        <Button
          variant="ghost"
          className="text-muted-foreground"
          onClick={() => {
            setSaved(false);
            setSelectedChannel(null);
            setConfigValues({});
          }}
        >
          {t('channel.configureAnother')}
        </Button>
      </div>
    );
  }

  // Channel type not selected — show picker
  if (!selectedChannel) {
    return (
      <div className="space-y-4">
        <div className="text-center mb-2">
          <div className="text-4xl mb-3">📡</div>
          <h2 className="text-xl font-semibold">{t('channel.title')}</h2>
          <p className="text-muted-foreground text-sm mt-1">
            {t('channel.subtitle')}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {primaryChannels.map((type) => {
            const channelMeta = CHANNEL_META[type];
            if (channelMeta.connectionType !== 'token') return null;
            return (
              <button
                key={type}
                onClick={() => setSelectedChannel(type)}
                className="p-4 rounded-lg bg-muted/50 hover:bg-muted transition-all text-left"
              >
                <ChannelIcon type={channelMeta.id} size="lg" />
                <p className="font-medium mt-2">{channelMeta.name}</p>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                  {t(channelMeta.description)}
                </p>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  // Channel selected — show config form
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 mb-2">
        <button
          onClick={() => { setSelectedChannel(null); setConfigValues({}); setValidationError(null); }}
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div>
          <h2 className="text-xl font-semibold flex items-center gap-2">
            <span>{meta?.icon}</span> {t('channel.configure', { name: meta?.name })}
          </h2>
          <p className="text-muted-foreground text-sm mt-1">{t(meta?.description || '')}</p>
        </div>
      </div>

      {/* Instructions */}
      <div className="p-3 rounded-lg bg-muted/50 text-sm">
        <div className="flex items-center justify-between mb-2">
          <p className="font-medium text-foreground">{t('channel.howTo')}</p>
          {meta?.docsUrl && (
            <button
              onClick={() => {
                try {
                  const url = t(meta.docsUrl!);
                  if (window.electron?.openExternal) {
                    window.electron.openExternal(url);
                  } else {
                    window.open(url, '_blank');
                  }
                } catch {
                  // ignore
                }
              }}
              className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              <BookOpen className="h-3 w-3" />
              {t('channel.viewDocs')}
              <ExternalLink className="h-3 w-3" />
            </button>
          )}
        </div>
        <ol className="list-decimal list-inside text-muted-foreground space-y-1">
          {meta?.instructions.map((inst, i) => (
            <li key={i}>{t(inst)}</li>
          ))}
        </ol>
      </div>

      {/* Config fields */}
      {meta?.configFields.map((field: ChannelConfigField) => {
        const isPassword = field.type === 'password';
        return (
          <div key={field.key} className="space-y-1.5">
            <Label htmlFor={`setup-${field.key}`} className="text-foreground">
              {t(field.label)}
              {field.required && <span className="text-red-400 ml-1">*</span>}
            </Label>
            <div className="flex gap-2">
              <Input
                id={`setup-${field.key}`}
                type={isPassword && !showSecrets[field.key] ? 'password' : 'text'}
                placeholder={field.placeholder ? t(field.placeholder) : undefined}
                value={configValues[field.key] || ''}
                onChange={(e) => setConfigValues((prev) => ({ ...prev, [field.key]: e.target.value }))}
                autoComplete="off"
                className="font-mono text-sm bg-background border-input"
              />
              {isPassword && (
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="shrink-0"
                  onClick={() => setShowSecrets((prev) => ({ ...prev, [field.key]: !prev[field.key] }))}
                >
                  {showSecrets[field.key] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </Button>
              )}
            </div>
            {field.description && (
              <p className="text-xs text-slate-500 mt-1">{t(field.description)}</p>
            )}
          </div>
        );
      })}

      {/* Validation error */}
      {validationError && (
        <div className="p-3 rounded-lg bg-red-900/30 border border-red-500/30 text-sm text-red-300 flex items-start gap-2">
          <XCircle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>{validationError}</span>
        </div>
      )}

      {/* Save button */}
      <Button
        className="w-full"
        onClick={handleSave}
        disabled={!isFormValid() || saving}
      >
        {saving ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            {t('provider.validateSave')}
          </>
        ) : (
          <>
            <Check className="h-4 w-4 mr-2" />
            {t('provider.validateSave')}
          </>
        )}
      </Button>
    </div>
  );
}

// NOTE: SkillsContent component removed - auto-install essential skills

// Installation status for each skill
type InstallStatus = 'pending' | 'installing' | 'completed' | 'failed';

interface SkillInstallState {
  id: string;
  name: string;
  description: string;
  status: InstallStatus;
}

interface InstallingContentProps {
  skills: DefaultSkill[];
  onComplete: (installedSkills: string[]) => void;
  onSkip: () => void;
}

function InstallingContent({ skills, onComplete, onSkip }: InstallingContentProps) {
  const { t } = useTranslation('setup');
  const [skillStates, setSkillStates] = useState<SkillInstallState[]>(
    skills.map((s) => ({ ...s, status: 'pending' as InstallStatus }))
  );
  const [overallProgress, setOverallProgress] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const installStarted = useRef(false);

  // Real installation process
  useEffect(() => {
    if (installStarted.current) return;
    installStarted.current = true;

    const runRealInstall = async () => {
      try {
        // Step 1: Initialize all skills to 'installing' state for UI
        setSkillStates(prev => prev.map(s => ({ ...s, status: 'installing' })));
        setOverallProgress(10);

        // Step 2: Call the backend to install uv and setup Python
        const result = await window.electron.ipcRenderer.invoke('uv:install-all') as {
          success: boolean;
          error?: string
        };

        if (!result.success) {
          throw new Error(result.error || 'Python setup failed');
        }
        setOverallProgress(50);

        // Step 3: Symlink Python into managed Node.js bin dir
        try {
          await window.electron.ipcRenderer.invoke('path:symlinkPython');
        } catch {
          // Non-fatal — Python will still work via uv
        }
        setOverallProgress(70);

        // Step 4: Persist managed bin dir to system PATH
        try {
          await window.electron.ipcRenderer.invoke('path:persist');
        } catch {
          // Non-fatal — gateway already injects managed bin into its own PATH
        }
        setOverallProgress(90);

        // Done
        setSkillStates(prev => prev.map(s => ({ ...s, status: 'completed' })));
        setOverallProgress(100);

        await new Promise((resolve) => setTimeout(resolve, 800));
        onComplete(skills.map(s => s.id));
      } catch (err) {
        setSkillStates(prev => prev.map(s => ({ ...s, status: 'failed' })));
        setErrorMessage(String(err));
        toast.error('Installation error');
      }
    };

    runRealInstall();
  }, [skills, onComplete]);

  const getStatusIcon = (status: InstallStatus) => {
    switch (status) {
      case 'pending':
        return <div className="h-5 w-5 rounded-full border-2 border-slate-500" />;
      case 'installing':
        return <Loader2 className="h-5 w-5 text-primary animate-spin" />;
      case 'completed':
        return <CheckCircle2 className="h-5 w-5 text-green-400" />;
      case 'failed':
        return <XCircle className="h-5 w-5 text-red-400" />;
    }
  };

  const getStatusText = (skill: SkillInstallState) => {
    switch (skill.status) {
      case 'pending':
        return <span className="text-muted-foreground">{t('installing.status.pending')}</span>;
      case 'installing':
        return <span className="text-primary">{t('installing.status.installing')}</span>;
      case 'completed':
        return <span className="text-green-400">{t('installing.status.installed')}</span>;
      case 'failed':
        return <span className="text-red-400">{t('installing.status.failed')}</span>;
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="text-4xl mb-4">⚙️</div>
        <h2 className="text-xl font-semibold mb-2">{t('installing.title')}</h2>
        <p className="text-muted-foreground">
          {t('installing.subtitle')}
        </p>
      </div>

      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t('installing.progress')}</span>
          <span className="text-primary">{overallProgress}%</span>
        </div>
        <div className="h-2 bg-secondary rounded-full overflow-hidden">
          <motion.div
            className="h-full bg-primary"
            initial={{ width: 0 }}
            animate={{ width: `${overallProgress}%` }}
            transition={{ duration: 0.3 }}
          />
        </div>
      </div>

      {/* Skill list */}
      <div className="space-y-2 max-h-48 overflow-y-auto">
        {skillStates.map((skill) => (
          <motion.div
            key={skill.id}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className={cn(
              'flex items-center justify-between p-3 rounded-lg',
              skill.status === 'installing' ? 'bg-muted' : 'bg-muted/50'
            )}
          >
            <div className="flex items-center gap-3">
              {getStatusIcon(skill.status)}
              <div>
                <p className="font-medium">{skill.name}</p>
                <p className="text-xs text-muted-foreground">{skill.description}</p>
              </div>
            </div>
            {getStatusText(skill)}
          </motion.div>
        ))}
      </div>

      {/* Error Message Display */}
      {errorMessage && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="p-4 rounded-lg bg-red-900/30 border border-red-500/50 text-red-200 text-sm"
        >
          <div className="flex items-start gap-2">
            <AlertCircle className="h-5 w-5 text-red-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">{t('installing.error')}</p>
              <pre className="text-xs bg-black/30 p-2 rounded overflow-x-auto whitespace-pre-wrap font-monospace">
                {errorMessage}
              </pre>
              <Button
                variant="link"
                className="text-red-400 p-0 h-auto text-xs underline"
                onClick={() => window.location.reload()}
              >
                {t('installing.restart')}
              </Button>
            </div>
          </div>
        </motion.div>
      )}

      {!errorMessage && (
        <p className="text-sm text-slate-400 text-center">
          {t('installing.wait')}
        </p>
      )}
      <div className="flex justify-end">
        <Button
          variant="ghost"
          className="text-muted-foreground"
          onClick={onSkip}
        >
          {t('installing.skip')}
        </Button>
      </div>
    </div>
  );
}
interface CompleteContentProps {
  selectedProvider: string | null;
  installedSkills: string[];
}

function CompleteContent({ selectedProvider, installedSkills }: CompleteContentProps) {
  const { t } = useTranslation(['setup', 'settings']);
  const gatewayStatus = useGatewayStore((state) => state.status);

  const providerData = providers.find((p) => p.id === selectedProvider);
  const installedSkillNames = defaultSkills
    .filter((s) => installedSkills.includes(s.id))
    .map((s) => s.name)
    .join(', ');

  return (
    <div className="text-center space-y-6">
      <div className="text-6xl mb-4">🎉</div>
      <h2 className="text-xl font-semibold">{t('complete.title')}</h2>
      <p className="text-muted-foreground">
        {t('complete.subtitle')}
      </p>

      <div className="space-y-3 text-left max-w-md mx-auto">
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
          <span>{t('complete.provider')}</span>
          <span className="text-green-400">
            {providerData ? <span className="flex items-center gap-1.5">{getProviderIconUrl(providerData.id) ? <img src={getProviderIconUrl(providerData.id)} alt={providerData.name} className={`h-4 w-4 inline-block ${shouldInvertInDark(providerData.id) ? 'dark:invert' : ''}`} /> : providerData.icon} {providerData.id === 'custom' ? t('settings:aiProviders.custom') : providerData.name}</span> : '—'}
          </span>
        </div>
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
          <span>{t('complete.components')}</span>
          <span className="text-green-400">
            {installedSkillNames || `${installedSkills.length} ${t('installing.status.installed')}`}
          </span>
        </div>
        <div className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
          <span>{t('complete.gateway')}</span>
          <span className={gatewayStatus.state === 'running' ? 'text-green-400' : 'text-yellow-400'}>
            {gatewayStatus.state === 'running' ? `✓ ${t('complete.running')}` : gatewayStatus.state}
          </span>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {t('complete.footer')}
      </p>
    </div>
  );
}

export default Setup;
