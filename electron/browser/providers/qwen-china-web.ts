/**
 * Qwen China Web Provider
 * Uses tongyi.aliyun.com / qianwen.com web session
 *
 * Reference: /Users/xnohat/openclaw-zero-token/src/providers/qwen-cn-web-client-browser.ts
 *
 * Flow:
 * POST /api/v2/chat with SSE response. Requires x-xsrf-token, x-deviceid, x-platform headers.
 * Auth cookies: tongyi_sso_ticket or login_aliyunid_ticket, XSRF-TOKEN.
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { streamFromWebview } from './base-provider';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-qwen-china-35-plus', name: 'Qwen 3.5 Plus China (WebAuth)', contextWindow: 128000 },
  { id: 'webauth-qwen-china-35-turbo', name: 'Qwen 3.5 Turbo China (WebAuth)', contextWindow: 32768 },
];

const MODEL_MAP: Record<string, string> = {
  'webauth-qwen-china-35-plus': 'Qwen3.5-Plus',
  'webauth-qwen-china-35-turbo': 'Qwen3.5-Turbo',
};

export class QwenChinaWebProvider implements WebProvider {
  id = 'qwen-china-web';
  name = 'Qwen China Web';
  loginUrl = 'https://tongyi.aliyun.com';
  partition = 'persist:webauth-qwen-china';
  models = MODELS;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      const hasCookie = await webview.executeJavaScript(
        `document.cookie.includes('tongyi_sso_ticket') || document.cookie.includes('login_aliyunid_ticket')`
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
    const qwenModel = MODEL_MAP[request.model] || 'Qwen3.5-Plus';

    const prompt = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n');

    // Extract XSRF token and device info from cookies
    const cookieInfo = await webview.executeJavaScript(`
      (function() {
        const cookies = document.cookie;
        let xsrf = '';
        let ut = '';
        const xsrfMatch = cookies.match(/XSRF-TOKEN=([^;]+)/);
        if (xsrfMatch) xsrf = decodeURIComponent(xsrfMatch[1]);
        const utMatch = cookies.match(/b-user-id=([^;]+)/);
        if (utMatch) ut = utMatch[1];
        // Also try meta tag
        if (!xsrf) {
          const meta = document.querySelector('meta[name="x-xsrf-token"]');
          if (meta) xsrf = meta.getAttribute('content') || '';
        }
        return { xsrf, ut };
      })()
    `) as { xsrf: string; ut: string };

    const sessionId = Array.from({ length: 32 }, () =>
      Math.floor(Math.random() * 16).toString(16)
    ).join('');
    const timestamp = Date.now();
    const nonce = Math.random().toString(36).slice(2);
    const ut = (cookieInfo as { ut: string }).ut || '';
    const xsrf = (cookieInfo as { xsrf: string }).xsrf || '';

    const body = JSON.stringify({
      model: qwenModel,
      messages: [
        {
          content: prompt,
          mime_type: 'text/plain',
          meta_data: { ori_query: prompt },
        },
      ],
      session_id: sessionId,
      parent_req_id: '0',
      deep_search: '0',
      req_id: `req-${Math.random().toString(36).slice(2)}`,
      scene: 'chat',
      sub_scene: 'chat',
      temporary: false,
      from: 'default',
      scene_param: 'first_turn',
      chat_client: 'h5',
      client_tm: timestamp.toString(),
      protocol_version: 'v2',
      biz_id: 'ai_qwen',
    });

    const { stream } = streamFromWebview(
      webview,
      `https://chat2.qianwen.com/api/v2/chat?biz_id=ai_qwen&chat_client=h5&device=pc&fr=pc&pr=qwen&nonce=${nonce}&timestamp=${timestamp}&ut=${ut}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream, text/plain, */*',
          'x-xsrf-token': xsrf,
          'x-deviceid': ut || `random-${Math.random().toString(36).slice(2)}`,
          'x-platform': 'pc_tongyi',
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
          // Qwen China SSE format: contents[].content or text field
          const content = parsed.contents?.[0]?.content
            ?? parsed.content
            ?? parsed.text
            ?? parsed.choices?.[0]?.delta?.content;

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
          // Skip malformed
        }
      }
    }
  }
}
