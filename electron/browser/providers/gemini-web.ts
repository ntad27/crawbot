/**
 * Gemini Web Provider
 * Uses gemini.google.com web session (DOM-based interaction)
 *
 * Reference: /Users/xnohat/openclaw-zero-token/src/providers/gemini-web-client-browser.ts
 *
 * NOTE: Gemini uses complex Batchexecute/RPC format internally. This implementation
 * uses a DOM-polling approach via the webview: it types the message into the input,
 * clicks send, and polls for the assistant response text.
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-gemini-pro', name: 'Gemini Pro (WebAuth)', contextWindow: 1000000 },
  { id: 'webauth-gemini-flash', name: 'Gemini Flash (WebAuth)', contextWindow: 1000000 },
];

/** Extract plain text from OpenAI message content (string or array) */
function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => typeof p === 'object' && p !== null && p.type === 'text')
      .map((p) => p.text || '')
      .join('\n');
  }
  return String(content);
}

export class GeminiWebProvider implements WebProvider {
  id = 'gemini-web';
  name = 'Gemini Web';
  loginUrl = 'https://gemini.google.com';
  partition = 'persist:webauth-gemini';
  models = MODELS;

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
    const prompt = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => extractText(m.content))
      .join('\n\n');

    // Ensure on clean /app page
    const currentUrl = await webview.executeJavaScript('location.href') as string;
    if (!currentUrl.includes('gemini.google.com/app') || currentUrl.includes('/app/')) {
      await webview.executeJavaScript(`window.location.href = 'https://gemini.google.com/app'`);
    }

    // Wait for textarea
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const hasInput = await webview.executeJavaScript(
        `!!document.querySelector('textarea, [contenteditable="true"], div[role="textbox"]')`
      );
      if (hasInput) break;
    }

    const responseText = await this.domSimulateChat(webview, prompt);

    if (!responseText) {
      throw new Error('Gemini: no response detected. Ensure you are logged in at gemini.google.com.');
    }

    // Clean up Gemini DOM artifacts from response
    let cleaned = responseText;
    // Remove "Gemini said" prefix (from model-response container)
    cleaned = cleaned.replace(/^\s*Gemini said\s*/i, '');
    // Remove "You stopped this response" suffix
    cleaned = cleaned.replace(/\s*You stopped this response\s*$/i, '');
    cleaned = cleaned.trim();

    const completionId = `chatcmpl-${Date.now()}`;
    yield {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        delta: { content: cleaned },
        finish_reason: 'stop',
      }],
    };
  }

  private async domSimulateChat(webview: WebviewLike, message: string): Promise<string> {
    // Step 1: Type message and click send
    const sendResult = await webview.executeJavaScript(`
      (async function() {
        const inputSelectors = [
          'textarea',
          '[contenteditable="true"]',
          'div[role="textbox"]',
          '[placeholder*="Gemini"]',
          '[aria-label*="message"]',
          '[aria-label*="prompt"]',
        ];
        let inputEl = null;
        for (const sel of inputSelectors) {
          const el = document.querySelector(sel);
          if (el && el.offsetParent !== null) {
            inputEl = el;
            break;
          }
        }
        if (!inputEl) return { ok: false, error: 'No input found' };

        inputEl.focus();

        // Use native setter for Angular/React change detection
        const msg = ${JSON.stringify(message)};
        if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
          const setter = Object.getOwnPropertyDescriptor(
            window.HTMLTextAreaElement.prototype, 'value'
          )?.set || Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value'
          )?.set;
          if (setter) setter.call(inputEl, msg);
          else inputEl.value = msg;
        } else {
          inputEl.innerText = msg;
        }
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));

        // Wait for framework to process
        await new Promise(r => setTimeout(r, 500));

        // Find send button — Gemini uses mat-icon.send-icon or arrow icon
        const sendSelectors = [
          'mat-icon.send-icon',
          '.send-icon',
          'button[aria-label*="Send"]',
          'button[aria-label*="send"]',
          'button[data-testid*="send"]',
          'button[type="submit"]',
        ];
        const container = inputEl.closest('.initial-input-area-container, .initial-input-area, .input-area-container') || document;
        let sendEl = null;
        for (const sel of sendSelectors) {
          const el = container.querySelector(sel) || document.querySelector(sel);
          if (el) { sendEl = el; break; }
        }
        if (sendEl) {
          sendEl.click();
          return { ok: true, method: 'click', tag: sendEl.tagName };
        }

        // Fallback: Enter key
        inputEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        inputEl.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        inputEl.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
        return { ok: true, method: 'enter' };
      })()
    `);

    if (!(sendResult as { ok: boolean }).ok) {
      throw new Error(`Gemini DOM send failed: ${(sendResult as { error?: string }).error}`);
    }

    // Step 2: Poll for response text
    const maxWaitMs = 120000;
    const pollIntervalMs = 2000;
    let lastText = '';
    let stableCount = 0;

    for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      const result = await webview.executeJavaScript(`
        (function() {
          const clean = (t) => t.replace(/[\\u200B-\\u200D\\uFEFF]/g, '').trim();
          const modelSelectors = [
            'message-content',
            'model-response',
            '.model-response-text',
            '[data-message-author="model"]',
            '[data-sender="model"]',
            '[class*="model-turn"]',
            '[class*="modelResponse"]',
            '[class*="response-content"]',
            "[class*='markdown']",
            'article',
          ];

          let text = '';
          for (const sel of modelSelectors) {
            const els = document.querySelectorAll(sel);
            for (let i = els.length - 1; i >= 0; i--) {
              const t = clean(els[i].textContent || '');
              if (t.length >= 5) {
                text = t;
                break;
              }
            }
            if (text) break;
          }

          const stopBtn = document.querySelector('[aria-label*="Stop"], [aria-label*="stop"]');
          return { text, isStreaming: !!stopBtn };
        })()
      `) as { text: string; isStreaming: boolean };

      if (result.text && result.text.length >= 5) {
        if (result.text !== lastText) {
          lastText = result.text;
          stableCount = 0;
        } else {
          stableCount++;
          // Break when stable 3+ polls (6s) OR streaming stopped
          if (stableCount >= 3 || (!result.isStreaming && stableCount >= 2)) {
            break;
          }
        }
      }
    }

    return lastText;
  }
}
