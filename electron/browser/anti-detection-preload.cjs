/**
 * Anti-detection preload script for WebContentsView
 *
 * Runs at document_start (before any page JavaScript) to make the
 * Electron WebContentsView indistinguishable from real Google Chrome.
 *
 * This is critical for Google OAuth and other services that block
 * embedded browsers / Electron apps.
 *
 * Must be .cjs (CommonJS) since Electron preload runs in Node context.
 */

// No electron imports needed — this runs in the main world with contextIsolation: false

// Get Chrome version from user agent
const chromeMatch = navigator.userAgent.match(/Chrome\/([\d.]+)/);
const chromeVersion = chromeMatch ? chromeMatch[1] : '130.0.0.0';
const majorVersion = chromeVersion.split('.')[0];

// ── Override navigator.userAgentData ──
// Google's primary detection method for embedded browsers
const fakeUAData = {
  brands: [
    { brand: 'Chromium', version: majorVersion },
    { brand: 'Google Chrome', version: majorVersion },
    { brand: 'Not-A.Brand', version: '99' },
  ],
  mobile: false,
  platform: 'macOS',
  getHighEntropyValues(hints) {
    return Promise.resolve({
      brands: this.brands,
      mobile: false,
      platform: 'macOS',
      platformVersion: '15.3.0',
      architecture: 'arm',
      bitness: '64',
      model: '',
      uaFullVersion: chromeVersion,
      fullVersionList: [
        { brand: 'Chromium', version: chromeVersion },
        { brand: 'Google Chrome', version: chromeVersion },
        { brand: 'Not-A.Brand', version: '99.0.0.0' },
      ],
      wow64: false,
    });
  },
  toJSON() {
    return { brands: this.brands, mobile: this.mobile, platform: this.platform };
  },
};

try {
  Object.defineProperty(navigator, 'userAgentData', {
    get: () => fakeUAData,
    configurable: true,
  });
} catch (_) { /* may already be defined */ }

// ── Override navigator.webdriver ──
try {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true,
  });
} catch (_) {}

// ── Override navigator.plugins ──
// Must be realistic PluginArray-like, not just numbers
const fakePlugins = {
  0: { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1, 0: { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format' } },
  1: { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: '', length: 1, 0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: '' } },
  2: { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '', length: 1, 0: { type: 'application/pdf', suffixes: 'pdf', description: '' } },
  3: { name: 'Native Client', filename: 'internal-nacl-plugin', description: '', length: 2, 0: { type: 'application/x-nacl', suffixes: '', description: 'Native Client Executable' }, 1: { type: 'application/x-pnacl', suffixes: '', description: 'Portable Native Client Executable' } },
  4: { name: 'Chromium PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 1, 0: { type: 'application/x-google-chrome-pdf', suffixes: 'pdf', description: 'Portable Document Format' } },
  length: 5,
  item(i) { return this[i] || null; },
  namedItem(n) { for (let i = 0; i < this.length; i++) { if (this[i] && this[i].name === n) return this[i]; } return null; },
  refresh() {},
  [Symbol.iterator]: function*() { for (let i = 0; i < this.length; i++) if (this[i]) yield this[i]; },
};

try {
  Object.defineProperty(navigator, 'plugins', {
    get: () => fakePlugins,
    configurable: true,
  });
} catch (_) {}

// ── Override navigator.languages ──
try {
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
    configurable: true,
  });
} catch (_) {}

// ── Fake window.chrome ──
// Google OAuth specifically checks for window.chrome.runtime
try {
  if (!window.chrome) {
    window.chrome = {};
  }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect() {
        return {
          onMessage: { addListener() {} },
          postMessage() {},
          onDisconnect: { addListener() {} },
        };
      },
      sendMessage() {},
      id: undefined,
    };
  }
  if (!window.chrome.csi) {
    window.chrome.csi = function() {
      return {
        onloadT: Date.now(),
        pageT: performance.now(),
        startE: Date.now(),
        tran: 15,
      };
    };
  }
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function() {
      return {
        commitLoadTime: Date.now() / 1000,
        connectionInfo: 'h2',
        finishDocumentLoadTime: Date.now() / 1000,
        finishLoadTime: Date.now() / 1000,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: Date.now() / 1000,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: Date.now() / 1000,
        startLoadTime: Date.now() / 1000,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
      };
    };
  }
} catch (_) {}

// ── Fake permissions API ──
try {
  const origQuery = navigator.permissions?.query?.bind(navigator.permissions);
  if (origQuery) {
    navigator.permissions.query = function(desc) {
      if (desc.name === 'notifications') {
        return Promise.resolve({ state: Notification.permission, onchange: null });
      }
      return origQuery(desc);
    };
  }
} catch (_) {}
