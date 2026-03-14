/**
 * Qwen International Web Provider
 * Uses chat.qwen.ai web session
 *
 * Reference: /Users/xnohat/openclaw-zero-token/src/providers/qwen-web-client-browser.ts
 *
 * Flow:
 * 1. POST /api/v2/chats/new -> chat_id
 * 2. POST /api/v2/chat/completions?chat_id={id} -> SSE stream
 * SSE data lines contain JSON with choices[].delta.content (incremental output).
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { executeInWebview, streamFromWebview } from './base-provider';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-qwen-35-plus', name: 'Qwen 3.5 Plus (WebAuth)', contextWindow: 128000 },
  { id: 'webauth-qwen-35-turbo', name: 'Qwen 3.5 Turbo (WebAuth)', contextWindow: 32768 },
];

const MODEL_MAP: Record<string, string> = {
  'webauth-qwen-35-plus': 'qwen3.5-plus',
  'webauth-qwen-35-turbo': 'qwen3.5-turbo',
};

export class QwenIntlWebProvider implements WebProvider {
  id = 'qwen-intl-web';
  name = 'Qwen International Web';
  loginUrl = 'https://chat.qwen.ai';
  partition = 'persist:webauth-qwen-intl';
  models = MODELS;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      const hasCookie = await webview.executeJavaScript(
        `document.cookie.split(';').some(c => {
          const t = c.trim();
          return t.startsWith('session') || t.startsWith('token') || t.startsWith('auth');
        })`
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
    const qwenModel = MODEL_MAP[request.model] || 'qwen3.5-plus';

    // 1. Create chat session
    const chatId = await this.createChat(webview);

    // 2. Build prompt
    const prompt = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n');

    const fid = crypto.randomUUID();

    // 3. Stream completion
    const body = JSON.stringify({
      stream: true,
      version: '2.1',
      incremental_output: true,
      chat_id: chatId,
      chat_mode: 'normal',
      model: qwenModel,
      parent_id: null,
      messages: [
        {
          fid,
          parentId: null,
          childrenIds: [],
          role: 'user',
          content: prompt,
          user_action: 'chat',
          files: [],
          timestamp: Math.floor(Date.now() / 1000),
          models: [qwenModel],
          chat_type: 't2t',
          feature_config: { thinking_enabled: true, output_schema: 'phase' },
        },
      ],
    });

    const { stream } = streamFromWebview(
      webview,
      `https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
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
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          // Qwen SSE uses OpenAI-compatible format with choices[].delta.content
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield {
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{
                index: 0,
                delta: { content },
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

  private async createChat(webview: WebviewLike): Promise<string> {
    const res = await executeInWebview(
      webview,
      'https://chat.qwen.ai/api/v2/chats/new',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }
    );

    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`Failed to create Qwen chat: HTTP ${res.status}`);
    }

    const data = JSON.parse(res.body);
    const chatId = data.data?.id ?? data.chat_id ?? data.id ?? data.chatId;
    if (!chatId) {
      throw new Error('Failed to create Qwen chat: no chat_id in response');
    }
    return chatId;
  }
}
