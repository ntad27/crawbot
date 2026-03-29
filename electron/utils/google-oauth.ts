/**
 * Google OAuth PKCE flow for Gemini CLI authentication.
 *
 * Implements the same flow as OpenClaw's google-gemini-cli-auth extension
 * but runs natively in Electron's main process (no TTY required).
 *
 * Credential resolution order:
 *  1. Env vars: OPENCLAW_GEMINI_OAUTH_CLIENT_ID / GEMINI_CLI_OAUTH_CLIENT_ID
 *  2. Extracted from installed Gemini CLI's bundled oauth2.js
 *  3. Built-in fallback credentials (same as pi-ai)
 *
 * Proactive token refresh:
 *  CrawBot refreshes the Google OAuth token BEFORE it expires, using the
 *  same client credentials that were used for the initial login. This avoids
 *  client_id mismatch errors that would occur if pi-ai tried to refresh
 *  with its own hardcoded credentials.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { BrowserWindow } from 'electron';
import { openExternalInDefaultProfile } from './open-external';
import { logger } from './logger';

// ── OAuth constants (same as openclaw/extensions/google-gemini-cli-auth) ──
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const TIER_FREE = 'free-tier';
const TIER_LEGACY = 'legacy-tier';
const TIER_STANDARD = 'standard-tier';

// Built-in fallback credentials (same base64 as pi-ai/dist/utils/oauth/google-gemini-cli.js).
// Used when Gemini CLI is not installed locally.
const BUILTIN_CLIENT_ID = atob(
  'NjgxMjU1ODA5Mzk1LW9vOGZ0Mm9wcmRybnA5ZTNhcWY2YXYzaG1kaWIxMzVqLmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t',
);
const BUILTIN_CLIENT_SECRET = atob(
  'R09DU1BYLTR1SGdNUG0tMW83U2stZ2VWNkN1NWNsWEZzeGw=',
);

// ── Credential resolution ──

function getExtraMacOsSearchDirs(): string[] {
  if (process.platform !== 'darwin') return [];
  const dirs: string[] = [];
  dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  dirs.push(join(homedir(), '.npm-global', 'bin'));
  const nvmDir = process.env.NVM_DIR || join(homedir(), '.nvm');
  const nvmCurrent = join(nvmDir, 'current', 'bin');
  if (existsSync(nvmCurrent)) dirs.push(nvmCurrent);
  dirs.push(
    join(homedir(), '.local', 'bin'),
    join(homedir(), 'Library', 'Application Support', 'fnm', 'current', 'bin'),
    join(homedir(), '.volta', 'bin'),
    join(homedir(), '.asdf', 'shims'),
  );
  for (const cellarBase of ['/opt/homebrew/Cellar/node', '/usr/local/Cellar/node']) {
    try {
      for (const ver of readdirSync(cellarBase)) {
        dirs.push(join(cellarBase, ver, 'bin'));
      }
    } catch { /* ignore */ }
  }
  return dirs;
}

function findInPath(name: string): string | null {
  const exts = process.platform === 'win32' ? ['.cmd', '.bat', '.exe', ''] : [''];
  const searchDirs = (process.env.PATH ?? '').split(delimiter);
  for (const extra of getExtraMacOsSearchDirs()) {
    if (!searchDirs.includes(extra)) searchDirs.push(extra);
  }
  for (const dir of searchDirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function findFile(dir: string, name: string, depth: number): string | null {
  if (depth <= 0) return null;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory() && !e.name.startsWith('.')) {
        const found = findFile(p, name, depth - 1);
        if (found) return found;
      }
    }
  } catch { /* ignore */ }
  return null;
}

function resolveGeminiCliDir(geminiPath: string): string {
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(geminiPath)) {
    const npmPrefix = dirname(geminiPath);
    const packageDir = join(npmPrefix, 'node_modules', '@google', 'gemini-cli');
    if (existsSync(packageDir)) return packageDir;
  }
  const resolvedPath = realpathSync(geminiPath);
  return dirname(dirname(resolvedPath));
}

function findGeminiCliDirDirectly(): string | null {
  const candidates: string[] = [];
  candidates.push(
    join(homedir(), '.npm-global', 'lib', 'node_modules', '@google', 'gemini-cli'),
    '/usr/local/lib/node_modules/@google/gemini-cli',
    '/opt/homebrew/lib/node_modules/@google/gemini-cli',
  );
  const nvmDir = process.env.NVM_DIR || join(homedir(), '.nvm');
  candidates.push(join(nvmDir, 'current', 'lib', 'node_modules', '@google', 'gemini-cli'));
  candidates.push(join(homedir(), '.volta', 'tools', 'image', 'packages', '@google', 'gemini-cli'));
  for (const cellarBase of ['/opt/homebrew/Cellar/node', '/usr/local/Cellar/node']) {
    try {
      for (const ver of readdirSync(cellarBase)) {
        candidates.push(join(cellarBase, ver, 'lib', 'node_modules', '@google', 'gemini-cli'));
      }
    } catch { /* ignore */ }
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, 'package.json'))) return dir;
  }
  return null;
}

function extractGeminiCliCredentials(): { clientId: string; clientSecret: string } | null {
  try {
    let geminiCliDir: string | null = null;

    const geminiPath = findInPath('gemini');
    if (geminiPath) {
      geminiCliDir = resolveGeminiCliDir(geminiPath);
    }

    if (!geminiCliDir || !existsSync(geminiCliDir)) {
      geminiCliDir = findGeminiCliDirDirectly();
    }
    if (!geminiCliDir) return null;

    const searchPaths = [
      join(geminiCliDir, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js'),
      join(geminiCliDir, 'node_modules', '@google', 'gemini-cli-core', 'dist', 'code_assist', 'oauth2.js'),
    ];

    let content: string | null = null;
    for (const p of searchPaths) {
      if (existsSync(p)) {
        content = readFileSync(p, 'utf8');
        break;
      }
    }
    if (!content) {
      const found = findFile(geminiCliDir, 'oauth2.js', 10);
      if (found) content = readFileSync(found, 'utf8');
    }
    if (!content) return null;

    const idMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    const secretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/);
    if (idMatch && secretMatch) {
      return { clientId: idMatch[1], clientSecret: secretMatch[1] };
    }
  } catch { /* ignore */ }
  return null;
}

function resolveOAuthClientConfig(): { clientId: string; clientSecret?: string } {
  // 1. Env var overrides
  const envClientId = process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_ID
    || process.env.GEMINI_CLI_OAUTH_CLIENT_ID;
  if (envClientId) {
    const envClientSecret = process.env.OPENCLAW_GEMINI_OAUTH_CLIENT_SECRET
      || process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET;
    logger.info('Using Google OAuth credentials from environment variables');
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  // 2. Extract from installed Gemini CLI
  const extracted = extractGeminiCliCredentials();
  if (extracted) {
    logger.info('Extracted Google OAuth credentials from Gemini CLI');
    return extracted;
  }

  // 3. Built-in fallback — no Gemini CLI installed, use same creds as pi-ai
  logger.info('Using built-in Google OAuth credentials (Gemini CLI not found)');
  return { clientId: BUILTIN_CLIENT_ID, clientSecret: BUILTIN_CLIENT_SECRET };
}

// ── PKCE ──

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ── Callback server ──

// Use dynamic port (port 0 = OS picks a free port) to avoid conflicts
// with the Gateway's OAuth callback server which also uses port 8085.
// Google Desktop app OAuth clients allow any localhost port as redirect URI.

function startCallbackServer(): Promise<{ server: Server; port: number; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (err) => reject(err));
    server.listen(0, 'localhost', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const redirectUri = `http://localhost:${port}/oauth2callback`;
      logger.info(`[google-oauth] Callback server listening on ${redirectUri}`);
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

        if (requestUrl.pathname !== '/oauth2callback') {
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
  config: { clientId: string; clientSecret?: string },
  redirectUri: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (config.clientSecret) {
    body.set('client_secret', config.clientSecret);
  }

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

// ── User info ──

async function getUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const response = await fetch(USERINFO_URL, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (response.ok) {
      const data = await response.json() as { email?: string };
      return data.email;
    }
  } catch { /* ignore */ }
  return undefined;
}

// ── Project discovery (Code Assist) ──

function isVpcScAffected(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object') return false;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return false;
  const details = (error as { details?: unknown[] }).details;
  if (!Array.isArray(details)) return false;
  return details.some(
    (item) => typeof item === 'object' && item && (item as { reason?: string }).reason === 'SECURITY_POLICY_VIOLATED',
  );
}

function getDefaultTier(allowedTiers?: Array<{ id?: string; isDefault?: boolean }>): { id?: string } | undefined {
  if (!allowedTiers?.length) return { id: TIER_LEGACY };
  return allowedTiers.find((tier) => tier.isDefault) ?? { id: TIER_LEGACY };
}

async function pollOperation(
  operationName: string,
  headers: Record<string, string>,
): Promise<{ done?: boolean; response?: { cloudaicompanionProject?: { id?: string } } }> {
  for (let attempt = 0; attempt < 24; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const response = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal/${operationName}`, { headers });
    if (!response.ok) continue;
    const data = await response.json() as { done?: boolean; response?: { cloudaicompanionProject?: { id?: string } } };
    if (data.done) return data;
  }
  throw new Error('Operation polling timeout');
}

async function discoverProject(accessToken: string): Promise<string> {
  const envProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT_ID;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    'User-Agent': 'google-api-nodejs-client/9.15.1',
    'X-Goog-Api-Client': 'gl-node/openclaw',
  };

  const loadBody = {
    cloudaicompanionProject: envProject,
    metadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
      duetProject: envProject,
    },
  };

  type LoadResponse = {
    currentTier?: { id?: string };
    cloudaicompanionProject?: string | { id?: string };
    allowedTiers?: Array<{ id?: string; isDefault?: boolean }>;
  };

  let data: LoadResponse;

  const response = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:loadCodeAssist`, {
    method: 'POST',
    headers,
    body: JSON.stringify(loadBody),
  });

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => null);
    if (isVpcScAffected(errorPayload)) {
      data = { currentTier: { id: TIER_STANDARD } };
    } else {
      throw new Error(`loadCodeAssist failed: ${response.status} ${response.statusText}`);
    }
  } else {
    data = await response.json() as LoadResponse;
  }

  if (data.currentTier) {
    const project = data.cloudaicompanionProject;
    if (typeof project === 'string' && project) return project;
    if (typeof project === 'object' && project?.id) return project.id;
    if (envProject) return envProject;
    throw new Error(
      'This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.',
    );
  }

  const tier = getDefaultTier(data.allowedTiers);
  const tierId = tier?.id || TIER_FREE;
  if (tierId !== TIER_FREE && !envProject) {
    throw new Error(
      'This account requires GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID to be set.',
    );
  }

  const onboardBody: Record<string, unknown> = {
    tierId,
    metadata: {
      ideType: 'IDE_UNSPECIFIED',
      platform: 'PLATFORM_UNSPECIFIED',
      pluginType: 'GEMINI',
    },
  };
  if (tierId !== TIER_FREE && envProject) {
    onboardBody.cloudaicompanionProject = envProject;
    (onboardBody.metadata as Record<string, unknown>).duetProject = envProject;
  }

  const onboardResponse = await fetch(`${CODE_ASSIST_ENDPOINT}/v1internal:onboardUser`, {
    method: 'POST',
    headers,
    body: JSON.stringify(onboardBody),
  });

  if (!onboardResponse.ok) {
    throw new Error(`onboardUser failed: ${onboardResponse.status} ${onboardResponse.statusText}`);
  }

  let lro = await onboardResponse.json() as {
    done?: boolean;
    name?: string;
    response?: { cloudaicompanionProject?: { id?: string } };
  };

  if (!lro.done && lro.name) {
    lro = await pollOperation(lro.name, headers);
  }

  const projectId = lro.response?.cloudaicompanionProject?.id;
  if (projectId) return projectId;
  if (envProject) return envProject;

  throw new Error(
    'Could not discover or provision a Google Cloud project. Set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID.',
  );
}

// ── Auth profile persistence ──

function writeAuthProfile(credential: {
  access: string;
  refresh?: string;
  expires: number;
  email?: string;
  projectId: string;
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

  // Remove ALL existing google-gemini-cli profiles before writing the new one.
  // When a user re-authenticates with a different Google account, the old profile
  // becomes stale and can cause OpenClaw to pick the wrong (broken) credentials.
  const providerType = 'google-gemini-cli';
  for (const key of Object.keys(store.profiles)) {
    if (key.startsWith(`${providerType}:`)) {
      delete store.profiles[key];
    }
  }
  if (store.order?.[providerType]) {
    store.order[providerType] = [];
  }

  const profileId = credential.email
    ? `google-gemini-cli:${credential.email}`
    : 'google-gemini-cli:default';

  store.profiles[profileId] = {
    type: 'oauth',
    provider: 'google-gemini-cli',
    access: credential.access,
    refresh: credential.refresh,
    expires: credential.expires,
    email: credential.email,
    projectId: credential.projectId,
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

// Refresh the Google OAuth token BEFORE it expires using the same client
// credentials that were used for the initial login. This is critical because
// pi-ai's built-in refreshToken() uses its own hardcoded credentials, which
// may differ from those extracted from the user's Gemini CLI installation.
// By refreshing proactively, the token is always fresh and pi-ai never needs
// to call its own refresh.

let googleRefreshTimer: ReturnType<typeof setTimeout> | null = null;

function readGoogleOAuthProfile(): {
  profileId: string;
  access: string;
  refresh: string;
  expires: number;
  projectId: string;
  email?: string;
} | null {
  const authPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
  try {
    if (!existsSync(authPath)) return null;
    const store = JSON.parse(readFileSync(authPath, 'utf-8'));
    if (!store?.profiles) return null;

    // Find any google-gemini-cli OAuth profile
    for (const [id, profile] of Object.entries(store.profiles)) {
      const p = profile as Record<string, unknown>;
      if (p.provider === 'google-gemini-cli' && p.type === 'oauth' && p.refresh && p.expires) {
        return {
          profileId: id,
          access: p.access as string,
          refresh: p.refresh as string,
          expires: p.expires as number,
          projectId: p.projectId as string,
          email: p.email as string | undefined,
        };
      }
    }
  } catch { /* ignore */ }
  return null;
}

async function refreshGoogleAccessToken(
  refreshToken: string,
  config: { clientId: string; clientSecret?: string },
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in: number;
} | null> {
  try {
    const body = new URLSearchParams({
      client_id: config.clientId,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    if (config.clientSecret) {
      body.set('client_secret', config.clientSecret);
    }

    const response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error(`[google-oauth] Token refresh failed (${response.status}): ${errorText}`);
      return null;
    }

    const data = await response.json() as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    if (!data.access_token) {
      logger.error('[google-oauth] No access token in refresh response');
      return null;
    }

    return data;
  } catch (err) {
    logger.error('[google-oauth] Token refresh error:', err instanceof Error ? err.message : err);
    return null;
  }
}

function scheduleGoogleRefresh(): void {
  if (googleRefreshTimer) {
    clearTimeout(googleRefreshTimer);
    googleRefreshTimer = null;
  }

  const profile = readGoogleOAuthProfile();
  if (!profile) {
    logger.debug('[google-oauth] No Google OAuth profile found, skipping proactive refresh');
    return;
  }

  if (!profile.projectId) {
    logger.warn('[google-oauth] Google OAuth profile missing projectId — token is unusable, skipping refresh');
    return;
  }

  // Refresh 10 minutes before expiry
  const refreshAt = profile.expires - 10 * 60 * 1000;
  const delayMs = Math.max(refreshAt - Date.now(), 5000);

  if (Date.now() >= profile.expires) {
    logger.warn('[google-oauth] Token already expired, attempting immediate refresh...');
    void doGoogleProactiveRefresh();
    return;
  }

  logger.info(`[google-oauth] Scheduling proactive refresh in ${Math.round(delayMs / 60000)} min (expires: ${new Date(profile.expires).toISOString()})`);

  googleRefreshTimer = setTimeout(() => {
    void doGoogleProactiveRefresh();
  }, delayMs);

  if (googleRefreshTimer && typeof googleRefreshTimer === 'object' && 'unref' in googleRefreshTimer) {
    googleRefreshTimer.unref();
  }
}

async function doGoogleProactiveRefresh(): Promise<void> {
  const profile = readGoogleOAuthProfile();
  if (!profile) return;

  logger.info('[google-oauth] Proactive token refresh starting...');

  // Use the same credentials resolution as login — this ensures we use
  // the same client_id/secret that was used to obtain the token.
  const config = resolveOAuthClientConfig();

  const tokens = await refreshGoogleAccessToken(profile.refresh, config);
  if (tokens) {
    const expires = Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000;
    writeAuthProfile({
      access: tokens.access_token,
      refresh: tokens.refresh_token || profile.refresh,
      expires,
      email: profile.email,
      projectId: profile.projectId,
    });
    logger.info('[google-oauth] Proactive refresh successful, new token written');
    notifyRenderer('google-gemini-cli', true);

    // Schedule next refresh
    scheduleGoogleRefresh();
  } else {
    logger.error('[google-oauth] Proactive refresh failed — user will need to re-authenticate');
    notifyRenderer('google-gemini-cli', false, 'Token refresh failed. Please re-authenticate.');
    // Retry in 5 minutes in case it was a transient error
    googleRefreshTimer = setTimeout(() => void doGoogleProactiveRefresh(), 5 * 60 * 1000);
    if (googleRefreshTimer && typeof googleRefreshTimer === 'object' && 'unref' in googleRefreshTimer) {
      googleRefreshTimer.unref();
    }
  }
}

/**
 * Start proactive OAuth token refresh for Google Gemini CLI.
 * Call this once during app startup. It monitors the token expiry
 * and refreshes before it expires, using the same credentials as login.
 */
export function startGoogleProactiveTokenRefresh(): void {
  scheduleGoogleRefresh();
}

/**
 * Stop proactive token refresh (for cleanup).
 */
export function stopGoogleProactiveTokenRefresh(): void {
  if (googleRefreshTimer) {
    clearTimeout(googleRefreshTimer);
    googleRefreshTimer = null;
  }
}

// ── Public API ──

export async function runGoogleOAuthFlow(): Promise<{
  success: boolean;
  error?: string;
  email?: string;
}> {
  // 1. Resolve credentials
  logger.info('Starting Google OAuth PKCE flow');
  const config = resolveOAuthClientConfig();
  logger.info('Resolved Google OAuth client credentials');

  // 2. Generate PKCE
  const { verifier, challenge } = generatePkce();

  // 3. Start callback server (dynamic port to avoid conflicts with Gateway on 8085)
  const { server, redirectUri } = await startCallbackServer();

  // 4. Build auth URL with the dynamic redirect URI
  const state = randomBytes(16).toString('hex');
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  });
  const authUrl = `${AUTH_URL}?${params}`;

  // 5. Open browser for consent
  logger.info('Opening browser for Google OAuth consent');
  await openExternalInDefaultProfile(authUrl);

  // 6. Wait for callback
  const { code } = await waitForCallback(server, state, CALLBACK_TIMEOUT_MS);
  logger.info('Received OAuth callback with authorization code');

  // 7. Exchange code for tokens
  const tokens = await exchangeCodeForTokens(code, verifier, config, redirectUri);
  logger.info('Token exchange successful');

  // 8. Get user email
  const email = await getUserEmail(tokens.access_token);
  logger.info(`OAuth user: ${email || 'unknown'}`);

  // 9. Discover/provision project (required — without projectId the credential is unusable)
  let projectId: string;
  try {
    projectId = await discoverProject(tokens.access_token);
    logger.info(`Google Cloud project: ${projectId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Project discovery failed:', msg);
    throw new Error(
      `Google OAuth login succeeded but project discovery failed: ${msg}. ` +
      'You may need to set GOOGLE_CLOUD_PROJECT or GOOGLE_CLOUD_PROJECT_ID environment variable.',
    );
  }

  // 10. Write auth profile
  const expires = Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000;
  writeAuthProfile({
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires,
    email,
    projectId,
  });
  logger.info('Google OAuth credentials saved to auth-profiles.json');

  // Kick off proactive refresh for the new token
  scheduleGoogleRefresh();

  return { success: true, email };
}
