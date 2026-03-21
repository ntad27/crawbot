/**
 * WebAuth Pipeline — Central orchestrator for web-authenticated AI models
 *
 * Connects: User login (browser) -> Cookie detection -> WebAuth Proxy (OpenAI-compatible)
 *           -> Provider implementations -> Agent uses models
 *
 * On initialization:
 * 1. Creates all provider instances
 * 2. Starts the WebAuth proxy (OpenAI-compatible HTTP server)
 * 3. Checks cookie auth for all providers
 * 4. Provisions hidden WebContentsView tabs for authenticated providers
 * 5. Registers authenticated models with OpenClaw via openclaw.json
 * 6. Runs periodic health checks to detect expired sessions
 */

import { logger } from '../utils/logger';
import { createWebAuthProxy, getWebAuthProxy } from './webauth-proxy';
import type { WebAuthProxy } from './webauth-proxy';
import { webauthViews } from './webauth-views';
import { WebContentsViewAdapter } from './providers/wcv-adapter';
import { checkProviderAuth } from './providers/cookie-auth-checker';
import { setOpenClawWebAuthConfig, removeOpenClawWebAuthConfig } from '../utils/browser-config';
import type { WebProvider } from './providers/types';
import type { BrowserWindow } from 'electron';

// Import all provider classes
import { ClaudeWebProvider } from './providers/claude-web';
import { DeepSeekWebProvider } from './providers/deepseek-web';
import { ChatGPTWebProvider } from './providers/chatgpt-web';
import { GeminiWebProvider } from './providers/gemini-web';
import { GrokWebProvider } from './providers/grok-web';
import { QwenIntlWebProvider } from './providers/qwen-intl-web';
import { QwenChinaWebProvider } from './providers/qwen-china-web';
import { KimiWebProvider } from './providers/kimi-web';
import { DoubaoWebProvider } from './providers/doubao-web';
import { GlmChinaWebProvider } from './providers/glm-china-web';
import { GlmIntlWebProvider } from './providers/glm-intl-web';
import { ManusApiProvider } from './providers/manus-api';

const LOG_TAG = '[WebAuth-Pipeline]';

class WebAuthPipeline {
  private proxy: WebAuthProxy | null = null;
  private providers = new Map<string, WebProvider>();
  private adapters = new Map<string, WebContentsViewAdapter>();
  private healthCheckInterval: NodeJS.Timeout | null = null;
  private mainWindow: BrowserWindow | null = null;
  private initialized = false;

  setMainWindow(win: BrowserWindow): void {
    this.mainWindow = win;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    logger.info(`${LOG_TAG} Initializing...`);

    // 1. Create and register all providers
    const allProviders: WebProvider[] = [
      new ClaudeWebProvider(),
      new DeepSeekWebProvider(),
      new ChatGPTWebProvider(),
      new GeminiWebProvider(),
      new GrokWebProvider(),
      new QwenIntlWebProvider(),
      new QwenChinaWebProvider(),
      new KimiWebProvider(),
      new DoubaoWebProvider(),
      new GlmChinaWebProvider(),
      new GlmIntlWebProvider(),
      new ManusApiProvider(),
    ];
    for (const p of allProviders) {
      this.providers.set(p.id, p);
    }

    // 2. Start proxy (port 0 = OS picks available port)
    this.proxy = createWebAuthProxy();
    const port = await this.proxy.start();
    logger.info(`${LOG_TAG} Proxy started on port ${port}`);

    // 3. Register providers with proxy
    for (const p of allProviders) {
      this.proxy.registerProvider(p);
    }

    // 4. Check auth for all providers and provision webviews for authenticated ones
    await this.checkAllProviders();

    // 5. Start health check (every 5 minutes)
    this.startHealthCheck(5 * 60 * 1000);

    // 6. Notify renderer
    this.notifyRenderer('webauth:proxy:started', port);

    this.initialized = true;
    logger.info(`${LOG_TAG} Initialized successfully`);
  }

  async checkAllProviders(): Promise<void> {
    // Check if proxy is still alive — restart if it died
    if (this.proxy && !this.proxy.isRunning) {
      logger.warn(`${LOG_TAG} Proxy died, restarting...`);
      try {
        const port = await this.proxy.start(0);
        logger.info(`${LOG_TAG} Proxy restarted on port ${port}`);
      } catch (err) {
        logger.error(`${LOG_TAG} Proxy restart failed:`, err);
      }
    }

    const authenticatedModels: Array<{ id: string; name: string }> = [];

    for (const [id, provider] of this.providers) {
      const result = await checkProviderAuth(id);
      const status = result.authenticated ? 'valid' : 'not-configured';

      if (result.authenticated) {
        // Ensure hidden WebContentsView exists for this provider
        await this.ensureProviderWebview(id, provider);
        authenticatedModels.push(...provider.models);
      } else {
        // Remove webview from proxy if it was previously set
        this.proxy?.removeWebview(id);
      }

      // Notify renderer of status — include full provider info so renderer can auto-add
      this.notifyRenderer('webauth:provider:status-changed', id, status, {
        name: provider.name,
        partition: provider.partition,
        loginUrl: provider.loginUrl,
        models: provider.models,
      });
    }

    // Update openclaw.json with authenticated models
    if (this.proxy && authenticatedModels.length > 0) {
      setOpenClawWebAuthConfig(this.proxy.port, authenticatedModels);
      logger.info(
        `${LOG_TAG} Updated OpenClaw config with ${authenticatedModels.length} WebAuth models`,
      );
      // Restart Gateway so it picks up the new webauth provider config
      await this.restartGateway();
    } else {
      removeOpenClawWebAuthConfig();
    }
  }

  async checkProvider(providerId: string): Promise<{ status: string }> {
    const result = await checkProviderAuth(providerId);
    const status = result.authenticated ? 'valid' : 'not-configured';
    const provider = this.providers.get(providerId);

    if (result.authenticated && provider) {
      await this.ensureProviderWebview(providerId, provider);
    } else {
      this.proxy?.removeWebview(providerId);
    }

    this.notifyRenderer('webauth:provider:status-changed', providerId, status);

    // Recalculate and update config
    await this.updateOpenClawConfig();
    return { status };
  }

  /**
   * Fix sameSite for all webauth partitions.
   * Electron doesn't persist sameSite to disk — after restart all cookies
   * restore with sameSite=undefined (defaults to Lax). Google and other
   * providers need SameSite=None for cross-site cookie delivery.
   */
  /**
   * Auto-refresh cookies from Chrome browser via relay extension.
   * Runs on every health check. If relay is available, re-imports fresh
   * cookies for each authenticated provider's login URL.
   * This keeps session cookies fresh (Google rotates SIDCC etc. frequently).
   */
  private async ensureProviderWebview(
    providerId: string,
    provider: WebProvider,
  ): Promise<void> {
    // Check if existing adapter is still valid (underlying view not destroyed)
    const existingAdapter = this.adapters.get(providerId);
    if (existingAdapter) {
      const existingTab = webauthViews.getViewForPartition(provider.partition);
      if (existingTab && !existingTab.view.webContents.isDestroyed()) {
        return; // Already provisioned and valid
      }
      // Adapter is stale — remove it and re-provision
      logger.info(`${LOG_TAG} Stale adapter for ${providerId}, re-provisioning...`);
      this.adapters.delete(providerId);
      this.proxy?.removeWebview(providerId);
    }

    // Reuse existing tab (from WebAuth browser panel UI or previous cycle)
    const existing = webauthViews.getViewForPartition(provider.partition);
    if (existing) {
      const adapter = new WebContentsViewAdapter(existing.view);
      this.adapters.set(providerId, adapter);
      this.proxy?.setWebview(providerId, adapter);
      logger.info(`${LOG_TAG} Reusing existing tab for ${providerId}`);
      return;
    }

    // Create a normal visible tab — same as Settings would create.
    // Keep it "visible" but off-screen — Chromium throttles truly hidden views
    // which causes executeJavaScript to hang.
    const tabId = `webauth-tab-${Date.now()}-${providerId}`;
    // Mark as pipeline tab BEFORE createTab to prevent did-start-loading from activating it
    webauthViews.markAsPipelineTab(tabId);
    const tab = webauthViews.createTab(tabId, provider.loginUrl, provider.partition);

    // Pipeline tabs are API-only — not for user interaction.
    // Keep hidden + prevent throttling so CDP works.
    tab.view.setVisible(false);
    tab.view.setBounds({ x: -9999, y: -9999, width: 1, height: 1 });
    tab.view.webContents.setBackgroundThrottling(false);
    // Remove from main window content view to prevent popup
    try {
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.contentView.removeChildView(tab.view);
      }
    } catch { /* already removed or not added */ }

    await new Promise<void>((resolve) => {
      if (tab.view.webContents.isLoading()) {
        tab.view.webContents.once('did-finish-load', () => resolve());
      } else {
        resolve();
      }
      setTimeout(resolve, 15000);
    });

    const adapter = new WebContentsViewAdapter(tab.view);
    this.adapters.set(providerId, adapter);
    this.proxy?.setWebview(providerId, adapter);
    logger.info(`${LOG_TAG} Provisioned webview for ${providerId}`);
  }

  private async updateOpenClawConfig(): Promise<void> {
    if (!this.proxy) return;
    const authenticatedModels: Array<{ id: string; name: string }> = [];
    for (const [id, provider] of this.providers) {
      const result = await checkProviderAuth(id);
      if (result.authenticated) {
        authenticatedModels.push(...provider.models);
      }
    }
    if (authenticatedModels.length > 0) {
      setOpenClawWebAuthConfig(this.proxy.port, authenticatedModels);
    } else {
      removeOpenClawWebAuthConfig();
    }
  }

  startHealthCheck(intervalMs: number): void {
    this.stopHealthCheck();
    this.healthCheckInterval = setInterval(() => {
      this.checkAllProviders().catch((err) => {
        logger.error(`${LOG_TAG} Health check failed:`, err);
      });
    }, intervalMs);
  }

  stopHealthCheck(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }
  }

  async shutdown(): Promise<void> {
    this.stopHealthCheck();
    if (this.proxy) {
      await this.proxy.stop();
    }
    removeOpenClawWebAuthConfig();
    this.adapters.clear();
    this.initialized = false;
    logger.info(`${LOG_TAG} Shut down`);
  }

  getProxyPort(): number | null {
    return this.proxy?.port ?? null;
  }

  isProxyRunning(): boolean {
    return this.proxy?.isRunning ?? false;
  }

  /** Restart Gateway so it reloads openclaw.json with webauth models */
  private gatewayRestarted = false;
  private _gatewayRestartFn: (() => Promise<void>) | null = null;

  setGatewayRestartFn(fn: () => Promise<void>): void {
    this._gatewayRestartFn = fn;
  }

  private async restartGateway(): Promise<void> {
    if (this.gatewayRestarted) return;
    this.gatewayRestarted = true;
    if (!this._gatewayRestartFn) {
      logger.warn(`${LOG_TAG} No gateway restart function set — models may not appear until manual restart`);
      return;
    }
    try {
      logger.info(`${LOG_TAG} Restarting Gateway to reload webauth config...`);
      await this._gatewayRestartFn();
      logger.info(`${LOG_TAG} Gateway restarted successfully`);
    } catch (err) {
      logger.warn(`${LOG_TAG} Gateway restart failed:`, err);
    }
  }

  private notifyRenderer(channel: string, ...args: unknown[]): void {
    this.mainWindow?.webContents.send(channel, ...args);
  }
}

// Singleton
let pipeline: WebAuthPipeline | null = null;

export function getWebAuthPipeline(): WebAuthPipeline {
  if (!pipeline) pipeline = new WebAuthPipeline();
  return pipeline;
}
