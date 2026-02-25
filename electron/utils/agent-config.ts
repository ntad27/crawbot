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
