/**
 * ChatGPT Web Provider
 * Uses chatgpt.com web session
 *
 * Reference: /Users/xnohat/openclaw-zero-token/src/providers/chatgpt-web-client-browser.ts
 *
 * NOTE: ChatGPT has anti-bot sentinel/turnstile tokens.
 * This implementation attempts basic auth; if 403, user must re-login.
 * Full sentinel token support requires loading CDN scripts inside the webview.
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { executeInWebview, streamFromWebview } from './base-provider';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-chatgpt-gpt-4o', name: 'GPT-4o (WebAuth)', contextWindow: 128000 },
  { id: 'webauth-chatgpt-gpt-4o-mini', name: 'GPT-4o Mini (WebAuth)', contextWindow: 128000 },
  { id: 'webauth-chatgpt-gpt-4', name: 'GPT-4 (WebAuth)', contextWindow: 8192 },
];

const MODEL_MAP: Record<string, string> = {
  'webauth-chatgpt-gpt-4o': 'gpt-4o',
  'webauth-chatgpt-gpt-4o-mini': 'gpt-4o-mini',
  'webauth-chatgpt-gpt-4': 'gpt-4',
};

export class ChatGPTWebProvider implements WebProvider {
  id = 'chatgpt-web';
  name = 'ChatGPT Web';
  loginUrl = 'https://chatgpt.com';
  partition = 'persist:webauth-chatgpt';
  models = MODELS;

  private accessToken: string | null = null;
  private deviceId: string | null = null;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      const hasCookie = await webview.executeJavaScript(
        `document.cookie.split(';').some(c => c.trim().startsWith('__Secure-next-auth.session-token'))`
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
    // 1. Get access token
    if (!this.accessToken) {
      await this.fetchAccessToken(webview);
    }

    // 2. Build request
    const chatgptModel = MODEL_MAP[request.model] || 'gpt-4o';
    const messageId = crypto.randomUUID();
    const parentId = crypto.randomUUID();

    const body = JSON.stringify({
      action: 'next',
      messages: [{
        id: messageId,
        author: { role: 'user' },
        content: {
          content_type: 'text',
          parts: [request.messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n\n')],
        },
      }],
      parent_message_id: parentId,
      model: chatgptModel,
      timezone_offset_min: new Date().getTimezoneOffset(),
      history_and_training_disabled: false,
      conversation_mode: { kind: 'primary_assistant', plugin_ids: null },
      force_paragen: false,
      force_paragen_model_slug: '',
      force_rate_limit: false,
      reset_rate_limits: false,
      force_use_sse: true,
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'oai-language': 'en-US',
      'Referer': 'https://chatgpt.com/',
    };
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    if (this.deviceId) {
      headers['oai-device-id'] = this.deviceId;
    }

    // 3. Stream
    const { stream } = streamFromWebview(
      webview,
      'https://chatgpt.com/backend-api/conversation',
      { method: 'POST', headers, body }
    );

    const completionId = `chatcmpl-${Date.now()}`;
    let buffer = '';
    let lastContent = '';

    for await (const chunk of stream) {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const msg = parsed.message;
          if (msg?.content?.parts?.[0] && typeof msg.content.parts[0] === 'string') {
            const fullContent = msg.content.parts[0];
            // ChatGPT sends cumulative content, we need the delta
            const delta = fullContent.slice(lastContent.length);
            lastContent = fullContent;

            if (delta) {
              yield {
                id: completionId,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: request.model,
                choices: [{
                  index: 0,
                  delta: { content: delta },
                  finish_reason: msg.status === 'finished_successfully' ? 'stop' : null,
                }],
              };
            }
          }
        } catch {
          // Skip malformed
        }
      }
    }
  }

  private async fetchAccessToken(webview: WebviewLike): Promise<void> {
    try {
      const res = await executeInWebview(
        webview,
        'https://chatgpt.com/api/auth/session',
        { headers: { 'Accept': 'application/json' } }
      );
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        this.accessToken = data.accessToken || null;
        this.deviceId = data.oaiDeviceId || crypto.randomUUID();
      }
    } catch {
      // Will try without access token
    }
  }
}
