/**
 * Claude Web Provider
 * Uses claude.ai web session to make API calls via direct executeJavaScript.
 *
 * Flow:
 * 1. GET /api/organizations -> org UUID
 * 2. POST /api/organizations/{org}/chat_conversations -> conversation UUID
 * 3. POST /api/organizations/{org}/chat_conversations/{conv}/completion -> SSE stream
 *
 * SSE format: data: {"type":"completion","completion":"token","stop_reason":null|"end_turn"}
 * Response is buffered in-page, parsed, and returned as a JSON string.
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { consolidateMessages, parseTextToolCalls } from './shared-utils';

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

    // 3. Consolidate all messages into a single prompt
    const prompt = consolidateMessages(request.messages);

    // 4. Send completion request (buffered in-page, SSE parsed in-page)
    const responseText = await this.apiChat(webview, convId, prompt, request.model);

    if (!responseText) {
      throw new Error(`Claude: no response (org=${this.orgId || 'none'}, conv=${convId || 'none'}). Ensure you are logged in.`);
    }

    const completionId = `chatcmpl-${Date.now()}`;

    // 5. Check for text-based tool calls
    const toolCalls = parseTextToolCalls(responseText);

    if (toolCalls.length > 0) {
      // Extract any text before/between tool calls
      let textContent = responseText;
      for (const tc of toolCalls) {
        textContent = textContent.replace(tc.raw, '');
      }
      textContent = textContent.trim();

      // Emit text content if any
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

      // Emit tool calls in OpenAI format
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
      // Regular text response
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

  private async discoverOrg(webview: WebviewLike): Promise<void> {
    try {
      const resultStr = await webview.executeJavaScript(`
        (async () => {
          try {
            const res = await fetch('https://claude.ai/api/organizations', {
              method: 'GET',
              credentials: 'include',
              headers: {
                'Accept': 'application/json',
                'anthropic-client-platform': 'web_claude_ai',
              },
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
      if (parsed.error) return;

      const orgs = JSON.parse(parsed.body);
      if (Array.isArray(orgs) && orgs.length > 0) {
        this.orgId = orgs[0].uuid;
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

    const convBody = JSON.stringify({
      name: `Conversation ${new Date().toISOString()}`,
      uuid,
      model: claudeModel,
    });

    const resultStr = await webview.executeJavaScript(`
      (async () => {
        try {
          const res = await fetch(${JSON.stringify(url)}, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'anthropic-client-platform': 'web_claude_ai',
            },
            body: ${JSON.stringify(convBody)},
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
      throw new Error(`Failed to create Claude conversation: ${parsed.error}`);
    }

    const data = JSON.parse(parsed.body);
    return data.uuid || uuid;
  }

  private async apiChat(
    webview: WebviewLike,
    convId: string,
    prompt: string,
    model: string,
  ): Promise<string> {
    const claudeModel = MODEL_MAP[model] || 'claude-sonnet-4-6';
    const basePath = this.orgId
      ? `https://claude.ai/api/organizations/${this.orgId}/chat_conversations/${convId}/completion`
      : `https://claude.ai/api/chat_conversations/${convId}/completion`;

    const reqBody = JSON.stringify({
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

    const resultStr = await webview.executeJavaScript(`
      (async () => {
        try {
          const res = await fetch(${JSON.stringify(basePath)}, {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'text/event-stream',
              'anthropic-client-platform': 'web_claude_ai',
            },
            body: ${JSON.stringify(reqBody)},
          });
          if (!res.ok) return JSON.stringify({ error: 'HTTP ' + res.status });
          const text = await res.text();
          // Parse SSE: handle both old (completion) and new (Messages API) formats
          let answer = '';
          for (const line of text.split('\\n')) {
            if (!line.startsWith('data: ')) continue;
            const data = line.slice(6).trim();
            if (!data || data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              // New Messages API format: content_block_delta with text delta
              if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta') {
                answer += parsed.delta.text || '';
              }
              // Old format (legacy): completion type
              else if (parsed.type === 'completion' && parsed.completion) {
                answer += parsed.completion;
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
      if (parsed.error.includes('401') || parsed.error.includes('403')) {
        this.orgId = null;
      }
      throw new Error(`Claude API: ${parsed.error}`);
    }
    return parsed.answer || '';
  }
}
