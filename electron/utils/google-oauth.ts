/**
 * Google OAuth PKCE flow for Gemini CLI authentication.
 *
 * Implements the same flow as OpenClaw's google-gemini-cli-auth extension
 * but runs natively in Electron's main process (no TTY required).
 *
 * Credential resolution order:
 *  1. Env vars: OPENCLAW_GEMINI_OAUTH_CLIENT_ID / GEMINI_CLI_OAUTH_CLIENT_ID
 *  2. Extracted from installed Gemini CLI's bundled oauth2.js
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { openExternalInDefaultProfile } from './open-external';
import { logger } from './logger';

// ── OAuth constants (same as openclaw/extensions/google-gemini-cli-auth) ──
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const REDIRECT_URI = 'http://localhost:8085/oauth2callback';
const REDIRECT_PORT = 8085;
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];
const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const TIER_FREE = 'free-tier';
const TIER_LEGACY = 'legacy-tier';
const TIER_STANDARD = 'standard-tier';

// ── Credential resolution ──

function getExtraMacOsSearchDirs(): string[] {
  if (process.platform !== 'darwin') return [];
  const dirs: string[] = [];
  // Homebrew bin directories (Apple Silicon + Intel)
  dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  // Common npm global bin locations
  dirs.push(join(homedir(), '.npm-global', 'bin'));
  // nvm current version bin
  const nvmDir = process.env.NVM_DIR || join(homedir(), '.nvm');
  const nvmCurrent = join(nvmDir, 'current', 'bin');
  if (existsSync(nvmCurrent)) dirs.push(nvmCurrent);
  // fnm, volta, asdf shims
  dirs.push(
    join(homedir(), '.local', 'bin'),
    join(homedir(), 'Library', 'Application Support', 'fnm', 'current', 'bin'),
    join(homedir(), '.volta', 'bin'),
    join(homedir(), '.asdf', 'shims'),
  );
  // Homebrew Cellar node bin (versioned) — scan for any installed node version
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
  // On macOS, Electron GUI apps get a minimal PATH; add common locations
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
    // On Windows, npm global installs create .cmd/.bat wrappers instead of symlinks.
    // realpathSync won't resolve them, so dirname(dirname()) would land in the wrong
    // directory. The package lives at {npmPrefix}/node_modules/@google/gemini-cli.
    const npmPrefix = dirname(geminiPath);
    const packageDir = join(npmPrefix, 'node_modules', '@google', 'gemini-cli');
    if (existsSync(packageDir)) return packageDir;
  }
  // Unix: symlink → realpathSync resolves to dist/index.js → dirname×2 = package root
  const resolvedPath = realpathSync(geminiPath);
  return dirname(dirname(resolvedPath));
}

/**
 * On macOS, find the gemini-cli package directory by checking well-known
 * npm/node_modules global roots. This is a fallback when findInPath('gemini')
 * can't locate the binary (e.g. Electron GUI PATH doesn't include it).
 */
function findGeminiCliDirDirectly(): string | null {
  const candidates: string[] = [];
  // npm global roots
  candidates.push(
    join(homedir(), '.npm-global', 'lib', 'node_modules', '@google', 'gemini-cli'),
    '/usr/local/lib/node_modules/@google/gemini-cli',
    '/opt/homebrew/lib/node_modules/@google/gemini-cli',
  );
  // nvm
  const nvmDir = process.env.NVM_DIR || join(homedir(), '.nvm');
  const nvmCurrent = join(nvmDir, 'current', 'lib', 'node_modules', '@google', 'gemini-cli');
  candidates.push(nvmCurrent);
  // volta
  candidates.push(join(homedir(), '.volta', 'tools', 'image', 'packages', '@google', 'gemini-cli'));
  // Homebrew Cellar node (versioned)
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

    // Fallback: search well-known npm global roots directly
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
  logger.info('Extracting Google OAuth credentials from Gemini CLI installation...');
  const extracted = extractGeminiCliCredentials();
  if (extracted) {
    logger.info('Successfully extracted Google OAuth credentials from Gemini CLI');
    return extracted;
  }

  logger.error(
    'Failed to find Gemini CLI credentials. ' +
    `PATH dirs searched: ${(process.env.PATH ?? '').split(delimiter).length} entries. ` +
    `Platform: ${process.platform}`,
  );
  throw new Error(
    'Google OAuth credentials not found. Install Gemini CLI ' +
    '(npm install -g @google/gemini-cli) to enable Google OAuth authentication.'
  );
}

// ── PKCE ──

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

// ── Callback server ──

function waitForLocalCallback(
  expectedState: string,
  timeoutMs: number,
): Promise<{ code: string; server: Server }> {
  return new Promise((resolve, reject) => {
    let timeout: NodeJS.Timeout | null = null;
    let settled = false;

    const server = createServer((req, res) => {
      try {
        const requestUrl = new URL(req.url ?? '/', `http://localhost:${REDIRECT_PORT}`);
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
          res.end(`<html><body><h2>Authentication Failed</h2><p>${error}</p></body></html>`);
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
          '<!doctype html><html><body>' +
          '<h2>Authentication successful!</h2>' +
          '<p>You can close this window and return to CrawBot.</p>' +
          '</body></html>'
        );
        finish(undefined, code);
      } catch (err) {
        finish(err instanceof Error ? err : new Error('OAuth callback failed'));
      }
    });

    const finish = (err?: Error, code?: string) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (err) {
        try { server.close(); } catch { /* ignore */ }
        reject(err);
      } else if (code) {
        resolve({ code, server });
      }
    };

    server.once('error', (err) => {
      finish(err instanceof Error ? err : new Error('OAuth callback server error'));
    });

    server.listen(REDIRECT_PORT, 'localhost', () => {
      logger.info(`OAuth callback server listening on ${REDIRECT_URI}`);
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
): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
  const body = new URLSearchParams({
    client_id: config.clientId,
    code,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI,
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
  projectId?: string;
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

  const providerType = 'google-gemini-cli';
  if (!store.order) store.order = {};
  if (!store.order[providerType]) store.order[providerType] = [];
  if (!store.order[providerType].includes(profileId)) {
    store.order[providerType].push(profileId);
  }

  if (!store.lastGood) store.lastGood = {};
  store.lastGood[providerType] = profileId;

  writeFileSync(authProfilesPath, JSON.stringify(store, null, 2), 'utf-8');
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

  // 3. Build auth URL
  const params = new URLSearchParams({
    client_id: config.clientId,
    response_type: 'code',
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: verifier,
    access_type: 'offline',
    prompt: 'consent',
  });
  const authUrl = `${AUTH_URL}?${params}`;

  // 4. Start callback server, then open browser
  const callbackPromise = waitForLocalCallback(verifier, CALLBACK_TIMEOUT_MS);

  // Small delay to ensure server is listening before opening browser
  await new Promise((r) => setTimeout(r, 300));
  logger.info('Opening browser for Google OAuth consent');
  await openExternalInDefaultProfile(authUrl);

  // 5. Wait for callback
  const { code, server } = await callbackPromise;
  server.close();
  logger.info('Received OAuth callback with authorization code');

  // 6. Exchange code for tokens
  const tokens = await exchangeCodeForTokens(code, verifier, config);
  logger.info('Token exchange successful');

  // 7. Get user email
  const email = await getUserEmail(tokens.access_token);
  logger.info(`OAuth user: ${email || 'unknown'}`);

  // 8. Discover/provision project
  let projectId: string | undefined;
  try {
    projectId = await discoverProject(tokens.access_token);
    logger.info(`Google Cloud project: ${projectId}`);
  } catch (err) {
    logger.warn('Project discovery failed (non-critical):', err);
  }

  // 9. Write auth profile
  const expires = Date.now() + tokens.expires_in * 1000 - 5 * 60 * 1000;
  writeAuthProfile({
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires,
    email,
    projectId,
  });
  logger.info('Google OAuth credentials saved to auth-profiles.json');

  return { success: true, email };
}
