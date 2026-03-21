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
import { consolidateMessages, parseBlockquoteToolCalls, parseJsonToolCalls, transformSystemPromptForChatGPT } from './shared-utils';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-chatgpt-gpt-4o', name: 'GPT-4o (WebAuth)', contextWindow: 128000 },
  { id: 'webauth-chatgpt-gpt-4o-mini', name: 'GPT-4o Mini (WebAuth)', contextWindow: 128000 },
  { id: 'webauth-chatgpt-gpt-4', name: 'GPT-4 (WebAuth)', contextWindow: 8192 },
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
    const responseText = await this.sendAndCapture(webview, prompt);

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
        yield { id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
          choices: [{ index: 0, delta: { content: textContent }, finish_reason: null }] };
      }
      yield { id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
        choices: [{ index: 0, delta: { tool_calls: toolCalls.map((tc, i) => ({
          index: i, id: `call_${Date.now()}_${i}`, type: 'function' as const,
          function: { name: tc.name, arguments: JSON.stringify(tc.params) },
        })) } as unknown as { content: string }, finish_reason: 'tool_calls' }],
      } as unknown as OpenAIChatChunk;
    } else {
      yield { id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: request.model,
        choices: [{ index: 0, delta: { content: responseText }, finish_reason: 'stop' }] };
    }
  }

  private async sendAndCapture(webview: WebviewLike, message: string): Promise<string> {
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

    // 1. Store message in page context (safe — no string escaping issues)
    await webview.executeJavaScript(
      `window.__crawbotMessage = ${JSON.stringify(message)}`
    );

    // 2. Inject fetch monkey-patch for REQUEST MODIFICATION ONLY
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
              init.body = body;
              args[1] = init;
              console.log('[ChatGPT-CrawBot] Placeholder replaced, body: ' + body.length + ' bytes');
            }
          }

          return _fetch.apply(this, args);
        };
      })()
    `);

    // 3. Enable CDP Network domain to capture response
    await webview.sendCDPCommand('Network.enable');

    let responseResolveFn: ((body: string) => void) | null = null;
    let targetRequestId: string | null = null;

    webview.onCDPEvent!((method, params) => {
      const p = params as Record<string, unknown>;

      if (method === 'Network.responseReceived') {
        const resp = p.response as { url?: string } | undefined;
        const reqUrl = resp?.url || '';
        if (reqUrl.includes('/f/conversation') && !reqUrl.includes('prepare')) {
          targetRequestId = p.requestId as string;
        }
      }

      if (method === 'Network.loadingFinished' && targetRequestId && p.requestId === targetRequestId) {
        webview.sendCDPCommand!('Network.getResponseBody', { requestId: targetRequestId })
          .then((result) => {
            const r = result as { body?: string; base64Encoded?: boolean };
            const body = r.base64Encoded
              ? Buffer.from(r.body || '', 'base64').toString()
              : (r.body || '');
            responseResolveFn?.(body);
          })
          .catch(() => {
            responseResolveFn?.('');
          });
      }

      if (method === 'Network.loadingFailed' && targetRequestId && p.requestId === targetRequestId) {
        responseResolveFn?.('');
      }
    });

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

    // 5. Wait for response (max 120s)
    const rawResponse = await new Promise<string>((resolve) => {
      responseResolveFn = resolve;
      setTimeout(() => resolve(''), 120000);
    });

    // 6. Disable Network + clean up
    await webview.sendCDPCommand('Network.disable').catch(() => {});
    await webview.executeJavaScript('window.__crawbotMessage = null').catch(() => {});

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
              const parts = msg.content?.parts;
              answer = Array.isArray(parts) && parts[0] ? String(parts[0]) : '';
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
      } catch {}
    }

    return answer;
  }
}
