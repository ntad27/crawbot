/**
 * Qwen International Web Provider
 * Uses chat.qwen.ai web session via direct executeJavaScript.
 *
 * Flow:
 * 1. POST /api/v2/chats/new -> chat_id
 * 2. POST /api/v2/chat/completions?chat_id={id} -> SSE stream
 *
 * SSE format: near-OpenAI compatible — choices[].delta.content (incremental)
 * Response is buffered in-page, parsed, and returned as a JSON string.
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { consolidateMessages, parseTextToolCalls } from './shared-utils';

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

    // 2. Consolidate all messages into a single prompt
    const prompt = consolidateMessages(request.messages);

    // 3. Send completion request (buffered in-page)
    const responseText = await this.apiChat(webview, chatId, prompt, qwenModel);

    if (!responseText) {
      throw new Error('Qwen: no response. Ensure you are logged in.');
    }

    const completionId = `chatcmpl-${Date.now()}`;

    // 4. Check for text-based tool calls
    const toolCalls = parseTextToolCalls(responseText);

    if (toolCalls.length > 0) {
      let textContent = responseText;
      for (const tc of toolCalls) {
        textContent = textContent.replace(tc.raw, '');
      }
      textContent = textContent.trim();

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

  private async createChat(webview: WebviewLike): Promise<string> {
    const resultStr = await webview.executeJavaScript(`
      (async () => {
        try {
          const res = await fetch('https://chat.qwen.ai/api/v2/chats/new', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          if (!res.ok) return JSON.stringify({ error: 'HTTP ' + res.status });
          const body = await res.text();
          return JSON.stringify({ status: res.status, body });
        } catch(e) {
          return JSON.stringify({ error: e.message });
        }
      })()
    `) as string;

    const parsed = JSON.parse(resultStr);
    if (parsed.error) {
      throw new Error(`Failed to create Qwen chat: ${parsed.error}`);
    }

    const data = JSON.parse(parsed.body);
    const chatId = data.data?.id ?? data.chat_id ?? data.id ?? data.chatId;
    if (!chatId) {
      throw new Error('Failed to create Qwen chat: no chat_id in response');
    }
    return chatId;
  }

  private async apiChat(
    webview: WebviewLike,
    chatId: string,
    prompt: string,
    qwenModel: string,
  ): Promise<string> {
    const fid = crypto.randomUUID();

    const reqBody = JSON.stringify({
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

    const resultStr = await webview.executeJavaScript(`
      (async () => {
        try {
          const res = await fetch(${JSON.stringify(`https://chat.qwen.ai/api/v2/chat/completions?chat_id=${chatId}`)}, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
            },
            body: ${JSON.stringify(reqBody)},
          });
          if (!res.ok) return JSON.stringify({ error: 'HTTP ' + res.status });
          const text = await res.text();
          // Parse SSE: Qwen uses OpenAI-compatible incremental format
          // Concatenate all delta.content tokens
          let answer = '';
          for (const line of text.split('\\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const content = parsed.choices && parsed.choices[0] && parsed.choices[0].delta && parsed.choices[0].delta.content;
              if (content) {
                answer += content;
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
      throw new Error(`Qwen API: ${parsed.error}`);
    }
    return parsed.answer || '';
  }
}
