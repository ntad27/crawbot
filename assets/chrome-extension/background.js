import { buildRelayWsUrl, isRetryableReconnectError, reconnectDelayMs } from './background-utils.js'

const DEFAULT_PORT = 18792
const AUTO_DISCOVER_INTERVAL_MS = 10000
// Playwright's CRBrowser._onAttachedToTarget asserts browserContextId exists.
// Use a stable fake context ID for all synthetic targets.
const BROWSER_CONTEXT_ID = 'CB-DEFAULT-CTX'

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
  ready: { text: '○', color: '#6B7280' },
}

const CDP_DOMAINS_TO_ENABLE = [
  'Page', 'Runtime', 'DOM', 'Network', 'Input',
  'Emulation', 'Overlay', 'Log',
  // NOTE: Target domain intentionally excluded — we manage target announcements
  // with synthetic UUIDs. Enabling Target causes Chrome to fire Target.attachedToTarget
  // for child targets (iframes), which would create ghost targets in the relay.
]

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
let relayGatewayToken = ''
/** @type {string|null} */
let relayConnectRequestId = null

let nextSession = 1

/**
 * Tab states:
 * - 'announced': visible to relay via synthetic UUID targetId, NO debugger attached (no yellow bar)
 * - 'connecting': debugger attach in progress
 * - 'connected': debugger attached with real CDP targetId (yellow bar on this tab only)
 * @type {Map<number, {state:'announced'|'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>}
 */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()
/** @type {Set<number>} */
const tabOperationLocks = new Set()
/** @type {Set<number>} */
const reattachPending = new Set()
/** @type {Set<number>} Tabs currently in debugger attach — suppress event forwarding */
const attachingTabs = new Set()
/** @type {Set<string>} targetIds announced to current relay connection — prevents duplicates */
const announcedTargetIds = new Set()
// Auto-detach is disabled — Playwright maintains long-lived CDP sessions and
// detaching mid-session corrupts its internal state (stuck responses → timeouts).
// Users can manually detach via the extension icon click.

/** @type {number|null} */
let activeTabId = null

let reconnectAttempt = 0
let reconnectTimer = null
let autoDiscoverTimer = null

// Generate Chrome-like UUID targetId (fallback when real targetId unavailable)
function generateUUID() {
  const h = '0123456789ABCDEF'
  const s = (n) => { let r = ''; for (let i = 0; i < n; i++) r += h[Math.floor(Math.random() * 16)]; return r }
  return `${s(8)}-${s(4)}-${s(4)}-${s(4)}-${s(12)}`
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const n = Number.parseInt(String(stored.relayPort || ''), 10)
  return (Number.isFinite(n) && n > 0 && n <= 65535) ? n : DEFAULT_PORT
}

async function getGatewayToken() {
  const stored = await chrome.storage.local.get(['gatewayToken'])
  return String(stored.gatewayToken || '').trim()
}

// ── Auto-discovery ──────────────────────────────────────────────────────────

async function autoDiscoverToken() {
  const existing = await getGatewayToken()
  if (existing) return existing
  try {
    const res = await fetch(chrome.runtime.getURL('crawbot-config.json'))
    if (res.ok) {
      const data = await res.json()
      if (data.token && data.relayPort) {
        await chrome.storage.local.set({ gatewayToken: data.token, relayPort: data.relayPort })
        console.log(`Auto-discovered config (port ${data.relayPort})`)
        return data.token
      }
    }
  } catch { /* */ }
  return ''
}

function startAutoDiscovery() {
  if (autoDiscoverTimer) return
  autoDiscoverTimer = setInterval(async () => {
    const token = await getGatewayToken()
    if (token && relayWs?.readyState === WebSocket.OPEN) return
    if (!token) {
      const discovered = await autoDiscoverToken()
      if (discovered) { try { await ensureRelayConnection() } catch { /* */ } }
    }
  }, AUTO_DISCOVER_INTERVAL_MS)
}

// ── External message handler ────────────────────────────────────────────────

chrome.runtime.onMessageExternal.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'crawbot:configure') {
    const updates = {}
    if (msg.token) updates.gatewayToken = msg.token
    if (msg.relayPort) updates.relayPort = msg.relayPort
    chrome.storage.local.set(updates).then(async () => {
      sendResponse({ success: true })
      if (msg.token) { try { await ensureRelayConnection(); await announceAllTabs() } catch { /* */ } }
    })
    return true
  }
  if (msg?.type === 'crawbot:status') {
    const attached = [...tabs.values()].filter(t => t.state === 'connected').length
    sendResponse({ connected: relayWs?.readyState === WebSocket.OPEN, announcedTabs: tabs.size, attachedTabs: attached })
    return false
  }
})

// ── Badge / persistence ─────────────────────────────────────────────────────

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

async function persistState() {
  try {
    const entries = []
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.sessionId && tab.targetId) {
        entries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId, attachOrder: tab.attachOrder, state: tab.state })
      }
    }
    await chrome.storage.session.set({ persistedTabs: entries, nextSession })
  } catch { /* */ }
}

async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(['persistedTabs', 'nextSession'])
    if (stored.nextSession) nextSession = Math.max(nextSession, stored.nextSession)
    for (const entry of (stored.persistedTabs || [])) {
      if (entry.state === 'connected') {
        try {
          await chrome.tabs.get(entry.tabId)
          await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Runtime.evaluate', { expression: '1', returnByValue: true })
          // Debugger still alive — refresh targetId in case it changed
          const freshId = await getRealTargetId(entry.tabId, entry.targetId)
          tabs.set(entry.tabId, { state: 'connected', sessionId: entry.sessionId, targetId: freshId, attachOrder: entry.attachOrder })
          tabBySession.set(entry.sessionId, entry.tabId)
          setBadge(entry.tabId, 'on')
          continue
        } catch { /* debugger gone, will re-announce below */ }
      }
      // Re-announce as non-attached
      try {
        await chrome.tabs.get(entry.tabId)
        tabs.set(entry.tabId, { state: 'announced', sessionId: entry.sessionId, targetId: entry.targetId, attachOrder: entry.attachOrder })
        tabBySession.set(entry.sessionId, entry.tabId)
        setBadge(entry.tabId, 'ready')
      } catch { /* tab gone */ }
    }
  } catch { /* */ }
}

// ── Relay connection ────────────────────────────────────────────────────────

async function ensureRelayConnection() {
  if (relayWs?.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    let gatewayToken = await getGatewayToken()
    if (!gatewayToken) gatewayToken = await autoDiscoverToken()

    const port = await getRelayPort()
    const wsUrl = await buildRelayWsUrl(port, gatewayToken)

    try { await fetch(`http://127.0.0.1:${port}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) }) }
    catch (err) { throw new Error(`Relay not reachable (${String(err)})`) }

    const ws = new WebSocket(wsUrl)
    relayWs = ws
    relayGatewayToken = gatewayToken
    ws.onmessage = (event) => { if (ws !== relayWs) return; void whenReady(() => onRelayMessage(String(event.data || ''))) }

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket timeout')), 5000)
      ws.onopen = () => { clearTimeout(t); resolve() }
      ws.onerror = () => { clearTimeout(t); reject(new Error('WebSocket failed')) }
      ws.onclose = (ev) => { clearTimeout(t); reject(new Error(`WebSocket closed (${ev.code})`)) }
    })

    ws.onclose = () => { if (ws !== relayWs) return; onRelayClosed('closed') }
    ws.onerror = () => { if (ws !== relayWs) return; onRelayClosed('error') }
  })()

  try { await relayConnectPromise; reconnectAttempt = 0 }
  finally { relayConnectPromise = null }
}

function onRelayClosed(reason) {
  relayWs = null; relayGatewayToken = ''; relayConnectRequestId = null
  for (const [id, p] of pending.entries()) { pending.delete(id); p.reject(new Error(`Relay disconnected`)) }
  reattachPending.clear()
  announcedTargetIds.clear() // new connection = fresh state
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') setBadge(tabId, 'connecting')
    else setBadge(tabId, 'off')
  }
  scheduleReconnect()
}

function scheduleReconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }
  reconnectAttempt++
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    try {
      await ensureRelayConnection()
      reconnectAttempt = 0
      await announceAllTabs()
    } catch (err) {
      if (isRetryableReconnectError(err)) scheduleReconnect()
    }
  }, reconnectDelayMs(reconnectAttempt))
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('Relay not connected')
  ws.send(JSON.stringify(payload))
}

/**
 * Safely announce a tab to the relay. Handles:
 * - Dedup: skip if targetId already announced in this connection
 * - ID change: detach old targetId first if it changed (synthetic → real)
 * @param {string} sessionId
 * @param {string} targetId - the current (real) targetId
 * @param {string|undefined} oldTargetId - previous targetId if changed
 * @param {{title:string, url:string}} info
 */
function announceTargetToRelay(sessionId, targetId, oldTargetId, info) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return

  // If targetId changed, detach the old one first so relay removes stale CRPage
  if (oldTargetId && oldTargetId !== targetId && announcedTargetIds.has(oldTargetId)) {
    try {
      sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId, targetId: oldTargetId, reason: 'target_id_changed' } } })
    } catch { /* */ }
    announcedTargetIds.delete(oldTargetId)
  }

  // Skip if already announced with this exact targetId
  if (announcedTargetIds.has(targetId)) return

  sendToRelay({
    method: 'forwardCDPEvent',
    params: {
      method: 'Target.attachedToTarget',
      params: {
        sessionId,
        targetInfo: { targetId, type: 'page', title: info.title, url: info.url, attached: true, browserContextId: BROWSER_CONTEXT_ID },
        waitingForDebugger: false,
      },
    },
  })
  announcedTargetIds.add(targetId)
}

function ensureGatewayHandshakeStarted(payload) {
  if (relayConnectRequestId) return
  const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : ''
  relayConnectRequestId = `ext-connect-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  sendToRelay({
    type: 'req', id: relayConnectRequestId, method: 'connect',
    params: {
      minProtocol: 3, maxProtocol: 3,
      client: { id: 'crawbot-relay-extension', version: '1.0.0', platform: 'chrome-extension', mode: 'webchat' },
      role: 'operator', scopes: ['operator.read', 'operator.write'], caps: [], commands: [],
      nonce: nonce || undefined,
      auth: relayGatewayToken ? { token: relayGatewayToken } : undefined,
    },
  })
}

async function onRelayMessage(text) {
  let msg; try { msg = JSON.parse(text) } catch { return }

  if (msg?.type === 'event' && msg.event === 'connect.challenge') {
    try { ensureGatewayHandshakeStarted(msg.payload) } catch { relayConnectRequestId = null }
    return
  }
  if (msg?.type === 'res' && relayConnectRequestId && msg.id === relayConnectRequestId) {
    relayConnectRequestId = null
    if (!msg.ok) { const ws = relayWs; if (ws?.readyState === WebSocket.OPEN) ws.close(1008, 'connect failed') }
    return
  }
  if (msg?.method === 'ping') { try { sendToRelay({ method: 'pong' }) } catch { /* */ }; return }
  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id); if (!p) return; pending.delete(msg.id)
    msg.error ? p.reject(new Error(String(msg.error))) : p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

// ── Tab announce (NO debugger attach — lazy only) ─────────────────────────────

async function announceTab(tabId) {
  if (tabs.has(tabId)) return tabs.get(tabId)

  let tabInfo
  try { tabInfo = await chrome.tabs.get(tabId) } catch { return null }
  if (!isAttachableUrl(tabInfo.url)) return null

  const sid = nextSession++
  const sessionId = `cb-tab-${sid}`
  const isActive = tabId === activeTabId

  // Get real Chrome targetId via chrome.debugger.getTargets() — NO debugger attach needed!
  const realTargetId = await getRealTargetId(tabId)

  const entry = { state: /** @type {const} */ ('announced'), sessionId, targetId: realTargetId, attachOrder: sid }
  tabs.set(tabId, entry)
  tabBySession.set(sessionId, tabId)

  const title = isActive ? `[ACTIVE] ${tabInfo.title || ''}` : (tabInfo.title || '')
  announceTargetToRelay(sessionId, realTargetId, undefined, { title, url: tabInfo.url || '' })

  setBadge(tabId, 'ready')
  await persistState()
  console.log(`Tab ${tabId} announced (targetId: ${realTargetId}, no debugger)`)
  return entry
}

async function announceAllTabs() {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return

  // First re-announce already-tracked tabs — refresh targetIds (no debugger attach)
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.sessionId && tab.targetId) {
      // Refresh real targetId (may have changed after navigation)
      const freshId = await getRealTargetId(tabId, tab.targetId)
      if (freshId !== tab.targetId) {
        tabs.set(tabId, { ...tab, targetId: freshId })
      }

      // Re-announce — dedup prevents duplicates on same connection
      const currentTab = tabs.get(tabId)
      try {
        const tabInfo = await chrome.tabs.get(tabId)
        const isActive = tabId === activeTabId
        const oldTargetId = tab.targetId !== freshId ? tab.targetId : undefined
        const title = isActive ? `[ACTIVE] ${tabInfo.title || ''}` : tabInfo.title || ''
        announceTargetToRelay(tab.sessionId, freshId, oldTargetId, { title, url: tabInfo.url || '' })
        setBadge(tabId, currentTab?.state === 'connected' ? 'on' : 'ready')
      } catch { /* tab gone */ }
    }
  }

  // Then announce + attach all other tabs
  let allTabs
  try { allTabs = await chrome.tabs.query({}) } catch { return }
  for (const tab of allTabs) {
    if (!tab.id || tabs.has(tab.id) || !isAttachableUrl(tab.url)) continue
    try { await announceTab(tab.id) } catch { /* skip */ }
  }

  await persistState()
}

// ── Lazy debugger attach (on CDP command) ────────────────────────────────────

async function ensureDebuggerAttached(tabId) {
  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') return existing
  if (existing?.state === 'connecting') {
    // Another attach in progress — wait for it (poll until done or timeout)
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250))
      const check = tabs.get(tabId)
      if (check?.state === 'connected') return check
      if (check?.state !== 'connecting') break
    }
    const final = tabs.get(tabId)
    if (final?.state === 'connected') return final
    throw new Error('Debugger attach timed out')
  }

  // Mark as connecting to prevent concurrent attaches
  if (existing) tabs.set(tabId, { ...existing, state: /** @type {const} */ ('connecting') })

  const debuggee = { tabId }
  attachingTabs.add(tabId) // suppress event forwarding during attach
  try {
    await chrome.debugger.attach(debuggee, '1.3')
  } catch (err) {
    attachingTabs.delete(tabId)
    if (existing) tabs.set(tabId, { ...existing, state: /** @type {const} */ ('announced') })
    throw err
  }

  // Enable CDP domains so commands work immediately after attach
  // This must happen BEFORE we mark as 'connected' and release attachingTabs
  for (const domain of CDP_DOMAINS_TO_ENABLE) {
    try {
      await chrome.debugger.sendCommand(debuggee, `${domain}.enable`)
    } catch (err) {
      console.warn(`Tab ${tabId}: ${domain}.enable failed:`, err?.message || err)
    }
  }

  // Settle delay — Chrome needs time to initialize CDP session, populate frame tree,
  // and send execution context events after domain enables. Playwright processes these
  // asynchronously via relay, so we need enough time for the full round-trip.
  await new Promise((r) => setTimeout(r, 500))

  // Verify debugger is responsive with a probe command
  try {
    await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', { expression: '1', returnByValue: true })
  } catch (err) {
    console.warn(`Tab ${tabId}: post-attach probe failed, extra settle:`, err?.message || err)
    await new Promise((r) => setTimeout(r, 500))
  }

  attachingTabs.delete(tabId)

  // Keep sessionId but get real Chrome targetId if we don't have one yet
  let sessionId = existing?.sessionId
  let attachOrder = existing?.attachOrder
  let targetId = existing?.targetId
  if (!sessionId) {
    const sid = nextSession++
    sessionId = `cb-tab-${sid}`
    attachOrder = sid
    targetId = targetId || generateUUID()
  }

  // ALWAYS refresh real Chrome target ID on every attach/re-attach
  targetId = await getRealTargetId(tabId, targetId)

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)

  setBadge(tabId, 'on')
  await persistState()
  console.log(`Debugger attached to tab ${tabId} (domains enabled, ready for CDP)`)
  return tabs.get(tabId)
}

// ── Tab detach ───────────────────────────────────────────────────────────────

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)
  for (const [cid, pid] of childSessionToTab.entries()) {
    if (pid === tabId) { try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: cid, reason: 'parent_detached' } } }) } catch { /* */ }; childSessionToTab.delete(cid) }
  }
  if (tab?.sessionId && tab?.targetId) {
    try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetId, reason } } }) } catch { /* */ }
  }
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  if (tab?.state === 'connected') { try { await chrome.debugger.detach({ tabId }) } catch { /* */ } }
  setBadge(tabId, 'off')
  await persistState()
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) { if (tab.targetId === targetId) return tabId }
  return null
}

/**
 * Get real Chrome target ID for a tab (= main frame ID).
 * Playwright requires targetId == main frame ID for _sessionForFrame() lookups.
 *
 * Uses chrome.debugger.getTargets() which does NOT require debugger to be attached.
 * No yellow debugger bar will appear from this call.
 *
 * @param {number} tabId
 * @param {string} [fallback]
 * @returns {Promise<string>}
 */
async function getRealTargetId(tabId, fallback) {
  try {
    const targets = await chrome.debugger.getTargets()
    const match = targets.find(t => t.tabId === tabId && t.type === 'page')
    if (match?.id) {
      return match.id
    }
  } catch (err) {
    console.warn(`Tab ${tabId}: getTargets() failed:`, err?.message || err)
  }
  // Fallback: if debugger IS attached, try Target.getTargetInfo via CDP
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') {
    try {
      const info = /** @type {any} */ (await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo'))
      if (info?.targetInfo?.targetId) return info.targetInfo.targetId
    } catch { /* */ }
  }
  return fallback || generateUUID()
}

function isAttachableUrl(url) {
  if (!url) return true
  return !url.startsWith('chrome://') && !url.startsWith('chrome-extension://') && !url.startsWith('devtools://') && !url.startsWith('chrome-search://')
}

// ── CDP command handler ──────────────────────────────────────────────────────

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  let tabId = bySession?.tabId || (targetId ? getTabByTargetId(targetId) : null)

  // Fallback: prefer active tab, then any tab
  if (!tabId) {
    if (activeTabId && tabs.has(activeTabId)) tabId = activeTabId
    else { for (const [id] of tabs.entries()) { tabId = id; break } }
  }

  // Custom: return active tab info (works without debugger)
  if (method === 'Target.getActiveTarget') {
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!active?.id) return { targetId: null }
      const ts = tabs.get(active.id)
      return { targetId: ts?.targetId || null, sessionId: ts?.sessionId || null, title: active.title, url: active.url, tabId: active.id, attached: ts?.state === 'connected' }
    } catch { return { targetId: null } }
  }

  // Browser-level session: return a unique sessionId so Playwright's CDPSession
  // is created with a valid key.
  if (method === 'Target.attachToBrowserTarget') {
    return { sessionId: `browser-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` }
  }

  // Target.attachToTarget: find the tab by targetId and return a NEW unique sessionId
  // mapped to the same tab. This avoids overwriting the CRPage session (which causes crashes).
  if (method === 'Target.attachToTarget') {
    const tgtId = typeof params?.targetId === 'string' ? params.targetId : ''
    const foundTabId = tgtId ? getTabByTargetId(tgtId) : null
    if (!foundTabId) throw new Error('target not found')
    const aliasId = `alias-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
    tabBySession.set(aliasId, foundTabId)
    return { sessionId: aliasId }
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 300))
    const attached = await ensureDebuggerAttached(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const t = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = t ? getTabByTargetId(t) : tabId
    if (!toClose) return { success: false }
    try { await chrome.tabs.remove(toClose) } catch { return { success: false } }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const t = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = t ? getTabByTargetId(t) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (tab?.windowId) await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    if (toActivate) await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  if (!tabId) throw new Error(`No tab available for ${method}`)

  // Attach debugger (or reuse existing connection)
  await ensureDebuggerAttached(tabId)


  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try { await chrome.debugger.sendCommand(debuggee, 'Runtime.disable'); await new Promise((r) => setTimeout(r, 50)) } catch { /* */ }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  // Only pass sessionId to Chrome for REAL child sessions (iframes etc).
  // Our synthetic sessions (cb-tab-*, alias-*, browser-*) are NOT Chrome sessions.
  const isRealChildSession = sessionId && childSessionToTab.has(sessionId)
  const debuggerSession = isRealChildSession ? { ...debuggee, sessionId } : debuggee
  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

// ── Event listeners ─────────────────────────────────────────────────────────

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId; if (!tabId) return
  const tab = tabs.get(tabId); if (!tab?.sessionId) return

  // Suppress ALL event forwarding during debugger attach to prevent
  // Playwright from reacting to domain-enable events and sending concurrent commands
  if (attachingTabs.has(tabId)) return

  // Track child sessions internally but do NOT forward Target.attachedToTarget /
  // Target.detachedFromTarget to the relay — we manage target announcements ourselves
  // with synthetic UUIDs. Forwarding Chrome's real Target events would create ghost
  // targets in the relay and crash the gateway.
  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
    return
  }
  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
    return
  }

  try { sendToRelay({ method: 'forwardCDPEvent', params: { sessionId: source.sessionId || tab.sessionId, method, params } }) } catch { /* */ }
}

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId; if (!tabId) return
  const tab = tabs.get(tabId); if (!tab || tab.state !== 'connected') return

  // Downgrade to announced — keep same UUID targetId, no relay events
  // The relay still sees this tab by its original UUID; just silently drop the debugger
  let tabInfo
  try { tabInfo = await chrome.tabs.get(tabId) } catch { void detachTab(tabId, reason); return }
  if (!isAttachableUrl(tabInfo.url)) { void detachTab(tabId, reason); return }

  tabs.set(tabId, { ...tab, state: 'announced' })

  // Update title in relay (it may have changed while debugger was attached)
  if (relayWs?.readyState === WebSocket.OPEN && tab.sessionId && tab.targetId) {
    try {
      const isActive = tabId === activeTabId
      sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: tab.targetId, type: 'page', title: isActive ? `[ACTIVE] ${tabInfo.title || ''}` : tabInfo.title || '', url: tabInfo.url || '', attached: true } } } })
    } catch { /* */ }
  }

  setBadge(tabId, 'ready')
  await persistState()
}

// ── Active tab tracking ──────────────────────────────────────────────────────

async function notifyActiveTabChanged(newId, oldId) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return

  // Remove [ACTIVE] from old
  if (oldId && tabs.has(oldId)) {
    const t = tabs.get(oldId)
    if (t?.sessionId && t?.targetId) {
      try {
        let title = ''
        if (t.state === 'connected') {
          const info = /** @type {any} */ (await chrome.debugger.sendCommand({ tabId: oldId }, 'Target.getTargetInfo'))
          title = info?.targetInfo?.title || ''
        } else {
          title = (await chrome.tabs.get(oldId)).title || ''
        }
        sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: t.targetId, type: 'page', title, attached: true } } } })
      } catch { /* */ }
    }
  }

  // Add [ACTIVE] to new
  if (newId && tabs.has(newId)) {
    const t = tabs.get(newId)
    if (t?.sessionId && t?.targetId) {
      try {
        let title = ''
        if (t.state === 'connected') {
          const info = /** @type {any} */ (await chrome.debugger.sendCommand({ tabId: newId }, 'Target.getTargetInfo'))
          title = info?.targetInfo?.title || ''
        } else {
          title = (await chrome.tabs.get(newId)).title || ''
        }
        sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: t.targetId, type: 'page', title: `[ACTIVE] ${title}`, attached: true } } } })
      } catch { /* */ }
    }
  }
}

// ── Tab lifecycle ───────────────────────────────────────────────────────────

chrome.tabs.onRemoved.addListener((tabId) => void whenReady(() => {
  reattachPending.delete(tabId); if (!tabs.has(tabId)) return
  const tab = tabs.get(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId); tabs.delete(tabId)
  for (const [cid, pid] of childSessionToTab.entries()) { if (pid === tabId) childSessionToTab.delete(cid) }
  if (tab?.sessionId && tab?.targetId) { try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetId, reason: 'tab_closed' } } }) } catch { /* */ } }
  void persistState()
}))

// Announce new tabs (no debugger — init commands get mock responses)
chrome.tabs.onCreated.addListener((tab) => void whenReady(async () => {
  if (!tab.id || !relayWs || relayWs.readyState !== WebSocket.OPEN) return
  await new Promise((r) => setTimeout(r, 500))
  if (tabs.has(tab.id)) return
  try { await announceTab(tab.id) } catch { /* */ }
}))

// Update tab info on navigation complete
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => void whenReady(async () => {
  if (changeInfo.status !== 'complete') return

  if (!tabs.has(tabId)) {
    // New tab — announce it
    if (!isAttachableUrl(tab.url) || !relayWs || relayWs.readyState !== WebSocket.OPEN) return
    try { await announceTab(tabId) } catch { /* */ }
    return
  }

  // Existing tab — update title/url in relay
  const entry = tabs.get(tabId)
  if (!entry?.sessionId || !entry?.targetId || !relayWs || relayWs.readyState !== WebSocket.OPEN) return
  const isActive = tabId === activeTabId
  try {
    sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: entry.targetId, type: 'page', title: isActive ? `[ACTIVE] ${tab.title || ''}` : tab.title || '', url: tab.url || '', attached: true } } } })
  } catch { /* */ }
}))

chrome.tabs.onReplaced.addListener((addedId, removedId) => void whenReady(() => {
  const tab = tabs.get(removedId); if (!tab) return
  tabs.delete(removedId); tabs.set(addedId, tab)
  if (tab.sessionId) tabBySession.set(tab.sessionId, addedId)
  for (const [cid, pid] of childSessionToTab.entries()) { if (pid === removedId) childSessionToTab.set(cid, addedId) }
  setBadge(addedId, tab.state === 'connected' ? 'on' : 'ready')
  void persistState()
}))

chrome.debugger.onEvent.addListener((...args) => void whenReady(() => onDebuggerEvent(...args)))
chrome.debugger.onDetach.addListener((...args) => void whenReady(() => onDebuggerDetach(...args)))

// Click icon: force-attach debugger to active tab
chrome.action.onClicked.addListener(() => void whenReady(async () => {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id; if (!tabId || tabOperationLocks.has(tabId)) return
  tabOperationLocks.add(tabId)
  try {
    const existing = tabs.get(tabId)
    if (existing?.state === 'connected') {
      // Detach debugger, downgrade to announced — keep same UUID, no relay events
      try { await chrome.debugger.detach({ tabId }) } catch { /* */ }
      tabs.set(tabId, { ...existing, state: 'announced' })
      setBadge(tabId, 'ready')
      await persistState()
      return
    }

    // Force attach
    try {
      await ensureRelayConnection()
      if (!tabs.has(tabId)) await announceTab(tabId)
      await ensureDebuggerAttached(tabId)
    } catch (err) { setBadge(tabId, 'error'); console.warn('attach failed', err instanceof Error ? err.message : String(err)) }
  } finally { tabOperationLocks.delete(tabId) }
}))

chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => void whenReady(async () => {
  if (frameId !== 0) return
  const tab = tabs.get(tabId)
  if (!tab) return

  // Refresh targetId after navigation — Chrome may assign new frame IDs
  const freshId = await getRealTargetId(tabId, tab.targetId)
  if (freshId !== tab.targetId) {
    tabs.set(tabId, { ...tab, targetId: freshId })
    console.log(`Tab ${tabId} navigated, targetId updated: ${tab.targetId} → ${freshId}`)
    // Update relay with new targetId
    if (relayWs?.readyState === WebSocket.OPEN && tab.sessionId) {
      announcedTargetIds.delete(tab.targetId) // allow re-announce with new ID
      try {
        const tabInfo = await chrome.tabs.get(tabId)
        const isActive = tabId === activeTabId
        const title = isActive ? `[ACTIVE] ${tabInfo.title || ''}` : tabInfo.title || ''
        announceTargetToRelay(tab.sessionId, freshId, tab.targetId, { title, url: tabInfo.url || '' })
      } catch { /* */ }
    }
    await persistState()
  }

  if (tab.state === 'connected') setBadge(tabId, relayWs?.readyState === WebSocket.OPEN ? 'on' : 'connecting')
}))

chrome.tabs.onActivated.addListener(({ tabId }) => void whenReady(async () => {
  const tab = tabs.get(tabId)
  if (tab?.state === 'connected') setBadge(tabId, relayWs?.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  const old = activeTabId; activeTabId = tabId
  await notifyActiveTabChanged(tabId, old)
}))

chrome.windows.onFocusChanged.addListener((windowId) => void whenReady(async () => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return
  try {
    const [active] = await chrome.tabs.query({ active: true, windowId })
    if (!active?.id || active.id === activeTabId) return
    const old = activeTabId; activeTabId = active.id
    await notifyActiveTabChanged(active.id, old)
  } catch { /* */ }
}))

chrome.runtime.onInstalled.addListener(() => {
  console.log('CrawBot Browser Relay — lazy attach mode (debugger on demand only)')
  // Don't race with init — let initPromise handle the first announceAllTabs()
})

// MV3 keepalive
chrome.alarms.create('relay-keepalive', { periodInMinutes: 0.5 })
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'relay-keepalive') return
  await initPromise
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') setBadge(tabId, relayWs?.readyState === WebSocket.OPEN ? 'on' : 'connecting')
  }
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    if (!relayConnectPromise && !reconnectTimer) {
      if (!await getGatewayToken()) await autoDiscoverToken()
      await ensureRelayConnection().catch(() => { if (!reconnectTimer) scheduleReconnect() })
    }
  } else {
    // Announce any new tabs
    await announceAllTabs()
  }
})

// Options page relay check
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'relayCheck') {
    const { url, token } = msg
    fetch(url, { method: 'GET', headers: token ? { 'x-openclaw-relay-token': token } : {}, signal: AbortSignal.timeout(2000) })
      .then(async (res) => {
        const ct = String(res.headers.get('content-type') || '')
        let json = null; if (ct.includes('application/json')) { try { json = await res.json() } catch { /* */ } }
        sendResponse({ status: res.status, ok: res.ok, contentType: ct, json })
      })
      .catch((err) => sendResponse({ status: 0, ok: false, error: String(err) }))
    return true
  }
})

// ── Init ────────────────────────────────────────────────────────────────────

const initPromise = rehydrateState()

initPromise.then(async () => {
  startAutoDiscovery()
  try { const [a] = await chrome.tabs.query({ active: true, currentWindow: true }); if (a?.id) activeTabId = a.id } catch { /* */ }

  const token = await getGatewayToken()
  if (token || tabs.size > 0) {
    try {
      await ensureRelayConnection()
      reconnectAttempt = 0
      await announceAllTabs()
    } catch { scheduleReconnect() }
  }
})

async function whenReady(fn) { await initPromise; return fn() }
