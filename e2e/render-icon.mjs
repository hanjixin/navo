// Renders resources/app-icon.svg to build/icon.png (1024x1024) for electron-builder.
import { _electron as electron } from 'playwright'
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const svg = readFileSync('resources/app-icon.svg', 'utf8')
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: mkdtempSync(join(tmpdir(), 'ab-icon-')) } })
const png = await app.evaluate(async ({ BrowserWindow }, svg) => {
  const w = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    webPreferences: { offscreen: true },
  })
  await w.loadURL(
    'data:text/html,' +
      encodeURIComponent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', '<svg width="1024" height="1024" ')}</body></html>`),
  )
  await new Promise((r) => setTimeout(r, 300))
  const img = await w.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  return img.resize({ width: 1024, height: 1024 }).toPNG().toString('base64')
}, svg)
writeFileSync('build/icon.png', Buffer.from(png, 'base64'))
writeFileSync('resources/icon.png', Buffer.from(png, 'base64'))
console.log('wrote build/icon.png')
await app.close()
