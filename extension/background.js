// Navo browser extension: a thin relay between Navo (a local WebSocket on 127.0.0.1) and the tabs
// of this browser. Navo does the agent work; this only lists/opens tabs and forwards CDP over
// chrome.debugger. Wire protocol: docs/superpowers/plans/2026-10-29-computer-use.md (Task 2).

const PORTS = Array.from({ length: 10 }, (_, i) => 38810 + i)
const MAX_BACKOFF = 10000

let ws = null
let connecting = false
let backoff = 1000
let retryTimer = null
/** what the popup shows: 'offline' | 'pairing' | 'linked' */
let state = 'offline'
let pairingCode = null
const attached = new Map()
const tabOperations = new Map()
const revoked = new Set()
const tabVersions = new Map()
let authorizationVersion = 0
let authorizationUpdate = Promise.resolve()
function updateAuthorization(action) {
  authorizationUpdate = authorizationUpdate.catch(() => undefined).then(action)
  return authorizationUpdate
}

function addOwned(tabId, creationVersion) {
  const valid = () => !revoked.has(tabId) && (tabVersions.get(tabId) ?? 0) <= creationVersion
  return updateAuthorization(async () => {
    if (!valid()) return false
    const { owned = [] } = await chrome.storage.session.get('owned')
    if (!valid()) return false
    await chrome.storage.session.set({ owned: [...new Set([...owned, tabId])] })
    // A concurrent revoke is already queued to remove the stored authorization.
    return valid()
  })
}

function nextTabVersion(tabId) {
  const version = ++authorizationVersion
  tabVersions.set(tabId, version)
  return version
}

/** Deny locally before any async work, including an older popup handover. */
function revokeTab(tabId) {
  nextTabVersion(tabId)
  revoked.add(tabId)
  event('revoke', { tabId })
  void withTab(tabId, () => detach(tabId))
  return updateAuthorization(async () => {
    const { handed = [], owned = [] } = await chrome.storage.session.get(['handed', 'owned'])
    await chrome.storage.session.set({
      handed: handed.filter((id) => id !== tabId),
      owned: owned.filter((id) => id !== tabId),
    })
  })
}

function current(sock) {
  return sock === ws && sock?.readyState === WebSocket.OPEN
}

function assertCurrent(sock) {
  if (!current(sock) || state !== 'linked') throw new Error('Browser connection is no longer authorized')
}

async function assertTab(sock, tabId) {
  assertCurrent(sock)
  const handed = await handedTabs()
  const { owned = [] } = await chrome.storage.session.get('owned')
  assertCurrent(sock)
  if (revoked.has(tabId) || (!owned.includes(tabId) && !handed.includes(tabId))) {
    throw new Error('Tab is no longer handed to Navo')
  }
}

function withTab(tabId, action) {
  const pending = (tabOperations.get(tabId) ?? Promise.resolve()).catch(() => undefined).then(action)
  tabOperations.set(tabId, pending)
  void pending
    .finally(() => {
      if (tabOperations.get(tabId) === pending) tabOperations.delete(tabId)
    })
    .catch(() => undefined)
  return pending
}

async function detach(tabId) {
  if (!attached.has(tabId)) return
  attached.delete(tabId)
  chrome.action.setBadgeText({ tabId, text: '' })
  await chrome.debugger.detach({ tabId }).catch(() => undefined)
}

function browserName() {
  const brands = navigator.userAgentData?.brands ?? []
  const own = brands.find((b) => !/Chromium|Not/i.test(b.brand))
  return own?.brand ?? 'Chromium'
}

function setState(next, code = null) {
  state = next
  pairingCode = code
  chrome.action.setBadgeText({ text: next === 'pairing' ? '?' : '' })
  chrome.runtime.sendMessage({ t: 'state' }).catch(() => undefined)
}

function send(msg, sock = ws) {
  if (current(sock)) sock.send(JSON.stringify(msg))
}

/** Opens a socket on one port and resolves once Navo has said who it is. */
function tryPort(port) {
  return new Promise((resolve) => {
    let sock
    try {
      sock = new WebSocket(`ws://127.0.0.1:${port}`)
    } catch {
      return resolve(null)
    }
    const fail = () => {
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        /* already closed */
      }
      resolve(null)
    }
    const timer = setTimeout(fail, 1500)
    sock.onerror = fail
    sock.onmessage = (e) => {
      let msg
      try {
        msg = JSON.parse(e.data)
      } catch {
        return fail()
      }
      if (msg.t !== 'welcome' || msg.app !== 'navo') return fail()
      clearTimeout(timer)
      sock.onerror = null
      sock.onmessage = null
      resolve({ sock, paired: !!msg.paired })
    }
    sock.onopen = async () => {
      const { token = null } = await chrome.storage.local.get('token')
      if (sock.readyState !== WebSocket.OPEN) return
      sock.send(JSON.stringify({ t: 'hello', version: chrome.runtime.getManifest().version, browser: browserName(), token }))
    }
  })
}

async function connect() {
  if (connecting || (ws && ws.readyState === WebSocket.OPEN)) return
  connecting = true
  clearTimeout(retryTimer)
  try {
    for (const port of PORTS) {
      const found = await tryPort(port)
      if (!found) continue
      ws = found.sock
      backoff = 1000
      ws.onmessage = (e) => void onMessage(e.data, found.sock)
      ws.onclose = () => onClose(found.sock)
      setState(found.paired ? 'linked' : 'offline')
      return
    }
    retryTimer = setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF)
  } finally {
    connecting = false
  }
}

function onClose(sock) {
  if (ws !== sock) return
  ws = null
  // Queue cleanup behind pending attaches, before any attach from a new connection.
  for (const tabId of new Set([...attached.keys(), ...tabOperations.keys()])) {
    void withTab(tabId, () => detach(tabId))
  }
  setState('offline')
  retryTimer = setTimeout(connect, backoff)
}

async function onMessage(raw, sock) {
  if (!current(sock)) return
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  switch (msg.t) {
    case 'ping':
      return send({ t: 'pong' }, sock)
    case 'pair':
      return setState('pairing', msg.code)
    case 'paired':
      await chrome.storage.local.set({ token: msg.token })
      if (current(sock)) setState('linked')
      return
    case 'busy':
      // another browser is already linked to Navo
      return sock.close()
    case 'req':
      try {
        send({ t: 'res', id: msg.id, ok: true, result: (await handle(msg.method, msg.params ?? {}, sock)) ?? null }, sock)
      } catch (err) {
        send({ t: 'res', id: msg.id, ok: false, error: String(err?.message ?? err) }, sock)
      }
  }
}

const info = (tab) => ({ tabId: tab.id, url: tab.url ?? tab.pendingUrl ?? '', title: tab.title ?? '', active: !!tab.active })

async function handle(method, p, sock) {
  assertCurrent(sock)
  if (['tabs.close', 'tabs.activate', 'debugger.attach', 'debugger.detach', 'cdp.send'].includes(method)) {
    const version = tabVersions.get(p.tabId) ?? 0
    const check = async () => {
      await assertTab(sock, p.tabId)
      if ((tabVersions.get(p.tabId) ?? 0) !== version) throw new Error('Tab authorization changed')
    }
    const result = await withTab(p.tabId, async () => {
      await check()
      switch (method) {
        case 'tabs.close':
          return chrome.tabs.remove(p.tabId)
        case 'tabs.activate': {
          const tab = await chrome.tabs.update(p.tabId, { active: true })
          await check()
          if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true })
          return null
        }
        case 'debugger.attach':
          if (attached.get(p.tabId) === sock) return null
          await detach(p.tabId)
          await check()
          await chrome.debugger.attach({ tabId: p.tabId }, '1.3')
          attached.set(p.tabId, sock)
          try {
            await check()
          } catch (error) {
            await detach(p.tabId)
            throw error
          }
          chrome.action.setBadgeText({ tabId: p.tabId, text: 'AI' })
          return null
        case 'debugger.detach':
          await detach(p.tabId)
          return null
        case 'cdp.send':
          if (attached.get(p.tabId) !== sock) throw new Error('Tab debugger is not attached')
          // Release the attach/authorization queue after dispatch. A CDP command may
          // wait for navigation indefinitely; it must not prevent user revocation.
          return { command: chrome.debugger.sendCommand({ tabId: p.tabId }, p.method, p.params ?? {}) }
      }
    })
    return result?.command ? await result.command : result
  }
  switch (method) {
    case 'tabs.list': {
      const handed = await handedTabs()
      assertCurrent(sock)
      return (await chrome.tabs.query({})).filter((t) => t.id != null).map((t) => ({ ...info(t), handed: !revoked.has(t.id) && handed.includes(t.id) }))
    }
    case 'tabs.create': {
      const creationVersion = authorizationVersion
      const tab = await chrome.tabs.create({ url: p.url || 'about:blank', active: true })
      if (tab.id != null && !(await addOwned(tab.id, creationVersion))) throw new Error('Tab authorization changed')
      return info(tab)
    }
    case 'ext.reload':
      setTimeout(() => {
        if (current(sock)) chrome.runtime.reload()
      }, 100)
      return null
    default:
      throw new Error(`unknown method ${method}`)
  }
}

const event = (name, payload) => send({ t: 'evt', name, payload })

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (src.tabId != null && attached.has(src.tabId))
    send({ t: 'evt', name: 'cdp', payload: { tabId: src.tabId, method, params: params ?? {} } }, attached.get(src.tabId))
})
chrome.debugger.onDetach.addListener((src, reason) => {
  if (src.tabId == null) return
  const owner = attached.get(src.tabId)
  attached.delete(src.tabId)
  chrome.action.setBadgeText({ tabId: src.tabId, text: '' })
  if (reason === 'canceled_by_user') void revokeTab(src.tabId).catch(() => undefined)
  if (owner) send({ t: 'evt', name: 'detached', payload: { tabId: src.tabId, reason } }, owner)
})
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId)
  void revokeTab(tabId).catch(() => undefined)
  event('tabRemoved', { tabId })
})
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url != null || change.title != null) event('tabUpdated', { tabId, url: tab.url ?? '', title: tab.title ?? '' })
})

async function handedTabs() {
  const { handed = [] } = await chrome.storage.session.get('handed')
  return handed
}
// the popup: connection state and handing the current tab to Navo
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  void (async () => {
    if (msg.t === 'status') {
      const handed = await handedTabs()
      return reply({ state, pairingCode, browser: browserName(), handed })
    }
    if (msg.t === 'revoke') {
      await revokeTab(msg.tabId)
      return reply({ ok: true })
    }
    if (msg.t === 'handover') {
      const version = nextTabVersion(msg.tabId)
      const valid = () => tabVersions.get(msg.tabId) === version
      const tab = await chrome.tabs.get(msg.tabId)
      if (!valid()) return reply({ ok: false, error: 'Tab authorization changed' })
      const saved = await updateAuthorization(async () => {
        if (!valid()) return false
        const handed = (await handedTabs()).filter((id) => id !== tab.id)
        if (!valid()) return false
        handed.push(tab.id)
        await chrome.storage.session.set({ handed })
        if (!valid()) return false
        revoked.delete(tab.id)
        event('handover', info(tab))
        return true
      })
      return reply(saved ? { ok: true } : { ok: false, error: 'Tab authorization changed' })
    }
    reply(null)
  })().catch((error) => reply({ ok: false, error: String(error?.message ?? error) }))
  return true
})

chrome.runtime.onStartup.addListener(connect)
chrome.runtime.onInstalled.addListener(connect)
// the service worker may be stopped while Navo isn't running; wake up every minute to look for it
chrome.alarms.create('navo-connect', { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === 'navo-connect') void connect()
})
void connect()
