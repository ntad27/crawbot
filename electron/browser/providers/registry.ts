/**
 * WebAuth Provider Registry — single source of truth for provider ID → partition mapping
 *
 * Used by both IPC handlers and provider instances to avoid hardcoded partition maps.
 */

export const WEBAUTH_PROVIDER_PARTITIONS: Record<string, string> = {
  'claude-web': 'persist:webauth-claude',
  'chatgpt-web': 'persist:webauth-chatgpt',
  'deepseek-web': 'persist:webauth-deepseek',
  'gemini-web': 'persist:webauth-gemini',
  'grok-web': 'persist:webauth-grok',
  'qwen-intl-web': 'persist:webauth-qwen-intl',
  'qwen-china-web': 'persist:webauth-qwen-china',
  'kimi-web': 'persist:webauth-kimi',
  'doubao-web': 'persist:webauth-doubao',
  'glm-china-web': 'persist:webauth-glm-china',
  'glm-intl-web': 'persist:webauth-glm-intl',
  'manus-api': 'persist:webauth-manus',
};

/** Get partition for a provider ID, or undefined if unknown */
export function getPartitionForProvider(providerId: string): string | undefined {
  return WEBAUTH_PROVIDER_PARTITIONS[providerId];
}
