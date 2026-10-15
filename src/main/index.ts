import { app, BrowserWindow, nativeTheme, session, shell } from 'electron'
import { appFile } from './core/app-dir'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { emit, registerIpc } from './core/ipc'
import { log } from './core/logger'
import { db } from './core/db'
import { applyTracingEnv, getSettings, onLanguageChange, setSettings } from './core/settings'
import { applyLanguage } from './core/language'
import { providers } from './models/registry'
import { runAgentEval, runFlowEval, runMemoryEval, runMonitorEval, runSkillEval } from './dev/evals'
import { registerHandlers } from './handlers'
import { browser } from './browser/browser-service'
import { plugins } from './plugins/plugin-service'
import { recorder } from './recorder/recorder-service'
import { learning } from './learning'
import { quick } from './quick/quick-service'
import { outputs } from './outputs/outputs-service'
import { memory } from './memory/memory-service'
import { mcp } from './mcp/mcp-service'
import { connectors } from './connectors/connector-service'
import { tasks } from './tasks/task-service'
import { navoMcpServer } from './mcp-server/navo-mcp-server'
import { files } from './files/file-service'
import { agent } from './agent/agent-service'
import { sessions } from './browser/agent-session'

// isolated profile for tests / multiple instances
if (process.env.AB_USER_DATA) app.setPath('userData', process.env.AB_USER_DATA)
if (process.env.AB_DOWNLOADS) app.setPath('downloads', process.env.AB_DOWNLOADS)

// One instance per profile: two processes would share the SQLite database, checkpoints and browser storage.
const primaryInstance = app.requestSingleInstanceLock()
if (!primaryInstance) app.quit()
/** The main window (not the quick window, which also loads the renderer). */
let mainWin: BrowserWindow | null = null
/** set while quitting, so closing the main window then really closes it */
let quitting = false

app.on('second-instance', () => {
  const win = mainWin
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

function createWindow(): BrowserWindow {
  const dark = nativeTheme.shouldUseDarkColors
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 960,
    minHeight: 680,
    show: false,
    title: 'Navo',
    icon: appFile('resources/icon.png'),
    backgroundColor: dark ? '#0B1220' : '#F6F7F9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: appFile('out/preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  // with "keep in the menu bar", closing the window hides it: shortcuts and running tasks keep going
  win.on('close', (e) => {
    if (!quitting && getSettings().quick.keepInTray) {
      e.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    if (mainWin === win) mainWin = null
  })
  mainWin = win
  // links in the app UI (e.g. in agent replies) open as tabs in the built-in browser panel
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      browser.newTab(url)
      browser.reveal(true) // the user clicked a link: show the panel itself
    } else if (/^(mailto|tel):/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  if (is.dev && process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(appFile('out/renderer/index.html'))
  return win
}

app.whenReady().then(async () => {
  if (!primaryInstance) return
  electronApp.setAppUserModelId('com.navo.app')
  // packaged builds get the icon from electron-builder; in dev set the dock icon explicitly
  if (process.platform === 'darwin' && is.dev) app.dock?.setIcon(appFile('resources/icon.png'))
  app.on('browser-window-created', (_, w) => optimizer.watchWindowShortcuts(w))

  db()
  applyLanguage()
  onLanguageChange(() => {
    applyLanguage()
    quick.apply()
  })
  // scripts/memory-eval.mjs: automatic-learning dry runs with the real keychain, then quit
  if (process.env.NAVO_MEMORY_EVAL) return runMemoryEval(process.env.NAVO_MEMORY_EVAL)
  if (process.env.NAVO_SKILL_EVAL) return runSkillEval(process.env.NAVO_SKILL_EVAL)
  if (process.env.NAVO_MONITOR_EVAL) return runMonitorEval(process.env.NAVO_MONITOR_EVAL)
  memory.ensureDefaults()
  // people who already configured a model before onboarding existed shouldn't be walked through it
  if (!getSettings().onboarded && providers.list().length) setSettings({ onboarded: true })
  applyTracingEnv()
  const theme = getSettings().theme
  nativeTheme.themeSource = theme
  log.setSink((line) => emit('dev.log', line))

  registerIpc()
  registerHandlers()
  // Navo's own windows (the browser tabs have their own session): the microphone for voice input, audio only
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
    const url = wc.getURL()
    const own = url.startsWith('file://') || (!!process.env.ELECTRON_RENDERER_URL && url.startsWith(process.env.ELECTRON_RENDERER_URL))
    if (!own) return cb(false)
    if (permission === 'media') return cb(((details as { mediaTypes?: string[] }).mediaTypes ?? ['audio']).every((t) => t === 'audio'))
    cb(true)
  })

  const win = createWindow()
  browser.init(win)
  sessions.init()
  browser.onDownload((d) => (d.state !== 'progressing' || d.received === 0 ? emit('browser.download', d) : undefined))
  // a file downloaded in a conversation's tab is one of its outputs
  browser.onDownload((d) => outputs.onDownload(d, d.tabId != null ? sessions.threadOfTab(d.tabId) : null))
  plugins.init()
  recorder.init()
  tasks.init()
  files.init()

  // network-bound startup work shouldn't block the window
  void mcp.connectAll()
  void connectors.startAll()
  void navoMcpServer.apply()
  // turns that were still waiting to be learned from when the app last quit
  learning.resume()
  // scripts/agent-eval.mjs: browser tasks against the real model, then quit
  if (process.env.NAVO_AGENT_EVAL) void runAgentEval(process.env.NAVO_AGENT_EVAL)
  // scripts/flow-eval.mjs: fixed flows (learn once, replay, repair) against the real model
  if (process.env.NAVO_FLOW_EVAL) void runFlowEval(process.env.NAVO_FLOW_EVAL)

  // global shortcuts, quick window, menu bar
  quick.init(() => mainWin)

  app.on('activate', () => {
    if (mainWin) mainWin.show()
    else browser.init(createWindow())
  })
})

app.on('before-quit', () => {
  quitting = true
  quick.shutdown()
  agent.shutdown()
  files.shutdown()
  tasks.stopAll()
  void mcp.closeAll()
  void connectors.closeAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
