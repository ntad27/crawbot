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
import { executeInWebview } from './base-provider';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-gemini-pro', name: 'Gemini Pro (WebAuth)', contextWindow: 1000000 },
  { id: 'webauth-gemini-flash', name: 'Gemini Flash (WebAuth)', contextWindow: 1000000 },
];

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
      .map((m) => m.content)
      .join('\n\n');

    // Navigate to Gemini app if needed, then use DOM simulation
    // to type the message and poll for the response.
    await executeInWebview(webview, 'https://gemini.google.com/app', {
      method: 'GET',
    }).catch(() => null);

    // Use DOM simulation: type into input, click send, poll for response
    const responseText = await this.domSimulateChat(webview, prompt);

    if (!responseText) {
      throw new Error('Gemini: no response detected. Ensure you are logged in at gemini.google.com.');
    }

    const completionId = `chatcmpl-${Date.now()}`;
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

  /**
   * DOM simulation: type message into Gemini's input, click send, poll for response.
   * This approach avoids the complexity of Gemini's Batchexecute RPC format.
   */
  private async domSimulateChat(webview: WebviewLike, message: string): Promise<string> {
    // Step 1: Type message and click send
    const sendResult = await webview.executeJavaScript(`
      (function() {
        const inputSelectors = [
          '[placeholder*="Gemini"]',
          '[contenteditable="true"]',
          'div[role="textbox"]',
          'textarea',
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
        if (inputEl.tagName === 'TEXTAREA' || inputEl.tagName === 'INPUT') {
          inputEl.value = ${JSON.stringify(message)};
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          inputEl.innerText = ${JSON.stringify(message)};
          inputEl.dispatchEvent(new Event('input', { bubbles: true }));
          inputEl.dispatchEvent(new Event('change', { bubbles: true }));
        }

        const sendSelectors = [
          'button[aria-label*="Send"]',
          'button[aria-label*="send"]',
          'button[type="submit"]',
          'button[data-testid*="send"]',
          'form button[type=submit]',
        ];
        let sendBtn = null;
        for (const sel of sendSelectors) {
          sendBtn = document.querySelector(sel);
          if (sendBtn && !sendBtn.disabled) break;
        }
        if (sendBtn) {
          sendBtn.click();
          return { ok: true };
        }

        inputEl.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
        return { ok: true };
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
            '[data-message-author="model"]',
            '[data-sender="model"]',
            '[class*="model-turn"]',
            '[class*="modelResponse"]',
            '[class*="assistant-message"]',
            '[class*="response-content"]',
            'article',
            "[class*='markdown']",
          ];

          const main = document.querySelector('main') || document.querySelector('[role="main"]') || document.body;
          let text = '';
          for (const sel of modelSelectors) {
            const els = main.querySelectorAll(sel);
            for (let i = els.length - 1; i >= 0; i--) {
              const t = clean(els[i].textContent || '');
              if (t.length >= 30) {
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

      if (result.text && result.text.length >= 30) {
        if (result.text !== lastText) {
          lastText = result.text;
          stableCount = 0;
        } else {
          stableCount++;
          if (!result.isStreaming && stableCount >= 2) {
            break;
          }
        }
      }
    }

    return lastText;
  }
}
