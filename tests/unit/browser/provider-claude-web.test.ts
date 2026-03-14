/**
 * Claude Web Provider Tests
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeMockWebview } from '../../mocks/electron-browser';

// Mock the base-provider module
vi.mock('@electron/browser/providers/base-provider', () => ({
  executeInWebview: vi.fn(),
  streamFromWebview: vi.fn(),
}));

import { ClaudeWebProvider } from '@electron/browser/providers/claude-web';
import { executeInWebview, streamFromWebview } from '@electron/browser/providers/base-provider';

const mockExecute = vi.mocked(executeInWebview);
const mockStream = vi.mocked(streamFromWebview);

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
    it('discovers org, creates conversation, and streams completion', async () => {
      // Mock org discovery
      mockExecute.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify([{ uuid: 'org-test-123' }]),
      });

      // Mock conversation creation
      mockExecute.mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: JSON.stringify({ uuid: 'conv-test-456' }),
      });

      // Mock streaming
      async function* mockGenerator() {
        yield 'data: {"type":"completion","completion":"Hello","stop_reason":null}\n\n';
        yield 'data: {"type":"completion","completion":" world","stop_reason":"end_turn"}\n\n';
      }

      mockStream.mockReturnValue({
        stream: mockGenerator(),
        abort: vi.fn(),
      });

      const chunks: unknown[] = [];
      for await (const chunk of provider.chatCompletion(webview, {
        model: 'webauth-claude-sonnet-4',
        messages: [{ role: 'user', content: 'Hi' }],
      })) {
        chunks.push(chunk);
      }

      expect(chunks).toHaveLength(2);
      expect((chunks[0] as { choices: Array<{ delta: { content: string } }> }).choices[0].delta.content).toBe('Hello');
      expect((chunks[1] as { choices: Array<{ delta: { content: string } }> }).choices[0].delta.content).toBe(' world');
      expect((chunks[1] as { choices: Array<{ finish_reason: string | null }> }).choices[0].finish_reason).toBe('stop');
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
