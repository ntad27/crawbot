/**
 * Comprehensive anti-detection preload script for WebContentsView
 *
 * Runs at document_start (before any page JavaScript) to make the
 * Electron WebContentsView indistinguishable from real Google Chrome.
 *
 * Techniques combined from:
 * - puppeteer-extra-plugin-stealth (17 evasion modules)
 * - opencli stealth.ts (CDP stack trace cleanup, automation artifacts)
 * - rebrowser-patches (Runtime.enable leak awareness)
 * - patchright (AutomationControlled feature disable)
 * - Real Chrome fingerprint comparison data
 *
 * Must be .cjs (CommonJS) since Electron preload runs in Node context.
 */

// No electron imports needed — this runs in the main world with contextIsolation: false

// ══════════════════════════════════════════════════════════════════════
// Guard: prevent double-injection
// ══════════════════════════════════════════════════════════════════════
try {
  const _gProto = EventTarget.prototype;
  const _gKey = '__lsn';
  if (_gProto[_gKey]) return;
  Object.defineProperty(_gProto, _gKey, { value: true, enumerable: false, configurable: true });
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// Extract Chrome version from user agent
// ══════════════════════════════════════════════════════════════════════
const chromeMatch = navigator.userAgent.match(/Chrome\/([\d.]+)/);
const chromeVersion = chromeMatch ? chromeMatch[1] : '130.0.0.0';
const majorVersion = chromeVersion.split('.')[0];

// ══════════════════════════════════════════════════════════════════════
// 1. navigator.webdriver → false
//    Real Chrome returns false (not undefined). Returning undefined is
//    itself a detection signal for advanced fingerprinters like Shopee.
// ══════════════════════════════════════════════════════════════════════
try {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => false,
    configurable: true,
  });
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 2. navigator.userAgentData — must include "Google Chrome" brand
//    Electron/Chromium only reports "Chromium" brand, missing "Google Chrome"
// ══════════════════════════════════════════════════════════════════════
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
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 3. navigator.plugins — match real Chrome plugin names exactly
//    Real Chrome 146: PDF Viewer, Chrome PDF Viewer, Chromium PDF Viewer,
//    Microsoft Edge PDF Viewer, WebKit built-in PDF
//    (NOT "Chrome PDF Plugin" or "Native Client" which are outdated)
// ══════════════════════════════════════════════════════════════════════
try {
  const mkPlugin = (name, filename, description, mimeTypes) => {
    const plugin = { name, filename, description, length: mimeTypes.length };
    mimeTypes.forEach((mt, i) => { plugin[i] = mt; });
    return plugin;
  };
  const mkMime = (type, suffixes, description) => ({ type, suffixes, description });

  const fakePlugins = {
    0: mkPlugin('PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format',
      [mkMime('application/pdf', 'pdf', 'Portable Document Format')]),
    1: mkPlugin('Chrome PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format',
      [mkMime('application/pdf', 'pdf', 'Portable Document Format')]),
    2: mkPlugin('Chromium PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format',
      [mkMime('application/pdf', 'pdf', 'Portable Document Format')]),
    3: mkPlugin('Microsoft Edge PDF Viewer', 'internal-pdf-viewer', 'Portable Document Format',
      [mkMime('application/pdf', 'pdf', 'Portable Document Format')]),
    4: mkPlugin('WebKit built-in PDF', 'internal-pdf-viewer', 'Portable Document Format',
      [mkMime('application/pdf', 'pdf', 'Portable Document Format')]),
    length: 5,
    item(i) { return this[i] || null; },
    namedItem(n) {
      for (let i = 0; i < this.length; i++) {
        if (this[i] && this[i].name === n) return this[i];
      }
      return null;
    },
    refresh() {},
    [Symbol.iterator]: function*() {
      for (let i = 0; i < this.length; i++) if (this[i]) yield this[i];
    },
  };

  Object.defineProperty(navigator, 'plugins', {
    get: () => fakePlugins,
    configurable: true,
  });

  // Also fake navigator.mimeTypes to match
  const fakeMimeTypes = {
    0: mkMime('application/pdf', 'pdf', 'Portable Document Format'),
    length: 1,
    item(i) { return this[i] || null; },
    namedItem(n) {
      for (let i = 0; i < this.length; i++) {
        if (this[i] && this[i].type === n) return this[i];
      }
      return null;
    },
    [Symbol.iterator]: function*() {
      for (let i = 0; i < this.length; i++) if (this[i]) yield this[i];
    },
  };

  Object.defineProperty(navigator, 'mimeTypes', {
    get: () => fakeMimeTypes,
    configurable: true,
  });
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 4. navigator.languages — use system locale, not hardcoded
//    Real Chrome had: ['en-US', 'vi-VN', 'vi', 'en']
//    Fallback to navigator.language if available
// ══════════════════════════════════════════════════════════════════════
try {
  // Try to detect system languages from navigator.language
  const primaryLang = navigator.language || 'en-US';
  const langs = [primaryLang];
  // Add base language if primary has region
  if (primaryLang.includes('-')) {
    const baseLang = primaryLang.split('-')[0];
    // Add common locale variant for non-English
    if (baseLang !== 'en' && !langs.includes(`${baseLang}-${baseLang.toUpperCase()}`)) {
      // Don't duplicate if already primary
    }
    if (!langs.includes(baseLang)) langs.push(baseLang);
  }
  // Always include en-US and en if not already
  if (!langs.includes('en-US')) langs.push('en-US');
  if (!langs.includes('en')) langs.push('en');

  Object.defineProperty(navigator, 'languages', {
    get: () => Object.freeze([...langs]),
    configurable: true,
  });
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 5. navigator.pdfViewerEnabled — must be true in real Chrome
// ══════════════════════════════════════════════════════════════════════
try {
  Object.defineProperty(navigator, 'pdfViewerEnabled', {
    get: () => true,
    configurable: true,
  });
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 6. window.chrome — comprehensive fake matching real Chrome
//    Includes: runtime, app, csi, loadTimes
// ══════════════════════════════════════════════════════════════════════
try {
  if (!window.chrome) {
    window.chrome = {};
  }

  // 6a. chrome.app — puppeteer-stealth chrome.app evasion
  if (!window.chrome.app) {
    window.chrome.app = {
      isInstalled: false,
      InstallState: {
        DISABLED: 'disabled',
        INSTALLED: 'installed',
        NOT_INSTALLED: 'not_installed',
      },
      RunningState: {
        CANNOT_RUN: 'cannot_run',
        READY_TO_RUN: 'ready_to_run',
        RUNNING: 'running',
      },
      getDetails: function() { return null; },
      getIsInstalled: function() { return false; },
      installState: function() { return 'not_installed'; },
      runningState: function() { return 'cannot_run'; },
    };
  }

  // 6b. chrome.runtime — must exist but with proper error handling
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      OnInstalledReason: {
        CHROME_UPDATE: 'chrome_update',
        INSTALL: 'install',
        SHARED_MODULE_UPDATE: 'shared_module_update',
        UPDATE: 'update',
      },
      OnRestartRequiredReason: {
        APP_UPDATE: 'app_update',
        OS_UPDATE: 'os_update',
        PERIODIC: 'periodic',
      },
      PlatformArch: {
        ARM: 'arm',
        ARM64: 'arm64',
        MIPS: 'mips',
        MIPS64: 'mips64',
        X86_32: 'x86-32',
        X86_64: 'x86-64',
      },
      PlatformNaclArch: {
        ARM: 'arm',
        MIPS: 'mips',
        MIPS64: 'mips64',
        X86_32: 'x86-32',
        X86_64: 'x86-64',
      },
      PlatformOs: {
        ANDROID: 'android',
        CROS: 'cros',
        LINUX: 'linux',
        MAC: 'mac',
        OPENBSD: 'openbsd',
        WIN: 'win',
      },
      RequestUpdateCheckStatus: {
        NO_UPDATE: 'no_update',
        THROTTLED: 'throttled',
        UPDATE_AVAILABLE: 'update_available',
      },
      connect: function() {
        return {
          onMessage: { addListener() {}, removeListener() {} },
          onDisconnect: { addListener() {}, removeListener() {} },
          postMessage() {},
        };
      },
      sendMessage: function() {
        // Chrome throws specific error for invalid extension ID
      },
      id: undefined,
    };
  }

  // 6c. chrome.csi — using Performance API for realistic values
  if (!window.chrome.csi) {
    window.chrome.csi = function() {
      const perfTiming = performance.timing || {};
      return {
        onloadT: perfTiming.domContentLoadedEventEnd || Date.now(),
        startE: perfTiming.navigationStart || Date.now(),
        pageT: performance.now(),
        tran: 15,
      };
    };
  }

  // 6d. chrome.loadTimes — using Performance API for realistic values
  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function() {
      const perfTiming = performance.timing || {};
      const navStart = perfTiming.navigationStart || Date.now();
      const connInfo = performance.getEntriesByType?.('navigation')?.[0]?.nextHopProtocol || 'h2';
      return {
        commitLoadTime: (perfTiming.responseStart || navStart) / 1000,
        connectionInfo: connInfo,
        finishDocumentLoadTime: (perfTiming.domContentLoadedEventEnd || navStart) / 1000,
        finishLoadTime: (perfTiming.loadEventEnd || navStart) / 1000,
        firstPaintAfterLoadTime: 0,
        firstPaintTime: (perfTiming.domContentLoadedEventEnd || navStart) / 1000,
        navigationType: 'Other',
        npnNegotiatedProtocol: connInfo,
        requestTime: (perfTiming.requestStart || navStart) / 1000,
        startLoadTime: navStart / 1000,
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: connInfo === 'h2',
        wasNpnNegotiated: connInfo === 'h2',
      };
    };
  }
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 7. Permissions API normalization
//    Headless Chrome throws on Permissions.query({ name: 'notifications' })
// ══════════════════════════════════════════════════════════════════════
try {
  const origQuery = window.Permissions?.prototype?.query;
  if (origQuery) {
    window.Permissions.prototype.query = function(parameters) {
      if (parameters?.name === 'notifications') {
        return Promise.resolve({
          state: Notification.permission || 'default',
          onchange: null,
        });
      }
      return origQuery.call(this, parameters);
    };
  }
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 8. Media codecs — report proper codec support
//    Headless Chrome reports limited codec support
// ══════════════════════════════════════════════════════════════════════
try {
  const origCanPlayType = HTMLMediaElement.prototype.canPlayType;
  HTMLMediaElement.prototype.canPlayType = function(type) {
    // H.264 video — real Chrome returns 'probably'
    if (type && (
      type.includes('avc1') ||
      type.includes('mp4') ||
      type.includes('video/mp4')
    )) {
      return 'probably';
    }
    // AAC/MP3 audio — real Chrome returns 'probably' or 'maybe'
    if (type && (
      type.includes('mp4a') ||
      type.includes('audio/mp4') ||
      type.includes('audio/mpeg')
    )) {
      return 'probably';
    }
    return origCanPlayType.call(this, type);
  };
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 9. WebGL vendor/renderer spoofing
//    Electron may report different GPU info or fail entirely
//    Spoof to common Apple GPU values for macOS
// ══════════════════════════════════════════════════════════════════════
try {
  const UNMASKED_VENDOR_WEBGL = 0x9245;   // WEBGL_debug_renderer_info.UNMASKED_VENDOR_WEBGL
  const UNMASKED_RENDERER_WEBGL = 0x9246; // WEBGL_debug_renderer_info.UNMASKED_RENDERER_WEBGL

  const spoofVendor = 'Google Inc. (Apple)';
  const spoofRenderer = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)';

  // Patch both WebGL and WebGL2
  for (const ctx of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    const proto = window[ctx]?.prototype;
    if (!proto) continue;

    const origGetParameter = proto.getParameter;
    proto.getParameter = function(param) {
      if (param === UNMASKED_VENDOR_WEBGL) return spoofVendor;
      if (param === UNMASKED_RENDERER_WEBGL) return spoofRenderer;
      return origGetParameter.call(this, param);
    };

    // Also patch getExtension to ensure WEBGL_debug_renderer_info is available
    const origGetExtension = proto.getExtension;
    proto.getExtension = function(name) {
      if (name === 'WEBGL_debug_renderer_info') {
        return {
          UNMASKED_VENDOR_WEBGL,
          UNMASKED_RENDERER_WEBGL,
        };
      }
      return origGetExtension.call(this, name);
    };
  }
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 10. window.outerWidth / outerHeight fix
//     In some Electron WebContentsView configurations these can be 0
// ══════════════════════════════════════════════════════════════════════
try {
  if (window.outerWidth === 0 || window.outerHeight === 0) {
    Object.defineProperty(window, 'outerWidth', {
      get: () => window.innerWidth,
      configurable: true,
    });
    Object.defineProperty(window, 'outerHeight', {
      get: () => window.innerHeight + 85, // Chrome's typical toolbar height
      configurable: true,
    });
  }
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 11. iframe.contentWindow proxy
//     Prevents detection through cross-origin iframe checks
// ══════════════════════════════════════════════════════════════════════
try {
  const origHTMLIFrameElement = HTMLIFrameElement.prototype;
  const origContentWindowDesc = Object.getOwnPropertyDescriptor(origHTMLIFrameElement, 'contentWindow');
  if (origContentWindowDesc) {
    Object.defineProperty(origHTMLIFrameElement, 'contentWindow', {
      get: function() {
        const iframe = origContentWindowDesc.get.call(this);
        if (!iframe) return iframe;
        // If it's a same-origin iframe, patch its navigator too
        try {
          if (iframe.navigator && iframe.navigator.webdriver !== false) {
            Object.defineProperty(iframe.navigator, 'webdriver', {
              get: () => false,
              configurable: true,
            });
          }
        } catch (_) { /* cross-origin — can't access, which is fine */ }
        return iframe;
      },
      configurable: true,
    });
  }
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 12. Clean automation artifacts
//     Remove properties left by Playwright, Puppeteer, or CDP injection
// ══════════════════════════════════════════════════════════════════════
try {
  delete window.__playwright;
  delete window.__puppeteer;
  delete window.__selenium_evaluate;
  delete window.__webdriver_evaluate;
  delete window.__selenium_unwrapped;
  delete window.__webdriver_script_function;
  delete window.__webdriver_script_func;
  delete window.__webdriver_script_fn;
  delete window.__fxdriver_evaluate;
  delete window.__driver_evaluate;
  delete window.__driver_unwrapped;
  delete window.domAutomation;
  delete window.domAutomationController;
  delete window._phantom;
  delete window.callPhantom;
  delete window._selenium;
  delete window.calledSelenium;

  // ChromeDriver injects cdc_ prefixed globals; suffix varies by version
  for (const prop of Object.getOwnPropertyNames(window)) {
    if (prop.startsWith('cdc_') || prop.startsWith('__cdc_')) {
      try { delete window[prop]; } catch (_) {}
    }
  }
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 13. CDP stack trace cleanup
//     Filter out automation tool frames from Error.stack
//     Websites do: new Error().stack to detect automation
// ══════════════════════════════════════════════════════════════════════
try {
  const _origDescriptor = Object.getOwnPropertyDescriptor(Error.prototype, 'stack');
  const _cdpPatterns = [
    'puppeteer_evaluation_script',
    'pptr:',
    'debugger://',
    '__playwright',
    '__puppeteer',
    '__crawbot',
    'electron/browser/',
    'ELECTRON_',
  ];
  if (_origDescriptor && _origDescriptor.get) {
    Object.defineProperty(Error.prototype, 'stack', {
      get: function() {
        const raw = _origDescriptor.get.call(this);
        if (typeof raw !== 'string') return raw;
        return raw.split('\n').filter(line =>
          !_cdpPatterns.some(p => line.includes(p))
        ).join('\n');
      },
      configurable: true,
    });
  }
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 14. Document.prototype.hasFocus — always true
//     Automated browsers may report false since window isn't focused
// ══════════════════════════════════════════════════════════════════════
try {
  Document.prototype.hasFocus = function() { return true; };
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 15. Notification.permission — normalize to 'default'
//     Electron may report 'granted' which is unusual for first visit
// ══════════════════════════════════════════════════════════════════════
try {
  Object.defineProperty(Notification, 'permission', {
    get: () => 'default',
    configurable: true,
  });
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 16. Screen and connection properties — ensure consistent values
// ══════════════════════════════════════════════════════════════════════
try {
  // Ensure screen.colorDepth matches real Chrome (30 on Retina)
  if (screen.colorDepth === 24) {
    Object.defineProperty(screen, 'colorDepth', {
      get: () => 30,
      configurable: true,
    });
    Object.defineProperty(screen, 'pixelDepth', {
      get: () => 30,
      configurable: true,
    });
  }
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 17. Performance.prototype.memory — add if missing
//     Some fingerprinters check for this Chrome-specific API
// ══════════════════════════════════════════════════════════════════════
try {
  if (!performance.memory) {
    Object.defineProperty(performance, 'memory', {
      get: () => ({
        jsHeapSizeLimit: 4294705152,
        totalJSHeapSize: 35100000 + Math.floor(Math.random() * 1000000),
        usedJSHeapSize: 25100000 + Math.floor(Math.random() * 1000000),
      }),
      configurable: true,
    });
  }
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 18. navigator.connection — ensure realistic values
// ══════════════════════════════════════════════════════════════════════
try {
  if (navigator.connection) {
    const conn = navigator.connection;
    // Ensure realistic values
    if (!conn.effectiveType) {
      Object.defineProperty(conn, 'effectiveType', { get: () => '4g', configurable: true });
    }
    if (!conn.rtt || conn.rtt === 0) {
      Object.defineProperty(conn, 'rtt', { get: () => 50, configurable: true });
    }
    if (!conn.downlink || conn.downlink === 0) {
      Object.defineProperty(conn, 'downlink', { get: () => 10, configurable: true });
    }
  }
} catch (_) {}

// ══════════════════════════════════════════════════════════════════════
// 19. Canvas fingerprint consistency
//     Add slight noise to canvas to prevent exact matching but keep consistent
// ══════════════════════════════════════════════════════════════════════
try {
  const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
  const origToBlob = HTMLCanvasElement.prototype.toBlob;
  const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;

  // Add minimal noise to canvas data to break exact fingerprint matching
  // while maintaining visual consistency
  const addNoise = (imageData) => {
    const data = imageData.data;
    // Only modify a tiny fraction of pixels to avoid visual artifacts
    for (let i = 0; i < data.length; i += 400) {
      data[i] = data[i] ^ 1; // XOR with 1 — invisible change
    }
    return imageData;
  };

  CanvasRenderingContext2D.prototype.getImageData = function(...args) {
    const imageData = origGetImageData.apply(this, args);
    // Only add noise to small canvases (fingerprint probes)
    if (imageData.width <= 500 && imageData.height <= 200) {
      return addNoise(imageData);
    }
    return imageData;
  };
} catch (_) {}
