---
name: WebAuth Provider Implementation Guide
description: Step-by-step guide for implementing WebAuth providers using inject-script + internal API approach. Covers research via CDP network monitoring, template capture via Fetch interception, response parsing, tool call translation, and debugging techniques.
type: reference
---

Detailed guide at `docs/webauth-provider-implementation-guide.md`.

Key techniques:
- CDP `Fetch.enable` + `Fetch.requestPaused` to capture exact request format from web app
- CDP `Network.enable` + `Network.requestWillBeSent` for monitoring
- Raw WebSocket CDP (`ws://127.0.0.1:9222/devtools/page/{targetId}`) for off-screen views (Electron's executeJavaScript AND debugger.sendCommand both hang on hidden views)
- `WebContentsViewAdapter` bridges WebContentsView to WebviewLike interface via CDP WebSocket
- Template capture pattern: trigger DOM send → intercept real API request → cache template → replay with different message
- Cookie import: `sameSite: 'unspecified'` explicitly (Electron defaults to 'lax' if omitted, Chrome uses -1/unspecified)
- Browser storage sync: cookies + localStorage + sessionStorage + IndexedDB via Chrome extension `scripting` permission
- Message consolidation: flatten OpenAI messages array into single prompt with `<system_instruction>`, `<user>`, `<assistant>`, `<tool_result>` tags (NOT `<system>` — Gemini rejects it)
- Tool call support: transform native tool defs → text-based ```tool_call``` blocks → parse response → emit OpenAI tool_calls format
- Gemini response parsing: answer at data[4][0][1] = ["text"] (filter strings, NOT x[0] which gets first char)
- Gateway config: minimal model format { id, name } only (extra fields crash Gateway)
