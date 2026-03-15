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
import { webContents } from 'electron';
import { browserManager } from './manager';
import { automationViews } from './automation-views';
import { logger } from '../utils/logger';

/** Map page-level WS paths to their webContents ID for printToPDF interception */
function findWebContentsForTarget(targetPath: string): Electron.WebContents | null {
  // targetPath looks like /devtools/page/<targetId>
  // We need to match it to an automation tab's webContents
  const allWc = webContents.getAllWebContents();
  for (const wc of allWc) {
    // Electron assigns numeric IDs that appear in CDP target paths
    const debuggerUrl = `/devtools/page/${wc.id}`;
    if (targetPath === debuggerUrl) return wc;
  }
  // Also try matching by looking for the ID after the last /
  const idPart = targetPath.split('/').pop();
  if (idPart) {
    for (const wc of allWc) {
      if (String(wc.id) === idPart) return wc;
    }
  }
  return null;
}

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

    // Normalize trailing slash for URL matching
    const normalizedUrl = url.endsWith('/') ? url.slice(0, -1) : url;

    if (normalizedUrl === '/json/list' || normalizedUrl === '/json') {
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

      // Rewrite ports in URLs (no type rewriting needed — WebContentsView
      // tabs are natively type: "page" in CDP)
      const rewritten = filtered.map((t: Record<string, unknown>) =>
        this.rewritePorts(t, realCdpPort, proxyPort)
      );

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rewritten));
    } else if (normalizedUrl.startsWith('/json/new')) {
      // Electron doesn't support Target.createTarget via CDP.
      // Create a real BrowserWindow as a CDP-controllable page.
      const targetUrl = normalizedUrl.split('?')[1] || 'about:blank';
      const target = await this.createCdpPage(targetUrl, realCdpPort, proxyPort);
      if (target) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(target));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create page' }));
      }
    } else if (normalizedUrl === '/json/version') {
      const realRes = await this.fetchFromRealCdp(realCdpPort, '/json/version');
      const version = JSON.parse(realRes);
      const rewritten = this.rewritePorts(version, realCdpPort, proxyPort);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rewritten));
    } else if (normalizedUrl === '/json/protocol') {
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

    // Track printToPDF requests to intercept error responses
    const pendingPdfRequests = new Map<number, { params: Record<string, unknown>; sessionId?: string; targetPath: string }>();

    // Buffer messages from client until real WS is open
    const pendingMessages: { data: Buffer | ArrayBuffer | Buffer[]; isBinary: boolean }[] = [];
    let realWsReady = false;

    realWs.on('open', () => {
      logger.info(`${LOG_TAG} WS relay open: ${targetPath}`);
      realWsReady = true;
      // Flush buffered messages
      for (const msg of pendingMessages) {
        realWs.send(msg.data, { binary: msg.isBinary });
      }
      pendingMessages.length = 0;
    });

    // Relay: client → real CDP (buffer if not ready)
    // Intercept commands that Electron doesn't support natively
    clientWs.on('message', (data, isBinary) => {
      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());
          // Intercept Target.activateTarget to sync tab switch in CrawBot UI
          if (msg.method === 'Target.activateTarget' && msg.params?.targetId) {
            logger.info(`${LOG_TAG} Intercepted Target.activateTarget: ${msg.params.targetId}`);
            this.activateTabByTargetId(msg.params.targetId, realCdpPort);
          }

          // Rewrite Target.setAutoAttach to disable waitForDebuggerOnStart
          // In Electron, waitForDebuggerOnStart pauses ALL targets (including
          // internal ones) and there's no reliable way to resume them. This
          // prevents Playwright's connectOverCDP from breaking existing tabs.
          if (msg.method === 'Target.setAutoAttach' && msg.params?.waitForDebuggerOnStart) {
            logger.info(`${LOG_TAG} Rewriting setAutoAttach: waitForDebuggerOnStart=false`);
            msg.params.waitForDebuggerOnStart = false;
            // Replace the forwarded data with the modified message
            const modifiedData = JSON.stringify(msg);
            if (realWsReady && realWs.readyState === WebSocket.OPEN) {
              realWs.send(modifiedData, { binary: false });
            } else {
              pendingMessages.push({ data: Buffer.from(modifiedData), isBinary: false });
            }
            return; // Don't forward the original
          }

          // Intercept Target.createTarget — Electron doesn't support it
          if (msg.method === 'Target.createTarget') {
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

          // Track Page.printToPDF requests by id+sessionId so we can
          // intercept the ERROR response from real CDP and replace with
          // Electron's webContents.printToPDF() result (which works in headed mode).
          // IMPORTANT: we forward the request to real CDP (so Playwright's
          // internal state tracking stays consistent), then intercept the
          // error response and replace it with our success response.
          if (msg.method === 'Page.printToPDF') {
            logger.info(`${LOG_TAG} Tracking Page.printToPDF id=${msg.id} sessionId=${msg.sessionId || 'none'}`);
            pendingPdfRequests.set(msg.id, {
              params: msg.params || {},
              sessionId: msg.sessionId,
              targetPath,
            });
            // Forward to real CDP — don't intercept the request
          }
        } catch {
          // Not JSON, forward as-is
        }
      }

      if (realWsReady && realWs.readyState === WebSocket.OPEN) {
        realWs.send(data, { binary: isBinary });
      } else {
        pendingMessages.push({ data: data as Buffer, isBinary });
      }
    });

    // Relay: real CDP → client
    // Filter Target events to hide main app window and internal targets
    realWs.on('message', (data, isBinary) => {
      if (clientWs.readyState !== WebSocket.OPEN) return;

      if (!isBinary) {
        try {
          const msg = JSON.parse(data.toString());

          // Intercept Page.printToPDF ERROR response — replace with Electron API result
          if (msg.id && msg.error && pendingPdfRequests.has(msg.id)) {
            const pdfReq = pendingPdfRequests.get(msg.id)!;
            pendingPdfRequests.delete(msg.id);
            logger.info(`${LOG_TAG} printToPDF CDP error intercepted, using Electron API`);

            // Use Electron's printToPDF which works in headed mode
            this.handlePrintToPdf(
              { id: msg.id, params: pdfReq.params },
              clientWs,
              pdfReq.targetPath,
              pdfReq.sessionId // Pass sessionId for correct Playwright session
            ).catch((err) => {
              logger.error(`${LOG_TAG} Electron printToPDF also failed:`, err);
              // Forward original CDP error if our fallback also fails
              clientWs.send(data, { binary: isBinary });
            });
            return; // Don't forward the CDP error
          }
          // Clean up successful PDF responses (CDP somehow worked)
          if (msg.id && msg.result && pendingPdfRequests.has(msg.id)) {
            pendingPdfRequests.delete(msg.id);
          }

          // Filter Target.getTargets response — hide main app window
          if (msg.result?.targetInfos) {
            msg.result.targetInfos = msg.result.targetInfos.filter(
              (t: { url?: string }) => !this.isInternalTarget(t.url)
            );
            clientWs.send(JSON.stringify(msg), { binary: false });
            return;
          }

          // Filter Target.attachedToTarget events for internal targets
          // (prevents Playwright from trying to initialize the main window)
          if (msg.method === 'Target.attachedToTarget' && msg.params?.targetInfo) {
            if (this.isInternalTarget(msg.params.targetInfo.url)) {
              logger.info(`${LOG_TAG} Suppressing attachedToTarget for internal: ${msg.params.targetInfo.url}`);
              return; // Don't forward to client
            }
          }

          // Filter Target.targetCreated events for internal targets
          if (msg.method === 'Target.targetCreated' && msg.params?.targetInfo) {
            if (this.isInternalTarget(msg.params.targetInfo.url)) {
              return; // Don't forward to client
            }
          }

          // Filter Target.targetInfoChanged events for internal targets
          if (msg.method === 'Target.targetInfoChanged' && msg.params?.targetInfo) {
            if (this.isInternalTarget(msg.params.targetInfo.url)) {
              return; // Don't forward to client
            }
          }
        } catch {
          // Not valid JSON — forward as-is
        }
      }

      clientWs.send(data, { binary: isBinary });
    });

    // Close propagation
    clientWs.on('close', (code, reason) => {
      logger.info(`${LOG_TAG} Client WS closed for ${targetPath}: code=${code}`);
      if (realWs.readyState === WebSocket.OPEN || realWs.readyState === WebSocket.CONNECTING) {
        realWs.close();
      }
    });

    realWs.on('close', (code, reason) => {
      logger.info(`${LOG_TAG} Real WS closed for ${targetPath}: code=${code}`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close();
      }
    });

    // Error handling
    clientWs.on('error', (err) => {
      logger.error(`${LOG_TAG} Client WS error for ${targetPath}:`, err.message);
      realWs.close();
    });

    realWs.on('error', (err) => {
      logger.error(`${LOG_TAG} Real CDP WS error for ${targetPath}:`, err.message);
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

  // ── Create new tab via AutomationViews for CDP automation ──

  private async createCdpPage(
    url: string,
    realCdpPort: number,
    proxyPort: number
  ): Promise<Record<string, unknown> | null> {
    try {
      // Create a WebContentsView tab (appears as type: "page" in CDP natively)
      const tabId = `cdp-new-${Date.now()}`;
      const tab = automationViews.createTab(tabId, url || 'about:blank');

      // Notify renderer about the new tab
      automationViews.notifyRendererPublic('browser:tab:created', tabId, {
        id: tabId,
        url: url || 'about:blank',
        title: 'New Tab',
        isLoading: true,
      });

      // Wait for CDP to register the new target
      const wcId = tab.view.webContents.id;
      let target: Record<string, unknown> | null = null;

      // Poll for the target to appear in CDP (up to 3 seconds)
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const listRes = await this.fetchFromRealCdp(realCdpPort, '/json/list');
          const targets = JSON.parse(listRes);
          // Match by webContents ID — Electron uses numeric IDs
          target = targets.find(
            (t: { id?: string; type?: string }) =>
              t.type === 'page' && String(t.id) === String(wcId)
          );
          // If not found by ID, try matching by URL for newly navigated pages
          if (!target && url && url !== 'about:blank') {
            target = targets.find(
              (t: { url?: string; type?: string }) =>
                t.type === 'page' && t.url === url
            );
          }
          if (target) break;
        } catch { /* retry */ }
      }

      if (target) {
        return this.rewritePorts(target as Record<string, unknown>, realCdpPort, proxyPort);
      }

      // Fallback: find the newest page target that isn't the main app
      const listRes = await this.fetchFromRealCdp(realCdpPort, '/json/list');
      const targets = JSON.parse(listRes);
      const pageTargets = targets.filter(
        (t: { type?: string; url?: string }) =>
          t.type === 'page' &&
          !t.url?.startsWith('http://localhost:5173') &&
          !t.url?.startsWith('http://127.0.0.1:5173') &&
          !t.url?.startsWith('http://localhost:23333') &&
          !t.url?.startsWith('file://') &&
          !t.url?.startsWith('devtools://')
      );
      if (pageTargets.length > 0) {
        return this.rewritePorts(pageTargets[pageTargets.length - 1], realCdpPort, proxyPort);
      }

      logger.warn(`${LOG_TAG} createCdpPage: target not found after creation`);
      return null;
    } catch (err) {
      logger.error(`${LOG_TAG} createCdpPage failed:`, err);
      return null;
    }
  }

  /** Activate the CrawBot browser tab matching a CDP targetId */
  private async activateTabByTargetId(targetId: string, realCdpPort: number): Promise<void> {
    try {
      // Get target info from real CDP
      const listRes = await this.fetchFromRealCdp(realCdpPort, '/json/list');
      const targets = JSON.parse(listRes);
      const target = targets.find((t: { id: string }) => t.id === targetId);
      if (target?.url) {
        const wcId = automationViews.findWebContentsIdByUrl(target.url);
        if (wcId != null) {
          automationViews.activateByWebContentsId(wcId);
        }
      }
    } catch {
      // ignore
    }
  }

  /** Check if a target URL belongs to CrawBot's internal windows/pages */
  private isInternalTarget(url?: string): boolean {
    if (!url) return false;
    return url.startsWith('http://localhost:5173') ||
           url.startsWith('http://127.0.0.1:5173') ||
           url.startsWith('http://localhost:23333') ||
           url.startsWith('http://127.0.0.1:23333') ||
           url.startsWith('file://') ||
           url.startsWith('devtools://');
  }

  /** Handle Page.printToPDF via Electron's webContents.printToPDF() API */
  private async handlePrintToPdf(
    msg: { id: number; params?: Record<string, unknown> },
    clientWs: WebSocket,
    targetPath: string,
    sessionId?: string
  ): Promise<void> {
    try {
      // Find webContents by matching CDP targetId to real CDP /json/list
      const cdpTargetId = targetPath.split('/').pop() || '';
      let wc: Electron.WebContents | null = null;

      // Get target URL from real CDP
      const listRes = await this.fetchFromRealCdp(this.options.realCdpPort, '/json/list');
      const targets = JSON.parse(listRes);
      const target = targets.find((t: { id: string }) => t.id === cdpTargetId);

      if (target?.url) {
        // Find matching automation tab by URL
        for (const tab of automationViews.getAllTabs()) {
          if (tab.view.webContents.getURL() === target.url) {
            wc = tab.view.webContents;
            break;
          }
        }
        // Fallback: search all webContents
        if (!wc) {
          for (const contents of webContents.getAllWebContents()) {
            if (contents.getURL() === target.url) {
              wc = contents;
              break;
            }
          }
        }
      }

      if (!wc) {
        // Last resort: use the active automation tab
        const activeId = automationViews.getActiveTabId();
        if (activeId) {
          const activeTab = automationViews.getTab(activeId);
          if (activeTab) wc = activeTab.view.webContents;
        }
      }

      if (!wc) {
        throw new Error('Could not find webContents for PDF target');
      }

      logger.info(`${LOG_TAG} printToPDF: using webContents id=${wc.id} url=${wc.getURL().substring(0, 50)}`);

      // Convert CDP params to Electron's printToPDF options
      const p = msg.params || {};
      const pdfOptions: Electron.PrintToPDFOptions = {
        printBackground: (p.printBackground as boolean) ?? true,
      };
      if (p.landscape) pdfOptions.landscape = true;
      if (p.scale) pdfOptions.scale = p.scale as number;
      if (p.paperWidth || p.paperHeight) {
        pdfOptions.pageSize = {
          width: ((p.paperWidth as number) || 8.5) * 25400,
          height: ((p.paperHeight as number) || 11) * 25400,
        };
      }
      if (p.marginTop !== undefined || p.marginBottom !== undefined ||
          p.marginLeft !== undefined || p.marginRight !== undefined) {
        pdfOptions.margins = {
          top: ((p.marginTop as number) || 0) * 96,
          bottom: ((p.marginBottom as number) || 0) * 96,
          left: ((p.marginLeft as number) || 0) * 96,
          right: ((p.marginRight as number) || 0) * 96,
        };
      }

      const pdfBuffer = await wc.printToPDF(pdfOptions);
      const base64Data = pdfBuffer.toString('base64');

      const response: Record<string, unknown> = {
        id: msg.id,
        result: { data: base64Data },
      };
      // Include sessionId if present (flattened CDP session from Playwright)
      if (sessionId) response.sessionId = sessionId;

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(response));
      }
      logger.info(`${LOG_TAG} printToPDF success: ${Math.round(pdfBuffer.length / 1024)}KB sessionId=${sessionId || 'none'}`);
    } catch (err) {
      logger.error(`${LOG_TAG} printToPDF failed:`, err);
      const errResponse: Record<string, unknown> = {
        id: msg.id,
        error: { code: -32000, message: `printToPDF failed: ${(err as Error).message}` },
      };
      if (sessionId) errResponse.sessionId = sessionId;

      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(errResponse));
      }
    }
  }

  private isTargetAllowed(
    target: { id: string; url?: string; type?: string },
    _exposed: Set<number>
  ): boolean {
    if (this.isInternalTarget(target.url)) return false;

    // Allow both page AND webview types
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
