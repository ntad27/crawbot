/**
 * DeepSeek Web Provider
 * Uses chat.deepseek.com web session
 *
 * Reference: /Users/xnohat/openclaw-zero-token/src/providers/deepseek-web-client.ts
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { executeInWebview, streamFromWebview } from './base-provider';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-deepseek-chat', name: 'DeepSeek Chat V3 (WebAuth)', contextWindow: 64000 },
  { id: 'webauth-deepseek-reasoner', name: 'DeepSeek Reasoner R1 (WebAuth)', contextWindow: 64000 },
];

export class DeepSeekWebProvider implements WebProvider {
  id = 'deepseek-web';
  name = 'DeepSeek Web';
  loginUrl = 'https://chat.deepseek.com';
  partition = 'persist:webauth-deepseek';
  models = MODELS;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      const hasCookie = await webview.executeJavaScript(
        `document.cookie.includes('ds_session_id') || document.cookie.includes('token')`
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
    // 1. Create chat session
    const sessionId = await this.createSession(webview);

    // 2. Build prompt
    const prompt = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n');

    const isReasoner = request.model.includes('reasoner');

    // 3. Stream completion
    const body = JSON.stringify({
      chat_session_id: sessionId,
      parent_message_id: null,
      prompt,
      ref_file_ids: [],
      thinking_enabled: isReasoner,
      search_enabled: false,
      preempt: false,
    });

    const { stream } = streamFromWebview(
      webview,
      'https://chat.deepseek.com/api/v0/chat/completion',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': '*/*',
          'Referer': 'https://chat.deepseek.com/',
        },
        body,
      }
    );

    const completionId = `chatcmpl-${Date.now()}`;
    let buffer = '';

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
          // DeepSeek SSE is near-OpenAI format
          if (parsed.choices?.[0]?.delta?.content) {
            yield {
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{
                index: 0,
                delta: { content: parsed.choices[0].delta.content },
                finish_reason: parsed.choices[0].finish_reason || null,
              }],
            };
          }
        } catch {
          // Skip malformed
        }
      }
    }
  }

  private async createSession(webview: WebviewLike): Promise<string> {
    const res = await executeInWebview(
      webview,
      'https://chat.deepseek.com/api/v0/chat_session/create',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    );

    if (res.status !== 200) {
      throw new Error(`Failed to create DeepSeek session: HTTP ${res.status}`);
    }

    const data = JSON.parse(res.body);
    return data.data?.biz_data?.id || data.data?.biz_data?.chat_session_id || '';
  }
}
