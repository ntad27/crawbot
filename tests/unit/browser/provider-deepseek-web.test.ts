/**
 * DeepSeek Web Provider Tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeMockWebview } from '../../mocks/electron-browser';

// Mock the base-provider module
vi.mock('@electron/browser/providers/base-provider', () => ({
  executeInWebview: vi.fn(),
  streamFromWebview: vi.fn(),
}));

import { DeepSeekWebProvider } from '@electron/browser/providers/deepseek-web';
import { executeInWebview, streamFromWebview } from '@electron/browser/providers/base-provider';

const mockExecute = vi.mocked(executeInWebview);
const mockStream = vi.mocked(streamFromWebview);

describe('DeepSeekWebProvider', () => {
  let provider: DeepSeekWebProvider;
  let webview: ReturnType<typeof makeMockWebview>;

  beforeEach(() => {
    provider = new DeepSeekWebProvider();
    webview = makeMockWebview();
    vi.clearAllMocks();
  });

  // ── Properties ──

  describe('properties', () => {
    it('has correct id', () => {
      expect(provider.id).toBe('deepseek-web');
    });

    it('has correct name', () => {
      expect(provider.name).toBe('DeepSeek Web');
    });

    it('has correct loginUrl', () => {
      expect(provider.loginUrl).toBe('https://chat.deepseek.com');
    });

    it('has correct partition', () => {
      expect(provider.partition).toBe('persist:webauth-deepseek');
    });
  });

  // ── Models ──

  describe('models', () => {
    it('exposes two models', () => {
      expect(provider.models).toHaveLength(2);
    });

    it('has deepseek-chat model', () => {
      const chat = provider.models.find((m) => m.id === 'webauth-deepseek-chat');
      expect(chat).toBeDefined();
      expect(chat!.name).toContain('DeepSeek Chat');
      expect(chat!.contextWindow).toBe(64000);
    });

    it('has deepseek-reasoner model', () => {
      const reasoner = provider.models.find((m) => m.id === 'webauth-deepseek-reasoner');
      expect(reasoner).toBeDefined();
      expect(reasoner!.name).toContain('Reasoner');
      expect(reasoner!.contextWindow).toBe(64000);
    });

    it('all model IDs have webauth- prefix', () => {
      for (const model of provider.models) {
        expect(model.id).toMatch(/^webauth-/);
      }
    });
  });

  // ── checkAuth ──

  describe('checkAuth', () => {
    it('returns authenticated=true when ds_session_id cookie exists', async () => {
      webview.executeJavaScript.mockResolvedValue(true);
      const result = await provider.checkAuth(webview);

      expect(result.authenticated).toBe(true);
      expect(webview.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('ds_session_id'),
      );
    });

    it('returns authenticated=true when token cookie exists', async () => {
      webview.executeJavaScript.mockResolvedValue(true);
      const result = await provider.checkAuth(webview);

      expect(result.authenticated).toBe(true);
      expect(webview.executeJavaScript).toHaveBeenCalledWith(
        expect.stringContaining('token'),
      );
    });

    it('returns authenticated=false when no session cookie', async () => {
      webview.executeJavaScript.mockResolvedValue(false);
      const result = await provider.checkAuth(webview);

      expect(result.authenticated).toBe(false);
    });

    it('returns authenticated=false when executeJavaScript returns falsy value', async () => {
      webview.executeJavaScript.mockResolvedValue('');
      const result = await provider.checkAuth(webview);

      expect(result.authenticated).toBe(false);
    });

    it('returns authenticated=false when executeJavaScript throws', async () => {
      webview.executeJavaScript.mockRejectedValue(new Error('Webview crashed'));
      const result = await provider.checkAuth(webview);

      expect(result.authenticated).toBe(false);
    });

    it('checks cookie via document.cookie expression', async () => {
      webview.executeJavaScript.mockResolvedValue(true);
      await provider.checkAuth(webview);

      const call = webview.executeJavaScript.mock.calls[0][0] as string;
      expect(call).toContain('document.cookie');
    });
  });

  // ── chatCompletion ──

  describe('chatCompletion', () => {
    function setupMocks(sessionId: string, sseData: string[]) {
      // Mock createSession (executeInWebview)
      mockExecute.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: { biz_data: { id: sessionId } },
        }),
      });

      // Mock streaming
      async function* mockGenerator() {
        for (const line of sseData) {
          yield line;
        }
      }

      mockStream.mockReturnValue({
        stream: mockGenerator(),
        abort: vi.fn(),
      });
    }

    it('creates session then streams completion', async () => {
      setupMocks('session-abc', [
        'data: {"choices":[{"delta":{"content":"Hello"}}]}\n',
        'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n',
      ]);

      const chunks: unknown[] = [];
      for await (const chunk of provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect(
        (chunks[0] as { choices: Array<{ delta: { content: string } }> }).choices[0].delta.content,
      ).toBe('Hello');
      expect(
        (chunks[1] as { choices: Array<{ delta: { content: string } }> }).choices[0].delta.content,
      ).toBe(' world');
    });

    it('session creation calls correct DeepSeek API endpoint', async () => {
      setupMocks('session-xyz', []);

      const gen = provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'test' }],
      });
      // Exhaust the generator
      for await (const _chunk of gen) { /* consume */ }

      expect(mockExecute).toHaveBeenCalledWith(
        webview,
        'https://chat.deepseek.com/api/v0/chat_session/create',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }),
      );
    });

    it('throws when session creation fails', async () => {
      mockExecute.mockResolvedValueOnce({
        status: 401,
        headers: {},
        body: 'Unauthorized',
      });

      const gen = provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'test' }],
      });

      await expect(async () => {
        for await (const _chunk of gen) { /* consume */ }
      }).rejects.toThrow('Failed to create DeepSeek session: HTTP 401');
    });

    it('streams to correct DeepSeek completion endpoint', async () => {
      setupMocks('session-123', []);

      const gen = provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'hello' }],
      });
      for await (const _chunk of gen) { /* consume */ }

      expect(mockStream).toHaveBeenCalledWith(
        webview,
        'https://chat.deepseek.com/api/v0/chat/completion',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
          }),
        }),
      );
    });

    it('sends correct body with session ID and prompt', async () => {
      setupMocks('session-456', []);

      const gen = provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '4' },
          { role: 'user', content: 'Thanks!' },
        ],
      });
      for await (const _chunk of gen) { /* consume */ }

      const streamCallBody = JSON.parse(
        (mockStream.mock.calls[0][2] as { body: string }).body,
      );
      expect(streamCallBody.chat_session_id).toBe('session-456');
      // Only user messages are joined
      expect(streamCallBody.prompt).toBe('What is 2+2?\n\nThanks!');
      expect(streamCallBody.thinking_enabled).toBe(false);
      expect(streamCallBody.search_enabled).toBe(false);
    });

    it('enables thinking for reasoner model', async () => {
      setupMocks('session-789', []);

      const gen = provider.chatCompletion(webview, {
        model: 'webauth-deepseek-reasoner',
        messages: [{ role: 'user', content: 'Prove P=NP' }],
      });
      for await (const _chunk of gen) { /* consume */ }

      const streamCallBody = JSON.parse(
        (mockStream.mock.calls[0][2] as { body: string }).body,
      );
      expect(streamCallBody.thinking_enabled).toBe(true);
    });

    it('disables thinking for chat model', async () => {
      setupMocks('session-abc', []);

      const gen = provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'Hi' }],
      });
      for await (const _chunk of gen) { /* consume */ }

      const streamCallBody = JSON.parse(
        (mockStream.mock.calls[0][2] as { body: string }).body,
      );
      expect(streamCallBody.thinking_enabled).toBe(false);
    });

    it('yields OpenAI-format chunks with correct structure', async () => {
      setupMocks('session-struct', [
        'data: {"choices":[{"delta":{"content":"Test"}}]}\n',
      ]);

      const chunks: unknown[] = [];
      for await (const chunk of provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      const chunk = chunks[0] as {
        id: string;
        object: string;
        created: number;
        model: string;
        choices: Array<{ index: number; delta: { content: string }; finish_reason: string | null }>;
      };

      expect(chunk.id).toMatch(/^chatcmpl-/);
      expect(chunk.object).toBe('chat.completion.chunk');
      expect(typeof chunk.created).toBe('number');
      expect(chunk.model).toBe('webauth-deepseek-chat');
      expect(chunk.choices[0].index).toBe(0);
      expect(chunk.choices[0].delta.content).toBe('Test');
      expect(chunk.choices[0].finish_reason).toBeNull();
    });

    it('skips [DONE] SSE event', async () => {
      setupMocks('session-done', [
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n',
        'data: [DONE]\n',
      ]);

      const chunks: unknown[] = [];
      for await (const chunk of provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
    });

    it('skips lines that do not start with data:', async () => {
      setupMocks('session-skip', [
        ': comment line\n',
        'event: ping\n',
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n',
      ]);

      const chunks: unknown[] = [];
      for await (const chunk of provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
    });

    it('skips malformed JSON in SSE data', async () => {
      setupMocks('session-malformed', [
        'data: {bad json}\n',
        'data: {"choices":[{"delta":{"content":"OK"}}]}\n',
      ]);

      const chunks: unknown[] = [];
      for await (const chunk of provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
    });

    it('skips SSE events without delta.content', async () => {
      setupMocks('session-nocontent', [
        'data: {"choices":[{"delta":{}}]}\n',
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n',
        'data: {"choices":[{"delta":{"content":"real content"}}]}\n',
      ]);

      const chunks: unknown[] = [];
      for await (const chunk of provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(1);
      expect(
        (chunks[0] as { choices: Array<{ delta: { content: string } }> }).choices[0].delta.content,
      ).toBe('real content');
    });

    it('handles session ID from chat_session_id field', async () => {
      mockExecute.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({
          data: { biz_data: { chat_session_id: 'alt-session-id' } },
        }),
      });

      async function* empty() {
        // no SSE lines
      }
      mockStream.mockReturnValue({ stream: empty(), abort: vi.fn() });

      const gen = provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
      });
      for await (const _chunk of gen) { /* consume */ }

      const streamCallBody = JSON.parse(
        (mockStream.mock.calls[0][2] as { body: string }).body,
      );
      expect(streamCallBody.chat_session_id).toBe('alt-session-id');
    });

    it('propagates finish_reason from SSE data', async () => {
      setupMocks('session-finish', [
        'data: {"choices":[{"delta":{"content":"Done"},"finish_reason":"stop"}]}\n',
      ]);

      const chunks: unknown[] = [];
      for await (const chunk of provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk);
      }

      expect(
        (chunks[0] as { choices: Array<{ finish_reason: string | null }> }).choices[0]
          .finish_reason,
      ).toBe('stop');
    });

    it('handles buffered multi-line SSE chunks', async () => {
      // Simulate data arriving in chunks that span multiple lines
      setupMocks('session-buffer', [
        'data: {"choices":[{"delta":{"content":"A"}}]}\ndata: {"choices":[{"delta":{"content":"B"}}]}\n',
      ]);

      const chunks: unknown[] = [];
      for await (const chunk of provider.chatCompletion(webview, {
        model: 'webauth-deepseek-chat',
        messages: [{ role: 'user', content: 'hi' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
    });
  });
});
