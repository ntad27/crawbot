/**
 * WebAuth Proxy Server Tests
 * Tests for the OpenAI-compatible HTTP proxy
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';

// Mock the logger to avoid console noise
vi.mock('@electron/utils/logger', () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

import { WebAuthProxy, createWebAuthProxy, getWebAuthProxy } from '@electron/browser/webauth-proxy';
import type { WebProvider, OpenAIChatRequest, OpenAIChatChunk, WebviewLike } from '@electron/browser/providers/types';

// ── Helpers ──

function makeRequest(
  port: number,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: data }));
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function makeMockProvider(overrides: Partial<WebProvider> = {}): WebProvider {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    loginUrl: 'https://test.example.com',
    partition: 'persist:webauth-test',
    models: [
      { id: 'webauth-test-model', name: 'Test Model' },
      { id: 'webauth-test-model-2', name: 'Test Model 2' },
    ],
    checkAuth: vi.fn().mockResolvedValue({ authenticated: true }),
    chatCompletion: vi.fn(),
    ...overrides,
  };
}

function makeMockWebview(): WebviewLike {
  return {
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

// ── Tests ──

describe('WebAuthProxy', () => {
  let proxy: WebAuthProxy;

  beforeEach(() => {
    proxy = new WebAuthProxy();
  });

  afterEach(async () => {
    await proxy.stop();
  });

  // ── Lifecycle ──

  describe('lifecycle', () => {
    it('starts and reports running on a port', async () => {
      const port = await proxy.start(0);

      expect(port).toBeGreaterThan(0);
      expect(proxy.isRunning).toBe(true);
      expect(proxy.port).toBe(port);
    });

    it('returns existing port if already running', async () => {
      const port1 = await proxy.start(0);
      const port2 = await proxy.start(0);

      expect(port2).toBe(port1);
    });

    it('stops cleanly', async () => {
      await proxy.start(0);
      await proxy.stop();

      expect(proxy.isRunning).toBe(false);
    });

    it('stop is a no-op when not running', async () => {
      // Should not throw
      await proxy.stop();
      expect(proxy.isRunning).toBe(false);
    });
  });

  // ── Provider Registration ──

  describe('registerProvider', () => {
    it('registers a provider', async () => {
      const provider = makeMockProvider();
      proxy.registerProvider(provider);

      // Verify by listing models after setting webview
      proxy.setWebview('test-provider', makeMockWebview());
      const port = await proxy.start(0);

      const res = await makeRequest(port, 'GET', '/v1/models');
      const data = JSON.parse(res.body);

      expect(data.data).toHaveLength(2);
      expect(data.data[0].id).toBe('webauth-test-model');
    });

    it('overwrites provider with same ID', async () => {
      const provider1 = makeMockProvider({ models: [{ id: 'model-a', name: 'A' }] });
      const provider2 = makeMockProvider({ models: [{ id: 'model-b', name: 'B' }] });

      proxy.registerProvider(provider1);
      proxy.registerProvider(provider2);
      proxy.setWebview('test-provider', makeMockWebview());

      const port = await proxy.start(0);
      const res = await makeRequest(port, 'GET', '/v1/models');
      const data = JSON.parse(res.body);

      expect(data.data).toHaveLength(1);
      expect(data.data[0].id).toBe('model-b');
    });
  });

  // ── Webview Management ──

  describe('webview management', () => {
    it('setWebview and removeWebview control model visibility', async () => {
      const provider = makeMockProvider();
      proxy.registerProvider(provider);

      const port = await proxy.start(0);

      // No webview → no models
      let res = await makeRequest(port, 'GET', '/v1/models');
      let data = JSON.parse(res.body);
      expect(data.data).toHaveLength(0);

      // Set webview → models appear
      proxy.setWebview('test-provider', makeMockWebview());
      res = await makeRequest(port, 'GET', '/v1/models');
      data = JSON.parse(res.body);
      expect(data.data).toHaveLength(2);

      // Remove webview → models gone
      proxy.removeWebview('test-provider');
      res = await makeRequest(port, 'GET', '/v1/models');
      data = JSON.parse(res.body);
      expect(data.data).toHaveLength(0);
    });
  });

  // ── GET /v1/models ──

  describe('GET /v1/models', () => {
    it('returns empty list when no providers registered', async () => {
      const port = await proxy.start(0);
      const res = await makeRequest(port, 'GET', '/v1/models');

      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.object).toBe('list');
      expect(data.data).toEqual([]);
    });

    it('returns models from multiple providers', async () => {
      const provider1 = makeMockProvider({
        id: 'provider-1',
        models: [{ id: 'model-a', name: 'Model A' }],
      });
      const provider2 = makeMockProvider({
        id: 'provider-2',
        models: [{ id: 'model-b', name: 'Model B' }],
      });

      proxy.registerProvider(provider1);
      proxy.registerProvider(provider2);
      proxy.setWebview('provider-1', makeMockWebview());
      proxy.setWebview('provider-2', makeMockWebview());

      const port = await proxy.start(0);
      const res = await makeRequest(port, 'GET', '/v1/models');
      const data = JSON.parse(res.body);

      expect(data.data).toHaveLength(2);
      expect(data.data.map((m: { id: string }) => m.id)).toContain('model-a');
      expect(data.data.map((m: { id: string }) => m.id)).toContain('model-b');
    });

    it('model entries have correct shape', async () => {
      const provider = makeMockProvider();
      proxy.registerProvider(provider);
      proxy.setWebview('test-provider', makeMockWebview());

      const port = await proxy.start(0);
      const res = await makeRequest(port, 'GET', '/v1/models');
      const data = JSON.parse(res.body);

      const model = data.data[0];
      expect(model).toHaveProperty('id', 'webauth-test-model');
      expect(model).toHaveProperty('object', 'model');
      expect(model).toHaveProperty('created');
      expect(typeof model.created).toBe('number');
      expect(model).toHaveProperty('owned_by', 'webauth-test-provider');
    });

    it('only lists models for providers with a webview', async () => {
      const withWebview = makeMockProvider({
        id: 'with-wv',
        models: [{ id: 'visible', name: 'Visible' }],
      });
      const withoutWebview = makeMockProvider({
        id: 'no-wv',
        models: [{ id: 'hidden', name: 'Hidden' }],
      });

      proxy.registerProvider(withWebview);
      proxy.registerProvider(withoutWebview);
      proxy.setWebview('with-wv', makeMockWebview());

      const port = await proxy.start(0);
      const res = await makeRequest(port, 'GET', '/v1/models');
      const data = JSON.parse(res.body);

      expect(data.data).toHaveLength(1);
      expect(data.data[0].id).toBe('visible');
    });
  });

  // ── POST /v1/chat/completions ──

  describe('POST /v1/chat/completions', () => {
    it('returns 400 for invalid JSON', async () => {
      const port = await proxy.start(0);
      const res = await makeRequest(port, 'POST', '/v1/chat/completions', '{bad json');

      expect(res.status).toBe(400);
      const data = JSON.parse(res.body);
      expect(data.error.message).toBe('Invalid JSON');
      expect(data.error.type).toBe('invalid_request_error');
    });

    it('returns 404 for unknown model', async () => {
      const port = await proxy.start(0);
      const body = JSON.stringify({
        model: 'nonexistent-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
      const res = await makeRequest(port, 'POST', '/v1/chat/completions', body);

      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error.message).toContain('nonexistent-model');
      expect(data.error.type).toBe('invalid_request_error');
    });

    it('returns 404 when provider has no webview', async () => {
      const provider = makeMockProvider();
      proxy.registerProvider(provider);
      // No setWebview

      const port = await proxy.start(0);
      const body = JSON.stringify({
        model: 'webauth-test-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
      const res = await makeRequest(port, 'POST', '/v1/chat/completions', body);

      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error.message).toContain('not authenticated');
    });

    it('streams SSE chunks from provider chatCompletion', async () => {
      const chunks: OpenAIChatChunk[] = [
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1000,
          model: 'webauth-test-model',
          choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
        },
        {
          id: 'chatcmpl-1',
          object: 'chat.completion.chunk',
          created: 1000,
          model: 'webauth-test-model',
          choices: [{ index: 0, delta: { content: ' world' }, finish_reason: 'stop' }],
        },
      ];

      async function* mockCompletion() {
        for (const chunk of chunks) {
          yield chunk;
        }
      }

      const provider = makeMockProvider({
        chatCompletion: vi.fn().mockReturnValue(mockCompletion()),
      });
      const webview = makeMockWebview();
      proxy.registerProvider(provider);
      proxy.setWebview('test-provider', webview);

      const port = await proxy.start(0);
      const body = JSON.stringify({
        model: 'webauth-test-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
      const res = await makeRequest(port, 'POST', '/v1/chat/completions', body);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/event-stream');
      expect(res.headers['cache-control']).toBe('no-cache');

      // Parse SSE events
      const events = res.body
        .split('\n\n')
        .filter((e) => e.startsWith('data: '))
        .map((e) => e.slice(6));

      expect(events).toHaveLength(3); // 2 chunks + [DONE]
      expect(JSON.parse(events[0]).choices[0].delta.content).toBe('Hello');
      expect(JSON.parse(events[1]).choices[0].delta.content).toBe(' world');
      expect(events[2]).toBe('[DONE]');
    });

    it('sends error chunk when chatCompletion throws', async () => {
      // eslint-disable-next-line require-yield
      async function* failingCompletion(): AsyncGenerator<OpenAIChatChunk> {
        throw new Error('Provider exploded');
      }

      const provider = makeMockProvider({
        chatCompletion: vi.fn().mockReturnValue(failingCompletion()),
      });
      proxy.registerProvider(provider);
      proxy.setWebview('test-provider', makeMockWebview());

      const port = await proxy.start(0);
      const body = JSON.stringify({
        model: 'webauth-test-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
      const res = await makeRequest(port, 'POST', '/v1/chat/completions', body);

      expect(res.status).toBe(200); // SSE starts as 200
      const events = res.body
        .split('\n\n')
        .filter((e) => e.startsWith('data: '))
        .map((e) => e.slice(6));

      const errorEvent = events.find((e) => {
        try { return JSON.parse(e).error; } catch { return false; }
      });
      expect(errorEvent).toBeTruthy();
      const parsed = JSON.parse(errorEvent!);
      expect(parsed.error.message).toContain('Provider exploded');
      expect(parsed.error.type).toBe('server_error');
    });

    it('passes correct request to provider chatCompletion', async () => {
      async function* emptyCompletion(): AsyncGenerator<OpenAIChatChunk> {
        // yield nothing
      }

      const mockChatCompletion = vi.fn().mockReturnValue(emptyCompletion());
      const provider = makeMockProvider({ chatCompletion: mockChatCompletion });
      const webview = makeMockWebview();
      proxy.registerProvider(provider);
      proxy.setWebview('test-provider', webview);

      const port = await proxy.start(0);
      const requestBody: OpenAIChatRequest = {
        model: 'webauth-test-model',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'hi' },
        ],
        temperature: 0.7,
      };
      await makeRequest(port, 'POST', '/v1/chat/completions', JSON.stringify(requestBody));

      expect(mockChatCompletion).toHaveBeenCalledWith(webview, requestBody);
    });
  });

  // ── CORS ──

  describe('CORS', () => {
    it('OPTIONS returns 204 with CORS headers', async () => {
      const port = await proxy.start(0);
      const res = await makeRequest(port, 'OPTIONS', '/v1/models');

      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(res.headers['access-control-allow-methods']).toContain('POST');
      expect(res.headers['access-control-allow-headers']).toContain('Authorization');
    });
  });

  // ── 404 ──

  describe('unknown routes', () => {
    it('returns 404 for unknown path', async () => {
      const port = await proxy.start(0);
      const res = await makeRequest(port, 'GET', '/unknown');

      expect(res.status).toBe(404);
      const data = JSON.parse(res.body);
      expect(data.error.message).toBe('Not found');
    });

    it('returns 404 for GET /v1/chat/completions', async () => {
      const port = await proxy.start(0);
      const res = await makeRequest(port, 'GET', '/v1/chat/completions');

      expect(res.status).toBe(404);
    });

    it('returns 404 for POST /v1/models', async () => {
      const port = await proxy.start(0);
      const res = await makeRequest(port, 'POST', '/v1/models', '{}');

      expect(res.status).toBe(404);
    });
  });
});

// ── Singleton ──

describe('singleton functions', () => {
  it('createWebAuthProxy returns a WebAuthProxy instance', () => {
    const proxy = createWebAuthProxy();
    expect(proxy).toBeInstanceOf(WebAuthProxy);
  });

  it('createWebAuthProxy returns same instance on repeated calls', () => {
    const proxy1 = createWebAuthProxy();
    const proxy2 = createWebAuthProxy();
    expect(proxy1).toBe(proxy2);
  });

  it('getWebAuthProxy returns the created instance', () => {
    const created = createWebAuthProxy();
    const retrieved = getWebAuthProxy();
    expect(retrieved).toBe(created);
  });
});
