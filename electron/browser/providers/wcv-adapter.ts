/**
 * WebContentsView Adapter — makes WebContentsView implement WebviewLike
 *
 * Uses a persistent raw WebSocket CDP connection to port 9222 for
 * executeJavaScript, since Electron's webContents.executeJavaScript()
 * hangs on off-screen WebContentsViews.
 */

import type { WebviewLike } from './types';
import type { WebContentsView } from 'electron';
import WebSocket from 'ws';

const IPC_CHANNELS = [
  'crawbot:stream:chunk',
  'crawbot:stream:end',
  'crawbot:stream:error',
  'crawbot:response',
];

export class WebContentsViewAdapter implements WebviewLike {
  private _listenerMap = new Map<
    (...args: unknown[]) => void,
    Array<(...args: unknown[]) => void>
  >();
  private _ws: WebSocket | null = null;
  private _wsReady = false;
  private _msgId = 0;
  private _pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private _targetId: string | null = null;
  private _connecting: Promise<void> | null = null;

  constructor(private view: WebContentsView) {}

  /** Ensure persistent CDP WebSocket is connected */
  private async ensureConnection(): Promise<void> {
    if (this._wsReady && this._ws?.readyState === WebSocket.OPEN) return;
    if (this._connecting) return this._connecting;

    this._connecting = (async () => {
      // Find CDP target ID by matching webContents URL
      if (!this._targetId) {
        const http = await import('node:http');
        const targets: Array<{ id: string; url: string }> = await new Promise((resolve, reject) => {
          http.get('http://127.0.0.1:9222/json/list', (res) => {
            let d = '';
            res.on('data', (c: Buffer) => { d += c.toString(); });
            res.on('end', () => { try { resolve(JSON.parse(d)); } catch { reject(new Error('Parse error')); } });
          }).on('error', reject);
        });

        const currentUrl = this.view.webContents.getURL();
        // Match by URL or by domain
        let match = targets.find((t) => t.url === currentUrl);
        if (!match) {
          // Try domain match
          try {
            const domain = new URL(currentUrl).hostname;
            match = targets.find((t) => t.url.includes(domain));
          } catch { /* */ }
        }
        if (!match) throw new Error(`No CDP target found for ${currentUrl}`);
        this._targetId = match.id;
        console.log(`[WCV-Adapter] Found CDP target: ${this._targetId} for ${currentUrl}`);
      }

      // Connect WebSocket
      const wsUrl = `ws://127.0.0.1:9222/devtools/page/${this._targetId}`;
      await new Promise<void>((resolve, reject) => {
        this._ws = new WebSocket(wsUrl);
        this._ws.on('open', () => {
          this._wsReady = true;
          console.log(`[WCV-Adapter] CDP WebSocket connected to ${this._targetId}`);
          resolve();
        });
        this._ws.on('error', (err) => {
          this._wsReady = false;
          reject(err);
        });
        this._ws.on('close', () => {
          this._wsReady = false;
          // Reject all pending
          for (const [, p] of this._pending) {
            p.reject(new Error('CDP connection closed'));
          }
          this._pending.clear();
        });
        this._ws.on('message', (data) => {
          try {
            const msg = JSON.parse(data.toString());
            if (typeof msg.id === 'number') {
              const p = this._pending.get(msg.id);
              if (p) {
                this._pending.delete(msg.id);
                if (msg.error) {
                  p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                } else {
                  p.resolve(msg.result);
                }
              }
            }
          } catch { /* ignore non-JSON */ }
        });
        setTimeout(() => reject(new Error('CDP connect timeout')), 5000);
      });
    })();

    try {
      await this._connecting;
    } finally {
      this._connecting = null;
    }
  }

  async executeJavaScript(code: string): Promise<unknown> {
    if (this.view.webContents.isDestroyed()) {
      throw new Error('WebContentsView is destroyed');
    }

    await this.ensureConnection();

    const id = ++this._msgId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error('CDP evaluate timeout (30s)'));
      }, 30000);

      this._pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          const r = result as { result?: { value?: unknown; type?: string }; exceptionDetails?: { text?: string } };
          console.log(`[WCV-Adapter] evaluate id=${id} resolved: type=${r?.result?.type} exception=${r?.exceptionDetails?.text || 'none'}`);
          if (r?.exceptionDetails) {
            reject(new Error(r.exceptionDetails.text || 'JS error'));
          } else {
            resolve(r?.result?.value);
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      const snippet = code.substring(0, 80).replace(/\n/g, ' ');
      console.log(`[WCV-Adapter] evaluate id=${id} code="${snippet}..."`);
      this._ws!.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression: code, returnByValue: true, awaitPromise: true },
      }));
    });
  }

  addEventListener(event: string, listener: (...args: unknown[]) => void): void {
    if (event === 'ipc-message') {
      const wrappedListeners: Array<(...args: unknown[]) => void> = [];
      for (const channel of IPC_CHANNELS) {
        const wrapped = (_event: unknown, ...args: unknown[]) => {
          listener({ channel, args });
        };
        wrappedListeners.push(wrapped);
        this.view.webContents.ipc.on(channel, wrapped);
      }
      this._listenerMap.set(listener, wrappedListeners);
    }
  }

  removeEventListener(event: string, listener: (...args: unknown[]) => void): void {
    if (event === 'ipc-message') {
      const wrappedListeners = this._listenerMap.get(listener);
      if (wrappedListeners) {
        for (let i = 0; i < IPC_CHANNELS.length; i++) {
          this.view.webContents.ipc.removeListener(IPC_CHANNELS[i], wrappedListeners[i]);
        }
        this._listenerMap.delete(listener);
      }
    }
  }

  /** Clean up WebSocket connection */
  dispose(): void {
    if (this._ws) {
      try { this._ws.close(); } catch { /* */ }
      this._ws = null;
      this._wsReady = false;
    }
  }
}
