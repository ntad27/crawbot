/**
 * WebAuth Provider Types
 */

export interface WebProviderModel {
  id: string;        // e.g., "webauth-claude-sonnet-4"
  name: string;      // e.g., "Claude Sonnet 4 (WebAuth)"
  contextWindow?: number;
}

export interface WebAuthCheckResult {
  authenticated: boolean;
  user?: string;
}

export interface OpenAIChatRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: Array<{ type: string; function: { name: string; description?: string; parameters?: unknown } }>;
  tool_choice?: string | { type: string; function?: { name: string } };
}

export interface OpenAIChatChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: { role?: string; content?: string };
    finish_reason: string | null;
  }>;
}

/**
 * Interface that every WebAuth provider must implement
 */
export interface WebProvider {
  id: string;              // e.g., "claude-web"
  name: string;            // e.g., "Claude Web"
  loginUrl: string;        // e.g., "https://claude.ai"
  partition: string;       // e.g., "persist:webauth-claude"
  models: WebProviderModel[];

  /** Check if session is still valid by inspecting cookies */
  checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult>;

  /** Execute a chat completion, yielding OpenAI-format SSE chunks */
  chatCompletion(
    webview: WebviewLike,
    request: OpenAIChatRequest,
  ): AsyncGenerator<OpenAIChatChunk>;
}

/**
 * Minimal webview interface for testability
 * (matches both real Electron webview and mock)
 */
export interface WebviewLike {
  executeJavaScript(code: string, timeout?: number): Promise<unknown>;
  addEventListener(event: string, listener: (...args: unknown[]) => void): void;
  removeEventListener(event: string, listener: (...args: unknown[]) => void): void;
  /** Optional: send raw CDP command (available on WebContentsViewAdapter) */
  sendCDPCommand?(method: string, params?: Record<string, unknown>): Promise<unknown>;
  /** Optional: subscribe to CDP events */
  onCDPEvent?(callback: (method: string, params: unknown) => void): void;
}
