# WebAuth Provider Implementation Guide

> How to research, debug, test, and implement a WebAuth provider that uses
> inject-script + internal API approach (instead of DOM simulation).

## Overview

CrawBot WebAuth providers work by:
1. **Importing cookies** from Chrome browser into Electron session partition
2. **Importing browser storage** (localStorage, sessionStorage, IndexedDB) for auth state
3. **Injecting fetch() calls** inside the provider's web page context to call internal APIs
4. **Parsing responses** in provider-specific format (Batchexecute, SSE, NDJSON, etc.)

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
// Find input element
const input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');

// Type message — use native setter for React/Angular apps
const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
if (setter) setter.call(input, 'test message');
input.dispatchEvent(new Event('input', { bubbles: true }));

// Find and click send button — check aria-labels
const btn = document.querySelector('button[aria-label="Send message"]');
btn.click();
```

### Step 3: Capture the request

Listen for `Fetch.requestPaused` or `Network.requestWillBeSent` CDP events:

```javascript
webview.onCDPEvent((method, params) => {
  if (method === 'Fetch.requestPaused') {
    // params.request.url — the API endpoint
    // params.request.postData — the request body (URL-encoded)
    // params.requestId — use to continue the request
  }
});
```

Key things to capture:
- **API endpoint URL** (e.g., `StreamGenerate`, `/backend-api/conversation`)
- **Request body format** (URL-encoded, JSON, protobuf)
- **Required headers** (X-Same-Domain, Authorization, custom tokens)
- **Auth tokens** embedded in the request (AT token, CSRF token, session blob)

### Step 4: Capture the response

Use `Fetch.getResponseBody` or `Network.getResponseBody`:

```javascript
// For Fetch domain:
const body = await webview.sendCDPCommand('Fetch.getResponseBody', { requestId });
// body.body = response text (or base64 if body.base64Encoded)
```

### Step 5: Decode and document the format

Example for Gemini (Batchexecute format):

```
Request body (URL-decoded):
f.req=[null,"[[\"message\",0,null,...69 elements...]]"]&at=TOKEN&

Response (line-delimited):
)]}' (XSSI prefix)
332
[["wrb.fr",null,"[...nested JSON...]"]]
1505
[["wrb.fr",null,"[...response with answer text...]"]]
```

Document:
- Request body structure (which array indices contain what)
- Where the message text goes
- Where auth tokens come from
- Response structure (where to find the answer text)

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

Some tokens are generated dynamically by the web app's JavaScript and can't be extracted from static HTML. For these:

1. **Capture from a real request** using CDP Fetch interception
2. **Cache the template** — reuse for subsequent calls
3. **Invalidate on 400/401** — recapture when token expires

---

## Phase 3: Implement the Provider

### Architecture

```
Provider.chatCompletion(webview, request)
  → consolidateMessages(request.messages)  // Flatten all roles into single prompt
  → ensureTemplate(webview)                // Capture API template if not cached
  → buildRequestBody(template, prompt)     // Inject message into template
  → webview.executeJavaScript(fetch(...))  // Call API from page context
  → parseResponse(responseText)            // Extract answer from response
```

### Template Capture Pattern (for complex APIs like Gemini)

```typescript
// First call: capture real request via CDP Fetch interception
private async captureTemplate(webview: WebviewLike): Promise<Template> {
  // 1. Enable Fetch interception
  await webview.sendCDPCommand('Fetch.enable', {
    patterns: [{ urlPattern: '*StreamGenerate*', requestStage: 'Request' }]
  });

  // 2. Register event listener BEFORE triggering DOM send
  const capturePromise = new Promise((resolve) => {
    webview.onCDPEvent((method, params) => {
      if (method === 'Fetch.requestPaused') {
        // Extract body, URL, tokens
        resolve({ body: params.request.postData, url: params.request.url });
      }
    });
  });

  // 3. Navigate to clean page + type + click send via DOM
  await webview.executeJavaScript(`...DOM send code...`);

  // 4. Wait for interception
  const captured = await capturePromise;

  // 5. Continue the paused request (don't break the UI)
  await webview.sendCDPCommand('Fetch.continueRequest', { requestId });

  // 6. Disable interception
  await webview.sendCDPCommand('Fetch.disable');

  // 7. Parse and return template
  return parseTemplate(captured);
}
```

### API Call Pattern

```typescript
private async apiChat(webview: WebviewLike, message: string): Promise<string> {
  // Clone template, inject message
  const template = JSON.parse(JSON.stringify(this.cachedTemplate.inner));
  template[0][0] = message;  // Message position varies by provider

  // Build request body
  const body = buildBody(template, this.cachedTemplate.atToken);

  // Execute fetch in page context (cookies included via credentials: 'include')
  const result = await webview.executeJavaScript(`
    (async () => {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': '...', 'X-Same-Domain': '1' },
        credentials: 'include',
        body: ${JSON.stringify(body)},
      });
      const text = await res.text();
      // Parse response...
      return JSON.stringify({ status: res.status, answer });
    })()
  `);

  return JSON.parse(result).answer;
}
```

### Message Consolidation

Since web chat UIs only accept a single text input, flatten the OpenAI messages array:

```typescript
function consolidateMessages(messages: Array<{ role: string; content: unknown }>): string {
  // Simple messages: just return user text
  if (messages.length === 1 && messages[0].role === 'user') {
    return extractText(messages[0].content);
  }

  // Multi-turn: wrap each role in XML-like tags
  return messages.map(m => {
    const text = extractText(m.content);
    return `<${m.role}>\n${text}\n</${m.role}>`;
  }).join('\n\n');
}
```

---

## Phase 4: Debug and Test

### Debug Tools

1. **CDP via raw WebSocket** (most reliable for off-screen views):
```bash
# Find target
curl -s http://127.0.0.1:9222/json/list | python3 -c "..."

# Connect and evaluate
node -e "
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

3. **Monitor network from CDP**:
```javascript
await webview.sendCDPCommand('Network.enable', { maxPostDataSize: 65536 });
webview.onCDPEvent((method, params) => {
  if (method === 'Network.requestWillBeSent') {
    console.log(params.request.url, params.request.postData?.length);
  }
});
```

### Key Pitfalls

1. **Electron `webContents.executeJavaScript()` hangs on hidden/off-screen views**
   - Solution: Use raw WebSocket CDP `Runtime.evaluate` via `WebContentsViewAdapter`
   - The adapter connects to `ws://127.0.0.1:9222/devtools/page/{targetId}`

2. **`Fetch.requestPaused` event timing** — register listener BEFORE triggering the action
   - CDP events arrive asynchronously via WebSocket
   - Call `sendCDPCommand('Fetch.enable')` first, then set up `onCDPEvent`, then trigger DOM

3. **Page navigation resets JavaScript context** — don't use `location.href = '...'` then immediately `executeJavaScript`
   - Wait for page to fully load (poll for DOM elements)
   - CDP target ID stays the same after same-origin navigation

4. **Trusted Types / CSP** — some sites block `innerHTML`, `document.write`
   - Use `innerText` instead of `innerHTML`
   - Use native property setters for form inputs

5. **Cookie `sameSite` attribute** — Electron `ses.cookies.set()` defaults to `lax` if omitted
   - Always pass `sameSite: 'unspecified'` explicitly when importing cookies
   - Chrome stores cookies with `samesite=-1` (unspecified), not `lax`

6. **Browser storage sync** — cookies alone may not be enough for login
   - Also import localStorage, sessionStorage, IndexedDB via Chrome extension
   - Extension uses `chrome.scripting.executeScript` to read storage from Chrome tabs

---

## Phase 5: Provider-Specific Notes

### Gemini (Batchexecute)
- Endpoint: `/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate`
- Body: `f.req=` URL-encoded nested JSON array (69 elements) + `&at=` CSRF token
- Response: line-delimited JSON, answer at `data[4][0][1]` (array of strings)
- Session blob `[3]` and hash `[4]` are dynamic — must capture from real request
- Template capture via CDP `Fetch.requestPaused`

### Claude (SSE API)
- Endpoint: `https://claude.ai/api/organizations/{orgId}/chat_conversations/{convId}/completion`
- Body: JSON with prompt, model, timezone
- Response: SSE `data: {"type":"completion","completion":"token"}`
- Needs org discovery (`/api/organizations`) + conversation creation first
- Uses `streamFromWebview()` with IPC bridge for streaming

### ChatGPT (Sentinel tokens)
- Endpoint: `https://chatgpt.com/backend-api/conversation`
- Requires sentinel/turnstile anti-bot tokens (complex)
- Access token from `/api/auth/session`
- Response: SSE with `{"message":{"content":{"parts":["text"]}}}`

### DeepSeek (Proof-of-Work)
- Endpoint: `https://chat.deepseek.com/api/v0/chat/completion`
- Requires PoW challenge (SHA256 or WASM hash)
- Response: near-OpenAI SSE format

### Grok (NDJSON)
- Endpoint: `https://grok.com/rest/app-chat/conversations/{id}/responses`
- Response: NDJSON with `contentDelta` field

---

## Reference Files

- Provider implementations: `electron/browser/providers/*.ts`
- WebContentsView adapter: `electron/browser/providers/wcv-adapter.ts`
- Proxy server: `electron/browser/webauth-proxy.ts`
- Pipeline orchestrator: `electron/browser/webauth-pipeline.ts`
- Cookie import handler: `electron/main/ipc-handlers.ts` (search `import-from-chrome`)
- Chrome extension handlers: `assets/chrome-extension/background.js` (search `CrawBot.getCookies`, `CrawBot.getStorage`)
- Zero-token reference: `~/openclaw-zero-token/src/providers/`
