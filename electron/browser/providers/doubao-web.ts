/**
 * Doubao Web Provider
 * Uses www.doubao.com web session
 *
 * Reference: /Users/xnohat/openclaw-zero-token/src/providers/doubao-web-client-browser.ts
 *
 * Flow:
 * POST /samantha/chat/completion?aid=497858&... -> SSE stream
 * Auth cookies: sessionid (required), ttwid (optional).
 * Request body uses a special content_type 2001 format with JSON-encoded text.
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { streamFromWebview } from './base-provider';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-doubao-seed-2', name: 'Doubao Seed 2.0 (WebAuth)', contextWindow: 64000 },
  { id: 'webauth-doubao-pro', name: 'Doubao Pro (WebAuth)', contextWindow: 64000 },
];

export class DoubaoWebProvider implements WebProvider {
  id = 'doubao-web';
  name = 'Doubao Web';
  loginUrl = 'https://www.doubao.com';
  partition = 'persist:webauth-doubao';
  models = MODELS;

  private conversationId: string | null = null;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      const hasCookie = await webview.executeJavaScript(
        `document.cookie.includes('sessionid')`
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
    // Merge messages into a single content string with role markers
    const text = request.messages
      .map((m) => {
        const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : 'system';
        return `<|im_start|>${role}\n${m.content}\n`;
      })
      .join('') + '<|im_end|>\n';

    const needCreate = !this.conversationId;

    const body = JSON.stringify({
      messages: [
        {
          content: JSON.stringify({ text }),
          content_type: 2001,
          attachments: [],
          references: [],
        },
      ],
      completion_option: {
        is_regen: false,
        with_suggest: true,
        need_create_conversation: needCreate,
        launch_stage: 1,
        is_replace: false,
        is_delete: false,
        message_from: 0,
        event_id: '0',
      },
      conversation_id: this.conversationId || '0',
      local_conversation_id: `local_16${Date.now().toString().slice(-14)}`,
      local_message_id: crypto.randomUUID(),
    });

    const params = new URLSearchParams({
      aid: '497858',
      device_platform: 'web',
      language: 'zh',
      pkg_type: 'release_version',
      real_aid: '497858',
      region: 'CN',
      samantha_web: '1',
      sys_region: 'CN',
      use_olympus_account: '1',
      version_code: '20800',
    });

    const { stream } = streamFromWebview(
      webview,
      `https://www.doubao.com/samantha/chat/completion?${params.toString()}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
          'Referer': 'https://www.doubao.com/chat/',
          'Agw-js-conv': 'str',
        },
        body,
      }
    );

    const completionId = `chatcmpl-${Date.now()}`;
    let sseBuffer = '';

    for await (const chunk of stream) {
      sseBuffer += chunk;
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);

          // Extract conversation_id for reuse
          if (!this.conversationId && parsed.conversation_id && parsed.conversation_id !== '0') {
            this.conversationId = parsed.conversation_id;
          }

          // Doubao SSE: event_data.message.content contains the text
          const content = parsed.event_data?.message?.content
            ?? parsed.choices?.[0]?.delta?.content
            ?? parsed.content
            ?? parsed.text;

          if (content) {
            // Content may be JSON-encoded with a "text" field
            let textContent = content;
            try {
              const inner = JSON.parse(content);
              if (inner.text) textContent = inner.text;
            } catch {
              // Use as-is
            }

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
        } catch {
          // Skip malformed
        }
      }
    }
  }
}
