/**
 * Anthropic Claude OAuth PKCE Flow
 *
 * Implements the same OAuth flow as `claude setup-token` but natively
 * in Electron's main process — no TTY/ink dependency required.
 *
 * Flow: PKCE Authorization Code → local callback server → token exchange
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { BrowserWindow } from 'electron';
import { openExternalInDefaultProfile } from './open-external';
import { logger } from './logger';

// ── OAuth constants (extracted from Claude Code CLI v2.1.83) ──
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const AUTH_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
// Full scopes — matches Claude Code CLI "auth login" mode.
// Anthropic issues 8h tokens with refresh tokens for these scopes.
// Proactive refresh (below) keeps the token alive continuously.
const SCOPES = ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload'];

// ── PKCE ──

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ── Callback server ──

function startCallbackServer(): Promise<{ server: Server; port: number; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (err) => reject(err));
    // Port 0 = OS picks a free port (avoids conflicts)
    server.listen(0, 'localhost', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const redirectUri = `http://localhost:${port}/callback`;
      logger.info(`[claude-oauth] Callback server listening on ${redirectUri}`);
      resolve({ server, port, redirectUri });
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
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        const requestUrl = new URL(req.url ?? '/', `http://localhost:${port}`);

        if (requestUrl.pathname !== '/callback') {
          res.statusCode = 404;
          res.end('Not found');
          return;
        }

        const error = requestUrl.searchParams.get('error');
        const code = requestUrl.searchParams.get('code')?.trim();
        const state = requestUrl.searchParams.get('state')?.trim();

        if (error) {
          const desc = requestUrl.searchParams.get('error_description') || error;
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(
            `<!doctype html><html><body style="font-family:system-ui;text-align:center;padding:60px">` +
            `<h2>Authentication Failed</h2><p>${desc}</p>` +
            `<p>You can close this window.</p></body></html>`
          );
          finish(new Error(`OAuth error: ${desc}`));
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
  redirectUri: string,
  state: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }> {
  // NOTE: Anthropic's token endpoint expects JSON (not form-urlencoded).
  // This is non-standard but matches the Claude CLI implementation.
  const body = JSON.stringify({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: CLIENT_ID,
    code_verifier: verifier,
    state,
  });

  logger.debug(`[claude-oauth] Exchanging code at ${TOKEN_URL}`);

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${errorText}`);
  }

  const data = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error('No access token received from Anthropic');
  }

  return data;
}

// ── Auth profile persistence ──

function writeAuthProfile(credential: {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
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
    } catch { /* start fresh */ }
  }
  if (!store.profiles || typeof store.profiles !== 'object') {
    store.profiles = {};
  }

  const providerType = 'anthropic';
  const profileId = `${providerType}:default`;

  // Use OAuth format (access/refresh/expires) when we have a short-lived token
  // that needs refresh. Use token format for long-lived API keys (no expiry).
  const useOAuthFormat = !!(credential.refreshToken && credential.expiresAt);
  store.profiles[profileId] = useOAuthFormat
    ? {
        type: 'oauth' as const,
        provider: providerType,
        access: credential.accessToken,
        refresh: credential.refreshToken,
        expires: credential.expiresAt,
      }
    : {
        type: 'token' as const,
        provider: providerType,
        token: credential.accessToken,
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

// Refresh the access token BEFORE it expires so the refresh token stays valid.
// Anthropic refresh tokens have a limited lifetime — if the access token expires
// and the app stays idle, the refresh token also expires, requiring full re-auth.
// By refreshing proactively (10 min before expiry), we keep both tokens fresh.

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
} | null> {
  try {
    // Do NOT send scope — Anthropic rejects it with "invalid_scope"
    const body = JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: refreshToken,
    });

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[claude-oauth] Token refresh failed (${response.status}): ${errorText}`);
      return null;
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      logger.error('[claude-oauth] No access token in refresh response');
      return null;
    }

    return data;
  } catch (err) {
    logger.error('[claude-oauth] Token refresh error:', err instanceof Error ? err.message : err);
    return null;
  }
}

function readAnthropicOAuthProfile(): {
  access: string;
  refresh: string;
  expires: number;
} | null {
  const authPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
  try {
    if (!existsSync(authPath)) return null;
    const store = JSON.parse(readFileSync(authPath, 'utf-8'));
    const profile = store?.profiles?.['anthropic:default'];
    if (profile?.type === 'oauth' && profile.refresh && profile.expires) {
      return { access: profile.access, refresh: profile.refresh, expires: profile.expires };
    }
  } catch { /* ignore */ }
  return null;
}

function scheduleNextRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }

  const profile = readAnthropicOAuthProfile();
  if (!profile) {
    logger.debug('[claude-oauth] No OAuth profile found, skipping proactive refresh');
    return;
  }

  // Refresh 10 minutes before expiry
  const refreshAt = profile.expires - 10 * 60 * 1000;
  const delayMs = Math.max(refreshAt - Date.now(), 5000); // minimum 5s delay

  if (Date.now() >= profile.expires) {
    // Already expired — try to refresh immediately
    logger.warn('[claude-oauth] Token already expired, attempting immediate refresh...');
    void doProactiveRefresh();
    return;
  }

  logger.info(`[claude-oauth] Scheduling proactive refresh in ${Math.round(delayMs / 60000)} min (expires: ${new Date(profile.expires).toISOString()})`);

  refreshTimer = setTimeout(() => {
    void doProactiveRefresh();
  }, delayMs);

  // Don't let the timer prevent process exit
  if (refreshTimer && typeof refreshTimer === 'object' && 'unref' in refreshTimer) {
    refreshTimer.unref();
  }
}

async function doProactiveRefresh(): Promise<void> {
  const profile = readAnthropicOAuthProfile();
  if (!profile) return;

  logger.info('[claude-oauth] Proactive token refresh starting...');

  const tokens = await refreshAccessToken(profile.refresh);
  if (tokens) {
    writeAuthProfile({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || profile.refresh,
      expiresAt: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000
        : undefined,
    });
    logger.info('[claude-oauth] Proactive refresh successful, new token written');
    notifyRenderer('anthropic', true);

    // Schedule next refresh
    scheduleNextRefresh();
  } else {
    logger.error('[claude-oauth] Proactive refresh failed — user will need to re-authenticate');
    notifyRenderer('anthropic', false, 'Token refresh failed. Please re-authenticate.');
    // Retry in 5 minutes in case it was a transient error
    refreshTimer = setTimeout(() => void doProactiveRefresh(), 5 * 60 * 1000);
    if (refreshTimer && typeof refreshTimer === 'object' && 'unref' in refreshTimer) {
      refreshTimer.unref();
    }
  }
}

/**
 * Start proactive OAuth token refresh for Anthropic.
 * Call this once during app startup. It monitors the token expiry
 * and refreshes before it expires, keeping the refresh token alive.
 */
export function startProactiveTokenRefresh(): void {
  scheduleNextRefresh();
}

/**
 * Stop proactive token refresh (for cleanup).
 */
export function stopProactiveTokenRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
}

// ── Public API ──

export async function runClaudeOAuthFlow(): Promise<{
  success: boolean;
  error?: string;
}> {
  logger.info('[claude-oauth] Starting Anthropic OAuth PKCE flow');

  try {
    // 1. Generate PKCE verifier + challenge
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString('hex');

    // 2. Start local callback server (dynamic port)
    const { server, redirectUri } = await startCallbackServer();

    // 3. Build authorization URL
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPES.join(' '),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    });
    const authUrl = `${AUTH_URL}?${params}`;

    // 4. Open browser for consent
    logger.info('[claude-oauth] Opening browser for Anthropic OAuth consent');
    await openExternalInDefaultProfile(authUrl);

    // 5. Wait for callback
    const { code } = await waitForCallback(server, state, CALLBACK_TIMEOUT_MS);
    logger.info('[claude-oauth] Received OAuth callback with authorization code');

    // 6. Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code, verifier, redirectUri, state);
    logger.info('[claude-oauth] Token exchange successful');

    // 7. Write auth profile as OAuth format (access + refresh + expires).
    //    Always keep the refresh token so pi-ai/OpenClaw can refresh when
    //    the access token expires. Previously we created a long-lived API key
    //    and stored it as type:'token' (discarding the refresh token), but
    //    this left no recovery path when the key eventually expired.
    writeAuthProfile({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: tokens.expires_in
        ? Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000
        : undefined,
    });
    logger.info('[claude-oauth] Anthropic OAuth credentials saved to auth-profiles.json');

    // Kick off proactive refresh for the new token
    scheduleNextRefresh();

    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[claude-oauth] OAuth flow failed:', message);
    return { success: false, error: message };
  }
}
