/**
 * Claude Web Provider Tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeMockWebview } from '../../mocks/electron-browser';

import { ClaudeWebProvider } from '@electron/browser/providers/claude-web';

describe('ClaudeWebProvider', () => {
  let provider: ClaudeWebProvider;
  let webview: ReturnType<typeof makeMockWebview>;

  beforeEach(() => {
    provider = new ClaudeWebProvider();
    webview = makeMockWebview();
  });

  describe('checkAuth', () => {
    it('returns authenticated=true when sessionKey cookie exists', async () => {
      webview.executeJavaScript.mockResolvedValue(true);
      const result = await provider.checkAuth(webview);
      expect(result.authenticated).toBe(true);
    });

    it('returns authenticated=false when no sessionKey cookie', async () => {
      webview.executeJavaScript.mockResolvedValue(false);
      const result = await provider.checkAuth(webview);
      expect(result.authenticated).toBe(false);
    });
  });

  describe('models', () => {
    it('exposes correct model IDs with webauth- prefix', () => {
      expect(provider.models.map((m) => m.id)).toContain('webauth-claude-sonnet-4');
      expect(provider.models.map((m) => m.id)).toContain('webauth-claude-opus-4');
      expect(provider.models.map((m) => m.id)).toContain('webauth-claude-haiku-4');
    });
  });

  describe('chatCompletion', () => {
    it('discovers org, creates conversation, and returns completion', async () => {
      // Provider now uses direct executeJavaScript (no IPC bridge)
      // Mock sequence: org discovery → conversation creation → completion
      webview.executeJavaScript
        // 1. Org discovery
        .mockResolvedValueOnce(JSON.stringify({
          status: 200,
          body: JSON.stringify([{ uuid: 'org-test-123' }]),
        }))
        // 2. Conversation creation
        .mockResolvedValueOnce(JSON.stringify({
          status: 200,
          body: JSON.stringify({ uuid: 'conv-test-456' }),
        }))
        // 3. Chat completion (buffered SSE response parsed in-page)
        .mockResolvedValueOnce(JSON.stringify({
          status: 200,
          answer: 'Hello world',
        }));

      const chunks: unknown[] = [];
      for await (const chunk of provider.chatCompletion(webview, {
        model: 'webauth-claude-sonnet-4',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThanOrEqual(1);
      // Last chunk should have the answer
      const lastChunk = chunks[chunks.length - 1] as { choices: Array<{ delta: { content?: string } }> };
      expect(lastChunk.choices[0].delta.content).toContain('Hello world');
    });
  });

  describe('properties', () => {
    it('has correct id, name, loginUrl, partition', () => {
      expect(provider.id).toBe('claude-web');
      expect(provider.name).toBe('Claude Web');
      expect(provider.loginUrl).toBe('https://claude.ai');
      expect(provider.partition).toBe('persist:webauth-claude');
    });
  });
});
