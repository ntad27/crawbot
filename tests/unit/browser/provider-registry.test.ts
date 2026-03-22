/**
 * Provider Registry Tests
 * Tests for WEBAUTH_PROVIDER_PARTITIONS and getPartitionForProvider
 */
import { describe, it, expect } from 'vitest';
import {
  WEBAUTH_PROVIDER_PARTITIONS,
  getPartitionForProvider,
} from '@electron/browser/providers/registry';

describe('WEBAUTH_PROVIDER_PARTITIONS', () => {
  it('contains 12 provider entries', () => {
    const keys = Object.keys(WEBAUTH_PROVIDER_PARTITIONS);
    expect(keys).toHaveLength(12);
  });

  it('all partitions start with persist:webauth-', () => {
    for (const partition of Object.values(WEBAUTH_PROVIDER_PARTITIONS)) {
      expect(partition).toMatch(/^persist:webauth-/);
    }
  });

  it('all partition values are unique', () => {
    const values = Object.values(WEBAUTH_PROVIDER_PARTITIONS);
    expect(new Set(values).size).toBe(values.length);
  });

  it('maps claude-web correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['claude-web']).toBe('persist:webauth-claude');
  });

  it('maps chatgpt-web correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['chatgpt-web']).toBe('persist:webauth-chatgpt');
  });

  it('maps deepseek-web correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['deepseek-web']).toBe('persist:webauth-deepseek');
  });

  it('maps gemini-web correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['gemini-web']).toBe('persist:webauth-gemini');
  });

  it('maps grok-web correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['grok-web']).toBe('persist:webauth-grok');
  });

  it('maps qwen-intl-web correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['qwen-intl-web']).toBe('persist:webauth-qwen-intl');
  });

  it('maps qwen-china-web correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['qwen-china-web']).toBe('persist:webauth-qwen-china');
  });

  it('maps kimi-web correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['kimi-web']).toBe('persist:webauth-kimi');
  });

  it('maps doubao-web correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['doubao-web']).toBe('persist:webauth-doubao');
  });

  it('maps glm-china-web correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['glm-china-web']).toBe('persist:webauth-glm-china');
  });

  it('maps glm-intl-web correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['glm-intl-web']).toBe('persist:webauth-glm-intl');
  });

  it('maps manus-api correctly', () => {
    expect(WEBAUTH_PROVIDER_PARTITIONS['manus-api']).toBe('persist:webauth-manus');
  });

  it('does not contain unknown provider IDs', () => {
    const expectedIds = [
      'claude-web',
      'chatgpt-web',
      'deepseek-web',
      'gemini-web',
      'grok-web',
      'qwen-intl-web',
      'qwen-china-web',
      'kimi-web',
      'doubao-web',
      'glm-china-web',
      'glm-intl-web',
      'manus-api',
    ];
    const actualIds = Object.keys(WEBAUTH_PROVIDER_PARTITIONS);
    expect(actualIds.sort()).toEqual(expectedIds.sort());
  });
});

describe('getPartitionForProvider', () => {
  it('returns correct partition for known provider', () => {
    expect(getPartitionForProvider('claude-web')).toBe('persist:webauth-claude');
  });

  it('returns correct partition for each known provider', () => {
    for (const [id, partition] of Object.entries(WEBAUTH_PROVIDER_PARTITIONS)) {
      expect(getPartitionForProvider(id)).toBe(partition);
    }
  });

  it('returns undefined for unknown provider ID', () => {
    expect(getPartitionForProvider('nonexistent')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getPartitionForProvider('')).toBeUndefined();
  });

  it('is case-sensitive', () => {
    expect(getPartitionForProvider('Claude-Web')).toBeUndefined();
    expect(getPartitionForProvider('CLAUDE-WEB')).toBeUndefined();
  });

  it('does not match partial provider IDs', () => {
    expect(getPartitionForProvider('claude')).toBeUndefined();
    expect(getPartitionForProvider('web')).toBeUndefined();
    expect(getPartitionForProvider('deepseek')).toBeUndefined();
  });
});
