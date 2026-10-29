import { BrowserWindow, screen } from 'electron'
import { t } from '@shared/i18n'

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** A separate, non-focusing window keeps Stop reachable while another app is foreground. */
export class DesktopOverlay {
  private win: BrowserWindow | null = null
  private label = ''
  constructor(private readonly stop: () => void) {}

  show(appName: string): void {
    if (this.win && !this.win.isDestroyed() && this.label === appName) return
    this.hide()
    this.label = appName
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const win = new BrowserWindow({
      x: Math.round(area.x + (area.width - 460) / 2),
      y: area.y + 12,
      width: 460,
      height: 44,
      show: false,
      frame: false,
      transparent: true,
      focusable: false,
      resizable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
    })
    this.win = win
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('will-navigate', (event, url) => {
      event.preventDefault()
      if (url === 'navo-desktop://stop') this.stop()
    })
    const label = escape(t('Navo 正在操作 {{app}}', { app: appName }))
    const stop = escape(t('按 Esc 或点击停止'))
    void win
      .loadURL(
        `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>body{margin:0;font:13px system-ui}a{height:44px;box-sizing:border-box;display:flex;align-items:center;justify-content:space-between;gap:16px;padding:0 16px;border-radius:12px;background:#18211f;color:#fff;text-decoration:none;border:1px solid #49665b}span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}b{white-space:nowrap;color:#ffc7b7;font-weight:500}</style><a href="navo-desktop://stop"><span>${label}</span><b>${stop}</b></a>`)}`,
      )
      .then(() => {
        if (this.win === win && !win.isDestroyed()) win.showInactive()
      })
      .catch(() => undefined)
  }

  hide(): void {
    this.win?.destroy()
    this.win = null
    this.label = ''
  }
}
