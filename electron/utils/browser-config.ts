/**
 * Browser Config — Write/remove browser config in openclaw.json
 *
 * Manages the `browser` section of ~/.openclaw/openclaw.json to make
 * OpenClaw's browser tool use CrawBot's built-in browser via CDP proxy.
 *
 * Same read-modify-write pattern as setOpenClawDefaultModel() in openclaw-auth.ts
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger';

const LOG_TAG = '[BrowserConfig]';

function getConfigPath(): string {
  return join(homedir(), '.openclaw', 'openclaw.json');
}

function readConfig(): Record<string, unknown> {
  const configPath = getConfigPath();
  try {
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    }
  } catch (err) {
    logger.warn(`${LOG_TAG} Failed to read openclaw.json:`, err);
  }
  return {};
}

function writeConfig(config: Record<string, unknown>): void {
  const configPath = getConfigPath();
  const dir = join(configPath, '..');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

/**
 * Write browser config to openclaw.json
 * Sets attachOnly=true so OpenClaw NEVER launches its own Chrome
 * and always connects to CrawBot's CDP proxy.
 */
export function setOpenClawBrowserConfig(cdpProxyPort: number): void {
  const config = readConfig();

  // Connect directly to Electron's real CDP (port 9222).
  // WebContentsView tabs natively appear as type: "page" — no proxy rewriting needed.
  // The cdpProxyPort parameter is ignored; we use the real CDP port.
  const cdpPort = 9222;

  config.browser = {
    enabled: true,
    evaluateEnabled: true,
    attachOnly: true,
    defaultProfile: 'crawbot',
    remoteCdpTimeoutMs: 5000,
    remoteCdpHandshakeTimeoutMs: 10000,
    profiles: {
      crawbot: {
        cdpUrl: `http://127.0.0.1:${cdpPort}`,
        driver: 'openclaw',
        attachOnly: true,
        color: '#3B82F6',
      },
      chrome: {
        cdpUrl: `http://127.0.0.1:${cdpPort}`,
        driver: 'openclaw',
        attachOnly: true,
        color: '#3B82F6',
      },
      openclaw: {
        cdpUrl: `http://127.0.0.1:${cdpPort}`,
        driver: 'openclaw',
        attachOnly: true,
        color: '#3B82F6',
      },
    },
  };

  writeConfig(config);
  logger.info(`${LOG_TAG} Set browser config: attachOnly=true, cdpUrl=127.0.0.1:${cdpProxyPort}`);
}

/**
 * Remove browser config from openclaw.json
 * Called on app quit so OpenClaw CLI still works standalone
 * (launches its own Chrome when used outside CrawBot)
 */
export function removeOpenClawBrowserConfig(): void {
  const config = readConfig();

  if ('browser' in config) {
    delete config.browser;
    writeConfig(config);
    logger.info(`${LOG_TAG} Removed browser config from openclaw.json`);
  }
}

/**
 * Write WebAuth provider config to openclaw.json
 * Registers the WebAuth proxy as an openai-compatible provider
 * so OpenClaw can use web session models like normal API models.
 */
export function setOpenClawWebAuthConfig(proxyPort: number, models: Array<{ id: string; name: string }>): void {
  const config = readConfig();

  const modelsConfig = (config.models || {}) as Record<string, unknown>;
  const providers = (modelsConfig.providers || {}) as Record<string, unknown>;

  providers.webauth = {
    baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
    api: 'openai-completions',
    apiKey: 'dummy-webauth-key',
    models,
  };

  modelsConfig.providers = providers;
  config.models = modelsConfig;
  writeConfig(config);
  logger.info(`${LOG_TAG} Set WebAuth provider config: port=${proxyPort}, models=${models.length}`);
}

/**
 * Remove WebAuth provider config from openclaw.json
 */
export function removeOpenClawWebAuthConfig(): void {
  const config = readConfig();

  const modelsConfig = (config.models || {}) as Record<string, unknown>;
  const providers = (modelsConfig.providers || {}) as Record<string, unknown>;

  if ('webauth' in providers) {
    delete providers.webauth;
    modelsConfig.providers = providers;
    config.models = modelsConfig;
    writeConfig(config);
    logger.info(`${LOG_TAG} Removed WebAuth provider config from openclaw.json`);
  }
}
