/**
 * Preload Script
 * Exposes safe APIs to the renderer process via contextBridge
 */
import { contextBridge, ipcRenderer } from 'electron';

/**
 * IPC renderer methods exposed to the renderer process
 */
const electronAPI = {
  /**
   * IPC invoke (request-response pattern)
   */
  ipcRenderer: {
    invoke: (channel: string, ...args: unknown[]) => {
      const validChannels = [
        // Gateway
        'gateway:status',
        'gateway:isConnected',
        'gateway:start',
        'gateway:stop',
        'gateway:restart',
        'gateway:rpc',
        'gateway:health',
        'gateway:getControlUiUrl',
        // OpenClaw
        'openclaw:status',
        'openclaw:isReady',
        // Shell
        'shell:openExternal',
        'shell:showItemInFolder',
        'shell:openPath',
        // Dialog
        'dialog:open',
        'dialog:save',
        'dialog:message',
        // App
        'app:version',
        'app:name',
        'app:getPath',
        'app:platform',
        'app:quit',
        'app:relaunch',
        'app:setAutoStart',
        'app:setStartMinimized',
        'app:setToolsAutoApprove',
        'app:setSessionDmScope',
        'app:setScreenshotMaxSide',
        'app:setUseBuiltinBrowser',
        'app:getOpenclawSettings',
        // Window controls
        'window:minimize',
        'window:maximize',
        'window:close',
        'window:isMaximized',
        // Settings
        'settings:get',
        'settings:set',
        'settings:getAll',
        'settings:reset',
        // Update
        'update:status',
        'update:version',
        'update:check',
        'update:download',
        'update:install',
        'update:setChannel',
        'update:setAutoDownload',
        // Env
        'env:getConfig',
        'env:setApiKey',
        'env:deleteApiKey',
        // Provider
        'provider:list',
        'provider:get',
        'provider:save',
        'provider:delete',
        'provider:setApiKey',
        'provider:updateWithKey',
        'provider:deleteApiKey',
        'provider:hasApiKey',
        'provider:getApiKey',
        'provider:setDefault',
        'provider:getDefault',
        'provider:validateKey',
        'provider:fetchModels',
        'provider:pasteSetupToken',
        'provider:oauthLogin',
        'provider:oauthCancel',
        // Cron
        'cron:list',
        'cron:create',
        'cron:update',
        'cron:delete',
        'cron:toggle',
        'cron:trigger',
        'cron:runs',
        // Automation / Event Triggers
        'automation:list-triggers',
        'automation:create-trigger',
        'automation:update-trigger',
        'automation:delete-trigger',
        'automation:toggle-trigger',
        // Workflows / Task Chaining
        'workflow:list',
        'workflow:create',
        'workflow:update',
        'workflow:delete',
        'workflow:toggle',
        'workflow:start',
        'workflow:cancel',
        'workflow:instances',
        // Channel Config
        'channel:saveConfig',
        'channel:getConfig',
        'channel:getFormValues',
        'channel:deleteConfig',
        'channel:listConfigured',
        'channel:setEnabled',
        'channel:getEnabledMap',
        'channel:validate',
        'channel:validate',
        'channel:validateCredentials',
        // Channel Accounts & Bindings
        'channel:saveAccountConfig',
        'channel:deleteAccountConfig',
        'channel:getAccountFormValues',
        'channel:listAccounts',
        'binding:get',
        'binding:set',
        'binding:remove',
        // Pairing
        'pairing:list',
        'pairing:approve',
        'pairing:reject',
        // WhatsApp
        'channel:requestWhatsAppQr',
        'channel:cancelWhatsAppQr',
        // Zalo Personal
        'channel:requestOpenZaloQr',
        'channel:cancelOpenZaloQr',
        // ClawHub
        'clawhub:search',
        'clawhub:install',
        'clawhub:uninstall',
        'clawhub:list',
        'clawhub:openSkillReadme',
        // UV
        'uv:check',
        'uv:install-all',
        // Node.js & CLI tools
        'nodejs:check',
        'nodejs:install',
        'nodejs:checkCliTools',
        'nodejs:installCliTools',
        'nodejs:installSingleCliTool',
        // PATH persistence, Python, Build tools
        'path:isPersisted',
        'path:persist',
        'path:symlinkPython',
        'path:getManagedBinDir',
        'python:getBinDir',
        'buildtools:check',
        'buildtools:install',
        // Skill config (direct file access)
        'skill:updateConfig',
        'skill:getConfig',
        'skill:getAllConfigs',
        'skill:import',
        // Agent config (direct file access)
        'agent:list',
        'agent:get',
        'agent:create',
        'agent:update',
        'agent:delete',
        'agent:getWorkspaceFiles',
        'agent:readFile',
        'agent:writeFile',
        'agent:listChannels',
        'agent:listFolders',
        'agent:createFolder',
        // Logs
        'log:getRecent',
        'log:readFile',
        'log:getFilePath',
        'log:getDir',
        'log:listFiles',
        // File browser
        'file:listDir',
        'file:readAny',
        'file:writeAny',
        'file:copy',
        'file:move',
        'file:delete',
        'file:create',
        'file:createDir',
        'file:getLocalUrl',
        'file:convertOffice',
        'file:watch',
        'file:unwatch',
        // File staging & media
        'file:stage',
        'file:stageBuffer',
        'media:getThumbnails',
        'media:saveImage',
        // Chat send with media (reads staged files in main process)
        'chat:sendWithMedia',
        // Config bundle export/import
        'config:export',
        'config:import',
        // Workspace archive export/import
        'workspace:export',
        'workspace:import',
        // OpenClaw extras
        'openclaw:getDir',
        'openclaw:getConfigDir',
        'openclaw:getSkillsDir',
        'openclaw:getCliCommand',
        'openclaw:installCliMac',
        'openclaw:getSlashCommands',
        // Browser extension
        'extension:install',
        'extension:status',
        'extension:openDir',
        // Webhook / HTTP API
        'webhook:list',
        'webhook:create',
        'webhook:delete',
        'webhook:regenerate-secret',
        'webhook:toggle',
        'webhook:logs',
        'webhook:server-config',
        'webhook:update-server-config',
        'webhook:api-key',
        'webhook:regenerate-api-key',

        // Browser
        'browser:tab:create',
        'browser:tab:close',
        'browser:tab:navigate',
        'browser:tab:goBack',
        'browser:tab:goForward',
        'browser:tab:reload',
        'browser:tab:setZoom',
        'browser:tab:setActive',
        'browser:tab:list',
        'browser:cookies:get',
        'browser:cookies:remove',
        'browser:cookies:clear',
        'browser:cookies:clear-site-data',
        'browser:cookies:export',
        'browser:cookies:import',
        'browser:cookies:import-from-chrome',
        'browser:cdp:getPort',
        'browser:cdp:status',
        'browser:panel:detach',
        'browser:panel:attach',
        'browser:panel:isDetached',
        'browser:panel:setBounds',
        'browser:printToPDF',

        // WebAuth Browser (independent from Chat browser)
        'webauth:browser:tab:create',
        'webauth:browser:tab:close',
        'webauth:browser:tab:navigate',
        'webauth:browser:tab:goBack',
        'webauth:browser:tab:goForward',
        'webauth:browser:tab:reload',
        'webauth:browser:tab:setZoom',
        'webauth:browser:tab:setActive',
        'webauth:browser:panel:setBounds',
        'webauth:browser:google-login-done',

        // WebAuth Providers
        'webauth:provider:add',
        'webauth:provider:remove',
        'webauth:provider:login',
        'webauth:provider:check',
        'webauth:provider:check-all',
        'webauth:pipeline:refresh',
        'webauth:proxy:start',
        'webauth:proxy:stop',
        'webauth:proxy:status',
      ];

      if (validChannels.includes(channel)) {
        return ipcRenderer.invoke(channel, ...args);
      }

      throw new Error(`Invalid IPC channel: ${channel}`);
    },

    /**
     * Listen for events from main process
     */
    on: (channel: string, callback: (...args: unknown[]) => void) => {
      const validChannels = [
        'gateway:status-changed',
        'gateway:message',
        'gateway:notification',
        'gateway:channel-status',
        'gateway:chat-message',
        'gateway:agent-event',
        'channel:whatsapp-qr',
        'channel:whatsapp-success',
        'channel:whatsapp-error',
        'channel:openzalo-qr',
        'channel:openzalo-success',
        'channel:openzalo-error',
        'gateway:exit',
        'gateway:error',
        'navigate',
        'update:status-changed',
        'update:checking',
        'update:available',
        'update:not-available',
        'update:progress',
        'update:downloaded',
        'update:error',
        'cron:updated',
        'file:changed',
        'browser:tab:updated',
        'browser:tab:created',
        'browser:tab:closed',
        'browser:tab:activated',
        'browser:tab:session-tagged',
        'webauth:browser:tab:created',
        'webauth:browser:tab:updated',
        'webauth:browser:tab:activated',
        'webauth:browser:tab:closed',
        'webauth:browser:google-login',
        'webauth:provider:status-changed',
        'webauth:provider:session-expired',
        'webauth:proxy:started',
        'oauth:token-refreshed',
      ];

      if (validChannels.includes(channel)) {
        // Wrap the callback to strip the event
        const subscription = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
          callback(...args);
        };
        ipcRenderer.on(channel, subscription);

        // Return unsubscribe function
        return () => {
          ipcRenderer.removeListener(channel, subscription);
        };
      }

      throw new Error(`Invalid IPC channel: ${channel}`);
    },

    /**
     * Listen for a single event from main process
     */
    once: (channel: string, callback: (...args: unknown[]) => void) => {
      const validChannels = [
        'gateway:status-changed',
        'gateway:message',
        'gateway:notification',
        'gateway:channel-status',
        'gateway:chat-message',
        'gateway:agent-event',
        'gateway:exit',
        'gateway:error',
        'navigate',
        'update:status-changed',
        'update:checking',
        'update:available',
        'update:not-available',
        'update:progress',
        'update:downloaded',
        'update:error',
      ];

      if (validChannels.includes(channel)) {
        ipcRenderer.once(channel, (_event, ...args) => callback(...args));
        return;
      }

      throw new Error(`Invalid IPC channel: ${channel}`);
    },

    /**
     * Remove all listeners for a channel
     */
    off: (channel: string, callback?: (...args: unknown[]) => void) => {
      if (callback) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ipcRenderer.removeListener(channel, callback as any);
      } else {
        ipcRenderer.removeAllListeners(channel);
      }
    },
  },

  /**
   * Open external URL in default browser
   */
  openExternal: (url: string) => {
    return ipcRenderer.invoke('shell:openExternal', url);
  },

  /**
   * Get current platform
   */
  platform: process.platform,

  /**
   * Check if running in development
   */
  isDev: process.env.NODE_ENV === 'development' || !!process.env.VITE_DEV_SERVER_URL,
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('electron', electronAPI);

// Type declarations for the renderer process
export type ElectronAPI = typeof electronAPI;
