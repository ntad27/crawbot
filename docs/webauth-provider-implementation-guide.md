# WebAuth Provider Implementation Guide

> How to research, debug, test, and implement a WebAuth provider that uses
> inject-script + internal API approach (instead of DOM simulation).

## Overview

CrawBot WebAuth providers work by:
1. **Importing cookies + browser storage** from Chrome browser into Electron session partition
2. **Injecting fetch() calls** inside the provider's web page context to call internal APIs
3. **Parsing responses** in provider-specific format (Batchexecute, SSE, NDJSON, etc.)
4. **Translating tool calls** between text-based format (web chat compatible) and OpenAI format

This is the same approach as [openclaw-zero-token](https://github.com/linuxhsj/openclaw-zero-token).

---

## Phase 1: Research — Capture the Internal API

### Step 1: Set up monitoring

Use CDP (Chrome DevTools Protocol) on the Electron WebContentsView to monitor network traffic:

```javascript
// Enable network monitoring via CDP
await webview.sendCDPCommand('Network.enable', { maxPostDataSize: 65536 });

// Or use Fetch.enable to PAUSE requests (better for capturing full body):
await webview.sendCDPCommand('Fetch.enable', {
  patterns: [{ urlPattern: '*StreamGenerate*', requestStage: 'Request' }]
});
```

### Step 2: Trigger a real chat via DOM

Send a test message through the web UI to capture what the app actually sends:

```javascript
// Find input element — check both textarea (clean page) and contenteditable (conversation page)
const input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');

// Type message — use native setter for React/Angular apps
// IMPORTANT: Simple .value = 'x' doesn't trigger Angular change detection
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
if (setter) setter.call(input, 'test message');
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));

// Find and click send button — check aria-labels, NOT CSS classes
// CSS classes change frequently; aria-labels are more stable
const btn = document.querySelector('button[aria-label="Send message"]');
btn.click();
```

**Key lesson (Gemini):** Gemini's UI changes frequently. `<button>` elements may be replaced with `<mat-icon>` or other custom elements. Always use aria-labels for discovery:

```javascript
// Find ALL buttons and their labels
[...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).filter(Boolean)
// Result: ["Main menu", "Send message", "Microphone", "Tools", ...]
```

### Step 3: Capture the request

Listen for `Fetch.requestPaused` or `Network.requestWillBeSent` CDP events:

```javascript
webview.onCDPEvent((method, params) => {
  if (method === 'Fetch.requestPaused') {
    // params.request.url — the API endpoint
    // params.request.postData — the request body (URL-encoded)
    // params.requestId — use to continue the paused request

    // IMPORTANT: Continue the request so the UI doesn't break
    webview.sendCDPCommand('Fetch.continueRequest', { requestId: params.requestId });
  }
});
```

Key things to capture:
- **API endpoint URL** (e.g., `StreamGenerate`, `/backend-api/conversation`)
- **Request body format** (URL-encoded, JSON, protobuf)
- **Required headers** (X-Same-Domain, Authorization, custom tokens)
- **Auth tokens** embedded in the request (AT token, CSRF token, session blob)

### Step 4: Capture the response

For streaming responses, use `Fetch.enable` with `requestStage: 'Response'`:

```javascript
await webview.sendCDPCommand('Fetch.enable', {
  patterns: [{ urlPattern: '*StreamGenerate*', requestStage: 'Response' }]
});

// When paused at response stage:
const body = await webview.sendCDPCommand('Fetch.getResponseBody', { requestId });
// body.body = response text (or base64 if body.base64Encoded)

// Fulfill the original request so page gets the response too
await webview.sendCDPCommand('Fetch.fulfillRequest', { requestId, ... });
```

### Step 5: Decode and document the format

Example for Gemini (Batchexecute format):

```
Request body (URL-decoded):
f.req=[null,"[[\"message\",0,null,...69 elements...]]"]&at=TOKEN&

Response (line-delimited, NOT standard JSON):
)]}' (XSSI prefix — skip this line)
332           (byte count — skip)
[["wrb.fr",null,"[...nested JSON...]"]]
1505          (byte count — skip)
[["wrb.fr",null,"[...response with answer text...]"]]
```

Document:
- Request body structure (which array indices contain what)
- Where the message text goes (e.g., `inner[0][0]` for Gemini)
- Where auth tokens come from (page scripts, dynamic generation)
- Response structure (e.g., `data[4][0][1]` = `["answer text"]` for Gemini)
- How streaming works (multiple `wrb.fr` entries, last one has final text)

---

## Phase 2: Extract Auth Tokens

### From page scripts (WIZ_global_data for Google):

```javascript
const allText = [...document.querySelectorAll('script')].map(s => s.textContent).join('\n');
const atToken = allText.match(/"SNlM0e":"([^"]+)"/)?.[1];  // AT/CSRF token
const fsid = allText.match(/"FdrFJe":"([^"]+)"/)?.[1];      // Session ID
const bl = allText.match(/"cfb2h":"([^"]+)"/)?.[1];          // Build label
```

### Session-specific tokens (blob, hash):

Some tokens are generated dynamically by the web app's JavaScript runtime and can't be extracted from static HTML. For these:

1. **Capture from a real request** using CDP Fetch interception (one-time DOM send)
2. **Cache the full request template** — reuse for subsequent calls
3. **Invalidate on 400/401** — recapture when token expires

**Gemini-specific:** The request body has 69 array elements. Elements `[3]` (session blob) and `[4]` (hash) are generated dynamically by Gemini's Angular code. They CANNOT be extracted from page scripts — must capture from a real network request.

---

## Phase 3: Implement the Provider

### Architecture

```
Provider.chatCompletion(webview, request)
  → consolidateMessages(request.messages)  // Flatten all roles into single prompt
  → transformSystemPrompt(systemText)      // Convert tool defs for web chat
  → ensureTemplate(webview)                // Capture API template if not cached
  → buildRequestBody(template, prompt)     // Inject message into template
  → webview.executeJavaScript(fetch(...))  // Call API from page context
  → parseResponse(responseText)            // Extract answer from response
  → parseTextToolCalls(answer)             // Detect text-based tool calls
```

### Template Capture Pattern (for complex APIs like Gemini)

```typescript
private async captureTemplate(webview: WebviewLike): Promise<Template> {
  // 1. Enable Fetch interception BEFORE triggering DOM send
  await webview.sendCDPCommand('Fetch.enable', {
    patterns: [{ urlPattern: '*StreamGenerate*', requestStage: 'Request' }]
  });

  // 2. Set up capture promise with event listener
  let capturedBody, capturedUrl, capturedRequestId;
  const capturePromise = new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(), 15000); // 15s max
    webview.onCDPEvent((method, params) => {
      if (method === 'Fetch.requestPaused' && params.request.url.includes('StreamGenerate')) {
        capturedBody = params.request.postData;
        capturedUrl = params.request.url;
        capturedRequestId = params.requestId;
        clearTimeout(timeout);
        resolve();
      }
    });
  });

  // 3. Navigate to clean /app + type + click send via DOM
  await webview.executeJavaScript(`window.location.href = '...'`);
  // Wait for input element...
  await webview.executeJavaScript(`...type and click send...`);

  // 4. Wait for interception
  await capturePromise;

  // 5. Continue the paused request (don't break the UI)
  await webview.sendCDPCommand('Fetch.continueRequest', { requestId: capturedRequestId });

  // 6. Disable interception
  await webview.sendCDPCommand('Fetch.disable');

  // 7. Parse captured body → extract template
  const decoded = decodeURIComponent(capturedBody);
  // f.req=[null,"[[...]]"]&at=TOKEN&
  const freqMatch = decoded.match(/^f\.req=([\s\S]+?)&at=/);
  const atMatch = decoded.match(/&at=([^&]+)/);
  const outer = JSON.parse(freqMatch[1]);
  const inner = JSON.parse(outer[1]);  // 69-element array for Gemini
  return { inner, atToken: atMatch[1], url: capturedUrl };
}
```

### API Call Pattern (replay template with different message)

```typescript
private async apiChat(webview: WebviewLike, message: string): Promise<string> {
  // Clone template, inject message
  const template = JSON.parse(JSON.stringify(this.cachedTemplate.inner));
  template[0][0] = message;  // Message position varies by provider
  // Clear conversation IDs for new chat
  template[2] = ['', '', '', null, null, null, null, null, null, ''];

  // Build request body
  const body = 'f.req=' + encodeURIComponent(JSON.stringify([null, JSON.stringify(template)]))
    + '&at=' + encodeURIComponent(this.cachedTemplate.atToken) + '&';

  // Execute fetch in page context (cookies sent via credentials: 'include')
  const result = await webview.executeJavaScript(`
    (async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' },
        credentials: 'include',
        body: ${JSON.stringify(body)},
      });
      const text = await res.text();
      // Parse Batchexecute response for answer text
      let answer = '';
      for (const line of text.split('\\n')) {
        try {
          const p = JSON.parse(line);
          if (Array.isArray(p)) {
            for (const item of p) {
              if (Array.isArray(item) && item[0] === 'wrb.fr') {
                const data = JSON.parse(item[2]);
                if (data?.[4]?.[0]?.[1]) {
                  const parts = data[4][0][1];  // ["answer text"]
                  const t = Array.isArray(parts) ? parts.filter(x => typeof x === 'string').join('') : String(parts);
                  if (t.length > answer.length) answer = t;
                }
              }
            }
          }
        } catch {}
      }
      return JSON.stringify({ status: res.status, answer });
    })()
  `);

  return JSON.parse(result).answer;
}
```

### Message Consolidation

Since web chat UIs only accept a single text input, flatten the OpenAI messages array:

```typescript
function consolidateMessages(messages): string {
  // Simple single message: just return raw text
  if (messages.length === 1 && messages[0].role === 'user') {
    return extractText(messages[0].content);
  }

  // Multi-turn: wrap each role in XML-like tags
  return messages.map(m => {
    const text = extractText(m.content);
    switch (m.role) {
      case 'system': return `<system_instruction>\n${text}\n</system_instruction>`;
      case 'user': return `<user>\n${text}\n</user>`;
      case 'assistant': return `<assistant>\n${text}\n</assistant>`;
      case 'tool': return `<tool_result>\n${text}\n</tool_result>`;
    }
  }).join('\n\n');
}
```

**Tag choice matters:** Use `<system_instruction>` instead of `<system>` — Gemini Web Chat rejects `<system>` tag (likely hits guardrails for system prompt injection).

### Content extraction (OpenAI message format)

OpenAI `content` field can be string OR array of objects:

```typescript
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(p => p?.type === 'text')
      .map(p => p.text || '')
      .join('\n');
  }
  return String(content);
}
```

---

## Phase 4: Tool Call Support for Web Chat Models

### The Problem

Web chat models (Gemini, etc.) don't support native OpenAI function/tool calling. When the system prompt contains tool definitions and the model tries to "use" them, web chat guardrails block the response.

### Solution: Text-Based Tool Calls

Transform tool definitions into text-based calling instructions, then parse the model's text output back into OpenAI tool_calls format.

#### Step 1: Transform system prompt

Replace OpenClaw's native tool definitions with web-chat-compatible instructions:

```typescript
function transformSystemPromptForWebChat(systemText: string): string {
  // Extract tool names from the original system prompt
  const toolListMatch = systemText.match(/Tool availability[^]*?(?=##\s|$)/s);
  let toolNames = [];
  if (toolListMatch) {
    const matches = toolListMatch[0].matchAll(/^- (\w+):/gm);
    toolNames = [...matches].map(m => m[1]);
  }

  // Replace ## Tooling section with text-based instructions
  return systemText.replace(
    /## Tooling[\s\S]*?(?=## (?!Tool))/,
    `## Tool Use (Web Chat Mode)
You are running through a web chat interface. You CANNOT call tools natively.
When you need to use a tool, output a tool request in this EXACT format:

\`\`\`tool_call
{"name": "TOOL_NAME", "params": {"param1": "value1"}}
\`\`\`

Available tools: ${toolNames.join(', ')}

After outputting a tool_call block, STOP and wait for the tool result.
IMPORTANT:
- Output ONLY the tool_call code block when you want to use a tool
- Do NOT narrate before a tool call — just output the block
- You CAN chain multiple tool calls in one response
`
  );
}
```

#### Step 2: Parse text-based tool calls from response

```typescript
function parseTextToolCalls(text: string): Array<{ name: string; params: object; raw: string }> {
  const calls = [];
  const regex = /```tool_call\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name) {
        calls.push({ name: parsed.name, params: parsed.params || {}, raw: match[0] });
      }
    } catch {}
  }
  return calls;
}
```

#### Step 3: Emit as OpenAI tool_calls in response

```typescript
if (toolCalls.length > 0) {
  // Emit tool calls in OpenAI format
  yield {
    id: completionId,
    object: 'chat.completion.chunk',
    choices: [{
      index: 0,
      delta: {
        tool_calls: toolCalls.map((tc, i) => ({
          index: i,
          id: `call_${Date.now()}_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: JSON.stringify(tc.params) },
        })),
      },
      finish_reason: 'tool_calls',
    }],
  };
} else {
  // Regular text response
  yield { ... delta: { content: responseText }, finish_reason: 'stop' };
}
```

#### How it works end-to-end

```
OpenClaw Agent → sends messages with tool defs in system prompt
  → WebAuth Proxy receives OpenAI format request
  → Gemini Provider consolidates messages:
    - System prompt: tool defs → transformed to "output ```tool_call``` blocks"
    - Conversation history: <user>, <assistant>, <tool_result> tags
  → Sends consolidated prompt to Gemini Web API via injected fetch()
  → Gemini responds with text containing ```tool_call``` blocks
  → Provider parses tool_call blocks → converts to OpenAI tool_calls format
  → OpenClaw Agent receives standard tool_calls response
  → Agent executes tool → sends tool result as next message
  → Next request includes <tool_result> in conversation
  → Gemini sees result → continues conversation
```

---

## Phase 5: Debug and Test

### Debug Tools

1. **CDP via raw WebSocket** (most reliable for off-screen views):
```bash
# Find target
curl -s http://127.0.0.1:9222/json/list | python3 -c "import json,sys; ..."

# Connect and evaluate
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/TARGET_ID');
ws.on('open', () => {
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: 'document.title', returnByValue: true
  }}));
});
"
```

2. **Test proxy directly** (bypass agent, test provider in isolation):
```bash
PORT=$(cat ~/.openclaw/openclaw.json | python3 -c "import json,sys; print(json.load(sys.stdin)['models']['providers']['webauth']['baseUrl'].split(':')[-1].split('/')[0])")
curl -sN --max-time 30 -H "Content-Type: application/json" \
  -X POST "http://127.0.0.1:${PORT}/v1/chat/completions" \
  -d '{"model":"webauth-gemini-pro","messages":[{"role":"user","content":"What is 2+2?"}]}'
```

3. **Test tool calls via proxy**:
```bash
curl -sN --max-time 30 -H "Content-Type: application/json" \
  -X POST "http://127.0.0.1:${PORT}/v1/chat/completions" \
  -d '{
    "model": "webauth-gemini-pro",
    "messages": [
      {"role": "system", "content": "You have tool: read (params: {path: string}). Use ```tool_call``` format."},
      {"role": "user", "content": "Read the file at /tmp/test.txt"}
    ]
  }'
```

4. **Monitor network from CDP**:
```javascript
await webview.sendCDPCommand('Network.enable', { maxPostDataSize: 65536 });
webview.onCDPEvent((method, params) => {
  if (method === 'Network.requestWillBeSent') {
    console.log(params.request.url, params.request.postData?.length);
  }
});
```

5. **Full automated test** (start dev, wait for init, test proxy):
```bash
pnpm dev > /tmp/crawbot_test.log 2>&1 &
sleep 50  # Wait for pipeline init + gateway restart
PORT=$(cat ~/.openclaw/openclaw.json | python3 -c "...")
curl -sN --max-time 30 ... # test
grep "Pipeline\|Template\|chatCompletion" /tmp/crawbot_test.log
kill $DEV_PID
```

### Key Pitfalls

1. **Electron `webContents.executeJavaScript()` hangs on hidden/off-screen views**
   - Root cause: Chromium throttles off-screen/hidden WebContentsViews
   - Solution: Use raw WebSocket CDP `Runtime.evaluate` via `WebContentsViewAdapter`
   - The adapter connects to `ws://127.0.0.1:9222/devtools/page/{targetId}`
   - Even `webContents.debugger.sendCommand()` hangs — only raw WebSocket works

2. **`Fetch.requestPaused` event timing** — register listener BEFORE triggering the action
   - CDP events arrive asynchronously via WebSocket
   - Call `sendCDPCommand('Fetch.enable')` first, then set up `onCDPEvent`, then trigger DOM
   - `onCDPEvent` must handle connection-aware buffering (callbacks stored, attached after WS opens)

3. **Page navigation resets JavaScript context** — don't use `location.href = '...'` then immediately `executeJavaScript`
   - Wait for page to fully load (poll for DOM elements every 300ms)
   - CDP target ID stays the same after same-origin navigation
   - But `location.href` assignment returns immediately — the navigation hasn't happened yet

4. **Trusted Types / CSP** — some sites block `innerHTML`, `document.write`
   - Use `innerText` instead of `innerHTML` for contenteditable elements
   - Use native property setters (`HTMLTextAreaElement.prototype.value.set`) for form inputs
   - Angular/React change detection requires dispatching `input` + `change` events after setting value

5. **Cookie `sameSite` attribute** — Electron `ses.cookies.set()` defaults to `lax` if omitted
   - Always pass `sameSite: 'unspecified'` explicitly when importing cookies
   - Chrome stores cookies with `samesite=-1` (UNSPECIFIED) in SQLite, not `lax` (1)
   - `no_restriction` (0) = SameSite=None, `lax` (1) = Lax, `strict` (2) = Strict
   - Verified via: `sqlite3 ~/Library/Application\ Support/crawbot/Partitions/*/Cookies "SELECT samesite FROM cookies"`

6. **Browser storage sync** — cookies alone may not be enough for login
   - Also import localStorage, sessionStorage, IndexedDB via Chrome extension
   - Extension uses `chrome.scripting.executeScript` to read storage from Chrome tabs
   - If no Chrome tab exists on the domain, extension auto-creates one (background), reads, then closes
   - IndexedDB import requires re-creating object stores with `onupgradeneeded`

7. **OpenClaw Gateway config format** — minimal model definitions only
   - Gateway crashes if model config has unknown fields (cost, reasoning, input)
   - Use only `{ id, name }` format for models in openclaw.json
   - Gateway restart required after writing webauth config (hot-reload not supported)

8. **Web chat guardrails** — models refuse tool-like requests when phrased as tool calls
   - Solution: Transform tool defs to text-based format (````tool_call` blocks)
   - Use `<system_instruction>` tag (not `<system>` — Gemini rejects it)
   - Model outputs tool calls as markdown code blocks → proxy parses → OpenAI format

9. **Response parsing for Batchexecute** — answer text location varies
   - Gemini: `data[4][0][1]` = `["answer text"]` (array of strings, NOT nested arrays)
   - Common mistake: `parts.map(x => x[0])` gets first CHARACTER, not first string
   - Correct: `parts.filter(x => typeof x === 'string').join('')`
   - Multiple `wrb.fr` entries in response — keep the longest answer (streaming chunks)

---

## Phase 6: Provider-Specific Notes

### Gemini (Batchexecute)
- **Endpoint:** `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
- **Body:** `f.req=` URL-encoded nested JSON array (69 elements) + `&at=` CSRF token
- **Response:** Line-delimited JSON, answer at `data[4][0][1]` (array of strings)
- **Session tokens:** `[3]` (blob) and `[4]` (hash) are dynamic — must capture from real request
- **Template capture:** Via CDP `Fetch.requestPaused` — intercept real StreamGenerate request
- **Auth tokens from page:** `SNlM0e` (AT), `FdrFJe` (session ID), `cfb2h` (build label)
- **Input elements:** textarea (clean /app page) OR contenteditable (conversation page, Quill editor)
- **Send button:** `button[aria-label="Send message"]` (stable aria-label, NOT CSS class)
- **Tool calls:** Text-based ````tool_call` blocks — Gemini Web guardrails block native tool formats

### Claude (SSE API)
- **Endpoint:** `https://claude.ai/api/organizations/{orgId}/chat_conversations/{convId}/completion`
- **Body:** JSON with prompt, model, timezone, rendering_mode
- **Response:** SSE `data: {"type":"completion","completion":"token"}`
- **Auth:** Cookie `sessionKey` (format: `sk-ant-sid01-*`)
- **Flow:** Org discovery (`/api/organizations`) → conversation creation → stream completion
- **Headers:** `anthropic-client-platform: web_claude_ai`, `anthropic-device-id: {uuid}`
- **Uses `streamFromWebview()`** with IPC bridge for streaming

### ChatGPT (Sentinel tokens)
- **Endpoint:** `https://chatgpt.com/backend-api/conversation`
- **Requires:** Sentinel/turnstile anti-bot tokens (complex dynamic import from oaistatic CDN)
- **Access token:** From `/api/auth/session`
- **Response:** SSE with `{"message":{"content":{"parts":["text"]}}}`
- **DOM fallback:** On 403, switches to DOM simulation (type + click)
- **Anti-bot complexity:** HIGH — sentinel token generation requires evaluating CDN scripts

### DeepSeek (Proof-of-Work)
- **Endpoint:** `https://chat.deepseek.com/api/v0/chat/completion`
- **Requires:** PoW challenge via `x-ds-pow-response` header
- **PoW algorithms:** SHA256 (CPU loop) or DeepSeekHashV1 (WASM binary)
- **Session:** `chat_session/create` → returns session ID
- **Response:** Near-OpenAI SSE format
- **Thinking mode:** `thinking_enabled: true` for DeepSeek Reasoner (R1)

### Grok (NDJSON)
- **Endpoint:** `https://grok.com/rest/app-chat/conversations/{id}/responses`
- **Auth:** Cookie-based (Twitter/X auth cookies: `auth_token`, `ct0`)
- **Response:** NDJSON with `contentDelta` field
- **DOM fallback:** On 403, switches to DOM simulation
- **Device info:** Spoofed screen dimensions in request body

---

## Reference Files

- Provider implementations: `electron/browser/providers/*.ts`
- WebContentsView adapter: `electron/browser/providers/wcv-adapter.ts`
- Provider types: `electron/browser/providers/types.ts` (WebviewLike, WebProvider, tool call types)
- Proxy server: `electron/browser/webauth-proxy.ts`
- Pipeline orchestrator: `electron/browser/webauth-pipeline.ts`
- Cookie/storage import: `electron/main/ipc-handlers.ts` (search `import-from-chrome`)
- Cookie manager: `electron/browser/cookie-manager.ts`
- Chrome extension: `assets/chrome-extension/background.js` (search `CrawBot.getCookies`, `CrawBot.getStorage`)
- Extension manifest: `assets/chrome-extension/manifest.json`
- Browser config: `electron/utils/browser-config.ts`
- Zero-token reference: `~/openclaw-zero-token/src/providers/`
- Design doc: `docs/design-built-in-browser.md`
