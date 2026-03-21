/**
 * ChatGPT Web Provider — Hybrid approach
 *
 * Request modification: In-page fetch monkey-patch (replaces placeholder with real message)
 * Response capture: CDP Network domain (captures SSE body after stream completes)
 *
 * Flow:
 * 1. Store real message in window.__crawbotMessage
 * 2. Inject fetch monkey-patch that replaces __CRAWBOT_MSG__ placeholder in request body
 * 3. Enable CDP Network.enable to capture response
 * 4. Type short placeholder into ProseMirror editor → click Send
 * 5. Fetch monkey-patch replaces placeholder with real message
 * 6. CDP Network.loadingFinished → Network.getResponseBody captures full SSE body
 * 7. Parse SSE with delta encoding v1 support
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { consolidateMessages, parseBlockquoteToolCalls, parseJsonToolCalls, transformSystemPromptForChatGPT, extractImages } from './shared-utils';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-chatgpt-gpt', name: 'GPT-4 (WebAuth)', contextWindow: 200000 },
];

const PLACEHOLDER = '__CRAWBOT_MSG__';

export class ChatGPTWebProvider implements WebProvider {
  id = 'chatgpt-web';
  name = 'ChatGPT Web';
  loginUrl = 'https://chatgpt.com';
  partition = 'persist:webauth-chatgpt';
  models = MODELS;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      const hasSession = await webview.executeJavaScript(
        `document.cookie.split(';').some(c => c.trim().startsWith('__Secure-next-auth.session-token'))`
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
    const prompt = consolidateMessages(request.messages, transformSystemPromptForChatGPT);
    const images = extractImages(request.messages);
    const responseText = await this.sendAndCapture(webview, prompt, images);

    if (!responseText) {
      throw new Error('ChatGPT: no response. Ensure you are logged in.');
    }

    const completionId = `chatcmpl-${Date.now()}`;
    // Try blockquote format first (ChatGPT copilot), then fall back to raw JSON
    let toolCalls = parseBlockquoteToolCalls(responseText);
    if (toolCalls.length === 0) toolCalls = parseJsonToolCalls(responseText);

    if (toolCalls.length > 0) {
      let textContent = responseText;
      for (const tc of toolCalls) textContent = textContent.replace(tc.raw, '');
      textContent = textContent.trim();
      if (textContent) {
        yield {
          id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
          choices: [{ index: 0, delta: { content: textContent }, finish_reason: null }]
        };
      }
      yield {
        id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
        choices: [{
          index: 0, delta: {
            tool_calls: toolCalls.map((tc, i) => ({
              index: i, id: `call_${Date.now()}_${i}`, type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.params) },
            }))
          } as unknown as { content: string }, finish_reason: 'tool_calls'
        }],
      } as unknown as OpenAIChatChunk;
    } else {
      yield {
        id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
        choices: [{ index: 0, delta: { content: responseText }, finish_reason: 'stop' }]
      };
    }
  }

  private async sendAndCapture(
    webview: WebviewLike,
    message: string,
    images: Array<{ url: string; mediaType: string }> = [],
  ): Promise<string> {
    if (!webview.sendCDPCommand) throw new Error('ChatGPT requires CDP support');

    // Navigate to clean chat if on conversation page
    const url = await webview.executeJavaScript('location.href') as string;
    if (url.includes('/c/') || !url.includes('chatgpt.com')) {
      await webview.executeJavaScript(`window.location.href = 'https://chatgpt.com/'`);
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 300));
        const ready = await webview.executeJavaScript(`!!document.querySelector('#prompt-textarea')`);
        if (ready) break;
      }
    }

    // 1. Upload images (if any) via ChatGPT's file upload endpoint
    const fileIds: string[] = [];
    if (images.length > 0) {
      console.log(`[ChatGPT] Uploading ${images.length} image(s)...`);
      for (const img of images) {
        try {
          console.log(`[ChatGPT] Uploading: ${img.url.substring(0, 80)}...`);
          const fileId = await this.uploadImage(webview, img.url, img.mediaType);
          if (fileId) {
            fileIds.push(fileId);
            console.log(`[ChatGPT] Upload OK: ${fileId}`);
          } else {
            console.error('[ChatGPT] Upload returned null');
          }
        } catch (err) {
          console.error('[ChatGPT] Image upload error:', err);
        }
      }
      console.log(`[ChatGPT] ${fileIds.length}/${images.length} images uploaded`);
    }

    // 2. Store message + image file IDs + sizes in page context
    const imageSizes = images.map(img => {
      try {
        const fs = require('node:fs');
        const p = img.url.startsWith('data:') ? '' : img.url.replace('file://', '');
        return p ? fs.statSync(p).size : 0;
      } catch { return 0; }
    });
    await webview.executeJavaScript(
      `window.__crawbotMessage = ${JSON.stringify(message)}`
    );
    await webview.executeJavaScript(
      `window.__crawbotImageFileIds = ${JSON.stringify(fileIds)};window.__crawbotImageSizes = ${JSON.stringify(imageSizes)}`
    );

    // 3. Inject fetch monkey-patch for REQUEST MODIFICATION
    await webview.executeJavaScript(`
      (function() {
        if (!window.__crawbotOriginalFetch) {
          window.__crawbotOriginalFetch = window.fetch;
        }
        var _fetch = window.__crawbotOriginalFetch;

        window.fetch = function() {
          var args = Array.prototype.slice.call(arguments);
          var urlStr = '';
          if (typeof args[0] === 'string') {
            urlStr = args[0];
          } else if (args[0] && args[0].url) {
            urlStr = args[0].url;
          }

          if (urlStr.indexOf('/f/conversation') !== -1 && urlStr.indexOf('prepare') === -1) {
            var init = args[1] || {};
            var body = typeof init.body === 'string' ? init.body : '';

            if (body.indexOf('${PLACEHOLDER}') !== -1 && window.__crawbotMessage) {
              var escaped = JSON.stringify(window.__crawbotMessage).slice(1, -1);
              body = body.replace('${PLACEHOLDER}', escaped);

              // Inject image references into the conversation body
              // Format discovered from real ChatGPT UI:
              // - prefix: sediment:// (NOT file-service://)
              // - image BEFORE text in parts array
              // - width/height must have real values
              var imageFileIds = window.__crawbotImageFileIds || [];
              if (imageFileIds.length > 0) {
                try {
                  var parsed = JSON.parse(body);
                  var msg = parsed.messages && parsed.messages[0];
                  if (msg && msg.content) {
                    msg.content.content_type = 'multimodal_text';
                    // Insert images BEFORE text (ChatGPT expects images first)
                    var textParts = msg.content.parts.slice();
                    msg.content.parts = [];
                    for (var i = 0; i < imageFileIds.length; i++) {
                      msg.content.parts.push({
                        content_type: 'image_asset_pointer',
                        asset_pointer: 'sediment://' + imageFileIds[i],
                        size_bytes: window.__crawbotImageSizes ? window.__crawbotImageSizes[i] : 0,
                        width: 1024,
                        height: 1024
                      });
                    }
                    // Then add text parts after images
                    for (var j = 0; j < textParts.length; j++) {
                      msg.content.parts.push(textParts[j]);
                    }
                    body = JSON.stringify(parsed);
                  }
                } catch(e) {}
              }

              init.body = body;
              args[1] = init;
            }
          }

          return _fetch.apply(this, args);
        };
      })()
    `);

    // 3. Disable + re-enable Network to get clean event state
    await webview.sendCDPCommand('Network.disable').catch(() => { });
    await webview.sendCDPCommand('Network.enable');

    // Use direct WebSocket listener instead of onCDPEvent (which accumulates)
    let responseResolveFn: ((body: string) => void) | null = null;
    let targetRequestId: string | null = null;
    let dataReceivedForTarget = false;

    const wsHandler = (data: unknown) => {
      try {
        const msg = JSON.parse(String(data));
        if (!msg.method || msg.id) return;
        const method = msg.method as string;
        const p = (msg.params || {}) as Record<string, unknown>;

        if (method === 'Network.responseReceived') {
          const resp = p.response as { url?: string } | undefined;
          const reqUrl = resp?.url || '';
          if (reqUrl.includes('/f/conversation') && !reqUrl.includes('prepare')) {
            targetRequestId = p.requestId as string;
            dataReceivedForTarget = false;
          }
        }

        if (method === 'Network.dataReceived' && targetRequestId && p.requestId === targetRequestId) {
          dataReceivedForTarget = true;
        }

        if (method === 'Network.loadingFinished' && targetRequestId && p.requestId === targetRequestId) {
          webview.sendCDPCommand!('Network.getResponseBody', { requestId: targetRequestId })
            .then((result) => {
              const r = result as { body?: string; base64Encoded?: boolean };
              const body = r.base64Encoded
                ? Buffer.from(r.body || '', 'base64').toString()
                : (r.body || '');
              if (responseResolveFn) { responseResolveFn(body); responseResolveFn = null; }
            })
            .catch(() => {
              if (responseResolveFn) { responseResolveFn(''); responseResolveFn = null; }
            });
        }

        if (method === 'Network.loadingFailed' && targetRequestId && p.requestId === targetRequestId) {
          if (responseResolveFn) { responseResolveFn(''); responseResolveFn = null; }
        }
      } catch { /* ignore */ }
    };

    // Access the raw WebSocket from the adapter
    const adapter = webview as unknown as { _ws?: { on: (e: string, h: unknown) => void; removeListener: (e: string, h: unknown) => void } };
    adapter._ws?.on('message', wsHandler);

    // 4. Type placeholder + click send
    await webview.executeJavaScript(`
      (async function() {
        var editor = document.querySelector('#prompt-textarea');
        if (!editor) return;
        editor.focus();
        editor.innerHTML = '<p>${PLACEHOLDER}</p>';
        editor.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(function(r) { setTimeout(r, 1000); });
        var btn = document.querySelector('button[data-testid="send-button"]');
        if (!btn) {
          var buttons = document.querySelectorAll('button');
          for (var i = 0; i < buttons.length; i++) {
            var label = buttons[i].getAttribute('aria-label') || '';
            if (label.indexOf('Send') !== -1) { btn = buttons[i]; break; }
          }
        }
        if (btn && !btn.disabled) btn.click();
      })()
    `);

    // 5. Wait for response — primary: loadingFinished, fallback: poll getResponseBody
    const rawResponse = await new Promise<string>((resolve) => {
      responseResolveFn = resolve;

      // Fallback: if loadingFinished never fires (SSE stream stays open),
      // poll getResponseBody every 3s after data starts arriving.
      // SSE response body accumulates even before stream closes.
      let pollCount = 0;
      const pollInterval = setInterval(async () => {
        pollCount++;
        if (!targetRequestId || !dataReceivedForTarget) return;
        // Start polling after 10s of data received
        if (pollCount < 4) return;
        try {
          const result = await webview.sendCDPCommand!('Network.getResponseBody', { requestId: targetRequestId });
          const r = result as { body?: string; base64Encoded?: boolean };
          const body = r.base64Encoded
            ? Buffer.from(r.body || '', 'base64').toString()
            : (r.body || '');
          // Check if response contains [DONE] marker (SSE complete)
          if (body.includes('[DONE]') || body.includes('"is_completion":true')) {
            clearInterval(pollInterval);
            if (responseResolveFn) { responseResolveFn(body); responseResolveFn = null; }
          }
        } catch { /* request still streaming, getResponseBody may fail */ }
      }, 3000);

      // Hard timeout
      setTimeout(() => {
        clearInterval(pollInterval);
        if (responseResolveFn) { responseResolveFn(''); responseResolveFn = null; }
      }, 120000);
    });

    // 6. Disable Network + clean up listener (prevent accumulation)
    adapter._ws?.removeListener('message', wsHandler);
    await webview.sendCDPCommand('Network.disable').catch(() => { });
    await webview.executeJavaScript('window.__crawbotMessage = null').catch(() => { });

    if (!rawResponse) return '';

    // 7. Parse SSE — delta encoding v1 + old cumulative fallback
    let useDeltaEncoding = false;
    let answer = '';
    let currentMessageRole = '';
    let currentContentType = '';

    for (const line of rawResponse.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') continue;
      if (data === '"v1"') {
        useDeltaEncoding = true;
        continue;
      }

      try {
        const parsed = JSON.parse(data);

        if (useDeltaEncoding) {
          if (parsed.v && parsed.v.message) {
            const msg = parsed.v.message;
            currentMessageRole = msg.author?.role || '';
            currentContentType = msg.content?.content_type || '';
            if (currentMessageRole === 'assistant' && currentContentType === 'text') {
              // ACCUMULATE — don't reset. ChatGPT sends multiple assistant text
              // messages: first with tool call JSON, then with greeting text.
              // Always add \n separator so last tool call JSON doesn't merge with greeting.
              const parts = msg.content?.parts;
              const initial = Array.isArray(parts) && parts[0] ? String(parts[0]) : '';
              if (answer) answer += '\n';
              if (initial) answer += initial;
            }
          } else if (parsed.v && Array.isArray(parsed.v)) {
            if (currentMessageRole === 'assistant' && currentContentType === 'text') {
              for (const patch of parsed.v) {
                if (patch.o === 'append' && patch.p === '/message/content/parts/0') {
                  answer += patch.v;
                }
              }
            }
          }
        } else {
          if (parsed.message?.content?.parts?.[0] && parsed.message.role === 'assistant') {
            answer = parsed.message.content.parts[0];
          }
        }
      } catch { }
    }

    return answer;
  }

  /**
   * Upload an image to ChatGPT's file service (3-step flow).
   * 1. POST /backend-api/files (JSON) → file_id + upload_url
   * 2. PUT upload_url (XHR blob) → 201
   * 3. POST /backend-api/files/{id}/uploaded → confirmed
   * Returns the file_id for use in image_asset_pointer.
   */
  private async uploadImage(
    webview: WebviewLike,
    imageUrl: string,
    _mediaType: string,
  ): Promise<string | null> {
    // Extract base64 data from data URI or file path
    let base64Data = '';
    let fileSize = 0;
    if (imageUrl.startsWith('data:')) {
      const commaIdx = imageUrl.indexOf(',');
      if (commaIdx > 0) {
        base64Data = imageUrl.substring(commaIdx + 1);
        fileSize = Math.floor(base64Data.length * 3 / 4);
      }
    } else {
      const fs = await import('node:fs');
      const path = imageUrl.replace('file://', '');
      if (fs.existsSync(path)) {
        const buf = fs.readFileSync(path);
        base64Data = buf.toString('base64');
        fileSize = buf.length;
      }
    }
    if (!base64Data) return null;

    // Get access token (needed for file endpoints)
    if (!this.accessToken) await this.fetchAccessToken(webview);
    const token = this.accessToken || '';

    // Step 1: Create upload
    const step1Str = await webview.executeJavaScript(`
      (async function() {
        try {
          var res = await fetch('https://chatgpt.com/backend-api/files', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ${JSON.stringify(token)} },
            body: JSON.stringify({ file_name: 'image.jpg', file_size: ${fileSize}, use_case: 'multimodal' }),
          });
          if (!res.ok) return JSON.stringify({ error: 'HTTP ' + res.status });
          return JSON.stringify(await res.json());
        } catch(e) { return JSON.stringify({ error: e.message }); }
      })()
    `) as string;

    const step1 = JSON.parse(step1Str);
    if (!step1.file_id || !step1.upload_url) {
      console.error('[ChatGPT] Image create failed:', step1.error || 'no file_id');
      return null;
    }

    // Step 2: Upload blob via XHR (fetch fails due to CORS on Azure Blob Storage)
    const step2Str = await webview.executeJavaScript(`
      (async function() {
        return new Promise(function(resolve) {
          try {
            var b64 = ${JSON.stringify(base64Data)};
            var bin = atob(b64);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            var blob = new Blob([bytes], { type: 'image/jpeg' });
            var xhr = new XMLHttpRequest();
            xhr.open('PUT', ${JSON.stringify(step1.upload_url)}, true);
            xhr.setRequestHeader('Content-Type', 'image/jpeg');
            xhr.setRequestHeader('x-ms-blob-type', 'BlockBlob');
            xhr.onload = function() { resolve(JSON.stringify({ status: xhr.status })); };
            xhr.onerror = function() { resolve(JSON.stringify({ error: 'XHR failed' })); };
            xhr.send(blob);
          } catch(e) { resolve(JSON.stringify({ error: e.message })); }
        });
      })()
    `) as string;

    const step2 = JSON.parse(step2Str);
    if (step2.status !== 201 && step2.status !== 200) {
      console.error('[ChatGPT] Image upload failed:', step2);
      return null;
    }

    // Step 3: Confirm upload
    await webview.executeJavaScript(`
      fetch('https://chatgpt.com/backend-api/files/${step1.file_id}/uploaded', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + ${JSON.stringify(token)} },
        body: '{}',
      }).catch(function() {})
    `);

    console.log('[ChatGPT] Image uploaded:', step1.file_id);
    return step1.file_id;
  }

  private accessToken: string | null = null;

  private async fetchAccessToken(webview: WebviewLike): Promise<void> {
    try {
      const resultStr = await webview.executeJavaScript(`
        (async function() {
          try {
            var res = await fetch('https://chatgpt.com/api/auth/session', { credentials: 'include' });
            if (!res.ok) return JSON.stringify({});
            var data = await res.json();
            return JSON.stringify({ accessToken: data.accessToken || '' });
          } catch(e) { return JSON.stringify({}); }
        })()
      `) as string;
      const parsed = JSON.parse(resultStr);
      if (parsed.accessToken) this.accessToken = parsed.accessToken;
    } catch { /* retry next time */ }
  }
}
