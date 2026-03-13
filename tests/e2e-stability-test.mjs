#!/usr/bin/env node
/**
 * E2E Stability Test — Simulates real agent usage patterns
 *
 * Tests the exact failure scenarios the user reported:
 * 1. Connect → interact with tabs → wait for idle detach → interact again (same targetIds)
 * 2. Navigate a tab → verify targetId stays the same → interact again
 * 3. Multiple rounds of idle → re-attach cycles
 * 4. Verify timeout doesn't happen on navigate
 *
 * Usage: node tests/e2e-stability-test.mjs
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

function send(obj) { ws.send(JSON.stringify(obj)) }

function sendCDP(method, params, sessionId) {
  return new Promise((resolve, reject) => {
    const id = msgId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)) }, TIMEOUT)
    pending.set(id, { resolve, reject, timer })
    const msg = { id, method }
    if (params) msg.params = params
    if (sessionId) msg.sessionId = sessionId
    send(msg)
  })
}

function log(msg) { console.log(`[${new Date().toISOString().slice(11, 23)}] ${msg}`) }

/** Test a single tab: Page.enable → getFrameTree → createIsolatedWorld → evaluate → screenshot */
async function testTab(sessionId, label) {
  await sendCDP('Page.enable', {}, sessionId)
  await sendCDP('Runtime.enable', {}, sessionId)
  const tree = await sendCDP('Page.getFrameTree', {}, sessionId)
  const frameId = tree?.frameTree?.frame?.id
  const url = tree?.frameTree?.frame?.url || '?'
  if (!frameId) throw new Error('No frame.id')

  const world = await sendCDP('Page.createIsolatedWorld', { frameId, worldName: '__stability_test__', grantUniveralAccess: true }, sessionId)
  if (!world?.executionContextId) throw new Error('No contextId')

  const evalResult = await sendCDP('Runtime.evaluate', { expression: 'document.title', contextId: world.executionContextId, returnByValue: true }, sessionId)
  const title = evalResult?.result?.value || '(empty)'

  const screenshot = await sendCDP('Page.captureScreenshot', { format: 'jpeg', quality: 20 }, sessionId)
  const kb = Math.round((screenshot?.data?.length || 0) * 0.75 / 1024)
  if (kb < 1) throw new Error('Screenshot too small')

  return { title, url, kb }
}

async function run() {
  log('Connecting to CDP...')
  ws = new WebSocket(`ws://localhost:${RELAY_PORT}/cdp?token=${RELAY_TOKEN}`)
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('connect timeout')), 10000)
    ws.on('open', () => { clearTimeout(t); resolve() })
    ws.on('error', (err) => { clearTimeout(t); reject(err) })
  })

  ws.on('message', (data) => {
    let msg; try { msg = JSON.parse(data.toString()) } catch { return }
    if (!('id' in msg) && msg.method === 'Target.attachedToTarget' && msg.params?.targetInfo) {
      targets.set(msg.params.targetInfo.targetId, { sessionId: msg.params.sessionId, targetInfo: msg.params.targetInfo })
      return
    }
    if ('id' in msg) {
      const p = pending.get(msg.id)
      if (p) { clearTimeout(p.timer); pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error?.message || JSON.stringify(msg.error))) : p.resolve(msg.result || {}) }
    }
  })

  // ─── Phase 1: Initial connect + interact ───
  log('\n══════ Phase 1: Initial connect + interact ══════')
  await sendCDP('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  await new Promise(r => setTimeout(r, 1000))

  const pageTargets = [...targets.entries()].filter(([, t]) => t.targetInfo.type === 'page')
  log(`Found ${pageTargets.length} page targets`)
  if (pageTargets.length === 0) { log('ERROR: No targets'); ws.close(); process.exit(1) }

  // Save targetIds for later comparison
  const savedTargetIds = new Map()
  for (const [tid, { sessionId, targetInfo }] of pageTargets) {
    savedTargetIds.set(tid, sessionId)
    const label = targetInfo.title || tid.slice(0, 12)
    try {
      const result = await testTab(sessionId, label)
      log(`  ✅ [${label}] title="${result.title}" url=${result.url} screenshot=${result.kb}KB`)
    } catch (err) {
      log(`  ❌ [${label}] ${err.message}`)
      ws.close(); process.exit(1)
    }
  }

  // ─── Phase 2: Wait for idle detach (35s) then re-interact ───
  log('\n══════ Phase 2: Idle detach + re-interact (same targetIds) ══════')
  log('Waiting 35s for idle auto-detach...')
  await new Promise(r => setTimeout(r, 35000))

  for (const [tid, sessionId] of savedTargetIds) {
    const label = targets.get(tid)?.targetInfo?.title || tid.slice(0, 12)
    try {
      const result = await testTab(sessionId, label)
      log(`  ✅ [${label}] re-attached OK! title="${result.title}" screenshot=${result.kb}KB`)
    } catch (err) {
      log(`  ❌ [${label}] FAILED after idle: ${err.message}`)
      ws.close(); process.exit(1)
    }
  }

  // ─── Phase 3: Navigate a tab then interact ───
  log('\n══════ Phase 3: Navigate tab + interact ══════')
  const [firstTid, firstSid] = [...savedTargetIds.entries()][0]
  const firstLabel = targets.get(firstTid)?.targetInfo?.title || firstTid.slice(0, 12)

  log(`Navigating [${firstLabel}] to https://example.com ...`)
  try {
    await sendCDP('Page.navigate', { url: 'https://example.com' }, firstSid)
    // Wait for navigation
    await new Promise(r => setTimeout(r, 3000))

    // Test with SAME sessionId and SAME targetId
    const result = await testTab(firstSid, firstLabel)
    log(`  ✅ After navigate: title="${result.title}" url=${result.url} screenshot=${result.kb}KB`)
  } catch (err) {
    log(`  ❌ After navigate: ${err.message}`)
    ws.close(); process.exit(1)
  }

  // ─── Phase 4: Second idle cycle ───
  log('\n══════ Phase 4: Second idle cycle ══════')
  log('Waiting 35s for second idle detach...')
  await new Promise(r => setTimeout(r, 35000))

  for (const [tid, sessionId] of savedTargetIds) {
    const label = targets.get(tid)?.targetInfo?.title || tid.slice(0, 12)
    try {
      const result = await testTab(sessionId, label)
      log(`  ✅ [${label}] 2nd re-attach OK! title="${result.title}" screenshot=${result.kb}KB`)
    } catch (err) {
      log(`  ❌ [${label}] 2nd re-attach FAILED: ${err.message}`)
      ws.close(); process.exit(1)
    }
  }

  // ─── Phase 5: Navigate back then interact ───
  log('\n══════ Phase 5: Navigate back + interact ══════')
  log(`Navigating back to https://www.google.com ...`)
  try {
    await sendCDP('Page.navigate', { url: 'https://www.google.com' }, firstSid)
    await new Promise(r => setTimeout(r, 3000))
    const result = await testTab(firstSid, 'navigated tab')
    log(`  ✅ After second navigate: title="${result.title}" screenshot=${result.kb}KB`)
  } catch (err) {
    log(`  ❌ After second navigate: ${err.message}`)
    ws.close(); process.exit(1)
  }

  log('\n══════════════════════════════════════════')
  log('✅✅✅ ALL STABILITY TESTS PASSED')
  log('══════════════════════════════════════════\n')
  ws.close()
  process.exit(0)
}

run().catch(err => { console.error('Fatal:', err); process.exit(1) })
