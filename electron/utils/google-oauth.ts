/**
 * Google OAuth via Gemini CLI.
 *
 * Reads tokens directly from Gemini CLI's credential store (~/.gemini/)
 * instead of reimplementing the OAuth PKCE flow. Requires the user to
 * have authenticated with `gemini auth login` first.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { logger } from './logger';

// ── Paths ──
const GEMINI_DIR = join(homedir(), '.gemini');
const OAUTH_CREDS_PATH = join(GEMINI_DIR, 'oauth_creds.json');
const GOOGLE_ACCOUNTS_PATH = join(GEMINI_DIR, 'google_accounts.json');

// ── Project discovery (Code Assist) ──

const CODE_ASSIST_ENDPOINT = 'https://cloudcode-pa.googleapis.com';
const TIER_FREE = 'free-tier';
const TIER_LEGACY = 'legacy-tier';
const TIER_STANDARD = 'standard-tier';

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

  let store: { version?: number; profiles?: Record<string, unknown> } = { version: 1, profiles: {} };
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

  writeFileSync(authProfilesPath, JSON.stringify(store, null, 2), 'utf-8');
}

// ── Gemini CLI credential reader ──

interface GeminiCliCreds {
  access_token: string;
  refresh_token?: string;
  expiry_date: number;
}

function readGeminiCliCreds(): GeminiCliCreds | null {
  if (!existsSync(OAUTH_CREDS_PATH)) return null;
  try {
    const data = JSON.parse(readFileSync(OAUTH_CREDS_PATH, 'utf-8'));
    if (!data.access_token) return null;
    return data as GeminiCliCreds;
  } catch {
    return null;
  }
}

function readGeminiCliEmail(): string | undefined {
  if (!existsSync(GOOGLE_ACCOUNTS_PATH)) return undefined;
  try {
    const data = JSON.parse(readFileSync(GOOGLE_ACCOUNTS_PATH, 'utf-8'));
    return typeof data.active === 'string' ? data.active : undefined;
  } catch {
    return undefined;
  }
}

// ── Public API ──

export async function runGoogleOAuthFlow(): Promise<{
  success: boolean;
  error?: string;
  email?: string;
}> {
  logger.info('Reading Google OAuth credentials from Gemini CLI');

  // 1. Read tokens from Gemini CLI's credential store (~/.gemini/)
  const creds = readGeminiCliCreds();
  if (!creds) {
    const msg = 'No Gemini CLI credentials found. Install Gemini CLI ' +
      '(npm install -g @google/gemini-cli) and run: gemini auth login';
    logger.error(msg);
    return { success: false, error: msg };
  }

  // 2. Read email from Gemini CLI accounts
  const email = readGeminiCliEmail();
  logger.info(`Gemini CLI user: ${email || 'unknown'}`);

  // 3. Discover/provision GCP project (needed by Gateway for API calls)
  let projectId: string | undefined;
  try {
    projectId = await discoverProject(creds.access_token);
    logger.info(`Google Cloud project: ${projectId}`);
  } catch (err) {
    logger.warn('Project discovery failed (non-critical):', err);
  }

  // 4. Write auth profile for OpenClaw Gateway
  const expires = creds.expiry_date - 5 * 60 * 1000; // 5 min safety margin
  writeAuthProfile({
    access: creds.access_token,
    refresh: creds.refresh_token,
    expires,
    email,
    projectId,
  });
  logger.info('Google OAuth credentials synced from Gemini CLI to auth-profiles.json');

  return { success: true, email };
}
