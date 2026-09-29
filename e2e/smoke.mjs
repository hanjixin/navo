// Smoke test: launches the built app with an isolated profile, visits every page and saves window screenshots.
// Usage: pnpm build && node e2e/smoke.mjs [outDir]
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const out = process.argv[2] ?? join(tmpdir(), 'ab-shots')
mkdirSync(out, { recursive: true })
const userData = mkdtempSync(join(tmpdir(), 'ab-profile-'))

const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: userData } })
const page = await mainWindow(app)
const errors = []
page.on('pageerror', (e) => errors.push(e.message))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.waitForSelector('nav')

async function shot(name) {
  // capture from the main process so the native browser view is included
  const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
  writeFileSync(join(out, `${name}.png`), Buffer.from(png, 'base64'))
}

const theme = process.env.THEME
if (theme) await page.evaluate((t) => window.api.invoke('settings.set', { theme: t }), theme)

for (const route of ['chat', 'models', 'tasks', 'skills', 'connectors', 'mcp', 'memory', 'plugins', 'macros', 'settings']) {
  await page.evaluate((r) => (location.hash = `#/${r}`), route)
  await page.waitForTimeout(900)
  await shot(route)
}
console.log(JSON.stringify({ out, errors }, null, 2))
await app.close()
