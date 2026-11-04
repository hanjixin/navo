// Project home remains usable with an empty welcome, long conversation lists and a bottom composer.
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { _electron as electron, expect } from 'playwright/test'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const profile = mkdtempSync(join(tmpdir(), 'navo-project-home-'))
const mock = startMock(39045)
let app
let win
const poll = async (read, label, timeout = 60000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
try {
  if (!mock.server.listening) await once(mock.server, 'listening')
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile, AB_MEMORY_IDLE_MS: '600000' } })
  win = await mainWindow(app)
  await win.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
      window.setFocusable(false)
      window.setIgnoreMouseEvents(true)
      window.showInactive()
    }
  })
  const api = (method, ...args) => win.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
  const route = (pathname) =>
    win.evaluate((pathname) => {
      window.location.hash = pathname
    }, pathname)
  const provider = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  const model = await api('models.save', {
    providerId: provider.id,
    model: 'mock-1',
    displayName: 'Mock',
    supportsTools: true,
    supportsVision: false,
    isDefault: true,
  })
  await win.evaluate(() => {
    window.__homeEvents = []
    window.api.on('chat.event', (event) => window.__homeEvents.push(event))
  })
  const home = win.getByTestId('project-home')
  const composer = win.getByTestId('project-composer')
  const textarea = win.locator('main textarea')
  const geometry = async () => {
    await expect(composer).toBeVisible()
    const result = await win.evaluate(() => {
      const root = document.querySelector('[data-testid=project-home]')
      const composer = document.querySelector('[data-testid=project-composer]')
      const inspector = document.querySelector('[data-testid=project-inspector]')
      const rootBox = root.getBoundingClientRect()
      const box = composer.getBoundingClientRect()
      const inspectorBox = inspector?.getBoundingClientRect()
      return {
        bottomGap: rootBox.bottom - box.bottom,
        y: box.y,
        bottom: box.bottom,
        x: box.x,
        right: box.right,
        width: box.width,
        viewportHeight: innerHeight,
        inspectorX: inspectorBox?.x,
      }
    })
    assert.ok(result.bottomGap >= -1 && result.bottomGap <= 48, `composer stays at the bottom: ${JSON.stringify(result)}`)
    assert.ok(result.y >= 0 && result.bottom <= result.viewportHeight + 1 && result.width >= 240, `composer is inside viewport: ${JSON.stringify(result)}`)
    if (result.inspectorX !== undefined) assert.ok(result.right <= result.inspectorX + 1, 'project inspector does not cover the composer')
    return result
  }
  const cases = [
    { width: 1600, height: 1000, theme: 'light' },
    { width: 1600, height: 1000, theme: 'dark' },
    { width: 1024, height: 760, theme: 'light' },
    { width: 1024, height: 760, theme: 'dark' },
  ]
  for (const [index, scenario] of cases.entries()) {
    const label = `${scenario.width}-${scenario.theme}`
    await app.evaluate(({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()
        .find((window) => window.webContents.getURL().includes('index.html'))
        ?.setContentSize(size.width, size.height)
    }, scenario)
    await api('settings.set', { theme: scenario.theme })
    await poll(() => win.evaluate((dark) => document.documentElement.classList.contains('dark') === dark, scenario.theme === 'dark'), 'applied theme')
    const project = await api('projects.save', { name: `Home ${label}`, description: 'Project home layout regression' })
    await route(`/projects/${project.id}`)
    await expect(home).toBeVisible()
    await expect(win.getByTestId('project-welcome').getByRole('heading', { level: 2 })).toBeVisible()
    await expect(win.getByTestId('project-context')).toContainText(project.name)
    await expect(win.getByTestId('project-inspector')).toBeVisible()
    await geometry()

    const emptyPng = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html'))
      return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
    })
    writeFileSync(join(profile, `${label}-welcome.png`), Buffer.from(emptyPng, 'base64'))

    // An unsent draft must survive both project tabs without creating a conversation.
    const draft = `[plain] preserved draft ${label}`
    await textarea.fill(draft)
    await home.getByRole('tab', { name: 'Artifacts', exact: true }).click()
    await expect(win.locator('main').getByTestId('artifact-browser')).toBeVisible()
    await home.getByRole('tab', { name: '项目设置', exact: true }).click()
    await expect(win.locator('main').getByRole('button', { name: '编辑项目', exact: true })).toBeVisible()
    await home.getByRole('tab', { name: '对话', exact: true }).click()
    await expect(textarea).toHaveValue(draft)
    assert.equal((await api('projects.get', project.id)).threads.length, 0, 'tab navigation does not submit the draft')

    // Populate enough rows to force the conversation list to scroll in both viewport sizes.
    for (let i = 0; i < 36; i++) {
      const thread = await api('threads.create', model.id, project.id)
      await api('threads.rename', thread.id, `Seed ${label} ${String(i).padStart(2, '0')}`)
    }
    await expect(home.getByRole('link', { name: new RegExp(`^Seed ${label}`) })).toHaveCount(36)
    await expect(textarea).toHaveValue(draft)
    const beforeScroll = await geometry()
    const scrolled = await home.evaluate((root) => {
      const candidates = [...root.querySelectorAll('div')].filter((element) => {
        const overflow = getComputedStyle(element).overflowY
        return /auto|scroll/.test(overflow) && element.scrollHeight > element.clientHeight + 100 && element.querySelector('a[href*="/chat/"]')
      })
      const list = candidates.at(-1)
      if (!list) return null
      list.scrollTop = list.scrollHeight
      return { scrollTop: list.scrollTop, clientHeight: list.clientHeight, scrollHeight: list.scrollHeight }
    })
    assert.ok(scrolled && scrolled.scrollTop > 0 && scrolled.scrollHeight > scrolled.clientHeight, 'conversation list actually scrolls')
    const afterScroll = await geometry()
    assert.ok(Math.abs(beforeScroll.y - afterScroll.y) < 2, 'scrolling conversations leaves the composer anchored')
    await expect(win.getByTestId('project-context')).toContainText(project.name)

    // Send through the visible UI; every viewport/theme must create a thread in this project.
    const text = index === 0 ? '[outputs:HOME1] create a Markdown home artifact' : `[plain] send from ${label}`
    await textarea.fill(text)
    const beforeIds = new Set((await api('threads.list')).map((thread) => thread.id))
    const eventStart = await win.evaluate(() => window.__homeEvents.length)
    await composer.getByRole('button', { name: '发送', exact: true }).click()
    const sent = await poll(async () => (await api('threads.list')).find((thread) => !beforeIds.has(thread.id)), 'UI-created project conversation')
    assert.equal(sent.projectId, project.id)
    await poll(() => win.url().split('#')[1]?.split('?')[0] === `/projects/${project.id}/chat/${sent.id}`, 'canonical conversation URL')
    await poll(
      async () =>
        (await win.evaluate((from) => window.__homeEvents.slice(from), eventStart)).some((event) => event.type === 'run_end' && event.threadId === sent.id),
      `finish ${label}`,
    )
    const errors = (await win.evaluate((from) => window.__homeEvents.slice(from), eventStart)).filter(
      (event) => event.type === 'error' && event.threadId === sent.id,
    )
    assert.deepEqual(errors, [])
    assert.ok((await api('threads.state', sent.id)).messages.some((message) => message.role === 'user' && message.content === text))
    await route(`/projects/${project.id}?tab=artifacts`)
    await expect(win.locator('main').getByTestId('artifact-browser')).toBeVisible()
    if (index === 0) {
      await win.locator('main').getByRole('button', { name: '预览 周报-HOME1.md', exact: true }).click()
      await expect(win.locator('[data-testid=output-preview] h1')).toContainText('竞品周报 HOME1')
      await win.getByRole('button', { name: '收起工作区面板', exact: true }).last().click()
    }
    await home.getByRole('tab', { name: '项目设置', exact: true }).click()
    await expect(win.locator('main').getByRole('button', { name: '编辑项目', exact: true })).toBeVisible()
    await home.getByRole('tab', { name: '对话', exact: true }).click()
    await geometry()
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html'))
      return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
    })
    writeFileSync(join(profile, `${label}.png`), Buffer.from(png, 'base64'))
    console.log(`PASS project home ${label}: welcome, inspector, draft tabs, scrolling and UI send`)
  }
  console.log(`Screenshots: ${profile}`)
} catch (error) {
  console.error(`FAIL project-home-layout (profile: ${profile})`, error)
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise((resolve, reject) => mock.server.close((error) => (error ? reject(error) : resolve())))
}
