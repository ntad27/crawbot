/**
 * WebAuth Proxy Server — OpenAI-compatible HTTP API
 *
 * Exposes /v1/chat/completions and /v1/models endpoints.
 * Routes requests to the correct provider based on model prefix.
 * Transforms provider-specific SSE to OpenAI SSE format.
 */

import http from 'node:http';
import { logger } from '../utils/logger';
import type { WebProvider, OpenAIChatRequest, WebviewLike } from './providers/types';

const LOG_TAG = '[WebAuth-Proxy]';

export class WebAuthProxy {
  private server: http.Server | null = null;
  private _port = 0;
  private _running = false;

  /** Registered providers */
  private providers = new Map<string, WebProvider>();

  /** Webview lookup: providerId → webview instance */
  private webviews = new Map<string, WebviewLike>();

  get port(): number { return this._port; }
  get isRunning(): boolean { return this._running; }

  registerProvider(provider: WebProvider): void {
    this.providers.set(provider.id, provider);
  }

  setWebview(providerId: string, webview: WebviewLike): void {
    this.webviews.set(providerId, webview);
  }

  removeWebview(providerId: string): void {
    this.webviews.delete(providerId);
  }

  async start(preferredPort = 0): Promise<number> {
    if (this._running) return this._port;

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          logger.error(`${LOG_TAG} Request error:`, err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Internal server error', type: 'server_error' } }));
          }
        });
      });

      this.server.listen(preferredPort, '127.0.0.1', () => {
        const addr = this.server!.address();
        this._port = typeof addr === 'object' && addr ? addr.port : preferredPort;
        this._running = true;
        logger.info(`${LOG_TAG} Listening on 127.0.0.1:${this._port}`);
        resolve(this._port);
      });

      this.server.on('error', reject);
    });
  }

  async stop(): Promise<void> {
    if (!this._running || !this.server) return;
    this._running = false;

    return new Promise((resolve) => {
      this.server!.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  // ── Request Router ──

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url || '/';
    const method = req.method || 'GET';

    // CORS headers for local access
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url === '/v1/models' && method === 'GET') {
      return this.handleListModels(res);
    }

    if (url === '/v1/chat/completions' && method === 'POST') {
      const body = await readBody(req);
      return this.handleChatCompletion(body, res);
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Not found', type: 'invalid_request_error' } }));
  }

  // ── GET /v1/models ──

  private handleListModels(res: http.ServerResponse): void {
    const models: unknown[] = [];

    for (const provider of this.providers.values()) {
      if (this.webviews.has(provider.id)) {
        for (const model of provider.models) {
          models.push({
            id: model.id,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: `webauth-${provider.id}`,
          });
        }
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: models }));
  }

  // ── POST /v1/chat/completions ──

  private async handleChatCompletion(body: string, res: http.ServerResponse): Promise<void> {
    let request: OpenAIChatRequest;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid JSON', type: 'invalid_request_error' } }));
      return;
    }

    // Find provider by model prefix: "webauth-claude-sonnet-4" → "claude"
    const { provider, webview } = this.findProviderForModel(request.model);
    if (!provider || !webview) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: `Model ${request.model} not found or provider not authenticated`,
          type: 'invalid_request_error',
        },
      }));
      return;
    }

    // Log what OpenClaw sends
    const roles = request.messages.map((m: { role: string; content: unknown }) => m.role);
    logger.info(`${LOG_TAG} Chat: model=${request.model} msgs=${request.messages.length} roles=[${roles}]`);

    // Stream SSE response
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    try {
      const stream = provider.chatCompletion(webview, request);
      for await (const chunk of stream) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
      res.write('data: [DONE]\n\n');
    } catch (err) {
      const errorChunk = {
        error: { message: String(err), type: 'server_error' },
      };
      res.write(`data: ${JSON.stringify(errorChunk)}\n\n`);
    }

    res.end();
  }

  // ── Provider Lookup ──

  private findProviderForModel(modelId: string): {
    provider: WebProvider | null;
    webview: WebviewLike | null;
  } {
    for (const provider of this.providers.values()) {
      if (provider.models.some((m) => m.id === modelId)) {
        const webview = this.webviews.get(provider.id) ?? null;
        return { provider, webview };
      }
    }
    return { provider: null, webview: null };
  }
}

// ── Helpers ──

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** Singleton */
let proxyInstance: WebAuthProxy | null = null;

export function getWebAuthProxy(): WebAuthProxy | null {
  return proxyInstance;
}

export function createWebAuthProxy(): WebAuthProxy {
  if (!proxyInstance) {
    proxyInstance = new WebAuthProxy();
  }
  return proxyInstance;
}
