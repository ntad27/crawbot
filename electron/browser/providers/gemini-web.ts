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
import { consolidateMessages, parseTextToolCalls } from './shared-utils';

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
  loginUrl = 'https://gemini.google.com';
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
    const prompt = consolidateMessages(request.messages);

    const responseText = await this.apiChat(webview, prompt);

    if (!responseText) {
      throw new Error('Gemini: no response. Ensure you are logged in.');
    }

    const completionId = `chatcmpl-${Date.now()}`;

    // Check if response contains text-based tool calls
    const toolCalls = parseTextToolCalls(responseText);

    if (toolCalls.length > 0) {
      // Extract any text before/between tool calls
      let textContent = responseText;
      for (const tc of toolCalls) {
        textContent = textContent.replace(tc.raw, '');
      }
      textContent = textContent.trim();

      // Emit text content if any
      if (textContent) {
        yield {
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [{
            index: 0,
            delta: { content: textContent },
            finish_reason: null,
          }],
        };
      }

      // Emit tool calls in OpenAI format
      yield {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: toolCalls.map((tc, i) => ({
              index: i,
              id: `call_${Date.now()}_${i}`,
              type: 'function' as const,
              function: {
                name: tc.name,
                arguments: JSON.stringify(tc.params),
              },
            })),
          } as unknown as { content: string },
          finish_reason: 'tool_calls',
        }],
      } as unknown as OpenAIChatChunk;
    } else {
      // Regular text response
      yield {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          delta: { content: responseText },
          finish_reason: 'stop',
        }],
      };
    }
  }

  private cachedPageUrl: string | null = null;

  private async apiChat(webview: WebviewLike, message: string): Promise<string> {
    // Check if page URL changed (account switch or model change)
    // If so, invalidate cached template so we recapture with new settings
    try {
      const currentUrl = await webview.executeJavaScript('location.href') as string;
      if (this.cachedTemplate && this.cachedPageUrl) {
        // Detect account change: /app vs /u/2/app
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
      console.log('[Gemini] No cached template, capturing...');
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
   * Capture template by using CDP Fetch.requestPaused to intercept a real
   * StreamGenerate request triggered via DOM interaction.
   * CDP Fetch pauses the request so we can read its body before continuing.
   */
  private async captureTemplate(webview: WebviewLike): Promise<CapturedTemplate | null> {
    if (!webview.sendCDPCommand) return null;
    console.log('[Gemini] Capturing template via CDP Fetch...');

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
          window.location.href = 'https://gemini.google.com' + accountPrefix + '/app';
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
              console.log('[Gemini] Fetch.requestPaused: StreamGenerate intercepted!');
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
      console.log('[Gemini] Sending via DOM to trigger StreamGenerate...');
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
        console.error('[Gemini] Template capture failed: no StreamGenerate intercepted');
        return null;
      }

      // Parse — postData is URL-encoded
      const decoded = decodeURIComponent(capturedBody);
      console.log('[Gemini] Decoded body starts:', decoded.substring(0, 30));
      console.log('[Gemini] Decoded body length:', decoded.length);
      // Use greedy match for f.req (content can contain &)
      const freqMatch = decoded.match(/^f\.req=([\s\S]+?)&at=/);
      const atMatch = decoded.match(/&at=([^&]+)/);
      if (!freqMatch || !atMatch) {
        console.error('[Gemini] Template parse failed: f.req=' + !!freqMatch + ' at=' + !!atMatch);
        console.error('[Gemini] Body sample:', decoded.substring(0, 100));
        return null;
      }

      const outer = JSON.parse(freqMatch[1]);
      const inner = JSON.parse(outer[1]);
      console.log(`[Gemini] Template captured: ${inner.length} elements`);

      return { inner, atToken: atMatch[1], url: capturedUrl };
    } catch (err) {
      console.error('[Gemini] Template capture error:', err);
      // Disable fetch interception on error
      await webview.sendCDPCommand('Fetch.disable').catch(() => {});
      return null;
    }
  }
}
