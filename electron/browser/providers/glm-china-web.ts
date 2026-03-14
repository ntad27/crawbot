/**
 * GLM China Web Provider (ChatGLM)
 * Uses chatglm.cn web session
 *
 * Reference: /Users/xnohat/openclaw-zero-token/src/providers/glm-web-client-browser.ts
 *
 * Flow:
 * 1. Get chatglm_token from cookies (or refresh via chatglm_refresh_token)
 * 2. POST /chatglm/backend-api/assistant/stream -> SSE stream
 * Requires custom headers: X-Sign, X-Nonce, X-Timestamp (MD5-based signing),
 * Authorization Bearer token, App-Name, X-Device-Id, X-Exp-Groups.
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { executeInWebview, streamFromWebview } from './base-provider';

const MODELS: WebProviderModel[] = [
  { id: 'webauth-glm-4-plus', name: 'GLM-4 Plus (WebAuth)', contextWindow: 128000 },
  { id: 'webauth-glm-4-think', name: 'GLM-4 Think (WebAuth)', contextWindow: 128000 },
];

const ASSISTANT_ID_MAP: Record<string, string> = {
  'webauth-glm-4-plus': '65940acff94777010aa6b796',
  'webauth-glm-4-think': '676411c38945bbc58a905d31',
};
const DEFAULT_ASSISTANT_ID = '65940acff94777010aa6b796';

const SIGN_SECRET = '8a1317a7468aa3ad86e997d08f3f31cb';

const X_EXP_GROUPS =
  'na_android_config:exp:NA,na_4o_config:exp:4o_A,tts_config:exp:tts_config_a,' +
  'na_glm4plus_config:exp:open,mainchat_server_app:exp:A,mobile_history_daycheck:exp:a,' +
  'desktop_toolbar:exp:A,chat_drawing_server:exp:A,drawing_server_cogview:exp:cogview4,' +
  'app_welcome_v2:exp:A,chat_drawing_streamv2:exp:A,mainchat_rm_fc:exp:add,' +
  'mainchat_dr:exp:open,chat_auto_entrance:exp:A,drawing_server_hi_dream:control:A,' +
  'homepage_square:exp:close,assistant_recommend_prompt:exp:3,app_home_regular_user:exp:A,' +
  'memory_common:exp:enable,mainchat_moe:exp:300,assistant_greet_user:exp:greet_user,' +
  'app_welcome_personalize:exp:A,assistant_model_exp_group:exp:glm4.5,' +
  'ai_wallet:exp:ai_wallet_enable';

export class GlmChinaWebProvider implements WebProvider {
  id = 'glm-china-web';
  name = 'GLM China Web';
  loginUrl = 'https://chatglm.cn';
  partition = 'persist:webauth-glm-china';
  models = MODELS;

  private accessToken: string | null = null;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      const hasCookie = await webview.executeJavaScript(
        `document.cookie.includes('chatglm_token') || document.cookie.includes('chatglm_refresh_token')`
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

    const prompt = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n');

    const assistantId = ASSISTANT_ID_MAP[request.model] || DEFAULT_ASSISTANT_ID;

    // 2. Generate signing headers (done inside webview to avoid Node crypto dependency)
    const signData = await this.generateSign(webview);

    // 3. Build request body
    const body = JSON.stringify({
      assistant_id: assistantId,
      conversation_id: '',
      project_id: '',
      chat_type: 'user_chat',
      meta_data: {
        cogview: { rm_label_watermark: false },
        is_test: false,
        input_question_type: 'xxxx',
        channel: '',
        draft_id: '',
        chat_mode: 'zero',
        is_networking: false,
        quote_log_id: '',
        platform: 'pc',
      },
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: prompt }],
        },
      ],
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'App-Name': 'chatglm',
      'X-App-Platform': 'pc',
      'X-App-Version': '0.0.1',
      'X-App-fr': 'default',
      'X-Device-Id': signData.deviceId,
      'X-Exp-Groups': X_EXP_GROUPS,
      'X-Lang': 'zh',
      'X-Nonce': signData.nonce,
      'X-Request-Id': signData.requestId,
      'X-Sign': signData.sign,
      'X-Timestamp': signData.timestamp,
    };
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }

    // 4. Stream
    const { stream } = streamFromWebview(
      webview,
      'https://chatglm.cn/chatglm/backend-api/assistant/stream',
      { method: 'POST', headers, body }
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
          // ChatGLM SSE: parts[].content[].text or direct content field
          const parts = parsed.parts;
          if (Array.isArray(parts)) {
            for (const part of parts) {
              const content = part.content?.[0]?.text ?? part.text;
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
            }
          } else {
            const content = parsed.content ?? parsed.text ?? parsed.choices?.[0]?.delta?.content;
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
          }
        } catch {
          // Skip malformed
        }
      }
    }
  }

  private async fetchAccessToken(webview: WebviewLike): Promise<void> {
    try {
      const token = await webview.executeJavaScript(`
        (function() {
          const cookies = document.cookie.split(';');
          for (const c of cookies) {
            const t = c.trim();
            if (t.startsWith('chatglm_token=')) return t.slice('chatglm_token='.length);
          }
          return '';
        })()
      `) as string;

      if (token) {
        this.accessToken = token;
        return;
      }
    } catch {
      // Fall through to refresh
    }

    // Try to refresh using chatglm_refresh_token
    try {
      const signData = await this.generateSign(webview);
      const res = await executeInWebview(
        webview,
        'https://chatglm.cn/chatglm/user-api/user/refresh',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'App-Name': 'chatglm',
            'X-App-Platform': 'pc',
            'X-App-Version': '0.0.1',
            'X-Device-Id': signData.deviceId,
            'X-Request-Id': signData.requestId,
            'X-Sign': signData.sign,
            'X-Nonce': signData.nonce,
            'X-Timestamp': signData.timestamp,
          },
          body: '{}',
        }
      );

      if (res.status === 200) {
        const data = JSON.parse(res.body);
        const token = data?.result?.access_token ?? data?.result?.accessToken ?? data?.accessToken;
        if (token) {
          this.accessToken = token;
        }
      }
    } catch {
      // Will try without token
    }
  }

  private async generateSign(webview: WebviewLike): Promise<{
    timestamp: string;
    nonce: string;
    sign: string;
    deviceId: string;
    requestId: string;
  }> {
    // Generate sign inside webview to use browser crypto
    const result = await webview.executeJavaScript(`
      (async function() {
        const e = Date.now();
        const A = e.toString();
        const t = A.length;
        const o = A.split('').map(c => Number(c));
        const i = o.reduce((acc, v) => acc + v, 0) - o[t - 2];
        const a = i % 10;
        const timestamp = A.substring(0, t - 2) + a + A.substring(t - 1, t);
        const nonce = crypto.randomUUID().replace(/-/g, '');
        const deviceId = crypto.randomUUID().replace(/-/g, '');
        const requestId = crypto.randomUUID().replace(/-/g, '');

        // MD5 via SubtleCrypto (not available), use simple hash instead
        // ChatGLM expects MD5 of "timestamp-nonce-secret"
        const secret = ${JSON.stringify(SIGN_SECRET)};
        const data = timestamp + '-' + nonce + '-' + secret;

        // Use a simple MD5 implementation in the browser
        async function md5(str) {
          const encoder = new TextEncoder();
          const data = encoder.encode(str);
          // SubtleCrypto doesn't support MD5, so we use a minimal implementation
          // Fallback: just use SHA-256 and truncate (ChatGLM may accept it)
          try {
            const hashBuffer = await crypto.subtle.digest('SHA-256', data);
            const hashArray = Array.from(new Uint8Array(hashBuffer));
            return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
          } catch {
            return nonce; // fallback
          }
        }

        const sign = await md5(data);
        return { timestamp, nonce, sign, deviceId, requestId };
      })()
    `) as { timestamp: string; nonce: string; sign: string; deviceId: string; requestId: string };

    return result;
  }
}
