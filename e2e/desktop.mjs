// Desktop settings, consent and tools through the native JSON transport, using --fake.
// The helper simulates TextEdit and permissions; no real desktop app receives input.
// Build first: pnpm build. macOS and Windows; no model or system permission prompt is needed.
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { checkDesktopHelper, desktopHelperPath } from './desktop-helper.mjs'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!['darwin', 'win32'].includes(process.platform)) {
  console.log('SKIP desktop: the native helper requires macOS or Windows')
  process.exit(0)
}
if (!existsSync(desktopHelperPath())) throw new Error('Build the desktop helper before running e2e/desktop.mjs')
const ok = (condition, message) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${message}`)
  if (!condition) process.exitCode = 1
}
const waitFor = async (fn, ms = 10000) => {
  const until = Date.now() + ms
  do {
    const value = await fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 100))
  } while (Date.now() < until)
  throw new Error('Timed out waiting for desktop state')
}
await checkDesktopHelper()
const profile = mkdtempSync(join(tmpdir(), 'navo-desktop-e2e-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile, NAVO_DESKTOP_FAKE: '1' } })
const page = await mainWindow(app)
const api = (method, ...args) => page.evaluate(([m, a]) => window.api.invoke(m, ...a), [method, args])
const tool = async (name, args = {}) => {
  let timer
  try {
    return await Promise.race([
      api('dev.invokeTool', name, args).catch((error) => `ERROR ${error.message ?? error}`),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not complete`)), 15000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
const consent = page.getByTestId('desktop-consent')
const openInbox = async () => {
  await waitFor(async () => (await api('computerUse.consents')).length > 0)
  await page.getByRole('button', { name: /有 \d+ 个待确认操作|确认中心/ }).click()
}
const allow = async (operation, decision) => {
  await openInbox()
  await consent.waitFor({ state: 'visible', timeout: 10000 })
  ok((await consent.textContent()).includes('com.apple.TextEdit'), 'consent identifies the exact app')
  await consent.getByRole('button', { name: decision, exact: true }).click()
  const result = await operation
  await consent.waitFor({ state: 'detached' })
  await page.keyboard.press('Escape')
  return result
}
const refOf = (snapshot) => /\[(d\d+)\]/.exec(snapshot)?.[1]
const snapshotOK = (result) => typeof result === 'string' && result.includes('AXTextArea') && result.includes('Hello Navo') && !!refOf(result)

try {
  ok(!(await api('dev.tools')).some((t) => t.name.startsWith('desktop_')), 'desktop tools are absent while disabled')
  await page.evaluate(() => {
    window.location.hash = '/settings'
  })
  const section = page.getByTestId('computer-use-settings')
  await section.waitFor({ state: 'visible' })
  const toggle = section.getByTestId('desktop-enabled')
  await toggle.click()
  await waitFor(async () => (await api('settings.get')).computerUse.desktop)
  await waitFor(async () => {
    const d = (await api('computerUse.status')).desktop
    return d.accessibility && d.screenRecording && d.helper === 'ok'
  })
  if (process.platform === 'darwin') ok((await section.getByText('已授权', { exact: true }).count()) >= 2, 'settings displays both granted permissions')
  else {
    await section.getByText('Windows 桌面访问', { exact: true }).waitFor({ state: 'visible' })
    ok(await section.getByText('可用', { exact: true }).isVisible(), 'Windows desktop access is shown as available')
    ok(
      (await section.getByText('辅助功能', { exact: true }).count()) === 0 &&
        (await section.getByText('屏幕录制', { exact: true }).count()) === 0 &&
        (await section.getByRole('button', { name: '前往授权', exact: true }).count()) === 0,
      'Windows desktop settings omit macOS permission rows and grant buttons',
    )
  }
  ok(
    (await api('dev.tools')).some((t) => t.name === 'desktop_activate'),
    'enabling desktop exposes the tools',
  )
  ok(
    JSON.parse(await tool('desktop_apps')).some((a) => a.bundleId === 'com.apple.TextEdit'),
    'fake native helper lists TextEdit',
  )

  // One-time approval is consumed by one tool call; hiding the inbox never denies the next request.
  const activated = await allow(tool('desktop_activate', { app: 'com.apple.TextEdit' }), '仅这一次')
  ok(snapshotOK(activated), 'one-time approval returns an accessible element snapshot')
  await page.getByTestId('desktop-control-bar').waitFor({ state: 'visible' })
  ok((await api('computerUse.status')).desktop.active?.bundleId === 'com.apple.TextEdit', 'active control is visible in status and the stop bar')
  const denied = tool('desktop_snapshot')
  await openInbox()
  await consent.waitFor({ state: 'visible' })
  await page.keyboard.press('Escape')
  ok((await api('computerUse.consents')).length === 1, 'closing the inbox preserves pending consent')
  await openInbox()
  await consent.getByRole('button', { name: '拒绝', exact: true }).click()
  ok((await denied).includes('授权被拒绝'), 'explicit denial rejects the pending tool')
  await page.keyboard.press('Escape')

  const granted = await allow(tool('desktop_activate', { app: 'com.apple.TextEdit' }), '本对话允许')
  ok(snapshotOK(granted), 'conversation approval resumes the pending tool')
  let snapshot = await tool('desktop_snapshot')
  ok(snapshotOK(snapshot) && (await consent.count()) === 0, 'conversation grant avoids repeated consent dialogs')
  ok((await tool('desktop_click', { ref: refOf(granted) })).includes('已失效'), 'a previous snapshot reference is rejected')
  snapshot = await tool('desktop_type', { ref: refOf(snapshot), text: '你好，Navo 🌍' })
  ok(snapshotOK(snapshot), 'Unicode input passes through the helper transport and returns fresh refs')
  snapshot = await tool('desktop_key', { combo: process.platform === 'win32' ? 'ctrl+a' : 'cmd+a' })
  ok(snapshotOK(snapshot), 'keyboard shortcut passes through the helper transport')
  snapshot = await tool('desktop_scroll', { ref: refOf(snapshot), dy: 160 })
  ok(snapshotOK(snapshot), 'scroll by element reference returns fresh refs')
  ok((await tool('desktop_click', { x: 20, y: 20 })).includes('desktop_screenshot'), 'coordinate input requires a screenshot')
  const image = await tool('desktop_screenshot')
  ok(Array.isArray(image) && image[1]?.image_url?.url?.startsWith('data:image/jpeg;base64,'), 'screenshot returns a JPEG image block')
  ok(snapshotOK(await tool('desktop_click', { x: 20, y: 20 })), 'screenshot coordinates reach the fake app')
  ok((await tool('desktop_click', { x: 20, y: 20 })).includes('desktop_screenshot'), 'a coordinate action invalidates the captured coordinate map')
  ok(snapshotOK(await tool('desktop_wait_for', { text: 'Hello Navo', timeout: 0 })), 'wait-for finds accessible text')
  ok((await tool('desktop_wait_for', { text: 'not present', timeout: 0 })).includes('等待超时'), 'wait-for reports a bounded timeout')

  const blocked = section.getByLabel('禁止操作的应用', { exact: true })
  const original = await blocked.inputValue()
  await blocked.fill(`${original}\ncom.apple.TextEdit`)
  await section.getByRole('button', { name: '保存', exact: true }).click()
  await waitFor(async () => (await api('settings.get')).computerUse.blockedApps.includes('com.apple.TextEdit'))
  ok((await tool('desktop_activate', { app: 'com.apple.TextEdit' })).includes('已禁止控制'), 'blocked app overrides an existing conversation grant')
  ok(JSON.parse(await tool('desktop_apps')).length === 0, 'blocked apps are excluded from the available app list')
  await blocked.fill(original)
  await section.getByRole('button', { name: '保存', exact: true }).click()
  await waitFor(async () => !(await api('settings.get')).computerUse.blockedApps.includes('com.apple.TextEdit'))

  await page.getByTestId('desktop-control-bar').getByRole('button', { name: '停止操作', exact: true }).click()
  await waitFor(async () => !(await api('computerUse.status')).desktop.active)
  ok((await api('computerUse.status')).desktop.lastStop?.reason === 'user_stop', 'stop status identifies explicit user stop')
  await page.getByTestId('desktop-control-bar').getByRole('button', { name: '关闭', exact: true }).click()
  ok((await tool('desktop_key', { combo: 'enter' })).includes('中止'), 'the stop button cancels subsequent desktop input')
  await api('computerUse.stop')
  ok(!(await api('computerUse.status')).desktop.active, 'repeated stop is safe')
  const grants = await api('computerUse.grants')
  ok(grants.length === 1 && grants[0].scope === 'session', 'conversation authorization is listed for revocation')
  await api('computerUse.revokeGrant', grants[0].id)
  ok((await api('computerUse.grants')).length === 0, 'revocation removes the grant')
  await toggle.click()
  await waitFor(async () => !(await api('settings.get')).computerUse.desktop)
  ok(!(await api('dev.tools')).some((t) => t.name.startsWith('desktop_')), 'disabling desktop removes its tools')
} catch (error) {
  ok(false, `exception ${error.stack ?? error}`)
} finally {
  await api('computerUse.stop').catch(() => undefined)
  await app.close()
  rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}
