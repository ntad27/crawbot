/**
 * WebAuth WCV (WebContentsView) Preload Script
 *
 * Combines anti-detection (from anti-detection-preload.cjs) with
 * __crawbot IPC bridge for provider API calls.
 *
 * Used by hidden WebContentsView tabs created for WebAuth providers.
 * These tabs execute fetch() calls with the user's session cookies
 * and stream responses back to the main process via IPC.
 *
 * Must be .cjs (CommonJS) since Electron preload runs in Node context.
 * Uses ipcRenderer.send() (NOT sendToHost — that's for <webview> only).
 */

const { ipcRenderer } = require('electron');

// ══════════════════════════════════════════════════════════════════════
// __crawbot IPC Bridge
// Providers use window.__crawbot.sendChunk/sendEnd/sendError/sendResponse
// to stream data back from in-page fetch() calls.
// ══════════════════════════════════════════════════════════════════════

window.__crawbot = {
  sendChunk: (requestId, data) => ipcRenderer.send('crawbot:stream:chunk', requestId, data),
  sendEnd: (requestId) => ipcRenderer.send('crawbot:stream:end', requestId),
  sendError: (requestId, error) => ipcRenderer.send('crawbot:stream:error', requestId, error),
  sendResponse: (requestId, data) => ipcRenderer.send('crawbot:response', requestId, data),
};

// ══════════════════════════════════════════════════════════════════════
// Anti-detection code — load from shared module
// Makes the WebContentsView indistinguishable from real Google Chrome.
// ══════════════════════════════════════════════════════════════════════
require('./anti-detection-preload.cjs');
