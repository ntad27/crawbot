---
name: WebAuth Provider Implementation Guide
description: Step-by-step guide for implementing WebAuth providers using inject-script + internal API approach. Covers research via CDP network monitoring, template capture via Fetch interception, response parsing, and debugging techniques.
type: reference
---

Detailed guide at `docs/webauth-provider-implementation-guide.md`.

Key techniques:
- CDP `Fetch.enable` + `Fetch.requestPaused` to capture exact request format from web app
- CDP `Network.enable` + `Network.requestWillBeSent` for monitoring
- Raw WebSocket CDP (`ws://127.0.0.1:9222/devtools/page/{targetId}`) for off-screen views (Electron's executeJavaScript hangs on hidden views)
- `WebContentsViewAdapter` bridges WebContentsView to WebviewLike interface via CDP
- Template capture pattern: trigger DOM send → intercept real API request → cache template → replay with different message
- Cookie import: `sameSite: 'unspecified'` explicitly (Electron defaults to 'lax' if omitted)
- Browser storage sync: cookies + localStorage + sessionStorage + IndexedDB via Chrome extension `scripting` permission
- Message consolidation: flatten OpenAI messages array into single prompt with `<system>`, `<user>`, `<assistant>` tags
