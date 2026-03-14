/**
 * Base Provider — Shared logic for executing fetch inside webviews
 *
 * Two patterns:
 * 1. executeInWebview — non-streaming (auth checks, org discovery)
 * 2. streamFromWebview — streaming (chat completions via ipcRenderer.sendToHost)
 */

import type { WebviewLike } from './types';

let requestCounter = 0;
function nextRequestId(): string {
  return `req-${Date.now()}-${++requestCounter}`;
}

// ── Non-streaming fetch ──

export interface WebviewResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/**
 * Execute a fetch() inside the webview's browser context.
 * Cookies are automatically included via credentials: 'include'.
 * Returns the full response (buffered, not streaming).
 */
export async function executeInWebview(
  webview: WebviewLike,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): Promise<WebviewResponse> {
  const requestId = nextRequestId();

  return new Promise<WebviewResponse>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Request timeout: ${url}`));
    }, 30000);

    const handler = (event: unknown) => {
      const e = event as { channel: string; args: unknown[] };
      if (e.channel === 'crawbot:response' && e.args[0] === requestId) {
        cleanup();
        resolve(e.args[1] as WebviewResponse);
      } else if (e.channel === 'crawbot:stream:error' && e.args[0] === requestId) {
        cleanup();
        reject(new Error(e.args[1] as string));
      }
    };

    function cleanup() {
      clearTimeout(timeout);
      webview.removeEventListener('ipc-message', handler);
    }

    webview.addEventListener('ipc-message', handler);

    const code = `
      (async () => {
        try {
          const r = await fetch(${JSON.stringify(url)}, {
            method: ${JSON.stringify(options.method || 'GET')},
            headers: ${JSON.stringify(options.headers || {})},
            ${options.body ? `body: ${JSON.stringify(options.body)},` : ''}
            credentials: 'include',
          });
          const body = await r.text();
          window.__crawbot.sendResponse(${JSON.stringify(requestId)}, {
            status: r.status,
            headers: Object.fromEntries(r.headers.entries()),
            body: body,
          });
        } catch (e) {
          window.__crawbot.sendError(${JSON.stringify(requestId)}, e.message);
        }
      })()
    `;

    webview.executeJavaScript(code).catch((err: Error) => {
      cleanup();
      reject(err);
    });
  });
}

// ── Streaming fetch ──

export interface StreamHandle {
  stream: AsyncGenerator<string>;
  abort: () => void;
}

/**
 * Execute a streaming fetch() inside the webview.
 * Returns an async generator that yields raw SSE text chunks as they arrive.
 */
export function streamFromWebview(
  webview: WebviewLike,
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {}
): StreamHandle {
  const requestId = nextRequestId();
  const chunks: string[] = [];
  let done = false;
  let error: string | null = null;
  let resolveWait: (() => void) | null = null;

  const handler = (event: unknown) => {
    const e = event as { channel: string; args: unknown[] };
    if (e.args[0] !== requestId) return;

    if (e.channel === 'crawbot:stream:chunk') {
      chunks.push(e.args[1] as string);
      resolveWait?.();
    } else if (e.channel === 'crawbot:stream:end') {
      done = true;
      resolveWait?.();
      webview.removeEventListener('ipc-message', handler);
    } else if (e.channel === 'crawbot:stream:error') {
      error = e.args[1] as string;
      done = true;
      resolveWait?.();
      webview.removeEventListener('ipc-message', handler);
    }
  };

  webview.addEventListener('ipc-message', handler);

  // Start streaming fetch inside webview
  const code = `
    (async () => {
      try {
        const r = await fetch(${JSON.stringify(url)}, {
          method: ${JSON.stringify(options.method || 'POST')},
          headers: ${JSON.stringify(options.headers || {})},
          ${options.body ? `body: ${JSON.stringify(options.body)},` : ''}
          credentials: 'include',
        });
        if (!r.ok) {
          window.__crawbot.sendError(${JSON.stringify(requestId)},
            'HTTP ' + r.status + ': ' + (await r.text()));
          return;
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          window.__crawbot.sendChunk(${JSON.stringify(requestId)},
            decoder.decode(value, { stream: true }));
        }
        window.__crawbot.sendEnd(${JSON.stringify(requestId)});
      } catch (e) {
        window.__crawbot.sendError(${JSON.stringify(requestId)}, e.message);
      }
    })()
  `;

  webview.executeJavaScript(code).catch(() => {
    error = 'Failed to execute JavaScript in webview';
    done = true;
    resolveWait?.();
  });

  async function* generate(): AsyncGenerator<string> {
    while (!done) {
      if (chunks.length > 0) {
        yield chunks.shift()!;
      } else {
        await new Promise<void>((r) => {
          resolveWait = r;
        });
      }
    }
    // Drain remaining chunks
    while (chunks.length > 0) {
      yield chunks.shift()!;
    }
    if (error) throw new Error(error);
  }

  return {
    stream: generate(),
    abort: () => {
      webview.removeEventListener('ipc-message', handler);
      done = true;
      resolveWait?.();
    },
  };
}
