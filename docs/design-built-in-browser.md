# CrawBot Built-in Browser — Design Document

> **Status:** Planning / Pre-implementation
> **Created:** 2025-03-14
> **Last updated:** 2025-03-14 (rev2 — critical fixes after design review)
>
> **IMPORTANT:** This document is the single source of truth for this feature.
> Read this file first after context compaction to recover full design context.

## 1. Overview

Tích hợp browser trực tiếp vào CrawBot, phục vụ 2 mục đích:

1. **WebAuth Providers (WebAuth):** Dùng web login session của các AI provider (Claude, ChatGPT, Gemini...) làm LLM API thay vì API key trả phí. Lấy ý tưởng từ [openclaw-zero-token](https://github.com/linuxhsj/openclaw-zero-token).
2. **OpenClaw Browser Tool:** Thay thế Chrome bên ngoài, cho phép OpenClaw agent điều khiển browser trực tiếp trong CrawBot qua CDP.

### Design Principles

- Tận dụng chính Chromium engine của Electron (không cần Chrome/Playwright bên ngoài)
- Browser Panel tích hợp trong Chat UI (toggle/detach)
- CDP debug server cho OpenClaw kết nối
- Session isolation per provider/tab

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ CrawBot Main Window (BrowserWindow)                         │
│ ┌──────────────────────┬──────────────────────────────────┐ │
│ │   Chat Panel         │  Browser Panel (toggle/detach)   │ │
│ │                      │  ┌────────────────────────────┐  │ │
│ │  [Messages...]       │  │ Tab Bar  [+] [claude.ai ×] │  │ │
│ │                      │  │ [chatgpt.com ×] [gemini ×]  │  │ │
│ │                      │  ├────────────────────────────┤  │ │
│ │                      │  │ URL Bar [🔒 claude.ai/...] │  │ │
│ │                      │  │ [← → ↻] [zoom] [cookie ⚙] │  │ │
│ │                      │  ├────────────────────────────┤  │ │
│ │                      │  │                            │  │ │
│ │                      │  │   <webview> content area   │  │ │
│ │                      │  │   (external web page)      │  │ │
│ │                      │  │                            │  │ │
│ │  [Input area...]     │  └────────────────────────────┘  │ │
│ └──────────────────────┴──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
         │                              │
         │ WebSocket JSON-RPC           │ CDP (port 9333)
         ▼                              ▼
   OpenClaw Gateway ──────────► Browser Tool connects via CDP
```

### Process Architecture

```
Electron Main Process
├── app.commandLine: --remote-debugging-port=9222 (internal, localhost only)
├── GatewayManager (existing)
├── BrowserManager (NEW)
│   ├── CDP Filter Proxy (port 9333) — thin HTTP+WS relay to real CDP 9222
│   │   ├── HTTP: /json/list → filter targets (hide main window + provider webviews)
│   │   ├── HTTP: /json/version → pass-through with port rewrite
│   │   └── WS: relay bytes unchanged ← → real CDP WebSocket
│   ├── Tab lifecycle management
│   ├── Session/cookie management
│   └── app.on('web-contents-created') → sync new targets to BrowserPanel
└── IPC Handlers (browser:* channels)

Electron Renderer Process
├── Chat Page (existing)
│   ├── ChatPanel (existing)
│   └── BrowserPanel (NEW)
│       ├── BrowserTabBar
│       ├── BrowserToolbar (URL, nav, zoom, cookies)
│       └── <webview> per tab (hidden/shown)
└── Zustand Store: useBrowserStore (NEW)
```

### Target Categories (CDP visibility)

```
webContents targets in Electron:
┌─────────────────────────┬──────────────┬─────────────────────────────┐
│ Target                  │ CDP visible? │ Notes                       │
├─────────────────────────┼──────────────┼─────────────────────────────┤
│ Main app window         │ HIDDEN       │ React UI, never expose      │
│ Browser automation tabs │ EXPOSED      │ OpenClaw browser tool uses  │
│ Zero-token webviews     │ HIDDEN       │ Internal API, not for agent │
└─────────────────────────┴──────────────┴─────────────────────────────┘

Filter logic in CDP proxy /json/list:
- Each webview has a webContents ID tracked by BrowserManager
- BrowserManager maintains a Set<number> of "cdp-exposed" webContents IDs
- Only targets whose webContents ID is in the exposed set appear in /json/list
- Automation tabs are added to exposed set on creation
- Provider (zero-token) webviews are never added to exposed set
```

## 3. Component Design

### 3.1 Browser Panel UI (Renderer)

**Location:** `src/pages/Chat/BrowserPanel.tsx`

Based on existing WorkspacePanel pattern (resizable right panel in Chat).

**Sub-components:**
- `BrowserTabBar.tsx` — Tab strip with add/close/reorder
- `BrowserToolbar.tsx` — URL bar, back/forward/reload, zoom controls, cookie menu
- `BrowserWebview.tsx` — Wrapper around `<webview>` tag with event handling
- `BrowserCookieManager.tsx` — Dialog for viewing/clearing cookies per site

**Zustand Store:** `src/stores/browser.ts`

```typescript
interface BrowserTab {
  id: string
  url: string
  title: string
  favicon?: string
  partition: string        // "persist:browser-shared" | "persist:browser-{domain}" | "browser-temp-{id}"
  isLoading: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoomFactor: number       // default 1.0
}

interface BrowserStore {
  // Panel state
  panelOpen: boolean
  panelWidth: number       // pixels, default 50% of window
  detached: boolean        // true = separate BrowserWindow

  // Tabs
  tabs: BrowserTab[]
  activeTabId: string | null

  // Actions
  togglePanel(): void
  setPanelWidth(w: number): void
  detachPanel(): void
  attachPanel(): void

  addTab(url?: string, partition?: string): void
  closeTab(id: string): void
  setActiveTab(id: string): void
  updateTab(id: string, updates: Partial<BrowserTab>): void

  // Navigation
  navigate(url: string): void
  goBack(): void
  goForward(): void
  reload(): void
  setZoom(factor: number): void
}
```

**Panel constraints:**
- MIN width: 320px
- MAX width: 1200px
- Default: 50% of available space
- Drag handle on left edge (wider 8px hit area, with drag overlay to prevent webview from stealing mouse events)

**Panel behavior:**
- **Always mounted** — BrowserPanel is always in the DOM. When closed, it is moved offscreen (`position:fixed, left:-9999`) with `visibility:hidden` so webviews remain fully active (not throttled by Chromium). This is critical for browser automation to work even when the panel is not visible.
- **Default tab** — When opening the panel for the first time (no tabs exist), automatically opens `https://crawbot.net` as the default tab.
- **Tab persistence** — Tabs (URLs, partitions, active tab) are persisted to localStorage via Zustand `persist` middleware. On app restart, all previously open tabs are restored.
- **Ctrl+W** — Closes the active tab when the browser panel is open.
- **Ctrl+T** — Opens a new tab (about:blank) when the browser panel is open.
- **Close vs Hide** — The panel close button (X) only hides the panel, it does NOT destroy tabs or webviews. Tabs remain active in the background.

### 3.2 webview Tag Usage

Each tab renders a `<webview>` element:

```html
<webview
  src={tab.url}
  partition={tab.partition}
  webpreferences="contextIsolation=yes"
  style={{ width: '100%', height: '100%' }}
/>
```

**Why `<webview>` over `WebContentsView`:**
- `webviewTag: true` already enabled in CrawBot
- Renders directly in React JSX (WebContentsView requires main process management)
- Each webview = separate renderer process (crash isolation)
- Built-in `partition` attribute for session isolation
- Rich event API: `did-navigate`, `did-fail-load`, `page-title-updated`, `page-favicon-updated`, etc.
- Built-in methods: `loadURL()`, `goBack()`, `goForward()`, `reload()`, `getURL()`, `getTitle()`, `setZoomFactor()`

**Known limitation:** Electron team recommends `WebContentsView` for new code. However, `WebContentsView` is managed from main process and cannot be directly embedded in React components. For our use case (browser tabs in a React panel), `<webview>` is the practical choice. If Electron removes webview support in future, migration path is to move tab content management to main process with `WebContentsView` + IPC.

### 3.3 CDP Hybrid Proxy (Main Process)

**Location:** `electron/browser/cdp-proxy.ts`

**Problem:** Two bad options —
- `--remote-debugging-port` alone exposes ALL webContents (main app UI + zero-token provider webviews)
- Custom CDP proxy via `webContents.debugger` API can't support the full CDP surface area (hundreds of methods across Target, Page, Runtime, DOM, Input, Accessibility, Network, Emulation... — building this is a multi-month effort and guaranteed to have compatibility gaps)

**Solution: Hybrid CDP Filter Proxy**

Use Electron's real `--remote-debugging-port` for 100% CDP compatibility, but put a thin proxy in front that filters targets:

```
OpenClaw Gateway (Playwright connectOverCDP)
         │
         ▼
CDP Filter Proxy (port 9333) — ~200 lines, thin relay
  │
  ├── GET /json/list
  │   → fetch real http://127.0.0.1:9222/json/list
  │   → FILTER: remove main window + zero-token webview targets
  │   → REWRITE: replace port 9222 → 9333 in webSocketDebuggerUrl
  │   → return filtered list
  │
  ├── GET /json/version
  │   → fetch real http://127.0.0.1:9222/json/version
  │   → REWRITE: port 9222 → 9333 in webSocketDebuggerUrl
  │   → return
  │
  ├── GET /json/protocol → pass-through
  │
  └── WS /devtools/page/{targetId}
      → Security check: is targetId in exposed set?
      → YES: create WS to ws://127.0.0.1:9222/devtools/page/{targetId}
             relay all bytes bidirectionally (zero interpretation)
      → NO: reject connection (403)

         ▼ (relay)
Electron's Real CDP Server (--remote-debugging-port=9222, localhost only)
```

**Why this works:**
- WebSocket is pure byte relay — 100% CDP compatible, zero protocol gaps
- HTTP endpoints are simple JSON filter + port rewrite
- ~200 lines of code total (not thousands)
- OpenClaw/Playwright works exactly as if connecting to real Chrome
- Main app window and zero-token webviews are invisible to OpenClaw
- New tabs created by OpenClaw via `Target.createTarget` work natively
- `app.on('web-contents-created')` detects new targets → syncs BrowserPanel UI

**Internal CDP port (9222) security:**
- Bound to `127.0.0.1` only (Electron default)
- Not advertised to OpenClaw — only the proxy port 9333 is in config
- Could be randomized per-session for extra safety

**OpenClaw config** (`~/.openclaw/openclaw.json`):
```json
{
  "browser": {
    "profiles": {
      "crawbot": {
        "cdpUrl": "http://127.0.0.1:9333",
        "driver": "openclaw",
        "attachOnly": true
      }
    },
    "defaultProfile": "crawbot"
  }
}
```

### 3.4 Session & Cookie Management

**Partition strategy:**

| Use case | Partition | Persists? |
|----------|-----------|-----------|
| General browsing | `persist:browser-shared` | Yes |
| Web provider auth (Claude) | `persist:webauth-claude` | Yes |
| Web provider auth (ChatGPT) | `persist:webauth-chatgpt` | Yes |
| Web provider auth (Gemini) | `persist:webauth-gemini` | Yes |
| Incognito / temp tab | `browser-temp-{uuid}` | No |

**Cookie management IPC channels:**

```
browser:cookies:get    → session.cookies.get({ url })
browser:cookies:set    → session.cookies.set(cookie)
browser:cookies:remove → session.cookies.remove(url, name)
browser:cookies:clear  → session.clearStorageData({ storages: ['cookies'] })
browser:cookies:export → session.cookies.get({}) → JSON
browser:cookies:import → loop session.cookies.set(cookie)
```

**Cookie Manager UI:**
- View all cookies for current tab's domain
- Delete individual cookies
- Clear all cookies for domain
- Reset entire session (clear all storage data)
- Export/import cookies as JSON (for backup/sharing)

### 3.5 Detach/Attach Window

**Embedded mode (default):**
- BrowserPanel renders inside Chat page as right panel
- webview tags are children of the panel div

**Detached mode:**
- Create new `BrowserWindow` with its own preload
- Move browser tab state to new window
- New window loads a dedicated `browser-window.html` route
- Main Chat panel regains full width
- Closing detached window → auto re-attach to panel

**IPC coordination:**
- Main process tracks detached state
- Renderer queries state via `browser:isDetached`
- Detach: `browser:detach` → main creates window, renderer hides panel
- Attach: `browser:attach` or window close → main destroys window, renderer shows panel

## 4. OpenClaw Browser Tool Replacement Strategy

**Goal:** OpenClaw's browser tool ALWAYS uses CrawBot's built-in browser. No external Chrome needed. No OpenClaw patches — config only.

### How OpenClaw Browser Tool Works (Reference)

Source: `~/openclaw/src/` — browser tool architecture:

```
Agent calls browser tool → browser-tool.ts
  → HTTP POST to browser control server (port 18791)
  → server-context.availability.ts: ensureBrowserAvailable()
  → Checks: is CDP endpoint reachable?
     ├── YES → Playwright connectOverCDP(cdpUrl) → use existing browser
     └── NO  → attachOnly: true?
              ├── YES → retry 1500ms → THROW ERROR (never launch)
              └── NO  → launchOpenClawChrome() → spawn new Chrome
```

**Key insight:** With `attachOnly: true` + `cdpUrl`, OpenClaw will NEVER launch its own Chrome. It will only connect to our CDP proxy.

### Config-Only Integration (No Patches)

CrawBot writes browser config to `~/.openclaw/openclaw.json` alongside existing config (agents, models, tools, etc.):

```json
{
  "agents": { "..." : "existing config" },
  "models": { "..." : "existing config" },
  "browser": {
    "enabled": true,
    "evaluateEnabled": true,
    "attachOnly": true,
    "defaultProfile": "crawbot",
    "profiles": {
      "crawbot": {
        "cdpUrl": "http://127.0.0.1:9333",
        "driver": "openclaw",
        "attachOnly": true,
        "color": "#3B82F6"
      }
    }
  }
}
```

**What this does:**
- `attachOnly: true` (global) → OpenClaw will NEVER launch its own Chrome
- `defaultProfile: "crawbot"` → All browser tool calls default to our CDP proxy
- `profiles.crawbot.cdpUrl` → Points to CrawBot's CDP Proxy Server
- `profiles.crawbot.driver: "openclaw"` → Uses standard Playwright CDP connection
- Removes the default "openclaw" profile → no fallback to self-launched Chrome

### Implementation in CrawBot

**New utility:** `electron/utils/browser-config.ts`

```typescript
// Called on app startup + gateway restart + CDP proxy start
export function setOpenClawBrowserConfig(cdpPort: number): void {
  // Same read-modify-write pattern as setOpenClawDefaultModel()
  // in electron/utils/openclaw-auth.ts (line 268-396)
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');
  let config = readExistingConfig(configPath);

  config.browser = {
    enabled: true,
    evaluateEnabled: true,
    attachOnly: true,
    defaultProfile: 'crawbot',
    profiles: {
      crawbot: {
        cdpUrl: `http://127.0.0.1:${cdpPort}`,
        driver: 'openclaw',
        attachOnly: true,
        color: '#3B82F6',
      },
    },
  };

  writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
}

// Called on app quit (restore default so OpenClaw CLI still works standalone)
export function removeOpenClawBrowserConfig(): void {
  // Remove browser key entirely → OpenClaw falls back to default behavior
  // (launches its own Chrome when used from CLI)
}
```

### Startup Sequence

```
CrawBot app starts
  │
  ├── 0. app.commandLine.appendSwitch('remote-debugging-port', '9222')
  │      └── MUST be before app.whenReady() — enables Electron's real CDP
  │
  ├── 1. Start CDP Filter Proxy (port 9333)
  │      └── Connects to real CDP at localhost:9222
  │      └── Listening but no exposed targets yet (no webview tabs open)
  │
  ├── 2. Write browser config to openclaw.json
  │      └── setOpenClawBrowserConfig(9333)
  │
  ├── 3. Start OpenClaw Gateway (existing flow)
  │      └── Gateway reads openclaw.json → browser.attachOnly=true, cdpUrl=9333
  │
  ├── 4. Register app.on('web-contents-created') listener
  │      └── Detects new webContents → syncs to BrowserPanel via IPC
  │
  └── 5. Agent uses browser tool
         └── Gateway → Playwright connectOverCDP("http://127.0.0.1:9333")
         └── Proxy filters /json/list → only shows automation tabs
         └── Agent opens URL → new webview appears in BrowserPanel
         └── All CDP commands (click, type, snapshot) work natively
```

### Edge Cases

**Agent requests browser but no tab exists:**
- CDP Proxy `/json/list` returns empty array
- OpenClaw creates a new page via CDP `Target.createTarget` (goes through WS relay to real CDP)
- Chromium natively creates a new target (page)
- `app.on('web-contents-created')` fires → BrowserManager detects new target
- BrowserManager adds target to exposed set + notifies renderer via IPC
- New tab appears in BrowserPanel
- Agent proceeds with the new tab

**CDP Proxy not ready when Gateway starts:**
- Browser tool is lazy — only called when agent explicitly uses it
- By the time agent uses browser tool, CDP Proxy is already running
- If somehow not ready: OpenClaw retries for 1500ms (remoteCdpTimeoutMs)
- If still fails: agent gets error message, can retry

**App quit / crash cleanup:**
- `app.on('will-quit')` → `removeOpenClawBrowserConfig()`
- Removes `browser` key from openclaw.json
- Next OpenClaw CLI run (outside CrawBot) works normally with its own Chrome

**Multiple CrawBot instances:**
- Port 9333 conflict → detect and use alternative port
- Write the actual port to openclaw.json

### Port Strategy

| Service | Port | Exposed to | Notes |
|---------|------|-----------|-------|
| OpenClaw Gateway WS | 18789 | Gateway clients | Existing, unchanged |
| Gateway Browser Control | 18791 | Internal | Existing, but unused since attachOnly |
| OpenClaw default CDP range | 18800+ | — | Unused since we override profiles |
| **Electron Real CDP** | **9222** | **localhost only** | `--remote-debugging-port`, internal |
| **CrawBot CDP Filter Proxy** | **9333** | **OpenClaw** | Thin proxy, filters targets |
| **Web Provider Proxy** | **dynamic** | **OpenClaw** | OpenAI-compatible API for zero-token |

Port choices:
- 9222 (internal CDP): Standard Chrome debug port, but only localhost-bound and not advertised. Could be randomized.
- 9333 (external proxy): Not in OpenClaw's port range (18789-18899), not 9222 (avoids conflict with user's Chrome). Configurable via electron-store.
- Web Provider Proxy: Dynamic port (find available), written to openclaw.json at startup.

## 5. WebAuth Providers

> **Tên chính thức:** WebAuth Providers (gọi tắt: WebAuth)
> **Prefix trong code:** `webauth-` (stores, IPC, model IDs, file names)
> Based on research of [openclaw-zero-token](https://github.com/linuxhsj/openclaw-zero-token).
> Adapted to use CrawBot's Electron webview instead of external Chrome + Playwright.

### 5.1 Core Concept

openclaw-zero-token uses **browser login sessions** (cookies/tokens) to call AI providers' **internal web API endpoints** — the same endpoints their web UIs use. CrawBot adapts this by using `<webview>` tags + `webview.executeJavaScript()` instead of Playwright's `page.evaluate()`.

**Original (openclaw-zero-token):**
```
Chrome (CDP 9222) → Playwright connectOverCDP → page.evaluate(() => fetch(...))
```

**CrawBot adaptation:**
```
Electron webview (partition: persist:webauth-X) → webview.executeJavaScript(() => fetch(...))
```

Same principle, zero external dependencies.

### 5.2 Architecture

```
OpenClaw Gateway
  │
  │ (configured as openai-compatible provider)
  │ baseUrl = http://127.0.0.1:{proxyPort}/v1
  ▼
Web Provider Proxy Server (electron/browser/webauth-proxy.ts)
  │
  │ POST /v1/chat/completions  { model: "web-claude-3.5-sonnet", messages: [...] }
  │
  ├── Route by model prefix → find provider module
  │
  ▼
Provider Module (e.g., claude-web.ts)
  │
  │ 1. Transform OpenAI format → provider's internal API format
  │ 2. Find webview with partition "persist:webauth-claude"
  │ 3. webview.executeJavaScript(`fetch("https://claude.ai/api/...", {...})`)
  │ 4. Parse SSE/streaming response
  │ 5. Transform back → OpenAI SSE format
  │
  ▼
Gateway receives standard OpenAI streaming response
```

### 5.3 WebAuth Management UI

#### Settings Page: WebAuth Tab

**Location:** `src/pages/Settings/WebAuthSettings.tsx`

```
┌─ Settings ──────────────────────────────────────────────────┐
│ [General] [Providers] [WebAuth] [Channels] [About]          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  WebAuth Providers                              [+ Add]     │
│  Use web login sessions as LLM API — no API key needed      │
│                                                             │
│  ┌─────────────────────────────────────────────────────┐    │
│  │ 🟢 Claude Web          claude-sonnet-4-6, opus, haiku│    │
│  │    Logged in as: user@email.com                      │    │
│  │    Session: Valid (expires ~3h)                       │    │
│  │    [Re-login]  [Show Browser]  [Remove]              │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │ 🟡 ChatGPT Web         GPT-4, GPT-4 Turbo           │    │
│  │    Session: Expiring soon                            │    │
│  │    [Re-login]  [Show Browser]  [Remove]              │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │ 🔴 DeepSeek Web        deepseek-chat, reasoner       │    │
│  │    Session: Expired — click Re-login                 │    │
│  │    [Re-login]  [Show Browser]  [Remove]              │    │
│  ├─────────────────────────────────────────────────────┤    │
│  │ ⚪ Gemini Web           (not configured)              │    │
│  │    [Login]                                           │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                             │
│  ── Available Providers ──────────────────────────────      │
│  Click to add:                                              │
│  [Grok] [Qwen] [Kimi] [Doubao] [GLM] [Manus]              │
│                                                             │
│  ── Status ───────────────────────────────────────────      │
│  WebAuth Proxy: Running on port 23456                       │
│  Active models: 8 models from 3 providers                   │
│  Default model: webauth-claude-sonnet-4                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Provider status indicators:**
- 🟢 **Valid** — Session cookies present and recently verified
- 🟡 **Expiring** — Session nearing expiry (provider-specific heuristic)
- 🔴 **Expired** — Last API call returned 401/403
- ⚪ **Not configured** — Provider available but not logged in

**Actions per provider:**
| Button | Action |
|--------|--------|
| **Login** / **Re-login** | Opens webview tab in BrowserPanel → navigates to provider login URL → user logs in manually |
| **Show Browser** | Shows the hidden webview tab in BrowserPanel (for debugging, inspecting cookies) |
| **Remove** | Clears session (cookies, partition data), removes from store, removes models from openclaw.json |

#### Add Provider Dialog

```
┌─ Add WebAuth Provider ────────────────────────┐
│                                                │
│  Select a provider to authenticate:            │
│                                                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Claude   │ │ ChatGPT  │ │ DeepSeek │       │
│  │ claude.ai│ │chatgpt.co│ │deepseek. │       │
│  └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Gemini   │ │ Grok     │ │ Qwen     │       │
│  │google.com│ │ grok.com │ │ qwen.ai  │       │
│  └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐       │
│  │ Kimi     │ │ Doubao   │ │ GLM      │       │
│  │moonshot. │ │doubao.com│ │chatglm.cn│       │
│  └──────────┘ └──────────┘ └──────────┘       │
│  ┌──────────┐                                  │
│  │ Manus    │  (API key — no login needed)     │
│  │manus.api │                                  │
│  └──────────┘                                  │
│                                                │
│  [Cancel]                                      │
└────────────────────────────────────────────────┘
```

Clicking a provider:
1. Creates hidden webview with `partition: persist:webauth-{provider}`
2. Opens BrowserPanel with the webview tab visible
3. Navigates to provider's login URL
4. User logs in (handles CAPTCHA, 2FA manually)
5. After login detected (cookie check), shows "Login successful" toast
6. User can close the tab or click "Done" → webview goes hidden
7. Provider appears in WebAuth list with 🟢 status

#### Zustand Store: `useWebAuthStore`

**Location:** `src/stores/webauth.ts`

```typescript
interface WebAuthProvider {
  id: string;                    // e.g., "claude-web"
  name: string;                  // e.g., "Claude Web"
  status: 'valid' | 'expiring' | 'expired' | 'not-configured';
  user?: string;                 // e.g., "user@email.com" (from auth check)
  models: WebAuthModel[];        // available models for this provider
  partition: string;             // e.g., "persist:webauth-claude"
  lastChecked?: number;          // timestamp of last auth check
}

interface WebAuthModel {
  id: string;                    // e.g., "webauth-claude-sonnet-4"
  name: string;                  // e.g., "Claude Sonnet 4 (WebAuth)"
  provider: string;              // e.g., "claude-web"
}

interface WebAuthStore {
  providers: WebAuthProvider[];
  proxyPort: number | null;
  proxyRunning: boolean;

  // Actions
  addProvider(providerId: string): Promise<void>;
  removeProvider(providerId: string): Promise<void>;
  loginProvider(providerId: string): Promise<void>;   // opens webview
  checkAuth(providerId: string): Promise<void>;       // verify session
  checkAllAuth(): Promise<void>;                       // periodic check

  // Proxy
  startProxy(): Promise<void>;
  stopProxy(): Promise<void>;
}
```

#### IPC Channels (WebAuth-specific)

```
// Rename from browser:provider:* to webauth:*
webauth:provider:add       (providerId) → creates webview + partition
webauth:provider:remove    (providerId) → clears partition + removes config
webauth:provider:login     (providerId) → shows webview in BrowserPanel
webauth:provider:check     (providerId) → { status, user, models }
webauth:provider:check-all () → WebAuthProvider[]
webauth:proxy:start        () → { port }
webauth:proxy:stop         ()
webauth:proxy:status       () → { running, port, modelCount }

// Events (main → renderer)
webauth:provider:status-changed  (providerId, status)
webauth:provider:session-expired (providerId)
```

#### Chat Integration

When WebAuth providers are authenticated, their models appear in the model selector alongside API-key providers:

```
Model Selector Dropdown:
├── API Providers
│   ├── claude-sonnet-4 (Anthropic API)
│   ├── gpt-4o (OpenAI API)
│   └── ...
├── ── WebAuth Providers ──
│   ├── 🟢 webauth-claude-sonnet-4 (Claude Web)
│   ├── 🟢 webauth-claude-opus-4 (Claude Web)
│   ├── 🟡 webauth-gpt-4 (ChatGPT Web)
│   └── 🔴 webauth-deepseek-chat (DeepSeek Web) — expired
└── ...
```

Expired models show warning icon. Clicking an expired model triggers re-login prompt.

### 5.4 User Flow (Updated)

**Initial login:**
```
Settings → WebAuth tab → [+ Add] → select "Claude Web"
  → CrawBot creates webview with partition "persist:webauth-claude"
  → BrowserPanel opens with webview tab showing claude.ai
  → User logs in manually (handles CAPTCHA, 2FA, etc.)
  → Cookies auto-saved in persistent partition (survives app restart)
  → Auth check detects sessionKey → toast "Claude Web: Login successful"
  → User closes tab or clicks "Done" → webview hidden
  → Provider status: 🟢 Valid
  → Models registered in openclaw.json as openai-compatible
  → Models appear in Chat model selector
```

**Session expired:**
```
API call returns 401/403
  → Provider status: 🔴 Expired
  → Toast notification: "Claude Web session expired — click to re-login"
  → Chat model selector shows warning icon on affected models
  → User clicks notification or "Re-login" in Settings
  → BrowserPanel shows webview → user logs in again
  → Cookies refreshed → status: 🟢 Valid
  → API calls resume automatically
```

**Periodic health check:**
```
Every 5 minutes (configurable):
  → For each authenticated provider:
    → webview.executeJavaScript(check cookie presence)
    → If cookie missing/expired → status: 🔴 Expired
    → If cookie present → quick API health check (lightweight endpoint)
    → Update provider status in store
```

### 5.4 Provider Implementation Details

Each provider module implements this interface:

```typescript
interface WebProvider {
  id: string;                        // e.g., "claude-web"
  name: string;                      // e.g., "Claude Web"
  loginUrl: string;                  // e.g., "https://claude.ai"
  partition: string;                 // e.g., "persist:webauth-claude"

  // Models exposed by this provider
  models: WebProviderModel[];

  // Check if session cookies are still valid
  checkAuth(webview: WebviewTag): Promise<{ authenticated: boolean; user?: string }>;

  // Execute a chat completion request via the webview
  chatCompletion(
    webview: WebviewTag,
    request: OpenAIChatRequest,
  ): AsyncGenerator<OpenAIChatChunk>;  // SSE streaming
}

interface WebProviderModel {
  id: string;            // e.g., "web-claude-3.5-sonnet"
  name: string;          // e.g., "Claude 3.5 Sonnet (Web)"
  contextWindow?: number;
}
```

---

#### 5.4.1 Claude Web (`claude-web.ts`)

**Source reference:** `openclaw-zero-token/src/providers/claude-web-auth.ts` + `claude-web-client-browser.ts`

**Login URL:** `https://claude.ai`

**Session cookie:** `sessionKey` (format: `sk-ant-sid01-*` or `sk-ant-sid02-*`)

**Auth check:**
```javascript
// In webview context (executeJavaScript):
document.cookie.split(';').some(c => c.trim().startsWith('sessionKey='))
```

**Organization discovery (required before API calls):**
```javascript
// GET https://claude.ai/api/organizations
// Returns: [{ uuid: "org-xxx", name: "Personal", ... }]
// Use first org's uuid for all subsequent calls
fetch('https://claude.ai/api/organizations', { credentials: 'include' })
  .then(r => r.json())
```

**Conversation creation:**
```javascript
// POST https://claude.ai/api/organizations/{orgId}/chat_conversations
fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '', model: 'claude-sonnet-4-20250514' })
})
// Returns: { uuid: "conv-xxx", ... }
```

**Chat completion:**
```javascript
// POST https://claude.ai/api/organizations/{orgId}/chat_conversations/{convId}/completion
fetch(`https://claude.ai/api/organizations/${orgId}/chat_conversations/${convId}/completion`, {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    prompt: userMessage,
    timezone: 'UTC',
    attachments: [],
    files: [],
    model: 'claude-sonnet-4-20250514',
    // For continuing conversation, include parent_message_uuid
  })
})
// Response: SSE stream
// data: {"type":"completion","completion":"Hello","stop_reason":null,...}
// data: {"type":"completion","completion":" world","stop_reason":"end_turn",...}
```

**Available models (web):** claude-sonnet-4-20250514, claude-3-5-haiku, claude-3-opus (depends on user's plan)

**SSE format:** `data: {"type":"completion","completion":"<token>","stop_reason":null|"end_turn"}`

**Rate limiting:** Free tier ~30 msgs/3hrs, Pro tier ~100 msgs/3hrs (varies)

---

#### 5.4.2 ChatGPT Web (`chatgpt-web.ts`)

**Source reference:** `openclaw-zero-token/src/providers/chatgpt-web-auth.ts` + `chatgpt-web-client-browser.ts`

**Login URL:** `https://chatgpt.com`

**Session cookie:** `__Secure-next-auth.session-token` (may be split into `.0` and `.1` parts)

**Auth check:**
```javascript
document.cookie.split(';').some(c =>
  c.trim().startsWith('__Secure-next-auth.session-token')
)
```

**CRITICAL: Anti-bot tokens required!**

ChatGPT requires dynamic sentinel/turnstile tokens. The zero-token project handles this by:
```javascript
// 1. Dynamically import sentinel script from CDN
//    URL pattern: https://cdn.oaistatic.com/_next/static/chunks/...
//    The script registers window.__next_f or similar global
// 2. Call the sentinel function to get a token
// 3. Include token in request headers
```

**Chat completion:**
```javascript
// POST https://chatgpt.com/backend-api/conversation
fetch('https://chatgpt.com/backend-api/conversation', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${accessToken}`,  // from session
    // Anti-bot headers (sentinel/turnstile tokens)
  },
  body: JSON.stringify({
    action: 'next',
    messages: [{
      id: uuid(),
      author: { role: 'user' },
      content: { content_type: 'text', parts: [userMessage] },
      metadata: {}
    }],
    model: 'gpt-4o',
    parent_message_id: parentId || uuid(),
    // conversation_id: convId,  // omit for new conversation
  })
})
// Response: SSE stream with complex format
// data: {"message":{"id":"...","content":{"parts":["token"]},...},"conversation_id":"..."}
```

**Access token retrieval:**
```javascript
// GET https://chatgpt.com/api/auth/session
// Returns: { accessToken: "eyJ...", user: {...} }
fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' })
  .then(r => r.json())
  .then(d => d.accessToken)
```

**DOM fallback (on 403):**
The zero-token project has a fallback that simulates typing into ChatGPT's input box and clicking send.
This is complex and fragile — **recommend NOT implementing this in v1**. If 403, just notify user to re-login.

**Available models (web):** gpt-4o, gpt-4o-mini, gpt-4, o1-preview, o1-mini (depends on plan)

---

#### 5.4.3 Gemini Web (`gemini-web.ts`)

**Source reference:** `openclaw-zero-token/src/providers/gemini-web-auth.ts` + `gemini-web-client-browser.ts`

**Login URL:** `https://gemini.google.com`

**Session cookies:** `SID`, `__Secure-1PSID`, `__Secure-3PSID` (Google-wide auth cookies)

**Auth check:**
```javascript
document.cookie.split(';').some(c => c.trim().startsWith('__Secure-1PSID='))
```

**Chat completion:** Uses Google's internal Batchexecute API (protobuf-like JSON arrays):
```javascript
// POST https://gemini.google.com/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate
// Content-Type: application/x-www-form-urlencoded
// Body: f.req=[[[prompt_text],null,null,...],...]  (deeply nested arrays)
```

**Note:** Gemini's internal API format is significantly more complex than Claude/ChatGPT. The request/response uses nested JSON arrays (Google's Batchexecute format). Requires careful reverse-engineering of the payload structure.

**Available models (web):** gemini-2.0-flash, gemini-2.0-pro, gemini-1.5-pro (depends on plan)

**Priority:** LOWER — complex API format, recommend implementing after Claude and ChatGPT

---

#### 5.4.4 DeepSeek Web (`deepseek-web.ts`)

**Source reference:** `openclaw-zero-token/src/providers/deepseek-web-auth.ts` + `deepseek-web-client-browser.ts`

**Login URL:** `https://chat.deepseek.com`

**Auth mechanism:** Bearer token from `Authorization` header + `ds_session_id` cookie

**Auth capture:**
```javascript
// Monitor network requests for Authorization header
// Or extract from: localStorage.getItem('ds_token') or similar
```

**Chat completion:**
```javascript
// POST https://chat.deepseek.com/api/v0/chat/completions
fetch('https://chat.deepseek.com/api/v0/chat/completions', {
  method: 'POST',
  credentials: 'include',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({
    message: userMessage,
    stream: true,
    model_preference: null,  // uses default
    model_class: 'deepseek_chat',  // or 'deepseek_code'
    // temperature, top_p, etc.
  })
})
// Response: SSE stream similar to OpenAI format
```

**Available models (web):** deepseek-chat (V3), deepseek-coder, deepseek-reasoner (R1)

**Priority:** MEDIUM — relatively standard API format

---

#### 5.4.5 Kimi Web (`kimi-web.ts`)

**Source reference:** `openclaw-zero-token/src/providers/kimi-web-auth.ts` + `kimi-web-client-browser.ts`

**Login URL:** `https://kimi.moonshot.cn`

**Auth mechanism:** `kimi-auth` cookie → used as Bearer token

**CRITICAL: Binary protocol!**
Kimi uses a custom binary protocol over HTTP:
- 5-byte header: 1 byte flag + 4 byte length (big-endian) + JSON payload
- Endpoint: gRPC-Web style `kimi.gateway.chat.v1.ChatService/Chat`

```javascript
// Binary frame structure:
// [flag: 1 byte][length: 4 bytes big-endian][json_payload: N bytes]
// flag = 0x00 for data frames
```

**Priority:** LOW — binary protocol adds significant complexity

---

#### 5.4.6 Grok Web (`grok-web.ts`)

**Source reference:** `openclaw-zero-token/src/providers/grok-web-auth.ts` + `grok-web-client-browser.ts`

**Login URL:** `https://grok.com` (or `https://x.com/i/grok`)

**Session cookies:** Twitter/X auth cookies (`auth_token`, `ct0`)

**Chat completion:** Standard-ish REST API with SSE streaming

**Models:** Grok 1, Grok 2

---

#### 5.4.7 Qwen International (`qwen-intl-web.ts`)

**Source reference:** `openclaw-zero-token/src/providers/qwen-intl-web-auth.ts` + `qwen-intl-web-client-browser.ts`

**Login URL:** `https://chat.qwen.ai` (international)

**Session cookies:** Alibaba Cloud auth cookies

**Models:** Qwen 3.5 Plus, Qwen 3.5 Turbo

**Note:** Separate from China version — different domain, different auth cookies

---

#### 5.4.8 Qwen China (`qwen-china-web.ts`)

**Source reference:** `openclaw-zero-token/src/providers/qwen-china-web-auth.ts` + `qwen-china-web-client-browser.ts`

**Login URL:** `https://tongyi.aliyun.com`

**Session cookies:** Aliyun auth cookies

**Models:** Qwen 3.5 Plus, Qwen 3.5 Turbo

**Note:** China domain, requires Chinese phone auth. Same models as international but separate session.

---

#### 5.4.9 Doubao (`doubao-web.ts`)

**Source reference:** `openclaw-zero-token/src/providers/doubao-web-auth.ts` + `doubao-web-client-browser.ts`

**Login URL:** `https://www.doubao.com`

**Session cookies:** ByteDance/Volcano auth cookies

**Models:** doubao-seed-2.0, doubao-pro

---

#### 5.4.10 GLM Web / Zhipu China (`glm-china-web.ts`)

**Source reference:** `openclaw-zero-token/src/providers/glm-web-auth.ts` + `glm-web-client-browser.ts`

**Login URL:** `https://chatglm.cn`

**Session cookies:** Zhipu AI auth cookies

**Models:** glm-4-Plus, glm-4-Think

---

#### 5.4.11 GLM International (`glm-intl-web.ts`)

**Source reference:** `openclaw-zero-token/src/providers/glm-intl-web-auth.ts` + `glm-intl-web-client-browser.ts`

**Login URL:** `https://chat.glm.ai` (international)

**Session cookies:** Zhipu international auth cookies

**Models:** GLM-4 Plus, GLM-4 Think

---

#### 5.4.12 Manus API (`manus-api.ts`)

**Source reference:** `openclaw-zero-token/src/providers/manus-client.ts`

**Login URL:** N/A — uses API key (not browser-based)

**Auth:** API key from Manus dashboard (free quota available)

**Models:** Manus 1.6, Manus 1.6 Lite

**Note:** Only non-browser provider. Standard REST API with API key. Does not need webview — can use direct HTTP from main process. Still registered as openai-compatible in the proxy.

---

### 5.5 Web Provider Proxy Server

**Location:** `electron/browser/webauth-proxy.ts`

HTTP server on localhost (dynamic port), exposes OpenAI-compatible API.

**Endpoints:**

```
GET  /v1/models                    → List available web provider models
POST /v1/chat/completions          → Chat completion (streaming SSE)
GET  /v1/providers                 → List providers with auth status (custom)
POST /v1/providers/{id}/check-auth → Check if session is still valid (custom)
```

**Model naming convention:** `webauth-{provider}-{model}` e.g.:
- `webauth-claude-sonnet` → Claude Web, Sonnet 4.6 model
- `webauth-chatgpt-gpt` → ChatGPT Web, GPT-5.4 model
- `webauth-deepseek-chat` → DeepSeek Web, V3 model

**Request routing:**
```typescript
// POST /v1/chat/completions
// { model: "webauth-claude-sonnet", messages: [...] }
//
// 1. Parse model prefix → find provider ("claude" → claudeWebProvider)
// 2. Find webview with provider's partition
// 3. If no webview exists, create hidden one navigated to provider's loginUrl
// 4. Check auth (cookie presence)
// 5. If not authenticated → return 401 with re-login instruction
// 6. Call provider.chatCompletion(webview, request)
// 7. Stream response as OpenAI SSE format
```

**OpenAI SSE output format (standard):**
```
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"index":0}]}

data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"delta":{"content":" world"},"index":0,"finish_reason":"stop"}]}

data: [DONE]
```

### 5.6 Base Provider Pattern

**Location:** `electron/browser/providers/base-provider.ts`

Shared logic for all providers — the `executeInWebview` pattern.

**IMPORTANT:** `window.postMessage()` inside `executeJavaScript` does NOT reach the main/renderer process.
The correct Electron webview IPC mechanism is `ipcRenderer.sendToHost()`, accessible via a webview preload script.

#### Webview Preload Script

**Location:** `electron/browser/webview-preload.ts`

```typescript
// This runs inside each zero-token provider webview
// Loaded via <webview preload="./webview-preload.js">
const { ipcRenderer } = require('electron');

// Bridge for streaming data from webview guest → host (renderer process)
window.__crawbot = {
  sendChunk: (requestId: string, data: string) =>
    ipcRenderer.sendToHost('crawbot:stream:chunk', requestId, data),
  sendEnd: (requestId: string) =>
    ipcRenderer.sendToHost('crawbot:stream:end', requestId),
  sendError: (requestId: string, error: string) =>
    ipcRenderer.sendToHost('crawbot:stream:error', requestId, error),
  sendResponse: (requestId: string, data: any) =>
    ipcRenderer.sendToHost('crawbot:response', requestId, data),
};
```

#### Non-streaming fetch (for auth checks, org discovery, etc.)

```typescript
async function executeInWebview(
  webview: Electron.WebviewTag,
  requestId: string,
  url: string,
  options: RequestInit,
): Promise<{ status: number; headers: Record<string,string>; body: string }> {
  // webview must be navigated to the provider's domain
  // so that credentials: 'include' attaches session cookies

  return new Promise((resolve, reject) => {
    const handler = (event: Electron.IpcMessageEvent) => {
      if (event.channel === 'crawbot:response' && event.args[0] === requestId) {
        webview.removeEventListener('ipc-message', handler);
        resolve(event.args[1]);
      }
    };
    webview.addEventListener('ipc-message', handler);

    webview.executeJavaScript(`
      (async () => {
        try {
          const r = await fetch(${JSON.stringify(url)}, {
            method: ${JSON.stringify(options.method || 'GET')},
            headers: ${JSON.stringify(options.headers || {})},
            body: ${options.body ? JSON.stringify(options.body) : 'null'},
            credentials: 'include',
          });
          const body = await r.text();
          window.__crawbot.sendResponse(${JSON.stringify(requestId)}, {
            status: r.status,
            headers: Object.fromEntries(r.headers.entries()),
            body: body,
          });
        } catch (e) {
          window.__crawbot.sendError(${JSON.stringify(requestId)}, e.message);
        }
      })()
    `);
  });
}
```

#### Streaming fetch (for chat completions — true token-by-token streaming)

```typescript
function streamFromWebview(
  webview: Electron.WebviewTag,
  requestId: string,
  url: string,
  options: RequestInit,
): { stream: AsyncGenerator<string>; abort: () => void } {
  // Returns an async generator that yields SSE chunks in real-time

  const chunks: string[] = [];
  let done = false;
  let error: string | null = null;
  let resolveWait: (() => void) | null = null;

  const handler = (event: Electron.IpcMessageEvent) => {
    if (event.args[0] !== requestId) return;

    if (event.channel === 'crawbot:stream:chunk') {
      chunks.push(event.args[1]);
      resolveWait?.();
    } else if (event.channel === 'crawbot:stream:end') {
      done = true;
      resolveWait?.();
      webview.removeEventListener('ipc-message', handler);
    } else if (event.channel === 'crawbot:stream:error') {
      error = event.args[1];
      done = true;
      resolveWait?.();
      webview.removeEventListener('ipc-message', handler);
    }
  };
  webview.addEventListener('ipc-message', handler);

  // Start fetch + streaming inside webview
  webview.executeJavaScript(`
    (async () => {
      try {
        const r = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(options.method || 'POST')},
          headers: ${JSON.stringify(options.headers || {})},
          body: ${options.body ? JSON.stringify(options.body) : 'null'},
          credentials: 'include',
        });
        if (!r.ok) {
          window.__crawbot.sendError(${JSON.stringify(requestId)},
            'HTTP ' + r.status + ': ' + (await r.text()));
          return;
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          window.__crawbot.sendChunk(${JSON.stringify(requestId)},
            decoder.decode(value, { stream: true }));
        }
        window.__crawbot.sendEnd(${JSON.stringify(requestId)});
      } catch (e) {
        window.__crawbot.sendError(${JSON.stringify(requestId)}, e.message);
      }
    })()
  `);

  // Async generator that yields chunks as they arrive via IPC
  async function* generate(): AsyncGenerator<string> {
    while (!done) {
      if (chunks.length > 0) {
        yield chunks.shift()!;
      } else {
        await new Promise<void>(r => { resolveWait = r; });
      }
    }
    // Drain remaining
    while (chunks.length > 0) yield chunks.shift()!;
    if (error) throw new Error(error);
  }

  return {
    stream: generate(),
    abort: () => {
      webview.removeEventListener('ipc-message', handler);
      // Optionally abort the fetch inside webview
      webview.executeJavaScript(`window.__crawbot_abort_${requestId}?.()`);
    },
  };
}
```

**Why this approach:**
- `ipcRenderer.sendToHost()` is Electron's official webview→host IPC mechanism
- True streaming — chunks arrive as they're read, no polling
- `requestId` allows multiple concurrent requests on the same webview
- Abort support for cancellation
- Error propagation from webview context to caller

### 5.7 OpenClaw Provider Registration

Register the web provider proxy as an openai-compatible provider in CrawBot:

**In provider registry** (`electron/utils/provider-registry.ts`):
```typescript
// New provider type: "webauth"
{
  envVar: 'WEBAUTH_API_KEY',  // dummy, not actually used
  defaultModel: 'web-provider/webauth-claude-sonnet-4',
  providerConfig: {
    baseUrl: `http://127.0.0.1:${proxyPort}/v1`,
    api: 'openai-completions',
    apiKeyEnv: 'WEBAUTH_API_KEY',
    models: [
      { id: 'webauth-claude-sonnet', name: 'Claude Sonnet 4.6 (Web)' },
      { id: 'webauth-chatgpt-gpt', name: 'GPT-5.4 (Web)' },
      // dynamically populated based on authenticated providers
    ],
  },
}
```

**In openclaw.json** (auto-configured):
```json
{
  "models": {
    "providers": {
      "webauth": {
        "baseUrl": "http://127.0.0.1:{proxyPort}/v1",
        "api": "openai-completions",
        "apiKey": "dummy-webauth-key",
        "models": [
          { "id": "webauth-claude-sonnet", "name": "Claude Sonnet 4.6 (Web)" },
          { "id": "webauth-chatgpt-gpt", "name": "GPT-5.4 (Web)" }
        ]
      }
    }
  }
}
```

### 5.8 Supported Providers (Full List)

All providers below are **tested and working** in openclaw-zero-token. CrawBot will implement all of them.

| Provider | Auth Type | Models | Complexity | Priority |
|----------|-----------|--------|------------|----------|
| **Claude Web** | Cookie (`sessionKey`) | claude-sonnet-4-6, claude-opus-4-6, claude-haiku-4-6 | Medium | **P0** |
| **DeepSeek Web** | Bearer token + cookie | deepseek-chat, deepseek-reasoner | Low | **P1** |
| **ChatGPT Web** | Cookie + access token + sentinel | GPT-4, GPT-4 Turbo | High | **P2** |
| **Gemini Web** | Google cookies (SID, __Secure-1PSID) | Gemini Pro, Gemini Ultra | High | **P3** |
| **Grok Web** | X/Twitter cookies (auth_token, ct0) | Grok 1, Grok 2 | Medium | **P4** |
| **Qwen International** | Cookies | Qwen 3.5 Plus, Qwen 3.5 Turbo | Medium | **P5** |
| **Qwen China** | Cookies | Qwen 3.5 Plus, Qwen 3.5 Turbo | Medium | **P6** |
| **Kimi (Moonshot)** | Cookie (`kimi-auth`) as Bearer | Moonshot v1 8K/32K/128K | High (binary proto) | **P7** |
| **Doubao (ByteDance)** | Cookies | doubao-seed-2.0, doubao-pro | Medium | **P8** |
| **GLM Web (Zhipu China)** | Cookies | glm-4-Plus, glm-4-Think | Medium | **P9** |
| **GLM International** | Cookies | GLM-4 Plus, GLM-4 Think | Medium | **P10** |
| **Manus API** | API key (free quota) | Manus 1.6, Manus 1.6 Lite | Low (standard REST) | **P11** |

**Implementation strategy:**
- **Wave 1 (P0-P2):** Claude, DeepSeek, ChatGPT — highest value, most users
- **Wave 2 (P3-P6):** Gemini, Grok, Qwen — expand coverage
- **Wave 3 (P7-P11):** Kimi, Doubao, GLM, Manus — niche but supported

### 5.9 Provider File Structure

```
electron/browser/providers/
  ├── types.ts              — WebProvider interface, WebProviderModel, shared types
  ├── base-provider.ts      — executeInWebview(), streamFromWebview(), auth check utils
  │
  │ Wave 1 (P0-P2):
  ├── claude-web.ts         — Claude.ai: org discovery, conversation API, SSE parsing
  ├── deepseek-web.ts       — DeepSeek: bearer token, standard completion API
  ├── chatgpt-web.ts        — ChatGPT: session token, access token, sentinel tokens, SSE
  │
  │ Wave 2 (P3-P6):
  ├── gemini-web.ts         — Gemini: Batchexecute format, Google cookies
  ├── grok-web.ts           — Grok/X: Twitter auth cookies, completion API
  ├── qwen-intl-web.ts      — Qwen International: cookies, completion API
  ├── qwen-china-web.ts     — Qwen China: cookies, completion API
  │
  │ Wave 3 (P7-P11):
  ├── kimi-web.ts           — Kimi/Moonshot: binary gRPC-Web protocol
  ├── doubao-web.ts         — Doubao/ByteDance: cookies, completion API
  ├── glm-china-web.ts      — GLM/Zhipu China: cookies, completion API
  ├── glm-intl-web.ts       — GLM International: cookies, completion API
  └── manus-api.ts          — Manus: standard REST API key (free quota)

electron/browser/
  └── webauth-proxy.ts — HTTP server, /v1/chat/completions routing, model registry
```

### 5.10 Webview Lifecycle for Web Providers

**Key difference from regular browser tabs:**

Web provider webviews may run **hidden** (not visible in BrowserPanel) to serve API requests in the background.

```
Provider webview states:
  ┌─────────────┐     user clicks      ┌──────────────┐
  │  Not exists  │ ──"Add Provider"──►  │  Visible tab │
  └─────────────┘                       │  (login page)│
                                        └──────┬───────┘
                                    user clicks │ "Done"
                                               ▼
                                        ┌──────────────┐
                                        │  Hidden       │ ◄── API calls go here
                                        │  (in memory)  │     webview.executeJavaScript(fetch...)
                                        └──────┬───────┘
                                   session │ expired (401)
                                           ▼
                                        ┌──────────────┐
                                        │  Visible tab │ ◄── user re-logs in
                                        │  (re-login)  │
                                        └──────────────┘
```

- **Hidden webviews** are NOT shown in BrowserPanel tab bar (separate management)
- But user CAN choose to show them via Settings → Web Providers → "Show browser"
- Hidden webviews still consume memory (~50-100MB each)
- On app startup: auto-create hidden webviews for all authenticated providers
- Navigate to provider's domain to restore cookies from persistent partition

## 6. IPC Channel Plan

New preload bridge channels for browser feature:

```
// Tab management
browser:tab:create     (url?, partition?) → tabId
browser:tab:close      (tabId)
browser:tab:list       () → BrowserTab[]
browser:tab:navigate   (tabId, url)
browser:tab:goBack     (tabId)
browser:tab:goForward  (tabId)
browser:tab:reload     (tabId)
browser:tab:setZoom    (tabId, factor)

// Cookie management
browser:cookies:get    (url) → Cookie[]
browser:cookies:remove (url, name)
browser:cookies:clear  (partition)
browser:cookies:export (partition) → JSON
browser:cookies:import (partition, cookies)

// CDP
browser:cdp:getPort    () → number
browser:cdp:status     () → { running, port, targets }

// Panel/Window
browser:panel:detach   ()
browser:panel:attach   ()
browser:panel:isDetached () → boolean

// WebAuth (see Section 5.3 for full list)
webauth:provider:add       (providerId)
webauth:provider:remove    (providerId)
webauth:provider:login     (providerId)
webauth:provider:check     (providerId) → { status, user, models }
webauth:provider:check-all () → WebAuthProvider[]
webauth:proxy:start        () → { port }
webauth:proxy:stop         ()
webauth:proxy:status       () → { running, port, modelCount }

// Events (main → renderer)
browser:tab:updated    (tabId, updates)
browser:tab:created    (tab)
browser:tab:closed     (tabId)
webauth:provider:status-changed  (providerId, status)
webauth:provider:session-expired (providerId)
```

## 7. Implementation Phases

### Phase 1: Browser Panel UI (Foundation)
**Goal:** Basic browser panel in Chat with multi-tab support

- [ ] Create `useBrowserStore` Zustand store
- [ ] Create `BrowserPanel.tsx` (resizable right panel, same pattern as WorkspacePanel)
- [ ] Create `BrowserTabBar.tsx` (tab strip with add/close)
- [ ] Create `BrowserToolbar.tsx` (URL bar, nav buttons, zoom)
- [ ] Integrate `<webview>` tag with session partition support
- [ ] Add toggle button in ChatToolbar
- [ ] Add IPC channels in preload bridge (`browser:tab:*`)
- [ ] Add IPC handlers in main process
- [ ] User-agent override to hide Electron signature

### Phase 2: CDP Hybrid Proxy + OpenClaw Browser Replacement
**Goal:** OpenClaw's browser tool uses CrawBot's built-in browser exclusively (no external Chrome)

- [ ] Enable `--remote-debugging-port=9222` in app startup (before `app.whenReady()`)
- [ ] Implement CDP Filter Proxy (`electron/browser/cdp-proxy.ts`)
  - HTTP: `/json/list` → fetch from real CDP 9222, filter targets, rewrite ports
  - HTTP: `/json/version` → pass-through with port rewrite
  - WebSocket: `/devtools/page/{id}` → pure byte relay to real CDP (zero interpretation)
  - Security: reject WS connections for non-exposed target IDs
  - Target categorization: exposed set managed by BrowserManager
- [ ] Implement browser config writer (`electron/utils/browser-config.ts`)
  - `setOpenClawBrowserConfig(port)` — write browser section to openclaw.json
  - `removeOpenClawBrowserConfig()` — cleanup on app quit
  - Same read-modify-write pattern as `setOpenClawDefaultModel()` in openclaw-auth.ts
- [ ] Integrate into startup sequence:
  - Start CDP Proxy before Gateway
  - Write browser config before Gateway startup
  - Cleanup config on `app.will-quit`
- [ ] Test with OpenClaw browser tool commands (navigate, snapshot, click, type, evaluate)
- [ ] Handle tab creation from OpenClaw (agent opens new page → webview appears in panel)
- [ ] Visual indicator when OpenClaw agent is controlling a tab (e.g., colored border, "AI" badge)
- [ ] Port conflict detection (if 9333 in use, find alternative)

### Phase 3: Cookie Management + Session Control
**Goal:** Full cookie/session control per tab

- [ ] Cookie Manager dialog (view/delete/clear per domain)
- [ ] Session partition selector when creating new tab
- [ ] Cookie export/import (JSON format)
- [ ] Session reset button (clear all data for a partition)
- [ ] Cookie persistence indicator in tab bar
- [ ] IPC handlers for `browser:cookies:*` channels

### Phase 4: WebAuth Providers
**Goal:** Use web chat sessions as LLM API — full UI + backend + 12 providers

**4A: WebAuth Core Infrastructure**
- [ ] Create `useWebAuthStore` Zustand store (`src/stores/webauth.ts`)
- [ ] Create webview preload script (`electron/browser/webview-preload.ts`)
  - `ipcRenderer.sendToHost()` bridge for streaming
  - `window.__crawbot` API: sendChunk, sendEnd, sendError, sendResponse
- [ ] Implement base provider pattern (`executeInWebview`, `streamFromWebview`)
- [ ] WebAuth Proxy HTTP server (`electron/browser/webauth-proxy.ts`)
  - OpenAI-compatible `/v1/chat/completions` + `/v1/models`
  - Request routing by `webauth-{provider}-{model}` prefix
- [ ] Add IPC channels in preload bridge (`webauth:*`)
- [ ] Add IPC handlers in main process

**4B: WebAuth Management UI**
- [ ] Create `WebAuthSettings.tsx` — Settings tab with provider list
- [ ] Provider status indicators (🟢🟡🔴⚪)
- [ ] Add Provider dialog (grid of available providers)
- [ ] Login flow — opens webview in BrowserPanel, detects auth cookies
- [ ] Re-login flow — shows webview on session expiry
- [ ] Remove provider — clears partition, removes from config
- [ ] WebAuth models in Chat model selector (with status icons)
- [ ] Toast notifications for session expiry

**4C: Provider Implementations — Wave 1 (P0-P2)**
- [ ] Claude Web (claude.ai session → API)
- [ ] DeepSeek Web (standard API format)
- [ ] ChatGPT Web (anti-bot tokens complexity)

**4D: Provider Implementations — Wave 2 (P3-P6)**
- [ ] Gemini Web (Batchexecute format)
- [ ] Grok Web (X/Twitter cookies)
- [ ] Qwen International
- [ ] Qwen China

**4E: Provider Implementations — Wave 3 (P7-P11)**
- [ ] Kimi/Moonshot (binary gRPC-Web)
- [ ] Doubao/ByteDance
- [ ] GLM/Zhipu China
- [ ] GLM International
- [ ] Manus API (REST, free quota — no webview needed)

**4F: Integration**
- [ ] Hidden webview lifecycle (auto-create on startup for authenticated providers)
- [ ] WebAuth webviews NOT in CDP exposed set (invisible to OpenClaw browser tool)
- [ ] Periodic health check (every 5min, configurable)
- [ ] Register webauth as provider in CrawBot provider registry
- [ ] Auto-configure in OpenClaw as openai-compatible provider (write to openclaw.json)
- [ ] Cleanup on app quit (remove webauth provider from openclaw.json if needed)

### Phase 5: Detach/Attach + Polish
**Goal:** Detachable browser window + UX polish

- [ ] Detach panel to separate BrowserWindow
- [ ] Re-attach on close or button click
- [ ] Keyboard shortcuts (Ctrl+Shift+B toggle, Ctrl+T new tab, Ctrl+W close tab)
- [ ] Tab drag-to-reorder
- [ ] Find in page (Ctrl+F)
- [ ] DevTools toggle per tab (for debugging)
- [ ] Persist panel state across app restart
- [ ] i18n for all browser UI strings (en, vi, zh, ja)

## 8. Key Technical Decisions

### CDP: Hybrid Filter Proxy (revised from rev1)

**Decision: `--remote-debugging-port` (real CDP) + thin filter proxy**

| Approach | Pros | Cons |
|----------|------|------|
| `--remote-debugging-port` alone | Zero code, 100% compatible | Exposes ALL webContents |
| CDP Proxy via `webContents.debugger` | Full control, secure | **REJECTED**: Can't support full CDP surface (hundreds of methods). Would take months and still have gaps |
| **Hybrid: real CDP + filter proxy** | **100% compatible + secure + ~200 LOC** | Needs 2 ports (internal 9222 + external 9333) |

The hybrid approach gives us the best of both worlds:
- Real `--remote-debugging-port=9222` provides 100% CDP compatibility (zero protocol gaps)
- Thin proxy on 9333 filters `/json/list` to hide main window + zero-token webviews
- WebSocket connections are pure byte relay — no protocol interpretation needed
- OpenClaw/Playwright works exactly as if connecting to real Chrome

### Streaming: webview preload + ipcRenderer.sendToHost (revised from rev1)

**Decision: webview preload script with `ipcRenderer.sendToHost()`**

| Approach | Pros | Cons |
|----------|------|------|
| `window.postMessage` | Simple | **REJECTED**: Does NOT reach host from webview `executeJavaScript` context |
| Poll-based (`executeJavaScript` loop) | Simple | High latency, inefficient |
| `console.log` + `console-message` event | No preload needed | Hacky, conflicts with real console output |
| **webview preload + `sendToHost()`** | **Official API, true streaming, requestId multiplexing** | Requires preload script per webview |

`ipcRenderer.sendToHost()` is Electron's official mechanism for webview guest→host IPC. True token-by-token streaming with zero polling.

### webview vs WebContentsView

**Decision: `<webview>` tag**

| Approach | Pros | Cons |
|----------|------|------|
| `<webview>` | Works in React JSX, partition attribute, rich API, already enabled | Deprecated warning from Electron team |
| `WebContentsView` | Modern, recommended by Electron | Main process only, can't embed in React, complex IPC for every interaction |

Migration path if needed: Move to WebContentsView by managing tab content from main process and using IPC for all renderer interactions.

### CDP Port

**Decision: Port 9333 (not 9222)**

OpenClaw Gateway default `cdpPortRangeStart` is 9222. Using 9333 avoids conflicts if user also has external Chrome with CDP running.

### User-Agent

**Decision: Dynamic override per webview session**

Electron's default user-agent includes "Electron/40.x" which some sites detect and block. Override to match standard Chrome, deriving version from `process.versions.chrome` (not hardcoded):

```typescript
const chromeVersion = process.versions.chrome; // e.g., "134.0.6998.23"
const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
session.fromPartition('persist:browser-shared').setUserAgent(ua);
```

This ensures the user-agent always matches the actual Chromium version bundled with Electron, avoiding version mismatch detection.

### Zoom Per-Tab

**Decision: Re-apply zoom on navigation events**

Chromium shares zoom per-origin. Workaround: listen to `did-navigate` events on each webview and re-apply the tab's stored `zoomFactor`. Using different partitions per provider also helps isolate zoom.

## 9. File Structure (New Files)

```
electron/browser/
  ├── manager.ts              — BrowserManager: tab lifecycle, target categorization
  ├── cdp-proxy.ts            — CDP Hybrid Filter Proxy (HTTP filter + WS relay)
  ├── webauth-proxy.ts   — OpenAI-compatible proxy for web sessions
  ├── webview-preload.ts      — Preload for zero-token webviews (ipcRenderer.sendToHost bridge)
  ├── cookie-manager.ts       — Cookie CRUD operations
  └── providers/
      ├── types.ts            — WebProvider interface, WebProviderModel, shared types
      ├── base-provider.ts    — executeInWebview(), streamFromWebview(), auth check utils
      ├── claude-web.ts       — Claude.ai session API
      ├── deepseek-web.ts     — DeepSeek session API
      ├── chatgpt-web.ts      — ChatGPT session API
      ├── gemini-web.ts       — Gemini Batchexecute API
      ├── grok-web.ts         — Grok/X session API
      ├── qwen-intl-web.ts    — Qwen International
      ├── qwen-china-web.ts   — Qwen China (tongyi.aliyun.com)
      ├── kimi-web.ts         — Kimi/Moonshot binary gRPC-Web
      ├── doubao-web.ts       — Doubao/ByteDance
      ├── glm-china-web.ts    — GLM/Zhipu China
      ├── glm-intl-web.ts     — GLM International
      └── manus-api.ts        — Manus REST API (non-browser)

electron/utils/
  └── browser-config.ts       — Write/remove browser config in openclaw.json

src/stores/
  ├── browser.ts              — Zustand store for browser panel state
  └── webauth.ts              — Zustand store for WebAuth providers state

src/pages/Settings/
  └── WebAuthSettings.tsx     — WebAuth management tab in Settings

src/pages/Chat/
  ├── BrowserPanel.tsx        — Main browser panel container
  ├── BrowserTabBar.tsx       — Tab strip component
  ├── BrowserToolbar.tsx      — URL bar + controls
  ├── BrowserWebview.tsx      — webview wrapper with event handling
  └── BrowserCookieManager.tsx — Cookie management dialog

src/i18n/locales/
  ├── en/browser.json         — English translations
  ├── vi/browser.json         — Vietnamese translations
  ├── zh/browser.json         — Chinese translations
  └── ja/browser.json         — Japanese translations

tests/mocks/
  ├── electron-browser.ts     — Mock factories: makeMockWebview, makeMockSession, etc.
  ├── mock-cdp-server.ts      — Simulates Electron's CDP HTTP+WS endpoints
  └── provider-responses.ts   — Canned SSE responses for each AI provider

tests/unit/browser/
  ├── browser-store.test.ts
  ├── browser-manager.test.ts
  ├── cdp-proxy.test.ts
  ├── browser-config.test.ts
  ├── cookie-manager.test.ts
  ├── webauth-proxy.test.ts
  ├── provider-base.test.ts
  ├── provider-claude-web.test.ts
  ├── provider-deepseek-web.test.ts
  ├── provider-chatgpt-web.test.ts
  ├── provider-gemini-web.test.ts
  ├── provider-grok-web.test.ts
  ├── provider-qwen-web.test.ts      (covers both intl + china)
  ├── provider-kimi-web.test.ts
  ├── provider-doubao-web.test.ts
  ├── provider-glm-web.test.ts       (covers both china + intl)
  ├── provider-manus-api.test.ts
  └── webview-streaming.test.ts

tests/e2e/browser/
  ├── browser-panel.spec.ts
  ├── browser-navigation.spec.ts
  ├── browser-cdp.spec.ts
  ├── browser-zero-token.spec.ts
  └── helpers/
      └── mock-provider-server.ts  — Express mock for AI provider websites
```

## 10. Test Plan

> **Nguyên tắc:** Mọi tính năng phải được test tự động trước khi delivery. User không cần test tay bất kỳ thứ gì.
> **Conventions:** Theo patterns hiện có — Vitest globals, fixture builders `make*()`, `vi.mock()` before imports, store tests via `getState()`/`setState()`, IPC verification via mock assertions.

### 10.1 Test File Structure

```
tests/unit/browser/
  ├── browser-store.test.ts          — Zustand store logic
  ├── cdp-proxy.test.ts              — CDP filter proxy (HTTP filtering + WS relay)
  ├── browser-manager.test.ts        — Tab lifecycle, target categorization
  ├── browser-config.test.ts         — openclaw.json read/write
  ├── cookie-manager.test.ts         — Cookie CRUD operations
  ├── webauth-proxy.test.ts     — OpenAI-compatible proxy routing + SSE
  ├── provider-base.test.ts          — executeInWebview, streamFromWebview
  ├── provider-claude-web.test.ts    — Claude: org discovery, SSE transform
  ├── provider-deepseek-web.test.ts  — DeepSeek: bearer token, standard API
  ├── provider-chatgpt-web.test.ts   — ChatGPT: access token, sentinel, SSE
  ├── provider-gemini-web.test.ts    — Gemini: Batchexecute format
  ├── provider-grok-web.test.ts      — Grok: X/Twitter cookies
  ├── provider-qwen-web.test.ts      — Qwen: intl + china variants
  ├── provider-kimi-web.test.ts      — Kimi: binary gRPC-Web protocol
  ├── provider-doubao-web.test.ts    — Doubao: ByteDance cookies
  ├── provider-glm-web.test.ts       — GLM: china + intl variants
  ├── provider-manus-api.test.ts     — Manus: standard REST API
  └── webview-streaming.test.ts      — IPC streaming mechanics

tests/e2e/browser/
  ├── browser-panel.spec.ts          — Panel toggle, resize, tab management
  ├── browser-navigation.spec.ts     — URL bar, back/forward, external sites
  ├── browser-cdp.spec.ts            — CDP proxy + OpenClaw browser tool simulation
  └── browser-zero-token.spec.ts     — Full zero-token auth + API call flow
```

### 10.2 Mock Infrastructure

#### Mock Electron APIs (`tests/mocks/electron-browser.ts`)

```typescript
// Reusable mock factories for browser-related Electron APIs

export function makeMockWebview(overrides: Partial<MockWebview> = {}): MockWebview {
  return {
    src: '',
    partition: 'persist:browser-shared',
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    getURL: vi.fn().mockReturnValue('about:blank'),
    getTitle: vi.fn().mockReturnValue(''),
    setZoomFactor: vi.fn(),
    getZoomFactor: vi.fn().mockReturnValue(1.0),
    canGoBack: vi.fn().mockReturnValue(false),
    canGoForward: vi.fn().mockReturnValue(false),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    // IPC message simulation
    _simulateIpcMessage: (channel: string, ...args: unknown[]) => {
      // Fires registered 'ipc-message' listeners
    },
    ...overrides,
  };
}

export function makeMockSession(overrides = {}): MockSession {
  const cookieStore: Map<string, Electron.Cookie> = new Map();
  return {
    cookies: {
      get: vi.fn(async (filter) => [...cookieStore.values()]),
      set: vi.fn(async (cookie) => { cookieStore.set(cookie.name, cookie); }),
      remove: vi.fn(async (url, name) => { cookieStore.delete(name); }),
    },
    clearStorageData: vi.fn().mockResolvedValue(undefined),
    setUserAgent: vi.fn(),
    ...overrides,
  };
}

export function makeMockWebContents(id: number, url = 'about:blank'): MockWebContents {
  return {
    id,
    getURL: vi.fn().mockReturnValue(url),
    getTitle: vi.fn().mockReturnValue(`Page ${id}`),
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(),
      on: vi.fn(),
      isAttached: vi.fn().mockReturnValue(false),
    },
  };
}
```

#### Mock CDP Server (`tests/mocks/mock-cdp-server.ts`)

```typescript
// Simulates Electron's --remote-debugging-port HTTP + WS endpoints
// Used to test CDP filter proxy WITHOUT running Electron

export function createMockCdpServer(port: number): MockCdpServer {
  // HTTP endpoints:
  //   GET /json/list → returns configurable target list
  //   GET /json/version → returns version info
  // WebSocket:
  //   /devtools/page/{id} → echoes CDP messages back (for relay testing)
  //
  // Configurable:
  //   server.setTargets([...]) → set which targets /json/list returns
  //   server.getRelayedMessages() → get WS messages that were relayed
}
```

#### Mock AI Provider Responses (`tests/mocks/provider-responses.ts`)

```typescript
// Canned responses for each provider's internal API

export const claudeResponses = {
  organizations: [{ uuid: 'org-test-123', name: 'Personal' }],
  createConversation: { uuid: 'conv-test-456' },
  // SSE stream chunks as they come from claude.ai
  completionSSE: [
    'data: {"type":"completion","completion":"Hello","stop_reason":null}',
    'data: {"type":"completion","completion":" world","stop_reason":null}',
    'data: {"type":"completion","completion":"!","stop_reason":"end_turn"}',
  ],
};

export const chatgptResponses = {
  session: { accessToken: 'eyJ-test-token', user: { id: 'user-123' } },
  completionSSE: [
    'data: {"message":{"content":{"parts":["Hello"]}}}',
    'data: {"message":{"content":{"parts":["Hello world"]}}}',
    'data: [DONE]',
  ],
};

export const deepseekResponses = {
  completionSSE: [
    'data: {"choices":[{"delta":{"content":"Hello"}}]}',
    'data: {"choices":[{"delta":{"content":" world"}}]}',
    'data: [DONE]',
  ],
};

// Similar canned responses for: gemini, grok, qwen, kimi, doubao, glm, manus
// Each exports: auth check response, completion SSE chunks, error responses
export const geminiResponses = { /* Batchexecute format arrays */ };
export const grokResponses = { /* Standard SSE */ };
export const qwenResponses = { /* Standard SSE, shared for intl + china */ };
export const kimiResponses = { /* Binary gRPC-Web frames as Buffer */ };
export const doubaoResponses = { /* ByteDance SSE */ };
export const glmResponses = { /* Standard SSE, shared for china + intl */ };
export const manusResponses = { /* Standard REST JSON */ };
```

### 10.3 Unit Tests — Phase 1 (Browser Panel)

#### `browser-store.test.ts` — Zustand Store

```typescript
describe('useBrowserStore', () => {
  beforeEach(() => {
    useBrowserStore.setState({ tabs: [], activeTabId: null, panelOpen: false });
  });

  describe('tab management', () => {
    it('addTab creates tab with unique ID and default partition', () => {});
    it('addTab sets new tab as active', () => {});
    it('closeTab removes tab and activates previous', () => {});
    it('closeTab on last tab sets activeTabId to null', () => {});
    it('setActiveTab updates activeTabId', () => {});
    it('updateTab merges partial updates', () => {});
  });

  describe('navigation', () => {
    it('navigate calls IPC browser:tab:navigate with active tab ID', () => {});
    it('navigate does nothing if no active tab', () => {});
    it('goBack/goForward/reload call correct IPC channels', () => {});
  });

  describe('panel state', () => {
    it('togglePanel flips panelOpen', () => {});
    it('setPanelWidth clamps between MIN and MAX', () => {});
    it('setPanelWidth below 320 clamps to 320', () => {});
    it('setPanelWidth above 1200 clamps to 1200', () => {});
  });

  describe('zoom', () => {
    it('setZoom updates active tab zoomFactor', () => {});
    it('setZoom clamps between 0.25 and 5.0', () => {});
    it('setZoom calls IPC browser:tab:setZoom', () => {});
  });

  describe('detach/attach', () => {
    it('detachPanel sets detached=true and calls IPC', () => {});
    it('attachPanel sets detached=false and calls IPC', () => {});
  });
});
```

#### `browser-manager.test.ts` — Tab Lifecycle + Target Categorization

```typescript
describe('BrowserManager', () => {
  describe('target categorization', () => {
    it('main window webContents is never in exposed set', () => {});
    it('automation tab webContents is added to exposed set', () => {});
    it('zero-token provider webContents is never in exposed set', () => {});
    it('getExposedTargetIds returns only automation tabs', () => {});
    it('isTargetExposed returns false for unknown ID', () => {});
  });

  describe('tab lifecycle', () => {
    it('createTab generates unique ID and tracks webContents', () => {});
    it('closeTab removes from tracking and exposed set', () => {});
    it('onWebContentsCreated detects new targets from CDP', () => {});
    it('onWebContentsCreated for CDP-created target adds to exposed set', () => {});
    it('onWebContentsCreated for provider webview does NOT add to exposed', () => {});
  });

  describe('partition management', () => {
    it('creates correct partition for automation tab', () => {});
    it('creates persist partition for provider webview', () => {});
    it('incognito partition does not have persist: prefix', () => {});
  });
});
```

### 10.4 Unit Tests — Phase 2 (CDP Proxy)

#### `cdp-proxy.test.ts` — CDP Filter Proxy

```typescript
describe('CdpFilterProxy', () => {
  let mockCdpServer: MockCdpServer;
  let proxy: CdpFilterProxy;

  beforeEach(async () => {
    // Start mock CDP server on port 19222 (simulates Electron's real CDP)
    mockCdpServer = await createMockCdpServer(19222);
    mockCdpServer.setTargets([
      { id: 'main-window', url: 'file:///app/index.html', title: 'CrawBot', type: 'page' },
      { id: 'tab-1', url: 'https://example.com', title: 'Example', type: 'page' },
      { id: 'tab-2', url: 'https://google.com', title: 'Google', type: 'page' },
      { id: 'provider-claude', url: 'https://claude.ai', title: 'Claude', type: 'page' },
    ]);
    // Start proxy on port 19333, pointing to mock CDP
    proxy = new CdpFilterProxy({ realCdpPort: 19222, proxyPort: 19333 });
    proxy.setExposedTargets(new Set(['tab-1', 'tab-2'])); // Only automation tabs
    await proxy.start();
  });

  afterEach(async () => {
    await proxy.stop();
    await mockCdpServer.stop();
  });

  describe('GET /json/list', () => {
    it('returns only exposed targets (hides main window)', async () => {
      const res = await fetch('http://127.0.0.1:19333/json/list');
      const targets = await res.json();
      expect(targets).toHaveLength(2);
      expect(targets.map(t => t.id)).toEqual(['tab-1', 'tab-2']);
    });

    it('hides zero-token provider webviews', async () => {
      const res = await fetch('http://127.0.0.1:19333/json/list');
      const targets = await res.json();
      expect(targets.find(t => t.id === 'provider-claude')).toBeUndefined();
    });

    it('rewrites webSocketDebuggerUrl port from 19222 to 19333', async () => {
      const res = await fetch('http://127.0.0.1:19333/json/list');
      const targets = await res.json();
      targets.forEach(t => {
        expect(t.webSocketDebuggerUrl).toContain(':19333/');
        expect(t.webSocketDebuggerUrl).not.toContain(':19222/');
      });
    });
  });

  describe('GET /json/version', () => {
    it('returns browser version info with rewritten WS URL', async () => {
      const res = await fetch('http://127.0.0.1:19333/json/version');
      const version = await res.json();
      expect(version.webSocketDebuggerUrl).toContain(':19333/');
    });
  });

  describe('WebSocket relay', () => {
    it('relays CDP messages bidirectionally for exposed target', async () => {
      // Connect WS to proxy for tab-1
      // Send CDP command → verify it reaches mock CDP server
      // Mock CDP sends response → verify it reaches client
    });

    it('rejects WS connection for non-exposed target', async () => {
      // Try to connect WS for 'main-window' → expect 403 or connection refused
    });

    it('rejects WS connection for provider webview target', async () => {
      // Try to connect WS for 'provider-claude' → expect 403
    });
  });

  describe('dynamic target updates', () => {
    it('addExposedTarget makes new target visible in /json/list', () => {});
    it('removeExposedTarget hides target from /json/list', () => {});
  });
});
```

#### `browser-config.test.ts` — openclaw.json Management

```typescript
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));

describe('browser-config', () => {
  describe('setOpenClawBrowserConfig', () => {
    it('writes browser section to existing openclaw.json without overwriting other keys', () => {
      // Existing config has agents, models → verify they're preserved
    });
    it('creates openclaw.json if not exists', () => {});
    it('sets attachOnly=true and defaultProfile=crawbot', () => {});
    it('writes correct cdpUrl with given port', () => {});
    it('overwrites existing browser config if present', () => {});
  });

  describe('removeOpenClawBrowserConfig', () => {
    it('removes browser key from openclaw.json', () => {});
    it('preserves all other config keys', () => {});
    it('no-op if browser key not present', () => {});
    it('no-op if openclaw.json not exists', () => {});
  });

  describe('setOpenClawWebProviderConfig', () => {
    it('writes models.providers.web-provider with correct baseUrl', () => {});
    it('includes only authenticated provider models', () => {});
    it('preserves existing models.providers entries', () => {});
  });
});
```

### 10.5 Unit Tests — Phase 3 (Cookie Management)

#### `cookie-manager.test.ts`

```typescript
describe('CookieManager', () => {
  let mockSession: MockSession;

  beforeEach(() => {
    mockSession = makeMockSession();
  });

  it('getCookies returns cookies filtered by URL', async () => {});
  it('setCookie adds cookie to session', async () => {});
  it('removeCookie deletes specific cookie', async () => {});
  it('clearCookies clears all cookies for partition', async () => {});
  it('exportCookies returns all cookies as JSON', async () => {});
  it('importCookies sets multiple cookies from JSON array', async () => {});
  it('importCookies skips cookies with missing required fields', async () => {});
});
```

### 10.6 Unit Tests — Phase 4 (Zero-Token Providers)

#### `provider-base.test.ts` — Streaming Mechanics

```typescript
describe('executeInWebview', () => {
  let webview: MockWebview;

  beforeEach(() => {
    webview = makeMockWebview();
  });

  it('calls executeJavaScript with fetch and credentials:include', async () => {
    webview.executeJavaScript.mockImplementation(async () => {
      // Simulate the webview preload responding via IPC
      webview._simulateIpcMessage('crawbot:response', 'req-1', {
        status: 200, headers: {}, body: '{"ok":true}',
      });
    });
    const result = await executeInWebview(webview, 'req-1', 'https://api.example.com', { method: 'GET' });
    expect(result.status).toBe(200);
    expect(result.body).toBe('{"ok":true}');
  });

  it('propagates HTTP errors (401, 403, 500)', async () => {});
  it('propagates fetch exceptions as errors', async () => {});
});

describe('streamFromWebview', () => {
  let webview: MockWebview;

  it('yields chunks as they arrive via IPC', async () => {
    webview = makeMockWebview();
    const { stream } = streamFromWebview(webview, 'req-1', 'https://api.example.com', {
      method: 'POST', body: '{}',
    });

    // Simulate chunks arriving from webview preload
    setTimeout(() => {
      webview._simulateIpcMessage('crawbot:stream:chunk', 'req-1', 'data: chunk1\n\n');
      webview._simulateIpcMessage('crawbot:stream:chunk', 'req-1', 'data: chunk2\n\n');
      webview._simulateIpcMessage('crawbot:stream:end', 'req-1');
    }, 10);

    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(['data: chunk1\n\n', 'data: chunk2\n\n']);
  });

  it('throws on stream error', async () => {});
  it('supports abort', async () => {});
  it('handles multiple concurrent streams via requestId', async () => {});
});
```

#### `provider-claude-web.test.ts` — Claude Provider

```typescript
describe('ClaudeWebProvider', () => {
  let webview: MockWebview;
  let provider: ClaudeWebProvider;

  beforeEach(() => {
    webview = makeMockWebview();
    provider = new ClaudeWebProvider();
  });

  describe('checkAuth', () => {
    it('returns authenticated=true when sessionKey cookie exists', async () => {
      webview.executeJavaScript.mockResolvedValue(true); // cookie check returns true
      const result = await provider.checkAuth(webview);
      expect(result.authenticated).toBe(true);
    });

    it('returns authenticated=false when no sessionKey cookie', async () => {
      webview.executeJavaScript.mockResolvedValue(false);
      const result = await provider.checkAuth(webview);
      expect(result.authenticated).toBe(false);
    });
  });

  describe('chatCompletion', () => {
    it('discovers org → creates conversation → streams completion', async () => {
      // Mock sequence of IPC responses:
      // 1. org discovery → returns org UUID
      // 2. create conversation → returns conv UUID
      // 3. stream completion → yields SSE chunks
      // Verify final output is OpenAI-format SSE
    });

    it('transforms Claude SSE to OpenAI SSE format', async () => {
      // Input: data: {"type":"completion","completion":"Hello","stop_reason":null}
      // Output: data: {"id":"...","choices":[{"delta":{"content":"Hello"}}]}
    });

    it('handles stop_reason=end_turn → finish_reason=stop', async () => {});
    it('returns 401 when session expired', async () => {});
    it('reuses existing conversation for follow-up messages', async () => {});
  });

  describe('models', () => {
    it('exposes correct model IDs with web- prefix', () => {
      expect(provider.models.map(m => m.id)).toContain('webauth-claude-sonnet-4');
    });
  });
});
```

#### `provider-chatgpt-web.test.ts` — ChatGPT Provider

```typescript
describe('ChatGPTWebProvider', () => {
  describe('checkAuth', () => {
    it('detects split session token cookies (.0 and .1)', async () => {});
    it('returns false when no session token', async () => {});
  });

  describe('getAccessToken', () => {
    it('fetches from /api/auth/session and extracts accessToken', async () => {});
    it('caches access token to avoid repeated fetches', async () => {});
  });

  describe('chatCompletion', () => {
    it('transforms OpenAI request to ChatGPT backend-api format', async () => {
      // Verify: action=next, messages[].content.parts, parent_message_id
    });
    it('transforms ChatGPT SSE to OpenAI SSE format', async () => {
      // Input: {"message":{"content":{"parts":["Hello"]}}}
      // Output: {"choices":[{"delta":{"content":"Hello"}}]}
    });
    it('handles 403 with session expired notification (no DOM fallback)', async () => {});
  });
});
```

#### `provider-deepseek-web.test.ts` — DeepSeek Provider

```typescript
describe('DeepSeekWebProvider', () => {
  describe('checkAuth', () => {
    it('detects bearer token from stored auth', async () => {});
  });

  describe('chatCompletion', () => {
    it('sends request with Authorization header', async () => {});
    it('SSE format is already OpenAI-compatible (minimal transform)', async () => {});
  });
});
```

#### `webauth-proxy.test.ts` — Proxy Server

```typescript
describe('WebProviderProxy', () => {
  let proxy: WebProviderProxy;

  beforeEach(async () => {
    proxy = new WebProviderProxy({ providers: [mockClaudeProvider, mockChatGPTProvider] });
    await proxy.start(); // dynamic port
  });

  afterEach(async () => {
    await proxy.stop();
  });

  describe('GET /v1/models', () => {
    it('returns models from all authenticated providers', async () => {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/models`);
      const data = await res.json();
      expect(data.data).toContainEqual(expect.objectContaining({ id: 'webauth-claude-sonnet-4' }));
    });

    it('excludes models from unauthenticated providers', async () => {});
  });

  describe('POST /v1/chat/completions', () => {
    it('routes to correct provider based on model prefix', async () => {
      const res = await fetch(`http://127.0.0.1:${proxy.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'webauth-claude-sonnet-4', messages: [{ role: 'user', content: 'Hi' }] }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    });

    it('returns 404 for unknown model prefix', async () => {});
    it('returns 401 when provider session expired', async () => {});
    it('streams SSE chunks in real-time (not buffered)', async () => {
      // Verify: first chunk arrives before stream completes
    });
    it('returns proper OpenAI error format on provider error', async () => {});
  });

  describe('POST /v1/providers/{id}/check-auth', () => {
    it('returns auth status for given provider', async () => {});
  });
});
```

### 10.7 Integration Tests — End-to-End Flows

#### `webview-streaming.test.ts` — Full Streaming Pipeline

```typescript
describe('webview streaming integration', () => {
  it('full flow: executeJavaScript → preload sendToHost → IPC handler → async generator → HTTP SSE', async () => {
    // 1. Create mock webview with simulated IPC
    // 2. Start web provider proxy with mock provider
    // 3. HTTP request to /v1/chat/completions
    // 4. Provider calls streamFromWebview
    // 5. Simulate webview IPC chunks arriving
    // 6. Verify HTTP response receives SSE chunks in order
    // 7. Verify [DONE] at end
  });

  it('handles concurrent streaming requests to different providers', async () => {
    // Two simultaneous requests: one to Claude, one to ChatGPT
    // Verify both streams complete independently
  });

  it('handles provider error mid-stream', async () => {
    // Stream starts, 2 chunks arrive, then error
    // Verify HTTP response includes error after partial data
  });
});
```

### 10.8 E2E Tests (Playwright + Electron)

> These test the real Electron app. Run with `pnpm test:e2e`.
> Require the app to be built first (`pnpm build:vite`).

#### `browser-panel.spec.ts`

```typescript
test.describe('Browser Panel', () => {
  test('toggle panel via toolbar button', async ({ electronApp }) => {
    // Click browser toggle button → panel appears
    // Click again → panel hides
  });

  test('create new tab and navigate', async ({ electronApp }) => {
    // Open panel → click [+] → new tab appears
    // Type URL in address bar → press Enter → page loads
    // Verify tab title updates
  });

  test('close tab', async ({ electronApp }) => {
    // Open 2 tabs → close first → second becomes active
  });

  test('back/forward navigation', async ({ electronApp }) => {
    // Navigate to page A → navigate to page B
    // Click back → verify page A
    // Click forward → verify page B
  });

  test('zoom in/out', async ({ electronApp }) => {
    // Click zoom in → verify zoom factor increases
    // Click zoom out → verify zoom factor decreases
  });

  test('resize panel via drag handle', async ({ electronApp }) => {
    // Drag left edge → verify panel width changes
    // Verify minimum width constraint (320px)
  });
});
```

#### `browser-cdp.spec.ts` — CDP + OpenClaw Simulation

```typescript
test.describe('CDP Proxy + OpenClaw Browser Tool', () => {
  test('OpenClaw can connect to CDP proxy and list targets', async ({ electronApp }) => {
    // Connect Playwright to http://127.0.0.1:9333
    // Verify /json/list returns browser tabs only (not main window)
  });

  test('OpenClaw can navigate a page via CDP', async ({ electronApp }) => {
    // Connect via CDP → get first target → navigate to URL
    // Verify webview in CrawBot shows the URL
  });

  test('OpenClaw can take screenshot via CDP', async ({ electronApp }) => {
    // CDP Page.captureScreenshot → verify non-empty image data
  });

  test('OpenClaw can click elements via CDP', async ({ electronApp }) => {
    // Navigate to test page → find button → CDP Input.dispatchMouseEvent
    // Verify click happened (page state changed)
  });

  test('new page created via CDP appears in BrowserPanel', async ({ electronApp }) => {
    // CDP Target.createTarget → verify new tab in panel
  });

  test('main window is NOT visible via CDP', async ({ electronApp }) => {
    // GET /json/list → verify no target with file:// or localhost URL
  });
});
```

#### `browser-zero-token.spec.ts` — Full Zero-Token Flow

```typescript
test.describe('Zero-Token Web Provider', () => {
  // These tests use a mock HTTP server that simulates Claude/ChatGPT web APIs
  // to avoid depending on real AI services

  test('full Claude Web auth + completion flow', async ({ electronApp }) => {
    // 1. Mock server on localhost simulates claude.ai responses
    // 2. Open Settings → Web Providers → Add Claude Web
    // 3. Webview navigates to mock server login page
    // 4. Inject session cookie via mock
    // 5. Click "Done" → provider marked authenticated
    // 6. Send chat completion via proxy → verify SSE response
  });

  test('session expiry triggers re-login notification', async ({ electronApp }) => {
    // 1. Setup authenticated provider
    // 2. Mock server returns 401
    // 3. Verify notification appears
    // 4. Re-login → verify session restored
  });

  test('web provider models appear in OpenClaw model list', async ({ electronApp }) => {
    // After auth → verify openclaw.json has models.providers.web-provider
    // Verify model IDs match webauth-claude-sonnet-4 etc.
  });

  test('provider webview is hidden from CDP targets', async ({ electronApp }) => {
    // Auth a provider → webview exists but not in /json/list
  });
});
```

### 10.9 Test Execution per Phase

| Phase | Tests to Run | Pass Criteria |
|-------|-------------|---------------|
| **Phase 1** | `browser-store.test.ts`, `browser-manager.test.ts`, E2E `browser-panel.spec.ts` | All store actions work, panel toggle/resize/tabs work |
| **Phase 2** | `cdp-proxy.test.ts`, `browser-config.test.ts`, E2E `browser-cdp.spec.ts` | CDP filter works, OpenClaw can navigate/click/screenshot via proxy |
| **Phase 3** | `cookie-manager.test.ts` | Cookie CRUD, export/import, clear per partition |
| **Phase 4** | `provider-*.test.ts`, `webauth-proxy.test.ts`, `webview-streaming.test.ts`, E2E `browser-zero-token.spec.ts` | Auth check, SSE transform, streaming pipeline, OpenAI-compat output |
| **Phase 5** | All above + detach/attach E2E tests | Full regression |

### 10.10 CI Integration

```bash
# Run all browser-related unit tests
pnpm vitest run tests/unit/browser/

# Run all browser E2E tests (requires built app)
pnpm build:vite && pnpm playwright test tests/e2e/browser/

# Run full test suite (existing + new)
pnpm test && pnpm test:e2e
```

### 10.11 Test Data & Mock Servers

For E2E tests that simulate AI provider websites, use a local mock HTTP server:

```typescript
// tests/e2e/helpers/mock-provider-server.ts
// Express server that simulates:
// - claude.ai/api/organizations → returns mock org
// - claude.ai/api/.../completion → returns canned SSE stream
// - chatgpt.com/api/auth/session → returns mock access token
// - chatgpt.com/backend-api/conversation → returns canned SSE
//
// Runs on localhost:18999 during E2E tests
// webview navigates to localhost:18999 instead of real provider
```

This avoids:
- Depending on real AI services in tests
- Rate limiting / ToS issues
- Flaky tests from network issues
- Need for real credentials

## 11. References

- [openclaw-zero-token](https://github.com/linuxhsj/openclaw-zero-token) — Original project for web session API hijacking. **Local clone: `/Users/xnohat/openclaw-zero-token`** — use this for implementation reference
- [Electron webview tag](https://www.electronjs.org/docs/latest/api/webview-tag)
- [Electron webContents.debugger](https://www.electronjs.org/docs/latest/api/debugger)
- [Electron session API](https://www.electronjs.org/docs/latest/api/session)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/)
- OpenClaw browser config: `~/openclaw/src/config/types.browser.ts`
- OpenClaw browser tool: `~/openclaw/src/agents/tools/browser-tool.ts`
- CrawBot WorkspacePanel pattern: `src/pages/Chat/WorkspacePanel.tsx`
