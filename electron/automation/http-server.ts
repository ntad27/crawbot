/**
 * HTTP Server
 * Lightweight local HTTP server for webhook ingestion and REST API access.
 * Uses only Node.js built-in modules (http, crypto, url).
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import type { GatewayManager } from '../gateway/manager';
import type { HttpServerConfig, WebhookLogEntry } from './webhook-types';
import { webhookStore } from './webhook-store';
import { rateLimiter } from './rate-limiter';
import { automationEventBus } from './event-bus';
import { logger } from '../utils/logger';

const DEFAULT_PORT = 18790;
const DEFAULT_BIND = '127.0.0.1';
const MAX_BODY_BYTES = 1_048_576; // 1 MB

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let storeInstance: any = null;

async function getStore() {
  if (!storeInstance) {
    const Store = (await import('electron-store')).default;
    storeInstance = new Store({ name: 'automation' });
  }
  return storeInstance;
}

// ---- HMAC verification -------------------------------------------------------

function verifyWebhookSignature(
  secret: string,
  body: string,
  signature: string,
  timestamp: string,
): boolean {
  // Validate timestamp is within 300s
  const ts = parseInt(timestamp, 10);
  if (isNaN(ts)) return false;
  const ageSec = Math.abs(Date.now() / 1000 - ts);
  if (ageSec > 300) return false;

  // Compute expected HMAC-SHA256(secret, timestamp + '.' + body)
  const mac = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  const expected = Buffer.from(`sha256=${mac}`, 'utf8');
  const received = Buffer.from(signature, 'utf8');

  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

// ---- Body reader -------------------------------------------------------------

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      data += chunk.toString('utf8');
    });

    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ---- Simple JSON response helper --------------------------------------------

function jsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Access-Control-Allow-Origin': 'null', // same-origin only
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(payload);
}

// ---- HTTP Server class -------------------------------------------------------

export class HttpServer {
  private server: http.Server | null = null;
  private gatewayManager: GatewayManager | null = null;
  private startedAt: number | null = null;
  private _config: HttpServerConfig = {
    port: DEFAULT_PORT,
    bindAddress: DEFAULT_BIND,
    enabled: false,
  };

  // ---- Lifecycle ----

  async start(gatewayManager: GatewayManager): Promise<void> {
    this.gatewayManager = gatewayManager;

    // Load persisted config
    const store = await getStore();
    const saved = store.get('automation.httpServer') as HttpServerConfig | undefined;
    if (saved) {
      this._config = { ...this._config, ...saved };
    }

    if (!this._config.enabled) {
      logger.debug('[HttpServer] Disabled — skipping start');
      return;
    }

    await this._listen();
  }

  private _listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server) {
        this.server.close();
        this.server = null;
      }

      this.server = http.createServer((req, res) => {
        this._handleRequest(req, res).catch((err) => {
          logger.warn(`[HttpServer] Unhandled error: ${String(err)}`);
          if (!res.headersSent) {
            jsonResponse(res, 500, { error: 'Internal server error' });
          }
        });
      });

      this.server.on('error', (err) => {
        logger.error(`[HttpServer] Server error: ${String(err)}`);
        reject(err);
      });

      this.server.listen(this._config.port, this._config.bindAddress, () => {
        this.startedAt = Date.now();
        logger.info(
          `[HttpServer] Listening on http://${this._config.bindAddress}:${this._config.port}`,
        );
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        this.startedAt = null;
        logger.info('[HttpServer] Stopped');
        resolve();
      });
    });
  }

  getStatus(): { running: boolean; port: number; bindAddress: string; uptimeMs: number | null } {
    return {
      running: !!this.server?.listening,
      port: this._config.port,
      bindAddress: this._config.bindAddress,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : null,
    };
  }

  getPort(): number {
    return this._config.port;
  }

  async getConfig(): Promise<HttpServerConfig> {
    return { ...this._config };
  }

  async updateConfig(config: Partial<HttpServerConfig>): Promise<HttpServerConfig> {
    const store = await getStore();
    this._config = { ...this._config, ...config };
    store.set('automation.httpServer', this._config);

    // Restart if running and config changed
    if (this.server) {
      await this.stop();
      if (this._config.enabled) {
        await this._listen();
      }
    } else if (this._config.enabled && this.gatewayManager) {
      await this._listen();
    }

    return { ...this._config };
  }

  // ---- API Key management ----

  async getApiKey(): Promise<string> {
    const store = await getStore();
    let apiKey = store.get('automation.apiKey') as string | undefined;
    if (!apiKey) {
      apiKey = crypto.randomBytes(32).toString('hex');
      store.set('automation.apiKey', apiKey);
    }
    return apiKey;
  }

  async regenerateApiKey(): Promise<string> {
    const store = await getStore();
    const apiKey = crypto.randomBytes(32).toString('hex');
    store.set('automation.apiKey', apiKey);
    return apiKey;
  }

  // ---- Request router -------------------------------------------------------

  private async _handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': 'null',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, X-Webhook-Signature, X-Webhook-Timestamp',
      });
      res.end();
      return;
    }

    const baseUrl = `http://${req.headers.host ?? 'localhost'}`;
    let url: URL;
    try {
      url = new URL(req.url ?? '/', baseUrl);
    } catch {
      jsonResponse(res, 400, { error: 'Bad request' });
      return;
    }

    const { pathname } = url;
    const method = req.method ?? 'GET';

    // POST /webhooks/:id
    const webhookMatch = pathname.match(/^\/webhooks\/([^/]+)$/);
    if (webhookMatch && method === 'POST') {
      await this._handleWebhookTrigger(req, res, webhookMatch[1]);
      return;
    }

    // GET /api/health
    if (pathname === '/api/health' && method === 'GET') {
      await this._handleHealth(res);
      return;
    }

    // REST API routes — require API key auth
    if (pathname.startsWith('/api/tasks')) {
      const authed = await this._requireApiKey(req, res);
      if (!authed) return;

      const taskIdMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);

      if (pathname === '/api/tasks') {
        if (method === 'GET') {
          await this._handleListTasks(res);
          return;
        }
        if (method === 'POST') {
          await this._handleCreateTask(req, res);
          return;
        }
      }

      if (taskIdMatch) {
        const taskId = taskIdMatch[1];
        if (method === 'GET') {
          await this._handleGetTask(res, taskId);
          return;
        }
        if (method === 'PUT') {
          await this._handleUpdateTask(req, res, taskId);
          return;
        }
        if (method === 'DELETE') {
          await this._handleDeleteTask(res, taskId);
          return;
        }
      }
    }

    jsonResponse(res, 404, { error: 'Not found' });
  }

  // ---- Webhook trigger handler ----------------------------------------------

  private async _handleWebhookTrigger(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    webhookId: string,
  ): Promise<void> {
    const startMs = Date.now();
    const requestId = crypto.randomUUID();
    const ip =
      (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ??
      req.socket.remoteAddress ??
      'unknown';

    // Look up webhook config
    const webhook = await webhookStore.getWebhook(webhookId);
    if (!webhook) {
      await this._logRequest({
        timestamp: new Date().toISOString(),
        webhookId,
        ip,
        statusCode: 404,
        payloadPreview: '',
        processingMs: Date.now() - startMs,
        requestId,
      });
      jsonResponse(res, 404, { error: 'Webhook not found' });
      return;
    }

    if (!webhook.enabled) {
      await this._logRequest({
        timestamp: new Date().toISOString(),
        webhookId,
        ip,
        statusCode: 403,
        payloadPreview: '',
        processingMs: Date.now() - startMs,
        requestId,
      });
      jsonResponse(res, 403, { error: 'Webhook disabled' });
      return;
    }

    // Rate limit check
    if (!rateLimiter.tryConsume(webhookId, webhook.rateLimit ?? 60)) {
      await this._logRequest({
        timestamp: new Date().toISOString(),
        webhookId,
        ip,
        statusCode: 429,
        payloadPreview: '',
        processingMs: Date.now() - startMs,
        requestId,
      });
      jsonResponse(res, 429, { error: 'Rate limit exceeded' });
      return;
    }

    // Read body
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      jsonResponse(res, 413, { error: 'Payload too large' });
      return;
    }

    // Verify HMAC signature
    const signature = req.headers['x-webhook-signature'] as string | undefined;
    const timestamp = req.headers['x-webhook-timestamp'] as string | undefined;

    if (!signature || !timestamp) {
      await this._logRequest({
        timestamp: new Date().toISOString(),
        webhookId,
        ip,
        statusCode: 401,
        payloadPreview: body.slice(0, 200),
        processingMs: Date.now() - startMs,
        requestId,
      });
      jsonResponse(res, 401, { error: 'Missing signature headers' });
      return;
    }

    if (!verifyWebhookSignature(webhook.secret, body, signature, timestamp)) {
      await this._logRequest({
        timestamp: new Date().toISOString(),
        webhookId,
        ip,
        statusCode: 401,
        payloadPreview: body.slice(0, 200),
        processingMs: Date.now() - startMs,
        requestId,
      });
      jsonResponse(res, 401, { error: 'Invalid signature' });
      return;
    }

    // Parse body (optional — emit raw)
    let parsedPayload: unknown = body;
    try {
      parsedPayload = JSON.parse(body);
    } catch {
      // non-JSON body is fine
    }

    // Emit event on the automation event bus so TriggerManager can handle it
    automationEventBus.emit('webhook:trigger', { webhookId, jobId: webhook.jobId, payload: parsedPayload });

    // Also directly run the job if gateway is available
    if (this.gatewayManager) {
      this.gatewayManager
        .rpc('cron.run', { id: webhook.jobId, mode: 'force' })
        .catch((err: unknown) => {
          logger.warn(`[HttpServer] Failed to run job ${webhook.jobId}: ${String(err)}`);
        });
    }

    const processingMs = Date.now() - startMs;
    await this._logRequest({
      timestamp: new Date().toISOString(),
      webhookId,
      ip,
      statusCode: 200,
      payloadPreview: body.slice(0, 200),
      processingMs,
      requestId,
    });

    jsonResponse(res, 200, { ok: true, requestId });
  }

  // ---- Health check ---------------------------------------------------------

  private async _handleHealth(res: http.ServerResponse): Promise<void> {
    const webhooks = await webhookStore.listWebhooks();
    jsonResponse(res, 200, {
      status: 'ok',
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      webhookCount: webhooks.length,
      enabledWebhookCount: webhooks.filter((w) => w.enabled).length,
    });
  }

  // ---- Task REST API (proxied to Gateway RPC) --------------------------------

  private async _handleListTasks(res: http.ServerResponse): Promise<void> {
    try {
      const result = await this.gatewayManager!.rpc('cron.list', {});
      jsonResponse(res, 200, result);
    } catch (err) {
      jsonResponse(res, 502, { error: String(err) });
    }
  }

  private async _handleGetTask(res: http.ServerResponse, taskId: string): Promise<void> {
    try {
      const result = await this.gatewayManager!.rpc('cron.get', { id: taskId });
      jsonResponse(res, 200, result);
    } catch (err) {
      jsonResponse(res, 502, { error: String(err) });
    }
  }

  private async _handleCreateTask(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      jsonResponse(res, 413, { error: 'Payload too large' });
      return;
    }

    let params: unknown;
    try {
      params = JSON.parse(body);
    } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON' });
      return;
    }

    try {
      const result = await this.gatewayManager!.rpc('cron.add', params as Record<string, unknown>);
      jsonResponse(res, 201, result);
    } catch (err) {
      jsonResponse(res, 502, { error: String(err) });
    }
  }

  private async _handleUpdateTask(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    taskId: string,
  ): Promise<void> {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      jsonResponse(res, 413, { error: 'Payload too large' });
      return;
    }

    let params: unknown;
    try {
      params = JSON.parse(body);
    } catch {
      jsonResponse(res, 400, { error: 'Invalid JSON' });
      return;
    }

    try {
      const result = await this.gatewayManager!.rpc('cron.update', {
        id: taskId,
        ...(params as Record<string, unknown>),
      });
      jsonResponse(res, 200, result);
    } catch (err) {
      jsonResponse(res, 502, { error: String(err) });
    }
  }

  private async _handleDeleteTask(res: http.ServerResponse, taskId: string): Promise<void> {
    try {
      await this.gatewayManager!.rpc('cron.remove', { id: taskId });
      jsonResponse(res, 204, {});
    } catch (err) {
      jsonResponse(res, 502, { error: String(err) });
    }
  }

  // ---- Auth helper ----------------------------------------------------------

  private async _requireApiKey(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    const provided = req.headers['x-api-key'] as string | undefined;
    if (!provided) {
      jsonResponse(res, 401, { error: 'Missing X-API-Key header' });
      return false;
    }

    const apiKey = await this.getApiKey();
    const expectedBuf = Buffer.from(apiKey, 'utf8');
    const providedBuf = Buffer.from(provided, 'utf8');

    if (expectedBuf.length !== providedBuf.length || !crypto.timingSafeEqual(expectedBuf, providedBuf)) {
      jsonResponse(res, 403, { error: 'Invalid API key' });
      return false;
    }

    return true;
  }

  // ---- Log helper -----------------------------------------------------------

  private async _logRequest(entry: WebhookLogEntry): Promise<void> {
    try {
      await webhookStore.addLogEntry(entry);
    } catch (err) {
      logger.warn(`[HttpServer] Failed to log request: ${String(err)}`);
    }
  }
}

export const httpServer = new HttpServer();
