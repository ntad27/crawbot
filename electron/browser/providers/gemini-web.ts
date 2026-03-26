/**
 * Gemini Web Provider — API approach via Batchexecute
 *
 * Uses Gemini's internal StreamGenerate API instead of DOM simulation.
 * First call captures the request template via CDP Network interception,
 * subsequent calls replay it with different messages via fetch().
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { consolidateMessages, parseTextToolCalls, extractImages, extractText, transformSystemPromptForGemini } from './shared-utils';
import { logger } from '../../utils/logger';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-gemini-pro', name: 'Gemini Pro (WebAuth)', contextWindow: 1000000 },
  { id: 'webauth-gemini-flash', name: 'Gemini Flash (WebAuth)', contextWindow: 1000000 },
];

interface CapturedTemplate {
  inner: unknown[];
  atToken: string;
  url: string;
}

export class GeminiWebProvider implements WebProvider {
  id = 'gemini-web';
  name = 'Gemini Web';
  loginUrl = 'https://gemini.google.com/app?hl=en';
  partition = 'persist:webauth-gemini';
  models = MODELS;

  private cachedTemplate: CapturedTemplate | null = null;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      const hasSession = await webview.executeJavaScript(
        `document.cookie.split(';').some(c => c.trim().startsWith('__Secure-1PSID='))`
      );
      return { authenticated: !!hasSession };
    } catch {
      return { authenticated: false };
    }
  }

  async *chatCompletion(
    webview: WebviewLike,
    request: OpenAIChatRequest,
  ): AsyncGenerator<OpenAIChatChunk> {
    const prompt = consolidateMessages(request.messages, transformSystemPromptForGemini);
    const lastUserMsg = [...request.messages].reverse().find(m => m.role === 'user');
    const images = lastUserMsg ? extractImages([lastUserMsg]) : [];
    const completionId = `chatcmpl-${Date.now()}`;
    const ts = () => Math.floor(Date.now() / 1000);

    // Image flow — non-streaming (sendWithImage uses CDP Network capture)
    if (images.length > 0) {
      logger.info('[Gemini] Image detected, step 1: getting image description...');
      const imageDescription = await this.sendWithImage(webview, 'describe this image in detail', images);
      if (!imageDescription) throw new Error('Gemini: no response. Ensure you are logged in.');
      const imageContext = `\n\n<image_description>\nThe user attached an image. Here is a detailed description of the image:\n${imageDescription}\n</image_description>`;
      const responseText = await this.apiChat(webview, prompt + imageContext);
      if (responseText) {
        yield { id: completionId, object: 'chat.completion.chunk', created: ts(), model: request.model,
          choices: [{ index: 0, delta: { content: responseText }, finish_reason: 'stop' }] };
      }
      return;
    }

    // ── Text-only flow with streaming ──
    // Stream text deltas, but hold back text that might be tool call JSON.
    // Tool calls look like: {"action": "function_call", "name": "...", ...}
    // We buffer text and only yield the "safe" prefix before any potential JSON.
    let fullText = '';
    let yieldedUpTo = 0;

    for await (const delta of this.apiChatStreaming(webview, prompt)) {
      fullText += delta;

      // Find the safe-to-yield boundary: everything before the first '{' that
      // could be a tool call JSON. We hold back from the first unmatched '{'.
      let safeEnd = fullText.length;
      const braceIdx = fullText.indexOf('{', yieldedUpTo);
      if (braceIdx !== -1) {
        safeEnd = braceIdx;
      }

      if (safeEnd > yieldedUpTo) {
        const safeChunk = fullText.substring(yieldedUpTo, safeEnd);
        yieldedUpTo = safeEnd;
        yield { id: completionId, object: 'chat.completion.chunk', created: ts(), model: request.model,
          choices: [{ index: 0, delta: { content: safeChunk }, finish_reason: null }] };
      }
    }

    if (!fullText) {
      throw new Error('Gemini: no response. Ensure you are logged in.');
    }

    // Parse tool calls from the complete response
    const toolCalls = parseTextToolCalls(fullText);
    const imageCalls = toolCalls.filter((tc) => tc.name === 'image');
    const otherCalls = toolCalls.filter((tc) => tc.name !== 'image');
    for (const ic of imageCalls) {
      const imgPath = (ic.params.path || ic.params.image || '') as string;
      if (imgPath) otherCalls.push({ name: 'read', params: { path: imgPath }, raw: ic.raw });
    }
    const allCalls = [...toolCalls]; // Keep original list for stripping

    // Yield remaining text (excluding tool call JSON)
    if (fullText.length > yieldedUpTo) {
      let remaining = fullText.substring(yieldedUpTo);
      // Strip tool call raw JSON from remaining text
      for (const tc of allCalls) remaining = remaining.replace(tc.raw, '');
      remaining = remaining.trim();
      if (remaining) {
        yield { id: completionId, object: 'chat.completion.chunk', created: ts(), model: request.model,
          choices: [{ index: 0, delta: { content: remaining }, finish_reason: null }] };
      }
    }

    // Handle image tool calls (vision flow)
    if (imageCalls.length > 0) {
      const analyses: string[] = [];
      for (const ic of imageCalls) {
        const imgPath = (ic.params.path || ic.params.image || '') as string;
        if (!imgPath) continue;
        try {
          const imgPrompt = (ic.params.prompt as string) || 'Describe this image in detail.';
          const analysis = await this.sendWithImage(webview, imgPrompt, [{ url: imgPath, mediaType: 'image/png' }]);
          if (analysis) analyses.push(analysis);
        } catch (err) {
          logger.error('[Gemini] Image analysis failed:', err);
          analyses.push(`[Image analysis failed: ${err}]`);
        }
      }
      if (analyses.length > 0) {
        const contextMsg = prompt + `\n\n<tool_result>\nImage analysis result:\n${analyses.join('\n---\n')}\n</tool_result>\n\nNow continue with the user's request based on this image analysis. Respond naturally.`;
        const finalResponse = await this.apiChat(webview, contextMsg);
        if (finalResponse) {
          const finalToolCalls = parseTextToolCalls(finalResponse);
          if (finalToolCalls.length > 0) {
            otherCalls.push(...finalToolCalls);
            let textContent = finalResponse;
            for (const tc of finalToolCalls) textContent = textContent.replace(tc.raw, '');
            textContent = textContent.trim();
            if (textContent) {
              yield { id: completionId, object: 'chat.completion.chunk', created: ts(), model: request.model,
                choices: [{ index: 0, delta: { content: textContent }, finish_reason: null }] };
            }
          } else {
            yield { id: completionId, object: 'chat.completion.chunk', created: ts(), model: request.model,
              choices: [{ index: 0, delta: { content: finalResponse }, finish_reason: otherCalls.length > 0 ? null : 'stop' }] };
          }
        }
      }
    }

    if (otherCalls.length > 0) {
      // Emit tool calls as structured chunk
      yield { id: completionId, object: 'chat.completion.chunk', created: ts(), model: request.model,
        choices: [{ index: 0, delta: {
          tool_calls: otherCalls.map((tc, i) => ({
            index: i, id: `call_${Date.now()}_${i}`, type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.params) },
          }))
        } as unknown as { content: string }, finish_reason: 'tool_calls' }],
      } as unknown as OpenAIChatChunk;
    } else {
      // Signal end of text stream
      yield { id: completionId, object: 'chat.completion.chunk', created: ts(), model: request.model,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
    }
  }

  private cachedPageUrl: string | null = null;

  private _apiRetryCount = 0;

  /** Parse Gemini batchexecute response, extracting the longest answer text */
  private parseBatchResponse(text: string): string {
    let answer = '';
    for (const line of text.split('\n')) {
      try {
        const p = JSON.parse(line);
        if (Array.isArray(p)) {
          for (const item of p) {
            if (Array.isArray(item) && item[0] === 'wrb.fr') {
              const data = JSON.parse(item[2]);
              if (data?.[4]?.[0]?.[1]) {
                const parts = data[4][0][1];
                const t = Array.isArray(parts)
                  ? parts.filter((x: unknown) => typeof x === 'string').join('')
                  : String(parts);
                if (t.length > answer.length) answer = t;
              }
            }
          }
        }
      } catch { /* skip unparseable lines */ }
    }
    return answer;
  }

  // 5-minute timeout for the Gemini API fetch — complex agentic queries
  // with many tool calls can take well over 30s on Gemini's side.
  private static readonly API_FETCH_TIMEOUT = 300_000;

  /**
   * Streaming version of apiChat — yields text deltas as Gemini generates them.
   *
   * Strategy: "polling" — the injected JS writes partial results to
   * window.__geminiPartial. A polling loop on the Node side reads it
   * via short executeJavaScript calls every 500ms. This avoids IPC entirely
   * and uses the proven CDP executeJavaScript mechanism.
   *
   * The main fetch runs in a SEPARATE executeJavaScript call with 5-min
   * timeout. CDP supports concurrent Runtime.evaluate calls.
   */
  private async *apiChatStreaming(webview: WebviewLike, message: string): AsyncGenerator<string> {
    await this.prepareForApiCall(webview);

    if (!this.cachedTemplate) {
      logger.info('[Gemini] No cached template, capturing (attempt 1)...');
      this.cachedTemplate = await this.captureTemplate(webview);
    }
    if (!this.cachedTemplate) {
      logger.warn('[Gemini] First capture failed, retrying (attempt 2)...');
      this.cachedTemplate = await this.captureTemplate(webview);
    }
    if (!this.cachedTemplate) {
      throw new Error('Failed to capture Gemini API template. Try reloading the Gemini tab.');
    }

    const template = JSON.parse(JSON.stringify(this.cachedTemplate.inner));
    template[0][0] = message;
    template[2] = ['', '', '', null, null, null, null, null, null, ''];

    const body = 'f.req=' + encodeURIComponent(JSON.stringify([null, JSON.stringify(template)]))
      + '&at=' + encodeURIComponent(this.cachedTemplate.atToken) + '&';

    logger.info(`[Gemini] Streaming API request (${message.length} chars)...`);

    // Inject the fetch code that stores partial results in window.__geminiPartial
    const fetchCode = `
      (async () => {
        window.__geminiPartial = '';
        window.__geminiDone = false;
        window.__geminiError = null;
        try {
          var res = await fetch(${JSON.stringify(this.cachedTemplate!.url)}, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' },
            credentials: 'include',
            body: ${JSON.stringify(body)},
          });
          if (!res.ok) {
            window.__geminiError = 'HTTP ' + res.status;
            window.__geminiDone = true;
            return JSON.stringify({ error: 'HTTP ' + res.status });
          }
          var reader = res.body.getReader();
          var decoder = new TextDecoder();
          var buffer = '';
          while (true) {
            var r = await reader.read();
            if (r.done) break;
            buffer += decoder.decode(r.value, { stream: true });
            var lines = buffer.split('\\n');
            buffer = lines.pop() || '';
            for (var i = 0; i < lines.length; i++) {
              var line = lines[i];
              if (!line.trim()) continue;
              try {
                var p = JSON.parse(line);
                if (Array.isArray(p)) {
                  for (var j = 0; j < p.length; j++) {
                    var item = p[j];
                    if (Array.isArray(item) && item[0] === 'wrb.fr') {
                      var data = JSON.parse(item[2]);
                      if (data && data[4] && data[4][0] && data[4][0][1]) {
                        var parts = data[4][0][1];
                        var t = Array.isArray(parts)
                          ? parts.filter(function(x) { return typeof x === 'string'; }).join('')
                          : String(parts);
                        if (t.length > window.__geminiPartial.length) {
                          window.__geminiPartial = t;
                        }
                      }
                    }
                  }
                }
              } catch(e) {}
            }
          }
          // Parse remaining buffer
          if (buffer.trim()) {
            try {
              var p2 = JSON.parse(buffer);
              if (Array.isArray(p2)) {
                for (var k = 0; k < p2.length; k++) {
                  var item2 = p2[k];
                  if (Array.isArray(item2) && item2[0] === 'wrb.fr') {
                    var data2 = JSON.parse(item2[2]);
                    if (data2 && data2[4] && data2[4][0] && data2[4][0][1]) {
                      var parts2 = data2[4][0][1];
                      var t2 = Array.isArray(parts2)
                        ? parts2.filter(function(x) { return typeof x === 'string'; }).join('')
                        : String(parts2);
                      if (t2.length > window.__geminiPartial.length) {
                        window.__geminiPartial = t2;
                      }
                    }
                  }
                }
              }
            } catch(e) {}
          }
          window.__geminiDone = true;
          return JSON.stringify({ answer: window.__geminiPartial });
        } catch (e) {
          window.__geminiError = e.message || String(e);
          window.__geminiDone = true;
          return JSON.stringify({ error: e.message || String(e) });
        }
      })()
    `;

    // Start the fetch (fire and forget — we'll poll for results)
    let fetchResult: string | null = null;
    let fetchError: string | null = null;
    let fetchDone = false;

    const fetchPromise = webview.executeJavaScript(fetchCode, GeminiWebProvider.API_FETCH_TIMEOUT)
      .then((result) => {
        fetchResult = result as string;
        fetchDone = true;
      })
      .catch((err: Error) => {
        fetchError = err.message;
        fetchDone = true;
      });

    // Poll for partial results every 500ms
    let lastYielded = 0;
    const pollInterval = 500;

    while (!fetchDone) {
      await new Promise(r => setTimeout(r, pollInterval));

      // Read partial result from the page
      try {
        const partial = await webview.executeJavaScript(
          `JSON.stringify({ t: window.__geminiPartial || '', d: !!window.__geminiDone, e: window.__geminiError })`
        ) as string;
        const state = JSON.parse(partial);

        if (state.t && state.t.length > lastYielded) {
          const delta = state.t.substring(lastYielded);
          lastYielded = state.t.length;
          yield delta;
        }

        if (state.d) {
          fetchDone = true;
          if (state.e) fetchError = state.e;
        }
      } catch {
        // Page might be navigating — skip this poll
      }
    }

    // Wait for the fetch promise to settle
    await fetchPromise;

    // Check for any remaining text from the final result
    if (fetchResult) {
      try {
        const parsed = JSON.parse(fetchResult);
        if (parsed.answer && parsed.answer.length > lastYielded) {
          yield parsed.answer.substring(lastYielded);
        }
      } catch { /* ignore */ }
    }

    if (fetchError) {
      if ((fetchError.includes('400') || fetchError.includes('401')) && this._apiRetryCount < 2) {
        logger.warn(`[Gemini] Stream error ${fetchError}, clearing template and retrying (${this._apiRetryCount + 1}/2)...`);
        this._apiRetryCount++;
        this.cachedTemplate = null;
        yield* this.apiChatStreaming(webview, message);
        return;
      }
      this._apiRetryCount = 0;
      throw new Error(`Gemini API: ${fetchError}`);
    }
    this._apiRetryCount = 0;

    logger.info(`[Gemini] Streaming complete (${lastYielded} chars)`);
  }

  /** Navigate to clean /app and validate template cache — shared by apiChat and apiChatStreaming */
  private async prepareForApiCall(webview: WebviewLike): Promise<void> {
    // Navigate to clean /app to ensure each message starts a new conversation
    try {
      const currentUrl = await webview.executeJavaScript('location.href') as string;
      if (currentUrl.includes('/app/')) {
        const accountMatch = currentUrl.match(/\/u\/(\d+)\//);
        const prefix = accountMatch ? '/u/' + accountMatch[1] : '';
        await webview.executeJavaScript(`window.location.href = 'https://gemini.google.com${prefix}/app?hl=en'`);
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 500));
          const ready = await webview.executeJavaScript(`!!document.querySelector('textarea, [contenteditable]')`);
          if (ready) break;
        }
      }
    } catch { /* page might not be ready */ }

    // Check if page URL changed (account switch or model change)
    try {
      const currentUrl = await webview.executeJavaScript('location.href') as string;
      if (this.cachedTemplate && this.cachedPageUrl) {
        const oldAccount = this.cachedPageUrl.match(/\/u\/(\d+)\//)?.[1] || '0';
        const newAccount = currentUrl.match(/\/u\/(\d+)\//)?.[1] || '0';
        if (oldAccount !== newAccount) {
          console.log(`[Gemini] Account changed (u/${oldAccount} → u/${newAccount}), invalidating template`);
          this.cachedTemplate = null;
        }
      }
      this.cachedPageUrl = currentUrl;
    } catch { /* page might not be ready */ }
  }

  private async apiChat(webview: WebviewLike, message: string): Promise<string> {
    await this.prepareForApiCall(webview);

    if (!this.cachedTemplate) {
      logger.info('[Gemini] No cached template, capturing (attempt 1)...');
      this.cachedTemplate = await this.captureTemplate(webview);
    }

    if (!this.cachedTemplate) {
      // Retry once — first attempt may fail due to stale page state or slow load
      logger.warn('[Gemini] First capture failed, retrying (attempt 2)...');
      this.cachedTemplate = await this.captureTemplate(webview);
    }

    if (!this.cachedTemplate) {
      throw new Error('Failed to capture Gemini API template. Try reloading the Gemini tab.');
    }

    // Clone template and set new message
    const template = JSON.parse(JSON.stringify(this.cachedTemplate.inner));
    template[0][0] = message;
    template[2] = ['', '', '', null, null, null, null, null, null, ''];

    const body = 'f.req=' + encodeURIComponent(JSON.stringify([null, JSON.stringify(template)]))
      + '&at=' + encodeURIComponent(this.cachedTemplate.atToken) + '&';

    logger.info(`[Gemini] Sending API request (${message.length} chars, timeout ${GeminiWebProvider.API_FETCH_TIMEOUT / 1000}s)...`);

    // Use extended timeout (5 min) for the fetch — complex queries can take minutes
    const resultStr = await webview.executeJavaScript(`
      (async () => {
        try {
          const res = await fetch(${JSON.stringify(this.cachedTemplate!.url)}, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' },
            credentials: 'include',
            body: ${JSON.stringify(body)},
          });
          if (!res.ok) return JSON.stringify({ error: 'HTTP ' + res.status });
          const text = await res.text();
          return JSON.stringify({ status: res.status, text });
        } catch(e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `, GeminiWebProvider.API_FETCH_TIMEOUT) as string;

    const parsed = JSON.parse(resultStr);
    if (parsed.error) {
      if ((parsed.error.includes('400') || parsed.error.includes('401')) && this._apiRetryCount < 2) {
        logger.warn(`[Gemini] API error ${parsed.error}, clearing template and retrying (${this._apiRetryCount + 1}/2)...`);
        this._apiRetryCount++;
        this.cachedTemplate = null;
        return this.apiChat(webview, message);
      }
      this._apiRetryCount = 0;
      throw new Error(`Gemini API: ${parsed.error}`);
    }
    this._apiRetryCount = 0;

    const answer = this.parseBatchResponse(parsed.text || '');
    logger.info(`[Gemini] Response received (${answer.length} chars)`);
    return answer;
  }

  /**
   * Send message with images via Gemini UI:
   * 1. Force viewport via CDP (ensures "+" button renders)
   * 2. Navigate to clean /app
   * 3. Click "+" → "Upload files" → Page.handleFileChooser sets file
   * 4. Wait for upload via push.clients6.google.com
   * 5. Type message via accessibility tree
   * 6. Click send via accessibility tree
   * 7. Capture response via CDP Network
   */
  private async sendWithImage(
    webview: WebviewLike,
    message: string,
    images: Array<{ url: string; mediaType: string }>,
  ): Promise<string> {
    if (!webview.sendCDPCommand) throw new Error('Gemini image requires CDP');

    const { BrowserWindow } = await import('electron');
    const mainWindow = BrowserWindow.getAllWindows()[0];
    const viewObj = (webview as unknown as { view?: import('electron').WebContentsView }).view;

    // Helper: hide webview and restore off-screen position
    const hideWebview = () => {
      if (mainWindow && viewObj && !mainWindow.isDestroyed()) {
        viewObj.setVisible(false);
        viewObj.setBounds({ x: -9999, y: -9999, width: 1280, height: 800 });
      }
    };

    // Resolve file paths first (before showing webview)
    const filePaths: string[] = [];
    for (const img of images) {
      if (img.url.startsWith('data:')) {
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const commaIdx = img.url.indexOf(',');
        if (commaIdx > 0) {
          const tmpPath = path.join(os.tmpdir(), `gemini-upload-${Date.now()}.${img.mediaType.includes('png') ? 'png' : 'jpg'}`);
          fs.writeFileSync(tmpPath, Buffer.from(img.url.substring(commaIdx + 1), 'base64'));
          filePaths.push(tmpPath);
        }
      } else {
        filePaths.push(img.url.replace('file://', ''));
      }
    }
    if (filePaths.length === 0) return this.apiChat(webview, message);

    try {
      // Navigate to clean /app first (before showing webview)
      try {
        const currentUrl = await webview.executeJavaScript('location.href') as string;
        if (currentUrl.includes('/app/')) {
          const accountMatch = currentUrl.match(/\/u\/(\d+)\//);
          const prefix = accountMatch ? '/u/' + accountMatch[1] : '';
          await webview.executeJavaScript(`window.location.href = 'https://gemini.google.com${prefix}/app?hl=en'`);
          for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            const ready = await webview.executeJavaScript(`!!document.querySelector('textarea, [contenteditable]')`);
            if (ready) break;
          }
        }
      } catch { /* page might not be ready */ }

      // Show webview on screen (Angular needs visible view to render "+" button)
      if (mainWindow && viewObj && !mainWindow.isDestroyed()) {
        try { mainWindow.contentView.removeChildView(viewObj); } catch { /* */ }
        mainWindow.contentView.addChildView(viewObj);
        const [winW, winH] = mainWindow.getContentSize();
        const w = Math.min(1280, winW - 40);
        const h = Math.min(800, winH - 40);
        viewObj.setBounds({ x: Math.floor((winW - w) / 2), y: Math.floor((winH - h) / 2), width: w, height: h });
        viewObj.setVisible(true);
      }

      // Override Page Visibility API (must be after navigation which reloads page)
      await webview.sendCDPCommand('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
      await webview.executeJavaScript(`
        Object.defineProperty(document, 'hidden', { get: function() { return false; }, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: function() { return 'visible'; }, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
      `);

      // Wait for Angular to render
      await new Promise(r => setTimeout(r, 2000));

      await webview.sendCDPCommand('DOM.enable');
      await webview.sendCDPCommand('Network.enable');
      const adapter = webview as unknown as { _ws?: { on: (e: string, h: unknown) => void; removeListener: (e: string, h: unknown) => void } };

      // Step A: Click "+" button via JS DOM selector (more reliable than a11y tree for off-screen views)
      const plusClicked = await webview.executeJavaScript(`
        (function() {
          var btn = document.querySelector('button[aria-label*="upload file menu"]');
          if (btn) { btn.click(); return btn.getAttribute('aria-label'); }
          return null;
        })()
      `) as string | null;

      if (!plusClicked) {
        logger.error('[Gemini] No "+" upload button found via DOM, falling back to text-only');
        hideWebview();
        return this.apiChat(webview, message);
      }
      logger.info('[Gemini] Clicked:', plusClicked);

      // Wait for overlay menu to render
      await new Promise(r => setTimeout(r, 1500));

      // Step B: Click "Upload files" menu item via JS DOM selector
      const uploadClicked = await webview.executeJavaScript(`
        (function() {
          var btn = document.querySelector('button[aria-label*="Upload files"]');
          if (btn) { btn.click(); return btn.getAttribute('aria-label'); }
          return null;
        })()
      `) as string | null;
      logger.info('[Gemini] Upload files clicked:', uploadClicked);

      // Wait for file input to appear
      await new Promise(r => setTimeout(r, 1000));

      // Step C: Set file on input[type=file] via CDP DOM.setFileInputFiles
      const doc = await webview.sendCDPCommand('DOM.getDocument') as { root: { nodeId: number } };
      const fileInput = await webview.sendCDPCommand('DOM.querySelector', {
        nodeId: doc.root.nodeId,
        selector: 'input[type="file"]',
      }) as { nodeId: number };

      if (!fileInput.nodeId) {
        logger.error('[Gemini] No input[type=file] found, falling back to text-only');
        hideWebview();
        return this.apiChat(webview, message);
      }

      await webview.sendCDPCommand('DOM.setFileInputFiles', {
        files: filePaths,
        nodeId: fileInput.nodeId,
      });
      logger.info('[Gemini] File set via DOM.setFileInputFiles');

      // Wait for upload to complete (monitor network for push.clients6.google.com)
      logger.info('[Gemini] Waiting for image upload...');
      await new Promise<void>(resolve => {
        let uploadSeen = false;
        const handler = (data: unknown) => {
          try {
            const msg = JSON.parse(String(data));
            if (msg.method === 'Network.responseReceived') {
              const url = (msg.params.response?.url || '') as string;
              if (url.includes('push.clients6.google.com') && url.includes('upload_id')) uploadSeen = true;
            }
            if (msg.method === 'Network.loadingFinished' && uploadSeen) {
              adapter._ws?.removeListener('message', handler);
              resolve();
            }
          } catch { /* ignore */ }
        };
        adapter._ws?.on('message', handler);
        setTimeout(() => { adapter._ws?.removeListener('message', handler); resolve(); }, 15000);
      });

      // Wait for image preview to appear (keep webview visible for typing/sending)
      await new Promise(r => setTimeout(r, 3000));
      logger.info('[Gemini] Upload done, typing message...');

      // Type message via JS DOM (webview must stay visible for Angular events)
      await webview.executeJavaScript(`
        (function() {
          var input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
          if (!input) return;
          input.focus();
          if (input.tagName === 'TEXTAREA') {
            var s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value');
            if (s && s.set) s.set.call(input, ${JSON.stringify(message)});
            else input.value = ${JSON.stringify(message)};
          } else { input.innerText = ${JSON.stringify(message)}; }
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()
      `);
      await new Promise(r => setTimeout(r, 1000));

      // Set up Network listener BEFORE clicking send to capture StreamGenerate response
      let streamResolve: (value: string) => void;
      const rawResponsePromise = new Promise<string>(resolve => { streamResolve = resolve; });
      let rid: string | null = null;
      let dataRx = false;
      const responseHandler = (data: unknown) => {
        try {
          const msg = JSON.parse(String(data));
          if (!msg.method || msg.id) return;
          if (msg.method === 'Network.responseReceived') {
            const url = (msg.params.response?.url || '') as string;
            if (url.includes('StreamGenerate')) {
              rid = msg.params.requestId as string;
              logger.info('[Gemini] StreamGenerate response detected, requestId:', rid);
            }
          }
          if (msg.method === 'Network.dataReceived' && rid && msg.params.requestId === rid) dataRx = true;
          if (msg.method === 'Network.loadingFinished' && rid && msg.params.requestId === rid) {
            adapter._ws?.removeListener('message', responseHandler);
            webview.sendCDPCommand!('Network.getResponseBody', { requestId: rid })
              .then(r => { const b = r as { body?: string; base64Encoded?: boolean }; streamResolve(b.base64Encoded ? Buffer.from(b.body || '', 'base64').toString() : (b.body || '')); })
              .catch(() => streamResolve(''));
          }
        } catch { /* ignore */ }
      };
      adapter._ws?.on('message', responseHandler);
      // Poll fallback
      let polls = 0;
      const pi = setInterval(async () => {
        polls++;
        if (!rid || !dataRx || polls < 5) return;
        try {
          const r = await webview.sendCDPCommand!('Network.getResponseBody', { requestId: rid });
          const b = r as { body?: string; base64Encoded?: boolean };
          const body = b.base64Encoded ? Buffer.from(b.body || '', 'base64').toString() : (b.body || '');
          if (body.includes('"wrb.fr"')) { clearInterval(pi); adapter._ws?.removeListener('message', responseHandler); streamResolve(body); }
        } catch { /* still streaming */ }
      }, 3000);
      const responseTimeout = setTimeout(() => { clearInterval(pi); adapter._ws?.removeListener('message', responseHandler); streamResolve(''); }, 120000);

      // NOW click send via JS DOM
      const sendResult = await webview.executeJavaScript(`
        (function() {
          var btn = document.querySelector('button[aria-label*="Send"]')
            || document.querySelector('button[aria-label*="send"]')
            || document.querySelector('button.send');
          if (btn) {
            btn.click();
            return 'clicked: ' + btn.getAttribute('aria-label');
          }
          return 'no send button found';
        })()
      `) as string;
      logger.info('[Gemini] Send button:', sendResult);

      // Hide webview after send (Angular already processed the click)
      await new Promise(r => setTimeout(r, 500));
      if (viewObj) {
        viewObj.setBounds({ x: -9999, y: -9999, width: 1280, height: 800 });
      }

      // Wait for response
      const rawResponse = await rawResponsePromise;
      clearTimeout(responseTimeout);
      clearInterval(pi);

      // Clean up
      await webview.sendCDPCommand('Network.disable').catch(() => {});
      hideWebview();

      if (!rawResponse) return '';

      // Parse batchexecute response
      return this.parseBatchResponse(rawResponse);
    } catch (err) {
      // CRITICAL: Always hide webview on error to prevent it blocking the screen
      logger.error('[Gemini] sendWithImage error:', err);
      hideWebview();
      throw err;
    }
  }

  /**
   * Capture template by using CDP Fetch.requestPaused to intercept a real
   * StreamGenerate request triggered via DOM interaction.
   * CDP Fetch pauses the request so we can read its body before continuing.
   */
  private async captureTemplate(webview: WebviewLike): Promise<CapturedTemplate | null> {
    if (!webview.sendCDPCommand) return null;
    logger.info('[Gemini] Capturing template via CDP Fetch...');

    try {
      // Enable Fetch interception for StreamGenerate
      await webview.sendCDPCommand('Fetch.enable', {
        patterns: [{ urlPattern: '*StreamGenerate*', requestStage: 'Request' }],
      });

      // Navigate to clean /app for current account
      // Preserve /u/N/ prefix if user switched to non-default account
      await webview.executeJavaScript(`
        (function() {
          const url = location.href;
          const accountMatch = url.match(/\\/u\\/(\\d+)\\//);
          const accountPrefix = accountMatch ? '/u/' + accountMatch[1] : '';
          window.location.href = 'https://gemini.google.com' + accountPrefix + '/app?hl=en';
        })()
      `);

      // Wait for input
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 300));
        const ready = await webview.executeJavaScript(
          `!!document.querySelector('textarea, [contenteditable="true"]')`
        );
        if (ready) break;
      }

      // Set up capture promise BEFORE sending
      let capturedBody: string | null = null;
      let capturedUrl: string | null = null;
      let capturedRequestId: string | null = null;

      const capturePromise = new Promise<void>((resolve) => {
        const timeout = setTimeout(() => resolve(), 15000); // 15s max wait
        webview.onCDPEvent!((method, params) => {
          if (method === 'Fetch.requestPaused') {
            const p = params as { requestId: string; request: { url: string; postData?: string } };
            if (p.request.url.includes('StreamGenerate')) {
              logger.info('[Gemini] Fetch.requestPaused: StreamGenerate intercepted!');
              capturedBody = p.request.postData || null;
              capturedUrl = p.request.url;
              capturedRequestId = p.requestId;
              clearTimeout(timeout);
              resolve();
            }
          }
        });
      });

      // Type and click send
      logger.info('[Gemini] Sending via DOM to trigger StreamGenerate...');
      const domResult = await webview.executeJavaScript(`
        (async () => {
          const input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
          if (!input) return JSON.stringify({ error: 'no input found' });
          input.focus();
          if (input.tagName === 'TEXTAREA') {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (setter) setter.call(input, 'Hello');
            else input.value = 'Hello';
          } else {
            input.innerText = 'Hello';
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 1500));
          const btn = document.querySelector('button[aria-label*="Send"]')
            || document.querySelector('button[aria-label*="send"]')
            || document.querySelector('button.send-button');
          if (!btn) return JSON.stringify({ error: 'no send button found' });
          if (btn.disabled) return JSON.stringify({ error: 'send button disabled' });
          btn.click();
          return JSON.stringify({ ok: true, label: btn.getAttribute('aria-label') });
        })()
      `) as string;
      try {
        const parsed = JSON.parse(domResult as string);
        if (parsed.error) {
          logger.warn('[Gemini] DOM interaction failed:', parsed.error);
        } else {
          logger.info('[Gemini] Clicked send button:', parsed.label);
        }
      } catch {
        logger.warn('[Gemini] DOM result:', domResult);
      }

      // Wait for interception
      await capturePromise;

      // Continue the paused request so Gemini UI doesn't break
      if (capturedRequestId) {
        await webview.sendCDPCommand('Fetch.continueRequest', { requestId: capturedRequestId }).catch(() => {});
      }

      // Disable fetch interception
      await webview.sendCDPCommand('Fetch.disable').catch(() => {});

      if (!capturedBody || !capturedUrl) {
        logger.error('[Gemini] Template capture failed: no StreamGenerate intercepted');
        return null;
      }

      // Parse — postData is URL-encoded
      const decoded = decodeURIComponent(capturedBody);
      logger.info('[Gemini] Decoded body starts:', decoded.substring(0, 30));
      logger.info('[Gemini] Decoded body length:', decoded.length);
      // Use greedy match for f.req (content can contain &)
      const freqMatch = decoded.match(/^f\.req=([\s\S]+?)&at=/);
      const atMatch = decoded.match(/&at=([^&]+)/);
      if (!freqMatch || !atMatch) {
        logger.error('[Gemini] Template parse failed: f.req=' + !!freqMatch + ' at=' + !!atMatch);
        logger.error('[Gemini] Body sample:', decoded.substring(0, 100));
        return null;
      }

      const outer = JSON.parse(freqMatch[1]);
      const inner = JSON.parse(outer[1]);
      console.log(`[Gemini] Template captured: ${inner.length} elements`);

      return { inner, atToken: atMatch[1], url: capturedUrl };
    } catch (err) {
      logger.error('[Gemini] Template capture error:', err);
      // Disable fetch interception on error
      await webview.sendCDPCommand('Fetch.disable').catch(() => {});
      return null;
    }
  }

  // NOTE: Gemini image upload requires Google's push.clients6.google.com service
  // with proprietary auth (ClientId/Feed). Cannot be replicated programmatically.
  // Image tool calls pass through to OpenClaw's configured vision model.
  // User-attached images are described as text only (path in [media attached:] format).
}
