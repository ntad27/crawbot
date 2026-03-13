#!/usr/bin/env node
/**
 * FULL E2E Test — Covers ALL reported bugs
 *
 * Test 1: Basic tab interaction (Page.enable, getFrameTree, createIsolatedWorld, evaluate, screenshot)
 * Test 2: Target.createTarget (open new tab) → interact with it → no "tab not found"
 * Test 3: Navigate tab → same targetId → still works
 * Test 4: Idle detach (30s) → re-interact with same targetIds → still works
 * Test 5: Close created tab → verify cleanup
 *
 * Usage: node tests/e2e-full-test.mjs
 */

import { WebSocket } from 'ws'
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createHmac } from 'crypto'

const RELAY_PORT = 18792
const TIMEOUT = 60000

let GATEWAY_TOKEN = ''
const settingsPath = join(homedir(), 'Library', 'Application Support', 'crawbot', 'settings.json')
if (existsSync(settingsPath)) {
  try { GATEWAY_TOKEN = JSON.parse(readFileSync(settingsPath, 'utf8')).gatewayToken || '' } catch {}
}
if (!GATEWAY_TOKEN) { console.error('No gateway token'); process.exit(1) }

const RELAY_TOKEN = createHmac('sha256', GATEWAY_TOKEN)
  .update(`openclaw-extension-relay-v1:${RELAY_PORT}`)
  .digest('hex')

let msgId = 1, ws
const pending = new Map()
const targets = new Map()
let testsPassed = 0, testsFailed = 0

function send(obj) { ws.send(JSON.stringify(obj)) }

function sendCDP(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const id = msgId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method} (${TIMEOUT/1000}s)`)) }, TIMEOUT)
    pending.set(id, { resolve, reject, timer })
    const msg = { id, method }
    if (params) msg.params = params
    if (sessionId) msg.sessionId = sessionId
    send(msg)
  })
}

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`) }
function pass(test) { testsPassed++; log(`  ✅ ${test}`) }
function fail(test, err) { testsFailed++; log(`  ❌ ${test}: ${err}`) }

/** Full CRPage init sequence for a session */
async function fullTabTest(sessionId, label) {
  await sendCDP('Page.enable', {}, sessionId)
  await sendCDP('Runtime.enable', {}, sessionId)
  const tree = await sendCDP('Page.getFrameTree', {}, sessionId)
  const frameId = tree?.frameTree?.frame?.id
  const url = tree?.frameTree?.frame?.url || '?'
  if (!frameId) throw new Error('No frame.id in getFrameTree')

  const world = await sendCDP('Page.createIsolatedWorld', {
    frameId, worldName: '__full_test__', grantUniveralAccess: true
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
  log('Connecting to CDP relay...')
  ws = new WebSocket(`ws://localhost:${RELAY_PORT}/cdp?token=${RELAY_TOKEN}`)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 10000)
    ws.on('open', () => { clearTimeout(t); resolve() })
    ws.on('error', (err) => { clearTimeout(t); reject(err) })
  })

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()) } catch { return }
    if (!('id' in msg) && msg.method === 'Target.attachedToTarget' && msg.params?.targetInfo) {
      const ti = msg.params.targetInfo
      targets.set(ti.targetId, { sessionId: msg.params.sessionId, targetInfo: ti })
      return
    }
    if ('id' in msg) {
      const p = pending.get(msg.id)
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error?.message || JSON.stringify(msg.error))) : p.resolve(msg.result || {}) }
    }
  })

  // ═══ Test 1: Basic tab interaction ═══
  log('\n═══ Test 1: Basic tab interaction ═══')
  await sendCDP('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  await new Promise(r => setTimeout(r, 1000))

  const pageTargets = [...targets.entries()].filter(([, t]) => t.targetInfo.type === 'page')
  log(`Found ${pageTargets.length} existing page targets`)

  const savedTargetIds = new Map()
  for (const [tid, { sessionId, targetInfo }] of pageTargets) {
    savedTargetIds.set(tid, sessionId)
    const label = targetInfo.title?.slice(0, 30) || tid.slice(0, 12)
    try {
      const r = await fullTabTest(sessionId, label)
      pass(`[${label}] title="${r.title}" ${r.kb}KB`)
    } catch (err) {
      fail(`[${label}]`, err.message)
    }
  }

  // ═══ Test 2: Target.createTarget (THE BUG: "tab not found" on new tabs) ═══
  log('\n═══ Test 2: Target.createTarget → interact ═══')
  let createdTargetId = null
  let createdSessionId = null
  try {
    const result = await sendCDP('Target.createTarget', { url: 'https://example.com' })
    createdTargetId = result?.targetId
    if (!createdTargetId) throw new Error('No targetId returned')
    pass(`Target.createTarget → targetId=${createdTargetId.slice(0, 12)}...`)

    // Wait for Target.attachedToTarget event + page load
    await new Promise(r => setTimeout(r, 2000))

    // The relay should now know about this target. Try to find it.
    const createdTarget = targets.get(createdTargetId)
    if (!createdTarget) {
      // Try Target.attachToTarget manually
      try {
        const attachResult = await sendCDP('Target.attachToTarget', { targetId: createdTargetId, flatten: true })
        createdSessionId = attachResult?.sessionId
        pass(`Target.attachToTarget → session=${createdSessionId}`)
      } catch (err) {
        fail('Target.attachToTarget for new tab', err.message)
      }
    } else {
      createdSessionId = createdTarget.sessionId
      pass(`New tab announced to relay: session=${createdSessionId}`)
    }

    if (createdSessionId) {
      // Full interaction test on the NEW tab
      const r = await fullTabTest(createdSessionId, 'new tab')
      pass(`New tab interaction: title="${r.title}" url=${r.url} ${r.kb}KB`)
    }
  } catch (err) {
    fail('Target.createTarget', err.message)
  }

  // ═══ Test 3: Navigate tab → same targetId ═══
  log('\n═══ Test 3: Navigate → same targetId ═══')
  if (createdSessionId) {
    try {
      await sendCDP('Page.navigate', { url: 'https://www.google.com' }, createdSessionId)
      await new Promise(r => setTimeout(r, 3000))
      const r = await fullTabTest(createdSessionId, 'after navigate')
      pass(`After navigate: title="${r.title}" url=${r.url} ${r.kb}KB`)
    } catch (err) {
      fail('Navigate + interact', err.message)
    }
  } else {
    log('  (skipped — no created session)')
  }

  // ═══ Test 4: Idle detach → re-interact ═══
  log('\n═══ Test 4: Idle detach (35s) → re-interact ═══')
  log('Waiting 35s for idle auto-detach...')
  await new Promise(r => setTimeout(r, 35000))

  // Re-test ALL tabs with original targetIds
  for (const [tid, sessionId] of savedTargetIds) {
    const label = targets.get(tid)?.targetInfo?.title?.slice(0, 30) || tid.slice(0, 12)
    try {
      const r = await fullTabTest(sessionId, label)
      pass(`[${label}] re-attach: title="${r.title}" ${r.kb}KB`)
    } catch (err) {
      fail(`[${label}] re-attach`, err.message)
    }
  }

  // Also test the created tab after idle
  if (createdSessionId) {
    try {
      const r = await fullTabTest(createdSessionId, 'created tab after idle')
      pass(`Created tab after idle: title="${r.title}" ${r.kb}KB`)
    } catch (err) {
      fail('Created tab after idle', err.message)
    }
  }

  // ═══ Test 5: Close created tab ═══
  log('\n═══ Test 5: Close created tab ═══')
  if (createdTargetId) {
    try {
      const closeResult = await sendCDP('Target.closeTarget', { targetId: createdTargetId })
      if (closeResult?.success) {
        pass('Target.closeTarget succeeded')
      } else {
        fail('Target.closeTarget', 'returned success=false')
      }
    } catch (err) {
      fail('Target.closeTarget', err.message)
    }
  }

  // ═══ Results ═══
  log(`\n${'═'.repeat(50)}`)
  log(`RESULTS: ${testsPassed} passed, ${testsFailed} failed`)
  log(`${'═'.repeat(50)}\n`)

  ws.close()
  process.exit(testsFailed > 0 ? 1 : 0)
}

run().catch(err => { console.error('Fatal:', err); process.exit(1) })
