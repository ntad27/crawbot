/**
 * Runtime in-memory patches for OpenClaw — loaded via --require before gateway starts.
 *
 * Uses Node.js module.register() ESM loader hook to rewrite source code in memory.
 * No node_modules modifications needed. Survives OpenClaw version updates.
 *
 * Patch A) dispatch-*.js (browser tool client):
 *   A1. fetchHttpJson default timeout: 5s → 30s
 *   A2. fetchBrowserJson default timeout: 5s → 30s
 *   A3. Replace "Do NOT retry" agent hint with retry-friendly message
 *
 * Patch B) chrome-*.js (CDP relay):
 *   B1. Dedup: disable duplicate Target.attachedToTarget re-send (Playwright crash)
 *   B2. Passthrough: remove local Target.attachToTarget handler → fall through
 *       to extension for unique session alias (prevents session overwrite race)
 */
'use strict';

const { register } = require('node:module');
const { pathToFileURL } = require('node:url');

// Build the loader source as a regular string, then encode for data: URL.
// This avoids escaping issues with template literals inside encodeURIComponent.
const loaderSource = [
  'import { readFileSync } from "node:fs";',
  'import { fileURLToPath } from "node:url";',
  '',
  'const NEW_TIMEOUT = "30e3";',
  '',
  '// ── Patch A: dispatch-*.js ──',
  'const DISPATCH_PATCHES = [',
  '  ["const timeoutMs = init.timeoutMs ?? 5e3;", "const timeoutMs = init.timeoutMs ?? " + NEW_TIMEOUT + ";"],',
  '  ["const timeoutMs = init?.timeoutMs ?? 5e3;", "const timeoutMs = init?.timeoutMs ?? " + NEW_TIMEOUT + ";"],',
  '  ["Do NOT retry the browser tool \\u2014 it will keep failing. Use an alternative approach or inform the user that the browser is currently unavailable.",',
  '   "This may be a transient timeout. Retry the browser tool at least 3 more times before giving up. If it still fails after retries, inform the user that the browser may need a restart."],',
  '];',
  '',
  '// ── Patch B: chrome-*.js ──',
  '// B1: dedup — disable the if-block that re-sends Target.attachedToTarget',
  'const DEDUP_FIND = \'if (cmd.method === "Target.attachToTarget") {\';',
  'const DEDUP_REPLACE = \'if (false && cmd.method === "Target.attachToTarget") {\';',
  '',
  '// B2: passthrough — remove the local case handler so it falls through to extension',
  '// Match the minified single-line or multi-line variant',
  'const PASSTHROUGH_FIND_RE = /case "Target\\.attachToTarget": \\{[\\s\\S]*?throw new Error\\("target not found"\\);\\s*\\}/;',
  'const PASSTHROUGH_REPLACE = \'case "Target.attachToTarget":\';',
  '',
  'let dispatchDone = false;',
  'const relayDone = new Set();',
  '',
  'function applyPairs(src, pairs) {',
  '  let s = src, n = 0;',
  '  for (const [f, r] of pairs) { if (s.includes(f)) { s = s.split(f).join(r); n++; } }',
  '  return { s, n };',
  '}',
  '',
  'export async function load(url, context, nextLoad) {',
  '  if (!url.startsWith("file://") || !url.includes("openclaw")) return nextLoad(url, context);',
  '  const base = url.split("/").pop() || "";',
  '',
  '  // Patch A: dispatch-*.js',
  '  if (!dispatchDone && base.startsWith("dispatch-") && base.endsWith(".js")) {',
  '    try {',
  '      const src = readFileSync(fileURLToPath(url), "utf8");',
  '      if (src.includes("fetchBrowserJson")) {',
  '        const { s, n } = applyPairs(src, DISPATCH_PATCHES);',
  '        if (n > 0) {',
  '          dispatchDone = true;',
  '          console.log("[openclaw-patches] dispatch: " + n + " patch(es) applied (" + base + ")");',
  '          return { format: "module", source: s, shortCircuit: true };',
  '        }',
  '      }',
  '    } catch { /* skip */ }',
  '  }',
  '',
  '  // Patch B: chrome-*.js',
  '  if (base.startsWith("chrome-") && base.endsWith(".js") && !relayDone.has(base)) {',
  '    try {',
  '      const src = readFileSync(fileURLToPath(url), "utf8");',
  '      if (src.includes("Target.attachToTarget")) {',
  '        let modified = src;',
  '        let count = 0;',
  '        // B1: dedup',
  '        if (modified.includes(DEDUP_FIND)) {',
  '          modified = modified.split(DEDUP_FIND).join(DEDUP_REPLACE);',
  '          count++;',
  '        }',
  '        // B2: passthrough',
  '        if (PASSTHROUGH_FIND_RE.test(modified)) {',
  '          modified = modified.replace(PASSTHROUGH_FIND_RE, PASSTHROUGH_REPLACE);',
  '          count++;',
  '        }',
  '        if (count > 0) {',
  '          relayDone.add(base);',
  '          console.log("[openclaw-patches] relay: " + count + " patch(es) applied (" + base + ")");',
  '          return { format: "module", source: modified, shortCircuit: true };',
  '        }',
  '      }',
  '    } catch { /* skip */ }',
  '  }',
  '',
  '  return nextLoad(url, context);',
  '}',
].join('\n');

register('data:text/javascript,' + encodeURIComponent(loaderSource), pathToFileURL(__filename).href);
