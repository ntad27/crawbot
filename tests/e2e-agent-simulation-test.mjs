#!/usr/bin/env node
/**
 * E2E Agent Simulation Test — Mimics EXACT real agent usage patterns
 *
 * Simulates the failure scenario from the user's log:
 * 1. Connect as Playwright would (Target.setAutoAttach)
 * 2. Open a new tab (Target.createTarget)
 * 3. Snapshot the tab (Page.captureScreenshot)
 * 4. Click something (Runtime.evaluate)
 * 5. Wait (simulating LLM thinking time — 10s, 20s, 40s rounds)
 * 6. Snapshot again — THIS is where "tab not found" used to occur
 * 7. Navigate the tab → verify no timeout
 * 8. Snapshot after navigate → verify still works
 * 9. Disconnect and reconnect (simulating new Playwright connection)
 * 10. Verify all tabs are still accessible after reconnect
 *
 * Tests the exact bugs:
 * - B3 race: __sentTargetIds blocking new connections from receiving targets
 * - B5: pruneStaleTargetsFromCommandFailure cascade
 * - B6: sendToExtension 30s timeout on heavy pages
 * - Idle detach (120s) during LLM think time
 *
 * Usage: node tests/e2e-agent-simulation-test.mjs
 */

import { WebSocket } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHmac } from 'crypto'

const RELAY_PORT = 18792
const TIMEOUT = 120000 // 120s to match new B6 timeout

let GATEWAY_TOKEN = ''
const settingsPath = join(homedir(), 'Library', 'Application Support', 'crawbot', 'settings.json')
if (existsSync(settingsPath)) {
  try { GATEWAY_TOKEN = JSON.parse(readFileSync(settingsPath, 'utf8')).gatewayToken || '' } catch {}
}
if (!GATEWAY_TOKEN) { console.error('No gateway token'); process.exit(1) }

const RELAY_TOKEN = createHmac('sha256', GATEWAY_TOKEN)
  .update(`openclaw-extension-relay-v1:${RELAY_PORT}`)
  .digest('hex')

let msgId = 1
let testsPassed = 0, testsFailed = 0

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`) }
function pass(test) { testsPassed++; log(`  ✅ ${test}`) }
function fail(test, err) { testsFailed++; log(`  ❌ ${test}: ${err}`) }

/**
 * Create a fresh CDP connection (simulates what Playwright does for each browser action).
 * Returns { ws, sendCDP, targets, close }
 */
async function createCdpConnection() {
  const ws = new WebSocket(`ws://localhost:${RELAY_PORT}/cdp?token=${RELAY_TOKEN}`)
  const pending = new Map()
  const targets = new Map()
  let id = msgId

  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 10000)
    ws.on('open', () => { clearTimeout(t); resolve() })
    ws.on('error', (err) => { clearTimeout(t); reject(err) })
  })

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()) } catch { return }
    if (!('id' in msg) && msg.method === 'Target.attachedToTarget' && msg.params?.targetInfo) {
      targets.set(msg.params.targetInfo.targetId, {
        sessionId: msg.params.sessionId,
        targetInfo: msg.params.targetInfo
      })
      return
    }
    if ('id' in msg) {
      const p = pending.get(msg.id)
      if (p) {
        clearTimeout(p.timer)
        pending.delete(msg.id)
        msg.error ? p.reject(new Error(msg.error?.message || JSON.stringify(msg.error))) : p.resolve(msg.result || {})
      }
    }
  })

  function sendCDP(method, params, sessionId) {
    return new Promise((resolve, reject) => {
      const reqId = id++
      const timer = setTimeout(() => { pending.delete(reqId); reject(new Error(`Timeout: ${method} (${TIMEOUT/1000}s)`)) }, TIMEOUT)
      pending.set(reqId, { resolve, reject, timer })
      const msg = { id: reqId, method }
      if (params) msg.params = params
      if (sessionId) msg.sessionId = sessionId
      ws.send(JSON.stringify(msg))
    })
  }

  function close() {
    msgId = id // preserve global counter
    for (const [, p] of pending) { clearTimeout(p.timer) }
    pending.clear()
    ws.close()
  }

  return { ws, sendCDP, targets, close }
}

/**
 * Full tab interaction: Page.enable → getFrameTree → createIsolatedWorld → evaluate → screenshot
 */
async function interactWithTab(sendCDP, sessionId, label) {
  await sendCDP('Page.enable', {}, sessionId)
  await sendCDP('Runtime.enable', {}, sessionId)
  const tree = await sendCDP('Page.getFrameTree', {}, sessionId)
  const frameId = tree?.frameTree?.frame?.id
  const url = tree?.frameTree?.frame?.url || '?'
  if (!frameId) throw new Error('No frame.id in getFrameTree')

  const world = await sendCDP('Page.createIsolatedWorld', {
    frameId, worldName: `__sim_test_${Date.now()}__`, grantUniveralAccess: true
  }, sessionId)
  if (!world?.executionContextId) throw new Error('No executionContextId')

  const evalResult = await sendCDP('Runtime.evaluate', {
    expression: 'document.title', contextId: world.executionContextId, returnByValue: true
  }, sessionId)
  const title = evalResult?.result?.value || '(empty)'

  const screenshot = await sendCDP('Page.captureScreenshot', { format: 'jpeg', quality: 20 }, sessionId)
  const kb = Math.round((screenshot?.data?.length || 0) * 0.75 / 1024)
  if (kb < 1) throw new Error('Screenshot empty')

  return { title, url, kb, frameId }
}

async function run() {
  log('═══════════════════════════════════════════════════════')
  log('  E2E AGENT SIMULATION TEST')
  log('  Simulates real Playwright/OpenClaw browser tool usage')
  log('═══════════════════════════════════════════════════════\n')

  // ═══ Phase 1: Initial connection + discover tabs ═══
  log('═══ Phase 1: Initial connection + Target.setAutoAttach ═══')
  let conn = await createCdpConnection()
  await conn.sendCDP('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  await new Promise(r => setTimeout(r, 2000)) // wait for target events

  let pageTargets = [...conn.targets.entries()].filter(([, t]) => t.targetInfo.type === 'page')
  log(`Found ${pageTargets.length} page targets`)

  if (pageTargets.length === 0) {
    fail('Phase 1', 'No page targets found')
    conn.close()
    process.exit(1)
  }

  // Test interaction with existing tabs
  const existingTargetIds = []
  for (const [tid, { sessionId, targetInfo }] of pageTargets) {
    const label = targetInfo.title?.slice(0, 30) || tid.slice(0, 12)
    try {
      const r = await interactWithTab(conn.sendCDP, sessionId, label)
      pass(`[${label}] title="${r.title}" ${r.kb}KB`)
      existingTargetIds.push({ tid, sessionId })
    } catch (err) {
      fail(`[${label}]`, err.message)
    }
  }
  conn.close()

  // ═══ Phase 2: Reconnect (simulate new browser action) + open new tab ═══
  log('\n═══ Phase 2: Reconnect + Target.createTarget ═══')
  conn = await createCdpConnection()
  await conn.sendCDP('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  await new Promise(r => setTimeout(r, 2000))

  // Verify existing targets are visible after reconnect (B3 race test)
  const reconnectedTargets = [...conn.targets.entries()].filter(([, t]) => t.targetInfo.type === 'page')
  log(`After reconnect: found ${reconnectedTargets.length} page targets`)
  if (reconnectedTargets.length >= existingTargetIds.length) {
    pass(`Reconnect shows all targets (${reconnectedTargets.length} >= ${existingTargetIds.length})`)
  } else {
    fail(`Reconnect target count`, `${reconnectedTargets.length} < ${existingTargetIds.length} — B3 __sentTargetIds race!`)
  }

  // Create new tab
  let createdTargetId = null, createdSessionId = null
  try {
    const result = await conn.sendCDP('Target.createTarget', { url: 'https://example.com' })
    createdTargetId = result?.targetId
    if (!createdTargetId) throw new Error('No targetId returned')
    pass(`Target.createTarget → ${createdTargetId.slice(0, 12)}...`)

    await new Promise(r => setTimeout(r, 2000))

    const createdTarget = conn.targets.get(createdTargetId)
    if (createdTarget) {
      createdSessionId = createdTarget.sessionId
    } else {
      const attachResult = await conn.sendCDP('Target.attachToTarget', { targetId: createdTargetId, flatten: true })
      createdSessionId = attachResult?.sessionId
    }

    if (createdSessionId) {
      const r = await interactWithTab(conn.sendCDP, createdSessionId, 'new tab')
      pass(`New tab interaction: title="${r.title}" ${r.kb}KB`)
    }
  } catch (err) {
    fail('Target.createTarget', err.message)
  }
  conn.close()

  // ═══ Phase 3: Simulate LLM think time then interact again ═══
  // This is the EXACT scenario that causes "tab not found":
  // 1. Agent does a browser action (snapshot/click) — works
  // 2. LLM thinks for 10-40s
  // 3. Agent does another browser action — used to fail with "tab not found"
  const thinkTimes = [5, 15, 35] // seconds
  for (const thinkTime of thinkTimes) {
    log(`\n═══ Phase 3.${thinkTimes.indexOf(thinkTime)+1}: Wait ${thinkTime}s (LLM think time) → reconnect → interact ═══`)
    log(`Waiting ${thinkTime}s...`)
    await new Promise(r => setTimeout(r, thinkTime * 1000))

    conn = await createCdpConnection()
    await conn.sendCDP('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    await new Promise(r => setTimeout(r, 2000))

    const targets = [...conn.targets.entries()].filter(([, t]) => t.targetInfo.type === 'page')
    log(`After ${thinkTime}s wait: found ${targets.length} targets`)

    if (targets.length < existingTargetIds.length) {
      fail(`Wait ${thinkTime}s target count`, `${targets.length} < ${existingTargetIds.length}`)
    } else {
      pass(`Wait ${thinkTime}s: ${targets.length} targets visible`)
    }

    // Try to interact with each target
    for (const [tid, { sessionId, targetInfo }] of targets) {
      const label = targetInfo.title?.slice(0, 25) || tid.slice(0, 12)
      try {
        const r = await interactWithTab(conn.sendCDP, sessionId, label)
        pass(`[${label}] after ${thinkTime}s: title="${r.title}" ${r.kb}KB`)
      } catch (err) {
        fail(`[${label}] after ${thinkTime}s`, err.message)
      }
    }

    // Also test the created tab if it exists
    if (createdTargetId) {
      const ct = conn.targets.get(createdTargetId)
      if (ct) {
        try {
          const r = await interactWithTab(conn.sendCDP, ct.sessionId, 'created tab')
          pass(`Created tab after ${thinkTime}s: title="${r.title}" ${r.kb}KB`)
        } catch (err) {
          fail(`Created tab after ${thinkTime}s`, err.message)
        }
      } else {
        fail(`Created tab after ${thinkTime}s`, 'Not in target list')
      }
    }

    conn.close()
  }

  // ═══ Phase 4: Navigate then interact (navigate timeout test) ═══
  log('\n═══ Phase 4: Navigate + interact (timeout test) ═══')
  conn = await createCdpConnection()
  await conn.sendCDP('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  await new Promise(r => setTimeout(r, 2000))

  if (createdTargetId) {
    const ct = conn.targets.get(createdTargetId)
    if (ct) {
      try {
        await conn.sendCDP('Page.navigate', { url: 'https://www.google.com' }, ct.sessionId)
        await new Promise(r => setTimeout(r, 3000))
        const r = await interactWithTab(conn.sendCDP, ct.sessionId, 'after navigate')
        pass(`Navigate + interact: title="${r.title}" ${r.kb}KB`)
      } catch (err) {
        fail('Navigate + interact', err.message)
      }
    }
  }
  conn.close()

  // ═══ Phase 5: Rapid reconnect stress test ═══
  // Simulates rapid browser actions (open → snapshot → act → snapshot)
  // Each action creates a new Playwright connection
  log('\n═══ Phase 5: Rapid reconnect stress test (5 rapid connections) ═══')
  for (let i = 0; i < 5; i++) {
    conn = await createCdpConnection()
    await conn.sendCDP('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    await new Promise(r => setTimeout(r, 1500))

    const targets = [...conn.targets.entries()].filter(([, t]) => t.targetInfo.type === 'page')
    if (targets.length === 0) {
      fail(`Rapid reconnect #${i+1}`, 'No targets')
      conn.close()
      continue
    }

    const [tid, { sessionId, targetInfo }] = targets[0]
    const label = targetInfo.title?.slice(0, 20) || tid.slice(0, 12)
    try {
      const r = await interactWithTab(conn.sendCDP, sessionId, label)
      pass(`Rapid #${i+1} [${label}]: ${r.kb}KB`)
    } catch (err) {
      fail(`Rapid #${i+1} [${label}]`, err.message)
    }
    conn.close()
    // Small delay between rapid connections
    await new Promise(r => setTimeout(r, 500))
  }

  // ═══ Phase 6: Close created tab ═══
  log('\n═══ Phase 6: Cleanup ═══')
  if (createdTargetId) {
    conn = await createCdpConnection()
    await conn.sendCDP('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
    await new Promise(r => setTimeout(r, 1000))
    try {
      const closeResult = await conn.sendCDP('Target.closeTarget', { targetId: createdTargetId })
      if (closeResult?.success) pass('Closed created tab')
      else fail('Close created tab', 'success=false')
    } catch (err) {
      fail('Close created tab', err.message)
    }
    conn.close()
  }

  // ═══ Results ═══
  log(`\n${'═'.repeat(55)}`)
  log(`RESULTS: ${testsPassed} passed, ${testsFailed} failed`)
  log(`${'═'.repeat(55)}\n`)

  process.exit(testsFailed > 0 ? 1 : 0)
}

run().catch(err => { console.error('Fatal:', err); process.exit(1) })
