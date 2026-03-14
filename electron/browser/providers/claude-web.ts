/**
 * Claude Web Provider
 * Uses claude.ai web session to make API calls
 *
 * Reference: /Users/xnohat/openclaw-zero-token/src/providers/claude-web-client-browser.ts
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { executeInWebview, streamFromWebview } from './base-provider';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-claude-sonnet-4', name: 'Claude Sonnet 4 (WebAuth)', contextWindow: 200000 },
  { id: 'webauth-claude-opus-4', name: 'Claude Opus 4 (WebAuth)', contextWindow: 200000 },
  { id: 'webauth-claude-haiku-4', name: 'Claude Haiku 4 (WebAuth)', contextWindow: 200000 },
];

const MODEL_MAP: Record<string, string> = {
  'webauth-claude-sonnet-4': 'claude-sonnet-4-6',
  'webauth-claude-opus-4': 'claude-opus-4-6',
  'webauth-claude-haiku-4': 'claude-haiku-4-6',
};

export class ClaudeWebProvider implements WebProvider {
  id = 'claude-web';
  name = 'Claude Web';
  loginUrl = 'https://claude.ai';
  partition = 'persist:webauth-claude';
  models = MODELS;

  private orgId: string | null = null;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      const hasSession = await webview.executeJavaScript(
        `document.cookie.split(';').some(c => c.trim().startsWith('sessionKey='))`
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
    // 1. Discover org ID if needed
    if (!this.orgId) {
      await this.discoverOrg(webview);
    }

    // 2. Create conversation
    const convId = await this.createConversation(webview, request.model);

    // 3. Build prompt from messages
    const prompt = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n');

    // 4. Stream completion
    const claudeModel = MODEL_MAP[request.model] || 'claude-sonnet-4-6';
    const basePath = this.orgId
      ? `https://claude.ai/api/organizations/${this.orgId}/chat_conversations/${convId}/completion`
      : `https://claude.ai/api/chat_conversations/${convId}/completion`;

    const body = JSON.stringify({
      prompt,
      parent_message_uuid: '00000000-0000-4000-8000-000000000000',
      model: claudeModel,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      rendering_mode: 'messages',
      attachments: [],
      files: [],
      locale: 'en-US',
      personalized_styles: [],
      sync_sources: [],
      tools: [],
    });

    const { stream } = streamFromWebview(webview, basePath, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'anthropic-client-platform': 'web_claude_ai',
      },
      body,
    });

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
          if (parsed.type === 'completion' && parsed.completion) {
            yield {
              id: completionId,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: request.model,
              choices: [{
                index: 0,
                delta: { content: parsed.completion },
                finish_reason: parsed.stop_reason === 'end_turn' ? 'stop' : null,
              }],
            };
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }

  private async discoverOrg(webview: WebviewLike): Promise<void> {
    try {
      const res = await executeInWebview(webview, 'https://claude.ai/api/organizations', {
        headers: {
          'Accept': 'application/json',
          'anthropic-client-platform': 'web_claude_ai',
        },
      });
      if (res.status === 200) {
        const orgs = JSON.parse(res.body);
        if (Array.isArray(orgs) && orgs.length > 0) {
          this.orgId = orgs[0].uuid;
        }
      }
    } catch {
      // Will use non-org path
    }
  }

  private async createConversation(webview: WebviewLike, model: string): Promise<string> {
    const claudeModel = MODEL_MAP[model] || 'claude-sonnet-4-6';
    const uuid = crypto.randomUUID();
    const url = this.orgId
      ? `https://claude.ai/api/organizations/${this.orgId}/chat_conversations`
      : 'https://claude.ai/api/chat_conversations';

    const res = await executeInWebview(webview, url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-client-platform': 'web_claude_ai',
      },
      body: JSON.stringify({
        name: `Conversation ${new Date().toISOString()}`,
        uuid,
        model: claudeModel,
      }),
    });

    if (res.status !== 200 && res.status !== 201) {
      throw new Error(`Failed to create conversation: HTTP ${res.status}`);
    }

    const data = JSON.parse(res.body);
    return data.uuid || uuid;
  }
}
