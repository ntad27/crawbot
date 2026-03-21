/**
 * Shared Utilities for WebAuth Providers
 *
 * Common functions used across all web providers:
 * - extractText: Extract text from OpenAI message content
 * - consolidateMessages: Flatten messages array into a single prompt
 * - transformSystemPromptForWebChat: Rewrite system prompt for text-based tool calling
 * - parseTextToolCalls: Parse text-based tool calls from model responses
 */

/**
 * Extract text from OpenAI message content (string or content parts array).
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => typeof p === 'object' && p !== null && p.type === 'text')
      .map((p) => p.text || '')
      .join('\n');
  }
  return String(content);
}

/**
 * Extract image references from messages.
 * Handles two formats:
 * 1. OpenAI content parts: [{type: "image_url", image_url: {url: "data:..."}}]
 * 2. OpenClaw text-embedded: [media attached: /path/file.jpg (image/jpeg) | /path/file.jpg]
 */
export function extractImages(
  messages: Array<{ role: string; content: unknown }>,
): Array<{ url: string; mediaType: string }> {
  const images: Array<{ url: string; mediaType: string }> = [];
  for (const msg of messages) {
    // Format 1: OpenAI content parts array
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part !== 'object' || part === null) continue;
        if (part.type === 'image_url' && part.image_url?.url) {
          const url = part.image_url.url as string;
          let mediaType = 'image/jpeg';
          const mimeMatch = url.match(/^data:([^;]+);/);
          if (mimeMatch) mediaType = mimeMatch[1];
          images.push({ url, mediaType });
        }
      }
    }

    // Format 2: OpenClaw text-embedded media references
    // Pattern: [media attached: /path/file.jpg (image/jpeg) | /path/file.jpg]
    const text = typeof msg.content === 'string' ? msg.content : extractText(msg.content);
    const mediaRegex = /\[media attached:\s*([^\s(]+)\s*\(([^)]+)\)\s*\|[^\]]*\]/g;
    let m;
    while ((m = mediaRegex.exec(text)) !== null) {
      const filePath = m[1];
      const mimeType = m[2];
      if (mimeType.startsWith('image/')) {
        images.push({ url: filePath, mediaType: mimeType });
      }
    }
  }
  return images;
}

/**
 * Transform system prompt for WebAuth models that don't support native tool calling.
 *
 * Replaces OpenClaw's tool definitions with text-based tool calling instructions.
 * The model outputs tool calls as XML-like tags that the proxy can parse.
 */
export function transformSystemPromptForWebChat(systemText: string): string {
  // Extract tool list with descriptions
  const toolListMatch = systemText.match(/Tool availability[^]*?(?=##\s|$)/s);
  const toolLines: string[] = [];
  if (toolListMatch) {
    const matches = toolListMatch[0].matchAll(/^- (\w+): (.+)$/gm);
    for (const m of matches) {
      toolLines.push(`  ${m[1]}: ${m[2]}`);
    }
  }

  // Replace the ## Tooling section with JSON action format
  let transformed = systemText.replace(
    /## Tooling[\s\S]*?(?=## (?!Tool))/,
    `## Tool Use — MANDATORY
YOU MUST USE TOOLS. You are connected to a REAL system with FULL access.

⚠️ RULE: Tool call FIRST, talk LATER. Never answer without checking first.
⚠️ RULE: Never say "I can't access" — you CAN. Use the tool.

Format — output ONLY this JSON, nothing else:
{"action": "function_call", "name": "TOOL", "arguments": {"key": "value"}}

Multiple tools — one JSON per line:
{"action": "function_call", "name": "read", "arguments": {"path": "/a.txt"}}
{"action": "function_call", "name": "exec", "arguments": {"cmd": "ls"}}

Tools: ${toolLines.map((l) => l.trim()).join(' | ')}

After tool result arrives, THEN respond to user. Plain text ONLY when no lookup needed.

`,
  );

  // Also replace ## Tool Call Style section
  transformed = transformed.replace(/## Tool Call Style[\s\S]*?(?=## )/, '');

  return transformed;
}

/**
 * Transform system prompt specifically for ChatGPT web chat.
 *
 * ChatGPT's Thinking model (GPT-5.4) has a code sandbox and will execute
 * commands directly rather than outputting tool calls. It also refuses
 * "tool calling" framing because it knows it can't access user's files.
 *
 * Breakthrough: explain TWO environments (sandbox ❌ vs host ✅) and give
 * concrete examples with real file paths. The model cooperates when it
 * understands its sandbox is NOT the user's computer and blockquote JSON
 * is the ONLY way to access user's files.
 * Tested on GPT-5.4 Thinking with real /new session startup flow (7/7 tool calls).
 */
export function transformSystemPromptForChatGPT(systemText: string): string {
  // Extract workspace path from Runtime line for concrete examples
  let workspace = '/Users/xnohat/.openclaw/workspace-main';
  const repoMatch = systemText.match(/repo=([^\s|]+)/);
  if (repoMatch) workspace = repoMatch[1];

  // Replace ## Tooling with "two environments" framing
  let transformed = systemText.replace(
    /## Tooling[\s\S]*?(?=## (?!Tool))/,
    `## System Access (IMPORTANT — read carefully)
You have TWO environments:
1. ❌ Code sandbox — an isolated container. It does NOT have the user's files.
2. ✅ Host system — the user's real Mac. Accessed ONLY through blockquote requests.

To access the user's files, output blockquote JSON:
> {"action": "function_call", "name": "read", "arguments": {"path": "/path/to/file"}}

> {"action": "function_call", "name": "exec", "arguments": {"command": "shell command"}}

> {"action": "function_call", "name": "write", "arguments": {"path": "/path", "content": "data"}}

Example — Session Startup (reading workspace files):
> {"action": "function_call", "name": "read", "arguments": {"path": "${workspace}/SOUL.md"}}
> {"action": "function_call", "name": "read", "arguments": {"path": "${workspace}/USER.md"}}
> {"action": "function_call", "name": "read", "arguments": {"path": "${workspace}/MEMORY.md"}}

Output ALL blockquote requests FIRST. Wait for results. Then respond to the user.
❌ NEVER use your code sandbox to read files — those are NOT the user's files.

`,
  );

  // Also replace ## Tool Call Style section
  transformed = transformed.replace(/## Tool Call Style[\s\S]*?(?=## )/, '');

  return transformed;
}

/**
 * Consolidate an OpenAI messages array into a single text prompt.
 * Web chat providers only accept a single text input, so we flatten
 * the entire conversation context into one coherent message.
 */
export function consolidateMessages(
  messages: Array<{ role: string; content: unknown }>,
  systemPromptTransformer?: (text: string) => string,
): string {
  const parts: string[] = [];
  const transformer = systemPromptTransformer || transformSystemPromptForWebChat;

  for (const msg of messages) {
    let text = extractText(msg.content);
    if (!text.trim()) continue;

    // Transform system prompt for web chat compatibility
    if (msg.role === 'system') {
      text = transformer(text);
    }

    switch (msg.role) {
      case 'system':
        parts.push(`<system_instruction>\n${text}\n</system_instruction>`);
        break;
      case 'user':
        parts.push(`<user>\n${text}\n</user>`);
        break;
      case 'assistant':
        parts.push(`<assistant>\n${text}\n</assistant>`);
        break;
      case 'tool':
        parts.push(`<tool_result>\n${text}\n</tool_result>`);
        break;
      default:
        parts.push(`<${msg.role}>\n${text}\n</${msg.role}>`);
    }
  }

  // If only one user message and no system/assistant context,
  // just send the raw text (simpler for the model)
  const hasSystem = messages.some((m) => m.role === 'system');
  const hasAssistant = messages.some((m) => m.role === 'assistant');
  const userMsgs = messages.filter((m) => m.role === 'user');

  if (!hasSystem && !hasAssistant && userMsgs.length === 1) {
    return extractText(userMsgs[0].content);
  }

  return parts.join('\n\n');
}

type ToolCall = { name: string; params: Record<string, unknown>; raw: string };

/**
 * Parse tool calls from blockquote format: > {"action":"function_call",...}
 * Used by ChatGPT copilot-style responses.
 */
export function parseBlockquoteToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const quoteRegex = /^>\s*(\{[^\n]+\})\s*$/gm;
  let m;
  while ((m = quoteRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(m[1].trim());
      if (parsed.action === 'function_call' && parsed.name) {
        calls.push({ name: parsed.name, params: parsed.arguments || parsed.params || {}, raw: m[0] });
      }
    } catch { /* skip */ }
  }
  return calls;
}

/**
 * Parse tool calls from raw JSON (balanced-brace extraction).
 * Used by Gemini, Qwen, and other providers that output bare JSON.
 * Also handles ```tool_call code blocks.
 */
export function parseJsonToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];

  // Strategy 1: Match ```tool_call\n{...}\n``` blocks
  const codeBlockRegex = /```tool_call\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name) {
        calls.push({ name: parsed.name, params: parsed.params || parsed.arguments || {}, raw: match[0] });
      }
    } catch { /* skip */ }
  }
  if (calls.length > 0) return calls;

  // Strategy 2: Balanced-brace JSON extraction
  let i = 0;
  while (i < text.length) {
    if (text[i] === '{') {
      let depth = 0;
      const start = i;
      while (i < text.length) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}') { depth--; if (depth === 0) break; }
        i++;
      }
      const candidate = text.substring(start, i + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed.action === 'function_call' && parsed.name) {
          calls.push({ name: parsed.name, params: parsed.arguments || parsed.params || {}, raw: candidate });
        } else if (parsed.function && typeof parsed.function === 'string') {
          calls.push({ name: parsed.function, params: parsed.params || parsed.arguments || {}, raw: candidate });
        } else if (parsed.action && parsed.action !== 'function_call' && parsed.arguments && typeof parsed.action === 'string') {
          calls.push({ name: parsed.action, params: parsed.arguments || {}, raw: candidate });
        }
      } catch { /* skip */ }
    }
    i++;
  }
  return calls;
}

/**
 * Parse text-based tool calls — dispatches to provider-specific parser.
 * Default: parseJsonToolCalls (Gemini/Qwen/Claude).
 * ChatGPT uses parseBlockquoteToolCalls via its own provider code.
 *
 * @deprecated Providers should call their specific parser directly.
 * Kept for backward compatibility with existing provider code.
 */
export function parseTextToolCalls(text: string): ToolCall[] {
  return parseJsonToolCalls(text);
}
