/**
 * Kimi Web Provider
 * Uses kimi.moonshot.cn / www.kimi.com web session
 *
 * Reference: /Users/xnohat/openclaw-zero-token/src/providers/kimi-web-client-browser.ts
 *
 * NOTE: Kimi uses Connect RPC (gRPC-Web) with binary framing:
 *   - Content-Type: application/connect+json
 *   - Request: 5-byte header (1 byte flags + 4 bytes big-endian length) + JSON payload
 *   - Response: same framing, each frame is a JSON object with block.text.content
 *
 * Auth: kimi-auth cookie -> Bearer token for Authorization header.
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
// Uses direct webview.executeJavaScript for binary gRPC-Web protocol

const MODELS: WebProviderModel[] = [
  { id: 'webauth-kimi-128k', name: 'Kimi 128K (WebAuth)', contextWindow: 128000 },
  { id: 'webauth-kimi-32k', name: 'Kimi 32K (WebAuth)', contextWindow: 32000 },
];

const MODEL_SCENARIO_MAP: Record<string, string> = {
  'webauth-kimi-128k': 'SCENARIO_K2',
  'webauth-kimi-32k': 'SCENARIO_K2',
};

export class KimiWebProvider implements WebProvider {
  id = 'kimi-web';
  name = 'Kimi Web';
  loginUrl = 'https://kimi.moonshot.cn';
  partition = 'persist:webauth-kimi';
  models = MODELS;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      const hasCookie = await webview.executeJavaScript(
        `document.cookie.includes('kimi-auth')`
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

    const scenario = MODEL_SCENARIO_MAP[request.model] || 'SCENARIO_K2';

    // Execute the Connect RPC call inside the webview.
    // The binary framing is built inside the webview's JS context.
    const result = await webview.executeJavaScript(`
      (async function() {
        // Extract kimi-auth from cookies
        const cookies = document.cookie.split(';');
        let kimiAuth = '';
        for (const c of cookies) {
          const t = c.trim();
          if (t.startsWith('kimi-auth=')) {
            kimiAuth = t.slice('kimi-auth='.length);
            break;
          }
        }
        if (!kimiAuth) {
          return { ok: false, error: 'kimi-auth cookie not found' };
        }

        const baseUrl = window.location.origin || 'https://kimi.moonshot.cn';
        const message = ${JSON.stringify(prompt)};
        const scenario = ${JSON.stringify(scenario)};

        // Build Connect RPC binary frame
        const req = {
          scenario,
          message: {
            role: 'user',
            blocks: [{ message_id: '', text: { content: message } }],
            scenario,
          },
          options: { thinking: false },
        };
        const enc = new TextEncoder().encode(JSON.stringify(req));
        const buf = new ArrayBuffer(5 + enc.byteLength);
        const dv = new DataView(buf);
        dv.setUint8(0, 0x00);
        dv.setUint32(1, enc.byteLength, false);
        new Uint8Array(buf, 5).set(enc);

        try {
          const res = await fetch(
            baseUrl + '/apiv2/kimi.gateway.chat.v1.ChatService/Chat',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/connect+json',
                'Connect-Protocol-Version': '1',
                'Accept': '*/*',
                'Origin': baseUrl,
                'Referer': baseUrl + '/',
                'X-Language': 'zh-CN',
                'X-Msh-Platform': 'web',
                'Authorization': 'Bearer ' + kimiAuth,
              },
              body: buf,
            }
          );

          if (!res.ok) {
            const text = await res.text();
            return { ok: false, error: 'HTTP ' + res.status + ': ' + text.slice(0, 400) };
          }

          const arr = await res.arrayBuffer();
          const u8 = new Uint8Array(arr);
          const texts = [];
          let o = 0;
          while (o + 5 <= u8.length) {
            const len = new DataView(u8.buffer, u8.byteOffset + o + 1, 4).getUint32(0, false);
            if (o + 5 + len > u8.length) break;
            const chunk = u8.slice(o + 5, o + 5 + len);
            try {
              const obj = JSON.parse(new TextDecoder().decode(chunk));
              if (obj.error) {
                return { ok: false, error: obj.error.message || obj.error.code || JSON.stringify(obj.error).slice(0, 200) };
              }
              if (obj.block && obj.block.text && obj.block.text.content &&
                  ['set', 'append'].includes(obj.op || '')) {
                texts.push(obj.block.text.content);
              }
              if (obj.done) break;
            } catch {
              // ignore non-JSON frames
            }
            o += 5 + len;
          }
          return { ok: true, text: texts.join('') };
        } catch (e) {
          return { ok: false, error: e.message || String(e) };
        }
      })()
    `, 300_000) as { ok: boolean; text?: string; error?: string };

    if (!result.ok) {
      throw new Error(`Kimi API error: ${result.error}`);
    }

    const completionId = `chatcmpl-${Date.now()}`;
    if (result.text) {
      yield {
        id: completionId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: request.model,
        choices: [{
          index: 0,
          delta: { content: result.text },
          finish_reason: 'stop',
        }],
      };
    }
  }
}
