/**
 * Grok Web Provider
 * Uses grok.com web session
 *
 * Reference: /Users/xnohat/openclaw-zero-token/src/providers/grok-web-client-browser.ts
 *
 * Grok uses NDJSON streaming. Each line is a JSON object with a `contentDelta` field.
 * If the direct API returns 403 (anti-bot), falls back to DOM simulation.
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { executeInWebview, streamFromWebview } from './base-provider';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-grok-2', name: 'Grok 2 (WebAuth)', contextWindow: 128000 },
  { id: 'webauth-grok-1', name: 'Grok 1 (WebAuth)', contextWindow: 128000 },
];

export class GrokWebProvider implements WebProvider {
  id = 'grok-web';
  name = 'Grok Web';
  loginUrl = 'https://grok.com';
  partition = 'persist:webauth-grok';
  models = MODELS;

  private lastConversationId: string | null = null;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      const hasCookie = await webview.executeJavaScript(
        `document.cookie.includes('sso') || document.cookie.includes('_ga') || document.cookie.includes('auth_token')`
      );
      return { authenticated: !!hasCookie };
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

    // 1. Get or create conversation
    const convId = await this.getOrCreateConversation(webview);

    // 2. Build request body (matches Grok's API format)
    const body = JSON.stringify({
      message: prompt,
      parentResponseId: crypto.randomUUID(),
      disableSearch: false,
      enableImageGeneration: false,
      imageAttachments: [],
      returnImageBytes: false,
      returnRawGrokInXaiRequest: false,
      fileAttachments: [],
      enableImageStreaming: false,
      imageGenerationCount: 0,
      forceConcise: false,
      toolOverrides: {},
      enableSideBySide: false,
      sendFinalMetadata: true,
      isReasoning: false,
      metadata: { request_metadata: { mode: 'auto' } },
      disableTextFollowUps: false,
      disableArtifact: false,
      isFromGrokFiles: false,
      disableMemory: false,
      forceSideBySide: false,
      modelMode: 'MODEL_MODE_AUTO',
      isAsyncChat: false,
      skipCancelCurrentInflightRequests: false,
      isRegenRequest: false,
      disableSelfHarmShortCircuit: false,
    });

    // 3. Stream from Grok API (NDJSON format)
    const { stream } = streamFromWebview(
      webview,
      `https://grok.com/rest/app-chat/conversations/${convId}/responses`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'Referer': 'https://grok.com/',
        },
        body,
      }
    );

    const completionId = `chatcmpl-${Date.now()}`;
    let buffer = '';

    try {
      for await (const chunk of stream) {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const parsed = JSON.parse(line);
            const content = parsed.contentDelta ?? parsed.textDelta ?? parsed.content ?? parsed.text ?? parsed.delta;
            if (content) {
              yield {
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: request.model,
                choices: [{
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                }],
              };
            }
          } catch {
            // Skip unparseable NDJSON lines
          }
        }
      }
    } catch (err) {
      // If 403 anti-bot, fall back to DOM simulation
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('403')) {
        yield* this.domFallback(webview, request, prompt);
        return;
      }
      throw err;
    }

    // Final chunk
    yield {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: 'stop',
      }],
    };
  }

  private async getOrCreateConversation(webview: WebviewLike): Promise<string> {
    if (this.lastConversationId) return this.lastConversationId;

    // Try to list existing conversations
    try {
      const res = await executeInWebview(
        webview,
        'https://grok.com/rest/app-chat/conversations?limit=1',
        { headers: { 'Accept': 'application/json' } }
      );
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        const convId = data?.conversations?.[0]?.conversationId;
        if (convId) {
          this.lastConversationId = convId;
          return convId;
        }
      }
    } catch {
      // Fall through to create
    }

    // Create new conversation
    const res = await executeInWebview(
      webview,
      'https://grok.com/rest/app-chat/conversations',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    );

    if (res.status === 200 || res.status === 201) {
      const data = JSON.parse(res.body);
      const convId = data?.conversationId ?? data?.id;
      if (convId) {
        this.lastConversationId = convId;
        return convId;
      }
    }

    throw new Error('Failed to create Grok conversation');
  }

  /**
   * DOM fallback when API returns 403 (anti-bot).
   * Types into the input and polls for the assistant response.
   */
  private async *domFallback(
    webview: WebviewLike,
    request: OpenAIChatRequest,
    prompt: string,
  ): AsyncGenerator<OpenAIChatChunk> {
    await webview.executeJavaScript(`
      (function() {
        const selectors = ['[contenteditable="true"]', 'textarea', 'div[role="textbox"]'];
        let el = null;
        for (const sel of selectors) {
          el = document.querySelector(sel);
          if (el && el.offsetParent !== null) break;
        }
        if (!el) return;
        el.focus();
        if (el.tagName === 'TEXTAREA') {
          el.value = ${JSON.stringify(prompt)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          el.innerText = ${JSON.stringify(prompt)};
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const btn = document.querySelector('button[aria-label*="Send"], button[type="submit"]');
        if (btn && !btn.disabled) btn.click();
        else el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      })()
    `);

    // Poll for response
    const maxWaitMs = 90000;
    const pollIntervalMs = 2000;
    let lastText = '';
    let stableCount = 0;

    for (let elapsed = 0; elapsed < maxWaitMs; elapsed += pollIntervalMs) {
      await new Promise((r) => setTimeout(r, pollIntervalMs));

      const result = await webview.executeJavaScript(`
        (function() {
          const clean = (t) => t.replace(/[\\u200B-\\u200D\\uFEFF]/g, '').trim();
          const selectors = ['[data-role="assistant"]', '[class*="assistant"]', '[class*="response"]', 'article', "[class*='markdown']", '.prose'];
          let text = '';
          for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            const last = els.length > 0 ? els[els.length - 1] : null;
            if (last) {
              const t = clean(last.textContent || '');
              if (t.length > 10) { text = t; break; }
            }
          }
          const stopBtn = document.querySelector('[aria-label*="Stop"]');
          return { text, isStreaming: !!stopBtn };
        })()
      `) as { text: string; isStreaming: boolean };

      if (result.text && result.text !== lastText) {
        lastText = result.text;
        stableCount = 0;
      } else if (result.text) {
        stableCount++;
        if (!result.isStreaming && stableCount >= 2) break;
      }
    }

    if (lastText) {
      yield {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          delta: { content: lastText },
          finish_reason: 'stop',
        }],
      };
    }
  }
}
