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
 * ChatGPT's Thinking model (o-series) has a code sandbox and will execute
 * commands directly rather than outputting tool calls. GPT-4o refuses tool
 * calls for user paths saying "I can't access your computer."
 *
 * GPT-4o-mini cooperates when framed as an "API endpoint" that outputs JSON.
 * This transformer uses that framing while preserving persona context.
 */
export function transformSystemPromptForChatGPT(systemText: string): string {
  // Extract tool list with descriptions
  const toolListMatch = systemText.match(/Tool availability[^]*?(?=##\s|$)/s);
  const toolLines: string[] = [];
  if (toolListMatch) {
    const matches = toolListMatch[0].matchAll(/^- (\w+): (.+)$/gm);
    for (const m of matches) {
      toolLines.push(`${m[1]}: ${m[2]}`);
    }
  }

  // Replace the ## Tooling section with API endpoint framing
  let transformed = systemText.replace(
    /## Tooling[\s\S]*?(?=## (?!Tool))/,
    `## Tool Use — API Mode
You are a tool-calling proxy. You CANNOT execute commands or read files yourself.
You must output JSON tool calls. A separate execution engine runs them on the user's real computer.

Format — one JSON per line, nothing else before or after:
{"action": "function_call", "name": "<tool_name>", "arguments": {<tool_specific_args>}}

Example — reading a file:
{"action": "function_call", "name": "read", "arguments": {"path": "/etc/hostname"}}

Example — running a command:
{"action": "function_call", "name": "exec", "arguments": {"command": "ls -la /tmp"}}

Example — multiple tools (one JSON per line):
{"action": "function_call", "name": "exec", "arguments": {"command": "uname -a"}}
{"action": "function_call", "name": "read", "arguments": {"path": "/etc/os-release"}}

Available tools:
${toolLines.map((l) => `- ${l}`).join('\n')}

RULES:
- Output ONLY the JSON. No explanation, no markdown, no commentary.
- "action" must always be exactly "function_call".
- "name" must be one of the available tool names.
- "arguments" must match the tool's expected parameters.
- After receiving tool results, respond naturally to the user.

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

/**
 * Parse text-based tool calls from model responses.
 * Supports two formats:
 * 1. ```tool_call\n{...}\n``` code blocks
 * 2. {"action":"function_call","name":"...","arguments":{...}} JSON objects
 */
export function parseTextToolCalls(
  text: string,
): Array<{ name: string; params: Record<string, unknown>; raw: string }> {
  const calls: Array<{
    name: string;
    params: Record<string, unknown>;
    raw: string;
  }> = [];

  // Strategy 1: Match ```tool_call\n{...}\n``` blocks
  const codeBlockRegex = /```tool_call\s*\n([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.name) {
        calls.push({
          name: parsed.name,
          params: parsed.params || parsed.arguments || {},
          raw: match[0],
        });
      }
    } catch {
      /* skip malformed */
    }
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
        else if (text[i] === '}') {
          depth--;
          if (depth === 0) break;
        }
        i++;
      }
      const candidate = text.substring(start, i + 1);
      try {
        const parsed = JSON.parse(candidate);
        // Accept multiple tool call formats:
        // 1. {"action": "function_call", "name": "read", "arguments": {...}}  (standard)
        // 2. {"function": "read", "params": {...}}  (simplified)
        // 3. {"action": "read", "arguments": {...}}  (model uses action as tool name)
        // 4. {"name": "read", "arguments": {...}}  (minimal)
        if (parsed.action === 'function_call' && parsed.name) {
          calls.push({
            name: parsed.name,
            params: parsed.arguments || parsed.params || {},
            raw: candidate,
          });
        } else if (parsed.function && typeof parsed.function === 'string') {
          calls.push({
            name: parsed.function,
            params: parsed.params || parsed.arguments || {},
            raw: candidate,
          });
        } else if (parsed.action && parsed.action !== 'function_call' && parsed.arguments && typeof parsed.action === 'string') {
          // Model used "action" as the tool name
          calls.push({
            name: parsed.action,
            params: parsed.arguments || {},
            raw: candidate,
          });
        }
      } catch {
        /* not valid JSON, skip */
      }
    }
    i++;
  }

  return calls;
}
