# Anti-Detection Research & Implementation

> Research conducted 2026-03-31. Covers browser fingerprint evasion techniques
> for making CrawBot's Electron WebContentsView indistinguishable from real Chrome.

## Table of Contents

- [Problem Statement](#problem-statement)
- [Fingerprint Comparison: Real Chrome vs CrawBot](#fingerprint-comparison-real-chrome-vs-crawbot)
- [Root Cause Analysis](#root-cause-analysis)
- [Research Sources](#research-sources)
- [Technique Catalog](#technique-catalog)
- [Implementation Summary](#implementation-summary)
- [Files Changed](#files-changed)
- [Verification Procedure](#verification-procedure)

---

## Problem Statement

Shopee.vn (and other anti-bot-protected sites) detect CrawBot's built-in browser
as automated/Electron and redirect to a captcha page that fails to render.
Even though cookies are correctly imported from the user's real Chrome session,
the browser fingerprint mismatches trigger anti-bot protection.

The captcha URL pattern:
```
https://shopee.vn/verify/captcha?anti_bot_tracking_id=...
```

---

## Fingerprint Comparison: Real Chrome vs CrawBot

Data collected via CDP on both browsers visiting `shopee.vn`.

### Chrome 146 (real, logged in, working)

```json
{
  "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
  "platform": "MacIntel",
  "languages": ["en-US", "vi-VN", "vi", "en"],
  "hardwareConcurrency": 10,
  "deviceMemory": 8,
  "maxTouchPoints": 0,
  "webdriver": false,
  "plugins_count": 5,
  "plugins_names": ["PDF Viewer", "Chrome PDF Viewer", "Chromium PDF Viewer", "Microsoft Edge PDF Viewer", "WebKit built-in PDF"],
  "cookieEnabled": true,
  "doNotTrack": null,
  "vendor": "Google Inc.",
  "vendorSub": "",
  "productSub": "20030107",
  "chrome_runtime": "undefined",
  "chrome_app": "object",
  "chrome_csi": "function",
  "chrome_loadTimes": "function",
  "screen_width": 1800,
  "screen_height": 1169,
  "screen_colorDepth": 30,
  "devicePixelRatio": 2,
  "innerWidth": 1800,
  "innerHeight": 930,
  "outerWidth": 1800,
  "outerHeight": 1069,
  "pdf_viewer": true,
  "windowChrome_keys": ["loadTimes", "csi", "app", ...],
  "webgl_vendor": "Google Inc. (Apple)",
  "webgl_renderer": "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)",
  "userAgentData": {
    "brands": [
      {"brand": "Chromium", "version": "146"},
      {"brand": "Google Chrome", "version": "146"},
      {"brand": "Not-A.Brand", "version": "99"}
    ],
    "mobile": false,
    "platform": "macOS"
  },
  "permissions_notification": "default",
  "connection": {"effectiveType": "4g", "downlink": 10, "rtt": 50}
}
```

### CrawBot Electron (before fix, captcha blocked)

```json
{
  "userAgent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.177 Safari/537.36",
  "platform": "MacIntel",
  "languages": ["en-US", "en"],
  "hardwareConcurrency": 10,
  "deviceMemory": 8,
  "maxTouchPoints": 0,
  "plugins_count": 5,
  "plugins_names": [null, null, null, null, null],
  "cookieEnabled": true,
  "doNotTrack": null,
  "vendor": "Google Inc.",
  "vendorSub": "",
  "productSub": "20030107",
  "chrome_runtime": "undefined",
  "chrome_app": "undefined",
  "chrome_csi": "undefined",
  "chrome_loadTimes": "undefined",
  "screen_width": 1800,
  "screen_height": 1169,
  "screen_colorDepth": 30,
  "devicePixelRatio": 2,
  "innerWidth": 863,
  "innerHeight": 928,
  "outerWidth": 1800,
  "outerHeight": 1069,
  "pdf_viewer": true,
  "windowChrome_keys": [],
  "webgl_error": "Cannot read properties of null (reading 'getExtension')",
  "userAgentData": {
    "brands": [
      {"brand": "Not(A:Brand", "version": "8"},
      {"brand": "Chromium", "version": "144"}
    ],
    "mobile": false,
    "platform": "macOS"
  },
  "permissions_notification": "granted",
  "connection": {"effectiveType": "4g", "downlink": 10, "rtt": 50}
}
```

### Difference Table

| Property | Chrome (real) | CrawBot (before fix) | Detection Risk |
|----------|--------------|---------------------|----------------|
| **User Agent version** | Chrome/146 | Chrome/144 (Electron's Chromium) | Medium |
| **languages** | `['en-US','vi-VN','vi','en']` | `['en-US','en']` | Medium |
| **webdriver** | `false` | `undefined` (missing) | **CRITICAL** |
| **plugins names** | 5 real names | 5x `null` | **CRITICAL** |
| **window.chrome.app** | `"object"` | `"undefined"` | High |
| **window.chrome.csi** | `"function"` | `"undefined"` | High |
| **window.chrome.loadTimes** | `"function"` | `"undefined"` | High |
| **windowChrome_keys** | Has keys | `[]` (empty) | **CRITICAL** |
| **userAgentData brands** | Chromium + **Google Chrome** | Only Chromium (no Google Chrome) | **CRITICAL** |
| **WebGL** | Works (Apple M1 Pro) | **Error** (null) | **CRITICAL** |
| **Notification.permission** | `"default"` | `"granted"` | Medium |

---

## Root Cause Analysis

CrawBot has two types of browser views:

1. **AutomationViews** (`automation-views.ts`) — Used for the Chat browser panel
   - Partition: `persist:browser-shared`
   - `contextIsolation: true`, `sandbox: true`
   - **NO preload script** (no anti-detection at all!)
   - Only had a weak `dom-ready` injection: `webdriver=undefined, plugins=[1,2,3,4,5]`

2. **WebAuthViews** (`webauth-views.ts`) — Used for provider login
   - Partition: `persist:webauth-*`
   - `contextIsolation: false`, `sandbox: false`
   - Has `anti-detection-preload.cjs` preload
   - Has proper header hooks

The Shopee page opens in **AutomationViews** which had zero anti-detection.
Additionally, `app.disableHardwareAcceleration()` in `index.ts` completely
disabled WebGL across the entire app.

### Why preload didn't work on AutomationViews

With `contextIsolation: true`, preload scripts run in an isolated world.
Any modifications to `window`, `navigator`, etc. are NOT visible to page
scripts. The preload approach requires `contextIsolation: false` to share
the same JavaScript world with the page.

---

## Research Sources

### 1. opencli (github.com/jackwener/opencli)

**File:** `src/browser/stealth.ts`

Key techniques:
- `navigator.webdriver = false` (not `undefined` — returning `undefined` is itself detectable)
- Guard against double-injection using non-enumerable property on `EventTarget.prototype`
- Automation artifact cleanup: delete `__playwright`, `__puppeteer`, `cdc_*` globals
- CDP stack trace cleanup: override `Error.prototype.stack` getter to filter out
  `puppeteer_evaluation_script`, `pptr:`, `debugger://`, `__playwright` frames
- `window.chrome` stub with `runtime`, `loadTimes`, `csi`
- Plugin faking only when `navigator.plugins.length === 0`
- `Permissions.prototype.query` (not `navigator.permissions.query`) for proper prototype chain

### 2. puppeteer-extra-plugin-stealth (github.com/berstend/puppeteer-extra)

17 evasion modules:

| Module | What it does |
|--------|-------------|
| `chrome.app` | Mock `window.chrome.app` with `isInstalled`, `InstallState`, `RunningState`, `getDetails()` |
| `chrome.csi` | Fake `chrome.csi()` using Performance Timing API |
| `chrome.loadTimes` | Fake `chrome.loadTimes()` using Performance API + navigation entries |
| `chrome.runtime` | Proper `chrome.runtime` with `OnInstalledReason`, `PlatformArch`, `connect()`, `sendMessage()` |
| `navigator.plugins` | Full `PluginArray` + `MimeTypeArray` mock with cross-references |
| `navigator.webdriver` | Delete from prototype (their approach) |
| `iframe.contentWindow` | Proxy `HTMLIFrameElement.contentWindow` to mask automation markers in iframes |
| `media.codecs` | Proxy `canPlayType()` to return `'probably'` for H.264, AAC |
| `sourceurl` | Strip `//# sourceURL=__puppeteer_evaluation_script__` from CDP evaluations |
| `window.outerdimensions` | Fix `outerWidth`/`outerHeight` (0 in headless, add 85px toolbar offset) |
| `defaultArgs` | Filter adversarial Chrome launch args |
| `navigator.hardwareConcurrency` | Proxy getter to return configurable value (default: 4) |
| `navigator.languages` | Proxy getter returning frozen array |
| `navigator.permissions` | Normalize `Notification.permission` to `'default'` on secure origins |
| `navigator.vendor` | Proxy getter returning `'Google Inc.'` |
| `user-agent-override` | CDP-level UA override with `userAgentMetadata` (brands, architecture) |
| `webgl.vendor` | Proxy `getParameter()` for `UNMASKED_VENDOR_WEBGL` (37445) and `UNMASKED_RENDERER_WEBGL` (37446) |

### 3. rebrowser-patches (github.com/rebrowser/rebrowser-patches)

Focus: CDP protocol-level leaks that JavaScript patches can't fix.

**Primary detection vector: `Runtime.Enable`**

When Playwright/Puppeteer call `Runtime.Enable`, anti-bot systems (Cloudflare, DataDome)
can detect the resulting execution context creation events.

Three mitigation strategies:
1. **addBinding** (default) — Create bindings in main execution context to get context IDs
   without triggering `Runtime.Enable`
2. **alwaysIsolated** — Execute scripts in separate isolated contexts via `Page.createIsolatedWorld`
3. **enableDisable** — Rapidly call then disable `Runtime.Enable` to minimize exposure

**Secondary leaks:**
- `sourceURL` leak: evaluated scripts include `//# sourceURL=pptr:...`
  - Fix: `REBROWSER_PATCHES_SOURCE_URL='app.js'`
- Utility world naming: `__puppeteer_utility_world__[version]` is predictable
  - Fix: `REBROWSER_PATCHES_UTILITY_WORLD_NAME='utility_world'`

**Environment variables:**
```
REBROWSER_PATCHES_RUNTIME_FIX_MODE=addBinding|alwaysIsolated|enableDisable|0
REBROWSER_PATCHES_SOURCE_URL=app.js
REBROWSER_PATCHES_UTILITY_WORLD_NAME=utility_world
```

### 4. patchright (github.com/Kaliiiiiiiiii-Vinyzu/patchright)

Playwright fork with built-in stealth patches:

- `--disable-blink-features=AutomationControlled` — prevents Blink engine from setting
  `navigator.webdriver = true`
- Removes `--enable-automation` flag
- Removes `--disable-popup-blocking`
- Avoids `Runtime.enable` by executing JS in isolated ExecutionContexts
- Disables `Console.enable` entirely (console won't work, but eliminates detection vector)
- Injects InitScript via Playwright Routes (HTML request injection) instead of CDP
- Can interact with Closed Shadow DOM elements using standard locators

---

## Technique Catalog

Complete list of all anti-detection techniques, organized by category.

### A. Navigator Properties

| # | Property | Real Chrome Value | Detection Method | Fix |
|---|----------|------------------|------------------|-----|
| 1 | `navigator.webdriver` | `false` | `=== true` or `=== undefined` | `Object.defineProperty → false` |
| 2 | `navigator.plugins` | 5 named plugins | `.length === 0` or `.name === null` | Fake PluginArray with real names |
| 3 | `navigator.mimeTypes` | Has PDF type | `.length === 0` | Fake MimeTypeArray |
| 4 | `navigator.languages` | System locale array | Empty or hardcoded `['en-US']` | Use `navigator.language` + add base |
| 5 | `navigator.pdfViewerEnabled` | `true` | `=== false` or `undefined` | `defineProperty → true` |
| 6 | `navigator.userAgentData` | Has "Google Chrome" brand | Missing brand or only "Chromium" | Fake `NavigatorUAData` with brands |
| 7 | `navigator.connection` | `{effectiveType:'4g', rtt:50, downlink:10}` | Missing or zero values | Ensure realistic values |
| 8 | `navigator.hardwareConcurrency` | System value (e.g., 10) | `=== 0` or very low | Proxy getter if needed |
| 9 | `navigator.vendor` | `"Google Inc."` | Empty or wrong | Already correct in Electron |
| 10 | `navigator.permissions.query` | Returns proper state | Throws for 'notifications' | Patch `Permissions.prototype.query` |

### B. Window / Chrome Object

| # | Property | Real Chrome | Electron Default | Fix |
|---|----------|-------------|-----------------|-----|
| 11 | `window.chrome.app` | Object with `isInstalled`, etc. | `undefined` | Full mock |
| 12 | `window.chrome.runtime` | Object with enums + methods | `undefined` | Full mock with `OnInstalledReason`, etc. |
| 13 | `window.chrome.csi` | Function returning timing | `undefined` | Use Performance API |
| 14 | `window.chrome.loadTimes` | Function returning timing | `undefined` | Use Performance API |
| 15 | `window.outerWidth/Height` | Matches screen with toolbar | May be 0 | Derive from `innerWidth` + 85px |
| 16 | `Document.hasFocus()` | `true` when focused | May be `false` | Override to return `true` |

### C. Rendering / GPU

| # | Property | Real Chrome | Electron Default | Fix |
|---|----------|-------------|-----------------|-----|
| 17 | WebGL vendor | `"Google Inc. (Apple)"` | Error / unavailable | Proxy `getParameter(37445)` |
| 18 | WebGL renderer | `"ANGLE (Apple, ...M1 Pro...)"` | Error / unavailable | Proxy `getParameter(37446)` |
| 19 | `WEBGL_debug_renderer_info` ext | Available | May be null | Return fake extension object |
| 20 | `screen.colorDepth` | 30 (Retina) | 24 (sometimes) | Override if 24 |
| 21 | Canvas fingerprint | Consistent | May differ | Add minimal noise to small canvases |

### D. Media

| # | Property | Real Chrome | Electron | Fix |
|---|----------|-------------|----------|-----|
| 22 | `canPlayType('video/mp4; codecs="avc1.42E01E"')` | `'probably'` | May differ | Proxy `canPlayType` |

### E. HTTP Headers

| # | Header | Real Chrome | Electron Default | Fix |
|---|--------|-------------|-----------------|-----|
| 23 | `sec-ch-ua` | Includes "Google Chrome" | Only "Chromium" | Rewrite in `onBeforeSendHeaders` |
| 24 | `sec-ch-ua-platform` | `"macOS"` | May be missing | Set explicitly |
| 25 | `sec-ch-ua-mobile` | `?0` | May be missing | Set explicitly |
| 26 | `sec-ch-ua-full-version-list` | Full Chrome version | Missing Chrome | Rewrite with full list |
| 27 | `Sec-Fetch-Dest` | `document` | `webview` | Rewrite `webview` → `document` |
| 28 | `X-Electron-Version` | Not present | Present! | Delete header |

### F. Automation Artifact Cleanup

| # | Artifact | Source | Fix |
|---|----------|--------|-----|
| 29 | `window.__playwright` | Playwright | `delete` |
| 30 | `window.__puppeteer` | Puppeteer | `delete` |
| 31 | `window.cdc_*` | ChromeDriver | Scan + `delete` all `cdc_` prefixed |
| 32 | `window.__selenium_*` | Selenium | `delete` |
| 33 | `window.domAutomation*` | Chrome automation | `delete` |
| 34 | `window._phantom` / `callPhantom` | PhantomJS | `delete` |

### G. Error Stack Trace Cleanup

| # | Pattern | Source | Fix |
|---|---------|--------|-----|
| 35 | `puppeteer_evaluation_script` | Puppeteer CDP eval | Filter from `Error.prototype.stack` |
| 36 | `pptr:` | Puppeteer | Filter |
| 37 | `debugger://` | DevTools | Filter |
| 38 | `__playwright` | Playwright | Filter |
| 39 | `electron/browser/` | Electron preload | Filter |
| 40 | `ELECTRON_` | Electron internals | Filter |

### H. Electron Command-Line Switches

| # | Switch | Purpose |
|---|--------|---------|
| 41 | `--disable-blink-features=AutomationControlled` | Prevents Blink from setting `webdriver=true` |
| 42 | Remove `--enable-automation` | Removes "controlled by automation" infobar |
| 43 | Remove `app.disableHardwareAcceleration()` | Re-enables WebGL (critical for fingerprint) |

### I. Iframe Protection

| # | Technique | Purpose |
|---|-----------|---------|
| 44 | Proxy `HTMLIFrameElement.contentWindow` | Patch `webdriver` in iframe contexts too |

### J. Notification Permission

| # | Technique | Purpose |
|---|-----------|---------|
| 45 | `Notification.permission → 'default'` | Electron returns `'granted'` which is unusual for first visit |

### K. Performance Memory

| # | Technique | Purpose |
|---|-----------|---------|
| 46 | `performance.memory` mock | Chrome-specific API, some fingerprinters check for it |

---

## Implementation Summary

### anti-detection-preload.cjs (19 techniques applied)

The preload script runs at `document_start` (before any page JS) with
`contextIsolation: false` so modifications affect the page's main world.

Techniques implemented: #1, #2, #3, #4, #5, #6, #7, #10, #11, #12, #13, #14,
#15, #16, #17, #18, #19, #20, #21, #22, #29-40, #44, #45, #46

### automation-views.ts changes

- Changed from `contextIsolation: true, sandbox: true` (no preload)
  to `contextIsolation: false, sandbox: false` with `ANTI_DETECTION_PRELOAD`
- Enhanced `onBeforeSendHeaders`: techniques #23-28
- Replaced weak dom-ready injection with defense-in-depth re-enforcement

### manager.ts changes

- Enhanced `ensureSessionConfig` with full header set: #23-28

### index.ts changes

- Removed `app.disableHardwareAcceleration()`: technique #43
- Added `--disable-blink-features=AutomationControlled`: technique #41
- Added `removeSwitch('enable-automation')`: technique #42

### webauth-wcv-preload.cjs

- Now `require('./anti-detection-preload.cjs')` instead of duplicating code

### webauth-views.ts

- Synced dom-ready injection with `webdriver=false` and artifact cleanup

---

## Verification Procedure

### Step 1: Collect fingerprint from both browsers

Use CDP to run this script on both real Chrome and CrawBot browser:

```javascript
(async () => {
  const result = {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    languages: navigator.languages,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory,
    maxTouchPoints: navigator.maxTouchPoints,
    webdriver: navigator.webdriver,
    plugins_count: navigator.plugins.length,
    plugins_names: Array.from(navigator.plugins).map(p => p.name),
    cookieEnabled: navigator.cookieEnabled,
    vendor: navigator.vendor,
    productSub: navigator.productSub,
    chrome_runtime: typeof window.chrome?.runtime,
    chrome_app: typeof window.chrome?.app,
    chrome_csi: typeof window.chrome?.csi,
    chrome_loadTimes: typeof window.chrome?.loadTimes,
    screen_colorDepth: screen.colorDepth,
    devicePixelRatio: window.devicePixelRatio,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    outerWidth: window.outerWidth,
    outerHeight: window.outerHeight,
    pdf_viewer: navigator.pdfViewerEnabled,
    windowChrome_keys: Object.keys(window.chrome || {}),
  };
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl');
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    result.webgl_vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
    result.webgl_renderer = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch(e) { result.webgl_error = e.message; }
  try {
    result.userAgentData = navigator.userAgentData
      ? { brands: navigator.userAgentData.brands, mobile: navigator.userAgentData.mobile, platform: navigator.userAgentData.platform }
      : null;
  } catch(e) {}
  return JSON.stringify(result, null, 2);
})()
```

### Step 2: Connect to CrawBot via CDP

```bash
# List all CDP targets
curl -s http://127.0.0.1:9222/json | python3 -m json.tool

# Run script on specific target
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/TARGET_ID');
ws.on('open', () => {
  ws.send(JSON.stringify({
    id: 1,
    method: 'Runtime.evaluate',
    params: { expression: SCRIPT, awaitPromise: true, returnByValue: true }
  }));
});
ws.on('message', (data) => {
  const resp = JSON.parse(data);
  if (resp.id === 1) { console.log(resp.result?.result?.value); ws.close(); }
});
"
```

### Step 3: Compare key values

All these should match between real Chrome and CrawBot:

- [ ] `webdriver === false`
- [ ] `plugins_names` — 5 named plugins (not null)
- [ ] `chrome_app === "object"`
- [ ] `chrome_csi === "function"`
- [ ] `chrome_loadTimes === "function"`
- [ ] `windowChrome_keys` — non-empty array
- [ ] `userAgentData.brands` — includes "Google Chrome"
- [ ] `webgl_vendor` / `webgl_renderer` — not error
- [ ] `languages` — includes system locale
- [ ] `permissions_notification === "default"`

---

## Cookie & Storage Import System

### What the relay extension exports

The Chrome relay extension connects via CDP WebSocket at `ws://127.0.0.1:{relayPort}/cdp`
and provides two custom CDP commands:

1. **`CrawBot.getCookies`** — All HTTP cookies including httpOnly
2. **`CrawBot.getStorage`** — localStorage, sessionStorage, and IndexedDB data

### What gets imported

| Data Type | Imported? | Method |
|-----------|-----------|--------|
| Cookies (including httpOnly) | Yes | `ses.cookies.set()` per cookie |
| localStorage | Yes | `executeJavaScript()` injection |
| sessionStorage | Yes | `executeJavaScript()` injection |
| IndexedDB | Yes | `executeJavaScript()` with `indexedDB.open()` |
| Service Workers | No | Not exported by extension |
| Cache API | No | Not exported by extension |
| Cookie partitioning (CHIPS) | No | Partition keys not preserved |

### Cookie sameSite mapping (critical)

```
Chrome SQLite value → Electron value
-1 (unspecified)   → 'unspecified' (NOT 'lax'!)
 0 (no_restriction) → 'no_restriction'
 1 (lax)           → 'lax'
 2 (strict)        → 'strict'
```

Defaulting to `'lax'` instead of `'unspecified'` breaks Google auth cookies.

### Clear Site Data feature

Added `clearSiteData(partition, url)` in `cookie-manager.ts` that clears:
- All storage types: cookies, localStorage, sessionStorage, IndexedDB,
  Cache Storage, Service Workers, Shader Cache, WebSQL
- Domain cookies including parent/subdomain patterns (e.g., `.shopee.vn`)
- HTTP cache

UI: Trash2 icon button in BrowserToolbar, before the Import Cookies button.

---

## Techniques NOT Implemented (Future Work)

| Technique | Reason | Priority |
|-----------|--------|----------|
| `Runtime.enable` leak prevention | Requires patching Playwright internals (rebrowser-patches) | High if using Playwright |
| `sourceURL` cleanup for CDP evals | Would need CDP proxy modification | Medium |
| TLS/JA3 fingerprint | Electron uses system TLS, hard to change | Low |
| TCP fingerprint | OS-level, can't change from Electron | Low |
| Font enumeration spoofing | Complex, site-specific | Low |
| AudioContext fingerprint noise | Rarely checked | Low |
| Battery API spoofing | Deprecated in most browsers | Very low |
| Gamepad API spoofing | Rarely checked | Very low |

---

## Known Limitations

1. **Chrome version mismatch**: CrawBot uses Electron's bundled Chromium (e.g., 144)
   while real Chrome may be 146+. The UA string reflects Electron's version.
   This is inherent to Electron and can't be changed without updating Electron.

2. **`contextIsolation: false` security**: AutomationViews now runs with
   `contextIsolation: false` to enable the preload script. `nodeIntegration`
   remains `false` so page scripts can't access Node.js APIs, but this is
   a reduced security posture for arbitrary web content.

3. **WebGL spoofing vs real GPU**: The WebGL vendor/renderer values are hardcoded
   to Apple M1 Pro. On different hardware, this creates an inconsistency.
   Could be improved by detecting actual GPU at runtime.

4. **Hardware acceleration**: Removed `app.disableHardwareAcceleration()` to
   enable WebGL. If GPU crashes occur on specific hardware, may need
   per-platform fallback logic.
