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
    // Consolidate ALL messages (system, user, assistant, tool) into a single prompt.
    // Gemini web chat only accepts a single text input, so we must flatten the
    // entire conversation context into one message.
    const prompt = consolidateMessages(request.messages, transformSystemPromptForGemini);

    // Only extract images from the LAST user message (not entire conversation).
    // Previous messages may reference old images that shouldn't be re-uploaded.
    const lastUserMsg = [...request.messages].reverse().find(m => m.role === 'user');
    const images = lastUserMsg ? extractImages([lastUserMsg]) : [];

    let responseText: string;
    if (images.length > 0) {
      // Two-step image flow:
      // 1. Upload image to Gemini webchat → get detailed description
      // 2. Append description as context, then call apiChat with full prompt
      logger.info('[Gemini] Image detected, step 1: getting image description...');
      const imageDescription = await this.sendWithImage(webview, 'describe this image in detail', images);

      if (imageDescription) {
        // Step 2: Build prompt with image description appended as tool result
        const imageContext = `\n\n<image_description>\nThe user attached an image. Here is a detailed description of the image:\n${imageDescription}\n</image_description>`;
        const promptWithImage = prompt + imageContext;
        logger.info('[Gemini] Step 2: calling apiChat with image context...');
        responseText = await this.apiChat(webview, promptWithImage);
      } else {
        responseText = '';
      }
    } else {
      responseText = await this.apiChat(webview, prompt);
    }

    if (!responseText) {
      throw new Error('Gemini: no response. Ensure you are logged in.');
    }

    const completionId = `chatcmpl-${Date.now()}`;

    // Check if response contains text-based tool calls
    const toolCalls = parseTextToolCalls(responseText);

    // Intercept `image` tool calls — use Gemini's two-step vision flow.
    // Upload image → Gemini analyzes → feed analysis back → Gemini continues.
    const imageCalls = toolCalls.filter((tc) => tc.name === 'image');
    const otherCalls = toolCalls.filter((tc) => tc.name !== 'image');
    // Convert image tool calls to read tool calls so OpenClaw UI shows the widget
    for (const ic of imageCalls) {
      const imgPath = (ic.params.path || ic.params.image || '') as string;
      if (imgPath) {
        otherCalls.push({ name: 'read', params: { path: imgPath }, raw: ic.raw });
      }
    }

    if (imageCalls.length > 0) {
      // Step 1: Get image analysis via Gemini two-step vision flow
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

      // Step 2: Feed analysis back to Gemini as context → let it continue responding
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
              yield { id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
                choices: [{ index: 0, delta: { content: textContent }, finish_reason: null }] };
            }
          } else {
            yield { id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
              choices: [{ index: 0, delta: { content: finalResponse }, finish_reason: otherCalls.length > 0 ? null : 'stop' }] };
          }
        }
      }
    }

    if (otherCalls.length > 0) {
      let textContent = responseText;
      for (const tc of toolCalls) textContent = textContent.replace(tc.raw, '');
      textContent = textContent.trim();
      // Only emit text if no image analysis was already emitted
      if (textContent && imageCalls.length === 0) {
        yield { id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
          choices: [{ index: 0, delta: { content: textContent }, finish_reason: null }] };
      }
      yield { id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
        choices: [{ index: 0, delta: {
          tool_calls: otherCalls.map((tc, i) => ({
            index: i, id: `call_${Date.now()}_${i}`, type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.params) },
          }))
        } as unknown as { content: string }, finish_reason: 'tool_calls' }],
      } as unknown as OpenAIChatChunk;
    } else if (imageCalls.length === 0) {
      yield { id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
        choices: [{ index: 0, delta: { content: responseText }, finish_reason: 'stop' }] };
    }
  }

  private cachedPageUrl: string | null = null;

  private async apiChat(webview: WebviewLike, message: string): Promise<string> {
    // Navigate to clean /app to ensure each message starts a new conversation
    // (staying on /app/UUID makes Gemini append to existing thread)
    try {
      const currentUrl = await webview.executeJavaScript('location.href') as string;
      if (currentUrl.includes('/app/')) {
        // On a conversation page — navigate back to clean /app
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

    if (!this.cachedTemplate) {
      logger.info('[Gemini] No cached template, capturing...');
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
          let answer = '';
          for (const line of text.split('\\n')) {
            try {
              const p = JSON.parse(line);
              if (Array.isArray(p)) {
                for (const item of p) {
                  if (Array.isArray(item) && item[0] === 'wrb.fr') {
                    const data = JSON.parse(item[2]);
                    // Response text is at data[4][0][1] = ["full text"]
                    if (data?.[4]?.[0]?.[1]) {
                      const parts = data[4][0][1];
                      const t = Array.isArray(parts) ? parts.filter(x => typeof x === 'string').join('') : String(parts);
                      if (t.length > answer.length) answer = t;
                    }
                  }
                }
              }
            } catch {}
          }
          return JSON.stringify({ status: res.status, answer });
        } catch(e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `) as string;

    const parsed = JSON.parse(resultStr);
    if (parsed.error) {
      if (parsed.error.includes('400') || parsed.error.includes('401')) {
        this.cachedTemplate = null;
        return this.apiChat(webview, message);
      }
      throw new Error(`Gemini API: ${parsed.error}`);
    }
    return parsed.answer || '';
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
      let answer = '';
      for (const line of rawResponse.split('\n')) {
        try {
          const p = JSON.parse(line);
          if (Array.isArray(p)) {
            for (const item of p) {
              if (Array.isArray(item) && item[0] === 'wrb.fr') {
                const data = JSON.parse(item[2]);
                if (data?.[4]?.[0]?.[1]) {
                  const parts = data[4][0][1];
                  const t = Array.isArray(parts) ? parts.filter((x: unknown) => typeof x === 'string').join('') : String(parts);
                  if (t.length > answer.length) answer = t;
                }
              }
            }
          }
        } catch { /* skip */ }
      }
      return answer;
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
      await webview.executeJavaScript(`
        (async () => {
          const input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
          if (!input) return;
          input.focus();
          if (input.tagName === 'TEXTAREA') {
            const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
            if (setter) setter.call(input, 'Hello');
            else input.value = 'Hello';
          } else {
            input.innerText = 'Hello';
          }
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(r => setTimeout(r, 1000));
          const btn = document.querySelector('button[aria-label="Send message"]');
          if (btn && !btn.disabled) btn.click();
        })()
      `);

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
