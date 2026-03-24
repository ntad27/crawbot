/**
 * Channel Configuration Utilities
 * Manages channel configuration in OpenClaw config files
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'fs';
import https from 'https';
import { join } from 'path';
import { homedir } from 'os';
import { getOpenClawResolvedDir } from './paths';
import * as logger from './logger';

const OPENCLAW_DIR = join(homedir(), '.openclaw');
const CONFIG_FILE = join(OPENCLAW_DIR, 'openclaw.json');

// Channels that are managed as plugins (config goes under plugins.entries, not channels)
const PLUGIN_CHANNELS = ['whatsapp', 'openzalo'];

export interface ChannelConfigData {
    enabled?: boolean;
    [key: string]: unknown;
}

export interface PluginsConfig {
    entries?: Record<string, ChannelConfigData>;
    [key: string]: unknown;
}

export interface AgentBinding {
    agentId: string;
    match: {
        channel: string;
        accountId?: string;
    };
}

export interface OpenClawConfig {
    channels?: Record<string, ChannelConfigData>;
    plugins?: PluginsConfig;
    bindings?: AgentBinding[];
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
 * Read OpenClaw configuration
 */
export function readOpenClawConfig(): OpenClawConfig {
    ensureConfigDir();

    if (!existsSync(CONFIG_FILE)) {
        return {};
    }

    try {
        const content = readFileSync(CONFIG_FILE, 'utf-8');
        return JSON.parse(content) as OpenClawConfig;
    } catch (error) {
        logger.error('Failed to read OpenClaw config', error);
        console.error('Failed to read OpenClaw config:', error);
        return {};
    }
}

/**
 * Write OpenClaw configuration
 */
export function writeOpenClawConfig(config: OpenClawConfig): void {
    ensureConfigDir();

    try {
        writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch (error) {
        logger.error('Failed to write OpenClaw config', error);
        console.error('Failed to write OpenClaw config:', error);
        throw error;
    }
}

/**
 * Ensure session.dmScope is set to "per-channel-peer" so each channel user
 * gets an isolated session automatically.  Only sets the value if it is not
 * already configured (i.e. does not overwrite a user's explicit choice).
 */
function ensureSessionDmScope(config: OpenClawConfig): void {
    if (!config.session || typeof config.session !== 'object') {
        config.session = {};
    }
    const session = config.session as Record<string, unknown>;
    if (!session.dmScope) {
        session.dmScope = 'per-channel-peer';
    }
}

/**
 * Save channel configuration
 * @param channelType - The channel type (e.g., 'telegram', 'discord')
 * @param config - The channel configuration object
 */
export function saveChannelConfig(
    channelType: string,
    config: ChannelConfigData
): void {
    const currentConfig = readOpenClawConfig();

    // Plugin-based channels (e.g. WhatsApp, Zalo Personal) need both:
    // 1. plugins.entries.<type>.enabled — enables the plugin
    // 2. channels.<type>.enabled — tells the gateway to start the channel
    if (PLUGIN_CHANNELS.includes(channelType)) {
        if (!currentConfig.plugins) {
            currentConfig.plugins = {};
        }
        if (!currentConfig.plugins.entries) {
            currentConfig.plugins.entries = {};
        }
        currentConfig.plugins.entries[channelType] = {
            ...currentConfig.plugins.entries[channelType],
            enabled: config.enabled ?? true,
        };

        // Also create channels.<type> so the gateway recognizes the channel
        if (!currentConfig.channels) {
            currentConfig.channels = {};
        }
        if (!currentConfig.channels[channelType]) {
            currentConfig.channels[channelType] = {};
        }
        const channelBlock = currentConfig.channels[channelType] as Record<string, unknown>;
        channelBlock.enabled = config.enabled ?? true;
        if (!channelBlock.dmPolicy) {
            channelBlock.dmPolicy = 'pairing';
        }

        ensureSessionDmScope(currentConfig);
        writeOpenClawConfig(currentConfig);
        logger.info('Plugin channel config saved', {
            channelType,
            configFile: CONFIG_FILE,
            path: `plugins.entries.${channelType} + channels.${channelType}`,
        });
        console.log(`Saved plugin channel config for ${channelType}`);
        return;
    }

    if (!currentConfig.channels) {
        currentConfig.channels = {};
    }

    // Transform config to match OpenClaw expected format
    let transformedConfig: ChannelConfigData = { ...config };

    // Special handling for Discord: convert guildId/channelId to complete structure
    if (channelType === 'discord') {
        const { guildId, channelId, ...restConfig } = config;
        transformedConfig = { ...restConfig };

        // Add standard Discord config
        transformedConfig.groupPolicy = 'allowlist';
        transformedConfig.dm = { enabled: false };
        transformedConfig.retry = {
            attempts: 3,
            minDelayMs: 500,
            maxDelayMs: 30000,
            jitter: 0.1,
        };

        // Build guilds structure
        if (guildId && typeof guildId === 'string' && guildId.trim()) {
            const guildConfig: Record<string, unknown> = {
                users: ['*'],
                requireMention: true,
            };

            // Add channels config
            if (channelId && typeof channelId === 'string' && channelId.trim()) {
                // Specific channel
                guildConfig.channels = {
                    [channelId.trim()]: { allow: true, requireMention: true }
                };
            } else {
                // All channels
                guildConfig.channels = {
                    '*': { allow: true, requireMention: true }
                };
            }

            transformedConfig.guilds = {
                [guildId.trim()]: guildConfig
            };
        }
    }

    // Special handling for channels with allowedUsers → dmPolicy + allowFrom transform
    if (channelType === 'telegram' || channelType === 'openzalo') {
        const { allowedUsers, ...restConfig } = config;
        transformedConfig = { ...restConfig };

        const trimmed = typeof allowedUsers === 'string' ? allowedUsers.trim() : '';

        if (trimmed === '') {
            // Blank → pairing mode
            transformedConfig.dmPolicy = 'pairing';
            transformedConfig.allowFrom = [''];
        } else if (trimmed === '*') {
            // Wildcard → open mode
            transformedConfig.dmPolicy = 'open';
            transformedConfig.allowFrom = ['*'];
        } else {
            // Specific user IDs → allowlist mode
            const users = trimmed.split(',')
                .map(u => u.trim())
                .filter(u => u.length > 0);
            transformedConfig.dmPolicy = 'allowlist';
            transformedConfig.allowFrom = users;
        }
    }

    // Special handling for Feishu: default to open DM policy with wildcard allowlist
    if (channelType === 'feishu') {
        const existingConfig = currentConfig.channels[channelType] || {};
        transformedConfig.dmPolicy = transformedConfig.dmPolicy ?? existingConfig.dmPolicy ?? 'open';
        
        let allowFrom = transformedConfig.allowFrom ?? existingConfig.allowFrom ?? ['*'];
        if (!Array.isArray(allowFrom)) {
            allowFrom = [allowFrom];
        }
        
        // If dmPolicy is open, OpenClaw schema requires '*' in allowFrom
        if (transformedConfig.dmPolicy === 'open' && !allowFrom.includes('*')) {
            allowFrom = [...allowFrom, '*'];
        }
        
        transformedConfig.allowFrom = allowFrom;
    }

    // Merge with existing config
    currentConfig.channels[channelType] = {
        ...currentConfig.channels[channelType],
        ...transformedConfig,
        enabled: transformedConfig.enabled ?? true,
    };

    // Bundled channel plugins (e.g. telegram, discord) are disabled by default
    // in OpenClaw's plugin system. Ensure the plugin entry is enabled so the
    // Gateway actually starts the channel after a config reload.
    if (!currentConfig.plugins) {
        currentConfig.plugins = {};
    }
    if (!currentConfig.plugins.entries) {
        currentConfig.plugins.entries = {};
    }
    if (!currentConfig.plugins.entries[channelType]) {
        currentConfig.plugins.entries[channelType] = {};
    }
    currentConfig.plugins.entries[channelType].enabled = true;

    ensureSessionDmScope(currentConfig);
    writeOpenClawConfig(currentConfig);
    logger.info('Channel config saved', {
        channelType,
        configFile: CONFIG_FILE,
        rawKeys: Object.keys(config),
        transformedKeys: Object.keys(transformedConfig),
        enabled: currentConfig.channels[channelType]?.enabled,
    });
    console.log(`Saved channel config for ${channelType}`);
}

/**
 * Get channel configuration
 * @param channelType - The channel type
 */
export function getChannelConfig(channelType: string): ChannelConfigData | undefined {
    const config = readOpenClawConfig();
    return config.channels?.[channelType];
}

/**
 * Get channel configuration as form-friendly values.
 * Reverses the transformation done in saveChannelConfig so the
 * values can be fed back into the UI form fields.
 *
 * @param channelType - The channel type
 * @returns A flat Record<string, string> matching the form field keys, or undefined
 */
export function getChannelFormValues(channelType: string): Record<string, string> | undefined {
    const saved = getChannelConfig(channelType);
    if (!saved) return undefined;

    const values: Record<string, string> = {};

    if (channelType === 'discord') {
        // token is stored at top level
        if (saved.token && typeof saved.token === 'string') {
            values.token = saved.token;
        }

        // Extract guildId and channelId from the nested guilds structure
        const guilds = saved.guilds as Record<string, Record<string, unknown>> | undefined;
        if (guilds) {
            const guildIds = Object.keys(guilds);
            if (guildIds.length > 0) {
                values.guildId = guildIds[0];

                const guildConfig = guilds[guildIds[0]];
                const channels = guildConfig?.channels as Record<string, unknown> | undefined;
                if (channels) {
                    const channelIds = Object.keys(channels).filter((id) => id !== '*');
                    if (channelIds.length > 0) {
                        values.channelId = channelIds[0];
                    }
                }
            }
        }
    } else if (channelType === 'telegram' || channelType === 'openzalo') {
        // Reconstruct allowedUsers from dmPolicy + allowFrom
        const dmPolicy = saved.dmPolicy as string | undefined;
        const allowFrom = saved.allowFrom as string[] | undefined;

        if (dmPolicy === 'open') {
            values.allowedUsers = '*';
        } else if (dmPolicy === 'pairing' || (Array.isArray(allowFrom) && allowFrom.length === 1 && allowFrom[0] === '')) {
            values.allowedUsers = '';
        } else if (Array.isArray(allowFrom)) {
            values.allowedUsers = allowFrom.filter(u => u.length > 0).join(', ');
        }

        // Also extract other string values
        for (const [key, value] of Object.entries(saved)) {
            if (typeof value === 'string' && key !== 'enabled' && key !== 'dmPolicy') {
                values[key] = value;
            }
        }
    } else {
        // For other channel types, extract all string values directly
        for (const [key, value] of Object.entries(saved)) {
            if (typeof value === 'string' && key !== 'enabled') {
                values[key] = value;
            }
        }
    }

    return Object.keys(values).length > 0 ? values : undefined;
}

/**
 * Delete channel configuration
 * @param channelType - The channel type
 */
export function deleteChannelConfig(channelType: string): void {
    const currentConfig = readOpenClawConfig();

    if (currentConfig.channels?.[channelType]) {
        delete currentConfig.channels[channelType];
        // Also remove the plugin entry that was added when saving
        if (currentConfig.plugins?.entries?.[channelType]) {
            delete currentConfig.plugins.entries[channelType];
        }
        writeOpenClawConfig(currentConfig);
        console.log(`Deleted channel config for ${channelType}`);
    } else if (PLUGIN_CHANNELS.includes(channelType)) {
        // Handle plugin channels (like whatsapp)
        if (currentConfig.plugins?.entries?.[channelType]) {
            delete currentConfig.plugins.entries[channelType];

            // Cleanup empty objects
            if (Object.keys(currentConfig.plugins.entries).length === 0) {
                delete currentConfig.plugins.entries;
            }
            if (currentConfig.plugins && Object.keys(currentConfig.plugins).length === 0) {
                delete currentConfig.plugins;
            }

            writeOpenClawConfig(currentConfig);
            console.log(`Deleted plugin channel config for ${channelType}`);
        }
    }

    // Special handling for WhatsApp credentials
    if (channelType === 'whatsapp') {
        try {

            const whatsappDir = join(homedir(), '.openclaw', 'credentials', 'whatsapp');
            if (existsSync(whatsappDir)) {
                rmSync(whatsappDir, { recursive: true, force: true });
                console.log('Deleted WhatsApp credentials directory');
            }
        } catch (error) {
            console.error('Failed to delete WhatsApp credentials:', error);
        }
    }

    // OpenZalo credentials are managed by openzca CLI, no special cleanup needed
}

/**
 * List all configured channels
 */
export function listConfiguredChannels(): string[] {
    const config = readOpenClawConfig();
    const channels: string[] = [];

    if (config.channels) {
        channels.push(...Object.keys(config.channels).filter(
            (channelType) => config.channels![channelType]?.enabled !== false
        ));
    }

    // Check for WhatsApp credentials directory
    try {
        const whatsappDir = join(homedir(), '.openclaw', 'credentials', 'whatsapp');
        if (existsSync(whatsappDir)) {
            const entries = readdirSync(whatsappDir);
            // Check if there's at least one directory (session)
            const hasSession = entries.some((entry: string) => {
                try {
                    return statSync(join(whatsappDir, entry)).isDirectory();
                } catch { return false; }
            });

            if (hasSession && !channels.includes('whatsapp')) {
                channels.push('whatsapp');
            }
        }
    } catch {
        // Ignore errors checking whatsapp dir
    }

    // OpenZalo credentials are managed by openzca CLI — no local credential dir to check

    // Check for plugin-only channels enabled in plugins.entries
    const pluginEntries = config.plugins?.entries as Record<string, Record<string, unknown>> | undefined;
    if (pluginEntries) {
        for (const channelType of PLUGIN_CHANNELS) {
            if (channels.includes(channelType)) continue;
            const entry = pluginEntries[channelType];
            if (entry?.enabled === true) {
                channels.push(channelType);
            }
        }
    }

    return channels;
}

/**
 * Enable or disable a channel (or a specific account within a channel).
 */
export function setChannelEnabled(channelType: string, enabled: boolean, accountId?: string): void {
    const currentConfig = readOpenClawConfig();

    // Per-account toggle
    if (accountId && accountId !== 'default') {
        if (!currentConfig.channels) currentConfig.channels = {};
        if (!currentConfig.channels[channelType]) currentConfig.channels[channelType] = {};
        const channelBlock = currentConfig.channels[channelType] as Record<string, unknown>;
        if (!channelBlock.accounts || typeof channelBlock.accounts !== 'object') {
            channelBlock.accounts = {};
        }
        const accounts = channelBlock.accounts as Record<string, ChannelConfigData>;
        if (!accounts[accountId]) accounts[accountId] = {};
        accounts[accountId].enabled = enabled;
        writeOpenClawConfig(currentConfig);
        logger.info('Account enabled toggled', { channelType, accountId, enabled });
        return;
    }

    // Top-level channel toggle
    // Plugin-based channels go under plugins.entries
    if (PLUGIN_CHANNELS.includes(channelType)) {
        if (!currentConfig.plugins) {
            currentConfig.plugins = {};
        }
        if (!currentConfig.plugins.entries) {
            currentConfig.plugins.entries = {};
        }
        if (!currentConfig.plugins.entries[channelType]) {
            currentConfig.plugins.entries[channelType] = {};
        }
        currentConfig.plugins.entries[channelType].enabled = enabled;
    }

    if (!currentConfig.channels) {
        currentConfig.channels = {};
    }
    if (!currentConfig.channels[channelType]) {
        currentConfig.channels[channelType] = {};
    }
    currentConfig.channels[channelType].enabled = enabled;

    writeOpenClawConfig(currentConfig);
    logger.info('Channel enabled toggled', { channelType, enabled });
}

/**
 * Get enabled status for all channel accounts.
 * Returns { channelType: { accountId: boolean } }.
 * 'default' key is used for the top-level channel config.
 */
export function getChannelEnabledMap(): Record<string, Record<string, boolean>> {
    const config = readOpenClawConfig();
    const result: Record<string, Record<string, boolean>> = {};

    if (config.channels) {
        for (const [channelType, channelBlock] of Object.entries(config.channels)) {
            if (!channelBlock || typeof channelBlock !== 'object') continue;
            const block = channelBlock as Record<string, unknown>;
            result[channelType] = {};

            // Top-level enabled (check both channels.<type>.enabled and plugins.entries.<type>.enabled)
            let topEnabled = true;
            if (typeof block.enabled === 'boolean') {
                topEnabled = block.enabled;
            }
            if (PLUGIN_CHANNELS.includes(channelType)) {
                const pluginEntry = (config.plugins?.entries as Record<string, Record<string, unknown>> | undefined)?.[channelType];
                if (pluginEntry && typeof pluginEntry.enabled === 'boolean') {
                    topEnabled = pluginEntry.enabled;
                }
            }
            // Per-account enabled
            const accounts = block.accounts as Record<string, Record<string, unknown>> | undefined;
            if (accounts && typeof accounts === 'object') {
                for (const [acctId, acctBlock] of Object.entries(accounts)) {
                    if (!acctBlock || typeof acctBlock !== 'object') continue;
                    result[channelType][acctId] = typeof acctBlock.enabled === 'boolean' ? acctBlock.enabled : true;
                }
            }

            // For plugin channels, also discover accounts from credentials files and bindings
            if (PLUGIN_CHANNELS.includes(channelType)) {
                const credDir = join(homedir(), '.openclaw', 'credentials', channelType);
                try {
                    if (existsSync(credDir)) {
                        for (const file of readdirSync(credDir)) {
                            if (!file.endsWith('.json')) continue;
                            const match = file.match(/^credentials(?:-(.+))?\.json$/);
                            if (match) {
                                const acctId = match[1] ? decodeURIComponent(match[1]) : 'default';
                                if (result[channelType][acctId] === undefined) {
                                    result[channelType][acctId] = topEnabled;
                                }
                            }
                        }
                    }
                } catch { /* ignore */ }

                const bindings = config.bindings as Array<{ match?: { channel?: string; accountId?: string } }> | undefined;
                if (bindings) {
                    for (const b of bindings) {
                        if (b.match?.channel === channelType && b.match?.accountId) {
                            if (result[channelType][b.match.accountId] === undefined) {
                                result[channelType][b.match.accountId] = topEnabled;
                            }
                        }
                    }
                }
            }

            // Only add "default" entry if no named accounts exist
            if (Object.keys(result[channelType]).length === 0) {
                result[channelType]['default'] = topEnabled;
            }
        }
    }

    // Include plugin-only channels (e.g. whatsapp, zalouser) that exist
    // under plugins.entries but not under channels
    const pluginEntries = config.plugins?.entries as Record<string, Record<string, unknown>> | undefined;
    if (pluginEntries) {
        for (const channelType of PLUGIN_CHANNELS) {
            if (result[channelType]) continue; // already handled above
            const entry = pluginEntries[channelType];
            if (entry && typeof entry === 'object') {
                const enabled = typeof entry.enabled === 'boolean' ? entry.enabled : false;
                result[channelType] = {};

                // Discover account IDs from credentials files
                const credDir = join(homedir(), '.openclaw', 'credentials', channelType);
                try {
                    if (existsSync(credDir)) {
                        for (const file of readdirSync(credDir)) {
                            if (!file.endsWith('.json')) continue;
                            // credentials.json → default, credentials-<id>.json → <id>
                            const match = file.match(/^credentials(?:-(.+))?\.json$/);
                            if (match) {
                                const acctId = match[1] ? decodeURIComponent(match[1]) : 'default';
                                result[channelType][acctId] = enabled;
                            }
                        }
                    }
                } catch {
                    // ignore credential dir read errors
                }

                // Also discover accounts from bindings
                const bindings = config.bindings as Array<{ match?: { channel?: string; accountId?: string } }> | undefined;
                if (bindings) {
                    for (const b of bindings) {
                        if (b.match?.channel === channelType && b.match?.accountId) {
                            if (result[channelType][b.match.accountId] === undefined) {
                                result[channelType][b.match.accountId] = enabled;
                            }
                        }
                    }
                }

                // Fallback: if no accounts discovered, add default
                if (Object.keys(result[channelType]).length === 0) {
                    result[channelType]['default'] = enabled;
                }
            }
        }
    }

    return result;
}

/**
 * Save configuration for a specific channel account.
 * If accountId is empty or 'default', delegates to saveChannelConfig (top-level).
 * Otherwise writes to channels.<type>.accounts.<accountId>.
 */
export function saveAccountConfig(
    channelType: string,
    accountId: string,
    config: ChannelConfigData
): void {
    if (!accountId || accountId === 'default') {
        saveChannelConfig(channelType, config);
        return;
    }

    const currentConfig = readOpenClawConfig();

    // Ensure plugin channel has proper channels.<type> + plugins.entries setup
    if (PLUGIN_CHANNELS.includes(channelType)) {
        if (!currentConfig.plugins) currentConfig.plugins = {};
        if (!currentConfig.plugins.entries) currentConfig.plugins.entries = {};
        if (!currentConfig.plugins.entries[channelType]) currentConfig.plugins.entries[channelType] = {};
        currentConfig.plugins.entries[channelType].enabled = true;
    }

    if (!currentConfig.channels) {
        currentConfig.channels = {};
    }
    if (!currentConfig.channels[channelType]) {
        currentConfig.channels[channelType] = {};
    }

    const channelBlock = currentConfig.channels[channelType] as Record<string, unknown>;
    // Ensure channel-level enabled and dmPolicy for plugin channels
    if (PLUGIN_CHANNELS.includes(channelType)) {
        if (typeof channelBlock.enabled !== 'boolean') channelBlock.enabled = true;
        if (!channelBlock.dmPolicy) channelBlock.dmPolicy = 'pairing';
    }
    if (!channelBlock.accounts || typeof channelBlock.accounts !== 'object') {
        channelBlock.accounts = {};
    }
    const accounts = channelBlock.accounts as Record<string, ChannelConfigData>;

    // Apply the same transforms as saveChannelConfig for specific channel types
    let transformedConfig: ChannelConfigData = { ...config };

    if (channelType === 'telegram' || channelType === 'openzalo') {
        const { allowedUsers, ...restConfig } = config;
        transformedConfig = { ...restConfig };

        const trimmed = typeof allowedUsers === 'string' ? allowedUsers.trim() : '';

        if (trimmed === '') {
            // Blank → pairing mode
            transformedConfig.dmPolicy = 'pairing';
            transformedConfig.allowFrom = [''];
        } else if (trimmed === '*') {
            // Wildcard → open mode
            transformedConfig.dmPolicy = 'open';
            transformedConfig.allowFrom = ['*'];
        } else {
            // Specific user IDs → allowlist mode
            const users = trimmed.split(',')
                .map(u => u.trim())
                .filter(u => u.length > 0);
            transformedConfig.dmPolicy = 'allowlist';
            transformedConfig.allowFrom = users;
        }
    }

    if (channelType === 'discord') {
        const { guildId, channelId, ...restConfig } = config;
        transformedConfig = { ...restConfig };
        transformedConfig.groupPolicy = 'allowlist';
        transformedConfig.dm = { enabled: false };
        transformedConfig.retry = { attempts: 3, minDelayMs: 500, maxDelayMs: 30000, jitter: 0.1 };
        if (guildId && typeof guildId === 'string' && guildId.trim()) {
            const guildConfig: Record<string, unknown> = { users: ['*'], requireMention: true };
            if (channelId && typeof channelId === 'string' && channelId.trim()) {
                guildConfig.channels = { [channelId.trim()]: { allow: true, requireMention: true } };
            } else {
                guildConfig.channels = { '*': { allow: true, requireMention: true } };
            }
            transformedConfig.guilds = { [guildId.trim()]: guildConfig };
        }
    }

    accounts[accountId] = {
        ...accounts[accountId],
        ...transformedConfig,
        enabled: transformedConfig.enabled ?? true,
    };

    // Ensure channel plugin is enabled
    if (!currentConfig.plugins) currentConfig.plugins = {};
    if (!currentConfig.plugins.entries) currentConfig.plugins.entries = {};
    if (!currentConfig.plugins.entries[channelType]) currentConfig.plugins.entries[channelType] = {};
    currentConfig.plugins.entries[channelType].enabled = true;

    ensureSessionDmScope(currentConfig);
    writeOpenClawConfig(currentConfig);
    logger.info('Account config saved', { channelType, accountId });
}

/**
 * Delete a specific channel account configuration.
 * If accountId is empty or 'default', delegates to deleteChannelConfig.
 * Otherwise removes channels.<type>.accounts.<accountId> and any matching binding.
 */
export function deleteAccountConfig(channelType: string, accountId: string): void {
    if (!accountId || accountId === 'default') {
        deleteChannelConfig(channelType);
        return;
    }

    const currentConfig = readOpenClawConfig();
    const channelBlock = currentConfig.channels?.[channelType] as Record<string, unknown> | undefined;
    const accounts = channelBlock?.accounts as Record<string, unknown> | undefined;

    if (accounts?.[accountId]) {
        delete accounts[accountId];
        // Clean up empty accounts object
        if (Object.keys(accounts).length === 0 && channelBlock) {
            delete channelBlock.accounts;
        }
    }

    // If no accounts remain, clean up the entire channel + plugin entry
    const remainingAccounts = (channelBlock?.accounts as Record<string, unknown> | undefined);
    const hasNoAccounts = !remainingAccounts || Object.keys(remainingAccounts).length === 0;
    if (hasNoAccounts && channelBlock) {
        delete currentConfig.channels![channelType];
        if (currentConfig.plugins?.entries?.[channelType]) {
            delete currentConfig.plugins.entries[channelType];
        }
    }

    // Also remove any matching binding
    if (currentConfig.bindings) {
        currentConfig.bindings = currentConfig.bindings.filter(
            b => !(b.match.channel === channelType && b.match.accountId === accountId)
        );
        if (currentConfig.bindings.length === 0) {
            delete currentConfig.bindings;
        }
    }

    writeOpenClawConfig(currentConfig);

    // Delete credential files for this account
    if (PLUGIN_CHANNELS.includes(channelType)) {
        const credDir = join(homedir(), '.openclaw', 'credentials', channelType);
        try {
            // Delete account-specific credential file
            const credFile = join(credDir, `credentials-${accountId}.json`);
            if (existsSync(credFile)) {
                rmSync(credFile, { force: true });
            }
            // Also try default credentials file name
            const defaultCredFile = join(credDir, 'credentials.json');
            if (existsSync(defaultCredFile)) {
                // Only delete default cred file if this was the only account
                if (hasNoAccounts) {
                    rmSync(defaultCredFile, { force: true });
                }
            }
            // If credential dir is now empty, remove it
            if (existsSync(credDir) && readdirSync(credDir).length === 0) {
                rmSync(credDir, { recursive: true, force: true });
            }
        } catch (error) {
            console.error(`Failed to delete credentials for ${channelType}/${accountId}:`, error);
        }

        // Delete allowFrom files for this account
        const pairingDir = join(homedir(), '.openclaw', 'credentials');
        try {
            const allowFromFile = join(pairingDir, `${channelType}-${accountId}-allowFrom.json`);
            if (existsSync(allowFromFile)) {
                rmSync(allowFromFile, { force: true });
            }
            // Also clean up legacy channel-level files if no accounts remain
            if (hasNoAccounts) {
                const legacyAllowFrom = join(pairingDir, `${channelType}-allowFrom.json`);
                if (existsSync(legacyAllowFrom)) rmSync(legacyAllowFrom, { force: true });
                const pairingFile = join(pairingDir, `${channelType}-pairing.json`);
                if (existsSync(pairingFile)) rmSync(pairingFile, { force: true });
            }
        } catch (error) {
            console.error(`Failed to delete pairing files for ${channelType}/${accountId}:`, error);
        }
    }

    logger.info('Account config deleted', { channelType, accountId });
}

/**
 * Get form-friendly values for a specific channel account.
 * If accountId is empty or 'default', delegates to getChannelFormValues.
 */
export function getAccountFormValues(
    channelType: string,
    accountId: string
): Record<string, string> | undefined {
    if (!accountId || accountId === 'default') {
        return getChannelFormValues(channelType);
    }

    const config = readOpenClawConfig();
    const channelBlock = config.channels?.[channelType] as Record<string, unknown> | undefined;
    const accounts = channelBlock?.accounts as Record<string, Record<string, unknown>> | undefined;
    const saved = accounts?.[accountId];
    if (!saved) return undefined;

    const values: Record<string, string> = {};

    if (channelType === 'discord') {
        if (saved.token && typeof saved.token === 'string') values.token = saved.token;
        const guilds = saved.guilds as Record<string, Record<string, unknown>> | undefined;
        if (guilds) {
            const guildIds = Object.keys(guilds);
            if (guildIds.length > 0) {
                values.guildId = guildIds[0];
                const channels = guilds[guildIds[0]]?.channels as Record<string, unknown> | undefined;
                if (channels) {
                    const channelIds = Object.keys(channels).filter(id => id !== '*');
                    if (channelIds.length > 0) values.channelId = channelIds[0];
                }
            }
        }
    } else if (channelType === 'telegram' || channelType === 'openzalo') {
        // Reconstruct allowedUsers from dmPolicy + allowFrom
        const dmPolicy = saved.dmPolicy as string | undefined;
        const allowFrom = saved.allowFrom as string[] | undefined;

        if (dmPolicy === 'open') {
            values.allowedUsers = '*';
        } else if (dmPolicy === 'pairing' || (Array.isArray(allowFrom) && allowFrom.length === 1 && allowFrom[0] === '')) {
            values.allowedUsers = '';
        } else if (Array.isArray(allowFrom)) {
            values.allowedUsers = (allowFrom as string[]).filter(u => u.length > 0).join(', ');
        }

        for (const [key, value] of Object.entries(saved)) {
            if (typeof value === 'string' && key !== 'enabled' && key !== 'dmPolicy') values[key] = value;
        }
    } else {
        for (const [key, value] of Object.entries(saved)) {
            if (typeof value === 'string' && key !== 'enabled') values[key] = value;
        }
    }

    return Object.keys(values).length > 0 ? values : undefined;
}

/**
 * List all accounts for a given channel type.
 * Returns the default account (if top-level config has meaningful keys) plus any sub-accounts.
 */
export function listChannelAccounts(
    channelType: string
): Array<{ accountId: string; isDefault: boolean }> {
    const config = readOpenClawConfig();
    const result: Array<{ accountId: string; isDefault: boolean }> = [];

    const channelBlock = config.channels?.[channelType] as Record<string, unknown> | undefined;

    // Check if top-level has meaningful config (e.g. botToken, token)
    if (channelBlock) {
        const meaningfulKeys = Object.keys(channelBlock).filter(
            k => k !== 'enabled' && k !== 'accounts'
        );
        if (meaningfulKeys.length > 0) {
            result.push({ accountId: 'default', isDefault: true });
        }
    }

    // Also check plugin-only channels
    if (PLUGIN_CHANNELS.includes(channelType) && result.length === 0) {
        const pluginEntry = config.plugins?.entries?.[channelType];
        if (pluginEntry?.enabled) {
            result.push({ accountId: 'default', isDefault: true });
        }
    }

    // Add sub-accounts
    const accounts = channelBlock?.accounts as Record<string, unknown> | undefined;
    if (accounts) {
        for (const accountId of Object.keys(accounts)) {
            result.push({ accountId, isDefault: false });
        }
    }

    return result;
}

/**
 * Get all bindings from config.
 */
export function getBindings(): AgentBinding[] {
    const config = readOpenClawConfig();
    return config.bindings || [];
}

/**
 * Set (upsert) a binding for a channel + accountId combination.
 */
export function setBinding(
    agentId: string,
    channel: string,
    accountId?: string,
    _session?: string
): void {
    const config = readOpenClawConfig();
    if (!config.bindings) config.bindings = [];

    // Find existing binding for this channel+accountId
    const idx = config.bindings.findIndex(
        b => b.match.channel === channel && (b.match.accountId || undefined) === (accountId || undefined)
    );

    const binding: AgentBinding = {
        agentId,
        match: { channel },
    };
    if (accountId && accountId !== 'default') binding.match.accountId = accountId;
    // Note: session is not part of the OpenClaw binding schema.
    // Session routing is handled via the session key format (agent:<id>:<session>).

    if (idx >= 0) {
        config.bindings[idx] = binding;
    } else {
        config.bindings.push(binding);
    }

    writeOpenClawConfig(config);
    logger.info('Binding set', { agentId, channel, accountId });
}

/**
 * Remove a binding for a channel + accountId combination.
 */
export function removeBinding(channel: string, accountId?: string): void {
    const config = readOpenClawConfig();
    if (!config.bindings) return;

    config.bindings = config.bindings.filter(
        b => !(b.match.channel === channel && (b.match.accountId || undefined) === (accountId || undefined))
    );

    if (config.bindings.length === 0) {
        delete config.bindings;
    }

    writeOpenClawConfig(config);
    logger.info('Binding removed', { channel, accountId });
}

export interface ValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
}

export interface CredentialValidationResult {
    valid: boolean;
    errors: string[];
    warnings: string[];
    /** Extra info returned from the API (e.g. bot username, guild name) */
    details?: Record<string, string>;
}

/**
 * Validate channel credentials by calling the actual service APIs
 * This validates the raw config values BEFORE saving them.
 *
 * @param channelType - The channel type (e.g., 'discord', 'telegram')
 * @param config - The raw config values from the form
 */
export async function validateChannelCredentials(
    channelType: string,
    config: Record<string, string>
): Promise<CredentialValidationResult> {
    switch (channelType) {
        case 'discord':
            return validateDiscordCredentials(config);
        case 'telegram':
            return validateTelegramCredentials(config);
        default:
            // For channels without specific validation, just check required fields are present
            return { valid: true, errors: [], warnings: ['No online validation available for this channel type.'] };
    }
}

/**
 * Validate Discord bot token and optional guild/channel IDs
 */
async function validateDiscordCredentials(
    config: Record<string, string>
): Promise<CredentialValidationResult> {
    const result: CredentialValidationResult = { valid: true, errors: [], warnings: [], details: {} };
    const token = config.token?.trim();

    if (!token) {
        return { valid: false, errors: ['Bot token is required'], warnings: [] };
    }

    // 1) Validate bot token by calling GET /users/@me
    try {
        const meResponse = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bot ${token}` },
        });

        if (!meResponse.ok) {
            if (meResponse.status === 401) {
                return { valid: false, errors: ['Invalid bot token. Please check and try again.'], warnings: [] };
            }
            const errorData = await meResponse.json().catch(() => ({}));
            const msg = (errorData as { message?: string }).message || `Discord API error: ${meResponse.status}`;
            return { valid: false, errors: [msg], warnings: [] };
        }

        const meData = (await meResponse.json()) as { username?: string; id?: string; bot?: boolean };
        if (!meData.bot) {
            return {
                valid: false,
                errors: ['The provided token belongs to a user account, not a bot. Please use a bot token.'],
                warnings: [],
            };
        }
        result.details!.botUsername = meData.username || 'Unknown';
        result.details!.botId = meData.id || '';
    } catch (error) {
        return {
            valid: false,
            errors: [`Connection error when validating bot token: ${error instanceof Error ? error.message : String(error)}`],
            warnings: [],
        };
    }

    // 2) Validate guild ID (optional)
    const guildId = config.guildId?.trim();
    if (guildId) {
        try {
            const guildResponse = await fetch(`https://discord.com/api/v10/guilds/${guildId}`, {
                headers: { Authorization: `Bot ${token}` },
            });

            if (!guildResponse.ok) {
                if (guildResponse.status === 403 || guildResponse.status === 404) {
                    result.errors.push(
                        `Cannot access guild (server) with ID "${guildId}". Make sure the bot has been invited to this server.`
                    );
                    result.valid = false;
                } else {
                    result.errors.push(`Failed to verify guild ID: Discord API returned ${guildResponse.status}`);
                    result.valid = false;
                }
            } else {
                const guildData = (await guildResponse.json()) as { name?: string };
                result.details!.guildName = guildData.name || 'Unknown';
            }
        } catch (error) {
            result.warnings.push(`Could not verify guild ID: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // 3) Validate channel ID (optional)
    const channelId = config.channelId?.trim();
    if (channelId) {
        try {
            const channelResponse = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
                headers: { Authorization: `Bot ${token}` },
            });

            if (!channelResponse.ok) {
                if (channelResponse.status === 403 || channelResponse.status === 404) {
                    result.errors.push(
                        `Cannot access channel with ID "${channelId}". Make sure the bot has permission to view this channel.`
                    );
                    result.valid = false;
                } else {
                    result.errors.push(`Failed to verify channel ID: Discord API returned ${channelResponse.status}`);
                    result.valid = false;
                }
            } else {
                const channelData = (await channelResponse.json()) as { name?: string; guild_id?: string };
                result.details!.channelName = channelData.name || 'Unknown';

                // Cross-check: if both guild and channel are provided, make sure channel belongs to the guild
                if (guildId && channelData.guild_id && channelData.guild_id !== guildId) {
                    result.errors.push(
                        `Channel "${channelData.name}" does not belong to the specified guild. It belongs to a different server.`
                    );
                    result.valid = false;
                }
            }
        } catch (error) {
            result.warnings.push(`Could not verify channel ID: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    return result;
}

/**
 * Validate Telegram bot token
 */
async function validateTelegramCredentials(
    config: Record<string, string>
): Promise<CredentialValidationResult> {
    const botToken = config.botToken?.trim();

    if (!botToken) {
        return { valid: false, errors: ['Bot token is required'], warnings: [] };
    }

    try {
        // Use node:https with family:4 instead of fetch() because undici's
        // autoSelectFamily can fail on networks where IPv6 is unreachable
        // (e.g. Raspberry Pi) — it abandons IPv4 too early when IPv6 errors.
        const data = await new Promise<{ ok?: boolean; description?: string; result?: { username?: string } }>((resolve, reject) => {
            const req = https.get(
                `https://api.telegram.org/bot${botToken}/getMe`,
                { family: 4, timeout: 15000 },
                (res) => {
                    let body = '';
                    res.on('data', (chunk: Buffer) => (body += chunk));
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(body));
                        } catch {
                            reject(new Error(`Invalid JSON response: ${body.slice(0, 100)}`));
                        }
                    });
                },
            );
            req.on('error', reject);
            req.on('timeout', () => req.destroy(new Error('Request timeout')));
        });

        if (data.ok) {
            return {
                valid: true,
                errors: [],
                warnings: [],
                details: { botUsername: data.result?.username || 'Unknown' },
            };
        }

        return {
            valid: false,
            errors: [data.description || 'Invalid bot token'],
            warnings: [],
        };
    } catch (error) {
        return {
            valid: false,
            errors: [`Connection error: ${error instanceof Error ? error.message : String(error)}`],
            warnings: [],
        };
    }
}



/**
 * Validate channel configuration using OpenClaw doctor
 */
export async function validateChannelConfig(channelType: string): Promise<ValidationResult> {
    const { execSync } = await import('child_process');

    const result: ValidationResult = {
        valid: true,
        errors: [],
        warnings: [],
    };

    try {
        // Get OpenClaw path
        const openclawPath = getOpenClawResolvedDir();

        // Run openclaw doctor command to validate config
        const output = execSync(
            `node openclaw.mjs doctor --json 2>&1`,
            {
                cwd: openclawPath,
                encoding: 'utf-8',
                timeout: 30000,
            }
        );

        // Parse output for errors related to the channel
        const lines = output.split('\n');
        for (const line of lines) {
            const lowerLine = line.toLowerCase();
            if (lowerLine.includes(channelType) && lowerLine.includes('error')) {
                result.errors.push(line.trim());
                result.valid = false;
            } else if (lowerLine.includes(channelType) && lowerLine.includes('warning')) {
                result.warnings.push(line.trim());
            } else if (lowerLine.includes('unrecognized key') && lowerLine.includes(channelType)) {
                result.errors.push(line.trim());
                result.valid = false;
            }
        }

        // If no specific errors found, check if config exists and is valid
        const config = readOpenClawConfig();
        if (!config.channels?.[channelType]) {
            result.errors.push(`Channel ${channelType} is not configured`);
            result.valid = false;
        } else if (!config.channels[channelType].enabled) {
            result.warnings.push(`Channel ${channelType} is disabled`);
        }

        // Channel-specific validation
        if (channelType === 'discord') {
            const discordConfig = config.channels?.discord;
            if (!discordConfig?.token) {
                result.errors.push('Discord: Bot token is required');
                result.valid = false;
            }
        } else if (channelType === 'telegram') {
            const telegramConfig = config.channels?.telegram;
            if (!telegramConfig?.botToken) {
                result.errors.push('Telegram: Bot token is required');
                result.valid = false;
            }
            // Check allowed users (stored as allowFrom array)
            const allowedUsers = telegramConfig?.allowFrom as string[] | undefined;
            if (!allowedUsers || allowedUsers.length === 0) {
                result.errors.push('Telegram: Allowed User IDs are required');
                result.valid = false;
            }
        }

        if (result.errors.length === 0 && result.warnings.length === 0) {
            result.valid = true;
        }

    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);

        // Check for config errors in the error message
        if (errorMessage.includes('Unrecognized key') || errorMessage.includes('invalid config')) {
            result.errors.push(errorMessage);
            result.valid = false;
        } else if (errorMessage.includes('ENOENT')) {
            result.errors.push('OpenClaw not found. Please ensure OpenClaw is installed.');
            result.valid = false;
        } else {
            // Doctor command might fail but config could still be valid
            // Just log it and do basic validation
            console.warn('Doctor command failed:', errorMessage);

            const config = readOpenClawConfig();
            if (config.channels?.[channelType]) {
                result.valid = true;
            } else {
                result.errors.push(`Channel ${channelType} is not configured`);
                result.valid = false;
            }
        }
    }

    return result;
}