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
 * Transform system prompt for Gemini web chat.
 *
 * Gemini cooperates with the "MANDATORY" approach when given full persona context.
 * Unlike ChatGPT, Gemini doesn't have a code sandbox so no "two environments" trick needed.
 * Uses bare JSON format (not blockquote) — Gemini outputs JSON directly.
 * Full tool schema with examples for every tool, same as ChatGPT.
 */
export function transformSystemPromptForGemini(systemText: string): string {
  // Extract workspace path for concrete examples
  let workspace = '/Users/xnohat/.openclaw/workspace-main';
  const repoMatch = systemText.match(/repo=([^\s|]+)/);
  if (repoMatch) workspace = repoMatch[1];

  // Replace ## Tooling with MANDATORY format + full tool schema
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
{"action": "function_call", "name": "exec", "arguments": {"command": "ls"}}

After tool result arrives, THEN respond to user. Plain text ONLY when no lookup needed.

### File tools
read — Read file contents (also images). Params: path (required), offset (start line), limit (max lines)
{"action": "function_call", "name": "read", "arguments": {"path": "${workspace}/SOUL.md"}}

write — Create or overwrite file. Params: path (required), content (required)
{"action": "function_call", "name": "write", "arguments": {"path": "${workspace}/notes.md", "content": "hello"}}

edit — Replace exact text in file. Params: path (required), oldText (must match exactly), newText (required)
{"action": "function_call", "name": "edit", "arguments": {"path": "${workspace}/AGENTS.md", "oldText": "old", "newText": "new"}}

exec — Run bash command. Params: command (required), timeout (seconds, optional)
{"action": "function_call", "name": "exec", "arguments": {"command": "uname -a"}}

grep — Search file contents. Params: pattern (required), path (optional), glob (file filter, optional), ignoreCase (bool)
{"action": "function_call", "name": "grep", "arguments": {"pattern": "TODO", "path": "${workspace}"}}

find — Find files by glob. Params: pattern (glob, required), path (optional)
{"action": "function_call", "name": "find", "arguments": {"pattern": "*.md", "path": "${workspace}"}}

ls — List directory. Params: path (optional)
{"action": "function_call", "name": "ls", "arguments": {"path": "${workspace}"}}

### Web tools
web_search — Search the web. Params: query (required), count (1-10), freshness ("day"/"week"/"month")
{"action": "function_call", "name": "web_search", "arguments": {"query": "latest AI news"}}

web_fetch — Fetch URL content. Params: url (required), extractMode ("markdown"/"text"), maxChars
{"action": "function_call", "name": "web_fetch", "arguments": {"url": "https://example.com"}}

### Browser
browser — Control OpenClaw's browser. Actions: status, tabs, open, snapshot, screenshot, act, navigate, console, upload, dialog
Act kinds: click, type, press, hover, drag, select, fill, resize, wait, evaluate, close
{"action": "function_call", "name": "browser", "arguments": {"action": "snapshot"}}
{"action": "function_call", "name": "browser", "arguments": {"action": "open", "url": "https://example.com"}}
{"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "click", "ref": "E42"}}
{"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "type", "ref": "E15", "text": "hello"}}
{"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "press", "key": "PageDown"}}
{"action": "function_call", "name": "browser", "arguments": {"action": "screenshot"}}
{"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "evaluate", "fn": "document.title"}}

### Other tools
image — Analyze images. Params: image (path/URL), prompt (optional)
{"action": "function_call", "name": "image", "arguments": {"image": "/path/to/img.png"}}

cron — Manage cron jobs. Actions: status, list, add, remove, wake
{"action": "function_call", "name": "cron", "arguments": {"action": "list"}}
{"action": "function_call", "name": "cron", "arguments": {"action": "wake", "text": "Reminder", "mode": "now"}}

message — Send messages. Params: action ("send"), to, message, channel
{"action": "function_call", "name": "message", "arguments": {"action": "send", "to": "user", "message": "Hello!"}}

process — Manage background sessions. Actions: list, poll, log, write, send-keys, kill
{"action": "function_call", "name": "process", "arguments": {"action": "list"}}

memory_search — Search memory files. Params: query (required)
{"action": "function_call", "name": "memory_search", "arguments": {"query": "what did we decide?"}}

memory_get — Read memory file lines. Params: path (required), from (line), lines (count)
{"action": "function_call", "name": "memory_get", "arguments": {"path": "MEMORY.md"}}

pdf — Analyze PDF. Params: pdf (path), prompt, pages (e.g. "1-5")
{"action": "function_call", "name": "pdf", "arguments": {"pdf": "/path/to/doc.pdf"}}

session_status — Show model/usage info
{"action": "function_call", "name": "session_status", "arguments": {}}

sessions_spawn — Spawn sub-agent. Params: task (required), runtime ("subagent"/"acp"), mode ("run"/"session")
{"action": "function_call", "name": "sessions_spawn", "arguments": {"task": "Fix the bug", "runtime": "subagent", "mode": "run"}}

tts — Text to speech. Params: text (required)
{"action": "function_call", "name": "tts", "arguments": {"text": "Xin chào!"}}

gateway — Manage OpenClaw. Actions: restart, config.get, config.patch, update.run
{"action": "function_call", "name": "gateway", "arguments": {"action": "restart"}}

canvas — Canvas display. Actions: present, snapshot, eval, hide
{"action": "function_call", "name": "canvas", "arguments": {"action": "snapshot"}}

nodes — IoT/phone nodes. Actions: status, notify, camera_snap, location_get
{"action": "function_call", "name": "nodes", "arguments": {"action": "status"}}

subagents — Manage sub-agents. Actions: list, steer, kill
{"action": "function_call", "name": "subagents", "arguments": {"action": "list"}}

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

  // Extract ALL tool names + descriptions from original ## Tooling section
  const toolListMatch = systemText.match(/Tool availability[^]*?(?=##\s|$)/s);
  const allTools: Array<{ name: string; desc: string }> = [];
  if (toolListMatch) {
    const matches = toolListMatch[0].matchAll(/^- (\w+): (.+)$/gm);
    for (const m of matches) {
      allTools.push({ name: m[1], desc: m[2] });
    }
  }

  // All tools now have full examples in the prompt — no extra list needed

  // Replace ## Tooling — KEEP proven "two environments" structure EXACTLY,
  // only add edit/grep/ls to file tools, then append new tools in separate section
  let transformed = systemText.replace(
    /## Tooling[\s\S]*?(?=## (?!Tool))/,
    `## System Access (IMPORTANT — read carefully)
You have TWO environments:
1. ❌ Code sandbox — an isolated container. It does NOT have the user's files.
2. ✅ Host system — the user's real Mac. Accessed ONLY through blockquote requests.

To access the user's files, output blockquote JSON:

read — Read file contents (also images: jpg/png/gif/webp). Params: path (required), offset (start line, optional), limit (max lines, optional)
> {"action": "function_call", "name": "read", "arguments": {"path": "/path/to/file"}}
> {"action": "function_call", "name": "read", "arguments": {"path": "/path/to/file", "offset": 100, "limit": 50}}

write — Create or overwrite file (creates parent dirs). Params: path (required), content (required)
> {"action": "function_call", "name": "write", "arguments": {"path": "/path/to/file", "content": "file content"}}

edit — Replace exact text in file (surgical edit, must match exactly including whitespace). Params: path (required), oldText (required), newText (required)
> {"action": "function_call", "name": "edit", "arguments": {"path": "/path/to/file", "oldText": "exact text to find", "newText": "replacement text"}}

exec — Run bash command. Params: command (required), timeout (seconds, optional)
> {"action": "function_call", "name": "exec", "arguments": {"command": "shell command"}}
> {"action": "function_call", "name": "exec", "arguments": {"command": "long-running-cmd", "timeout": 30}}

grep — Search file contents for pattern (regex or literal). Params: pattern (required), path (dir/file, optional), glob (file filter e.g. "*.ts", optional), ignoreCase (bool, optional), literal (bool, optional), context (lines around match, optional), limit (max matches, optional)
> {"action": "function_call", "name": "grep", "arguments": {"pattern": "TODO", "path": "${workspace}"}}
> {"action": "function_call", "name": "grep", "arguments": {"pattern": "function.*export", "path": "${workspace}", "glob": "*.ts", "ignoreCase": true}}

find — Find files by glob pattern (respects .gitignore). Params: pattern (glob, required), path (dir, optional), limit (max results, optional)
> {"action": "function_call", "name": "find", "arguments": {"pattern": "*.md", "path": "${workspace}"}}
> {"action": "function_call", "name": "find", "arguments": {"pattern": "**/*.test.ts", "path": "${workspace}", "limit": 20}}

ls — List directory contents. Params: path (optional, default: cwd), limit (max entries, optional)
> {"action": "function_call", "name": "ls", "arguments": {"path": "${workspace}"}}
> {"action": "function_call", "name": "ls", "arguments": {"path": "/Users/xnohat", "limit": 50}}

Example — Session Startup (reading workspace files):
> {"action": "function_call", "name": "read", "arguments": {"path": "${workspace}/SOUL.md"}}
> {"action": "function_call", "name": "read", "arguments": {"path": "${workspace}/USER.md"}}
> {"action": "function_call", "name": "read", "arguments": {"path": "${workspace}/MEMORY.md"}}

Output ALL blockquote requests FIRST. Wait for results. Then respond to the user.
❌ NEVER use your code sandbox to read files — those are NOT the user's files.

## Additional Tools
The following tools are also available. Use the same blockquote JSON format.

### web_search — Search the web (Brave API)
Params: query (required), count (1-10, optional), freshness ("day"/"week"/"month"/"year", optional), language (ISO 639-1 e.g. "en"/"vi", optional), date_after (YYYY-MM-DD, optional), date_before (YYYY-MM-DD, optional)
> {"action": "function_call", "name": "web_search", "arguments": {"query": "F1 Shanghai GP 2026"}}
> {"action": "function_call", "name": "web_search", "arguments": {"query": "latest AI news", "count": 5, "freshness": "week"}}
> {"action": "function_call", "name": "web_search", "arguments": {"query": "tin tức AI", "language": "vi", "date_after": "2026-03-01"}}

### web_fetch — Fetch and extract readable content from a URL
Params: url (required), extractMode ("markdown"/"text", default: "markdown", optional), maxChars (truncation limit, optional)
> {"action": "function_call", "name": "web_fetch", "arguments": {"url": "https://example.com/article"}}
> {"action": "function_call", "name": "web_fetch", "arguments": {"url": "https://example.com", "extractMode": "text", "maxChars": 5000}}

### browser — Control OpenClaw's built-in web browser
Actions: status, start, stop, profiles, tabs, open, focus, close, snapshot, screenshot, navigate, console, pdf, upload, dialog, act
Act kinds: click, type, press, hover, drag, select, fill, resize, wait, evaluate, close

Global params (apply to most actions):
- action (required): the action to perform
- target: "sandbox"|"host"|"node" — which browser to control
- profile: "chrome" (Chrome extension relay) or "openclaw" (isolated browser)
- targetId: tab ID from previous snapshot/tabs response — keep same tab across calls
- timeoutMs: timeout in milliseconds

Workflow: snapshot → read element refs (e.g. E42) → act using refs → snapshot again to verify

**Navigation & tabs:**
> {"action": "function_call", "name": "browser", "arguments": {"action": "status"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "tabs"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "open", "url": "https://facebook.com"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "open", "url": "https://facebook.com", "profile": "chrome"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "navigate", "url": "back"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "focus", "targetId": "tab-456"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "close", "targetId": "tab-456"}}

**Reading page content:**
> {"action": "function_call", "name": "browser", "arguments": {"action": "snapshot"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "snapshot", "selector": "#comments"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "snapshot", "refs": "aria", "compact": true}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "snapshot", "targetId": "tab-123"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "screenshot"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "screenshot", "fullPage": true}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "console", "level": "error"}}

**Click & interact:**
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "click", "ref": "E42"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "click", "ref": "E42", "doubleClick": true}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "click", "ref": "E42", "button": "right"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "hover", "ref": "E10"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "drag", "startRef": "E10", "endRef": "E20"}}

**Type & input:**
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "type", "ref": "E15", "text": "hello world"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "type", "ref": "E15", "text": "search query", "submit": true}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "type", "ref": "E15", "text": "password", "slowly": true}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "press", "key": "Enter"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "press", "key": "PageDown"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "press", "key": "Tab"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "press", "key": "Escape"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "select", "ref": "E30", "values": ["option1"]}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "fill", "fields": [{"ref": "E10", "value": "John"}, {"ref": "E11", "value": "john@example.com"}]}}

**Wait & timing:**
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "wait", "timeMs": 2000}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "wait", "selector": ".loaded"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "wait", "url": "*/success*"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "wait", "textGone": "Loading..."}}

**Evaluate JS on page:**
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "evaluate", "fn": "document.title"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "evaluate", "fn": "document.querySelectorAll('.comment').length"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "evaluate", "fn": "window.scrollBy(0, 500)"}}

**File & dialog:**
> {"action": "function_call", "name": "browser", "arguments": {"action": "upload", "ref": "E50", "paths": ["/path/to/file.pdf"]}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "dialog", "accept": true}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "dialog", "accept": true, "promptText": "answer"}}
> {"action": "function_call", "name": "browser", "arguments": {"action": "pdf"}}

**Resize:**
> {"action": "function_call", "name": "browser", "arguments": {"action": "act", "kind": "resize", "width": 1280, "height": 720}}

### image — Analyze images with vision model
Params: image (single path or URL, optional), images (array of paths/URLs for multiple, up to 20, optional), prompt (what to analyze, optional), model (override model, optional)
> {"action": "function_call", "name": "image", "arguments": {"image": "/path/to/screenshot.png"}}
> {"action": "function_call", "name": "image", "arguments": {"image": "/path/to/photo.jpg", "prompt": "What text is visible in this image?"}}
> {"action": "function_call", "name": "image", "arguments": {"images": ["/img1.png", "/img2.png"], "prompt": "Compare these two images"}}

### cron — Manage cron jobs, scheduled reminders, and wake events
Actions: status, list, add, update, remove, run, runs, wake
Params: action (required), jobId/id (for update/remove), job (object for add), text (for wake reminder), mode ("now"/"next-heartbeat" for wake), runMode ("due"/"force" for run), contextMessages (number, for wake context), includeDisabled (bool for list)
> {"action": "function_call", "name": "cron", "arguments": {"action": "status"}}
> {"action": "function_call", "name": "cron", "arguments": {"action": "list"}}
> {"action": "function_call", "name": "cron", "arguments": {"action": "list", "includeDisabled": true}}
> {"action": "function_call", "name": "cron", "arguments": {"action": "add", "job": {"schedule": "0 9 * * *", "command": "echo hello", "description": "Morning greeting"}}}
> {"action": "function_call", "name": "cron", "arguments": {"action": "update", "id": "job-123", "patch": {"schedule": "30 8 * * *"}}}
> {"action": "function_call", "name": "cron", "arguments": {"action": "remove", "id": "job-123"}}
> {"action": "function_call", "name": "cron", "arguments": {"action": "run", "runMode": "due"}}
> {"action": "function_call", "name": "cron", "arguments": {"action": "runs"}}
> {"action": "function_call", "name": "cron", "arguments": {"action": "wake", "text": "Reminder: meeting in 20 minutes", "mode": "now"}}
> {"action": "function_call", "name": "cron", "arguments": {"action": "wake", "text": "Check email", "mode": "next-heartbeat", "contextMessages": 3}}

### message — Send messages and channel actions (send, delete, react, poll, pin, threads)
Params: action (required, e.g. "send"), to (recipient), message (text), channel (telegram/whatsapp/discord/slack/signal/imessage/line/etc, optional)
> {"action": "function_call", "name": "message", "arguments": {"action": "send", "to": "user", "message": "Hello!"}}
> {"action": "function_call", "name": "message", "arguments": {"action": "send", "to": "user", "message": "Update", "channel": "telegram"}}

### process — Manage background exec sessions (PTY/interactive CLIs)
Actions: list, poll, log, write, send-keys, submit, paste, kill, clear, remove
Params: action (required), sessionId (for all except list), data (for write), keys (array for send-keys), literal (string for send-keys), text (for paste), timeout (ms for poll), offset/limit (for log)
> {"action": "function_call", "name": "process", "arguments": {"action": "list"}}
> {"action": "function_call", "name": "process", "arguments": {"action": "poll", "sessionId": "bg-123", "timeout": 5000}}
> {"action": "function_call", "name": "process", "arguments": {"action": "log", "sessionId": "bg-123", "offset": 0, "limit": 100}}
> {"action": "function_call", "name": "process", "arguments": {"action": "write", "sessionId": "bg-123", "data": "ls\\n"}}
> {"action": "function_call", "name": "process", "arguments": {"action": "send-keys", "sessionId": "bg-123", "keys": ["Enter"]}}
> {"action": "function_call", "name": "process", "arguments": {"action": "send-keys", "sessionId": "bg-123", "literal": "yes\\n"}}
> {"action": "function_call", "name": "process", "arguments": {"action": "paste", "sessionId": "bg-123", "text": "long text..."}}
> {"action": "function_call", "name": "process", "arguments": {"action": "kill", "sessionId": "bg-123"}}

### canvas — Present/eval/snapshot the Canvas (web app display)
Actions: present, hide, navigate, eval, snapshot, a2ui_push, a2ui_reset
Params: action (required), url (for present/navigate), javaScript (for eval), outputFormat ("png"/"jpg" for snapshot), node (optional), x/y/width/height (for present)
> {"action": "function_call", "name": "canvas", "arguments": {"action": "present", "url": "https://example.com"}}
> {"action": "function_call", "name": "canvas", "arguments": {"action": "snapshot"}}
> {"action": "function_call", "name": "canvas", "arguments": {"action": "snapshot", "outputFormat": "png"}}
> {"action": "function_call", "name": "canvas", "arguments": {"action": "eval", "javaScript": "document.title"}}
> {"action": "function_call", "name": "canvas", "arguments": {"action": "hide"}}

### nodes — List/describe/notify/camera/screen on paired nodes (phones, IoT devices)
Actions: status, describe, pending, approve, reject, notify, camera_snap, camera_list, camera_clip, photos_latest, screen_record, location_get, notifications_list, notifications_action
Params: action (required), node (node id/name, optional), title/body (for notify), sound/priority/delivery (for notify), facing ("front"/"back"/"both" for camera)
> {"action": "function_call", "name": "nodes", "arguments": {"action": "status"}}
> {"action": "function_call", "name": "nodes", "arguments": {"action": "describe", "node": "my-phone"}}
> {"action": "function_call", "name": "nodes", "arguments": {"action": "notify", "node": "my-phone", "title": "Reminder", "body": "Check email"}}
> {"action": "function_call", "name": "nodes", "arguments": {"action": "camera_snap", "node": "my-phone", "facing": "back"}}
> {"action": "function_call", "name": "nodes", "arguments": {"action": "camera_clip", "node": "my-phone", "facing": "front"}}
> {"action": "function_call", "name": "nodes", "arguments": {"action": "photos_latest", "node": "my-phone"}}
> {"action": "function_call", "name": "nodes", "arguments": {"action": "screen_record", "node": "my-phone"}}
> {"action": "function_call", "name": "nodes", "arguments": {"action": "location_get", "node": "my-phone"}}
> {"action": "function_call", "name": "nodes", "arguments": {"action": "notifications_list", "node": "my-phone"}}

### gateway — Restart, apply config, or run updates on OpenClaw
Actions: restart, config.get, config.schema.lookup, config.apply, config.patch, update.run
Params: action (required), path (config path for get/lookup), raw (JSON config for apply), reason (for restart), delayMs (for restart)
> {"action": "function_call", "name": "gateway", "arguments": {"action": "restart", "reason": "config updated"}}
> {"action": "function_call", "name": "gateway", "arguments": {"action": "config.get"}}
> {"action": "function_call", "name": "gateway", "arguments": {"action": "config.schema.lookup", "path": "models.providers"}}
> {"action": "function_call", "name": "gateway", "arguments": {"action": "config.patch", "raw": "{\\"agents\\":{\\"defaults\\":{\\"model\\":\\"gpt-4o\\"}}}"}}
> {"action": "function_call", "name": "gateway", "arguments": {"action": "update.run"}}

### pdf — Analyze PDF documents with vision model
Params: pdf (single path/URL), pdfs (array, up to 10), prompt (what to analyze, optional), pages (range e.g. "1-5", optional), model (optional)
> {"action": "function_call", "name": "pdf", "arguments": {"pdf": "/path/to/document.pdf"}}
> {"action": "function_call", "name": "pdf", "arguments": {"pdf": "/path/to/doc.pdf", "prompt": "Summarize this document", "pages": "1-5"}}
> {"action": "function_call", "name": "pdf", "arguments": {"pdfs": ["/doc1.pdf", "/doc2.pdf"], "prompt": "Compare these two"}}

### memory_search — Search MEMORY.md + memory/*.md semantically (MUST use before answering about prior work/decisions/dates)
Params: query (required), maxResults (optional), minScore (optional)
> {"action": "function_call", "name": "memory_search", "arguments": {"query": "what did we decide about the API design?"}}
> {"action": "function_call", "name": "memory_search", "arguments": {"query": "meeting notes March", "maxResults": 5}}

### memory_get — Read specific lines from memory files (use after memory_search)
Params: path (required), from (start line, optional), lines (count, optional)
> {"action": "function_call", "name": "memory_get", "arguments": {"path": "MEMORY.md"}}
> {"action": "function_call", "name": "memory_get", "arguments": {"path": "memory/2026-03-21.md", "from": 10, "lines": 20}}

### tts — Convert text to speech (reply with NO_REPLY after success)
Params: text (required), channel (optional, e.g. "telegram")
> {"action": "function_call", "name": "tts", "arguments": {"text": "Chào anh, bé đây nè!"}}
> {"action": "function_call", "name": "tts", "arguments": {"text": "Hello world", "channel": "telegram"}}

### agents_list — List OpenClaw agent IDs allowed for sessions_spawn
> {"action": "function_call", "name": "agents_list", "arguments": {}}

### session_status — Show usage, time, model, reasoning state (answers "what model?")
> {"action": "function_call", "name": "session_status", "arguments": {}}

### subagents — List, steer, or kill sub-agent runs for this session
Actions: list, steer, kill. Params: action (default: "list"), target (run ID for kill/steer), message (text for steer), recentMinutes (filter, optional)
> {"action": "function_call", "name": "subagents", "arguments": {"action": "list"}}
> {"action": "function_call", "name": "subagents", "arguments": {"action": "list", "recentMinutes": 60}}
> {"action": "function_call", "name": "subagents", "arguments": {"action": "steer", "target": "run-123", "message": "Focus on the CSS bug first"}}
> {"action": "function_call", "name": "subagents", "arguments": {"action": "kill", "target": "run-123"}}

### sessions_spawn — Spawn an isolated sub-agent or ACP coding session
Params: task (required, description of work), runtime ("subagent"/"acp"), mode ("run" one-shot / "session" persistent), agentId (optional), model (optional), label (optional), cwd (working dir, optional), runTimeoutSeconds (optional), thread (bool for Discord threads), sandbox ("inherit"/"require"), attachments (array of {name, content})
> {"action": "function_call", "name": "sessions_spawn", "arguments": {"task": "Review the PR and fix any issues", "runtime": "subagent", "mode": "run"}}
> {"action": "function_call", "name": "sessions_spawn", "arguments": {"task": "Build a new React component", "runtime": "acp", "agentId": "claude-code", "mode": "run", "cwd": "/Users/xnohat/project"}}
> {"action": "function_call", "name": "sessions_spawn", "arguments": {"task": "Monitor CI pipeline", "runtime": "subagent", "mode": "session", "label": "ci-monitor"}}

### sessions_send — Send a message to another session/sub-agent
Params: sessionKey (required), message (required)
> {"action": "function_call", "name": "sessions_send", "arguments": {"sessionKey": "session-123", "message": "Status update"}}

### sessions_list — List other sessions with filters
> {"action": "function_call", "name": "sessions_list", "arguments": {}}

### sessions_history — Fetch history for another session
> {"action": "function_call", "name": "sessions_history", "arguments": {"sessionKey": "session-123"}}
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
