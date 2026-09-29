import { app, BrowserWindow, nativeTheme, shell } from 'electron'
import { appFile } from './core/app-dir'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { emit, registerIpc } from './core/ipc'
import { log } from './core/logger'
import { db } from './core/db'
import { applyTracingEnv, getSettings, setSettings } from './core/settings'
import { providers } from './models/registry'
import { runAgentEval, runMemoryEval } from './dev/evals'
import { registerHandlers } from './handlers'
import { browser } from './browser/browser-service'
import { plugins } from './plugins/plugin-service'
import { recorder } from './recorder/recorder-service'
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
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
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
  // scripts/memory-eval.mjs: automatic-learning dry runs with the real keychain, then quit
  if (process.env.NAVO_MEMORY_EVAL) return runMemoryEval(process.env.NAVO_MEMORY_EVAL)
  memory.ensureDefaults()
  // people who already configured a model before onboarding existed shouldn't be walked through it
  if (!getSettings().onboarded && providers.list().length) setSettings({ onboarded: true })
  applyTracingEnv()
  const theme = getSettings().theme
  nativeTheme.themeSource = theme
  log.setSink((line) => emit('dev.log', line))

  registerIpc()
  registerHandlers()

  const win = createWindow()
  browser.init(win)
  sessions.init()
  browser.onDownload((d) => (d.state !== 'progressing' || d.received === 0 ? emit('browser.download', d) : undefined))
  plugins.init()
  recorder.init()
  tasks.init()
  files.init()

  // network-bound startup work shouldn't block the window
  void mcp.connectAll()
  void connectors.startAll()
  void navoMcpServer.apply()
  // scripts/agent-eval.mjs: browser tasks against the real model, then quit
  if (process.env.NAVO_AGENT_EVAL) void runAgentEval(process.env.NAVO_AGENT_EVAL)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) browser.init(createWindow())
  })
})

app.on('before-quit', () => {
  agent.shutdown()
  files.shutdown()
  tasks.stopAll()
  void mcp.closeAll()
  void connectors.closeAll()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
