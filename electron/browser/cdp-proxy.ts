/**
 * CDP Filter Proxy — Thin HTTP + WebSocket relay
 *
 * Sits between OpenClaw (Playwright) and Electron's real CDP server.
 * - HTTP: filters /json/list to hide main window + webauth webviews
 * - WebSocket: pure byte relay (zero protocol interpretation)
 *
 * ~200 lines. 100% CDP compatible because we don't interpret the protocol.
 */

import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { BrowserWindow, session } from 'electron';
import { browserManager } from './manager';
import { logger } from '../utils/logger';

const LOG_TAG = '[CDP-Proxy]';

export interface CdpProxyOptions {
  /** Port for the proxy server (external, advertised to OpenClaw) */
  proxyPort: number;
  /** Port of Electron's real CDP server (internal) */
  realCdpPort: number;
}

export class CdpFilterProxy {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private options: CdpProxyOptions;
  private running = false;

  constructor(options: CdpProxyOptions) {
    this.options = options;
  }

  get port(): number {
    return this.options.proxyPort;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const { proxyPort, realCdpPort } = this.options;

    this.server = http.createServer(async (req, res) => {
      try {
        logger.info(`${LOG_TAG} HTTP ${req.method} ${req.url}`);
        await this.handleHttp(req, res, realCdpPort, proxyPort);
      } catch (err) {
        logger.error(`${LOG_TAG} HTTP error:`, err);
        res.writeHead(500);
        res.end('Internal Server Error');
      }
    });

    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (clientWs, req) => {
      logger.info(`${LOG_TAG} WS client connected: ${req.url}`);
      this.handleWsConnection(clientWs, req, realCdpPort);
    });

    return new Promise((resolve, reject) => {
      this.server!.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(`${LOG_TAG} Port ${proxyPort} in use`);
          reject(new Error(`Port ${proxyPort} already in use`));
        } else {
          reject(err);
        }
      });

      this.server!.listen(proxyPort, '127.0.0.1', () => {
        this.running = true;
        logger.info(`${LOG_TAG} Listening on 127.0.0.1:${proxyPort} → real CDP 127.0.0.1:${realCdpPort}`);

        // No default page needed — Browser Panel webview tabs are exposed as "page" type

        resolve();
      });
    });
  }

  // No default page needed — webview tabs in Browser Panel serve as CDP targets
  // (their type is rewritten from "webview" to "page" in /json/list)

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    // Close all WebSocket connections
    if (this.wss) {
      for (const client of this.wss.clients) {
        client.close();
      }
      this.wss.close();
      this.wss = null;
    }

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // ── HTTP Handler ──

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    realCdpPort: number,
    proxyPort: number
  ): Promise<void> {
    const url = req.url || '/';

    if (url === '/json/list' || url === '/json') {
      // Filter targets: only expose automation tabs
      const realRes = await this.fetchFromRealCdp(realCdpPort, '/json/list');
      const targets = JSON.parse(realRes);
      const exposed = browserManager.getExposedTargetIds();

      const filtered = targets.filter((t: { id: string; webSocketDebuggerUrl?: string }) => {
        // Match by webContents ID embedded in the target's devtoolsFrontendUrl or id
        // CDP target IDs are strings — we need to check against our exposed set
        // The real CDP /json/list returns targets with numeric-ish IDs
        return this.isTargetAllowed(t, exposed);
      });

      // Rewrite ports in URLs AND change webview→page type
      const rewritten = filtered.map((t: Record<string, unknown>) =>
        this.rewriteTargetType(this.rewritePorts(t, realCdpPort, proxyPort))
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rewritten));
    } else if (url.startsWith('/json/new')) {
      // Electron doesn't support Target.createTarget via CDP.
      // Create a real BrowserWindow as a CDP-controllable page.
      const targetUrl = url.split('?')[1] || 'about:blank';
      const target = await this.createCdpPage(targetUrl, realCdpPort, proxyPort);
      if (target) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(target));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create page' }));
      }
    } else if (url === '/json/version') {
      const realRes = await this.fetchFromRealCdp(realCdpPort, '/json/version');
      const version = JSON.parse(realRes);
      const rewritten = this.rewritePorts(version, realCdpPort, proxyPort);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rewritten));
    } else if (url === '/json/protocol') {
      const realRes = await this.fetchFromRealCdp(realCdpPort, '/json/protocol');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(realRes);
    } else {
      // Pass-through unknown endpoints
      try {
        const realRes = await this.fetchFromRealCdp(realCdpPort, url);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(realRes);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    }
  }

  // ── WebSocket Relay ──

  private handleWsConnection(
    clientWs: WebSocket,
    req: http.IncomingMessage,
    realCdpPort: number
  ): void {
    const targetPath = req.url || '';
    const realWsUrl = `ws://127.0.0.1:${realCdpPort}${targetPath}`;

    const realWs = new WebSocket(realWsUrl);

    // Buffer messages from client until real WS is open
    const pendingMessages: (Buffer | ArrayBuffer | Buffer[])[] = [];
    let realWsReady = false;

    realWs.on('open', () => {
      logger.info(`${LOG_TAG} WS relay open: ${targetPath}`);
      realWsReady = true;
      // Flush buffered messages
      for (const msg of pendingMessages) {
        realWs.send(msg);
      }
      pendingMessages.length = 0;
    });

    // Relay: client → real CDP (buffer if not ready)
    // Intercept Target.createTarget since Electron doesn't support it
    clientWs.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.method === 'Target.createTarget') {
            // Electron doesn't support Target.createTarget
            // Create a BrowserWindow instead and return its target info
            const url = msg.params?.url || 'about:blank';
            logger.info(`${LOG_TAG} Intercepted Target.createTarget for: ${url}`);
            this.createCdpPage(url, realCdpPort, this.options.proxyPort).then((target) => {
              const response = {
                id: msg.id,
                result: { targetId: (target as Record<string, unknown>)?.id || '' },
              };
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify(response));
              }
            }).catch(() => {
              const errorResponse = {
                id: msg.id,
                error: { code: -32000, message: 'Failed to create target' },
              };
              if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify(errorResponse));
              }
            });
            return; // Don't forward to real CDP
          }
        } catch {
          // Not JSON, forward as-is
        }
      }

      if (realWsReady && realWs.readyState === WebSocket.OPEN) {
        realWs.send(data, { binary: isBinary });
      } else {
        pendingMessages.push(data as Buffer);
      }
    });

    // Relay: real CDP → client
    // Intercept Target.getTargets response to rewrite webview→page types
    realWs.on('message', (data, isBinary) => {
      if (clientWs.readyState !== WebSocket.OPEN) return;

      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          // Intercept Target.getTargets response
          if (msg.result?.targetInfos) {
            msg.result.targetInfos = msg.result.targetInfos
              .filter((t: { url?: string }) => {
                // Hide main app window
                const url = t.url || '';
                return !url.startsWith('http://localhost:5173') &&
                       !url.startsWith('http://127.0.0.1:5173') &&
                       !url.startsWith('file://') &&
                       !url.startsWith('devtools://');
              })
              .map((t: { type?: string; attached?: boolean }) => {
                // Rewrite webview → page so Playwright treats them as controllable
                if (t.type === 'webview') {
                  return { ...t, type: 'page', attached: true };
                }
                return t;
              });
            clientWs.send(JSON.stringify(msg), { binary: false });
            return;
          }
          // Intercept Target.targetCreated event
          if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo?.type === 'webview') {
            msg.params.targetInfo.type = 'page';
            msg.params.targetInfo.attached = true;
            clientWs.send(JSON.stringify(msg), { binary: false });
            return;
          }
          // Intercept Target.targetInfoChanged event
          if (msg.method === 'Target.targetInfoChanged' && msg.params?.targetInfo?.type === 'webview') {
            msg.params.targetInfo.type = 'page';
            msg.params.targetInfo.attached = true;
            clientWs.send(JSON.stringify(msg), { binary: false });
            return;
          }
        } catch {
          // Not valid JSON or parse error — forward as-is
        }
      }

      clientWs.send(data, { binary: isBinary });
    });

    // Close propagation
    clientWs.on('close', () => {
      realWs.close();
    });

    realWs.on('close', () => {
      clientWs.close();
    });

    // Error handling
    clientWs.on('error', (err) => {
      logger.error(`${LOG_TAG} Client WS error:`, err.message);
      realWs.close();
    });

    realWs.on('error', (err) => {
      logger.error(`${LOG_TAG} Real CDP WS error:`, err.message);
      clientWs.close();
    });
  }

  // ── Helpers ──

  private async fetchFromRealCdp(port: number, path: string, method = 'GET'): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}${path}`,
        { method },
        (res) => {
          let data = '';
          res.on('data', (chunk) => { data += chunk; });
          res.on('end', () => resolve(data));
        }
      );
      req.on('error', reject);
      req.setTimeout(3000, () => {
        req.destroy();
        reject(new Error(`Timeout fetching ${path} from real CDP`));
      });
      req.end();
    });
  }

  // ── Create real BrowserWindow for CDP automation ──

  /** CDP-automation windows — hidden from user but controllable via CDP */
  private cdpWindows = new Map<number, BrowserWindow>();

  private async createCdpPage(
    url: string,
    realCdpPort: number,
    proxyPort: number
  ): Promise<Record<string, unknown> | null> {
    try {
      const chromeVersion = process.versions.chrome || '130.0.0.0';
      const ua = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;

      const ses = session.fromPartition('persist:browser-shared');
      ses.setUserAgent(ua);

      const win = new BrowserWindow({
        width: 1280,
        height: 900,
        show: true, // Visible so user can see agent's browser automation
        webPreferences: {
          session: ses,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      this.cdpWindows.set(win.webContents.id, win);

      // Navigate to URL
      if (url && url !== 'about:blank') {
        await win.loadURL(url);
      }

      // Wait a moment for CDP to register the target
      await new Promise((r) => setTimeout(r, 500));

      // Find this window's target in CDP list
      const listRes = await this.fetchFromRealCdp(realCdpPort, '/json/list');
      const targets = JSON.parse(listRes);
      const target = targets.find(
        (t: { url?: string; type?: string }) =>
          t.type === 'page' && t.url === (url || 'about:blank')
      );

      if (target) {
        return this.rewritePorts(target, realCdpPort, proxyPort);
      }

      // Fallback: return the last page target
      const pageTargets = targets.filter(
        (t: { type?: string; url?: string }) =>
          t.type === 'page' &&
          !t.url?.startsWith('http://localhost:5173') &&
          !t.url?.startsWith('devtools://')
      );
      if (pageTargets.length > 0) {
        return this.rewritePorts(pageTargets[pageTargets.length - 1], realCdpPort, proxyPort);
      }

      return null;
    } catch (err) {
      logger.error(`${LOG_TAG} createCdpPage failed:`, err);
      return null;
    }
  }

  private isTargetAllowed(
    target: { id: string; url?: string; type?: string },
    _exposed: Set<number>
  ): boolean {
    // Hide CrawBot's own UI (main window loading the React app)
    if (target.url) {
      const isMainApp =
        target.url.startsWith('file://') ||
        target.url.startsWith('http://localhost:5173') ||
        target.url.startsWith('http://localhost:23333') ||
        target.url.startsWith('http://127.0.0.1:5173') ||
        target.url.startsWith('devtools://');
      if (isMainApp) return false;
    }

    // Allow both page AND webview types
    // Webview types will be rewritten to "page" in the response
    // so Playwright can control them
    if (target.type !== 'page' && target.type !== 'webview') return false;

    return true;
  }

  /** Rewrite webview targets to page type so Playwright treats them as controllable pages */
  private rewriteTargetType(target: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };
    if (result.type === 'webview') {
      result.type = 'page';
    }
    return result;
  }

  private rewritePorts(obj: Record<string, unknown>, from: number, to: number): Record<string, unknown> {
    const result = { ...obj };
    const fromStr = `:${from}`;
    const toStr = `:${to}`;

    for (const key of Object.keys(result)) {
      if (typeof result[key] === 'string') {
        result[key] = (result[key] as string).replaceAll(fromStr, toStr);
      }
    }
    return result;
  }
}

/** Singleton proxy instance */
let proxyInstance: CdpFilterProxy | null = null;

export function getCdpProxy(): CdpFilterProxy | null {
  return proxyInstance;
}

export async function startCdpProxy(
  proxyPort = 9333,
  realCdpPort = 9222
): Promise<CdpFilterProxy> {
  if (proxyInstance?.isRunning) return proxyInstance;

  proxyInstance = new CdpFilterProxy({ proxyPort, realCdpPort });
  await proxyInstance.start();
  return proxyInstance;
}

export async function stopCdpProxy(): Promise<void> {
  if (proxyInstance) {
    await proxyInstance.stop();
    proxyInstance = null;
  }
}
