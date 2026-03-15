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

// CDP domains are NOT pre-enabled by the extension — Playwright enables them
// itself during CRPage init. Pre-enabling would consume Chrome's one-shot init
// events while the attachingTabs guard suppresses forwarding, leaving Playwright's
// CRPage in a broken state (no frame tree, no execution contexts).

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
// Idle auto-detach: detach debugger after IDLE_DETACH_MS of no CDP commands.
// This removes the yellow bar when the agent is done using the browser.
// Re-attach happens transparently when the next CDP command arrives.
const IDLE_DETACH_MS = 120_000 // 120 seconds — LLM takes 30-60s to think between actions
/** @type {Map<number, ReturnType<typeof setTimeout>>} */
const idleDetachTimers = new Map()
/** @type {Set<number>} Tabs where user explicitly dismissed the debugger bar.
 * Re-attachment is blocked until a NEW agent CDP command targets this tab. */
const userDismissedTabs = new Set()

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
      if (discovered) { try { await ensureRelayConnection(); await announceAllTabs(); await discoverAndAnnounceNewTabs() } catch { /* */ } }
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
      if (msg.token) { try { await ensureRelayConnection(); await announceAllTabs(); await discoverAndAnnounceNewTabs() } catch { /* */ } }
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
      await discoverAndAnnounceNewTabs()
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

  // Use a STABLE UUID as targetId — never changes for the tab's lifetime.
  // Chrome's real target IDs change on navigation, causing "tab not found" errors
  // when the agent caches old IDs. The frame ID rewriting mechanism handles any
  // mismatch between our stable UUID and Chrome's changing frame/target IDs.
  const stableTargetId = generateUUID()

  const entry = { state: /** @type {const} */ ('announced'), sessionId, targetId: stableTargetId, attachOrder: sid }
  tabs.set(tabId, entry)
  tabBySession.set(sessionId, tabId)

  const title = isActive ? `[ACTIVE] ${tabInfo.title || ''}` : (tabInfo.title || '')
  announceTargetToRelay(sessionId, stableTargetId, undefined, { title, url: tabInfo.url || '' })

  setBadge(tabId, 'ready')
  await persistState()
  console.log(`Tab ${tabId} announced (targetId: ${stableTargetId}, stable UUID)`)
  return entry
}

async function announceAllTabs() {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return

  // Re-announce already-tracked tabs with STABLE targetIds (no refresh).
  // Also clean up stale entries (tabs closed while service worker was suspended).
  const stale = []
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.sessionId && tab.targetId) {
      try {
        const tabInfo = await chrome.tabs.get(tabId)

        // Re-announce with same stable UUID — dedup prevents duplicates
        const isActive = tabId === activeTabId
        const title = isActive ? `[ACTIVE] ${tabInfo.title || ''}` : tabInfo.title || ''
        announceTargetToRelay(tab.sessionId, tab.targetId, undefined, { title, url: tabInfo.url || '' })
        setBadge(tabId, tab.state === 'connected' ? 'on' : 'ready')
      } catch {
        // Tab no longer exists — mark for cleanup
        stale.push(tabId)
      }
    }
  }
  // Remove stale tabs and notify relay
  for (const tabId of stale) {
    const tab = tabs.get(tabId)
    if (tab?.sessionId) tabBySession.delete(tab.sessionId)
    tabs.delete(tabId)
    if (tab?.sessionId && tab?.targetId) {
      try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetId } } }) } catch { /* */ }
    }
    console.log(`Cleaned up stale tab ${tabId}`)
  }

  // NOTE: We intentionally do NOT discover/announce new tabs here.
  // New tabs are only announced on-demand when the agent targets them
  // (via handleForwardCdpCommand → announceTab). This prevents the debugger
  // bar from appearing on tabs the user is just browsing normally.
  // New tabs CAN be announced on initial relay connect (announceAllTabs
  // is called once at startup), but NOT on periodic keepalive.

  await persistState()
}

/** One-time full discovery — called only on initial relay connect. */
async function discoverAndAnnounceNewTabs() {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return
  let allTabs
  try { allTabs = await chrome.tabs.query({}) } catch { allTabs = [] }
  for (const tab of allTabs) {
    if (!tab.id || tabs.has(tab.id) || !isAttachableUrl(tab.url)) continue
    try { await announceTab(tab.id) } catch { /* skip */ }
  }
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
    const msg = err?.message || String(err)
    if (msg.includes('Another debugger') || msg.includes('already attached')) {
      // Debugger already attached (e.g. DevTools open or previous session) — reuse it.
      // Verify it's responsive, then treat as connected.
      try {
        await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', { expression: '1', returnByValue: true })
        console.log(`Tab ${tabId}: reusing existing debugger attachment`)
        // Fall through to domain enables below
      } catch {
        attachingTabs.delete(tabId)
        if (existing) tabs.set(tabId, { ...existing, state: /** @type {const} */ ('announced') })
        throw new Error(`Tab ${tabId}: debugger attached by another client and not responsive`)
      }
    } else {
      attachingTabs.delete(tabId)
      if (existing) tabs.set(tabId, { ...existing, state: /** @type {const} */ ('announced') })
      throw err
    }
  }

  // Pre-enable Page domain to get the REAL main frame ID from Page.getFrameTree.
  // Chrome's target IDs can differ from main frame IDs (e.g. after SPA navigation).
  // Playwright REQUIRES targetId == main frame.id for CRPage to work.
  // We intentionally do NOT call Page.disable — leaving Page enabled means
  // Playwright's subsequent Page.enable is a no-op, which is fine since Playwright
  // uses Page.getFrameTree (not Page.enable events) for initial state.
  // Events fired during this probe are suppressed by the attachingTabs guard.
  let realFrameId = null
  try {
    await chrome.debugger.sendCommand(debuggee, 'Page.enable')
    const tree = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Page.getFrameTree'))
    realFrameId = tree?.frameTree?.frame?.id || null
  } catch (err) {
    console.warn(`Tab ${tabId}: Page.getFrameTree probe failed:`, err?.message || err)
  }

  attachingTabs.delete(tabId)

  // Keep existing sessionId and STABLE targetId — never refresh targetId from Chrome.
  // Chrome's real target IDs change on navigation, but our UUID is stable for the tab's lifetime.
  // The frame ID rewriting mechanism handles any mismatch transparently.
  let sessionId = existing?.sessionId
  let attachOrder = existing?.attachOrder
  let targetId = existing?.targetId
  if (!sessionId) {
    const sid = nextSession++
    sessionId = `cb-tab-${sid}`
    attachOrder = sid
    targetId = targetId || generateUUID()
  }

  // Set up frame ID rewriting if the real frame ID (from Page.getFrameTree probe)
  // differs from our stable announced targetId. This is EXPECTED — Chrome's frame IDs
  // are ephemeral, our targetId is a stable UUID.
  let frameIdMap = null
  if (realFrameId && realFrameId !== targetId) {
    console.log(`Tab ${tabId}: frame ID rewrite: targetId=${targetId}, realFrameId=${realFrameId}`)
    frameIdMap = { real: realFrameId, announced: targetId }
  }

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder, frameIdMap })
  tabBySession.set(sessionId, tabId)

  setBadge(tabId, 'on')
  await persistState()
  console.log(`Debugger attached to tab ${tabId} (targetId: ${targetId}, ready for CDP)`)
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

// ── Idle auto-detach ─────────────────────────────────────────────────────────

function resetIdleDetachTimer(tabId) {
  const existing = idleDetachTimers.get(tabId)
  if (existing) clearTimeout(existing)
  idleDetachTimers.set(tabId, setTimeout(() => {
    idleDetachTimers.delete(tabId)
    const tab = tabs.get(tabId)
    if (!tab || tab.state !== 'connected') return
    console.log(`Tab ${tabId}: idle auto-detach after ${IDLE_DETACH_MS / 1000}s`)
    // Downgrade to announced — keep UUID, no relay events
    try { chrome.debugger.detach({ tabId }) } catch { /* */ }
    tabs.set(tabId, { ...tab, state: 'announced', frameIdMap: undefined })
    setBadge(tabId, 'ready')
    void persistState()
  }, IDLE_DETACH_MS))
}

function clearIdleDetachTimer(tabId) {
  const existing = idleDetachTimers.get(tabId)
  if (existing) { clearTimeout(existing); idleDetachTimers.delete(tabId) }
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

/**
 * Rewrite frame IDs in a CDP result/params object to match the announced targetId.
 * Chrome can return frame IDs that differ from the target ID (e.g. after navigation).
 * Playwright requires targetId == main frame.id, so we transparently patch the mismatch.
 * @param {any} obj - The object to rewrite (mutated in place)
 * @param {string} realId - Chrome's actual frame ID
 * @param {string} announcedId - The targetId we announced to the relay
 */
function rewriteFrameIds(obj, realId, announcedId) {
  if (!obj || typeof obj !== 'object') return
  // Direct frameId fields
  if (obj.frameId === realId) obj.frameId = announcedId
  // Frame objects (Page.getFrameTree, Page.frameNavigated)
  if (obj.id === realId) obj.id = announcedId
  if (obj.parentId === realId) obj.parentId = announcedId
  // Nested objects
  if (obj.frame) rewriteFrameIds(obj.frame, realId, announcedId)
  if (obj.frameTree) rewriteFrameIds(obj.frameTree, realId, announcedId)
  // auxData in Runtime.executionContextCreated
  if (obj.context?.auxData?.frameId === realId) obj.context.auxData.frameId = announcedId
  // Child frames in Page.getFrameTree
  if (Array.isArray(obj.childFrames)) {
    for (const child of obj.childFrames) rewriteFrameIds(child, realId, announcedId)
  }
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

  // Custom: return active tab info (works without debugger).
  // Also announces the active tab on-demand so the relay/Playwright knows about it.
  if (method === 'Target.getActiveTarget') {
    try {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (!active?.id) return { targetId: null }
      // On-demand announce: ensure relay knows about this tab
      if (!tabs.has(active.id)) await announceTab(active.id)
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
    // Announce first (assigns stable UUID), then attach debugger
    if (!tabs.has(tab.id)) await announceTab(tab.id)
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

  // Target.getTargets: re-discover new tabs before returning the list.
  // Without this, tabs opened after initial relay connect are invisible.
  if (method === 'Target.getTargets') {
    // Discover any new tabs that haven't been announced yet
    let allTabs
    try { allTabs = await chrome.tabs.query({}) } catch { allTabs = [] }
    for (const t of allTabs) {
      if (!t.id || tabs.has(t.id) || !isAttachableUrl(t.url)) continue
      try { await announceTab(t.id) } catch { /* skip */ }
    }
    // Build synthetic target list from our tracked tabs
    const targetInfos = []
    for (const [tabId, entry] of tabs.entries()) {
      if (!entry.targetId) continue
      let title = '', url = ''
      try {
        const info = await chrome.tabs.get(tabId)
        title = info.title || ''
        url = info.url || ''
      } catch { continue } // tab gone
      const isActive = tabId === activeTabId
      targetInfos.push({
        targetId: entry.targetId,
        type: 'page',
        title: isActive ? `[ACTIVE] ${title}` : title,
        url,
        attached: entry.state === 'connected',
        browserContextId: BROWSER_CONTEXT_ID,
      })
    }
    return { targetInfos }
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

  // On-demand tab discovery: if no tab found by session/targetId, try to find
  // the Chrome tab by targetId and announce it now (lazy announcement).
  if (!tabId && targetId) {
    try {
      const targets = await chrome.debugger.getTargets()
      const match = targets.find(t => t.id === targetId && t.type === 'page')
      if (match?.tabId) {
        await announceTab(match.tabId)
        tabId = match.tabId
      }
    } catch { /* */ }
  }

  // Last resort: use active tab
  if (!tabId) {
    if (activeTabId && tabs.has(activeTabId)) tabId = activeTabId
    else {
      // Try to announce active tab on-demand
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (active?.id) { await announceTab(active.id); tabId = active.id }
      } catch { /* */ }
    }
  }

  if (!tabId) throw new Error(`No tab available for ${method}`)

  // Clear user-dismissed flag — a fresh agent CDP command overrides the dismissal
  userDismissedTabs.delete(tabId)

  // Attach debugger (or reuse existing connection)
  await ensureDebuggerAttached(tabId)

  // Reset idle auto-detach timer — the agent is actively using this tab
  resetIdleDetachTimer(tabId)

  const debuggee = { tabId }

  // Only pass sessionId to Chrome for REAL child sessions (iframes etc).
  // Our synthetic sessions (cb-tab-*, alias-*, browser-*) are NOT Chrome sessions.
  const isRealChildSession = sessionId && childSessionToTab.has(sessionId)
  const debuggerSession = isRealChildSession ? { ...debuggee, sessionId } : debuggee

  // Reverse-rewrite frame IDs in command params: announced → real for Chrome
  let tabEntry = tabs.get(tabId)
  let cmdParams = params
  if (tabEntry?.frameIdMap && cmdParams && typeof cmdParams === 'object') {
    cmdParams = JSON.parse(JSON.stringify(cmdParams)) // deep clone
    rewriteFrameIds(cmdParams, tabEntry.frameIdMap.announced, tabEntry.frameIdMap.real)
  }

  let result
  try {
    result = await chrome.debugger.sendCommand(debuggerSession, method, cmdParams)
  } catch (err) {
    // Auto-retry with fresh frame ID if Chrome says "No frame for given id found".
    // This handles cases where: (a) eager probe failed/was stale, (b) page navigated
    // since probe, (c) frameIdMap wasn't set in time. Re-probes Page.getFrameTree,
    // updates frameIdMap, and retries the command with the correct frame ID.
    const errMsg = err?.message || String(err)
    if (errMsg.includes('No frame for given id') && cmdParams?.frameId) {
      try {
        const tree = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Page.getFrameTree'))
        const freshRealId = tree?.frameTree?.frame?.id
        if (freshRealId && freshRealId !== cmdParams.frameId) {
          console.log(`Tab ${tabId}: frame ID stale for ${method}, reprobing: ${cmdParams.frameId} → ${freshRealId}`)
          tabEntry = tabs.get(tabId)
          if (tabEntry) {
            tabEntry.frameIdMap = { real: freshRealId, announced: tabEntry.targetId }
            tabs.set(tabId, tabEntry)
          }
          const retryParams = { ...cmdParams, frameId: freshRealId }
          result = await chrome.debugger.sendCommand(debuggerSession, method, retryParams)
        } else {
          throw err // same frame ID or no tree — can't recover
        }
      } catch (retryErr) {
        if (retryErr === err) throw err
        throw new Error(`${method} retry failed: ${retryErr?.message || retryErr} (original: ${errMsg})`)
      }
    } else {
      throw err
    }
  }

  // Lazy frame ID mismatch detection: when Page.getFrameTree response arrives,
  // check if Chrome's main frame.id matches our announced targetId.
  // If not, set up bidirectional rewriting for all future commands/events.
  if (method === 'Page.getFrameTree' && result?.frameTree?.frame?.id) {
    const chromeFrameId = result.frameTree.frame.id
    tabEntry = tabs.get(tabId) // refresh
    if (tabEntry && chromeFrameId !== tabEntry.targetId) {
      if (!tabEntry.frameIdMap || tabEntry.frameIdMap.real !== chromeFrameId) {
        console.log(`Tab ${tabId}: frame ID mismatch: targetId=${tabEntry.targetId}, frameId=${chromeFrameId}. Enabling rewrite.`)
        tabEntry.frameIdMap = { real: chromeFrameId, announced: tabEntry.targetId }
        tabs.set(tabId, tabEntry)
      }
    }
  }

  // Rewrite frame IDs in response: real → announced for Playwright
  tabEntry = tabs.get(tabId) // refresh after potential frameIdMap update
  if (tabEntry?.frameIdMap && result && typeof result === 'object') {
    const clonedResult = JSON.parse(JSON.stringify(result))
    rewriteFrameIds(clonedResult, tabEntry.frameIdMap.real, tabEntry.frameIdMap.announced)
    return clonedResult
  }

  return result
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

  // Rewrite frame IDs if this tab has a frame ID mismatch
  let fwdParams = params
  if (tab.frameIdMap && fwdParams) {
    fwdParams = JSON.parse(JSON.stringify(fwdParams)) // deep clone
    rewriteFrameIds(fwdParams, tab.frameIdMap.real, tab.frameIdMap.announced)
  }

  try { sendToRelay({ method: 'forwardCDPEvent', params: { sessionId: source.sessionId || tab.sessionId, method, params: fwdParams } }) } catch { /* */ }
}

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId; if (!tabId) return
  clearIdleDetachTimer(tabId)
  const tab = tabs.get(tabId); if (!tab || tab.state !== 'connected') return

  // If user clicked "Cancel" on the debugger bar, mark as user-dismissed.
  // This prevents re-attachment until a NEW agent CDP command explicitly targets this tab.
  if (reason === 'canceled_by_user') {
    userDismissedTabs.add(tabId)
    console.log(`Tab ${tabId}: user dismissed debugger bar — blocking re-attach until agent command`)
  }

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
  reattachPending.delete(tabId); clearIdleDetachTimer(tabId); userDismissedTabs.delete(tabId); if (!tabs.has(tabId)) return
  const tab = tabs.get(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId); tabs.delete(tabId)
  for (const [cid, pid] of childSessionToTab.entries()) { if (pid === tabId) childSessionToTab.delete(cid) }
  if (tab?.sessionId && tab?.targetId) { try { sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.detachedFromTarget', params: { sessionId: tab.sessionId, targetId: tab.targetId, reason: 'tab_closed' } } }) } catch { /* */ } }
  void persistState()
}))

// Auto-announce new tabs to the relay so they appear in /json/list (tab listing).
// announceTab() only sets state='announced' (no debugger attach, no yellow bar).
// The debugger is only attached lazily when the agent sends a CDP command to the tab.
chrome.tabs.onCreated.addListener((tab) => void whenReady(async () => {
  if (!tab.id || tabs.has(tab.id)) return
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return
  // Wait briefly for the tab URL to settle (new tabs start as about:blank)
  await new Promise((r) => setTimeout(r, 500))
  try {
    const tabInfo = await chrome.tabs.get(tab.id)
    if (!isAttachableUrl(tabInfo.url)) return
    await announceTab(tab.id)
  } catch { /* tab may have been closed already */ }
}))

// Update tab info on navigation complete — also announce previously-unknown tabs
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => void whenReady(async () => {
  if (changeInfo.status !== 'complete') return

  // Announce tabs we don't know about yet (opened before relay connect, or missed by onCreated)
  if (!tabs.has(tabId)) {
    if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return
    if (!isAttachableUrl(tab.url)) return
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

  // Navigation complete — clear stale frameIdMap so it's re-probed on next attach.
  // The targetId stays STABLE (our UUID never changes). Only the frame ID rewriting
  // needs to be updated, which happens automatically in ensureDebuggerAttached.
  if (tab.frameIdMap) {
    tabs.set(tabId, { ...tab, frameIdMap: undefined })
  }

  // Update title/url in relay (targetId stays the same)
  if (relayWs?.readyState === WebSocket.OPEN && tab.sessionId && tab.targetId) {
    try {
      const tabInfo = await chrome.tabs.get(tabId)
      const isActive = tabId === activeTabId
      const title = isActive ? `[ACTIVE] ${tabInfo.title || ''}` : tabInfo.title || ''
      sendToRelay({ method: 'forwardCDPEvent', params: { method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: tab.targetId, type: 'page', title, url: tabInfo.url || '', attached: true } } } })
    } catch { /* */ }
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
    // Re-announce tracked tabs + discover any new tabs missed by onCreated/onUpdated
    await announceAllTabs()
    await discoverAndAnnounceNewTabs()
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
      await discoverAndAnnounceNewTabs() // only on initial connect — not keepalive
    } catch { scheduleReconnect() }
  }
})

async function whenReady(fn) { await initPromise; return fn() }
