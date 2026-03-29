# OpenClaw Patch Maintenance Guide

After every OpenClaw version upgrade (`pnpm upgrade openclaw` or version bump in package.json), the runtime patches in `electron/gateway/openclaw-patches-preload.cjs` may break because the bundler (rolldown) can change chunk filenames and code structure.

## Quick Check: Are Patches Applying?

1. Start Gateway (via `pnpm dev` or the app)
2. Look for these lines in logs:
   ```
   [Gateway stderr] [openclaw-patches] dispatch: 3, relay: 8, session-affinity: 7 patch(es) applied (some-file.js)
   [Gateway stderr] [openclaw-patches] screenshot: 1 patch(es) applied (some-file.js)
   [Gateway stderr] [openclaw-patches] oauth-refresh: 1 patch(es) applied (anthropic.js)
   ```
3. If NO `[openclaw-patches]` line appears → patches are broken, follow diagnosis below
4. **Patch D (oauth-refresh)** targets `pi-ai` package, NOT `openclaw` — the ESM loader URL filter must include both `"openclaw"` and `"pi-ai"`

## Diagnosis: Why Patches Aren't Applying

### Step 1: Check if patch target strings still exist in the bundle
```bash
# Patch A targets (browser tool timeouts + retry hint)
grep -l "fetchBrowserJson" node_modules/openclaw/dist/*.js | xargs -I{} basename {}

# Patch B targets (relay dedup, target pruning, extension timeout)
grep -l "broadcastToCdpClients" node_modules/openclaw/dist/*.js | xargs -I{} basename {}

# Patch C target (screenshot max side)
grep -l "DEFAULT_BROWSER_SCREENSHOT_MAX_SIDE" node_modules/openclaw/dist/*.js | xargs -I{} basename {}

# Patch D target (OAuth refresh scope fix) — in pi-ai, NOT openclaw
find node_modules/.pnpm -path "*/pi-ai/dist/utils/oauth/anthropic.js" -exec grep -l "scope: SCOPES" {} \;
```

### Step 2: Check if those files are loaded at runtime
Use a debug preload to log which files the ESM loader intercepts:
```bash
OPENCLAW_NO_RESPAWN=1 node --require electron/gateway/openclaw-patches-preload.cjs \
  node_modules/openclaw/openclaw.mjs gateway --port 19999 --token test --allow-unconfigured
```
Look for `[openclaw-patches]` output. If missing, the loader's file filter may not match.

### Step 3: Check specific patch strings
```bash
# Patch A: browser tool timeouts + retry hint
grep -c "const timeoutMs = init.timeoutMs ?? 5e3" node_modules/openclaw/dist/FILENAME.js
grep -c "const timeoutMs = init?.timeoutMs ?? 5e3" node_modules/openclaw/dist/FILENAME.js
grep -c "Do NOT retry the browser tool" node_modules/openclaw/dist/FILENAME.js

# Patch B: relay dedup, target pruning, extension timeout
grep -c "broadcastToCdpClients" node_modules/openclaw/dist/FILENAME.js
grep -c "extension request timeout" node_modules/openclaw/dist/FILENAME.js
grep -c "pruneStaleTargetsFromCommandFailure" node_modules/openclaw/dist/FILENAME.js

# Patch C: screenshot max side
grep -c "SCREENSHOT_MAX_SIDE = 2e3" node_modules/openclaw/dist/FILENAME.js

# Patch D: OAuth refresh scope (pi-ai package, not openclaw!)
PI_FILE=$(find node_modules/.pnpm -path "*/pi-ai/dist/utils/oauth/anthropic.js" | head -1)
grep -c "scope: SCOPES" "$PI_FILE"
```

If any string is missing → OpenClaw/pi-ai changed the source code and that specific patch needs updating.

### Important: URL Filter

The ESM loader filters files by URL path. Patches A/B/C target `openclaw` bundle files. **Patch D targets `pi-ai`** which lives in a separate pnpm store path that does NOT contain "openclaw". The loader filter must include both:

```javascript
if (!url.includes("openclaw") && !url.includes("pi-ai")) return nextLoad(url, context);
```

If a future upgrade moves OAuth code into a different package, update this filter accordingly.

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| No `[openclaw-patches]` log at all | File name filter doesn't match new chunk names | Remove or update the `isCandidate` filter in the preload |
| Partial patches (e.g., dispatch: 2 instead of 3) | OpenClaw changed a specific string | Find the new string in the bundle and update the FIND constant |
| `module.register()` not working | Node.js API change or compile cache interference | Set `NODE_DISABLE_COMPILE_CACHE=1` in spawn env, or check Node version compat |
| Patches apply but browser still fails | OpenClaw refactored the relay architecture | Need to reverse-engineer the new relay code and write new patches |
| No `oauth-refresh` patch log | pi-ai path doesn't match URL filter | Ensure loader filter includes `url.includes("pi-ai")` |
| OAuth refresh still fails after patch | pi-ai changed refresh function signature | Check `refreshAnthropicToken` in pi-ai anthropic.js for new patterns |

## Verification: E2E Tests

After fixing patches, run ALL browser relay tests:
```bash
# Basic relay test (CDP connect + page interaction)
node tests/e2e-browser-relay-test.mjs

# Stability test (5 phases: connect, idle, navigate, repeat)
node tests/e2e-stability-test.mjs

# Idle detach test (auto-detach + transparent re-attach)
node tests/e2e-idle-detach-test.mjs
```
All must pass. Chrome must be open with the OpenClaw Browser Relay extension active.

## Key Files

- **Patches preload**: `electron/gateway/openclaw-patches-preload.cjs`
- **Gateway manager** (spawns process): `electron/gateway/manager.ts`
- **Chrome extension**: `assets/chrome-extension/background.js`
- **OpenClaw bundle**: `node_modules/openclaw/dist/*.js`
- **E2E tests**: `tests/e2e-browser-relay-test.mjs`, `tests/e2e-stability-test.mjs`, `tests/e2e-idle-detach-test.mjs`

## Patch F: Browser Session Tab Affinity (multi-agent tab isolation)

**Added**: 2026.3.29 | **OpenClaw version**: 2026.3.13

**Problem**: When multiple subagents use the browser tool concurrently, they all share `profileState.lastTargetId`, causing them to navigate on the same tab (race condition).

**Fix**: Per-session `lastTargetId` via `__lastTargetBySession` Map on ProfileRuntimeState. 7 sub-patches:
- F1: `ensureTabAvailable` accepts `sessionKey` param
- F1B: `pickDefault` checks per-session sticky before global
- F1C: Updates per-session sticky after tab selection
- F2: `withRouteTabContext` extracts `sessionKey` from request body
- F3: `browserNavigate` includes `sessionKey` in POST body
- F4: Browser tool navigate call passes `agentSessionKey`
- F5: `browserScreenshotAction` includes `sessionKey` in POST body

**Detection strings**: `ensureTabAvailable`, `pickDefault` (both must be present in file)

**Verify after upgrade**:
```bash
# Check the patch targets exist
grep -c "const ensureTabAvailable = async (targetId)" node_modules/openclaw/dist/*.js
grep -c "const pickDefault = () =>" node_modules/openclaw/dist/*.js
grep -c "profileState.lastTargetId = chosen.targetId" node_modules/openclaw/dist/*.js
```

## History of Breakages

- **2026.3.12**: rolldown bundler moved relay+browser code from `reply-*.js` into `auth-profiles-*.js` chunks. Fixed by removing filename-based candidate filter (commit 9c32105).
- **2026.3.26**: Patch D (OAuth refresh scope fix) was never applying because pi-ai's resolved pnpm path does not contain "openclaw". Fixed by adding `"pi-ai"` to the ESM loader URL filter (commit f65b19d).
