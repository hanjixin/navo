import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { is } from '@electron-toolkit/utils'
import { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, Menu, nativeImage, screen, Tray } from 'electron'
import { isValidAccelerator } from '@shared/accelerator'
import type { QuickStatus } from '@shared/types'
import { agent } from '../agent/agent-service'
import { appFile } from '../core/app-dir'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { getSettings } from '../core/settings'
import { files } from '../files/file-service'
import { language, t } from '@shared/i18n'

/** How recent a clipboard change must be for the quick window to offer it. */
const CLIPBOARD_FRESH_MS = 60_000

/**
 * Navo from anywhere: a global shortcut opens a small always-on-top window to ask a question
 * (optionally about what was just copied, or about a region of the screen), and a menu-bar icon
 * shows what is running. Closing the main window can leave Navo in the menu bar.
 */
class QuickService {
  private win: BrowserWindow | null = null
  private tray: Tray | null = null
  private main: () => BrowserWindow | null = () => null
  private status: QuickStatus = { registered: [], failed: [] }
  private clip = { text: '', changedAt: 0, offered: '' }
  private timer: NodeJS.Timeout | null = null

  init(main: () => BrowserWindow | null): void {
    this.main = main
    void Promise.resolve(clipboard.readText()).then((t) => (this.clip.text = t))
    this.apply()
    // cheap: one clipboard read every 2s, to know whether its content is fresh
    this.timer = setInterval(() => {
      void Promise.resolve(clipboard.readText()).then((t) => {
        if (t !== this.clip.text) this.clip = { ...this.clip, text: t, changedAt: Date.now() }
      })
      this.refreshTray()
    }, 2000)
  }

  /** (Re)registers the shortcuts and the menu-bar icon from the settings. */
  apply(): QuickStatus {
    const cfg = getSettings().quick
    globalShortcut.unregisterAll()
    const registered: string[] = []
    const failed: string[] = []
    if (cfg.enabled) {
      for (const [accel, fn] of [
        [cfg.shortcut, () => this.toggle()],
        [cfg.screenshotShortcut, () => void this.screenshotAsk()],
      ] as const) {
        if (!accel) continue
        if (!isValidAccelerator(accel)) {
          failed.push(accel)
          continue
        }
        try {
          if (globalShortcut.register(accel, fn)) registered.push(accel)
          else failed.push(accel) // taken by another app
        } catch {
          failed.push(accel) // not a valid accelerator
        }
      }
    }
    if (cfg.keepInTray && !this.tray) this.createTray()
    if (!cfg.keepInTray && this.tray) {
      this.tray.destroy()
      this.tray = null
    }
    this.status = { registered, failed }
    if (failed.length) log.warn(`[quick] shortcuts not registered: ${failed.join(', ')}`)
    emit('quick.status', this.status)
    return this.status
  }

  getStatus(): QuickStatus {
    return this.status
  }

  // ---------- the quick window

  private window(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win
    const win = new BrowserWindow({
      width: 680,
      height: 480,
      show: false,
      frame: false,
      resizable: true,
      minWidth: 480,
      minHeight: 220,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      transparent: true,
      vibrancy: process.platform === 'darwin' ? 'popover' : undefined,
      visualEffectState: 'active',
      roundedCorners: true,
      title: t('Navo 快问'),
      webPreferences: { preload: appFile('out/preload/index.cjs'), sandbox: true, contextIsolation: true },
    })
    // over full-screen apps and on every desktop, like Spotlight
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.setAlwaysOnTop(true, 'floating')
    win.on('blur', () => {
      // clicking elsewhere puts it away (not while dev tools are open)
      if (!win.webContents.isDevToolsOpened()) win.hide()
    })
    if (is.dev && process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/quick`)
    else void win.loadFile(appFile('out/renderer/index.html'), { hash: '/quick' })
    this.win = win
    return win
  }

  /** Opens the quick window on the display the pointer is on, with what it may use as context. */
  async show(context: { fileIds?: string[] } = {}): Promise<void> {
    const win = this.window()
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const [w] = win.getSize()
    const { x, y, width, height } = display.workArea
    win.setPosition(Math.round(x + (width - w) / 2), Math.round(y + height * 0.18))
    if (win.webContents.isLoading()) await new Promise<void>((r) => win.webContents.once('did-finish-load', () => r()))
    // read it now as well: copying and pressing the shortcut right away beats the 2s sampling
    const now = await Promise.resolve(clipboard.readText())
    if (now !== this.clip.text) this.clip = { ...this.clip, text: now, changedAt: Date.now() }
    // offer the clipboard once per change, and only while it is fresh
    const fresh = this.clip.text.trim() && Date.now() - this.clip.changedAt < CLIPBOARD_FRESH_MS && this.clip.offered !== this.clip.text
    if (fresh) this.clip.offered = this.clip.text
    win.webContents.send('evt:quick.opened', { clipboard: fresh ? this.clip.text.slice(0, 20_000) : null, fileIds: context.fileIds ?? [] })
    win.show()
    win.focus()
  }

  hide(): void {
    this.win?.hide()
  }

  toggle(): void {
    if (this.win?.isVisible() && this.win.isFocused()) this.hide()
    else void this.show()
  }

  /** Lets the user pick a region of the screen and opens the quick window with it attached. */
  async screenshotAsk(): Promise<void> {
    this.hide()
    const dir = mkdtempSync(join(tmpdir(), 'navo-shot-'))
    const file = join(dir, `截图-${new Date().toLocaleTimeString('zh-CN', { hour12: false }).replace(/:/g, '')}.png`)
    try {
      if (process.platform === 'darwin') {
        // interactive region selection; Esc cancels (no file is written)
        await new Promise<void>((resolve) => execFile('/usr/sbin/screencapture', ['-i', '-x', '-t', 'png', file], () => resolve()))
      } else {
        const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
        const [source] = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: display.size.width * display.scaleFactor, height: display.size.height * display.scaleFactor },
        })
        if (source) writeFileSync(file, source.thumbnail.toPNG())
      }
      if (!existsSync(file) || statSync(file).size === 0) return // cancelled
      const [rec] = files.addPaths([file])
      await this.show({ fileIds: rec ? [rec.id] : [] })
    } catch (err) {
      log.warn(`[quick] screenshot failed: ${(err as Error).message}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** "Continue in Navo": the conversation opens in the main window. */
  openInMain(threadId: string | null): void {
    this.hide()
    const main = this.main()
    if (!main) return
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    if (threadId) main.webContents.send('evt:quick.openThread', threadId)
  }

  // ---------- menu bar

  private createTray(): void {
    const icon = nativeImage.createFromPath(appFile('resources/trayTemplate.png'))
    icon.setTemplateImage(true)
    this.tray = new Tray(icon)
    this.tray.setToolTip('Navo')
    this.refreshTray()
  }

  private trayKey = ''
  private refreshTray(): void {
    if (!this.tray) return
    const running = agent.listThreads().filter((t) => agent.isRunning(t.id))
    const cfg = getSettings().quick
    // rebuild only when something visible changed
    const key = `${running.map((t) => `${t.id}:${t.title}`).join('|')}#${cfg.shortcut}#${this.status.registered.join()}#${language()}`
    if (key === this.trayKey) return
    this.trayKey = key
    if (process.platform === 'darwin') this.tray.setTitle(running.length ? ` ${running.length}` : '')
    const shortcutLabel = this.status.registered.includes(cfg.shortcut)
      ? `（${cfg.shortcut.replace('Alt', '⌥').replace('Shift', '⇧').replace(/\+/g, '')}）`
      : ''
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t('快问{{v0}}', { v0: shortcutLabel }), click: () => void this.show() },
        { label: t('截图提问'), click: () => void this.screenshotAsk() },
        { type: 'separator' },
        ...(running.length
          ? [
              { label: t('正在运行（{{v0}}）', { v0: running.length }), enabled: false },
              ...running.slice(0, 8).map((t) => ({ label: `  ${t.title.slice(0, 32)}`, click: () => this.openInMain(t.id) })),
              { type: 'separator' as const },
            ]
          : []),
        { label: t('打开 Navo'), click: () => this.openInMain(null) },
        { type: 'separator' },
        { label: t('退出 Navo'), click: () => app.quit() },
      ]),
    )
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer)
    globalShortcut.unregisterAll()
    this.tray?.destroy()
    this.tray = null
  }
}

export const quick = new QuickService()
