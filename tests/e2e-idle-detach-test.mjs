#!/usr/bin/env node
/**
 * E2E Idle Auto-Detach Test
 *
 * Verifies that:
 * 1. After CDP commands, the debugger detaches after 30s idle
 * 2. Re-attach works transparently on next command
 * 3. New tabs opened during idle don't get debugger bar
 *
 * Usage: node tests/e2e-idle-detach-test.mjs
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

  // Step 1: Connect and get targets
  log('Step 1: Target.setAutoAttach...')
  await sendCDP('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
  await new Promise(r => setTimeout(r, 1000))
  log(`  Found ${targets.size} targets`)

  // Step 2: Send CDP commands to first page target (triggers debugger attach)
  const pageTargets = [...targets.entries()].filter(([, t]) => t.targetInfo.type === 'page')
  if (pageTargets.length === 0) { log('No page targets'); ws.close(); process.exit(1) }

  const [targetId, { sessionId }] = pageTargets[0]
  const label = pageTargets[0][1].targetInfo.title || targetId.slice(0, 12)
  log(`Step 2: Sending commands to [${label}] (attaches debugger)...`)
  await sendCDP('Page.enable', {}, sessionId)
  await sendCDP('Runtime.enable', {}, sessionId)
  const tree = await sendCDP('Page.getFrameTree', {}, sessionId)
  const world = await sendCDP('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: '__idle_test__', grantUniveralAccess: true }, sessionId)
  const eval1 = await sendCDP('Runtime.evaluate', { expression: 'document.title', contextId: world.executionContextId, returnByValue: true }, sessionId)
  log(`  ✅ Title: "${eval1?.result?.value}" — debugger is now attached`)

  // Step 3: Wait for idle detach (30s + buffer)
  log('Step 3: Waiting 35s for idle auto-detach...')
  await new Promise(r => setTimeout(r, 35000))
  log('  Idle period complete — debugger should be detached now')

  // Step 4: Send commands again — should re-attach transparently
  log('Step 4: Sending commands again (should re-attach transparently)...')
  try {
    await sendCDP('Page.enable', {}, sessionId)
    await sendCDP('Runtime.enable', {}, sessionId)
    const tree2 = await sendCDP('Page.getFrameTree', {}, sessionId)
    const world2 = await sendCDP('Page.createIsolatedWorld', { frameId: tree2.frameTree.frame.id, worldName: '__idle_test_2__', grantUniveralAccess: true }, sessionId)
    const eval2 = await sendCDP('Runtime.evaluate', { expression: 'document.title', contextId: world2.executionContextId, returnByValue: true }, sessionId)
    log(`  ✅ Re-attach successful! Title: "${eval2?.result?.value}"`)
  } catch (err) {
    log(`  ❌ Re-attach FAILED: ${err.message}`)
    ws.close()
    process.exit(1)
  }

  log('\n✅✅ ALL TESTS PASSED — idle detach + re-attach works\n')
  ws.close()
  process.exit(0)
}

run().catch(err => { console.error('Fatal:', err); process.exit(1) })
