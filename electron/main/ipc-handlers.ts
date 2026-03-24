/**
 * IPC Handlers
 * Registers all IPC handlers for main-renderer communication
 */
import { ipcMain, BrowserWindow, shell, dialog, app, nativeImage } from 'electron';
import { existsSync, copyFileSync, cpSync, statSync, readFileSync, readdirSync, writeFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, watch, type FSWatcher } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, extname, basename, dirname, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import { openExternalInDefaultProfile } from '../utils/open-external';
import { browserManager } from '../browser/manager';
import { automationViews } from '../browser/automation-views';
import { webauthViews } from '../browser/webauth-views';
import {
  getCookies, removeCookie, clearPartition, exportCookies, importCookies,
  type CookieData,
} from '../browser/cookie-manager';
import { GatewayManager } from '../gateway/manager';
import { ClawHubService, ClawHubSearchParams, ClawHubInstallParams, ClawHubUninstallParams } from '../gateway/clawhub';
import {
  storeApiKey,
  getApiKey,
  deleteApiKey,
  hasApiKey,
  saveProvider,
  getProvider,
  deleteProvider,
  setDefaultProvider,
  getDefaultProvider,
  getAllProviders,
  getAllProvidersWithKeyInfo,
  type ProviderConfig,
} from '../utils/secure-storage';
import { getOpenClawStatus, getOpenClawDir, getOpenClawConfigDir, getOpenClawSkillsDir, ensureDir } from '../utils/paths';
import { getOpenClawCliCommand, installOpenClawCliMac } from '../utils/openclaw-cli';
import { getSetting, setSetting } from '../utils/store';
import { setAutoStart } from '../utils/autostart';
import {
  saveProviderKeyToOpenClaw,
  removeProviderKeyFromOpenClaw,
  removeProviderFromOpenClawConfig,
  setOpenClawDefaultModel,
  setOpenClawDefaultModelWithOverride,
} from '../utils/openclaw-auth';
import { logger } from '../utils/logger';
import {
  saveChannelConfig,
  getChannelConfig,
  getChannelFormValues,
  deleteChannelConfig,
  listConfiguredChannels,
  setChannelEnabled,
  validateChannelConfig,
  validateChannelCredentials,
  saveAccountConfig,
  deleteAccountConfig,
  getAccountFormValues,
  listChannelAccounts,
  getBindings,
  setBinding,
  removeBinding,
  getChannelEnabledMap,
} from '../utils/channel-config';
import { checkUvInstalled, installUv, setupManagedPython } from '../utils/uv-setup';
import {
  getNodeStatus,
  installManagedNode,
  checkAllCliTools,
  installAllCliTools,
  installSingleCliTool,
  getManagedBinDirPath,
  isManagedBinInPath,
  persistManagedBinToPath,
  symlinkPythonToManagedBin,
  type NodeStatus,
  type CliToolStatus,
} from '../utils/nodejs-setup';
import { getPythonBinDir } from '../utils/uv-setup';
import { checkBuildTools, installBuildTools, type BuildToolsStatus, type BuildToolsInstallResult } from '../utils/build-tools';
import { updateSkillConfig, getSkillConfig, getAllSkillConfigs } from '../utils/skill-config';
import {
  getAgentList,
  getAgentDefaults,
  getAgent,
  saveAgent,
  deleteAgent,
  getAgentWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
  createWorkspaceDir,
  listChannelTypes,
  listOpenclawFolders,
  createOpenclawFolder,
  getOpenclawDirPath,
  listDirectoryContents,
  readAnyFile,
  writeAnyFile,
  setToolsAutoApprove as setToolsAutoApproveConfig,
  getToolsAutoApproveFromConfig,
  setSessionDmScope as setSessionDmScopeConfig,
  getSessionDmScopeFromConfig,
  setScreenshotMaxSide as setScreenshotMaxSideConfig,
  getScreenshotMaxSideFromConfig,
  setUseBuiltinBrowser as setUseBuiltinBrowserConfig,
  getUseBuiltinBrowserFromConfig,
} from '../utils/agent-config';
import { whatsAppLoginManager } from '../utils/whatsapp-login';
import { zaloUserLoginManager } from '../utils/zalouser-login';
import { exportConfigBundle, importConfigBundle, validateConfigBundle } from '../utils/config-bundle';
import { getProviderConfig, getProviderDefaultModel } from '../utils/provider-registry';
import { installExtension, getExtensionStatus, updateExtensionConfig, getExtensionInstallDir } from '../utils/browser-extension';
import AdmZip from 'adm-zip';
import * as tar from 'tar';
import { triggerManager } from '../automation/trigger-manager';
import { automationEventBus } from '../automation/event-bus';
import type { EventTriggerCreateInput, EventTriggerUpdateInput } from '../automation/types';
import { workflowStore } from '../automation/workflow-store';
import { workflowExecutor } from '../automation/workflow-executor';
import type { WorkflowCreateInput, WorkflowUpdateInput } from '../automation/workflow-types';
import { webhookStore } from '../automation/webhook-store';
import { httpServer } from '../automation/http-server';
import type { HttpServerConfig } from '../automation/webhook-types';

/**
 * Register all IPC handlers
 */
export function registerIpcHandlers(
  gatewayManager: GatewayManager,
  clawHubService: ClawHubService,
  mainWindow: BrowserWindow
): void {
  // Gateway handlers
  registerGatewayHandlers(gatewayManager, mainWindow);

  // ClawHub handlers
  registerClawHubHandlers(clawHubService);

  // OpenClaw handlers
  registerOpenClawHandlers();

  // Provider handlers
  registerProviderHandlers(gatewayManager);

  // Shell handlers
  registerShellHandlers();

  // Dialog handlers
  registerDialogHandlers();

  // App handlers
  registerAppHandlers(gatewayManager);

  // UV handlers
  registerUvHandlers();

  // Node.js & CLI tools handlers
  registerNodejsHandlers();

  // PATH persistence, Python symlink, and build tools handlers
  registerPathHandlers();

  // Log handlers (for UI to read gateway/app logs)
  registerLogHandlers();

  // Skill config handlers (direct file access, no Gateway RPC)
  registerSkillConfigHandlers();

  // Cron task handlers (proxy to Gateway RPC)
  registerCronHandlers(gatewayManager);

  // Window control handlers (for custom title bar on Windows/Linux)
  registerWindowHandlers(mainWindow);

  // WhatsApp handlers
  registerWhatsAppHandlers(mainWindow);

  // Zalo Personal handlers
  registerZaloUserHandlers(mainWindow);

  // Agent config handlers (direct file access)
  registerAgentHandlers();

  // File staging handlers (upload/send separation)
  registerFileHandlers();

  // Config bundle export/import handlers
  registerConfigBundleHandlers();

  // Workspace archive export/import handlers
  registerWorkspaceArchiveHandlers();

  // Skill import handler (extract zip/tar.gz to ~/.openclaw/skills/ and enable)
  registerSkillImportHandler(gatewayManager);

  // Browser extension handlers
  registerBrowserExtensionHandlers(gatewayManager);

  // Automation / event trigger handlers
  registerAutomationHandlers(gatewayManager);

  // Workflow / task chaining handlers
  registerWorkflowHandlers(gatewayManager);

  // Webhook / HTTP API handlers
  registerWebhookHandlers(gatewayManager);

  // Built-in browser handlers
  registerBuiltinBrowserHandlers(mainWindow);

  // WebAuth browser handlers (independent from Chat browser)
  registerWebAuthBrowserHandlers(mainWindow);

  // WebAuth provider handlers
  registerWebAuthHandlers();
}

/**
 * Skill config IPC handlers
 * Direct read/write to ~/.openclaw/openclaw.json (bypasses Gateway RPC)
 */
function registerSkillConfigHandlers(): void {
  // Update skill config (apiKey and env)
  ipcMain.handle('skill:updateConfig', async (_, params: {
    skillKey: string;
    apiKey?: string;
    env?: Record<string, string>;
  }) => {
    return updateSkillConfig(params.skillKey, {
      apiKey: params.apiKey,
      env: params.env,
    });
  });

  // Get skill config
  ipcMain.handle('skill:getConfig', async (_, skillKey: string) => {
    return getSkillConfig(skillKey);
  });

  // Get all skill configs
  ipcMain.handle('skill:getAllConfigs', async () => {
    return getAllSkillConfigs();
  });
}

/**
 * Agent config IPC handlers
 * Direct read/write to ~/.openclaw/openclaw.json and workspace files
 */
function registerAgentHandlers(): void {
  // List all agents + defaults
  ipcMain.handle('agent:list', async () => {
    try {
      const list = getAgentList();
      const defaults = getAgentDefaults();
      return { success: true, agents: list, defaults };
    } catch (error) {
      console.error('Failed to list agents:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get a single agent by id
  ipcMain.handle('agent:get', async (_, id: string) => {
    try {
      const agent = getAgent(id);
      return { success: true, agent };
    } catch (error) {
      console.error('Failed to get agent:', error);
      return { success: false, error: String(error) };
    }
  });

  // Create a new agent (config + workspace scaffold)
  ipcMain.handle('agent:create', async (_, params: {
    id: string;
    name: string;
    emoji?: string;
    workspace?: string;
    model?: string;
    isDefault?: boolean;
  }) => {
    try {
      // Check for duplicate id
      const existing = getAgent(params.id);
      if (existing) {
        return { success: false, error: `Agent with id "${params.id}" already exists` };
      }

      // Resolve workspace: explicit > defaults > ~/.openclaw/workspace-{id}
      const defaults = getAgentDefaults();
      const workspace = params.workspace?.trim()
        || defaults?.workspace
        || join(homedir(), '.openclaw', `workspace-${params.id}`);

      // Scaffold workspace directory
      createWorkspaceDir(workspace);

      // Build agent entry matching OpenClaw schema
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const agent: Record<string, any> = {
        id: params.id,
        name: params.name,
        workspace,
        subagents: { allowAgents: ['*'] },
      };
      if (params.emoji) agent.identity = { emoji: params.emoji };
      if (params.isDefault) agent.default = true;
      if (params.model?.trim()) agent.model = params.model.trim();

      saveAgent(agent);

      return { success: true, agent };
    } catch (error) {
      console.error('Failed to create agent:', error);
      return { success: false, error: String(error) };
    }
  });

  // Update an existing agent
  ipcMain.handle('agent:update', async (_, id: string, updates: {
    name?: string;
    emoji?: string;
    workspace?: string;
    model?: string | { primary?: string; fallbacks?: string[] } | null;
    default?: boolean;
  }) => {
    try {
      const agent = getAgent(id);
      if (!agent) {
        return { success: false, error: `Agent "${id}" not found` };
      }

      // Apply updates
      if (updates.name !== undefined) {
        agent.name = updates.name || undefined;
      }
      if (updates.emoji !== undefined) {
        agent.identity = updates.emoji ? { emoji: updates.emoji } : undefined;
      }
      if (updates.workspace !== undefined) {
        agent.workspace = updates.workspace || undefined;
      }
      if (updates.model !== undefined) {
        if (updates.model === null || updates.model === '') {
          delete agent.model;
        } else {
          agent.model = updates.model;
        }
      }
      if (updates.default !== undefined) {
        agent.default = updates.default || undefined;
      }

      saveAgent(agent);
      return { success: true, agent };
    } catch (error) {
      console.error('Failed to update agent:', error);
      return { success: false, error: String(error) };
    }
  });

  // Delete an agent
  ipcMain.handle('agent:delete', async (_, id: string) => {
    try {
      deleteAgent(id);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete agent:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get workspace files for an agent
  ipcMain.handle('agent:getWorkspaceFiles', async (_, workspacePath: string) => {
    try {
      const files = getAgentWorkspaceFiles(workspacePath);
      return { success: true, files };
    } catch (error) {
      console.error('Failed to get workspace files:', error);
      return { success: false, error: String(error) };
    }
  });

  // Read a workspace file
  ipcMain.handle('agent:readFile', async (_, filePath: string) => {
    try {
      const content = readWorkspaceFile(filePath);
      return { success: true, content };
    } catch (error) {
      console.error('Failed to read workspace file:', error);
      return { success: false, error: String(error) };
    }
  });

  // Write a workspace file
  ipcMain.handle('agent:writeFile', async (_, filePath: string, content: string) => {
    try {
      writeWorkspaceFile(filePath, content);
      return { success: true };
    } catch (error) {
      console.error('Failed to write workspace file:', error);
      return { success: false, error: String(error) };
    }
  });

  // List folders inside ~/.openclaw/ for workspace selector
  ipcMain.handle('agent:listFolders', async () => {
    try {
      const folders = listOpenclawFolders();
      const basePath = getOpenclawDirPath();
      return { success: true, folders, basePath };
    } catch (error) {
      console.error('Failed to list openclaw folders:', error);
      return { success: false, error: String(error) };
    }
  });

  // Create a new folder inside ~/.openclaw/
  ipcMain.handle('agent:createFolder', async (_, name: string) => {
    try {
      const folderPath = createOpenclawFolder(name);
      return { success: true, path: folderPath };
    } catch (error) {
      console.error('Failed to create folder:', error);
      return { success: false, error: String(error) };
    }
  });

  // List configured channel types (for channel binding UI)
  ipcMain.handle('agent:listChannels', async () => {
    try {
      const channels = listChannelTypes();
      return { success: true, channels };
    } catch (error) {
      console.error('Failed to list channels:', error);
      return { success: false, error: String(error) };
    }
  });

  // ── File browser IPC handlers ──────────────────────────────────

  ipcMain.handle('file:listDir', async (_, dirPath: string, showHidden?: boolean) => {
    try {
      const files = listDirectoryContents(dirPath, showHidden ?? false);
      return { success: true, files };
    } catch (error) {
      console.error('Failed to list directory:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('file:readAny', async (_, filePath: string) => {
    try {
      const result = readAnyFile(filePath);
      return { success: true, ...result };
    } catch (error) {
      console.error('Failed to read file:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('file:writeAny', async (_, filePath: string, content: string) => {
    try {
      writeAnyFile(filePath, content);
      return { success: true };
    } catch (error) {
      console.error('Failed to write file:', error);
      return { success: false, error: String(error) };
    }
  });

  // Copy a file or directory to a destination directory
  ipcMain.handle('file:copy', async (_, srcPath: string, destDir: string) => {
    try {
      const name = basename(srcPath);
      const dest = join(destDir, name);
      const stat = statSync(srcPath);
      if (stat.isDirectory()) {
        cpSync(srcPath, dest, { recursive: true });
      } else {
        copyFileSync(srcPath, dest);
      }
      return { success: true, destPath: dest };
    } catch (error) {
      console.error('Failed to copy file:', error);
      return { success: false, error: String(error) };
    }
  });

  // Move (cut+paste) a file or directory to a destination directory
  ipcMain.handle('file:move', async (_, srcPath: string, destDir: string) => {
    try {
      const name = basename(srcPath);
      const dest = join(destDir, name);
      renameSync(srcPath, dest);
      return { success: true, destPath: dest };
    } catch (error) {
      console.error('Failed to move file:', error);
      return { success: false, error: String(error) };
    }
  });

  // Create a new empty file
  ipcMain.handle('file:create', async (_, filePath: string) => {
    try {
      if (existsSync(filePath)) {
        return { success: false, error: 'File already exists' };
      }
      writeFileSync(filePath, '', 'utf-8');
      return { success: true };
    } catch (error) {
      console.error('Failed to create file:', error);
      return { success: false, error: String(error) };
    }
  });

  // Create a new directory
  ipcMain.handle('file:createDir', async (_, dirPath: string) => {
    try {
      if (existsSync(dirPath)) {
        return { success: false, error: 'Directory already exists' };
      }
      mkdirSync(dirPath, { recursive: true });
      return { success: true };
    } catch (error) {
      console.error('Failed to create directory:', error);
      return { success: false, error: String(error) };
    }
  });

  // ── File watcher ──
  // Watch a directory for changes and send notifications to the renderer.
  // Uses fs.watch with recursive option (works on macOS, Windows; Linux falls back gracefully).
  let activeWatcher: FSWatcher | null = null;
  let _watchedPath: string | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  ipcMain.handle('file:watch', async (_, dirPath: string) => {
    // Close previous watcher if any
    if (activeWatcher) {
      activeWatcher.close();
      activeWatcher = null;
      _watchedPath = null;
    }

    try {
      activeWatcher = watch(dirPath, { recursive: true }, () => {
        // Debounce: batch rapid changes into a single notification
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const win = BrowserWindow.getAllWindows()[0];
          win?.webContents?.send('file:changed');
        }, 300);
      });

      // Silently handle watcher errors (e.g. directory deleted)
      activeWatcher.on('error', () => {
        activeWatcher?.close();
        activeWatcher = null;
        _watchedPath = null;
      });

      _watchedPath = dirPath;
      return { success: true };
    } catch (error) {
      console.error('Failed to watch directory:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('file:unwatch', async () => {
    if (activeWatcher) {
      activeWatcher.close();
      activeWatcher = null;
      _watchedPath = null;
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    return { success: true };
  });

  // Return a local-file:// protocol URL for binary file viewing (images, audio, video, PDF).
  // The local-file protocol is registered in index.ts and streams files directly from disk,
  // avoiding base64 encoding and supporting Range requests for large files.
  ipcMain.handle('file:getLocalUrl', async (_, filePath: string) => {
    try {
      const stat = statSync(filePath);
      // Use Node's pathToFileURL for correct cross-platform encoding (handles
      // Windows drive letters, backslashes, spaces, unicode, etc.), then swap
      // the scheme from file:/// to local-file://localhost/ so that Chromium's
      // standard URL parsing treats "localhost" as the host (harmless to lowercase)
      // and keeps the real file path intact in the pathname.
      // macOS/Linux: file:///Users/x/f.pdf → local-file://localhost/Users/x/f.pdf
      // Windows:     file:///C:/Users/x/f.pdf → local-file://localhost/C:/Users/x/f.pdf
      const fileUrl = pathToFileURL(filePath).href;
      const url = fileUrl.replace(/^file:\/\/\//, 'local-file://localhost/');
      return { success: true, url, size: stat.size };
    } catch (error) {
      console.error('Failed to get local file URL:', error);
      return { success: false, error: String(error) };
    }
  });

  // Delete a file or directory
  ipcMain.handle('file:delete', async (_, targetPath: string) => {
    try {
      const stat = statSync(targetPath);
      if (stat.isDirectory()) {
        rmSync(targetPath, { recursive: true });
      } else {
        rmSync(targetPath);
      }
      return { success: true };
    } catch (error) {
      console.error('Failed to delete file:', error);
      return { success: false, error: String(error) };
    }
  });

  // Convert office documents to HTML for inline viewing
  const OFFICE_CONVERT_EXTS = new Set([
    'docx', 'doc', 'odt', 'rtf',          // documents
    'xlsx', 'xls', 'ods', 'csv',           // spreadsheets
    'pptx', 'ppt', 'odp',                  // presentations
  ]);
  const MAX_OFFICE_SIZE = 50 * 1024 * 1024; // 50 MB

  ipcMain.handle('file:convertOffice', async (_, filePath: string) => {
    try {
      const ext = extname(filePath).slice(1).toLowerCase();
      if (!OFFICE_CONVERT_EXTS.has(ext)) {
        return { success: false, error: 'Unsupported format' };
      }

      const stat = statSync(filePath);
      if (stat.size > MAX_OFFICE_SIZE) {
        return { success: false, error: 'File too large to preview', size: stat.size };
      }

      const buffer = readFileSync(filePath);

      // --- Word documents (.docx) ---
      if (ext === 'docx') {
        const mammoth = await import('mammoth');
        const result = await mammoth.convertToHtml({ buffer });
        return { success: true, html: result.value, format: 'document' };
      }

      // --- Spreadsheets (.xlsx, .xls, .ods, .csv) ---
      if (['xlsx', 'xls', 'ods', 'csv'].includes(ext)) {
        const XLSX = await import('xlsx');
        const workbook = XLSX.read(buffer, { type: 'buffer' });
        const sheetNames = workbook.SheetNames;
        // Build HTML with tabs for multiple sheets
        const sheets: { name: string; html: string }[] = [];
        for (const name of sheetNames) {
          const ws = workbook.Sheets[name];
          const html = XLSX.utils.sheet_to_html(ws);
          sheets.push({ name, html });
        }
        return { success: true, sheets, format: 'spreadsheet' };
      }

      // --- Presentations (.pptx) — pure JS HTML conversion ---
      if (ext === 'pptx') {
        try {
          const { convertPptxToHtml } = await import('../utils/pptx-to-html');
          const result = await convertPptxToHtml(buffer);
          return {
            success: true,
            slidesHtml: result.slides,
            slideWidth: result.slideWidth,
            slideHeight: result.slideHeight,
            format: 'presentation-html',
          };
        } catch (htmlError) {
          console.error('pptx-to-html conversion failed:', htmlError);
          return { success: false, error: 'Cannot parse presentation file' };
        }
      }

      // --- Legacy presentations (.ppt, .odp) — LibreOffice PDF conversion ---
      if (['ppt', 'odp'].includes(ext)) {
        const { findLibreOffice, convertToPdf, trackTempDir } = await import(
          '../utils/libreoffice'
        );
        const sofficePath = findLibreOffice();

        if (sofficePath) {
          try {
            const tmpDir = mkdtempSync(join(tmpdir(), 'crawbot-pptx-'));
            const pdfPath = await convertToPdf(sofficePath, filePath, tmpDir);
            const pdfUrl = pathToFileURL(pdfPath)
              .href.replace(/^file:\/\/\//, 'local-file://localhost/');
            const pdfStat = statSync(pdfPath);
            trackTempDir(tmpDir);
            return { success: true, format: 'presentation-pdf', url: pdfUrl, size: pdfStat.size };
          } catch (conversionError) {
            console.error('LibreOffice conversion failed:', conversionError);
          }
        }

        return {
          success: false,
          error: `Preview not supported for .${ext} — open in default app`,
        };
      }

      // --- Fallback: unsupported legacy formats (.doc, .odt, .rtf) ---
      return { success: false, error: `Preview not supported for .${ext} files` };
    } catch (error) {
      console.error('Failed to convert office file:', error);
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Gateway CronJob type (as returned by cron.list RPC)
 */
interface GatewayCronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  wakeMode?: 'now' | 'next-heartbeat';
  deleteAfterRun?: boolean;
  failureAlert?: { cooldownMs?: number; destination?: string };
  schedule: { kind: string; expr?: string; everyMs?: number; at?: string; tz?: string; staggerMs?: number };
  payload: { kind: string; message?: string; text?: string };
  delivery?: { mode: string; channel?: string; to?: string };
  state: {
    nextRunAtMs?: number;
    lastRunAtMs?: number;
    lastStatus?: string;
    lastError?: string;
    lastDurationMs?: number;
  };
}

/**
 * Transform a Gateway CronJob to the frontend CronJob format
 */
function transformCronJob(job: GatewayCronJob) {
  // Extract message from payload
  const message = job.payload?.message || job.payload?.text || '';

  // Build target from delivery info
  const channelType = job.delivery?.channel || 'unknown';
  const target = {
    channelType,
    channelId: channelType,
    channelName: channelType,
    recipientId: job.delivery?.to || '',
  };

  // Build lastRun from state
  const lastRun = job.state?.lastRunAtMs
    ? {
      time: new Date(job.state.lastRunAtMs).toISOString(),
      success: job.state.lastStatus === 'ok',
      error: job.state.lastError,
      duration: job.state.lastDurationMs,
    }
    : undefined;

  // Build nextRun from state
  const nextRun = job.state?.nextRunAtMs
    ? new Date(job.state.nextRunAtMs).toISOString()
    : undefined;

  return {
    id: job.id,
    name: job.name,
    message,
    schedule: job.schedule, // Pass the object through; frontend parseCronSchedule handles it
    target,
    enabled: job.enabled,
    createdAt: new Date(job.createdAtMs).toISOString(),
    updatedAt: new Date(job.updatedAtMs).toISOString(),
    lastRun,
    nextRun,
    tz: job.schedule?.tz,
    wakeMode: job.wakeMode,
    deleteAfterRun: job.deleteAfterRun,
    staggerMs: job.schedule?.staggerMs,
    description: job.description,
  };
}

/**
 * Cron task IPC handlers
 * Proxies cron operations to the Gateway RPC service.
 * The frontend works with plain cron expression strings, but the Gateway
 * expects CronSchedule objects ({ kind: "cron", expr: "..." }).
 * These handlers bridge the two formats.
 */
function registerCronHandlers(gatewayManager: GatewayManager): void {
  // List all cron jobs — transforms Gateway CronJob format to frontend CronJob format
  ipcMain.handle('cron:list', async () => {
    try {
      const result = await gatewayManager.rpc('cron.list', { includeDisabled: true });
      const data = result as { jobs?: GatewayCronJob[] };
      const jobs = data?.jobs ?? [];
      // Transform Gateway format to frontend format
      return jobs.map(transformCronJob);
    } catch (error) {
      console.error('Failed to list cron jobs:', error);
      throw error;
    }
  });

  // Create a new cron job
  ipcMain.handle('cron:create', async (_, input: {
    name: string;
    message: string;
    schedule: string;
    target: { channelType: string; channelId: string; channelName: string };
    enabled?: boolean;
    tz?: string;
    wakeMode?: 'now' | 'next-heartbeat';
    deleteAfterRun?: boolean;
  }) => {
    try {
      // Transform frontend input to Gateway cron.add format
      // Discord/Slack/Mattermost targets use "channel:<id>" prefix
      const recipientId = input.target.channelId;
      const needsChannelPrefix = ['discord', 'slack', 'mattermost'].includes(input.target.channelType);
      const deliveryTo = needsChannelPrefix && recipientId
        ? `channel:${recipientId}`
        : recipientId;

      const gatewayInput = {
        name: input.name,
        schedule: { kind: 'cron', expr: input.schedule, tz: input.tz, staggerMs: 0 },
        payload: { kind: 'agentTurn', message: input.message },
        enabled: input.enabled ?? true,
        wakeMode: input.wakeMode ?? 'now',
        deleteAfterRun: input.deleteAfterRun,
        sessionTarget: 'isolated',
        delivery: {
          mode: 'announce',
          channel: input.target.channelType,
          to: deliveryTo,
          bestEffort: true,
        },
      };
      const result = await gatewayManager.rpc('cron.add', gatewayInput);
      // Transform the returned job to frontend format
      if (result && typeof result === 'object') {
        return transformCronJob(result as GatewayCronJob);
      }
      return result;
    } catch (error) {
      console.error('Failed to create cron job:', error);
      throw error;
    }
  });

  // Update an existing cron job
  ipcMain.handle('cron:update', async (_, id: string, input: Record<string, unknown>) => {
    try {
      // Transform schedule string to CronSchedule object if present
      const patch = { ...input };
      if (typeof patch.schedule === 'string') {
        const scheduleObj: Record<string, unknown> = { kind: 'cron', expr: patch.schedule };
        if (patch.tz !== undefined) {
          scheduleObj.tz = patch.tz;
        }
        patch.schedule = scheduleObj;
        delete patch.tz;
      }
      // Transform message to payload format if present
      if (typeof patch.message === 'string') {
        patch.payload = { kind: 'agentTurn', message: patch.message };
        delete patch.message;
      }
      // wakeMode and deleteAfterRun are passed through as-is from input
      const result = await gatewayManager.rpc('cron.update', { id, patch });
      return result;
    } catch (error) {
      console.error('Failed to update cron job:', error);
      throw error;
    }
  });

  // Delete a cron job
  ipcMain.handle('cron:delete', async (_, id: string) => {
    try {
      const result = await gatewayManager.rpc('cron.remove', { id });
      return result;
    } catch (error) {
      console.error('Failed to delete cron job:', error);
      throw error;
    }
  });

  // Toggle a cron job enabled/disabled
  ipcMain.handle('cron:toggle', async (_, id: string, enabled: boolean) => {
    try {
      const result = await gatewayManager.rpc('cron.update', { id, patch: { enabled } });
      return result;
    } catch (error) {
      console.error('Failed to toggle cron job:', error);
      throw error;
    }
  });

  // Trigger a cron job manually
  ipcMain.handle('cron:trigger', async (_, id: string) => {
    try {
      const result = await gatewayManager.rpc('cron.run', { jobId: id, mode: 'force' });
      return result;
    } catch (error) {
      console.error('Failed to trigger cron job:', error);
      throw error;
    }
  });

  // Fetch execution history for a cron job
  ipcMain.handle('cron:runs', async (_, jobId: string, limit?: number, offset?: number) => {
    try {
      const result = await gatewayManager.rpc('cron.runs', { jobId, limit: limit ?? 20, offset: offset ?? 0 });
      return result;
    } catch (error) {
      console.error('Failed to fetch cron runs:', error);
      throw error;
    }
  });
}

/**
 * UV-related IPC handlers
 */
function registerUvHandlers(): void {
  // Check if uv is installed
  ipcMain.handle('uv:check', async () => {
    return await checkUvInstalled();
  });

  // Install uv and setup managed Python
  ipcMain.handle('uv:install-all', async () => {
    try {
      const isInstalled = await checkUvInstalled();
      if (!isInstalled) {
        await installUv();
      }
      // Always run python setup to ensure it exists in uv's cache
      await setupManagedPython();
      return { success: true };
    } catch (error) {
      console.error('Failed to setup uv/python:', error);
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Node.js & CLI tools IPC handlers
 */
function registerNodejsHandlers(): void {
  // Check Node.js status (system or managed)
  ipcMain.handle('nodejs:check', async (): Promise<NodeStatus> => {
    return await getNodeStatus();
  });

  // Install Node.js (downloads official binary to managed location)
  ipcMain.handle('nodejs:install', async () => {
    return await installManagedNode();
  });

  // Check CLI tools status (claude, gemini, codex)
  ipcMain.handle('nodejs:checkCliTools', async (): Promise<CliToolStatus[]> => {
    return await checkAllCliTools();
  });

  // Install all CLI tools
  ipcMain.handle('nodejs:installCliTools', async () => {
    return await installAllCliTools();
  });

  // Install a single CLI tool by command name (for per-tool progress updates)
  ipcMain.handle('nodejs:installSingleCliTool', async (_event, command: string) => {
    return await installSingleCliTool(command);
  });
}

/**
 * PATH persistence, Python symlink, and build tools IPC handlers
 */
function registerPathHandlers(): void {
  ipcMain.handle('path:isPersisted', async (): Promise<boolean> => {
    return isManagedBinInPath();
  });

  ipcMain.handle('path:persist', async () => {
    return await persistManagedBinToPath();
  });

  ipcMain.handle('path:symlinkPython', async () => {
    return await symlinkPythonToManagedBin();
  });

  ipcMain.handle('path:getManagedBinDir', async (): Promise<string> => {
    return getManagedBinDirPath();
  });

  ipcMain.handle('python:getBinDir', async (): Promise<string | null> => {
    return await getPythonBinDir();
  });

  ipcMain.handle('buildtools:check', async (): Promise<BuildToolsStatus> => {
    return await checkBuildTools();
  });

  ipcMain.handle('buildtools:install', async (): Promise<BuildToolsInstallResult> => {
    return await installBuildTools();
  });
}

/**
 * Log-related IPC handlers
 * Allows the renderer to read application logs for diagnostics
 */
function registerLogHandlers(): void {
  // Get recent logs from memory ring buffer
  ipcMain.handle('log:getRecent', async (_, count?: number) => {
    return logger.getRecentLogs(count);
  });

  // Read log file content (last N lines)
  ipcMain.handle('log:readFile', async (_, tailLines?: number) => {
    return logger.readLogFile(tailLines);
  });

  // Get log file path (so user can open in file explorer)
  ipcMain.handle('log:getFilePath', async () => {
    return logger.getLogFilePath();
  });

  // Get log directory path
  ipcMain.handle('log:getDir', async () => {
    return logger.getLogDir();
  });

  // List all log files
  ipcMain.handle('log:listFiles', async () => {
    return logger.listLogFiles();
  });
}

/**
 * Gateway-related IPC handlers
 */
function registerGatewayHandlers(
  gatewayManager: GatewayManager,
  mainWindow: BrowserWindow
): void {
  // Get Gateway status
  ipcMain.handle('gateway:status', () => {
    return gatewayManager.getStatus();
  });

  // Check if Gateway is connected
  ipcMain.handle('gateway:isConnected', () => {
    return gatewayManager.isConnected();
  });

  // Start Gateway
  ipcMain.handle('gateway:start', async () => {
    try {
      await gatewayManager.start();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Stop Gateway
  ipcMain.handle('gateway:stop', async () => {
    try {
      await gatewayManager.stop();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Restart Gateway
  ipcMain.handle('gateway:restart', async () => {
    try {
      await gatewayManager.restart();
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Gateway RPC call
  ipcMain.handle('gateway:rpc', async (_, method: string, params?: unknown, timeoutMs?: number) => {
    try {
      const result = await gatewayManager.rpc(method, params, timeoutMs);

      // Filter models.list to only include user-configured providers
      if (method === 'models.list' && result && typeof result === 'object') {
        const data = result as { models?: Array<{ provider: string }> };
        if (Array.isArray(data.models)) {
          const configured = await getAllProviders();
          const configuredTypes = new Set<string>(configured.map((p) => p.type));
          configuredTypes.add('webauth'); // Always include WebAuth models
          // Google OAuth uses 'google-gemini-cli' provider in OpenClaw
          if (configuredTypes.has('google')) {
            configuredTypes.add('google-gemini-cli');
          }
          if (configuredTypes.size > 0) {
            data.models = data.models.filter((m) => configuredTypes.has(m.provider));
          }
        }
      }

      return { success: true, result };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Chat send with media — reads staged files from disk and builds attachments.
  // Raster images (png/jpg/gif/webp) are inlined as base64 vision attachments.
  // All other files are referenced by path in the message text so the model
  // can access them via tools (the same format channels use).
  const VISION_MIME_TYPES = new Set([
    'image/png', 'image/jpeg', 'image/bmp', 'image/webp',
  ]);

  ipcMain.handle('chat:sendWithMedia', async (_, params: {
    sessionKey: string;
    message: string;
    deliver?: boolean;
    idempotencyKey: string;
    media?: Array<{ filePath: string; mimeType: string; fileName: string }>;
  }) => {
    try {
      let message = params.message;
      // The Gateway processes image attachments through TWO parallel paths:
      // Path A: `attachments` param → parsed via `parseMessageWithAttachments` →
      //   injected as inline vision content when the model supports images.
      //   Format: { content: base64, mimeType: string, fileName?: string }
      // Path B: `[media attached: ...]` in message text → Gateway's native image
      //   detection (`detectAndLoadPromptImages`) reads the file from disk and
      //   injects it as inline vision content. Also works for history messages.
      // We use BOTH paths for maximum reliability.
      const imageAttachments: Array<Record<string, unknown>> = [];
      const fileReferences: string[] = [];

      if (params.media && params.media.length > 0) {
        for (const m of params.media) {
          logger.info(`[chat:sendWithMedia] Processing file: ${m.fileName} (${m.mimeType}), path: ${m.filePath}, exists: ${existsSync(m.filePath)}, isVision: ${VISION_MIME_TYPES.has(m.mimeType)}`);

          // Always add file path reference so the model can access it via tools
          fileReferences.push(
            `[media attached: ${m.filePath} (${m.mimeType}) | ${m.filePath}]`,
          );

          if (VISION_MIME_TYPES.has(m.mimeType)) {
            // Send as base64 attachment in the format the Gateway expects:
            // { content: base64String, mimeType: string, fileName?: string }
            // The Gateway normalizer looks for `a.content` (NOT `a.source.data`).
            const fileBuffer = readFileSync(m.filePath);
            const base64Data = fileBuffer.toString('base64');
            logger.info(`[chat:sendWithMedia] Read ${fileBuffer.length} bytes, base64 length: ${base64Data.length}`);
            imageAttachments.push({
              content: base64Data,
              mimeType: m.mimeType,
              fileName: m.fileName,
            });
          }
        }
      }

      // Append file references to message text so the model knows about them
      if (fileReferences.length > 0) {
        const refs = fileReferences.join('\n');
        message = message ? `${message}\n\n${refs}` : refs;
      }

      const rpcParams: Record<string, unknown> = {
        sessionKey: params.sessionKey,
        message,
        deliver: params.deliver ?? false,
        idempotencyKey: params.idempotencyKey,
      };

      if (imageAttachments.length > 0) {
        rpcParams.attachments = imageAttachments;
      }

      logger.info(`[chat:sendWithMedia] Sending: message="${message.substring(0, 100)}", attachments=${imageAttachments.length}, fileRefs=${fileReferences.length}`);

      // Use a longer timeout when images are present (120s vs default 30s)
      const timeoutMs = imageAttachments.length > 0 ? 120000 : 30000;
      const result = await gatewayManager.rpc('chat.send', rpcParams, timeoutMs);
      logger.info(`[chat:sendWithMedia] RPC result: ${JSON.stringify(result)}`);
      return { success: true, result };
    } catch (error) {
      logger.error(`[chat:sendWithMedia] Error: ${String(error)}`);
      return { success: false, error: String(error) };
    }
  });

  // Get the Control UI URL with token for embedding
  ipcMain.handle('gateway:getControlUiUrl', async () => {
    try {
      const status = gatewayManager.getStatus();
      const token = await getSetting('gatewayToken');
      const port = status.port || 18789;
      // Pass token as query param - Control UI will store it in localStorage
      const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
      return { success: true, url, port, token };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Health check
  ipcMain.handle('gateway:health', async () => {
    try {
      const health = await gatewayManager.checkHealth();
      return { success: true, ...health };
    } catch (error) {
      return { success: false, ok: false, error: String(error) };
    }
  });

  // Forward Gateway events to renderer
  gatewayManager.on('status', (status) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:status-changed', status);
    }
  });

  gatewayManager.on('message', (message) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:message', message);
    }
  });

  gatewayManager.on('notification', (notification) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:notification', notification);
    }
    // Forward to automation event bus for event-driven triggers
    automationEventBus.emitGatewayNotification({ notification });
  });

  gatewayManager.on('channel:status', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:channel-status', data);
    }
  });

  gatewayManager.on('chat:message', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:chat-message', data);
    }
  });

  gatewayManager.on('agent:event', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:agent-event', data);
    }
  });

  gatewayManager.on('exit', (code) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:exit', code);
    }
  });

  gatewayManager.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('gateway:error', error.message);
    }
  });
}

/**
 * OpenClaw-related IPC handlers
 * For checking package status and channel configuration
 */
function registerOpenClawHandlers(): void {

  // Get OpenClaw package status
  ipcMain.handle('openclaw:status', () => {
    const status = getOpenClawStatus();
    logger.info('openclaw:status IPC called', status);
    return status;
  });

  // Check if OpenClaw is ready (package present)
  ipcMain.handle('openclaw:isReady', () => {
    const status = getOpenClawStatus();
    return status.packageExists;
  });

  // Get the resolved OpenClaw directory path (for diagnostics)
  ipcMain.handle('openclaw:getDir', () => {
    return getOpenClawDir();
  });

  // Get the OpenClaw config directory (~/.openclaw)
  ipcMain.handle('openclaw:getConfigDir', () => {
    return getOpenClawConfigDir();
  });

  // Get the OpenClaw skills directory (~/.openclaw/skills)
  ipcMain.handle('openclaw:getSkillsDir', () => {
    const dir = getOpenClawSkillsDir();
    ensureDir(dir);
    return dir;
  });

  // Get a shell command to run OpenClaw CLI without modifying PATH
  ipcMain.handle('openclaw:getCliCommand', () => {
    try {
      const status = getOpenClawStatus();
      if (!status.packageExists) {
        return { success: false, error: `OpenClaw package not found at: ${status.dir}` };
      }
      if (!existsSync(status.entryPath)) {
        return { success: false, error: `OpenClaw entry script not found at: ${status.entryPath}` };
      }
      return { success: true, command: getOpenClawCliCommand() };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Install a system-wide openclaw command on macOS (requires admin prompt)
  ipcMain.handle('openclaw:installCliMac', async () => {
    return installOpenClawCliMac();
  });

  // Parse slash commands from the openclaw package docs
  ipcMain.handle('openclaw:getSlashCommands', () => {
    try {
      const status = getOpenClawStatus();
      if (!status.packageExists) {
        return { success: false, error: 'OpenClaw package not found' };
      }
      const mdPath = join(status.dir, 'docs', 'tools', 'slash-commands.md');
      if (!existsSync(mdPath)) {
        return { success: false, error: 'slash-commands.md not found' };
      }
      const content = readFileSync(mdPath, 'utf-8');
      const commands = parseSlashCommandsMd(content);
      return { success: true, commands };
    } catch (error) {
      logger.warn('Failed to parse slash commands:', error);
      return { success: false, error: String(error) };
    }
  });

  // ==================== Channel Configuration Handlers ====================

  // Save channel configuration
  ipcMain.handle('channel:saveConfig', async (_, channelType: string, config: Record<string, unknown>) => {
    try {
      logger.info('channel:saveConfig', { channelType, keys: Object.keys(config || {}) });
      saveChannelConfig(channelType, config);
      return { success: true };
    } catch (error) {
      console.error('Failed to save channel config:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get channel configuration
  ipcMain.handle('channel:getConfig', async (_, channelType: string) => {
    try {
      const config = getChannelConfig(channelType);
      return { success: true, config };
    } catch (error) {
      console.error('Failed to get channel config:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get channel form values (reverse-transformed for UI pre-fill)
  ipcMain.handle('channel:getFormValues', async (_, channelType: string) => {
    try {
      const values = getChannelFormValues(channelType);
      return { success: true, values };
    } catch (error) {
      console.error('Failed to get channel form values:', error);
      return { success: false, error: String(error) };
    }
  });

  // Delete channel configuration
  ipcMain.handle('channel:deleteConfig', async (_, channelType: string) => {
    try {
      deleteChannelConfig(channelType);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete channel config:', error);
      return { success: false, error: String(error) };
    }
  });

  // List configured channels
  ipcMain.handle('channel:listConfigured', async () => {
    try {
      const channels = listConfiguredChannels();
      return { success: true, channels };
    } catch (error) {
      console.error('Failed to list channels:', error);
      return { success: false, error: String(error) };
    }
  });

  // Enable or disable a channel
  ipcMain.handle('channel:setEnabled', async (_, channelType: string, enabled: boolean, accountId?: string) => {
    try {
      setChannelEnabled(channelType, enabled, accountId);
      return { success: true };
    } catch (error) {
      console.error('Failed to set channel enabled:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get enabled map for all channel accounts
  ipcMain.handle('channel:getEnabledMap', async () => {
    try {
      return { success: true, map: getChannelEnabledMap() };
    } catch (error) {
      return { success: false, error: String(error), map: {} };
    }
  });

  // Validate channel configuration
  ipcMain.handle('channel:validate', async (_, channelType: string) => {
    try {
      const result = await validateChannelConfig(channelType);
      return { success: true, ...result };
    } catch (error) {
      console.error('Failed to validate channel:', error);
      return { success: false, valid: false, errors: [String(error)], warnings: [] };
    }
  });

  // Validate channel credentials by calling actual service APIs (before saving)
  ipcMain.handle('channel:validateCredentials', async (_, channelType: string, config: Record<string, string>) => {
    try {
      const result = await validateChannelCredentials(channelType, config);
      return { success: true, ...result };
    } catch (error) {
      console.error('Failed to validate channel credentials:', error);
      return { success: false, valid: false, errors: [String(error)], warnings: [] };
    }
  });

  // Save account-specific channel configuration
  ipcMain.handle('channel:saveAccountConfig', async (_, channelType: string, accountId: string, config: Record<string, unknown>) => {
    try {
      saveAccountConfig(channelType, accountId, config);
      return { success: true };
    } catch (error) {
      console.error('Failed to save account config:', error);
      return { success: false, error: String(error) };
    }
  });

  // Delete account-specific channel configuration
  ipcMain.handle('channel:deleteAccountConfig', async (_, channelType: string, accountId: string) => {
    try {
      deleteAccountConfig(channelType, accountId);
      return { success: true };
    } catch (error) {
      console.error('Failed to delete account config:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get form values for a specific account
  ipcMain.handle('channel:getAccountFormValues', async (_, channelType: string, accountId: string) => {
    try {
      const values = getAccountFormValues(channelType, accountId);
      return { success: true, values };
    } catch (error) {
      console.error('Failed to get account form values:', error);
      return { success: false, error: String(error) };
    }
  });

  // List all accounts for a channel type
  ipcMain.handle('channel:listAccounts', async (_, channelType: string) => {
    try {
      const accounts = listChannelAccounts(channelType);
      return { success: true, accounts };
    } catch (error) {
      console.error('Failed to list channel accounts:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get all bindings
  ipcMain.handle('binding:get', async () => {
    try {
      const bindings = getBindings();
      return { success: true, bindings };
    } catch (error) {
      console.error('Failed to get bindings:', error);
      return { success: false, error: String(error) };
    }
  });

  // Set a binding
  ipcMain.handle('binding:set', async (_, agentId: string, channel: string, accountId?: string, session?: string) => {
    try {
      setBinding(agentId, channel, accountId, session);
      return { success: true };
    } catch (error) {
      console.error('Failed to set binding:', error);
      return { success: false, error: String(error) };
    }
  });

  // Remove a binding
  ipcMain.handle('binding:remove', async (_, channel: string, accountId?: string) => {
    try {
      removeBinding(channel, accountId);
      return { success: true };
    } catch (error) {
      console.error('Failed to remove binding:', error);
      return { success: false, error: String(error) };
    }
  });

  // ── Channel Pairing ──

  const PAIRING_DIR = join(homedir(), '.openclaw', 'credentials');
  const PAIRING_TTL_MS = 60 * 60 * 1000; // 1 hour

  type PairingRequest = {
    id: string;
    code: string;
    createdAt: string;
    lastSeenAt: string;
    meta?: Record<string, string>;
  };

  type PairingStore = { version: 1; requests: PairingRequest[] };
  type AllowFromStore = { version: 1; allowFrom: string[] };

  function pairingPath(channel: string): string {
    return join(PAIRING_DIR, `${channel}-pairing.json`);
  }

  function allowFromPath(channel: string, accountId?: string): string {
    const base = channel;
    if (accountId && accountId !== 'default') {
      return join(PAIRING_DIR, `${base}-${accountId}-allowFrom.json`);
    }
    return join(PAIRING_DIR, `${base}-allowFrom.json`);
  }

  function readPairingStore(channel: string): PairingStore {
    const fp = pairingPath(channel);
    try {
      if (existsSync(fp)) {
        return JSON.parse(readFileSync(fp, 'utf-8')) as PairingStore;
      }
    } catch { /* ignore */ }
    return { version: 1, requests: [] };
  }

  function writePairingStore(channel: string, store: PairingStore): void {
    const fp = pairingPath(channel);
    if (!existsSync(PAIRING_DIR)) mkdirSync(PAIRING_DIR, { recursive: true });
    writeFileSync(fp, JSON.stringify(store, null, 2), 'utf-8');
  }

  function readAllowFrom(channel: string, accountId?: string): string[] {
    const fp = allowFromPath(channel, accountId);
    try {
      if (existsSync(fp)) {
        const data = JSON.parse(readFileSync(fp, 'utf-8')) as AllowFromStore;
        return Array.isArray(data.allowFrom) ? data.allowFrom : [];
      }
    } catch { /* ignore */ }
    return [];
  }

  function writeAllowFrom(channel: string, accountId: string | undefined, entries: string[]): void {
    const fp = allowFromPath(channel, accountId);
    if (!existsSync(PAIRING_DIR)) mkdirSync(PAIRING_DIR, { recursive: true });
    writeFileSync(fp, JSON.stringify({ version: 1, allowFrom: entries } satisfies AllowFromStore, null, 2), 'utf-8');
  }

  // List pending pairing requests across all channels
  ipcMain.handle('pairing:list', async () => {
    try {
      const results: Array<PairingRequest & { channel: string }> = [];
      const now = Date.now();
      if (!existsSync(PAIRING_DIR)) return { success: true, requests: [] };
      for (const file of readdirSync(PAIRING_DIR)) {
        const match = file.match(/^(.+)-pairing\.json$/);
        if (!match) continue;
        const channel = match[1];
        const store = readPairingStore(channel);
        for (const req of store.requests) {
          const createdAt = Date.parse(req.createdAt);
          if (Number.isFinite(createdAt) && now - createdAt < PAIRING_TTL_MS) {
            results.push({ ...req, channel });
          }
        }
      }
      results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { success: true, requests: results };
    } catch (error) {
      console.error('Failed to list pairing requests:', error);
      return { success: false, error: String(error), requests: [] };
    }
  });

  // Approve a pairing request by code
  ipcMain.handle('pairing:approve', async (_, channel: string, code: string, accountId?: string) => {
    try {
      const store = readPairingStore(channel);
      const upperCode = code.trim().toUpperCase();
      const idx = store.requests.findIndex(r => r.code?.toUpperCase() === upperCode);
      if (idx < 0) return { success: false, error: 'Request not found or expired' };
      const entry = store.requests[idx];
      store.requests.splice(idx, 1);
      writePairingStore(channel, store);
      // Add to allowFrom
      const resolvedAccountId = entry.meta?.accountId || accountId;
      const current = readAllowFrom(channel, resolvedAccountId);
      if (!current.includes(entry.id)) {
        writeAllowFrom(channel, resolvedAccountId, [...current, entry.id]);
      }
      return { success: true, approved: { id: entry.id, channel, code: entry.code } };
    } catch (error) {
      console.error('Failed to approve pairing:', error);
      return { success: false, error: String(error) };
    }
  });

  // Reject (remove) a pairing request by code
  ipcMain.handle('pairing:reject', async (_, channel: string, code: string) => {
    try {
      const store = readPairingStore(channel);
      const upperCode = code.trim().toUpperCase();
      const idx = store.requests.findIndex(r => r.code?.toUpperCase() === upperCode);
      if (idx < 0) return { success: false, error: 'Request not found or expired' };
      store.requests.splice(idx, 1);
      writePairingStore(channel, store);
      return { success: true };
    } catch (error) {
      console.error('Failed to reject pairing:', error);
      return { success: false, error: String(error) };
    }
  });
}

/**
 * WhatsApp Login Handlers
 */
function registerWhatsAppHandlers(mainWindow: BrowserWindow): void {
  // Request WhatsApp QR code
  ipcMain.handle('channel:requestWhatsAppQr', async (_, accountId: string) => {
    try {
      logger.info('channel:requestWhatsAppQr', { accountId });
      await whatsAppLoginManager.start(accountId);
      return { success: true };
    } catch (error) {
      logger.error('channel:requestWhatsAppQr failed', error);
      return { success: false, error: String(error) };
    }
  });

  // Cancel WhatsApp login
  ipcMain.handle('channel:cancelWhatsAppQr', async () => {
    try {
      await whatsAppLoginManager.stop();
      return { success: true };
    } catch (error) {
      logger.error('channel:cancelWhatsAppQr failed', error);
      return { success: false, error: String(error) };
    }
  });

  // Check WhatsApp status (is it active?)
  // ipcMain.handle('channel:checkWhatsAppStatus', ...)

  // Forward events to renderer
  whatsAppLoginManager.on('qr', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('channel:whatsapp-qr', data);
    }
  });

  whatsAppLoginManager.on('success', (data) => {
    if (!mainWindow.isDestroyed()) {
      logger.info('whatsapp:login-success', data);
      mainWindow.webContents.send('channel:whatsapp-success', data);
    }
  });

  whatsAppLoginManager.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      logger.error('whatsapp:login-error', error);
      mainWindow.webContents.send('channel:whatsapp-error', error);
    }
  });
}

/**
 * Zalo Personal Login Handlers
 */
function registerZaloUserHandlers(mainWindow: BrowserWindow): void {
  // Request OpenZalo QR code
  ipcMain.handle('channel:requestOpenZaloQr', async (_, accountId: string) => {
    try {
      logger.info('channel:requestOpenZaloQr', { accountId });
      await zaloUserLoginManager.start(accountId);
      return { success: true };
    } catch (error) {
      logger.error('channel:requestOpenZaloQr failed', error);
      return { success: false, error: String(error) };
    }
  });

  // Cancel OpenZalo login
  ipcMain.handle('channel:cancelOpenZaloQr', async () => {
    try {
      await zaloUserLoginManager.stop();
      return { success: true };
    } catch (error) {
      logger.error('channel:cancelOpenZaloQr failed', error);
      return { success: false, error: String(error) };
    }
  });

  // Forward events to renderer
  zaloUserLoginManager.on('qr', (data) => {
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send('channel:openzalo-qr', data);
    }
  });

  zaloUserLoginManager.on('success', (data) => {
    if (!mainWindow.isDestroyed()) {
      logger.info('openzalo:login-success', data);
      mainWindow.webContents.send('channel:openzalo-success', data);
    }
  });

  zaloUserLoginManager.on('error', (error) => {
    if (!mainWindow.isDestroyed()) {
      logger.error('openzalo:login-error', error);
      mainWindow.webContents.send('channel:openzalo-error', error);
    }
  });
}

/**
 * Provider-related IPC handlers
 */
function registerProviderHandlers(gatewayManager: GatewayManager): void {
  // Get all providers with key info
  ipcMain.handle('provider:list', async () => {
    return await getAllProvidersWithKeyInfo();
  });

  // Get a specific provider
  ipcMain.handle('provider:get', async (_, providerId: string) => {
    return await getProvider(providerId);
  });

  // Save a provider configuration
  ipcMain.handle('provider:save', async (_, config: ProviderConfig, apiKey?: string) => {
    try {
      // Save the provider config
      await saveProvider(config);

      // Store the API key if provided
      if (apiKey) {
        await storeApiKey(config.id, apiKey);

        // Also write to OpenClaw auth-profiles.json so the gateway can use it
        try {
          saveProviderKeyToOpenClaw(config.type, apiKey);
        } catch (err) {
          console.warn('Failed to save key to OpenClaw auth-profiles:', err);
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Delete a provider
  ipcMain.handle('provider:delete', async (_, providerId: string) => {
    try {
      const existing = await getProvider(providerId);
      const wasDefault = (await getDefaultProvider()) === providerId;
      await deleteProvider(providerId);

      // Best-effort cleanup in OpenClaw auth profiles + config
      if (existing?.type) {
        try {
          removeProviderKeyFromOpenClaw(existing.type);
        } catch (err) {
          console.warn('Failed to remove credentials from OpenClaw auth-profiles:', err);
        }
        try {
          removeProviderFromOpenClawConfig(existing.type);
        } catch (err) {
          console.warn('Failed to clean up OpenClaw config:', err);
        }
      }

      // If the deleted provider was the default, fall back to another provider
      if (wasDefault) {
        const remaining = await getAllProviders();
        if (remaining.length > 0) {
          // Pick the first enabled provider, or just the first one
          const next = remaining.find((p) => p.enabled) || remaining[0];
          logger.info(`Deleted default provider "${providerId}", falling back to "${next.id}" (${next.type})`);
          // Trigger the same logic as provider:setDefault to update OpenClaw config
          try {
            await setDefaultProvider(next.id);
            const provider = await getProvider(next.id);
            if (provider) {
              if (!provider.model) {
                const registryDefault = getProviderDefaultModel(provider.type);
                if (registryDefault) {
                  const modelPart = registryDefault.startsWith(`${provider.type}/`)
                    ? registryDefault.slice(provider.type.length + 1)
                    : registryDefault;
                  provider.model = modelPart;
                  await saveProvider({ ...provider, model: modelPart, updatedAt: new Date().toISOString() });
                }
              }
              let modelOverride = provider.model
                ? `${provider.type}/${provider.model}`
                : undefined;
              const providerHasKey = await hasApiKey(next.id);
              if (provider.type === 'google' && !providerHasKey) {
                modelOverride = `google-gemini-cli/${provider.model || 'gemini-3-pro-preview'}`;
              }
              if (provider.type === 'custom' || provider.type === 'ollama') {
                setOpenClawDefaultModelWithOverride(provider.type, modelOverride, {
                  baseUrl: provider.baseUrl,
                  api: 'openai-completions',
                });
              } else {
                setOpenClawDefaultModel(provider.type, modelOverride);
              }
              const providerKey = await getApiKey(next.id);
              if (providerKey) {
                saveProviderKeyToOpenClaw(provider.type, providerKey);
              }
              if (gatewayManager.isConnected()) {
                void gatewayManager.restart().catch((err) => {
                  logger.warn('Gateway restart after fallback provider switch failed:', err);
                });
              }
            }
          } catch (err) {
            logger.warn('Failed to set fallback default provider:', err);
          }
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Update API key for a provider
  ipcMain.handle('provider:setApiKey', async (_, providerId: string, apiKey: string) => {
    try {
      await storeApiKey(providerId, apiKey);

      // Also write to OpenClaw auth-profiles.json
      // Resolve provider type from stored config, or use providerId as type
      const provider = await getProvider(providerId);
      const providerType = provider?.type || providerId;
      try {
        saveProviderKeyToOpenClaw(providerType, apiKey);
      } catch (err) {
        console.warn('Failed to save key to OpenClaw auth-profiles:', err);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Atomically update provider config and API key
  ipcMain.handle(
    'provider:updateWithKey',
    async (
      _,
      providerId: string,
      updates: Partial<ProviderConfig>,
      apiKey?: string
    ) => {
      const existing = await getProvider(providerId);
      if (!existing) {
        return { success: false, error: 'Provider not found' };
      }

      const previousKey = await getApiKey(providerId);
      const previousProviderType = existing.type;

      try {
        const nextConfig: ProviderConfig = {
          ...existing,
          ...updates,
          updatedAt: new Date().toISOString(),
        };

        await saveProvider(nextConfig);

        if (apiKey !== undefined) {
          const trimmedKey = apiKey.trim();
          if (trimmedKey) {
            await storeApiKey(providerId, trimmedKey);
            saveProviderKeyToOpenClaw(nextConfig.type, trimmedKey);
          } else {
            await deleteApiKey(providerId);
            removeProviderKeyFromOpenClaw(nextConfig.type);
          }
        }

        // If this provider is the current default, re-apply OpenClaw config
        // so model/baseUrl changes take effect immediately.
        const currentDefault = await getDefaultProvider();
        if (currentDefault === providerId) {
          try {
            let modelOverride = nextConfig.model
              ? `${nextConfig.type}/${nextConfig.model}`
              : undefined;

            const providerHasKey = await hasApiKey(providerId);
            if (nextConfig.type === 'google' && !providerHasKey) {
              const googleModel = nextConfig.model || 'gemini-3-pro-preview';
              modelOverride = `google-gemini-cli/${googleModel}`;
            }

            if (nextConfig.type === 'custom' || nextConfig.type === 'ollama') {
              setOpenClawDefaultModelWithOverride(nextConfig.type, modelOverride, {
                baseUrl: nextConfig.baseUrl,
                api: 'openai-completions',
              });
            } else {
              setOpenClawDefaultModel(nextConfig.type, modelOverride);
            }

            if (gatewayManager.isConnected()) {
              logger.info(`Restarting Gateway after default provider config update`);
              void gatewayManager.restart().catch((err) => {
                logger.warn('Gateway restart after provider update failed:', err);
              });
            }
          } catch (err) {
            console.warn('Failed to re-apply OpenClaw default model after update:', err);
          }
        }

        return { success: true };
      } catch (error) {
        // Best-effort rollback to keep config/key consistent.
        try {
          await saveProvider(existing);
          if (previousKey) {
            await storeApiKey(providerId, previousKey);
            saveProviderKeyToOpenClaw(previousProviderType, previousKey);
          } else {
            await deleteApiKey(providerId);
            removeProviderKeyFromOpenClaw(previousProviderType);
          }
        } catch (rollbackError) {
          console.warn('Failed to rollback provider updateWithKey:', rollbackError);
        }

        return { success: false, error: String(error) };
      }
    }
  );

  // Delete API key for a provider
  ipcMain.handle('provider:deleteApiKey', async (_, providerId: string) => {
    try {
      await deleteApiKey(providerId);

      // Keep OpenClaw auth-profiles.json in sync with local key storage
      const provider = await getProvider(providerId);
      const providerType = provider?.type || providerId;
      try {
        removeProviderKeyFromOpenClaw(providerType);
      } catch (err) {
        console.warn('Failed to remove key from OpenClaw auth-profiles:', err);
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Check if a provider has an API key
  ipcMain.handle('provider:hasApiKey', async (_, providerId: string) => {
    return await hasApiKey(providerId);
  });

  // Get the actual API key (for internal use only - be careful!)
  ipcMain.handle('provider:getApiKey', async (_, providerId: string) => {
    return await getApiKey(providerId);
  });

  // Set default provider and update OpenClaw default model
  ipcMain.handle('provider:setDefault', async (_, providerId: string) => {
    try {
      await setDefaultProvider(providerId);

      // Update OpenClaw config to use this provider's default model
      const provider = await getProvider(providerId);
      if (provider) {
        try {
          // If the provider doesn't have a model set yet, derive it from the
          // registry default and persist it so the config stays in sync with
          // what OpenClaw will actually use.
          if (!provider.model) {
            const registryDefault = getProviderDefaultModel(provider.type);
            if (registryDefault) {
              // registryDefault is "provider/model" — extract the model part
              const modelPart = registryDefault.startsWith(`${provider.type}/`)
                ? registryDefault.slice(provider.type.length + 1)
                : registryDefault;
              provider.model = modelPart;
              await saveProvider({ ...provider, model: modelPart, updatedAt: new Date().toISOString() });
            }
          }

          // Build the full model string: "providerType/modelId"
          let modelOverride = provider.model
            ? `${provider.type}/${provider.model}`
            : undefined;

          // For Google OAuth (no API key), use google-gemini-cli provider prefix
          // so the gateway matches the auth profile provider name.
          const providerHasKey = await hasApiKey(providerId);
          if (provider.type === 'google' && !providerHasKey) {
            const googleModel = provider.model || 'gemini-3-pro-preview';
            modelOverride = `google-gemini-cli/${googleModel}`;
          }

          if (provider.type === 'custom' || provider.type === 'ollama') {
            // For runtime-configured providers, use user-entered base URL/api.
            setOpenClawDefaultModelWithOverride(provider.type, modelOverride, {
              baseUrl: provider.baseUrl,
              api: 'openai-completions',
            });
          } else {
            setOpenClawDefaultModel(provider.type, modelOverride);
          }

          // Keep auth-profiles in sync with the default provider instance.
          // This is especially important when multiple custom providers exist.
          const providerKey = await getApiKey(providerId);
          if (providerKey) {
            saveProviderKeyToOpenClaw(provider.type, providerKey);
          }

          // Restart Gateway so it picks up the new config and env vars.
          // OpenClaw reads openclaw.json per-request, but env vars (API keys)
          // are only available if they were injected at process startup.
          if (gatewayManager.isConnected()) {
            logger.info(`Restarting Gateway after provider switch to "${provider.type}"`);
            void gatewayManager.restart().catch((err) => {
              logger.warn('Gateway restart after provider switch failed:', err);
            });
          }
        } catch (err) {
          console.warn('Failed to set OpenClaw default model:', err);
        }
      }

      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Get default provider
  ipcMain.handle('provider:getDefault', async () => {
    return await getDefaultProvider();
  });

  // Validate API key by making a real test request to the provider.
  // providerId can be either a stored provider ID or a provider type.
  ipcMain.handle(
    'provider:validateKey',
    async (
      _,
      providerId: string,
      apiKey: string,
      options?: { baseUrl?: string }
    ) => {
      try {
        // First try to get existing provider
        const provider = await getProvider(providerId);

        // Use provider.type if provider exists, otherwise use providerId as the type
        // This allows validation during setup when provider hasn't been saved yet
        const providerType = provider?.type || providerId;
        const registryBaseUrl = getProviderConfig(providerType)?.baseUrl;
        // Prefer caller-supplied baseUrl (live form value) over persisted config.
        // This ensures Setup/Settings validation reflects unsaved edits immediately.
        const resolvedBaseUrl = options?.baseUrl || provider?.baseUrl || registryBaseUrl;

        console.log(`[crawbot-validate] validating provider type: ${providerType}`);
        return await validateApiKeyWithProvider(providerType, apiKey, { baseUrl: resolvedBaseUrl });
      } catch (error) {
        console.error('Validation error:', error);
        return { valid: false, error: String(error) };
      }
    }
  );

  // Paste setup token (Anthropic OAuth setup-token flow)
  ipcMain.handle(
    'provider:pasteSetupToken',
    async (_, providerType: string, token: string) => {
      try {
        const trimmed = token.trim();
        if (!trimmed) {
          return { success: false, error: 'Token is required' };
        }

        // Validate Anthropic setup-token format
        if (providerType === 'anthropic') {
          const prefix = 'sk-ant-oat01-';
          if (!trimmed.startsWith(prefix)) {
            return { success: false, error: `Expected token starting with ${prefix}` };
          }
          if (trimmed.length < 80) {
            return { success: false, error: 'Token looks too short; paste the full setup-token' };
          }
        }

        // Write token to auth-profiles.json (same format as OpenClaw CLI)
        const profileId = `${providerType}:default`;
        const authProfilesPath = join(
          homedir(),
          '.openclaw',
          'agents',
          'main',
          'agent',
          'auth-profiles.json'
        );
        const dir = join(authProfilesPath, '..');
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }

        // Read existing store or create new
        let store: {
          version: number;
          profiles: Record<string, unknown>;
          order?: Record<string, string[]>;
          lastGood?: Record<string, string>;
        } = { version: 1, profiles: {} };

        try {
          if (existsSync(authProfilesPath)) {
            const raw = readFileSync(authProfilesPath, 'utf-8');
            const parsed = JSON.parse(raw);
            if (parsed.version && parsed.profiles) {
              store = parsed;
            }
          }
        } catch {
          // Start fresh if parse fails
        }

        // Upsert the token credential
        store.profiles[profileId] = {
          type: 'token',
          provider: providerType,
          token: trimmed,
        };

        // Update order
        if (!store.order) store.order = {};
        if (!store.order[providerType]) store.order[providerType] = [];
        if (!store.order[providerType].includes(profileId)) {
          store.order[providerType].push(profileId);
        }

        // Set as last good
        if (!store.lastGood) store.lastGood = {};
        store.lastGood[providerType] = profileId;

        writeFileSync(authProfilesPath, JSON.stringify(store, null, 2), 'utf-8');
        logger.info(`Setup token saved for provider "${providerType}" (profile: ${profileId})`);

        return { success: true };
      } catch (error) {
        logger.error('Failed to paste setup token:', error);
        return { success: false, error: String(error) };
      }
    }
  );

  // OAuth login (native PKCE flow — no CLI/TTY dependency)
  ipcMain.handle(
    'provider:oauthLogin',
    async (_, providerType: string) => {
      if (providerType === 'google') {
        try {
          const { runGoogleOAuthFlow } = await import('../utils/google-oauth');
          return await runGoogleOAuthFlow();
        } catch (error) {
          logger.error('Google OAuth login failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }

      if (providerType === 'openai-codex') {
        try {
          const { runOpenAICodexOAuthFlow } = await import('../utils/openai-codex-oauth');
          return await runOpenAICodexOAuthFlow();
        } catch (error) {
          logger.error('OpenAI Codex OAuth login failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }

      if (providerType === 'anthropic') {
        try {
          const { runClaudeOAuthFlow } = await import('../utils/claude-oauth');
          return await runClaudeOAuthFlow();
        } catch (error) {
          logger.error('Claude OAuth login failed:', error);
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }

      return { success: false, error: `OAuth login not supported for provider type: ${providerType}` };
    }
  );
}

type ValidationProfile = 'openai-compatible' | 'google-query-key' | 'anthropic-header' | 'openrouter' | 'none';

/**
 * Validate API key using lightweight model-listing endpoints (zero token cost).
 * Providers are grouped into 3 auth styles:
 * - openai-compatible: Bearer auth + /models
 * - google-query-key: ?key=... + /models
 * - anthropic-header: x-api-key + anthropic-version + /models
 */
async function validateApiKeyWithProvider(
  providerType: string,
  apiKey: string,
  options?: { baseUrl?: string }
): Promise<{ valid: boolean; error?: string }> {
  const profile = getValidationProfile(providerType);
  if (profile === 'none') {
    return { valid: true };
  }

  const trimmedKey = apiKey.trim();
  if (!trimmedKey) {
    return { valid: false, error: 'API key is required' };
  }

  try {
    switch (profile) {
      case 'openai-compatible':
        return await validateOpenAiCompatibleKey(providerType, trimmedKey, options?.baseUrl);
      case 'google-query-key':
        return await validateGoogleQueryKey(providerType, trimmedKey, options?.baseUrl);
      case 'anthropic-header':
        return await validateAnthropicHeaderKey(providerType, trimmedKey, options?.baseUrl);
      case 'openrouter':
        return await validateOpenRouterKey(providerType, trimmedKey);
      default:
        return { valid: false, error: `Unsupported validation profile for provider: ${providerType}` };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { valid: false, error: errorMessage };
  }
}

function logValidationStatus(provider: string, status: number): void {
  console.log(`[crawbot-validate] ${provider} HTTP ${status}`);
}

function maskSecret(secret: string): string {
  if (!secret) return '';
  if (secret.length <= 8) return `${secret.slice(0, 2)}***`;
  return `${secret.slice(0, 4)}***${secret.slice(-4)}`;
}

function sanitizeValidationUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const key = url.searchParams.get('key');
    if (key) url.searchParams.set('key', maskSecret(key));
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const next = { ...headers };
  if (next.Authorization?.startsWith('Bearer ')) {
    const token = next.Authorization.slice('Bearer '.length);
    next.Authorization = `Bearer ${maskSecret(token)}`;
  }
  if (next['x-api-key']) {
    next['x-api-key'] = maskSecret(next['x-api-key']);
  }
  return next;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function buildOpenAiModelsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models?limit=1`;
}

function logValidationRequest(
  provider: string,
  method: string,
  url: string,
  headers: Record<string, string>
): void {
  console.log(
    `[crawbot-validate] ${provider} request ${method} ${sanitizeValidationUrl(url)} headers=${JSON.stringify(sanitizeHeaders(headers))}`
  );
}

function getValidationProfile(providerType: string): ValidationProfile {
  switch (providerType) {
    case 'anthropic':
      return 'anthropic-header';
    case 'google':
      return 'google-query-key';
    case 'openrouter':
      return 'openrouter';
    case 'ollama':
      return 'none';
    default:
      return 'openai-compatible';
  }
}

async function performProviderValidationRequest(
  providerLabel: string,
  url: string,
  headers: Record<string, string>
): Promise<{ valid: boolean; error?: string }> {
  try {
    logValidationRequest(providerLabel, 'GET', url, headers);
    const response = await fetch(url, { headers });
    logValidationStatus(providerLabel, response.status);
    const data = await response.json().catch(() => ({}));
    return classifyAuthResponse(response.status, data);
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Helper: classify an HTTP response as valid / invalid / error.
 * 200 / 429 → valid (key works, possibly rate-limited).
 * 401 / 403 → invalid.
 * Everything else → return the API error message.
 */
function classifyAuthResponse(
  status: number,
  data: unknown
): { valid: boolean; error?: string } {
  if (status >= 200 && status < 300) return { valid: true };
  if (status === 429) return { valid: true }; // rate-limited but key is valid
  if (status === 401 || status === 403) return { valid: false, error: 'Invalid API key' };

  // Try to extract an error message
  const obj = data as { error?: { message?: string }; message?: string } | null;
  const msg = obj?.error?.message || obj?.message || `API error: ${status}`;
  return { valid: false, error: msg };
}

async function validateOpenAiCompatibleKey(
  providerType: string,
  apiKey: string,
  baseUrl?: string
): Promise<{ valid: boolean; error?: string }> {
  const trimmedBaseUrl = baseUrl?.trim();
  if (!trimmedBaseUrl) {
    return { valid: false, error: `Base URL is required for provider "${providerType}" validation` };
  }

  const headers = { Authorization: `Bearer ${apiKey}` };

  // Try /models first (standard OpenAI-compatible endpoint)
  const modelsUrl = buildOpenAiModelsUrl(trimmedBaseUrl);
  const modelsResult = await performProviderValidationRequest(providerType, modelsUrl, headers);

  // If /models returned 404, the provider likely doesn't implement it (e.g. MiniMax).
  // Fall back to a minimal /chat/completions POST which almost all providers support.
  if (modelsResult.error?.includes('API error: 404')) {
    console.log(
      `[crawbot-validate] ${providerType} /models returned 404, falling back to /chat/completions probe`
    );
    const base = normalizeBaseUrl(trimmedBaseUrl);
    const chatUrl = `${base}/chat/completions`;
    return await performChatCompletionsProbe(providerType, chatUrl, headers);
  }

  return modelsResult;
}

/**
 * Fallback validation: send a minimal /chat/completions request.
 * We intentionally use max_tokens=1 to minimise cost. The goal is only to
 * distinguish auth errors (401/403) from a working key (200/400/429).
 * A 400 "invalid model" still proves the key itself is accepted.
 */
async function performChatCompletionsProbe(
  providerLabel: string,
  url: string,
  headers: Record<string, string>
): Promise<{ valid: boolean; error?: string }> {
  try {
    logValidationRequest(providerLabel, 'POST', url, headers);
    const response = await fetch(url, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'validation-probe',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });
    logValidationStatus(providerLabel, response.status);
    const data = await response.json().catch(() => ({}));

    // 401/403 → invalid key
    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: 'Invalid API key' };
    }
    // 200, 400 (bad model but key accepted), 429 → key is valid
    if (
      (response.status >= 200 && response.status < 300) ||
      response.status === 400 ||
      response.status === 429
    ) {
      return { valid: true };
    }
    return classifyAuthResponse(response.status, data);
  } catch (error) {
    return {
      valid: false,
      error: `Connection error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function validateGoogleQueryKey(
  providerType: string,
  apiKey: string,
  baseUrl?: string
): Promise<{ valid: boolean; error?: string }> {
  // Default to the official Google Gemini API base URL if none is provided
  const base = normalizeBaseUrl(baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
  const url = `${base}/models?pageSize=1&key=${encodeURIComponent(apiKey)}`;
  return await performProviderValidationRequest(providerType, url, {});
}

async function validateAnthropicHeaderKey(
  providerType: string,
  apiKey: string,
  baseUrl?: string
): Promise<{ valid: boolean; error?: string }> {
  const base = normalizeBaseUrl(baseUrl || 'https://api.anthropic.com/v1');
  const url = `${base}/models?limit=1`;
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  return await performProviderValidationRequest(providerType, url, headers);
}

async function validateOpenRouterKey(
  providerType: string,
  apiKey: string
): Promise<{ valid: boolean; error?: string }> {
  // Use OpenRouter's auth check endpoint instead of public /models
  const url = 'https://openrouter.ai/api/v1/auth/key';
  const headers = { Authorization: `Bearer ${apiKey}` };
  return await performProviderValidationRequest(providerType, url, headers);
}

/**
 * Shell-related IPC handlers
 */
function registerShellHandlers(): void {
  // Open external URL in the user's default browser profile (not OpenClaw's)
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    await openExternalInDefaultProfile(url);
  });

  // Open path in file explorer
  ipcMain.handle('shell:showItemInFolder', async (_, path: string) => {
    shell.showItemInFolder(path);
  });

  // Open path
  ipcMain.handle('shell:openPath', async (_, path: string) => {
    return await shell.openPath(path);
  });
}

/**
 * ClawHub-related IPC handlers
 */
function registerClawHubHandlers(clawHubService: ClawHubService): void {
  // Search skills
  ipcMain.handle('clawhub:search', async (_, params: ClawHubSearchParams) => {
    try {
      const results = await clawHubService.search(params);
      return { success: true, results };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Install skill
  ipcMain.handle('clawhub:install', async (_, params: ClawHubInstallParams) => {
    try {
      await clawHubService.install(params);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Uninstall skill
  ipcMain.handle('clawhub:uninstall', async (_, params: ClawHubUninstallParams) => {
    try {
      await clawHubService.uninstall(params);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // List installed skills
  ipcMain.handle('clawhub:list', async () => {
    try {
      const results = await clawHubService.listInstalled();
      return { success: true, results };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Open skill readme
  ipcMain.handle('clawhub:openSkillReadme', async (_, slug: string) => {
    try {
      await clawHubService.openSkillReadme(slug);
      return { success: true };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });
}

/**
 * Dialog-related IPC handlers
 */
function registerDialogHandlers(): void {
  // Show open dialog
  ipcMain.handle('dialog:open', async (_, options: Electron.OpenDialogOptions) => {
    const result = await dialog.showOpenDialog(options);
    return result;
  });

  // Show save dialog
  ipcMain.handle('dialog:save', async (_, options: Electron.SaveDialogOptions) => {
    const result = await dialog.showSaveDialog(options);
    return result;
  });

  // Show message box
  ipcMain.handle('dialog:message', async (_, options: Electron.MessageBoxOptions) => {
    const result = await dialog.showMessageBox(options);
    return result;
  });
}

/**
 * App-related IPC handlers
 */
function registerAppHandlers(gatewayManager: GatewayManager): void {
  // Get app version
  ipcMain.handle('app:version', () => {
    return app.getVersion();
  });

  // Get app name
  ipcMain.handle('app:name', () => {
    return app.getName();
  });

  // Get app path
  ipcMain.handle('app:getPath', (_, name: Parameters<typeof app.getPath>[0]) => {
    return app.getPath(name);
  });

  // Get platform
  ipcMain.handle('app:platform', () => {
    return process.platform;
  });

  // Quit app
  ipcMain.handle('app:quit', () => {
    app.quit();
  });

  // Relaunch app
  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.quit();
  });

  // Set auto-start (launch at login) — persist + apply to OS
  ipcMain.handle('app:setAutoStart', async (_, enabled: boolean) => {
    await setSetting('launchAtStartup', enabled);
    setAutoStart(enabled);
  });

  // Set start-minimized — persist to electron-store
  ipcMain.handle('app:setStartMinimized', async (_, enabled: boolean) => {
    await setSetting('startMinimized', enabled);
  });

  // Set tools auto-approve — persist to electron-store + openclaw.json + restart gateway
  ipcMain.handle('app:setToolsAutoApprove', async (_, enabled: boolean) => {
    await setSetting('toolsAutoApprove', enabled);
    setToolsAutoApproveConfig(enabled);
    if (gatewayManager.isConnected()) {
      void gatewayManager.restart().catch((err) => {
        logger.warn('Gateway restart after tools auto-approve change failed:', err);
      });
    }
  });

  // Set session dmScope — persist to electron-store + openclaw.json + restart gateway
  ipcMain.handle('app:setSessionDmScope', async (_, scope: string) => {
    await setSetting('sessionDmScope', scope);
    setSessionDmScopeConfig(scope as 'main' | 'per-peer' | 'per-channel-peer' | 'per-account-channel-peer');
    if (gatewayManager.isConnected()) {
      void gatewayManager.restart().catch((err) => {
        logger.warn('Gateway restart after session dmScope change failed:', err);
      });
    }
  });

  // Read OpenClaw settings directly from openclaw.json (source of truth).
  // If a UI-configurable value is invalid/unrecognised, overwrite it with the default.
  ipcMain.handle('app:getOpenclawSettings', () => {
    let toolsAutoApprove = getToolsAutoApproveFromConfig();
    if (toolsAutoApprove === undefined) {
      toolsAutoApprove = true;
      setToolsAutoApproveConfig(toolsAutoApprove);
    }

    let sessionDmScope = getSessionDmScopeFromConfig();
    if (sessionDmScope === undefined) {
      sessionDmScope = 'main';
      setSessionDmScopeConfig(sessionDmScope);
    }

    const screenshotMaxSide = getScreenshotMaxSideFromConfig() ?? 2000;
    const useBuiltinBrowser = getUseBuiltinBrowserFromConfig();

    return { toolsAutoApprove, sessionDmScope, screenshotMaxSide, useBuiltinBrowser };
  });

  // Set use builtin browser — persist to crawbot-settings.json + update openclaw.json browser config + restart gateway
  ipcMain.handle('app:setUseBuiltinBrowser', async (_, enabled: boolean) => {
    await setSetting('useBuiltinBrowser', enabled);
    setUseBuiltinBrowserConfig(enabled);
    if (enabled) {
      // Restore browser config pointing to CDP proxy
      try {
        const { setOpenClawBrowserConfig } = await import('../utils/browser-config');
        setOpenClawBrowserConfig(9333);
      } catch (err) {
        logger.warn('Failed to set browser config:', err);
      }
    } else {
      // Remove browser config so OpenClaw uses Chrome / extension
      try {
        const { removeOpenClawBrowserConfig } = await import('../utils/browser-config');
        removeOpenClawBrowserConfig();
      } catch (err) {
        logger.warn('Failed to remove browser config:', err);
      }
    }
    // Sync AGENTS.md browser instructions across all workspaces
    try {
      const { syncBrowserBlockToAllWorkspaces } = await import('../utils/agents-md-injection');
      syncBrowserBlockToAllWorkspaces(enabled);
    } catch (err) {
      logger.warn('Failed to sync browser block to AGENTS.md:', err);
    }
    if (gatewayManager.isConnected()) {
      void gatewayManager.restart().catch((err) => {
        logger.warn('Gateway restart after use builtin browser change failed:', err);
      });
    }
  });

  // Set screenshot max side — persist to openclaw.json + restart gateway
  ipcMain.handle('app:setScreenshotMaxSide', async (_, value: number) => {
    await setSetting('screenshotMaxSide', value);
    setScreenshotMaxSideConfig(value);
    if (gatewayManager.isConnected()) {
      void gatewayManager.restart().catch((err) => {
        logger.warn('Gateway restart after screenshot max side change failed:', err);
      });
    }
  });
}

/**
 * Window control handlers (for custom title bar on Windows/Linux)
 */
function registerWindowHandlers(mainWindow: BrowserWindow): void {
  ipcMain.handle('window:minimize', () => {
    mainWindow.minimize();
  });

  ipcMain.handle('window:maximize', () => {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  });

  ipcMain.handle('window:close', () => {
    mainWindow.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow.isMaximized();
  });
}

// ── Mime type helpers ────────────────────────────────────────────

const EXT_MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.py': 'text/x-python',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function getMimeType(ext: string): string {
  return EXT_MIME_MAP[ext.toLowerCase()] || 'application/octet-stream';
}

function mimeToExt(mimeType: string): string {
  for (const [ext, mime] of Object.entries(EXT_MIME_MAP)) {
    if (mime === mimeType) return ext;
  }
  return '';
}

const OUTBOUND_DIR = join(homedir(), '.openclaw', 'media', 'outbound');

/**
 * Generate a preview data URL for image files.
 * Resizes large images while preserving aspect ratio (only constrain the
 * longer side so the image is never squished). The frontend handles
 * square cropping via CSS object-fit: cover.
 */
function generateImagePreview(filePath: string, mimeType: string): string | null {
  try {
    const img = nativeImage.createFromPath(filePath);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    const maxDim = 512; // keep enough resolution for crisp display on Retina
    // Only resize if larger than threshold — specify ONE dimension to keep ratio
    if (size.width > maxDim || size.height > maxDim) {
      const resized = size.width >= size.height
        ? img.resize({ width: maxDim })   // landscape / square → constrain width
        : img.resize({ height: maxDim }); // portrait → constrain height
      return `data:image/png;base64,${resized.toPNG().toString('base64')}`;
    }
    // Small image — use original
    const buf = readFileSync(filePath);
    return `data:${mimeType};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * File staging IPC handlers
 * Stage files to ~/.openclaw/media/outbound/ for gateway access
 */
function registerFileHandlers(): void {
  // Stage files from real disk paths (used with dialog:open)
  ipcMain.handle('file:stage', async (_, filePaths: string[]) => {
    mkdirSync(OUTBOUND_DIR, { recursive: true });

    const results = [];
    for (const filePath of filePaths) {
      const id = crypto.randomUUID();
      const ext = extname(filePath);
      const stagedPath = join(OUTBOUND_DIR, `${id}${ext}`);
      copyFileSync(filePath, stagedPath);

      const stat = statSync(stagedPath);
      const mimeType = getMimeType(ext);
      const fileName = basename(filePath);

      // Generate preview for images
      let preview: string | null = null;
      if (mimeType.startsWith('image/')) {
        preview = generateImagePreview(stagedPath, mimeType);
      }

      results.push({ id, fileName, mimeType, fileSize: stat.size, stagedPath, preview });
    }
    return results;
  });

  // Stage file from buffer (used for clipboard paste / drag-drop)
  ipcMain.handle('file:stageBuffer', async (_, payload: {
    base64: string;
    fileName: string;
    mimeType: string;
  }) => {
    mkdirSync(OUTBOUND_DIR, { recursive: true });

    const id = crypto.randomUUID();
    const ext = extname(payload.fileName) || mimeToExt(payload.mimeType);
    const stagedPath = join(OUTBOUND_DIR, `${id}${ext}`);
    const buffer = Buffer.from(payload.base64, 'base64');
    writeFileSync(stagedPath, buffer);

    const mimeType = payload.mimeType || getMimeType(ext);
    const fileSize = buffer.length;

    // Generate preview for images
    let preview: string | null = null;
    if (mimeType.startsWith('image/')) {
      preview = generateImagePreview(stagedPath, mimeType);
    }

    return { id, fileName: payload.fileName, mimeType, fileSize, stagedPath, preview };
  });

  // Load thumbnails for file paths on disk (used to restore previews in history)
  // Save an image to a user-chosen location (base64 data URI or existing file path)
  ipcMain.handle('media:saveImage', async (_, params: {
    base64?: string;
    mimeType?: string;
    filePath?: string;
    defaultFileName: string;
  }) => {
    try {
      const ext = params.defaultFileName.includes('.')
        ? params.defaultFileName.split('.').pop()!
        : (params.mimeType?.split('/')[1] || 'png');
      const result = await dialog.showSaveDialog({
        defaultPath: join(homedir(), 'Downloads', params.defaultFileName),
        filters: [
          { name: 'Images', extensions: [ext, 'png', 'jpg', 'jpeg', 'webp', 'gif'] },
          { name: 'All Files', extensions: ['*'] },
        ],
      });
      if (result.canceled || !result.filePath) return { success: false };

      if (params.filePath && existsSync(params.filePath)) {
        copyFileSync(params.filePath, result.filePath);
      } else if (params.base64) {
        const buffer = Buffer.from(params.base64, 'base64');
        writeFileSync(result.filePath, buffer);
      } else {
        return { success: false, error: 'No image data provided' };
      }
      return { success: true, savedPath: result.filePath };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('media:getThumbnails', async (_, paths: Array<{ filePath: string; mimeType: string }>) => {
    const results: Record<string, { preview: string | null; fileSize: number }> = {};
    for (const { filePath, mimeType } of paths) {
      try {
        if (!existsSync(filePath)) {
          results[filePath] = { preview: null, fileSize: 0 };
          continue;
        }
        const stat = statSync(filePath);
        let preview: string | null = null;
        if (mimeType.startsWith('image/')) {
          preview = generateImagePreview(filePath, mimeType);
        }
        results[filePath] = { preview, fileSize: stat.size };
      } catch {
        results[filePath] = { preview: null, fileSize: 0 };
      }
    }
    return results;
  });
}

/**
 * Config bundle export/import handlers
 */
function registerConfigBundleHandlers(): void {
  ipcMain.handle('config:export', async (_, options: { includeApiKeys: boolean }) => {
    const timestamp = new Date().toISOString().slice(0, 10);
    const defaultPath = join(homedir(), 'Downloads', `crawbot-config-${timestamp}.zip`);

    const result = await dialog.showSaveDialog({
      defaultPath,
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
    });
    if (result.canceled || !result.filePath) {
      return { success: false, error: 'cancelled' };
    }

    return exportConfigBundle(result.filePath, { includeApiKeys: options.includeApiKeys });
  });

  ipcMain.handle('config:import', async () => {
    const openResult = await dialog.showOpenDialog({
      filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
      properties: ['openFile'],
    });
    if (openResult.canceled || !openResult.filePaths.length) {
      return { success: false, error: 'cancelled' };
    }

    const zipPath = openResult.filePaths[0];
    const validation = validateConfigBundle(zipPath);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    const meta = validation.meta!;
    const confirmResult = await dialog.showMessageBox({
      type: 'warning',
      title: 'Import Config Bundle',
      message: 'This will overwrite your current configuration.',
      detail: [
        `Date: ${new Date(meta.timestamp).toLocaleString()}`,
        `Files: ${meta.fileCount}`,
        `App version: ${meta.appVersion}`,
        `API keys: ${meta.includesApiKeys ? 'included' : 'not included'}`,
      ].join('\n'),
      buttons: ['Cancel', 'Import'],
      defaultId: 0,
      cancelId: 0,
    });

    if (confirmResult.response !== 1) {
      return { success: false, error: 'cancelled' };
    }

    return importConfigBundle(zipPath);
  });
}

/** Directories to skip when walking for workspace archive */
const ARCHIVE_SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__']);

/** Count files recursively (for reporting after tar export) */
function countFiles(dir: string): number {
  let count = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ARCHIVE_SKIP_DIRS.has(entry.name)) continue;
      count += countFiles(fullPath);
    } else if (entry.isFile()) {
      count++;
    }
  }
  return count;
}

/** Check if a file path ends with .tar.gz or .tgz */
function isTarGz(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.tar.gz') || lower.endsWith('.tgz');
}

/**
 * Workspace archive export/import handlers
 */
function registerWorkspaceArchiveHandlers(): void {
  ipcMain.handle('workspace:export', async (_, params: { rootPath: string }) => {
    try {
      if (!params.rootPath || !existsSync(params.rootPath)) {
        return { success: false, error: 'Workspace folder does not exist' };
      }

      const folderName = basename(params.rootPath);
      const timestamp = new Date().toISOString().slice(0, 10);
      const defaultPath = join(homedir(), 'Downloads', `${folderName}-${timestamp}.zip`);

      const result = await dialog.showSaveDialog({
        defaultPath,
        filters: [
          { name: 'ZIP Archive', extensions: ['zip'] },
          { name: 'Gzipped Tar Archive', extensions: ['tar.gz', 'tgz'] },
        ],
      });
      if (result.canceled || !result.filePath) {
        return { success: false, error: 'cancelled' };
      }

      const outputPath = result.filePath;

      if (isTarGz(outputPath)) {
        // tar.gz export using the tar package
        // Build a filter to exclude unwanted directories
        await tar.create(
          {
            gzip: true,
            file: outputPath,
            cwd: params.rootPath,
            filter: (entryPath: string) => {
              const parts = entryPath.split('/');
              return !parts.some((p) => ARCHIVE_SKIP_DIRS.has(p));
            },
          },
          ['.'],
        );
        const fileCount = countFiles(params.rootPath);
        logger.info(`Workspace exported (tar.gz): ${outputPath} (${fileCount} files)`);
        return { success: true, filePath: outputPath, fileCount };
      } else {
        // ZIP export using AdmZip
        const zip = new AdmZip();
        let fileCount = 0;

        const walkAndAdd = (dir: string, baseDir: string) => {
          const dirEntries = readdirSync(dir, { withFileTypes: true });
          for (const entry of dirEntries) {
            const fullPath = join(dir, entry.name);
            if (entry.isDirectory()) {
              if (ARCHIVE_SKIP_DIRS.has(entry.name)) continue;
              walkAndAdd(fullPath, baseDir);
            } else if (entry.isFile()) {
              const relativePath = fullPath.slice(baseDir.length + 1);
              const relativeDir = dirname(relativePath);
              zip.addLocalFile(fullPath, relativeDir === '.' ? '' : relativeDir);
              fileCount++;
            }
          }
        };

        walkAndAdd(params.rootPath, params.rootPath);
        zip.writeZip(outputPath);

        logger.info(`Workspace exported (zip): ${outputPath} (${fileCount} files)`);
        return { success: true, filePath: outputPath, fileCount };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Workspace export failed:', message);
      return { success: false, error: message };
    }
  });

  ipcMain.handle('workspace:import', async (_, params: { targetPath: string }) => {
    try {
      if (!params.targetPath) {
        return { success: false, error: 'No target path specified' };
      }

      const openResult = await dialog.showOpenDialog({
        filters: [
          { name: 'Archives', extensions: ['zip', 'tar.gz', 'tgz'] },
        ],
        properties: ['openFile'],
      });
      if (openResult.canceled || !openResult.filePaths.length) {
        return { success: false, error: 'cancelled' };
      }

      const archivePath = openResult.filePaths[0];

      if (isTarGz(archivePath)) {
        // tar.gz import using the tar package
        // Ensure target directory exists
        if (!existsSync(params.targetPath)) {
          mkdirSync(params.targetPath, { recursive: true });
        }

        // Extract with path-slip protection via strip and the tar package's
        // built-in safeguards. We also use a filter to reject absolute paths
        // and paths with '..' components.
        const normalizedTarget = normalize(params.targetPath + '/');
        let fileCount = 0;

        await tar.extract({
          file: archivePath,
          cwd: params.targetPath,
          filter: (entryPath: string) => {
            // Reject absolute paths and path traversal
            if (entryPath.startsWith('/') || entryPath.includes('..')) {
              logger.warn(`Skipping unsafe path in workspace import: ${entryPath}`);
              return false;
            }
            const resolved = resolve(params.targetPath, entryPath);
            if (!resolved.startsWith(normalizedTarget)) {
              logger.warn(`Skipping unsafe resolved path in workspace import: ${entryPath}`);
              return false;
            }
            return true;
          },
          onReadEntry: (entry) => {
            if (entry.type === 'File') fileCount++;
          },
        });

        logger.info(`Workspace imported (tar.gz) to ${params.targetPath} (${fileCount} files)`);
        return { success: true, fileCount };
      } else {
        // ZIP import using AdmZip
        const zip = new AdmZip(archivePath);
        const entries = zip.getEntries();
        let fileCount = 0;

        // Zip-slip protection
        const normalizedTarget = normalize(params.targetPath + '/');
        for (const entry of entries) {
          if (entry.isDirectory) continue;
          const resolved = resolve(params.targetPath, entry.entryName);
          if (!resolved.startsWith(normalizedTarget)) {
            logger.warn(`Skipping unsafe path in workspace import: ${entry.entryName}`);
            continue;
          }
          const targetDir = dirname(resolved);
          if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true });
          }
          writeFileSync(resolved, entry.getData());
          fileCount++;
        }

        logger.info(`Workspace imported (zip) to ${params.targetPath} (${fileCount} files)`);
        return { success: true, fileCount };
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Workspace import failed:', message);
      return { success: false, error: message };
    }
  });
}

// ── Skill import handler ─────────────────────────────────────────

/**
 * Strip version suffix from a skill archive filename to derive the folder name.
 * Examples:
 *   "my-skill-1.0.0"       → "my-skill"
 *   "my-skill-v1.2.3"      → "my-skill"
 *   "cool_skill-0.1.0-beta" → "cool_skill"
 *   "skill"                 → "skill"
 */
function stripVersionFromName(name: string): string {
  // Remove common version patterns: -v1.2.3, -1.2.3, -1.0.0-beta, etc.
  return name.replace(/-v?\d+(\.\d+)*([-.]\w+)*$/, '');
}

/**
 * Get a clean folder name from an archive filename.
 * Strips the extension (.zip, .tar.gz, .tgz) and version suffix.
 */
function skillFolderNameFromArchive(archivePath: string): string {
  let name = basename(archivePath);
  // Strip extensions
  if (name.toLowerCase().endsWith('.tar.gz')) {
    name = name.slice(0, -7);
  } else if (name.toLowerCase().endsWith('.tgz')) {
    name = name.slice(0, -4);
  } else if (name.toLowerCase().endsWith('.zip')) {
    name = name.slice(0, -4);
  }
  return stripVersionFromName(name);
}

/**
 * After extracting an archive, check if the result is a single wrapper directory.
 * If so, move its contents up one level (flatten). This handles the common pattern
 * where archives contain a top-level directory like `my-skill-1.0.0/SKILL.md`.
 *
 * OpenClaw expects SKILL.md to be an immediate child of the skill folder:
 *   ~/.openclaw/skills/<skill-name>/SKILL.md
 */
function flattenSingleWrapperDir(targetPath: string): void {
  const entries = readdirSync(targetPath, { withFileTypes: true });
  // Only flatten if there's exactly one subdirectory and no files at the top level
  const dirs = entries.filter(e => e.isDirectory());
  const files = entries.filter(e => e.isFile());
  if (dirs.length === 1 && files.length === 0) {
    const wrapperDir = join(targetPath, dirs[0].name);
    // Check if SKILL.md is inside the wrapper (confirming it's a wrapped archive)
    if (existsSync(join(wrapperDir, 'SKILL.md'))) {
      logger.info(`Flattening wrapper directory: ${dirs[0].name}`);
      const innerEntries = readdirSync(wrapperDir, { withFileTypes: true });
      for (const inner of innerEntries) {
        const src = join(wrapperDir, inner.name);
        const dest = join(targetPath, inner.name);
        renameSync(src, dest);
      }
      // Remove the now-empty wrapper directory
      rmSync(wrapperDir, { recursive: true, force: true });
    }
  }
}

/**
 * Try to read the skillKey from SKILL.md frontmatter metadata.openclaw.skillKey.
 * Falls back to the folder name if not found.
 */
/**
 * Fix YAML frontmatter in SKILL.md: quote `description` values that contain
 * colons (`: `), which YAML misinterprets as nested mappings.
 */
function fixSkillMdYamlQuoting(targetPath: string): void {
  const skillMdPath = join(targetPath, 'SKILL.md');
  if (!existsSync(skillMdPath)) return;
  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const fmMatch = content.match(/^(---\s*\n)([\s\S]*?)(\n---)/);
    if (!fmMatch) return;
    const [fullMatch, open, fm, close] = fmMatch;
    // Find unquoted description lines that contain `: ` (YAML-breaking colons)
    const fixed = fm.replace(
      /^(description:\s*)(?!["'])(.*:.*)$/m,
      (_match, prefix: string, value: string) => {
        // Escape any existing double quotes in the value and wrap in double quotes
        const escaped = value.replace(/"/g, '\\"');
        return `${prefix}"${escaped}"`;
      }
    );
    if (fixed !== fm) {
      const newContent = content.replace(fullMatch, `${open}${fixed}${close}`);
      writeFileSync(skillMdPath, newContent, 'utf-8');
      logger.info(`Fixed YAML quoting in ${skillMdPath}`);
    }
  } catch (err) {
    logger.warn(`Could not fix YAML quoting in ${skillMdPath}: ${String(err)}`);
  }
}

function readSkillKeyFromMd(targetPath: string): string | null {
  const skillMdPath = join(targetPath, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;
  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    // Parse YAML frontmatter between --- markers
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const fm = fmMatch[1];
    // Look for skillKey in the metadata.openclaw block (JSON embedded in YAML)
    const skillKeyMatch = fm.match(/"skillKey"\s*:\s*"([^"]+)"/);
    if (skillKeyMatch) return skillKeyMatch[1];
    // Also try YAML-style skillKey
    const yamlMatch = fm.match(/skillKey\s*:\s*['"]?([^\s'"]+)['"]?/);
    if (yamlMatch) return yamlMatch[1];
    // Fall back to the `name` field (OpenClaw uses name as skillKey when metadata.skillKey is absent)
    const nameMatch = fm.match(/^name\s*:\s*['"]?([^\s'"]+)['"]?/m);
    if (nameMatch) return nameMatch[1];
    return null;
  } catch {
    return null;
  }
}

function registerSkillImportHandler(gatewayManager: GatewayManager): void {
  ipcMain.handle('skill:import', async () => {
    try {
      const openResult = await dialog.showOpenDialog({
        title: 'Import Skill',
        filters: [
          { name: 'Skill Archives', extensions: ['zip', 'tar.gz', 'tgz'] },
        ],
        properties: ['openFile'],
      });
      if (openResult.canceled || !openResult.filePaths.length) {
        return { success: false, error: 'cancelled' };
      }

      const archivePath = openResult.filePaths[0];
      const folderName = skillFolderNameFromArchive(archivePath);
      if (!folderName) {
        return { success: false, error: 'Could not determine skill folder name from archive' };
      }

      const skillsDir = join(homedir(), '.openclaw', 'skills');
      const targetPath = join(skillsDir, folderName);

      // Ensure skills directory exists
      if (!existsSync(skillsDir)) {
        mkdirSync(skillsDir, { recursive: true });
      }

      // Clean existing target folder if present, then recreate
      if (existsSync(targetPath)) {
        rmSync(targetPath, { recursive: true, force: true });
      }
      mkdirSync(targetPath, { recursive: true });

      let fileCount = 0;

      if (isTarGz(archivePath)) {
        const normalizedTarget = normalize(targetPath + '/');

        await tar.extract({
          file: archivePath,
          cwd: targetPath,
          filter: (entryPath: string) => {
            if (entryPath.startsWith('/') || entryPath.includes('..')) {
              logger.warn(`Skipping unsafe path in skill import: ${entryPath}`);
              return false;
            }
            const resolved = resolve(targetPath, entryPath);
            if (!resolved.startsWith(normalizedTarget)) {
              logger.warn(`Skipping unsafe resolved path in skill import: ${entryPath}`);
              return false;
            }
            return true;
          },
          onReadEntry: (entry) => {
            if (entry.type === 'File') fileCount++;
          },
        });
      } else {
        const zip = new AdmZip(archivePath);
        const entries = zip.getEntries();
        const normalizedTarget = normalize(targetPath + '/');

        for (const entry of entries) {
          if (entry.isDirectory) continue;
          const resolved = resolve(targetPath, entry.entryName);
          if (!resolved.startsWith(normalizedTarget)) {
            logger.warn(`Skipping unsafe path in skill import: ${entry.entryName}`);
            continue;
          }
          const targetDir = dirname(resolved);
          if (!existsSync(targetDir)) {
            mkdirSync(targetDir, { recursive: true });
          }
          writeFileSync(resolved, entry.getData());
          fileCount++;
        }
      }

      // Flatten wrapper directory if the archive had a single top-level folder
      // (e.g., my-skill-1.0.0.zip containing my-skill-1.0.0/SKILL.md)
      flattenSingleWrapperDir(targetPath);

      // Fix YAML frontmatter: quote descriptions containing colons to prevent YAML parse errors
      fixSkillMdYamlQuoting(targetPath);

      // Validate that SKILL.md exists after extraction
      if (!existsSync(join(targetPath, 'SKILL.md'))) {
        logger.warn(`No SKILL.md found in imported skill at ${targetPath}`);
        return {
          success: true,
          fileCount,
          folderName,
          warning: 'Skill extracted but no SKILL.md found. The skill may not be recognized by OpenClaw.',
        };
      }

      // Determine the skill key (from SKILL.md metadata or folder name)
      const skillKey = readSkillKeyFromMd(targetPath) || folderName;

      logger.info(`Skill imported to ${targetPath} (${fileCount} files, key: ${skillKey}). Enabling via gateway...`);

      // Enable the skill via gateway RPC so it becomes active in config
      try {
        await gatewayManager.rpc('skills.update', { skillKey, enabled: true });
        logger.info(`Skill "${skillKey}" enabled via gateway RPC`);
      } catch (enableErr) {
        logger.warn(`Could not auto-enable skill "${skillKey}" via RPC: ${String(enableErr)}`);
        // Not fatal — skill is imported, user can enable manually
      }

      return { success: true, fileCount, folderName, skillKey };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('Skill import failed:', message);
      return { success: false, error: message };
    }
  });
}

// ── Slash command parser ─────────────────────────────────────────

interface ParsedSlashCommand {
  name: string;
  description: string;
  acceptsArgs: boolean;
}

/**
 * Parse the "## Command list" section from slash-commands.md.
 * Extracts `/command` entries with their descriptions.
 */
function parseSlashCommandsMd(content: string): ParsedSlashCommand[] {
  const commands: ParsedSlashCommand[] = [];
  const seen = new Set<string>();

  // Match lines like: - `/help`  or  - `/model <name>` (alias: ...)  or  - `/think <off|minimal|...>`
  const cmdRegex = /^- `\/(\w+)(?:\s+([^`]*))?`\s*(.*)/;

  for (const line of content.split('\n')) {
    const m = line.match(cmdRegex);
    if (!m) continue;

    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);

    const argHint = m[2]?.trim() || '';
    const rest = m[3]?.trim() || '';

    // Extract description: strip parenthesized metadata, markdown links, backticks
    let description = rest
      .replace(/\(alias[es]*:[^)]*\)/gi, '')
      .replace(/\(requires[^)]*\)/gi, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // [text](url) → text
      .replace(/`([^`]*)`/g, '$1')              // `code` → code
      .trim();
    // Strip wrapping parentheses, "or ..." prefixes, and leading/trailing punctuation
    description = description
      .replace(/^\(/, '').replace(/\)$/, '')
      .replace(/^or\s+`?\/\w+[^`]*`?\s*/i, '')
      .replace(/^[;,\s]+|[;,\s]+$/g, '');
    // Capitalize first letter
    if (description) {
      description = description.charAt(0).toUpperCase() + description.slice(1);
    }
    // If no description extracted from rest, use the arg hint
    if (!description && argHint) {
      description = argHint;
    }

    commands.push({
      name,
      description: description || name,
      acceptsArgs: !!argHint,
    });

    // Extract aliases from (alias: /foo, /bar) and add as separate commands
    const aliasMatch = rest.match(/\(alias[es]*:\s*([^)]*)\)/i);
    if (aliasMatch) {
      const aliasRefs = aliasMatch[1].matchAll(/\/(\w+)/g);
      for (const ref of aliasRefs) {
        const alias = ref[1];
        if (alias && !seen.has(alias)) {
          seen.add(alias);
          commands.push({
            name: alias,
            description: description || name,
            acceptsArgs: !!argHint,
          });
        }
      }
    }
  }

  return commands;
}

// ── Browser Extension Handlers ──────────────────────────────────────────────

function registerBrowserExtensionHandlers(gatewayManager: GatewayManager): void {
  // Install extension files + write config with current token
  ipcMain.handle('extension:install', async () => {
    try {
      const token = await getSetting('gatewayToken');
      const status = gatewayManager.getStatus();
      const port = status.port || 18789;
      const result = installExtension(token, port);
      if (!result.success) {
        return { success: false, error: result.error };
      }
      return { success: true, path: result.path, relayPort: port + 3 };
    } catch (error) {
      logger.error(`[extension:install] ${String(error)}`);
      return { success: false, error: String(error) };
    }
  });

  // Get extension status (installed? Chrome found?)
  ipcMain.handle('extension:status', async () => {
    try {
      return { success: true, ...getExtensionStatus() };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Open extension directory in file manager
  ipcMain.handle('extension:openDir', async () => {
    try {
      const dir = getExtensionInstallDir();
      await shell.openPath(dir);
      return { success: true, path: dir };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  });

  // Auto-update extension config when gateway restarts (token/port may change)
  gatewayManager.on('status', (status) => {
    if (status.state === 'running') {
      getSetting('gatewayToken').then(token => {
        const port = status.port || 18789;
        updateExtensionConfig(token, port);
      }).catch(() => { /* ignore */ });
    }
  });
}

/**
 * Automation / event trigger IPC handlers
 */
function registerAutomationHandlers(gatewayManager: GatewayManager): void {
  // Initialize trigger manager with gateway manager access
  triggerManager.init(gatewayManager).catch((err) => {
    console.error('[automation] Failed to init trigger manager:', err);
  });

  ipcMain.handle('automation:list-triggers', async () => {
    return triggerManager.listTriggers();
  });

  ipcMain.handle('automation:create-trigger', async (_, input: EventTriggerCreateInput) => {
    return triggerManager.createTrigger(input);
  });

  ipcMain.handle('automation:update-trigger', async (_, id: string, input: EventTriggerUpdateInput) => {
    return triggerManager.updateTrigger(id, input);
  });

  ipcMain.handle('automation:delete-trigger', async (_, id: string) => {
    return triggerManager.deleteTrigger(id);
  });

  ipcMain.handle('automation:toggle-trigger', async (_, id: string, enabled: boolean) => {
    return triggerManager.toggleTrigger(id, enabled);
  });
}

/**
 * Workflow / task chaining IPC handlers
 */
function registerWorkflowHandlers(gatewayManager: GatewayManager): void {
  // Initialize executor with gateway manager access
  workflowExecutor.init(gatewayManager);

  ipcMain.handle('workflow:list', async () => {
    return workflowStore.listWorkflows();
  });

  ipcMain.handle('workflow:create', async (_, input: WorkflowCreateInput) => {
    const now = new Date().toISOString();
    const workflow = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description,
      enabled: input.enabled ?? true,
      steps: input.steps ?? [],
      edges: input.edges ?? [],
      errorStrategy: input.errorStrategy ?? 'fail-fast',
      createdAt: now,
      updatedAt: now,
    };
    await workflowStore.saveWorkflow(workflow);
    return workflow;
  });

  ipcMain.handle('workflow:update', async (_, id: string, input: WorkflowUpdateInput) => {
    const existing = await workflowStore.getWorkflow(id);
    if (!existing) throw new Error(`Workflow ${id} not found`);

    const updated = {
      ...existing,
      ...input,
      id,
      updatedAt: new Date().toISOString(),
    };
    await workflowStore.saveWorkflow(updated);
    return updated;
  });

  ipcMain.handle('workflow:delete', async (_, id: string) => {
    await workflowStore.deleteWorkflow(id);
  });

  ipcMain.handle('workflow:toggle', async (_, id: string, enabled: boolean) => {
    const existing = await workflowStore.getWorkflow(id);
    if (!existing) throw new Error(`Workflow ${id} not found`);
    const updated = { ...existing, enabled, updatedAt: new Date().toISOString() };
    await workflowStore.saveWorkflow(updated);
    return updated;
  });

  ipcMain.handle('workflow:start', async (_, id: string) => {
    return workflowExecutor.startWorkflow(id);
  });

  ipcMain.handle('workflow:cancel', async (_, instanceId: string) => {
    return workflowExecutor.cancelWorkflow(instanceId);
  });

  ipcMain.handle('workflow:instances', async (_, workflowId?: string) => {
    return workflowStore.listInstances(workflowId);
  });
}

/**
 * Webhook / HTTP API IPC handlers
 */
function registerWebhookHandlers(gatewayManager: GatewayManager): void {
  // Start the HTTP server (enabled flag controls actual listening)
  httpServer.start(gatewayManager).catch((err) => {
    console.error('[webhook] Failed to start HTTP server:', err);
  });

  ipcMain.handle('webhook:list', async () => {
    return webhookStore.listWebhooks();
  });

  ipcMain.handle('webhook:create', async (_, jobId: string, rateLimit?: number) => {
    return webhookStore.createWebhook(jobId, rateLimit);
  });

  ipcMain.handle('webhook:delete', async (_, id: string) => {
    return webhookStore.deleteWebhook(id);
  });

  ipcMain.handle('webhook:regenerate-secret', async (_, id: string) => {
    return webhookStore.regenerateSecret(id);
  });

  ipcMain.handle('webhook:toggle', async (_, id: string, enabled: boolean) => {
    return webhookStore.toggleWebhook(id, enabled);
  });

  ipcMain.handle('webhook:logs', async (_, webhookId: string, limit?: number) => {
    return webhookStore.getLogs(webhookId, limit);
  });

  ipcMain.handle('webhook:server-config', async () => {
    return httpServer.getConfig();
  });

  ipcMain.handle('webhook:update-server-config', async (_, config: Partial<HttpServerConfig>) => {
    return httpServer.updateConfig(config);
  });

  ipcMain.handle('webhook:api-key', async () => {
    return httpServer.getApiKey();
  });

  ipcMain.handle('webhook:regenerate-api-key', async () => {
    return httpServer.regenerateApiKey();
  });
}

/**
 * Built-in browser IPC handlers
 * Tab management, navigation, zoom — operates via BrowserManager
 */
function registerBuiltinBrowserHandlers(mainWindow: BrowserWindow): void {
  browserManager.setMainWindowId(mainWindow.webContents.id);
  automationViews.setMainWindow(mainWindow);

  ipcMain.handle(
    'browser:tab:create',
    (_, params: { id: string; url: string; partition: string; category: string }) => {
      try {
        // Create WebContentsView for automation tabs (type: "page" in CDP)
        const tab = automationViews.createTab(params.id, params.url, params.partition);
        browserManager.createTab(params.id, params.url, params.partition, params.category as 'automation' | 'webauth');
        return { success: true, tab: { id: tab.id, url: tab.url, title: tab.title } };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );

  ipcMain.handle('browser:tab:close', (_, tabId: string) => {
    automationViews.closeTab(tabId);
    browserManager.closeTab(tabId);
    return { success: true };
  });

  ipcMain.handle('browser:tab:navigate', (_, tabId: string, url: string) => {
    automationViews.navigateTab(tabId, url);
    return { success: true };
  });

  ipcMain.handle('browser:tab:goBack', (_, tabId: string) => {
    automationViews.goBack(tabId);
    return { success: true };
  });

  ipcMain.handle('browser:tab:goForward', (_, tabId: string) => {
    automationViews.goForward(tabId);
    return { success: true };
  });

  ipcMain.handle('browser:tab:reload', (_, tabId: string) => {
    automationViews.reload(tabId);
    return { success: true };
  });

  ipcMain.handle('browser:tab:setZoom', (_, tabId: string, factor: number) => {
    automationViews.setZoom(tabId, factor);
    return { success: true };
  });

  ipcMain.handle('browser:tab:setActive', (_, tabId: string) => {
    automationViews.setActiveTab(tabId);
    return { success: true };
  });

  ipcMain.handle('browser:tab:list', () => {
    const tabs = automationViews.getAllTabs().map(t => ({
      id: t.id, url: t.url, title: t.title, partition: t.partition,
    }));
    return { success: true, tabs };
  });

  // Panel bounds — renderer tells main process where to position WebContentsViews
  ipcMain.handle('browser:panel:setBounds', (_, bounds: { x: number; y: number; width: number; height: number }) => {
    automationViews.setPanelBounds(bounds);
    return { success: true };
  });

  ipcMain.handle('browser:cdp:getPort', () => {
    // Will be implemented in Phase 2 when CDP proxy is ready
    return { success: true, port: null };
  });

  ipcMain.handle('browser:cdp:status', () => {
    return {
      success: true,
      running: false,
      port: null,
      targets: browserManager.getExposedTargetIds().size,
    };
  });

  ipcMain.handle('browser:panel:detach', () => {
    // Will be implemented in Phase 5
    return { success: true };
  });

  ipcMain.handle('browser:panel:attach', () => {
    return { success: true };
  });

  ipcMain.handle('browser:panel:isDetached', () => {
    return { success: true, detached: false };
  });

  // ── PDF export (Electron API — works in headed mode unlike CDP) ──

  ipcMain.handle('browser:printToPDF', async (_, tabId?: string) => {
    try {
      let wc: Electron.WebContents | undefined;
      if (tabId) {
        const tab = automationViews.getTab(tabId);
        if (tab) wc = tab.view.webContents;
      }
      if (!wc) {
        const activeId = automationViews.getActiveTabId();
        if (activeId) {
          const tab = automationViews.getTab(activeId);
          if (tab) wc = tab.view.webContents;
        }
      }
      if (!wc) return { success: false, error: 'No active tab for PDF' };

      const buffer = await wc.printToPDF({ printBackground: true });
      return { success: true, data: buffer.toString('base64'), size: buffer.length };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Cookie management ──

  ipcMain.handle('browser:cookies:get', async (_, partition: string, url: string) => {
    const cookies = await getCookies(partition, url);
    return { success: true, cookies };
  });

  ipcMain.handle('browser:cookies:remove', async (_, partition: string, url: string, name: string) => {
    await removeCookie(partition, url, name);
    return { success: true };
  });

  ipcMain.handle('browser:cookies:clear', async (_, partition: string) => {
    await clearPartition(partition);
    return { success: true };
  });

  ipcMain.handle('browser:cookies:export', async (_, partition: string) => {
    const cookies = await exportCookies(partition);
    return { success: true, cookies };
  });

  ipcMain.handle('browser:cookies:import', async (_, partition: string, cookies: CookieData[]) => {
    const count = await importCookies(partition, cookies);
    return { success: true, imported: count };
  });

  // Import cookies from Chrome browser via the relay extension's CDP endpoint
  ipcMain.handle(
    'browser:cookies:import-from-chrome',
    async (_, partition: string, url: string) => {
      try {
        const token = await getSetting('gatewayToken');
        const gatewayPort = (await getSetting('gatewayPort')) || 18789;
        const relayPort = gatewayPort + 3;

        if (!token) {
          return { success: false, error: 'Gateway token not available. Is the gateway running?' };
        }

        // Derive relay token (same HMAC-SHA256 algorithm as extension background-utils.js)
        const hmac = crypto.createHmac('sha256', token);
        hmac.update(`openclaw-extension-relay-v1:${relayPort}`);
        const relayToken = hmac.digest('hex');

        // Connect to the relay's CDP WebSocket endpoint (not /extension)
        // CDP clients send standard { id, method, params } and receive { id, result/error }
        const cdpWsUrl = `ws://127.0.0.1:${relayPort}/cdp?token=${encodeURIComponent(relayToken)}`;

        const { default: WebSocket } = await import('ws');

        const cookies = await new Promise<CookieData[]>((resolveP, rejectP) => {
          const ws = new WebSocket(cdpWsUrl);
          const requestId = 1;
          let settled = false;

          const timeout = setTimeout(() => {
            if (!settled) {
              settled = true;
              try { ws.close(); } catch { /* */ }
              rejectP(new Error('Timeout waiting for cookies from Chrome extension. Is the extension connected?'));
            }
          }, 10000);

          ws.on('error', (err: Error) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              rejectP(new Error(`Relay connection error: ${err.message}`));
            }
          });

          ws.on('close', () => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              rejectP(new Error('Relay connection closed before receiving cookies'));
            }
          });

          ws.on('open', () => {
            // Send custom CDP command — the relay forwards unknown methods to the extension
            ws.send(JSON.stringify({
              id: requestId,
              method: 'CrawBot.getCookies',
              params: { url },
            }));
          });

          ws.on('message', (data: Buffer | string) => {
            try {
              const msg = JSON.parse(String(data));

              // CDP response to our command
              if (typeof msg?.id === 'number' && msg.id === requestId) {
                clearTimeout(timeout);
                settled = true;

                if (msg.error) {
                  try { ws.close(); } catch { /* */ }
                  const errMsg = typeof msg.error === 'object' ? msg.error.message : String(msg.error);
                  rejectP(new Error(`Extension error: ${errMsg}`));
                  return;
                }

                const chromeCookies: CookieData[] = (msg.result?.cookies || []).map(
                  (c: Record<string, unknown>) => ({
                    name: String(c.name || ''),
                    value: String(c.value || ''),
                    domain: String(c.domain || ''),
                    path: String(c.path || '/'),
                    secure: Boolean(c.secure),
                    httpOnly: Boolean(c.httpOnly),
                    sameSite: (c.sameSite as CookieData['sameSite']) || 'unspecified',
                    expirationDate: typeof c.expirationDate === 'number' ? c.expirationDate : undefined,
                  }),
                );
                try { ws.close(); } catch { /* */ }
                resolveP(chromeCookies);
              }
              // Ignore other messages (Target.attachedToTarget events, etc.)
            } catch { /* ignore parse errors */ }
          });
        });

        // Clear existing cookies for the domains being imported,
        // then import fresh ones — ensures no stale/corrupt cookies remain
        const ses = (await import('electron')).session.fromPartition(partition);
        const importDomains = new Set(cookies.map((c: CookieData) => c.domain));
        for (const domain of importDomains) {
          const existing = await ses.cookies.get({ domain });
          for (const c of existing) {
            const cookieUrl = `http${c.secure ? 's' : ''}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`;
            await ses.cookies.remove(cookieUrl, c.name).catch(() => {});
          }
        }

        // Import fresh cookies from Chrome into the requested partition
        const count = await importCookies(partition, cookies);
        logger.info(`[browser:cookies:import-from-chrome] Imported ${count} cookies into ${partition}`);

        // Also sync to related partitions so login works everywhere:
        // - If importing from Chat browser (browser-shared) → also import to matching webauth partition
        // - If importing from WebAuth browser (webauth-*) → also import to browser-shared
        const { WEBAUTH_PROVIDER_PARTITIONS } = await import('../browser/providers/registry');
        const allPartitions = new Set([partition, 'persist:browser-shared', ...Object.values(WEBAUTH_PROVIDER_PARTITIONS)]);
        // Find which webauth partitions match the imported domains
        for (const otherPartition of allPartitions) {
          if (otherPartition === partition) continue; // Already imported
          // Only sync if the URL domain matches a webauth provider's login domain
          const otherSes = (await import('electron')).session.fromPartition(otherPartition);
          // Clear old cookies for imported domains in this partition too
          for (const domain of importDomains) {
            const existing = await otherSes.cookies.get({ domain });
            for (const c of existing) {
              const cookieUrl = `http${c.secure ? 's' : ''}://${(c.domain || '').replace(/^\./, '')}${c.path || '/'}`;
              await otherSes.cookies.remove(cookieUrl, c.name).catch(() => {});
            }
          }
          await importCookies(otherPartition, cookies);
        }
        logger.info(`[browser:cookies:import-from-chrome] Synced cookies to all ${allPartitions.size} partitions`);

        // Also import localStorage from Chrome for this domain
        try {
          const storageResult = await new Promise<{ localStorage: Record<string, string>; sessionStorage: Record<string, string>; indexedDB: Record<string, unknown> }>((resolveS, rejectS) => {
            const ws2 = new WebSocket(cdpWsUrl);
            let settled2 = false;
            const timeout2 = setTimeout(() => { if (!settled2) { settled2 = true; try { ws2.close(); } catch {} rejectS(new Error('timeout')); } }, 15000);
            ws2.on('error', () => { if (!settled2) { settled2 = true; clearTimeout(timeout2); rejectS(new Error('relay error')); } });
            ws2.on('open', () => {
              ws2.send(JSON.stringify({ id: 1, method: 'CrawBot.getStorage', params: { url } }));
            });
            ws2.on('message', (data: Buffer | string) => {
              if (settled2) return;
              try {
                const msg = JSON.parse(String(data));
                if (msg.id === 1) {
                  settled2 = true; clearTimeout(timeout2);
                  try { ws2.close(); } catch {}
                  if (msg.error) { rejectS(new Error('storage error')); return; }
                  resolveS({
                    localStorage: msg.result?.localStorage || {},
                    sessionStorage: msg.result?.sessionStorage || {},
                    indexedDB: msg.result?.indexedDB || {},
                  });
                }
              } catch {}
            });
          });

          const storageData = storageResult.localStorage;
          const ssData = storageResult.sessionStorage;
          const idbData = storageResult.indexedDB;
          const lsKeys = Object.keys(storageData);

          if (lsKeys.length > 0 || Object.keys(ssData).length > 0 || Object.keys(idbData).length > 0) {
            const { automationViews } = await import('../browser/automation-views');
            const { webauthViews } = await import('../browser/webauth-views');

            const hostname = new URL(url).hostname;
            const allTabs = [...automationViews.getAllTabs(), ...webauthViews.getAllTabs()];
            for (const tab of allTabs) {
              try {
                const tabUrl = tab.view.webContents.getURL();
                if (tabUrl.includes(hostname) && !tab.view.webContents.isDestroyed()) {
                  // Import localStorage + sessionStorage
                  await tab.view.webContents.executeJavaScript(`
                    (function() {
                      const ls = ${JSON.stringify(storageData)};
                      for (const [k, v] of Object.entries(ls)) {
                        try { localStorage.setItem(k, v); } catch {}
                      }
                      const ss = ${JSON.stringify(ssData)};
                      for (const [k, v] of Object.entries(ss)) {
                        try { sessionStorage.setItem(k, v); } catch {}
                      }
                      return { ls: Object.keys(ls).length, ss: Object.keys(ss).length };
                    })()
                  `);

                  // Import IndexedDB data
                  if (Object.keys(idbData).length > 0) {
                    await tab.view.webContents.executeJavaScript(`
                      (async function() {
                        const idbData = ${JSON.stringify(idbData)};
                        for (const [dbName, dbInfo] of Object.entries(idbData)) {
                          try {
                            const db = await new Promise((resolve, reject) => {
                              const req = indexedDB.open(dbName, dbInfo.version || 1);
                              req.onupgradeneeded = (e) => {
                                const db = e.target.result;
                                for (const storeName of Object.keys(dbInfo.stores || {})) {
                                  if (!db.objectStoreNames.contains(storeName)) {
                                    db.createObjectStore(storeName);
                                  }
                                }
                              };
                              req.onsuccess = () => resolve(req.result);
                              req.onerror = () => reject(req.error);
                            });
                            for (const [storeName, storeData] of Object.entries(dbInfo.stores || {})) {
                              try {
                                const tx = db.transaction(storeName, 'readwrite');
                                const store = tx.objectStore(storeName);
                                const keys = storeData.keys || [];
                                const values = storeData.values || [];
                                for (let i = 0; i < values.length; i++) {
                                  store.put(values[i], keys[i] !== undefined ? keys[i] : i);
                                }
                              } catch {}
                            }
                            db.close();
                          } catch {}
                        }
                      })()
                    `);
                  }
                }
              } catch { /* tab might not be ready */ }
            }
            logger.info(`[browser:cookies:import-from-chrome] Imported storage: ${lsKeys.length} localStorage, ${Object.keys(ssData).length} sessionStorage, ${Object.keys(idbData).length} IndexedDB databases`);
          }
        } catch (storageErr) {
          // localStorage import is best-effort — don't fail the whole import
          logger.warn(`[browser:cookies:import-from-chrome] localStorage import skipped: ${String(storageErr)}`);
        }

        return { success: true, imported: count };
      } catch (error) {
        logger.error(`[browser:cookies:import-from-chrome] ${String(error)}`);
        return { success: false, error: String(error) };
      }
    },
  );
}

/**
 * WebAuth provider IPC handlers
 */
function registerWebAuthHandlers(): void {
  ipcMain.handle('webauth:provider:add', async (_, _providerId: string) => {
    // Provider registration is handled in renderer store
    // Trigger pipeline re-check after a delay (cookies may not be imported yet)
    setTimeout(async () => {
      try {
        const { getWebAuthPipeline } = await import('../browser/webauth-pipeline');
        const pipeline = getWebAuthPipeline();
        if (!pipeline.isProxyRunning()) await pipeline.initialize();
        else await pipeline.checkAllProviders();
      } catch { /* ignore */ }
    }, 2000);
    return { success: true };
  });

  ipcMain.handle('webauth:provider:remove', async (_, providerId: string) => {
    // Clear the partition data
    const { clearPartition: clearPart } = await import('../browser/cookie-manager');
    const partitionMap: Record<string, string> = {
      'claude-web': 'persist:webauth-claude',
      'chatgpt-web': 'persist:webauth-chatgpt',
      'deepseek-web': 'persist:webauth-deepseek',
      'gemini-web': 'persist:webauth-gemini',
      'grok-web': 'persist:webauth-grok',
      'qwen-intl-web': 'persist:webauth-qwen-intl',
      'qwen-china-web': 'persist:webauth-qwen-china',
      'kimi-web': 'persist:webauth-kimi',
      'doubao-web': 'persist:webauth-doubao',
      'glm-china-web': 'persist:webauth-glm-china',
      'glm-intl-web': 'persist:webauth-glm-intl',
      'manus-api': 'persist:webauth-manus',
    };
    const partition = partitionMap[providerId];
    if (partition) {
      await clearPart(partition);
    }
    return { success: true };
  });

  ipcMain.handle('webauth:provider:login', (_, _providerId: string) => {
    // Login is handled via browser panel in renderer (opens webview tab)
    // After user finishes login and imports cookies, re-check auth
    return { success: true };
  });

  // Trigger pipeline re-check after cookie import (called from BrowserToolbar import button)
  // This ensures provider status + models update immediately after import
  ipcMain.handle('webauth:pipeline:refresh', async () => {
    try {
      const { getWebAuthPipeline } = await import('../browser/webauth-pipeline');
      const pipeline = getWebAuthPipeline();
      if (!pipeline.isProxyRunning()) {
        pipeline.setMainWindow(BrowserWindow.getAllWindows()[0]);
        await pipeline.initialize();
      } else {
        await pipeline.checkAllProviders();
      }
      return { success: true, port: pipeline.getProxyPort() };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('webauth:provider:check', async (_, providerId: string) => {
    try {
      const { getWebAuthPipeline } = await import('../browser/webauth-pipeline');
      const result = await getWebAuthPipeline().checkProvider(providerId);
      return { success: true, status: result.status };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('webauth:provider:check-all', async () => {
    try {
      const { getWebAuthPipeline } = await import('../browser/webauth-pipeline');
      await getWebAuthPipeline().checkAllProviders();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('webauth:proxy:start', async () => {
    try {
      const { getWebAuthPipeline } = await import('../browser/webauth-pipeline');
      const pipeline = getWebAuthPipeline();
      await pipeline.initialize();
      return { success: true, port: pipeline.getProxyPort() };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('webauth:proxy:stop', async () => {
    try {
      const { getWebAuthPipeline } = await import('../browser/webauth-pipeline');
      await getWebAuthPipeline().shutdown();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('webauth:proxy:status', async () => {
    const { getWebAuthPipeline } = await import('../browser/webauth-pipeline');
    const pipeline = getWebAuthPipeline();
    return {
      success: true,
      running: pipeline.isProxyRunning(),
      port: pipeline.getProxyPort(),
    };
  });
}

/**
 * WebAuth Browser IPC handlers (independent from Chat browser)
 * Tab management, navigation, zoom — operates via WebAuthViewManager
 */
function registerWebAuthBrowserHandlers(mainWindow: BrowserWindow): void {
  webauthViews.setMainWindow(mainWindow);

  ipcMain.handle(
    'webauth:browser:tab:create',
    (_, params: { id: string; url: string; partition: string }) => {
      try {
        const tab = webauthViews.createTab(params.id, params.url, params.partition);
        return { success: true, tab: { id: tab.id, url: tab.url, title: tab.title } };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    }
  );

  ipcMain.handle('webauth:browser:tab:close', (_, tabId: string) => {
    webauthViews.closeTab(tabId);
    return { success: true };
  });

  ipcMain.handle('webauth:browser:tab:navigate', (_, tabId: string, url: string) => {
    webauthViews.navigateTab(tabId, url);
    return { success: true };
  });

  ipcMain.handle('webauth:browser:tab:goBack', (_, tabId: string) => {
    webauthViews.goBack(tabId);
    return { success: true };
  });

  ipcMain.handle('webauth:browser:tab:goForward', (_, tabId: string) => {
    webauthViews.goForward(tabId);
    return { success: true };
  });

  ipcMain.handle('webauth:browser:tab:reload', (_, tabId: string) => {
    webauthViews.reload(tabId);
    return { success: true };
  });

  ipcMain.handle('webauth:browser:tab:setZoom', (_, tabId: string, factor: number) => {
    webauthViews.setZoom(tabId, factor);
    return { success: true };
  });

  ipcMain.handle('webauth:browser:tab:setActive', (_, tabId: string) => {
    webauthViews.setActiveTab(tabId);
    return { success: true };
  });

  ipcMain.handle('webauth:browser:panel:setBounds', (_, bounds: { x: number; y: number; width: number; height: number }) => {
    webauthViews.setPanelBounds(bounds);
    return { success: true };
  });

  // Google login completed in renderer <webview> — reload WebContentsView
  ipcMain.handle('webauth:browser:google-login-done', (_, tabId: string, providerUrl: string) => {
    webauthViews.reloadAfterGoogleLogin(tabId, providerUrl);
    return { success: true };
  });
}
