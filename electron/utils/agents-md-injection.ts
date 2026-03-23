/**
 * AGENTS.md CrawBot Context Injection
 * Appends/updates a <crawbot> block in every workspace's AGENTS.md
 * so agents know they're running inside CrawBot.
 *
 * The Browser Tool section is only included when useBuiltinBrowser is enabled.
 */
import { app } from 'electron';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { platform, arch } from 'os';

import { getOpenClawConfigDir, getOpenClawStatus } from './paths';
import { getUseBuiltinBrowserFromConfig } from './agent-config';
import { logger } from './logger';

const BLOCK_START = '<crawbot>';
const BLOCK_END = '</crawbot>';

/**
 * Build the CrawBot context block content
 * @param includeBuiltinBrowser - whether to include Browser Tool instructions
 */
function buildCrawBotBlock(includeBuiltinBrowser: boolean): string {
  const crawBotVersion = app.getVersion();
  const openClawStatus = getOpenClawStatus();
  const openClawVersion = openClawStatus.version ?? 'unknown';
  const openClawDir = openClawStatus.dir;
  const plat = platform();
  const archt = arch();

  const browserSection = includeBuiltinBrowser
    ? `
### Browser Tool
- CrawBot provides a **built-in browser** accessible via the browser tool. **Do NOT specify a profile parameter** — the default profile automatically routes to CrawBot's built-in browser.
- Never use \`profile="user"\`, \`profile="chrome"\`, or \`profile="chrome-relay"\` unless the user explicitly asks to use their real Chrome browser.
- When the user asks you to browse, open a website, or check something on the web, simply use the browser tool without any profile parameter.
`
    : '';

  return `${BLOCK_START}
## CrawBot Runtime Context

You are running inside **CrawBot** (v${crawBotVersion}), an Electron desktop application that provides a graphical interface for OpenClaw AI agents.

### Environment
- **CrawBot version:** ${crawBotVersion}
- **OpenClaw version:** ${openClawVersion}
- **OpenClaw path:** ${openClawDir}
- **Platform:** ${plat}/${archt}

### Architecture
CrawBot is a dual-process Electron app:
- **Main process** manages the Gateway lifecycle, system tray, IPC, and secure storage
- **Renderer process** is a React UI that communicates with the Gateway over WebSocket (JSON-RPC)
- **OpenClaw Gateway** runs as a child process on port 18789
${browserSection}
### Guidelines
- You are managed by CrawBot — do not attempt to start, stop, or reconfigure the Gateway process
- API keys and provider credentials are stored securely in the system keychain via CrawBot
- The user interacts with you through CrawBot's chat interface
- CrawBot handles auto-updates, workspace management, and skill configuration
${BLOCK_END}`;
}

/**
 * Find all AGENTS.md files across OpenClaw workspace directories
 */
function findAgentsMdFiles(): string[] {
  const configDir = getOpenClawConfigDir();
  if (!existsSync(configDir)) {
    return [];
  }

  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(configDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const entryPath = join(configDir, entry);
    try {
      if (!statSync(entryPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const agentsMd = join(entryPath, 'AGENTS.md');
    if (existsSync(agentsMd)) {
      results.push(agentsMd);
    }
  }

  return results;
}

/**
 * Inject or replace the CrawBot block in a single AGENTS.md file
 * Returns true if the file was modified
 */
function injectIntoFile(filePath: string, block: string): boolean {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.warn(`Failed to read ${filePath}:`, err);
    return false;
  }

  const startIdx = content.indexOf(BLOCK_START);
  const endIdx = content.indexOf(BLOCK_END);

  let newContent: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing block (complete pair found)
    newContent = content.substring(0, startIdx) + block + content.substring(endIdx + BLOCK_END.length);
  } else if (startIdx !== -1) {
    // Opening tag without closing — truncate from the tag onward (old corrupted block)
    const cleaned = content.substring(0, startIdx).trimEnd();
    newContent = cleaned + '\n\n' + block + '\n';
  } else if (endIdx !== -1) {
    // Orphan closing tag only — strip it and append fresh
    const cleaned = (content.substring(0, endIdx) + content.substring(endIdx + BLOCK_END.length)).trimEnd();
    newContent = cleaned + '\n\n' + block + '\n';
  } else {
    // No existing block — append
    const separator = content.endsWith('\n') ? '\n' : '\n\n';
    newContent = content + separator + block + '\n';
  }

  try {
    writeFileSync(filePath, newContent, 'utf-8');
    return true;
  } catch (err) {
    logger.warn(`Failed to write ${filePath}:`, err);
    return false;
  }
}

/**
 * Main entry: inject CrawBot context into all workspace AGENTS.md files.
 * Content-based: skips files where the block is already up-to-date.
 * Reads useBuiltinBrowser setting to decide whether to include Browser Tool section.
 */
export async function injectCrawBotContext(): Promise<void> {
  const useBuiltinBrowser = getUseBuiltinBrowserFromConfig();
  const files = findAgentsMdFiles();
  if (files.length === 0) {
    logger.debug('AGENTS.md injection: no workspace AGENTS.md files found, will retry next startup');
    return;
  }

  const block = buildCrawBotBlock(useBuiltinBrowser);
  let injectedCount = 0;

  for (const filePath of files) {
    try {
      // Skip if the file already contains the exact same block between markers
      const content = readFileSync(filePath, 'utf-8');
      const startIdx = content.indexOf(BLOCK_START);
      const endIdx = content.indexOf(BLOCK_END);
      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        const existingBlock = content.substring(startIdx, endIdx + BLOCK_END.length);
        if (existingBlock === block) continue; // Already up-to-date
      }

      if (injectIntoFile(filePath, block)) {
        injectedCount++;
        logger.info(`Injected CrawBot context into ${filePath}`);
      }
    } catch (err) {
      logger.warn(`Failed to inject into ${filePath}:`, err);
    }
  }

  if (injectedCount > 0) {
    logger.info(`AGENTS.md injection complete: ${injectedCount}/${files.length} files updated (builtinBrowser=${useBuiltinBrowser})`);
  }
}

/**
 * Re-inject CrawBot context into all workspaces with updated browser setting.
 * Called when useBuiltinBrowser toggle changes — bypasses version gating.
 */
export function syncBrowserBlockToAllWorkspaces(useBuiltinBrowser: boolean): void {
  const files = findAgentsMdFiles();
  if (files.length === 0) return;

  const block = buildCrawBotBlock(useBuiltinBrowser);
  let count = 0;

  for (const filePath of files) {
    try {
      if (injectIntoFile(filePath, block)) count++;
    } catch (err) {
      logger.warn(`Failed to sync browser block in ${filePath}:`, err);
    }
  }

  if (count > 0) {
    logger.info(`Browser block synced in ${count}/${files.length} AGENTS.md files (builtinBrowser=${useBuiltinBrowser})`);
  }
}
