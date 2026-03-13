#!/usr/bin/env node
/**
 * E2E Browser Relay Test — Simulates Playwright's CDP connection
 *
 * Connects to the relay's CDP WebSocket (ws://localhost:18792/cdp) and simulates
 * exactly what Playwright does during connectOverCDP:
 * 1. Connect to CDP endpoint with auth token
 * 2. Send Target.setAutoAttach → receives Target.attachedToTarget events
 * 3. For each page target, simulate CRPage init:
 *    - Page.enable, Runtime.enable
 *    - Page.getFrameTree → get main frame ID
 *    - Page.createIsolatedWorld → create execution context
 *    - Runtime.evaluate → get title
 *    - Page.captureScreenshot → take screenshot
 * 4. Report pass/fail for each target
 *
 * Usage: node tests/e2e-browser-relay-test.mjs [--relay-port 18792] [--gateway-port 18789]
 */

import { WebSocket } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHmac } from 'crypto'

const args = process.argv.slice(2)
const relayPortIdx = args.indexOf('--relay-port')
const RELAY_PORT = relayPortIdx >= 0 ? parseInt(args[relayPortIdx + 1]) : 18792
const TIMEOUT = 60000 // 60s — B4 patch adds delay

// Read gateway token from settings
let GATEWAY_TOKEN = ''
const settingsPath = join(homedir(), 'Library', 'Application Support', 'crawbot', 'settings.json')
if (existsSync(settingsPath)) {
  try {
    const cfg = JSON.parse(readFileSync(settingsPath, 'utf8'))
    GATEWAY_TOKEN = cfg.gatewayToken || ''
  } catch { /* */ }
}
if (!GATEWAY_TOKEN) {
  console.error('ERROR: Could not find gateway token in settings.json')
  process.exit(1)
}

// Derive relay auth token (same as OpenClaw relay does)
const RELAY_TOKEN = createHmac('sha256', GATEWAY_TOKEN)
  .update(`openclaw-extension-relay-v1:${RELAY_PORT}`)
  .digest('hex')

const CDP_URL = `ws://localhost:${RELAY_PORT}/cdp?token=${RELAY_TOKEN}`

let msgId = 1
let ws
const pending = new Map()
const targets = new Map() // targetId → { sessionId, targetInfo }

function send(obj) {
  ws.send(JSON.stringify(obj))
}

function sendCDP(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const id = msgId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`CDP timeout: ${method} (id=${id}, session=${sessionId || 'browser'})`))
    }, TIMEOUT)
    pending.set(id, { resolve, reject, timer, method })
    const msg = { id, method }
    if (params) msg.params = params
    if (sessionId) msg.sessionId = sessionId
    send(msg)
  })
}

function log(msg) {
  const ts = new Date().toISOString().slice(11, 23)
  console.log(`[${ts}] ${msg}`)
}

async function run() {
  log(`Connecting to ws://localhost:${RELAY_PORT}/cdp ...`)

  ws = new WebSocket(CDP_URL)

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket connect timeout')), 10000)
    ws.on('open', () => { clearTimeout(timer); resolve() })
    ws.on('error', (err) => { clearTimeout(timer); reject(err) })
  })

  log('CDP WebSocket connected (authenticated)')

  // Message handler
  ws.on('message', (data) => {
    let msg
    try { msg = JSON.parse(data.toString()) } catch { return }

    // Handle CDP events (no id field = event)
    if (!('id' in msg) && msg.method) {
      if (msg.method === 'Target.attachedToTarget' && msg.params?.targetInfo) {
        const ti = msg.params.targetInfo
        const sid = msg.params.sessionId
        targets.set(ti.targetId, { sessionId: sid, targetInfo: ti })
        log(`  Target: ${ti.targetId.slice(0, 12)}... type=${ti.type} title="${ti.title || ''}" url="${ti.url || ''}"`)
      }
      return
    }

    // Handle responses
    if ('id' in msg) {
      const p = pending.get(msg.id)
      if (p) {
        clearTimeout(p.timer)
        pending.delete(msg.id)
        if (msg.error) {
          p.reject(new Error(typeof msg.error === 'object' ? msg.error.message || JSON.stringify(msg.error) : String(msg.error)))
        } else {
          p.resolve(msg.result || {})
        }
      }
    }
  })

  // Step 1: Target.setAutoAttach (this triggers the relay to send Target.attachedToTarget events)
  // Note: The B4 patch adds a delay of 3000 + N*2000 ms, so this can take a while
  log('Sending Target.setAutoAttach (may take time due to B4 delay)...')
  try {
    await sendCDP('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    log('Target.setAutoAttach response received')
  } catch (err) {
    log(`Target.setAutoAttach FAILED: ${err.message}`)
    ws.close()
    process.exit(1)
  }

  // Brief wait for any late-arriving events
  await new Promise(r => setTimeout(r, 1000))

  log(`\n=== Found ${targets.size} target(s) ===\n`)

  if (targets.size === 0) {
    log('ERROR: No targets found. Is Chrome open with the extension connected to relay?')
    ws.close()
    process.exit(1)
  }

  // Test each page target
  let passed = 0
  let failed = 0
  const pageTargets = [...targets.entries()].filter(([, t]) => t.targetInfo.type === 'page')

  log(`Testing ${pageTargets.length} page target(s)...\n`)

  for (const [targetId, { sessionId, targetInfo }] of pageTargets) {
    const label = `[${targetInfo.title || targetInfo.url || targetId.slice(0, 12)}]`
    log(`--- ${label} (session=${sessionId}) ---`)

    // Page.enable
    try {
      await sendCDP('Page.enable', {}, sessionId)
      console.log(`  ✅ Page.enable`)
    } catch (err) {
      console.log(`  ❌ Page.enable: ${err.message}`)
      failed++; continue
    }

    // Runtime.enable
    try {
      await sendCDP('Runtime.enable', {}, sessionId)
      console.log(`  ✅ Runtime.enable`)
    } catch (err) {
      console.log(`  ❌ Runtime.enable: ${err.message}`)
      failed++; continue
    }

    // Page.getFrameTree — get main frame ID
    let mainFrameId
    try {
      const tree = await sendCDP('Page.getFrameTree', {}, sessionId)
      mainFrameId = tree?.frameTree?.frame?.id
      const url = tree?.frameTree?.frame?.url || '(no url)'
      if (!mainFrameId) {
        console.log(`  ❌ Page.getFrameTree: No frame.id in response`)
        failed++; continue
      }
      console.log(`  ✅ Page.getFrameTree → frame.id=${mainFrameId.slice(0, 12)}... url=${url}`)
    } catch (err) {
      console.log(`  ❌ Page.getFrameTree: ${err.message}`)
      failed++; continue
    }

    // Page.createIsolatedWorld (THE CRITICAL TEST)
    let executionContextId
    try {
      const world = await sendCDP('Page.createIsolatedWorld', {
        frameId: mainFrameId,
        worldName: '__e2e_test__',
        grantUniveralAccess: true,
      }, sessionId)
      executionContextId = world?.executionContextId
      if (!executionContextId) {
        console.log(`  ❌ Page.createIsolatedWorld: No executionContextId: ${JSON.stringify(world)}`)
        failed++; continue
      }
      console.log(`  ✅ Page.createIsolatedWorld → contextId=${executionContextId}`)
    } catch (err) {
      console.log(`  ❌ Page.createIsolatedWorld: ${err.message}`)
      failed++; continue
    }

    // Runtime.evaluate (get title)
    let title
    try {
      const evalResult = await sendCDP('Runtime.evaluate', {
        expression: 'document.title',
        contextId: executionContextId,
        returnByValue: true,
      }, sessionId)
      title = evalResult?.result?.value || '(empty)'
      console.log(`  ✅ Runtime.evaluate(title) → "${title}"`)
    } catch (err) {
      console.log(`  ⚠️  Runtime.evaluate(title): ${err.message}`)
    }

    // Page.captureScreenshot
    try {
      const screenshot = await sendCDP('Page.captureScreenshot', { format: 'jpeg', quality: 30 }, sessionId)
      const dataLen = screenshot?.data?.length || 0
      if (dataLen > 100) {
        console.log(`  ✅ Page.captureScreenshot → ${Math.round(dataLen * 0.75 / 1024)}KB`)
      } else {
        console.log(`  ❌ Page.captureScreenshot: Too small (${dataLen} chars)`)
        failed++; continue
      }
    } catch (err) {
      console.log(`  ❌ Page.captureScreenshot: ${err.message}`)
      failed++; continue
    }

    passed++
    console.log(`  ✅✅ ALL PASSED\n`)
  }

  console.log(`\n${'='.repeat(50)}`)
  console.log(`RESULTS: ${passed} passed, ${failed} failed out of ${pageTargets.length} page targets`)
  console.log(`${'='.repeat(50)}\n`)

  ws.close()
  process.exit(failed > 0 ? 1 : 0)
}

run().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
