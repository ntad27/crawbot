/**
 * Agent Config Utilities
 * Direct read/write access to agent configuration in ~/.openclaw/openclaw.json
 * and agent workspace files (AGENTS.md, SOUL.md, etc.)
 *
 * Schema reference: node_modules/openclaw/dist/plugin-sdk/config/types.agents.d.ts
 *
 * Agent entries preserve all unknown fields — we only read/write the fields
 * we care about and pass everything else through untouched.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as logger from './logger';

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const CONFIG_FILE = join(OPENCLAW_DIR, 'openclaw.json');

/**
 * Agent entry — mirrors OpenClaw AgentConfig.
 * Uses Record to preserve unknown fields when round-tripping.
 */
interface AgentEntry extends Record<string, unknown> {
  id: string;
  default?: boolean;
  name?: string;
  workspace?: string;
  agentDir?: string;
  model?: string | { primary?: string; fallbacks?: string[] };
  identity?: { emoji?: string };
  skills?: string[];
}

interface AgentDefaults extends Record<string, unknown> {
  workspace?: string;
  skipBootstrap?: boolean;
  model?: {
    primary?: string;
    fallbacks?: string[];
  };
}

interface OpenClawConfig {
  agents?: {
    defaults?: AgentDefaults;
    list?: AgentEntry[];
    [key: string]: unknown;
  };
  channels?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Ensure OpenClaw config directory exists
 */
function ensureConfigDir(): void {
  if (!existsSync(OPENCLAW_DIR)) {
    mkdirSync(OPENCLAW_DIR, { recursive: true });
  }
}

/**
 * Read the current OpenClaw config
 */
function readConfig(): OpenClawConfig {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return {};
  }
  try {
    const raw = readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    logger.error('Failed to read openclaw config', err);
    return {};
  }
}

/**
 * Write the OpenClaw config
 */
function writeConfig(config: OpenClawConfig): void {
  ensureConfigDir();
  const json = JSON.stringify(config, null, 2);
  writeFileSync(CONFIG_FILE, json, 'utf-8');
}

/**
 * Get the agent list from config
 */
export function getAgentList(): AgentEntry[] {
  const config = readConfig();
  return config.agents?.list ?? [];
}

/**
 * Get agent defaults from config
 */
export function getAgentDefaults(): AgentDefaults | null {
  const config = readConfig();
  return config.agents?.defaults ?? null;
}

/**
 * Get a single agent by id
 */
export function getAgent(id: string): AgentEntry | undefined {
  const list = getAgentList();
  return list.find((a) => a.id === id);
}

/**
 * Save (create or update) an agent in agents.list.
 * Merges with existing entry to preserve unknown fields.
 */
export function saveAgent(agent: AgentEntry): void {
  const config = readConfig();

  if (!config.agents) {
    config.agents = {};
  }
  if (!config.agents.list) {
    config.agents.list = [];
  }

  const idx = config.agents.list.findIndex((a) => a.id === agent.id);
  if (idx >= 0) {
    // Merge: preserve existing fields, overlay our updates
    config.agents.list[idx] = { ...config.agents.list[idx], ...agent };
  } else {
    config.agents.list.push(agent);
  }

  // If this agent is set as default, unset default on all others
  if (agent.default) {
    for (const a of config.agents.list) {
      if (a.id !== agent.id) {
        delete a.default;
      }
    }
  }

  writeConfig(config);
  logger.info('Agent saved', { agentId: agent.id });
}

/**
 * Delete an agent from agents.list
 */
export function deleteAgent(id: string): void {
  if (id === 'main') {
    throw new Error('Cannot delete the default "main" agent');
  }

  const config = readConfig();
  if (!config.agents?.list) return;

  // Find agent entry before removing — need workspace path
  const agent = config.agents.list.find((a) => a.id === id);
  const workspace = agent?.workspace as string | undefined;

  // Remove from config
  config.agents.list = config.agents.list.filter((a) => a.id !== id);
  writeConfig(config);

  // Delete workspace directory
  if (workspace && existsSync(workspace)) {
    try {
      rmSync(workspace, { recursive: true, force: true });
      logger.info('Agent workspace deleted', { agentId: id, workspace });
    } catch (err) {
      logger.warn('Failed to delete agent workspace', { agentId: id, workspace, error: String(err) });
    }
  }

  // Delete agent runtime directory (~/.openclaw/agents/{id}/)
  const agentRuntimeDir = join(OPENCLAW_DIR, 'agents', id);
  if (existsSync(agentRuntimeDir)) {
    try {
      rmSync(agentRuntimeDir, { recursive: true, force: true });
      logger.info('Agent runtime dir deleted', { agentId: id, dir: agentRuntimeDir });
    } catch (err) {
      logger.warn('Failed to delete agent runtime dir', { agentId: id, error: String(err) });
    }
  }

  logger.info('Agent deleted', { agentId: id });
}

/**
 * Get all editable files in a workspace directory
 * Returns *.md at root + memory/*.md
 */
export function getAgentWorkspaceFiles(workspacePath: string): Array<{
  name: string;
  path: string;
  isDirectory: boolean;
}> {
  const files: Array<{ name: string; path: string; isDirectory: boolean }> = [];

  if (!existsSync(workspacePath)) {
    return files;
  }

  try {
    // Root-level .md files
    const entries = readdirSync(workspacePath);
    for (const entry of entries) {
      const fullPath = join(workspacePath, entry);
      const stat = statSync(fullPath);

      if (stat.isFile() && entry.endsWith('.md')) {
        files.push({ name: entry, path: fullPath, isDirectory: false });
      }
    }

    // memory/*.md files
    const memoryDir = join(workspacePath, 'memory');
    if (existsSync(memoryDir) && statSync(memoryDir).isDirectory()) {
      const memEntries = readdirSync(memoryDir);
      for (const entry of memEntries) {
        const fullPath = join(memoryDir, entry);
        const stat = statSync(fullPath);
        if (stat.isFile() && entry.endsWith('.md')) {
          files.push({
            name: `memory/${entry}`,
            path: fullPath,
            isDirectory: false,
          });
        }
      }
    }
  } catch (err) {
    logger.error('Failed to list workspace files', err);
  }

  return files;
}

/**
 * Read a workspace file
 */
export function readWorkspaceFile(filePath: string): string {
  if (!existsSync(filePath)) {
    return '';
  }
  return readFileSync(filePath, 'utf-8');
}

/**
 * Write a workspace file
 */
export function writeWorkspaceFile(filePath: string, content: string): void {
  // Ensure parent directory exists
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, content, 'utf-8');
  logger.info('Workspace file written', { filePath });
}

/**
 * Create a workspace directory for a new agent.
 * Only creates the empty directory — OpenClaw's bootstrap process
 * (skipBootstrap: false) will populate it with rich template files
 * (AGENTS.md, SOUL.md, IDENTITY.md, etc.) on the agent's first session.
 */
export function createWorkspaceDir(workspacePath: string): void {
  if (!existsSync(workspacePath)) {
    mkdirSync(workspacePath, { recursive: true });
  }

  logger.info('Workspace directory created', { workspacePath });
}

/**
 * List subdirectories inside ~/.openclaw/ for workspace selection
 */
export function listOpenclawFolders(): string[] {
  if (!existsSync(OPENCLAW_DIR)) {
    return [];
  }

  try {
    const entries = readdirSync(OPENCLAW_DIR);
    const folders: string[] = [];
    for (const entry of entries) {
      const fullPath = join(OPENCLAW_DIR, entry);
      try {
        if (statSync(fullPath).isDirectory()) {
          folders.push(entry);
        }
      } catch {
        // skip inaccessible entries
      }
    }
    return folders.sort();
  } catch (err) {
    logger.error('Failed to list openclaw folders', err);
    return [];
  }
}

/**
 * Create a new folder inside ~/.openclaw/
 * Returns the full path of the created folder
 */
export function createOpenclawFolder(name: string): string {
  ensureConfigDir();
  const folderPath = join(OPENCLAW_DIR, name);
  if (!existsSync(folderPath)) {
    mkdirSync(folderPath, { recursive: true });
    logger.info('Created openclaw folder', { folderPath });
  }
  return folderPath;
}

/**
 * Get the .openclaw directory path
 */
export function getOpenclawDirPath(): string {
  return OPENCLAW_DIR;
}

// ── Tools exec config helpers ──────────────────────────────────

/**
 * Read tools.exec auto-approve state from openclaw.json.
 * Returns true if security="full" && ask="off",
 * false if security="allowlist" && ask="on-miss",
 * or undefined if not configured or has invalid/unrecognised values.
 */
export function getToolsAutoApproveFromConfig(): boolean | undefined {
  const config = readConfig();
  const tools = config.tools as Record<string, unknown> | undefined;
  if (!tools?.exec) return undefined;
  const exec = tools.exec as Record<string, unknown>;
  if (exec.security === 'full' && exec.ask === 'off') return true;
  if (exec.security === 'allowlist' && exec.ask === 'on-miss') return false;
  return undefined; // invalid or unrecognised combination
}

/**
 * Set tools.exec auto-approve config in openclaw.json.
 * When enabled: sets security="full", ask="off" (agent runs tools freely).
 * When disabled: sets security="allowlist", ask="on-miss" (safe defaults).
 * Only touches tools.exec — preserves all other fields inside tools.
 */
export function setToolsAutoApprove(enabled: boolean): void {
  const config = readConfig();

  if (!config.tools) config.tools = {};
  const tools = config.tools as Record<string, unknown>;
  const existingExec = (tools.exec as Record<string, unknown>) ?? {};

  if (enabled) {
    tools.exec = { ...existingExec, security: 'full', ask: 'off' };
  } else {
    tools.exec = { ...existingExec, security: 'allowlist', ask: 'on-miss' };
  }

  writeConfig(config);
  logger.info('Tools auto-approve updated', { enabled });
}

// ── Session dmScope config helper ──────────────────────────────────

type DmScope = 'main' | 'per-peer' | 'per-channel-peer' | 'per-account-channel-peer';
const VALID_DM_SCOPES: DmScope[] = ['main', 'per-peer', 'per-channel-peer', 'per-account-channel-peer'];

/**
 * Read session.dmScope from openclaw.json.
 * Returns the scope value if set, or undefined if not configured.
 */
export function getSessionDmScopeFromConfig(): DmScope | undefined {
  const config = readConfig();
  const session = config.session as Record<string, unknown> | undefined;
  const scope = session?.dmScope as string | undefined;
  if (!scope) return undefined;
  if (VALID_DM_SCOPES.includes(scope as DmScope)) {
    return scope as DmScope;
  }
  return undefined;
}

/**
 * Set session.dmScope in openclaw.json.
 * Only touches session.dmScope — preserves all other fields inside session.
 */
export function setSessionDmScope(scope: DmScope): void {
  const config = readConfig();

  if (!config.session) config.session = {};
  const session = config.session as Record<string, unknown>;
  session.dmScope = scope;

  writeConfig(config);
  logger.info('Session dmScope updated', { scope });
}

// ── Screenshot max side config helper ──────────────────────────────

// ── CrawBot-specific settings file ─────────────────────────────
// Stored separately from openclaw.json (which has strict schema validation)
// at ~/.openclaw/crawbot-settings.json

const CRAWBOT_SETTINGS_FILE = join(OPENCLAW_DIR, 'crawbot-settings.json');

function readCrawbotSettings(): Record<string, unknown> {
  try {
    if (existsSync(CRAWBOT_SETTINGS_FILE)) {
      return JSON.parse(readFileSync(CRAWBOT_SETTINGS_FILE, 'utf-8'));
    }
  } catch (err) {
    logger.error('Failed to read crawbot-settings.json', err);
  }
  return {};
}

function writeCrawbotSettings(settings: Record<string, unknown>): void {
  ensureConfigDir();
  writeFileSync(CRAWBOT_SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * Read screenshotMaxSide from crawbot-settings.json.
 * Returns the value if set, or undefined if not configured.
 */
export function getScreenshotMaxSideFromConfig(): number | undefined {
  const settings = readCrawbotSettings();
  const value = settings.screenshotMaxSide;
  if (typeof value === 'number' && value >= 1000 && value <= 32000) {
    return value;
  }
  return undefined;
}

/**
 * Set screenshotMaxSide in crawbot-settings.json.
 * This value is read by the ESM loader patch at Gateway startup.
 * Requires Gateway restart to take effect.
 */
export function setScreenshotMaxSide(value: number): void {
  const settings = readCrawbotSettings();
  settings.screenshotMaxSide = value;
  writeCrawbotSettings(settings);
  logger.info('Screenshot max side updated', { value });
}

// ── Generic file-browser helpers ──────────────────────────────────

const MAX_READ_SIZE = 1 * 1024 * 1024; // 1 MB guard

/**
 * List all entries in a directory (files + subdirectories).
 * Returns dirs first, then files, both sorted alphabetically.
 * Skips hidden entries (dotfiles) by default.
 */
export function listDirectoryContents(
  dirPath: string,
  showHidden = false,
): Array<{ name: string; path: string; isDirectory: boolean }> {
  if (!existsSync(dirPath)) return [];

  try {
    const entries = readdirSync(dirPath);
    const dirs: Array<{ name: string; path: string; isDirectory: boolean }> = [];
    const files: Array<{ name: string; path: string; isDirectory: boolean }> = [];

    for (const entry of entries) {
      if (!showHidden && entry.startsWith('.')) continue;
      const fullPath = join(dirPath, entry);
      try {
        const stat = statSync(fullPath);
        const item = { name: entry, path: fullPath, isDirectory: stat.isDirectory() };
        if (stat.isDirectory()) dirs.push(item);
        else files.push(item);
      } catch {
        // skip inaccessible entries
      }
    }

    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    return [...dirs, ...files];
  } catch (err) {
    logger.error('Failed to list directory', err);
    return [];
  }
}

/**
 * Read any file as UTF-8 (with size guard).
 */
export function readAnyFile(filePath: string): { content: string; truncated: boolean } {
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }
  const stat = statSync(filePath);
  if (stat.size > MAX_READ_SIZE) {
    const content = readFileSync(filePath, 'utf-8').slice(0, MAX_READ_SIZE);
    return { content, truncated: true };
  }
  return { content: readFileSync(filePath, 'utf-8'), truncated: false };
}

/**
 * Write any file as UTF-8 (creates parent dirs if needed).
 */
export function writeAnyFile(filePath: string, content: string): void {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  if (dir && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(filePath, content, 'utf-8');
  logger.info('File written', { filePath });
}

/**
 * List configured channel types (for agent-channel binding UI)
 */
export function listChannelTypes(): string[] {
  const config = readConfig();
  const channels: string[] = [];

  if (config.channels) {
    channels.push(...Object.keys(config.channels));
  }

  return channels;
}
