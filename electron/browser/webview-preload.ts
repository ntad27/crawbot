/**
 * WebAuth Webview Preload Script
 *
 * Loaded inside webauth provider webviews via <webview preload="...">
 * Provides IPC bridge from guest page → host renderer via ipcRenderer.sendToHost()
 *
 * This is the ONLY way to get streaming data from webview.executeJavaScript()
 * back to the main/renderer process in real-time.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { ipcRenderer } = require('electron');

// Expose streaming bridge to the guest page
(window as Record<string, unknown>).__crawbot = {
  sendChunk: (requestId: string, data: string) =>
    ipcRenderer.sendToHost('crawbot:stream:chunk', requestId, data),

  sendEnd: (requestId: string) =>
    ipcRenderer.sendToHost('crawbot:stream:end', requestId),

  sendError: (requestId: string, error: string) =>
    ipcRenderer.sendToHost('crawbot:stream:error', requestId, error),

  sendResponse: (requestId: string, data: unknown) =>
    ipcRenderer.sendToHost('crawbot:response', requestId, data),
};
