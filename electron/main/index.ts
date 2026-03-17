/**
 * Electron Main Process Entry
 * Manages window creation, system tray, and IPC handlers
 */
import { app, BrowserWindow, clipboard, Menu, nativeImage, net, protocol, session } from 'electron';
import { join } from 'path';
import { pathToFileURL } from 'node:url';
import { statSync, createReadStream } from 'node:fs';
import { GatewayManager } from '../gateway/manager';
import { registerIpcHandlers } from './ipc-handlers';
import { createTray } from './tray';
import { createMenu } from './menu';

import { getAppUpdater, registerUpdateHandlers } from './updater';
import { logger } from '../utils/logger';
import { openExternalInDefaultProfile } from '../utils/open-external';
import { warmupNetworkOptimization } from '../utils/uv-env';
import { getSetting, setSetting } from '../utils/store';
import { setAutoStart } from '../utils/autostart';
import {
  setToolsAutoApprove, getToolsAutoApproveFromConfig,
  setSessionDmScope, getSessionDmScopeFromConfig,
} from '../utils/agent-config';

import { ClawHubService } from '../gateway/clawhub';
import { ensureManagedBinInProcessPath } from '../utils/nodejs-setup';

// Disable GPU acceleration for better compatibility
app.disableHardwareAcceleration();

// Enable CDP (Chrome DevTools Protocol) on internal port for browser automation
// The CDP Filter Proxy (port 9333) will filter and relay to this internal port
app.commandLine.appendSwitch('remote-debugging-port', '9222');

// Register 'local-file' as a privileged scheme so it can be used in <iframe>, <img>, <video>, <audio>.
// Must be called before app.whenReady().
// NOTE: `standard: true` enables proper URL parsing. We use "localhost" as the host component
// so Chromium's authority parsing lowercases "localhost" (harmless) instead of the file path.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'local-file',
    privileges: {
      standard: true,       // standard URL parsing (scheme://host/path)
      secure: true,
      supportFetchAPI: true,
      stream: true,         // enables Range requests for video/audio seeking
      bypassCSP: true,
    },
  },
]);

// Global references
let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
const gatewayManager = new GatewayManager();
const clawHubService = new ClawHubService();

/**
 * Resolve the icons directory path (works in both dev and packaged mode)
 */
function getIconsDir(): string {
  if (app.isPackaged) {
    // Packaged: icons are in extraResources → process.resourcesPath/resources/icons
    return join(process.resourcesPath, 'resources', 'icons');
  }
  // Development: relative to dist-electron/main/
  return join(__dirname, '../../resources/icons');
}

/**
 * Get the app icon for the current platform
 */
function getAppIcon(): Electron.NativeImage | undefined {
  if (process.platform === 'darwin') return undefined; // macOS uses the app bundle icon

  const iconsDir = getIconsDir();
  const iconPath =
    process.platform === 'win32'
      ? join(iconsDir, 'icon.ico')
      : join(iconsDir, 'icon.png');
  const icon = nativeImage.createFromPath(iconPath);
  return icon.isEmpty() ? undefined : icon;
}

/**
 * Create the main application window
 */
function createWindow(startMinimized = false): BrowserWindow {
  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    icon: getAppIcon(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      webviewTag: true, // Enable <webview> for embedding OpenClaw Control UI
    },
    titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
    trafficLightPosition: isMac ? { x: 16, y: 16 } : undefined,
    frame: isMac,
    show: false,
  });

  // Show window when ready (unless starting minimized to tray)
  win.once('ready-to-show', () => {
    if (!startMinimized) {
      win.show();
    }
  });

  // Handle external links — use default profile to avoid OpenClaw's Chrome profile
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalInDefaultProfile(url);
    return { action: 'deny' };
  });

  // Enable right-click context menu with standard editing actions
  win.webContents.on('context-menu', (_event, params) => {
    const menuItems: Electron.MenuItemConstructorOptions[] = [];

    // Spell-check suggestions
    if (params.misspelledWord && params.dictionarySuggestions.length > 0) {
      for (const suggestion of params.dictionarySuggestions) {
        menuItems.push({
          label: suggestion,
          click: () => win.webContents.replaceMisspelling(suggestion),
        });
      }
      menuItems.push({ type: 'separator' });
    }

    // Text editing actions (shown when right-clicking an editable field)
    if (params.isEditable) {
      menuItems.push(
        { label: 'Undo', role: 'undo', enabled: params.editFlags.canUndo },
        { label: 'Redo', role: 'redo', enabled: params.editFlags.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Paste', role: 'paste', enabled: params.editFlags.canPaste },
        { label: 'Select All', role: 'selectAll', enabled: params.editFlags.canSelectAll },
      );
    } else if (params.selectionText) {
      // Non-editable area with selected text
      menuItems.push(
        { label: 'Copy', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Select All', role: 'selectAll' },
      );
    }

    // Link actions
    if (params.linkURL) {
      if (menuItems.length > 0) menuItems.push({ type: 'separator' });
      menuItems.push(
        {
          label: 'Open Link in Browser',
          click: () => openExternalInDefaultProfile(params.linkURL),
        },
        {
          label: 'Copy Link Address',
          click: () => clipboard.writeText(params.linkURL),
        },
      );
    }

    if (menuItems.length > 0) {
      Menu.buildFromTemplate(menuItems).popup();
    }
  });

  // Load the app
  if (process.env.VITE_DEV_SERVER_URL) {
    win.loadURL(process.env.VITE_DEV_SERVER_URL);
    win.webContents.openDevTools();
  } else {
    win.loadFile(join(__dirname, '../../dist/index.html'));
  }

  return win;
}

/**
 * Initialize the application
 */
async function initialize(): Promise<void> {
  // Initialize logger first
  logger.init();
  logger.info('=== CrawBot Application Starting ===');
  logger.debug(
    `Runtime: platform=${process.platform}/${process.arch}, electron=${process.versions.electron}, node=${process.versions.node}, packaged=${app.isPackaged}`
  );

  // Prepend managed Node.js bin dir to process.env.PATH so all main-process code
  // (OAuth flows, CLI tool lookups, etc.) can find managed tools like gemini, claude, codex.
  // Also called again after Node.js/CLI tool installation for first-run scenarios.
  ensureManagedBinInProcessPath();

  // Warm up network optimization (non-blocking)
  void warmupNetworkOptimization();

  // Sync autostart with OS on every launch (ensures .desktop file matches setting)
  const launchAtStartup = await getSetting('launchAtStartup');
  setAutoStart(launchAtStartup);

  // Sync tools.exec: openclaw.json is source of truth.
  // If configured in openclaw.json → sync back to electron-store.
  // If not yet configured (first install) → write defaults from electron-store.
  const configToolsAutoApprove = getToolsAutoApproveFromConfig();
  if (configToolsAutoApprove !== undefined) {
    await setSetting('toolsAutoApprove', configToolsAutoApprove);
  } else {
    const toolsAutoApprove = await getSetting('toolsAutoApprove');
    setToolsAutoApprove(toolsAutoApprove);
  }

  // Sync session.dmScope: openclaw.json is source of truth.
  const configSessionDmScope = getSessionDmScopeFromConfig();
  if (configSessionDmScope !== undefined) {
    await setSetting('sessionDmScope', configSessionDmScope);
  } else {
    const sessionDmScope = await getSetting('sessionDmScope');
    setSessionDmScope(sessionDmScope as 'main' | 'per-peer' | 'per-channel-peer' | 'per-account-channel-peer');
  }

  // Determine if window should start hidden
  const startMinimized =
    process.argv.includes('--minimized') || (await getSetting('startMinimized'));

  // Set application menu
  createMenu();

  // Create the main window
  mainWindow = createWindow(startMinimized);

  // Create system tray
  createTray(mainWindow);

  // Inject OpenRouter site headers (HTTP-Referer & X-Title) for rankings on openrouter.ai
  session.defaultSession.webRequest.onBeforeSendHeaders(
    { urls: ['https://openrouter.ai/*'] },
    (details, callback) => {
      details.requestHeaders['HTTP-Referer'] = 'https://crawbot.app';
      details.requestHeaders['X-Title'] = 'CrawBot';
      callback({ requestHeaders: details.requestHeaders });
    },
  );

  // Override security headers ONLY for the OpenClaw Gateway Control UI
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const isGatewayUrl = details.url.includes('127.0.0.1:18789') || details.url.includes('localhost:18789');

    if (!isGatewayUrl) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }

    const headers = { ...details.responseHeaders };
    delete headers['X-Frame-Options'];
    delete headers['x-frame-options'];
    if (headers['Content-Security-Policy']) {
      headers['Content-Security-Policy'] = headers['Content-Security-Policy'].map(
        (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
      );
    }
    if (headers['content-security-policy']) {
      headers['content-security-policy'] = headers['content-security-policy'].map(
        (csp) => csp.replace(/frame-ancestors\s+'none'/g, "frame-ancestors 'self' *")
      );
    }
    callback({ responseHeaders: headers });
  });

  // Register IPC handlers
  registerIpcHandlers(gatewayManager, clawHubService, mainWindow);

  // Register update handlers
  registerUpdateHandlers(getAppUpdater(), mainWindow, {
    onBeforeQuit: () => { isQuitting = true; },
  });

  // Note: Auto-check for updates is driven by the renderer (update store init)
  // so it respects the user's "Auto-check for updates" setting.

  // Minimize to tray on close instead of quitting (all platforms)
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Start CDP proxy (9333) → intercepts Target.createTarget + Page.printToPDF
  // then relays everything else to Electron's real CDP (9222)
  // Only set browser config if useBuiltinBrowser is enabled (default: true)
  try {
    const { startCdpProxy } = await import('../browser/cdp-proxy');
    await startCdpProxy(9333, 9222);
    logger.info('CDP proxy started on port 9333 → real CDP 9222');

    const { getUseBuiltinBrowserFromConfig } = await import('../utils/agent-config');
    const useBuiltinBrowser = getUseBuiltinBrowserFromConfig();

    if (useBuiltinBrowser) {
      const { setOpenClawBrowserConfig } = await import('../utils/browser-config');
      setOpenClawBrowserConfig(9333);
      logger.info('Browser config set: CDP proxy on port 9333');
    } else {
      logger.info('Builtin browser disabled — skipping browser config (using Chrome / extension)');
    }

    // Start CDP focus monitor to sync tab switches from Playwright/agent
    const { startCdpFocusMonitor } = await import('../browser/cdp-focus-monitor');
    startCdpFocusMonitor(9222).catch(() => {});
  } catch (err) {
    logger.warn('Browser config / CDP proxy failed:', err);
  }

  // Start Gateway automatically
  try {
    logger.debug('Auto-starting Gateway...');
    await gatewayManager.start();
    logger.info('Gateway auto-start succeeded');

    // Inject CrawBot context into AGENTS.md after workspace files settle
    setTimeout(async () => {
      try {
        const { injectCrawBotContext } = await import('../utils/agents-md-injection');
        await injectCrawBotContext();
      } catch (err) {
        logger.warn('Failed to inject CrawBot context:', err);
      }
    }, 5000);

    // Auto-start WebAuth pipeline after Gateway is ready
    setTimeout(async () => {
      try {
        const { getWebAuthPipeline } = await import('../browser/webauth-pipeline');
        const pipeline = getWebAuthPipeline();
        pipeline.setMainWindow(mainWindow!);
        pipeline.setGatewayRestartFn(() => gatewayManager.restart());
        await pipeline.initialize();
        logger.info('WebAuth pipeline auto-start succeeded');
      } catch (err) {
        logger.error('[WebAuth] Pipeline init failed:', err);
      }
    }, 3000);
  } catch (error) {
    logger.error('Gateway auto-start failed:', error);
    mainWindow?.webContents.send('gateway:error', String(error));
  }
}

// Force consistent app name so dev and prod use the same userData path
// (package.json name="crawbot" vs electron-builder productName="CrawBot")
app.setName('CrawBot');

/** Simple MIME type lookup for the local-file protocol handler */
function getMimeType(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  const mimeMap: Record<string, string> = {
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', aac: 'audio/aac', m4a: 'audio/mp4',
    pdf: 'application/pdf',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  };
  return mimeMap[ext] || 'application/octet-stream';
}

// Application lifecycle
app.whenReady().then(() => {
  // Register local-file:// protocol handler to serve local files for the workspace viewer.
  // URLs use local-file://localhost/<path> format. We parse the pathname, decode it, and
  // convert back to a file:// URL via pathToFileURL for correct cross-platform handling.
  protocol.handle('local-file', (request) => {
    // URL format: local-file://localhost/Users/x/file.pdf (macOS/Linux)
    //             local-file://localhost/C:/Users/x/file.pdf (Windows)
    const parsed = new URL(request.url);
    const filePath = decodeURIComponent(parsed.pathname);

    // Support Range requests for video/audio seeking
    const rangeHeader = request.headers.get('Range');
    if (rangeHeader) {
      const stat = statSync(filePath);
      const fileSize = stat.size;
      const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      const start = match ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? parseInt(match[2], 10) : fileSize - 1;
      const chunkSize = end - start + 1;

      const stream = createReadStream(filePath, { start, end });
      const readable = new ReadableStream({
        start(controller) {
          stream.on('data', (chunk: Buffer) => controller.enqueue(chunk));
          stream.on('end', () => controller.close());
          stream.on('error', (err) => controller.error(err));
        },
        cancel() { stream.destroy(); },
      });

      return new Response(readable, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${fileSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': String(chunkSize),
          'Content-Type': getMimeType(filePath),
        },
      });
    }

    // Non-range: serve full file via net.fetch
    return net.fetch(pathToFileURL(filePath).href);
  });

  initialize();

  // Register activate handler AFTER app is ready to prevent
  // "Cannot create BrowserWindow before app is ready" on macOS.
  app.on('activate', () => {
    if (mainWindow) {
      mainWindow.show();
    } else if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  isQuitting = true;
  // Clean up browser config from openclaw.json so CLI mode works standalone
  try {
    const { removeOpenClawBrowserConfig } = await import('../utils/browser-config');
    removeOpenClawBrowserConfig();
  } catch { /* ignore */ }
  // Stop WebAuth pipeline
  try {
    const { getWebAuthPipeline } = await import('../browser/webauth-pipeline');
    await getWebAuthPipeline().shutdown();
  } catch { /* ignore */ }
  // Stop CDP proxy
  try {
    const { stopCdpProxy } = await import('../browser/cdp-proxy');
    await stopCdpProxy();
  } catch { /* ignore */ }
  // Clean up LibreOffice conversion temp files
  const { cleanupTempDirs } = await import('../utils/libreoffice');
  cleanupTempDirs();
  await gatewayManager.stop();
});

// Export for testing
export { mainWindow, gatewayManager };
