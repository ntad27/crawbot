# OpenClaw Patch Maintenance Guide

After every OpenClaw version upgrade (`pnpm upgrade openclaw` or version bump in package.json), the runtime patches in `electron/gateway/openclaw-patches-preload.cjs` may break because the bundler (rolldown) can change chunk filenames and code structure.

## Quick Check: Are Patches Applying?

1. Start Gateway (via `pnpm dev` or the app)
2. Look for this line in logs:
   ```
   [Gateway stderr] [openclaw-patches] dispatch: 3, relay: 8 patch(es) applied (some-file.js)
   ```
3. If NO `[openclaw-patches]` line appears → patches are broken, follow diagnosis below

## Diagnosis: Why Patches Aren't Applying

### Step 1: Check if patch target strings still exist in the bundle
```bash
# Patch A targets (browser tool timeouts + retry hint)
grep -l "fetchBrowserJson" node_modules/openclaw/dist/*.js | xargs -I{} basename {}

# Patch B targets (relay dedup, target pruning, extension timeout)
grep -l "broadcastToCdpClients" node_modules/openclaw/dist/*.js | xargs -I{} basename {}
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
# Verify each patch target string exists in the bundle
grep -c "const timeoutMs = init.timeoutMs ?? 5e3" node_modules/openclaw/dist/FILENAME.js
grep -c "const timeoutMs = init?.timeoutMs ?? 5e3" node_modules/openclaw/dist/FILENAME.js
grep -c "Do NOT retry the browser tool" node_modules/openclaw/dist/FILENAME.js
grep -c "broadcastToCdpClients" node_modules/openclaw/dist/FILENAME.js
grep -c "extension request timeout" node_modules/openclaw/dist/FILENAME.js
grep -c "pruneStaleTargetsFromCommandFailure" node_modules/openclaw/dist/FILENAME.js
```

If any string is missing → OpenClaw changed the source code and that specific patch needs updating.

## Common Failure Modes

| Symptom | Cause | Fix |
|---------|-------|-----|
| No `[openclaw-patches]` log at all | File name filter doesn't match new chunk names | Remove or update the `isCandidate` filter in the preload |
| Partial patches (e.g., dispatch: 2 instead of 3) | OpenClaw changed a specific string | Find the new string in the bundle and update the FIND constant |
| `module.register()` not working | Node.js API change or compile cache interference | Set `NODE_DISABLE_COMPILE_CACHE=1` in spawn env, or check Node version compat |
| Patches apply but browser still fails | OpenClaw refactored the relay architecture | Need to reverse-engineer the new relay code and write new patches |

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

## History of Breakages

- **2026.3.12**: rolldown bundler moved relay+browser code from `reply-*.js` into `auth-profiles-*.js` chunks. Fixed by removing filename-based candidate filter (commit 9c32105).
