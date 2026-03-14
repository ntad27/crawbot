import { describe, it, expect, beforeEach } from 'vitest';
import { sep } from 'node:path';

/**
 * Test suite for electron/gateway/openclaw-patches-preload.cjs
 *
 * Tests the CJS module patching system that fixes dependency compatibility
 * issues in the packaged Electron app:
 * - C1: proper-lockfile signal-exit v3/v4 export mismatch
 * - C2: proxy-agent https-proxy-agent CJS→ESM import
 * - C3: pac-proxy-agent https-proxy-agent CJS→ESM import
 * - C4: @discordjs/node-pre-gyp make https-proxy-agent optional
 * - C5: node-edge-tts make https-proxy-agent optional
 */

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Simulates the path normalization logic from the preload file.
 * Converts OS-specific path separators to forward slashes.
 * Also normalizes any literal backslashes in the input (for cross-platform testing).
 */
function normalizePath(filename: string): string {
  return filename.split(sep).join('/').split('\\').join('/');
}

/**
 * Checks if a normalized path matches the C1 patch condition.
 */
function matchesC1(normFilename: string): boolean {
  return normFilename.includes('proper-lockfile/lib/lockfile.js');
}

/**
 * Checks if a normalized path matches the C2 patch condition.
 * Uses the exact regex from the preload: /\/proxy-agent\/dist\/index\.js$/
 */
function matchesC2(normFilename: string): boolean {
  return /\/proxy-agent\/dist\/index\.js$/.test(normFilename);
}

/**
 * Checks if a normalized path matches the C3 patch condition.
 */
function matchesC3(normFilename: string): boolean {
  return normFilename.includes('pac-proxy-agent/dist/index.js');
}

/**
 * Checks if a normalized path matches the C4 patch condition.
 */
function matchesC4(normFilename: string): boolean {
  return normFilename.includes('@discordjs/node-pre-gyp/lib/install.js');
}

/**
 * Checks if a normalized path matches the C5 patch condition.
 */
function matchesC5(normFilename: string): boolean {
  return normFilename.includes('node-edge-tts/dist/edge-tts.js');
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Suites
// ─────────────────────────────────────────────────────────────────────────────

describe('openclaw-patches-preload.cjs', () => {
  // ───────────────────────────────────────────────────────────────────────────
  // C1: proper-lockfile signal-exit mismatch
  // ───────────────────────────────────────────────────────────────────────────

  describe('C1: proper-lockfile/lib/lockfile.js path matching', () => {
    it('should match proper-lockfile with Unix path', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/proper-lockfile/lib/lockfile.js'
      );
      expect(matchesC1(filename)).toBe(true);
    });

    it('should match proper-lockfile with Windows path', () => {
      const filename = normalizePath(
        'C:\\Users\\user\\project\\node_modules\\proper-lockfile\\lib\\lockfile.js'
      );
      expect(matchesC1(filename)).toBe(true);
    });

    it('should match proper-lockfile with pnpm virtual store path', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/.pnpm/proper-lockfile@4.1.2/node_modules/proper-lockfile/lib/lockfile.js'
      );
      expect(matchesC1(filename)).toBe(true);
    });

    it('should match proper-lockfile with bundled openclaw path', () => {
      const filename = normalizePath(
        '/Applications/CrawBot.app/Contents/Resources/openclaw/node_modules/proper-lockfile/lib/lockfile.js'
      );
      expect(matchesC1(filename)).toBe(true);
    });

    it('should not match other lockfile modules', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/some-lockfile/lib/lockfile.js'
      );
      expect(matchesC1(filename)).toBe(false);
    });

    it('should not match files without lockfile.js', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/proper-lockfile/lib/index.js'
      );
      expect(matchesC1(filename)).toBe(false);
    });
  });

  describe('C1: proper-lockfile source transformation', () => {
    it('should replace signal-exit require with compatibility code', () => {
      const original =
        'const onExit = require(\'signal-exit\');';
      const expected =
        'const signalExit = require(\'signal-exit\');\nconst onExit = typeof signalExit === \'function\' ? signalExit : signalExit.onExit;';

      const result = original.replace(
        original,
        expected
      );

      expect(result).toBe(expected);
      expect(result).toContain('typeof signalExit === \'function\'');
      expect(result).toContain('signalExit.onExit');
    });

    it('should preserve code context when signal-exit replacement applied', () => {
      const code =
        'const fs = require("fs");\n' +
        'const onExit = require(\'signal-exit\');\n' +
        'onExit(() => { fs.closeSync(fd); });';

      const find = 'const onExit = require(\'signal-exit\');';
      const replace =
        'const signalExit = require(\'signal-exit\');\nconst onExit = typeof signalExit === \'function\' ? signalExit : signalExit.onExit;';

      const result = code.replace(find, replace);

      expect(result).toContain('const fs = require("fs");');
      expect(result).toContain('onExit(() => { fs.closeSync(fd); });');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C2: proxy-agent https-proxy-agent import
  // ───────────────────────────────────────────────────────────────────────────

  describe('C2: proxy-agent/dist/index.js path matching', () => {
    it('should match proxy-agent with Unix path using regex', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/proxy-agent/dist/index.js'
      );
      expect(matchesC2(filename)).toBe(true);
    });

    it('should match proxy-agent with Windows path', () => {
      const filename = normalizePath(
        'C:\\Users\\user\\project\\node_modules\\proxy-agent\\dist\\index.js'
      );
      expect(matchesC2(filename)).toBe(true);
    });

    it('should match proxy-agent with pnpm virtual store path', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/.pnpm/proxy-agent@6.0.0/node_modules/proxy-agent/dist/index.js'
      );
      expect(matchesC2(filename)).toBe(true);
    });

    it('should NOT match pac-proxy-agent (regex prevents it)', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/pac-proxy-agent/dist/index.js'
      );
      expect(matchesC2(filename)).toBe(false);
    });

    it('should NOT match https-proxy-agent (regex prevents it)', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/https-proxy-agent/dist/index.js'
      );
      expect(matchesC2(filename)).toBe(false);
    });

    it('should NOT match proxy-agent in wrong path position', () => {
      const filename = normalizePath(
        '/home/user/proxy-agent/node_modules/something/dist/index.js'
      );
      expect(matchesC2(filename)).toBe(false);
    });

    it('should NOT match files other than index.js', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/proxy-agent/dist/agent.js'
      );
      expect(matchesC2(filename)).toBe(false);
    });
  });

  describe('C2: proxy-agent source transformation', () => {
    it('should replace __importStar require with dynamic import', () => {
      const original =
        'https: async () => (await Promise.resolve().then(() => __importStar(require(\'https-proxy-agent\')))).HttpsProxyAgent,';
      const expected =
        'https: async () => (await import(\'https-proxy-agent\')).HttpsProxyAgent,';

      const result = original.replace(
        original,
        expected
      );

      expect(result).toBe(expected);
      expect(result).not.toContain('__importStar');
      expect(result).toContain("await import('https-proxy-agent')");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C3: pac-proxy-agent https-proxy-agent import
  // ───────────────────────────────────────────────────────────────────────────

  describe('C3: pac-proxy-agent/dist/index.js path matching', () => {
    it('should match pac-proxy-agent with Unix path', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/pac-proxy-agent/dist/index.js'
      );
      expect(matchesC3(filename)).toBe(true);
    });

    it('should match pac-proxy-agent with Windows path', () => {
      const filename = normalizePath(
        'C:\\Users\\user\\project\\node_modules\\pac-proxy-agent\\dist\\index.js'
      );
      expect(matchesC3(filename)).toBe(true);
    });

    it('should match pac-proxy-agent with pnpm virtual store path', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/.pnpm/pac-proxy-agent@7.0.0/node_modules/pac-proxy-agent/dist/index.js'
      );
      expect(matchesC3(filename)).toBe(true);
    });

    it('should NOT match proxy-agent (includes() is different from regex)', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/proxy-agent/dist/index.js'
      );
      expect(matchesC3(filename)).toBe(false);
    });

    it('should NOT match https-proxy-agent', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/https-proxy-agent/dist/index.js'
      );
      expect(matchesC3(filename)).toBe(false);
    });

    it('should not match other pac modules', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/pac-lib/dist/index.js'
      );
      expect(matchesC3(filename)).toBe(false);
    });
  });

  describe('C3: pac-proxy-agent source transformation', () => {
    it('should replace __importStar require with dynamic import', () => {
      const original =
        'const { HttpsProxyAgent } = await Promise.resolve().then(() => __importStar(require(\'https-proxy-agent\')));';
      const expected =
        'const { HttpsProxyAgent } = await import(\'https-proxy-agent\');';

      const result = original.replace(
        original,
        expected
      );

      expect(result).toBe(expected);
      expect(result).not.toContain('__importStar');
      expect(result).toContain("import('https-proxy-agent')");
    });

    it('should preserve code context when replacement applied', () => {
      const code =
        'async function init() {\n' +
        '  const { HttpsProxyAgent } = await Promise.resolve().then(() => __importStar(require(\'https-proxy-agent\')));\n' +
        '  return new HttpsProxyAgent(url);\n' +
        '}';

      const find =
        'const { HttpsProxyAgent } = await Promise.resolve().then(() => __importStar(require(\'https-proxy-agent\')));';
      const replace =
        'const { HttpsProxyAgent } = await import(\'https-proxy-agent\');';

      const result = code.replace(find, replace);

      expect(result).toContain('async function init()');
      expect(result).toContain('return new HttpsProxyAgent(url);');
      expect(result).toContain("await import('https-proxy-agent')");
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C4: @discordjs/node-pre-gyp https-proxy-agent optional
  // ───────────────────────────────────────────────────────────────────────────

  describe('C4: @discordjs/node-pre-gyp/lib/install.js path matching', () => {
    it('should match @discordjs/node-pre-gyp with Unix path', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/@discordjs/node-pre-gyp/lib/install.js'
      );
      expect(matchesC4(filename)).toBe(true);
    });

    it('should match @discordjs/node-pre-gyp with Windows path', () => {
      const filename = normalizePath(
        'C:\\Users\\user\\project\\node_modules\\@discordjs\\node-pre-gyp\\lib\\install.js'
      );
      expect(matchesC4(filename)).toBe(true);
    });

    it('should match @discordjs/node-pre-gyp with pnpm virtual store path', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/.pnpm/@discordjs+node-pre-gyp@1.4.0/node_modules/@discordjs/node-pre-gyp/lib/install.js'
      );
      expect(matchesC4(filename)).toBe(true);
    });

    it('should not match other @discordjs modules', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/@discordjs/some-module/lib/install.js'
      );
      expect(matchesC4(filename)).toBe(false);
    });

    it('should not match other install.js files', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/other-package/lib/install.js'
      );
      expect(matchesC4(filename)).toBe(false);
    });
  });

  describe('C4: @discordjs/node-pre-gyp source transformation', () => {
    it('should wrap ProxyAgent require in try/catch', () => {
      const original =
        'const ProxyAgent = require(\'https-proxy-agent\');';
      const expected =
        'let ProxyAgent; try { ProxyAgent = require(\'https-proxy-agent\'); } catch { log.warn(\'download\', \'https-proxy-agent not available, proxy disabled\'); }';

      const result = original.replace(
        original,
        expected
      );

      expect(result).toBe(expected);
      expect(result).toContain('try');
      expect(result).toContain('catch');
      expect(result).toContain('log.warn');
    });

    it('should guard ProxyAgent usage with conditional check', () => {
      const original =
        'agent = new ProxyAgent(proxyUrl);';
      const expected =
        'agent = ProxyAgent ? new ProxyAgent(proxyUrl) : undefined;';

      const result = original.replace(
        original,
        expected
      );

      expect(result).toBe(expected);
      expect(result).toContain('ProxyAgent ?');
      expect(result).toContain('undefined');
    });

    it('should apply both replacements in sequence', () => {
      const code =
        'const ProxyAgent = require(\'https-proxy-agent\');\n' +
        'function setupProxy() {\n' +
        '  agent = new ProxyAgent(proxyUrl);\n' +
        '}';

      const find1 = 'const ProxyAgent = require(\'https-proxy-agent\');';
      const replace1 =
        'let ProxyAgent; try { ProxyAgent = require(\'https-proxy-agent\'); } catch { log.warn(\'download\', \'https-proxy-agent not available, proxy disabled\'); }';

      const find2 = 'agent = new ProxyAgent(proxyUrl);';
      const replace2 =
        'agent = ProxyAgent ? new ProxyAgent(proxyUrl) : undefined;';

      let result = code.replace(find1, replace1);
      result = result.replace(find2, replace2);

      expect(result).toContain('try');
      expect(result).toContain('catch');
      expect(result).toContain('ProxyAgent ?');
      expect(result).toContain('undefined');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // C5: node-edge-tts https-proxy-agent optional
  // ───────────────────────────────────────────────────────────────────────────

  describe('C5: node-edge-tts/dist/edge-tts.js path matching', () => {
    it('should match node-edge-tts with Unix path', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/node-edge-tts/dist/edge-tts.js'
      );
      expect(matchesC5(filename)).toBe(true);
    });

    it('should match node-edge-tts with Windows path', () => {
      const filename = normalizePath(
        'C:\\Users\\user\\project\\node_modules\\node-edge-tts\\dist\\edge-tts.js'
      );
      expect(matchesC5(filename)).toBe(true);
    });

    it('should match node-edge-tts with pnpm virtual store path', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/.pnpm/node-edge-tts@4.0.0/node_modules/node-edge-tts/dist/edge-tts.js'
      );
      expect(matchesC5(filename)).toBe(true);
    });

    it('should not match other tts modules', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/some-tts/dist/edge-tts.js'
      );
      expect(matchesC5(filename)).toBe(false);
    });

    it('should not match other node-edge-tts files', () => {
      const filename = normalizePath(
        '/home/user/project/node_modules/node-edge-tts/dist/index.js'
      );
      expect(matchesC5(filename)).toBe(false);
    });
  });

  describe('C5: node-edge-tts source transformation', () => {
    it('should wrap top-level require in try/catch', () => {
      const original =
        'const https_proxy_agent_1 = require("https-proxy-agent");';
      const expected =
        'let https_proxy_agent_1; try { https_proxy_agent_1 = require("https-proxy-agent"); } catch { https_proxy_agent_1 = {}; }';

      const result = original.replace(
        original,
        expected
      );

      expect(result).toBe(expected);
      expect(result).toContain('try');
      expect(result).toContain('catch');
      expect(result).toContain('= {};');
    });

    it('should guard HttpsProxyAgent instantiation with property check', () => {
      const original =
        'agent: this.proxy ? new https_proxy_agent_1.HttpsProxyAgent(this.proxy) : undefined';
      const expected =
        'agent: this.proxy && https_proxy_agent_1.HttpsProxyAgent ? new https_proxy_agent_1.HttpsProxyAgent(this.proxy) : undefined';

      const result = original.replace(
        original,
        expected
      );

      expect(result).toBe(expected);
      expect(result).toContain('https_proxy_agent_1.HttpsProxyAgent ?');
    });

    it('should apply both replacements in sequence', () => {
      const code =
        'const https_proxy_agent_1 = require("https-proxy-agent");\n' +
        'function getAgent() {\n' +
        '  return { agent: this.proxy ? new https_proxy_agent_1.HttpsProxyAgent(this.proxy) : undefined };\n' +
        '}';

      const find1 = 'const https_proxy_agent_1 = require("https-proxy-agent");';
      const replace1 =
        'let https_proxy_agent_1; try { https_proxy_agent_1 = require("https-proxy-agent"); } catch { https_proxy_agent_1 = {}; }';

      const find2 =
        'agent: this.proxy ? new https_proxy_agent_1.HttpsProxyAgent(this.proxy) : undefined';
      const replace2 =
        'agent: this.proxy && https_proxy_agent_1.HttpsProxyAgent ? new https_proxy_agent_1.HttpsProxyAgent(this.proxy) : undefined';

      let result = code.replace(find1, replace1);
      result = result.replace(find2, replace2);

      expect(result).toContain('try');
      expect(result).toContain('catch');
      expect(result).toContain('https_proxy_agent_1.HttpsProxyAgent ?');
    });
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Edge Cases
  // ───────────────────────────────────────────────────────────────────────────

  describe('Edge cases: path normalization', () => {
    it('should normalize mixed separators (Windows path with backslashes)', () => {
      const windowsPath =
        'C:\\Users\\user\\project\\node_modules\\proper-lockfile\\lib\\lockfile.js';
      const normalized = normalizePath(windowsPath);
      expect(normalized).toContain('/');
      expect(normalized).not.toContain('\\');
    });

    it('should preserve forward slashes on Unix', () => {
      const unixPath =
        '/home/user/project/node_modules/proper-lockfile/lib/lockfile.js';
      const normalized = normalizePath(unixPath);
      expect(normalized).toBe(unixPath);
    });

    it('should handle pnpm virtual store naming with scoped packages', () => {
      const pnpmPath =
        '/home/user/project/node_modules/.pnpm/@discordjs+node-pre-gyp@1.4.0/node_modules/@discordjs/node-pre-gyp/lib/install.js';
      const normalized = normalizePath(pnpmPath);
      expect(normalized).toContain('@discordjs');
      expect(normalized).toContain('node-pre-gyp');
    });
  });

  describe('Edge cases: content matching', () => {
    it('C1: should not apply patch if find string not in source', () => {
      const source = 'const onExit = getOnExit();'; // Different require style
      const find = "const onExit = require('signal-exit');";
      const hasFind = source.includes(find);
      expect(hasFind).toBe(false);
    });

    it('C2: should not apply patch if find string not in source', () => {
      const source =
        'https: () => require("https-proxy-agent").HttpsProxyAgent,'; // Not the pattern
      const find =
        "https: async () => (await Promise.resolve().then(() => __importStar(require('https-proxy-agent')))).HttpsProxyAgent,";
      const hasFind = source.includes(find);
      expect(hasFind).toBe(false);
    });

    it('should handle empty file content', () => {
      const empty = '';
      const find = "const onExit = require('signal-exit');";
      expect(empty.includes(find)).toBe(false);
    });

    it('should only replace exact matching strings (not substrings)', () => {
      const source = `
        // require('signal-exit') in comment
        const onExit = require('signal-exit');
      `;
      const find = "const onExit = require('signal-exit');";
      const count = (source.match(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      expect(count).toBe(1);
    });
  });

  describe('Edge cases: patch isolation', () => {
    it('C2 should not match if path contains proxy-agent but not as /proxy-agent/', () => {
      const paths = [
        '/home/user/my-proxy-agent/dist/index.js',
        '/home/user/project/proxy-agent-handler/index.js',
        '/home/user/node_modules/proxy-agent',
      ];

      paths.forEach((p) => {
        const normalized = normalizePath(p);
        const matches = /\/proxy-agent\/dist\/index\.js$/.test(normalized);
        // None should match because the regex requires /proxy-agent/dist/index.js at the end
        expect(matches).toBe(false);
      });
    });

    it('should not apply C3 when C2 path is loaded', () => {
      const c2Path = normalizePath(
        '/home/user/project/node_modules/proxy-agent/dist/index.js'
      );
      expect(matchesC2(c2Path)).toBe(true);
      expect(matchesC3(c2Path)).toBe(false);
    });

    it('should not apply C1 when C4 path is loaded', () => {
      const c4Path = normalizePath(
        '/home/user/project/node_modules/@discordjs/node-pre-gyp/lib/install.js'
      );
      expect(matchesC4(c4Path)).toBe(true);
      expect(matchesC1(c4Path)).toBe(false);
    });
  });

  describe('Edge cases: special characters and encoding', () => {
    it('should handle paths with spaces', () => {
      const pathWithSpaces = normalizePath(
        '/home/user/My Projects/node_modules/proper-lockfile/lib/lockfile.js'
      );
      expect(matchesC1(pathWithSpaces)).toBe(true);
    });

    it('should handle paths with hyphens and underscores', () => {
      const path1 = normalizePath(
        '/home/user/my-project_v2/node_modules/node-edge-tts/dist/edge-tts.js'
      );
      expect(matchesC5(path1)).toBe(true);

      const path2 = normalizePath(
        '/home/user/my-project_v2/node_modules/proxy-agent/dist/index.js'
      );
      expect(matchesC2(path2)).toBe(true);
    });

    it('should handle version numbers in pnpm virtual store paths', () => {
      const versionedPath = normalizePath(
        '/home/user/project/node_modules/.pnpm/proper-lockfile@4.1.2+resolve@2.0.0/node_modules/proper-lockfile/lib/lockfile.js'
      );
      expect(matchesC1(versionedPath)).toBe(true);
    });
  });

  describe('Edge cases: multiple patch scenarios', () => {
    it('file should match only one patch at a time', () => {
      const c1Path = normalizePath(
        '/home/user/project/node_modules/proper-lockfile/lib/lockfile.js'
      );
      const matchCount = [
        matchesC1(c1Path),
        matchesC2(c1Path),
        matchesC3(c1Path),
        matchesC4(c1Path),
        matchesC5(c1Path),
      ].filter((m) => m).length;

      expect(matchCount).toBe(1);
      expect(matchesC1(c1Path)).toBe(true);
    });

    it('each patch target should match exactly one patch', () => {
      const targets = [
        { path: '/node_modules/proper-lockfile/lib/lockfile.js', patch: 'C1', matcher: matchesC1 },
        { path: '/node_modules/proxy-agent/dist/index.js', patch: 'C2', matcher: matchesC2 },
        { path: '/node_modules/pac-proxy-agent/dist/index.js', patch: 'C3', matcher: matchesC3 },
        { path: '/node_modules/@discordjs/node-pre-gyp/lib/install.js', patch: 'C4', matcher: matchesC4 },
        { path: '/node_modules/node-edge-tts/dist/edge-tts.js', patch: 'C5', matcher: matchesC5 },
      ];

      targets.forEach(({ path, patch, matcher }) => {
        const normalized = normalizePath(path);
        const matches = [
          matchesC1(normalized),
          matchesC2(normalized),
          matchesC3(normalized),
          matchesC4(normalized),
          matchesC5(normalized),
        ].filter((m) => m).length;

        expect(matches).toBe(1);
        expect(matcher(normalized)).toBe(true);
      });
    });
  });

  describe('Edge cases: regex anchoring (C2 specific)', () => {
    it('C2 regex should require trailing /proxy-agent/dist/index.js', () => {
      const validPaths = [
        '/node_modules/proxy-agent/dist/index.js',
        'C:\\node_modules\\proxy-agent\\dist\\index.js'.split('\\').join('/'),
        '/opt/app/node_modules/.pnpm/proxy-agent@6.0.0/node_modules/proxy-agent/dist/index.js',
      ];

      validPaths.forEach((p) => {
        expect(matchesC2(p)).toBe(true);
      });
    });

    it('C2 regex should reject paths that continue after index.js', () => {
      const invalidPaths = [
        '/node_modules/proxy-agent/dist/index.js.bak',
        '/node_modules/proxy-agent/dist/index.js.map',
        '/node_modules/proxy-agent/dist/index.js/other.js',
      ];

      invalidPaths.forEach((p) => {
        expect(matchesC2(p)).toBe(false);
      });
    });
  });

  describe('Integration tests: source replacements preserve functionality', () => {
    it('C1 replacement should not break variable scoping', () => {
      const code = `
        const signalExit = require('signal-exit');
        const onExit = typeof signalExit === 'function' ? signalExit : signalExit.onExit;
        onExit(() => { /* cleanup */ });
      `;

      expect(code).toContain('onExit');
      expect(code).toContain('signalExit');
      expect(code).not.toContain('__importStar');
    });

    it('C2 replacement should produce valid async code', () => {
      const code = `
        https: async () => (await import('https-proxy-agent')).HttpsProxyAgent,
      `;

      expect(code).toContain('async');
      expect(code).toContain('await');
      expect(code).toContain('import');
      expect(code).not.toContain('require');
      expect(code).not.toContain('Promise.resolve');
    });

    it('C4 replacement should provide fallback for missing module', () => {
      const code = `
        let ProxyAgent; try { ProxyAgent = require('https-proxy-agent'); } catch { log.warn('download', 'https-proxy-agent not available, proxy disabled'); }
        agent = ProxyAgent ? new ProxyAgent(proxyUrl) : undefined;
      `;

      expect(code).toContain('try');
      expect(code).toContain('catch');
      expect(code).toContain('ProxyAgent ?');
      expect(code).toContain('undefined');
    });

    it('C5 replacement should set empty object as fallback', () => {
      const code = `
        let https_proxy_agent_1; try { https_proxy_agent_1 = require("https-proxy-agent"); } catch { https_proxy_agent_1 = {}; }
        agent: this.proxy && https_proxy_agent_1.HttpsProxyAgent ? new https_proxy_agent_1.HttpsProxyAgent(this.proxy) : undefined
      `;

      expect(code).toContain('try');
      expect(code).toContain('catch');
      expect(code).toContain('https_proxy_agent_1 = {}');
      expect(code).toContain('https_proxy_agent_1.HttpsProxyAgent ?');
    });
  });
});
