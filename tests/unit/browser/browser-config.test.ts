/**
 * Browser Config Tests
 * Tests for openclaw.json read/write operations
 */

// Mock filesystem storage
const mockFs: Record<string, string> = {};

// vi.mock calls are hoisted by vitest
vi.mock('node:fs', () => {
  const impl = {
    existsSync: (path: string) => path in mockFs,
    readFileSync: (path: string) => {
      if (path in mockFs) return mockFs[path];
      throw new Error(`ENOENT: ${path}`);
    },
    writeFileSync: (path: string, data: string) => {
      mockFs[path] = data;
    },
    mkdirSync: () => {},
  };
  return { ...impl, default: impl };
});

vi.mock('node:os', () => {
  const impl = { homedir: () => '/mock-home' };
  return { ...impl, default: impl };
});

vi.mock('@electron/utils/logger', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  setOpenClawBrowserConfig,
  removeOpenClawBrowserConfig,
  setOpenClawWebAuthConfig,
  removeOpenClawWebAuthConfig,
} from '@electron/utils/browser-config';

const CONFIG_PATH = '/mock-home/.openclaw/openclaw.json';

describe('browser-config', () => {
  beforeEach(() => {
    // Clear mock filesystem
    for (const key of Object.keys(mockFs)) delete mockFs[key];
  });

  describe('setOpenClawBrowserConfig', () => {
    it('writes browser section to existing openclaw.json without overwriting other keys', () => {
      mockFs[CONFIG_PATH] = JSON.stringify({
        agents: { defaults: { model: { primary: 'anthropic/claude-3' } } },
        models: { providers: { anthropic: {} } },
      });

      setOpenClawBrowserConfig(9333);

      const config = JSON.parse(mockFs[CONFIG_PATH]);
      // Browser config written
      expect(config.browser).toBeDefined();
      expect(config.browser.attachOnly).toBe(true);
      expect(config.browser.defaultProfile).toBe('crawbot');
      expect(config.browser.profiles.crawbot.cdpUrl).toBe('http://127.0.0.1:9333');

      // Existing config preserved
      expect(config.agents.defaults.model.primary).toBe('anthropic/claude-3');
      expect(config.models.providers.anthropic).toBeDefined();
    });

    it('creates openclaw.json if not exists', () => {
      setOpenClawBrowserConfig(9333);

      expect(mockFs[CONFIG_PATH]).toBeDefined();
      const config = JSON.parse(mockFs[CONFIG_PATH]);
      expect(config.browser.enabled).toBe(true);
    });

    it('sets correct cdpUrl with given port', () => {
      setOpenClawBrowserConfig(9444);

      const config = JSON.parse(mockFs[CONFIG_PATH]);
      expect(config.browser.profiles.crawbot.cdpUrl).toBe('http://127.0.0.1:9444');
    });

    it('overwrites existing browser config', () => {
      mockFs[CONFIG_PATH] = JSON.stringify({
        browser: { enabled: false, defaultProfile: 'old' },
      });

      setOpenClawBrowserConfig(9333);

      const config = JSON.parse(mockFs[CONFIG_PATH]);
      expect(config.browser.enabled).toBe(true);
      expect(config.browser.defaultProfile).toBe('crawbot');
    });
  });

  describe('removeOpenClawBrowserConfig', () => {
    it('removes browser key from openclaw.json', () => {
      mockFs[CONFIG_PATH] = JSON.stringify({
        browser: { enabled: true },
        agents: { list: [] },
      });

      removeOpenClawBrowserConfig();

      const config = JSON.parse(mockFs[CONFIG_PATH]);
      expect(config.browser).toBeUndefined();
      expect(config.agents).toBeDefined();
    });

    it('preserves all other config keys', () => {
      mockFs[CONFIG_PATH] = JSON.stringify({
        browser: { enabled: true },
        agents: { list: ['a'] },
        models: { providers: {} },
        tools: { agentToAgent: true },
      });

      removeOpenClawBrowserConfig();

      const config = JSON.parse(mockFs[CONFIG_PATH]);
      expect(config.agents.list).toEqual(['a']);
      expect(config.models).toBeDefined();
      expect(config.tools).toBeDefined();
    });

    it('no-op if browser key not present', () => {
      mockFs[CONFIG_PATH] = JSON.stringify({ agents: {} });
      removeOpenClawBrowserConfig();
      const config = JSON.parse(mockFs[CONFIG_PATH]);
      expect(config.agents).toBeDefined();
    });

    it('no-op if openclaw.json not exists', () => {
      removeOpenClawBrowserConfig();
      // Should not throw
    });
  });

  describe('setOpenClawWebAuthConfig', () => {
    it('writes models.providers.webauth with correct baseUrl and models', () => {
      mockFs[CONFIG_PATH] = JSON.stringify({
        models: { providers: { anthropic: {} } },
      });

      setOpenClawWebAuthConfig(23456, [
        { id: 'webauth-claude-sonnet-4', name: 'Claude Sonnet 4 (WebAuth)' },
      ]);

      const config = JSON.parse(mockFs[CONFIG_PATH]);
      expect(config.models.providers.webauth).toBeDefined();
      expect(config.models.providers.webauth.baseUrl).toBe('http://127.0.0.1:23456/v1');
      expect(config.models.providers.webauth.models).toHaveLength(1);
      expect(config.models.providers.webauth.models[0].id).toBe('webauth-claude-sonnet-4');

      // Preserves existing providers
      expect(config.models.providers.anthropic).toBeDefined();
    });
  });

  describe('removeOpenClawWebAuthConfig', () => {
    it('removes webauth provider from openclaw.json', () => {
      mockFs[CONFIG_PATH] = JSON.stringify({
        models: { providers: { anthropic: {}, webauth: { baseUrl: 'http://...' } } },
      });

      removeOpenClawWebAuthConfig();

      const config = JSON.parse(mockFs[CONFIG_PATH]);
      expect(config.models.providers.webauth).toBeUndefined();
      expect(config.models.providers.anthropic).toBeDefined();
    });
  });
});
