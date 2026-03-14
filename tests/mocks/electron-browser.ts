/**
 * Mock factories for browser-related Electron APIs
 */
import { vi } from 'vitest';

// ── Mock Webview ──

export interface MockWebview {
  src: string;
  partition: string;
  executeJavaScript: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  getURL: ReturnType<typeof vi.fn>;
  getTitle: ReturnType<typeof vi.fn>;
  goBack: ReturnType<typeof vi.fn>;
  goForward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  canGoBack: ReturnType<typeof vi.fn>;
  canGoForward: ReturnType<typeof vi.fn>;
  setZoomFactor: ReturnType<typeof vi.fn>;
  getZoomFactor: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  _listeners: Map<string, Array<(...args: unknown[]) => void>>;
  _simulateEvent: (event: string, data?: unknown) => void;
  _simulateIpcMessage: (channel: string, ...args: unknown[]) => void;
}

export function makeMockWebview(overrides: Partial<MockWebview> = {}): MockWebview {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  const webview: MockWebview = {
    src: 'about:blank',
    partition: 'persist:browser-shared',
    executeJavaScript: vi.fn().mockResolvedValue(undefined),
    loadURL: vi.fn().mockResolvedValue(undefined),
    getURL: vi.fn().mockReturnValue('about:blank'),
    getTitle: vi.fn().mockReturnValue(''),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    canGoBack: vi.fn().mockReturnValue(false),
    canGoForward: vi.fn().mockReturnValue(false),
    setZoomFactor: vi.fn(),
    getZoomFactor: vi.fn().mockReturnValue(1.0),
    addEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    }),
    removeEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      const list = listeners.get(event);
      if (list) {
        const idx = list.indexOf(listener);
        if (idx >= 0) list.splice(idx, 1);
      }
    }),
    _listeners: listeners,
    _simulateEvent: (event: string, data?: unknown) => {
      const list = listeners.get(event);
      if (list) list.forEach((fn) => fn(data));
    },
    _simulateIpcMessage: (channel: string, ...args: unknown[]) => {
      const list = listeners.get('ipc-message');
      if (list) list.forEach((fn) => fn({ channel, args }));
    },
    ...overrides,
  };

  return webview;
}

// ── Mock WebContents ──

export interface MockWebContents {
  id: number;
  getURL: ReturnType<typeof vi.fn>;
  getTitle: ReturnType<typeof vi.fn>;
}

export function makeMockWebContents(id: number, url = 'about:blank'): MockWebContents {
  return {
    id,
    getURL: vi.fn().mockReturnValue(url),
    getTitle: vi.fn().mockReturnValue(`Page ${id}`),
  };
}
