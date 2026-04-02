/**
 * OpenAI Codex OAuth PKCE flow.
 *
 * Implements the same flow as OpenClaw's openai-codex auth extension
 * but runs natively in Electron's main process (no TTY required).
 *
 * Client ID and endpoints are hardcoded to match the upstream extension
 * in @mariozechner/pi-ai (same CLIENT_ID, so pi-ai refresh works too).
 *
 * Proactive token refresh keeps the token fresh before expiry,
 * same pattern as Claude and Google Gemini OAuth.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BrowserWindow } from 'electron';
import { openExternalInDefaultProfile } from './open-external';
import { logger } from './logger';

// ── OAuth constants (matches pi-ai/openclaw openai-codex) ──
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const REDIRECT_PORT = 1455;
const SCOPES = 'openid profile email offline_access';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── PKCE ──

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ── Callback server (fixed port 1455 — OpenAI requires exact redirect_uri match) ──

function startCallbackServer(): Promise<{ server: Server; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (err) => reject(err));
    server.listen(REDIRECT_PORT, 'localhost', () => {
      logger.info(`[openai-codex-oauth] Callback server listening on ${REDIRECT_URI}`);
      resolve({ server, redirectUri: REDIRECT_URI });
    });
  });
}

function waitForCallback(
  server: Server,
  expectedState: string,
  timeoutMs: number,
): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;

    const finish = (err?: Error, code?: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try { server.close(); } catch { /* ignore */ }
      if (err) reject(err);
      else if (code) resolve({ code });
    };

    server.on('request', (req, res) => {
      try {
        const requestUrl = new URL(req.url ?? '/', `http://localhost:${REDIRECT_PORT}`);

        if (requestUrl.pathname !== '/auth/callback') {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const error = requestUrl.searchParams.get('error');
        const code = requestUrl.searchParams.get('code')?.trim();
        const state = requestUrl.searchParams.get('state')?.trim();

        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:60px">` +
            `<h2>Authentication Failed</h2><p>${error}</p>` +
            `<p>You can close this window.</p></body></html>`
          );
          finish(new Error(`OAuth error: ${error}`));
          return;
        }

        if (!code || !state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h2>Missing code or state</h2></body></html>');
          finish(new Error('Missing OAuth code or state'));
          return;
        }

        if (state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><body><h2>Invalid state</h2></body></html>');
          finish(new Error('OAuth state mismatch'));
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          '<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:60px">' +
          '<h2>Authentication successful!</h2>' +
          '<p>You can close this window and return to CrawBot.</p>' +
          '</body></html>'
        );
        finish(undefined, code);
      } catch (err) {
        finish(err instanceof Error ? err : new Error('OAuth callback failed'));
      }
    });

    timeout = setTimeout(() => {
      finish(new Error('OAuth timeout: no browser response within 5 minutes'));
    }, timeoutMs);
  });
}

// ── Token exchange ──

async function exchangeCodeForTokens(
  code: string,
  verifier: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!data.access_token) {
    throw new Error('No access token received');
  }

  return data;
}

// ── JWT decode (extract accountId from access token) ──

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length < 2) throw new Error('Invalid JWT format');
  const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
  return JSON.parse(payload);
}

function extractAccountId(accessToken: string): string | undefined {
  try {
    const payload = decodeJwtPayload(accessToken);
    const authClaim = payload['https://api.openai.com/auth'] as
      | { chatgpt_account_id?: string }
      | undefined;
    return authClaim?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

// ── Auth profile persistence ──

function writeAuthProfile(credential: {
  access: string;
  refresh?: string;
  expires: number;
  accountId?: string;
}): void {
  const openclawDir = join(homedir(), '.openclaw', 'agents', 'main', 'agent');
  const authProfilesPath = join(openclawDir, 'auth-profiles.json');
  mkdirSync(openclawDir, { recursive: true });

  let store: {
    version?: number;
    profiles?: Record<string, unknown>;
    order?: Record<string, string[]>;
    lastGood?: Record<string, string>;
  } = { version: 1, profiles: {} };
  if (existsSync(authProfilesPath)) {
    try {
      store = JSON.parse(readFileSync(authProfilesPath, 'utf-8'));
    } catch { /* ignore */ }
  }
  if (!store.profiles || typeof store.profiles !== 'object') {
    store.profiles = {};
  }

  // Remove ALL existing openai-codex profiles before writing the new one.
  const providerType = 'openai-codex';
  for (const key of Object.keys(store.profiles)) {
    if (key.startsWith(`${providerType}:`)) {
      delete store.profiles[key];
    }
  }
  if (store.order?.[providerType]) {
    store.order[providerType] = [];
  }

  const profileId = 'openai-codex:default';

  store.profiles[profileId] = {
    type: 'oauth',
    provider: 'openai-codex',
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    accountId: credential.accountId,
  };

  if (!store.order) store.order = {};
  if (!store.order[providerType]) store.order[providerType] = [];
  if (!store.order[providerType].includes(profileId)) {
    store.order[providerType].push(profileId);
  }

  if (!store.lastGood) store.lastGood = {};
  store.lastGood[providerType] = profileId;

  writeFileSync(authProfilesPath, JSON.stringify(store, null, 2), 'utf-8');
}

// ── Notification helper ──

function notifyRenderer(provider: string, success: boolean, error?: string): void {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      win.webContents.send('oauth:token-refreshed', { provider, success, error });
    }
  } catch { /* ignore — window may not exist yet */ }
}

// ── Proactive Token Refresh ──

let codexRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function readCodexOAuthProfile(): {
  access: string;
  refresh: string;
  expires: number;
  accountId?: string;
} | null {
  const authPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
  try {
    if (!existsSync(authPath)) return null;
    const store = JSON.parse(readFileSync(authPath, 'utf-8'));
    if (!store?.profiles) return null;

    for (const [_id, profile] of Object.entries(store.profiles)) {
      const p = profile as Record<string, unknown>;
      if (p.provider === 'openai-codex' && p.type === 'oauth' && p.refresh && p.expires) {
        return {
          access: p.access as string,
          refresh: p.refresh as string,
          expires: p.expires as number,
          accountId: p.accountId as string | undefined,
        };
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function refreshCodexAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
} | null> {
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    });

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[openai-codex-oauth] Token refresh failed (${response.status}): ${errorText}`);
      return null;
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    if (!data.access_token) {
      logger.error('[openai-codex-oauth] No access token in refresh response');
      return null;
    }

    return data;
  } catch (err) {
    logger.error('[openai-codex-oauth] Token refresh error:', err instanceof Error ? err.message : err);
    return null;
  }
}

function scheduleCodexRefresh(): void {
  if (codexRefreshTimer) {
    clearTimeout(codexRefreshTimer);
    codexRefreshTimer = null;
  }

  const profile = readCodexOAuthProfile();
  if (!profile) {
    logger.debug('[openai-codex-oauth] No OpenAI Codex OAuth profile found, skipping proactive refresh');
    return;
  }

  // Refresh 10 minutes before expiry
  const refreshAt = profile.expires - 10 * 60 * 1000;
  const delayMs = Math.max(refreshAt - Date.now(), 5000);

  if (Date.now() >= profile.expires) {
    logger.warn('[openai-codex-oauth] Token already expired, attempting immediate refresh...');
    void doCodexProactiveRefresh();
    return;
  }

  logger.info(`[openai-codex-oauth] Scheduling proactive refresh in ${Math.round(delayMs / 60000)} min (expires: ${new Date(profile.expires).toISOString()})`);

  codexRefreshTimer = setTimeout(() => {
    void doCodexProactiveRefresh();
  }, delayMs);

  if (codexRefreshTimer && typeof codexRefreshTimer === 'object' && 'unref' in codexRefreshTimer) {
    codexRefreshTimer.unref();
  }
}

async function doCodexProactiveRefresh(): Promise<void> {
  const profile = readCodexOAuthProfile();
  if (!profile) return;

  logger.info('[openai-codex-oauth] Proactive token refresh starting...');

  const tokens = await refreshCodexAccessToken(profile.refresh);
  if (tokens) {
    const expires = Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000;
    const accountId = extractAccountId(tokens.access_token) || profile.accountId;
    writeAuthProfile({
      access: tokens.access_token,
      refresh: tokens.refresh_token || profile.refresh,
      expires,
      accountId,
    });
    logger.info('[openai-codex-oauth] Proactive refresh successful, new token written');
    notifyRenderer('openai-codex', true);

    // Schedule next refresh
    scheduleCodexRefresh();
  } else {
    logger.error('[openai-codex-oauth] Proactive refresh failed — user will need to re-authenticate');
    notifyRenderer('openai-codex', false, 'Token refresh failed. Please re-authenticate.');
    // Retry in 5 minutes in case it was a transient error
    codexRefreshTimer = setTimeout(() => void doCodexProactiveRefresh(), 5 * 60 * 1000);
    if (codexRefreshTimer && typeof codexRefreshTimer === 'object' && 'unref' in codexRefreshTimer) {
      codexRefreshTimer.unref();
    }
  }
}

/**
 * Start proactive OAuth token refresh for OpenAI Codex.
 */
export function startCodexProactiveTokenRefresh(): void {
  scheduleCodexRefresh();
}

/**
 * Stop proactive token refresh (for cleanup).
 */
export function stopCodexProactiveTokenRefresh(): void {
  if (codexRefreshTimer) {
    clearTimeout(codexRefreshTimer);
    codexRefreshTimer = null;
  }
}

// ── Active flow tracking (for cancel & port-conflict cleanup) ──

let activeCallbackServer: Server | null = null;

function cleanupActiveServer(): void {
  if (activeCallbackServer) {
    try { activeCallbackServer.close(); } catch { /* ignore */ }
    activeCallbackServer = null;
    logger.info('[openai-codex-oauth] Cleaned up stale callback server');
  }
}

// ── Public API ──

/**
 * Cancel any in-progress OAuth flow (closes callback server, unblocks waitForCallback).
 */
export function cancelOpenAICodexOAuthFlow(): void {
  cleanupActiveServer();
}

export async function runOpenAICodexOAuthFlow(): Promise<{
  success: boolean;
  error?: string;
}> {
  // Clean up any stale server from a previous cancelled/failed attempt
  cleanupActiveServer();

  // 1. Generate PKCE
  logger.info('Starting OpenAI Codex OAuth PKCE flow');
  const { verifier, challenge } = generatePkce();
  const state = randomBytes(16).toString('hex');

  // 2. Start callback server (fixed port 1455 — OpenAI requires exact redirect_uri)
  const { server } = await startCallbackServer();
  activeCallbackServer = server;

  try {
    // 3. Build auth URL
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: REDIRECT_URI,
      scope: SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      codex_cli_simplified_flow: 'true',
      id_token_add_organizations: 'true',
      originator: 'pi',
    });
    const authUrl = `${AUTH_URL}?${params}`;

    // 4. Open browser for consent
    logger.info('Opening browser for OpenAI Codex OAuth consent');
    await openExternalInDefaultProfile(authUrl);

    // 5. Wait for callback
    const { code } = await waitForCallback(server, state, CALLBACK_TIMEOUT_MS);
    logger.info('Received OAuth callback with authorization code');

    // 6. Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, verifier);
    logger.info('Token exchange successful');

    // 7. Extract accountId from JWT
    const accountId = extractAccountId(tokens.access_token);
    logger.info(`OpenAI Codex account: ${accountId || 'unknown'}`);

    // 8. Write auth profile
    const expires = Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000;
    writeAuthProfile({
      access: tokens.access_token,
      refresh: tokens.refresh_token,
      expires,
      accountId,
    });
    logger.info('OpenAI Codex OAuth credentials saved to auth-profiles.json');

    // Kick off proactive refresh for the new token
    scheduleCodexRefresh();

    return { success: true };
  } finally {
    // Always clean up the server reference
    if (activeCallbackServer === server) {
      activeCallbackServer = null;
    }
    try { server.close(); } catch { /* ignore */ }
  }
}
