/**
 * Manus API Provider
 * Uses REST API with API key (not browser-based auth)
 *
 * Reference: /Users/xnohat/openclaw-zero-token/src/providers/manus-api-client.ts
 *
 * Flow:
 * 1. POST /v1/tasks -> creates a task, returns task_id
 * 2. GET /v1/tasks/{id} -> poll until status is "completed"
 * 3. Extract assistant output text from task response
 *
 * Auth: API_KEY header obtained from manus.im account settings.
 * The webview is used to store/retrieve the API key from cookies.
 */

import type {
  WebProvider, WebProviderModel, WebAuthCheckResult,
  OpenAIChatRequest, OpenAIChatChunk, WebviewLike,
} from './types';
import { executeInWebview } from './base-provider';

const MANUS_API_BASE = 'https://api.manus.ai';
const POLL_INTERVAL_MS = 2000;
const MAX_POLL_MS = 120000;

const MODELS: WebProviderModel[] = [
  { id: 'webauth-manus-16', name: 'Manus 1.6 (WebAuth)', contextWindow: 128000 },
  { id: 'webauth-manus-16-lite', name: 'Manus 1.6 Lite (WebAuth)', contextWindow: 128000 },
];

const MODEL_PROFILE_MAP: Record<string, string> = {
  'webauth-manus-16': 'manus-1.6',
  'webauth-manus-16-lite': 'manus-1.6-lite',
};

export class ManusApiProvider implements WebProvider {
  id = 'manus-api';
  name = 'Manus API';
  loginUrl = 'https://manus.im';
  partition = 'persist:webauth-manus';
  models = MODELS;

  private apiKey: string | null = null;

  async checkAuth(webview: WebviewLike): Promise<WebAuthCheckResult> {
    try {
      // Check if we have an API key stored in the webview's localStorage
      const hasKey = await webview.executeJavaScript(
        `!!localStorage.getItem('manus_api_key')`
      );
      if (hasKey) {
        this.apiKey = await webview.executeJavaScript(
          `localStorage.getItem('manus_api_key')`
        ) as string;
        return { authenticated: true };
      }

      // Also check cookies for session (user logged into manus.im)
      const hasCookie = await webview.executeJavaScript(
        `document.cookie.includes('session') || document.cookie.includes('token')`
      );
      return { authenticated: !!hasCookie };
    } catch {
      return { authenticated: false };
    }
  }

  async *chatCompletion(
    webview: WebviewLike,
    request: OpenAIChatRequest,
  ): AsyncGenerator<OpenAIChatChunk> {
    // Ensure we have the API key
    if (!this.apiKey) {
      await this.fetchApiKey(webview);
    }

    if (!this.apiKey) {
      throw new Error(
        'Manus API key not found. Please set your API key at manus.im and store it ' +
        'via: localStorage.setItem("manus_api_key", "your-key") in the Manus webview.'
      );
    }

    const prompt = request.messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n');

    const agentProfile = MODEL_PROFILE_MAP[request.model] || 'manus-1.6';

    // 1. Create task via direct fetch (not webview - Manus is REST API)
    const createRes = await executeInWebview(
      webview,
      `${MANUS_API_BASE}/v1/tasks`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'API_KEY': this.apiKey,
        },
        body: JSON.stringify({
          prompt,
          agentProfile,
          taskMode: 'chat',
        }),
      }
    );

    if (createRes.status !== 200 && createRes.status !== 201) {
      throw new Error(`Manus API: failed to create task: HTTP ${createRes.status} - ${createRes.body.slice(0, 300)}`);
    }

    const createData = JSON.parse(createRes.body);
    const taskId = createData.task_id;

    if (!taskId) {
      throw new Error('Manus API: no task_id in response');
    }

    // 2. Poll for completion
    const completionId = `chatcmpl-${Date.now()}`;
    const startTime = Date.now();

    // Yield a "thinking" indicator
    yield {
      id: completionId,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [{
        index: 0,
        delta: { role: 'assistant' },
        finish_reason: null,
      }],
    };

    while (Date.now() - startTime < MAX_POLL_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      const pollRes = await executeInWebview(
        webview,
        `${MANUS_API_BASE}/v1/tasks/${taskId}`,
        {
          headers: {
            'Accept': 'application/json',
            'API_KEY': this.apiKey!,
          },
        }
      );

      if (pollRes.status !== 200) {
        throw new Error(`Manus API: poll failed: HTTP ${pollRes.status}`);
      }

      const task = JSON.parse(pollRes.body);

      if (task.status === 'completed') {
        // Extract assistant text from output
        const texts: string[] = [];
        for (const msg of task.output || []) {
          if (msg.role === 'assistant' && msg.content) {
            for (const c of msg.content) {
              if (c.text) {
                texts.push(c.text);
              }
            }
          }
        }

        const resultText = texts.join('\n\n').trim() || '(No text output)';

        yield {
          id: completionId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: request.model,
          choices: [{
            index: 0,
            delta: { content: resultText },
            finish_reason: 'stop',
          }],
        };
        return;
      }

      if (task.status === 'failed') {
        throw new Error(`Manus task failed: ${task.error || 'Unknown error'}`);
      }

      // Still pending/running, continue polling
    }

    throw new Error(`Manus task timed out after ${MAX_POLL_MS / 1000} seconds`);
  }

  private async fetchApiKey(webview: WebviewLike): Promise<void> {
    try {
      const key = await webview.executeJavaScript(
        `localStorage.getItem('manus_api_key') || ''`
      ) as string;

      if (key) {
        this.apiKey = key;
      }
    } catch {
      // No key available
    }
  }
}
