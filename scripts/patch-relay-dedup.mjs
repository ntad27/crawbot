#!/usr/bin/env node
/**
 * Postinstall script: Patch OpenClaw RELAY (not Playwright!) to prevent crashes.
 *
 * These patches target the relay's CDP proxy layer (chrome-*.js in openclaw/dist).
 * They do NOT modify Playwright or any other package.
 *
 * Patch 1 (dedup): The relay re-sends Target.attachedToTarget on Target.attachToTarget
 * for already-known targets. Playwright asserts no duplicates → crash.
 *
 * Patch 2 (passthrough): The relay handles Target.attachToTarget locally, returning
 * the SAME sessionId used by CRPage init. This overwrites the existing session while
 * init responses are still in-flight → crash. Fix: remove local handler so the command
 * falls through to the extension, which generates a new unique session alias.
 *
 * Patch 3 (autoattach): REVERTED. ensureTargetEventsForClient() is needed for Playwright
 * to discover existing targets. With lazy debugger attach, extension announces before
 * Playwright connects, so ensureTargetEventsForClient is the first time Playwright sees them.
 *
 * Runs automatically after `pnpm install`. Idempotent.
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const OPENCLAW_DIST = join(
  import.meta.dirname,
  '..',
  'node_modules',
  'openclaw',
  'dist',
);

// --- Patch 1: Disable duplicate Target.attachedToTarget re-send ---
const DEDUP_UNPATCHED = 'if (cmd.method === "Target.attachToTarget") {';
const DEDUP_PATCHED = 'if (false && cmd.method === "Target.attachToTarget") { /* PATCHED: prevent duplicate target crash */';
const DEDUP_DETECT = 'false && cmd.method === "Target.attachToTarget"';

// --- Patch 2: Remove local Target.attachToTarget handler → falls through to extension ---
const ATTACH_VARIANTS = [
  // Original unpatched handler (multi-line)
  {
    find: `case "Target.attachToTarget": {
					const params = cmd.params ?? {};
					const targetId = typeof params.targetId === "string" ? params.targetId : void 0;
					if (!targetId) throw new Error("targetId required");
					for (const t of connectedTargets.values()) if (t.targetId === targetId) return { sessionId: t.sessionId };
					throw new Error("target not found");
				}`,
    replace: `case "Target.attachToTarget": /* PATCHED: fall through to extension */`,
  },
  // Our previous "throw" patch
  {
    find: `case "Target.attachToTarget": { /* PATCHED: block to prevent session overwrite race */
					throw new Error("explicit attachment not supported by extension relay");
				}`,
    replace: `case "Target.attachToTarget": /* PATCHED: fall through to extension */`,
  },
  // Our previous "break" patch (wrong — break doesn't fall through)
  {
    find: `case "Target.attachToTarget": break; /* PATCHED: fall through to extension for proper session alias */`,
    replace: `case "Target.attachToTarget": /* PATCHED: fall through to extension */`,
  },
];
const ATTACH_DETECT = 'Target.attachToTarget": /* PATCHED: fall through';

// --- Patch 3: REVERTED ---
// ensureTargetEventsForClient is NEEDED for Playwright to discover targets.
// With lazy debugger attach, extension announces tabs before Playwright connects.
// When Playwright sends Target.setAutoAttach, ensureTargetEventsForClient sends
// ALL connectedTargets — this is the FIRST time Playwright sees them (no duplicate).
// We now UNPATCH any previously-patched files to restore this behavior.
const AUTOATTACH_PATCHED_DETECT = 'false && cmd.method === "Target.setAutoAttach"';
const AUTOATTACH_PATCHED_STR = 'if (false && cmd.method === "Target.setAutoAttach" && !cmd.sessionId) ensureTargetEventsForClient(ws, "autoAttach"); /* PATCHED: extension already announces targets */';
const AUTOATTACH_RESTORED = 'if (cmd.method === "Target.setAutoAttach" && !cmd.sessionId) ensureTargetEventsForClient(ws, "autoAttach");';

let patchedCount = 0;
let skippedCount = 0;

function patchDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        patchDir(fullPath);
      } else if (entry.startsWith('chrome-') && entry.endsWith('.js')) {
        let content = readFileSync(fullPath, 'utf8');
        let changed = false;

        // Patch 1: dedup
        if (!content.includes(DEDUP_DETECT) && content.includes(DEDUP_UNPATCHED)) {
          content = content.replace(DEDUP_UNPATCHED, DEDUP_PATCHED);
          changed = true;
        }

        // Patch 3: UNPATCH — restore ensureTargetEventsForClient (needed for Playwright target discovery)
        if (content.includes(AUTOATTACH_PATCHED_DETECT)) {
          content = content.replace(AUTOATTACH_PATCHED_STR, AUTOATTACH_RESTORED);
          changed = true;
        }

        // Patch 2: passthrough Target.attachToTarget to extension
        if (!content.includes(ATTACH_DETECT)) {
          for (const variant of ATTACH_VARIANTS) {
            if (content.includes(variant.find)) {
              content = content.replace(variant.find, variant.replace);
              changed = true;
              break;
            }
          }
        }

        if (changed) {
          writeFileSync(fullPath, content, 'utf8');
          patchedCount++;
          console.log(`  ✓ Patched: ${fullPath}`);
        } else {
          skippedCount++;
        }
      }
    } catch {
      // skip unreadable files
    }
  }
}

console.log('[patch-relay-dedup] Checking OpenClaw relay files...');
patchDir(OPENCLAW_DIST);

if (patchedCount > 0) {
  console.log(`[patch-relay-dedup] Patched ${patchedCount} file(s), ${skippedCount} already patched.`);
} else if (skippedCount > 0) {
  console.log(`[patch-relay-dedup] All ${skippedCount} file(s) already patched.`);
} else {
  console.log('[patch-relay-dedup] No relay files found to patch.');
}
