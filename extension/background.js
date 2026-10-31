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
const attached = new Set()

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

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
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
      ws.onmessage = (e) => void onMessage(e.data)
      ws.onclose = onClose
      setState(found.paired ? 'linked' : 'offline')
      return
    }
    retryTimer = setTimeout(connect, backoff)
    backoff = Math.min(backoff * 2, MAX_BACKOFF)
  } finally {
    connecting = false
  }
}

function onClose() {
  ws = null
  for (const tabId of attached) chrome.action.setBadgeText({ tabId, text: '' })
  attached.clear()
  setState('offline')
  retryTimer = setTimeout(connect, backoff)
}

async function onMessage(raw) {
  let msg
  try {
    msg = JSON.parse(raw)
  } catch {
    return
  }
  switch (msg.t) {
    case 'ping':
      return send({ t: 'pong' })
    case 'pair':
      return setState('pairing', msg.code)
    case 'paired':
      await chrome.storage.local.set({ token: msg.token })
      return setState('linked')
    case 'busy':
      // another browser is already linked to Navo
      return ws?.close()
    case 'req':
      try {
        send({ t: 'res', id: msg.id, ok: true, result: (await handle(msg.method, msg.params ?? {})) ?? null })
      } catch (err) {
        send({ t: 'res', id: msg.id, ok: false, error: String(err?.message ?? err) })
      }
  }
}

const info = (tab) => ({ tabId: tab.id, url: tab.url ?? tab.pendingUrl ?? '', title: tab.title ?? '', active: !!tab.active })

async function handle(method, p) {
  switch (method) {
    case 'tabs.list': {
      const handed = await handedTabs()
      return (await chrome.tabs.query({})).filter((t) => t.id != null).map((t) => ({ ...info(t), handed: handed.includes(t.id) }))
    }
    case 'tabs.create': {
      const tab = await chrome.tabs.create({ url: p.url || 'about:blank', active: true })
      return info(tab)
    }
    case 'tabs.close':
      return chrome.tabs.remove(p.tabId)
    case 'tabs.activate': {
      const tab = await chrome.tabs.update(p.tabId, { active: true })
      if (tab?.windowId != null) await chrome.windows.update(tab.windowId, { focused: true })
      return null
    }
    case 'debugger.attach':
      if (attached.has(p.tabId)) return null
      await chrome.debugger.attach({ tabId: p.tabId }, '1.3')
      attached.add(p.tabId)
      chrome.action.setBadgeText({ tabId: p.tabId, text: 'AI' })
      return null
    case 'debugger.detach':
      if (!attached.has(p.tabId)) return null
      attached.delete(p.tabId)
      chrome.action.setBadgeText({ tabId: p.tabId, text: '' })
      await chrome.debugger.detach({ tabId: p.tabId }).catch(() => undefined)
      return null
    case 'cdp.send':
      return chrome.debugger.sendCommand({ tabId: p.tabId }, p.method, p.params ?? {})
    case 'ext.reload':
      setTimeout(() => chrome.runtime.reload(), 100)
      return null
    default:
      throw new Error(`unknown method ${method}`)
  }
}

const event = (name, payload) => send({ t: 'evt', name, payload })

chrome.debugger.onEvent.addListener((src, method, params) => {
  if (src.tabId != null) event('cdp', { tabId: src.tabId, method, params: params ?? {} })
})
chrome.debugger.onDetach.addListener((src, reason) => {
  if (src.tabId == null) return
  attached.delete(src.tabId)
  chrome.action.setBadgeText({ tabId: src.tabId, text: '' })
  event('detached', { tabId: src.tabId, reason })
})
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId)
  void forgetHanded(tabId)
  event('tabRemoved', { tabId })
})
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.url != null || change.title != null) event('tabUpdated', { tabId, url: tab.url ?? '', title: tab.title ?? '' })
})

async function handedTabs() {
  const { handed = [] } = await chrome.storage.session.get('handed')
  return handed
}
async function forgetHanded(tabId) {
  const handed = await handedTabs()
  if (handed.includes(tabId)) await chrome.storage.session.set({ handed: handed.filter((id) => id !== tabId) })
}

// the popup: connection state and handing the current tab to Navo
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  void (async () => {
    if (msg.t === 'status') {
      const handed = await handedTabs()
      return reply({ state, pairingCode, browser: browserName(), handed })
    }
    if (msg.t === 'handover' || msg.t === 'revoke') {
      const tab = await chrome.tabs.get(msg.tabId)
      const handed = (await handedTabs()).filter((id) => id !== tab.id)
      if (msg.t === 'handover') handed.push(tab.id)
      await chrome.storage.session.set({ handed })
      event(msg.t, info(tab))
      return reply({ ok: true })
    }
    reply(null)
  })()
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
