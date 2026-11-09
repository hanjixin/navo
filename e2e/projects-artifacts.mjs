// Real UI regression for project routes and the shared artifact workspace. Requires a built app.
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { _electron as electron, expect } from 'playwright/test'
import JSZip from 'jszip'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const profile = mkdtempSync(join(tmpdir(), 'navo-project-artifacts-'))
const shots = process.argv[2] ?? profile
mkdirSync(shots, { recursive: true })
const mock = startMock(39043) // startMock constructs its URL from the argument; port 0 is unsupported.
let app
let win
const navigations = []
const poll = async (read, message, timeout = 30000) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  throw new Error(`Timed out: ${message}`)
}
try {
  if (!mock.server.listening) await once(mock.server, 'listening')
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile, AB_MEMORY_IDLE_MS: '600000' } })
  win = await mainWindow(app)
  await win.emulateMedia({ reducedMotion: 'reduce' })
  win.on('framenavigated', (frame) => {
    if (frame === win.mainFrame()) navigations.push(frame.url().split('#')[1])
  })
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().includes('index.html'))
      ?.setSize(1600, 1000),
  )
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
      window.setFocusable(false)
      window.setIgnoreMouseEvents(true)
      window.showInactive()
    }
  })
  const capture = async (name) => {
    await win.mouse.move(5, 5)
    const png = await app.evaluate(async ({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('index.html'))
      return (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG().toString('base64')
    })
    writeFileSync(join(shots, name), Buffer.from(png, 'base64'))
  }
  const rendererErrors = []
  win.on('pageerror', (error) => rendererErrors.push(error.message))
  win.on('console', (message) => {
    if (message.type() === 'error' && /same key|unique.*key/.test(message.text())) rendererErrors.push(message.text())
  })
  const api = (method, ...args) => win.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
  const path = (thread) => (thread.projectId ? `/projects/${thread.projectId}/chat/${thread.id}` : `/chat/${thread.id}`)
  const hashUrl = () => new URL(win.url().split('#')[1], 'http://local')
  const expectPath = async (pathname) => poll(() => hashUrl().pathname === pathname, `URL ${pathname} (current: ${hashUrl().pathname})`)
  const route = async (pathname) => {
    await win.evaluate((pathname) => {
      window.location.hash = pathname
    }, pathname)
    await expectPath(pathname.split('?')[0])
  }
  const ensureThreadList = async () => {
    const toggle = win.getByRole('button', { name: '切换对话列表', exact: true })
    await expect(toggle).toBeVisible()
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click()
  }
  const choose = async (trigger, name) => {
    await trigger.click()
    await win.getByRole('option', { name, exact: true }).click()
  }
  const editForm = async (name, description) => {
    const dialog = win.getByRole('dialog')
    await dialog.getByRole('textbox', { name: '名称', exact: true }).fill(name)
    await dialog.getByRole('textbox', { name: '描述', exact: true }).fill(description)
    await dialog.getByRole('button', { name: '保存', exact: true }).click()
    await expect(dialog).toBeHidden()
  }
  const installEvents = async () =>
    win.evaluate(() => {
      window.__projectEvents = []
      window.api.on('chat.event', (event) => window.__projectEvents.push(event))
    })
  const reload = async () => {
    const url = win.url()
    await win.reload()
    await win.waitForFunction(() => !!window.api && !!document.querySelector('nav'))
    assert.equal(win.url(), url, 'reload preserves the full route and query')
    await installEvents()
  }
  const run = async (threadId, text) => {
    const from = mock.requests.length
    const eventStart = await win.evaluate(() => window.__projectEvents.length)
    await api('chat.send', threadId, text)
    await poll(
      async () =>
        (await win.evaluate((from) => window.__projectEvents.slice(from), eventStart)).find((event) => event.type === 'run_end' && event.threadId === threadId),
      `agent run ${text}`,
      60000,
    )
    const events = (await win.evaluate((from) => window.__projectEvents.slice(from), eventStart)).filter((event) => event.threadId === threadId)
    assert.equal(
      events.some((event) => event.type === 'error'),
      false,
      JSON.stringify(events),
    )
    const requests = mock.requests
      .slice(from)
      .filter((request) => request.messages.some((message) => message.role === 'user' && JSON.stringify(message.content).includes(text)))
    assert.ok(requests.length, 'mock captured this run')
    return requests
      .map((request) =>
        request.messages
          .filter((message) => message.role === 'system')
          .map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
          .join('\n'),
      )
      .join('\n')
  }
  const createProject = async (name, description, checkBlank = false) => {
    await route('/projects')
    await win.locator('main').getByRole('button', { name: '新建项目', exact: true }).click()
    if (checkBlank) {
      await win.getByRole('dialog').getByRole('textbox', { name: '名称', exact: true }).fill('   ')
      await expect(win.getByRole('dialog').getByRole('button', { name: '保存', exact: true })).toBeDisabled()
      await assert.rejects(api('projects.save', { name: '   ' }), /不能为空/)
    }
    await editForm(name, description)
    const project = (await api('projects.list')).find((item) => item.name === name)
    assert.ok(project)
    await expectPath(`/projects/${project.id}`)
    await expect(win.getByRole('heading', { name, exact: true }).first()).toBeVisible()
    await expect(win.getByTestId('project-inspector')).toBeVisible()
    assert.equal(project.description, description)
    return project
  }
  const createProjectThread = async (project) => {
    await route(`/projects/${project.id}`)
    await expect(win.locator('main').getByRole('heading', { name: project.name, exact: true })).toBeVisible()
    const before = new Set((await api('threads.list')).map((thread) => thread.id))
    await win.getByRole('button', { name: '新建对话', exact: true }).first().click()
    await expectPath(`/projects/${project.id}`)
    await expect(win.getByTestId('composer-runtime').getByRole('combobox')).toBeVisible()
    assert.equal((await api('threads.list')).length, before.size, 'opening a new draft does not bind its runtime or create a thread')
    // Prepare independent-run fixtures through the API; first-send creation is covered below.
    const thread = await api('threads.create', null, project.id, 'builtin')
    await route(path(thread))
    assert.equal(thread.projectId, project.id)
    await expectPath(path(thread))
    return thread
  }
  const provider = await api('providers.save', { type: 'openai-compatible', name: 'Mock', baseURL: mock.url, apiKey: 'x' })
  await api('models.save', { providerId: provider.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false, isDefault: true })
  await installEvents()
  const alpha = await createProject('Project Alpha', 'Alpha original context', true)
  const beta = await createProject('Project Beta', 'Beta context')
  const threadA = await createProjectThread(alpha)
  const threadB = await createProjectThread(beta)

  // Independent simultaneous runs must not claim another project's shared-workspace files.
  const [contextA, contextB] = await Promise.all([run(threadA.id, '[outputs:P1] 写 Alpha 项目周报'), run(threadB.id, '[outputs:P2] 写 Beta 项目周报')])
  assert.ok(contextA.includes('项目名称：Project Alpha') && contextA.includes('Alpha original context'))
  assert.ok(!contextA.includes('项目名称：Project Beta'))
  assert.ok(contextB.includes('项目名称：Project Beta') && !contextB.includes('项目名称：Project Alpha'))
  const filesA = await api('artifacts.list', alpha.id)
  const filesB = await api('artifacts.list', beta.id)
  assert.equal(filesA.length, 3)
  assert.equal(filesB.length, 3)
  assert.ok(filesA.every((file) => file.threadId === threadA.id && file.name.includes('P1')))
  assert.ok(filesB.every((file) => file.threadId === threadB.id && file.name.includes('P2')))
  assert.equal(new Set([...filesA, ...filesB].map((file) => file.id)).size, 6)
  const firstPage = await api('artifacts.query', { threadId: threadA.id, limit: 1 })
  assert.equal(firstPage.items.length, 1)
  assert.ok(firstPage.nextCursor)
  const secondPage = await api('artifacts.query', { threadId: threadA.id, limit: 1, cursor: firstPage.nextCursor })
  assert.equal(secondPage.items.length, 1)
  assert.notEqual(secondPage.items[0].id, firstPage.items[0].id)
  assert.ok(secondPage.items.every((file) => file.threadId === threadA.id))
  assert.equal((await api('artifacts.query', { projectId: alpha.id, kind: 'markdown', q: '周报-P1' })).items.length, 1)
  await assert.rejects(api('artifacts.query', { threadId: threadB.id, cursor: firstPage.nextCursor }))
  const report = filesA.find((file) => file.name === '周报-P1.md')
  const reportB = filesB.find((file) => file.name === '周报-P2.md')
  assert.ok(report && reportB)

  // Navigating away from a running project does not cancel its work.
  const slowRun = run(threadB.id, '[slow] keep running while switching projects')
  await poll(async () => (await api('threads.state', threadB.id)).running, 'slow run started')
  await route(`/projects/${alpha.id}`)
  await expect(win.locator('main').getByRole('heading', { name: alpha.name, exact: true })).toBeVisible()
  assert.equal((await api('threads.state', threadB.id)).running, true)
  await route(`/projects/${beta.id}`)
  await expect(win.locator('nav').getByTitle('运行中', { exact: true })).toBeVisible()
  await slowRun
  assert.equal((await api('threads.state', threadB.id)).running, false)

  // URL-restorable project tabs, edits, and fresh project instructions on the next run.
  await route(`/projects/${alpha.id}`)
  await win.getByRole('tab', { name: '项目设置', exact: true }).click()
  assert.equal(hashUrl().searchParams.get('tab'), 'settings')
  await reload()
  await expect(win.getByRole('tab', { name: '项目设置', exact: true })).toHaveAttribute('aria-selected', 'true')
  await win.getByRole('button', { name: '编辑项目', exact: true }).click()
  await editForm('Project Alpha Renamed', 'Alpha updated context')
  const renamed = await api('projects.get', alpha.id)
  assert.equal(renamed.name, 'Project Alpha Renamed')
  assert.equal(renamed.description, 'Alpha updated context')
  const updatedContext = await run(threadA.id, '[plain] check updated context')
  assert.ok(updatedContext.includes('项目名称：Project Alpha Renamed') && updatedContext.includes('Alpha updated context'))
  assert.ok(!updatedContext.includes('Alpha original context'))

  await route(`/projects/${alpha.id}`)
  await expect(win.locator('main').getByRole('heading', { name: renamed.name, exact: true })).toBeVisible()
  await expect(win.getByRole('tab', { name: '对话', exact: true })).toHaveAttribute('aria-selected', 'true')
  await capture('project-detail.png')
  await win.getByRole('tab', { name: '产物', exact: true }).click()
  await win.getByTestId('project-inspector').getByRole('button', { name: '预览 周报-P1.md', exact: true }).click()
  await expect(win.locator('[data-testid=output-preview] h1')).toContainText('竞品周报 P1')
  await win.getByRole('button', { name: '收起工作区面板', exact: true }).last().click()
  await expect(win.getByTestId('artifact-panel')).toBeHidden()

  // Ownership changes from the shared conversation menu canonicalize the current URL.
  await route(path(threadA))
  await ensureThreadList()
  const move = async (name, projectId) => {
    const current = (await api('threads.list')).find((item) => item.id === threadA.id)
    const row = win.locator('div.group').filter({ has: win.getByRole('link', { name: current.title, exact: true }) })
    await row.hover()
    await row.getByRole('button', { name: '更多', exact: true }).click()
    await win.getByRole('menuitem', { name: '移动到项目' }).click()
    await choose(win.getByRole('dialog').getByRole('combobox'), name)
    await win.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
    await expect(win.getByRole('dialog')).toBeHidden()
    await expectPath(path({ id: threadA.id, projectId }))
    assert.equal((await api('threads.list')).find((item) => item.id === threadA.id).projectId, projectId)
  }
  await move(beta.name, beta.id)
  assert.ok((await api('artifacts.list', beta.id)).some((file) => file.id === report.id))
  assert.equal((await api('artifacts.list', alpha.id)).length, 0)
  await move('未归属项目', null)
  const unassignedContext = await run(threadA.id, '[plain] check unassigned context')
  assert.ok(!unassignedContext.includes('## 当前项目'))
  await move(renamed.name, alpha.id)
  await reload()
  await expectPath(path(threadA))
  await expect(win.getByTestId('outputs-button')).toBeVisible()

  // The project composer creates and sends to the explicitly scoped conversation.
  await route(`/projects/${alpha.id}`)
  const beforeComposing = new Set((await api('threads.list')).map((item) => item.id))
  const prompt = '[plain] sent from the project composer'
  await win.locator('main textarea').fill(prompt)
  await win.locator('main textarea').press('Enter')
  const composed = await poll(async () => (await api('threads.list')).find((item) => !beforeComposing.has(item.id)), 'project composer creates a conversation')
  assert.equal(composed.projectId, alpha.id)
  await expectPath(path(composed))
  await poll(async () => (await api('threads.state', composed.id)).messages.some((m) => m.role === 'assistant'), 'project composer sends and receives')
  const sentRequest = mock.requests.find((req) => req.messages.some((m) => m.role === 'user' && JSON.stringify(m.content).includes(prompt)))
  assert.ok(sentRequest && JSON.stringify(sentRequest.messages[0]).includes('Alpha updated context'))
  await win.getByRole('button', { name: `展开 ${renamed.name}`, exact: true }).click()
  await reload()
  await expect(win.getByRole('button', { name: `收起 ${renamed.name}`, exact: true })).toHaveAttribute('aria-expanded', 'true')

  // Global creation must ignore whichever project conversation was previously active.
  await route('/chat')
  await ensureThreadList()
  const previous = new Set((await api('threads.list')).map((item) => item.id))
  await win.getByRole('button', { name: '新建对话', exact: true }).click()
  await expectPath('/chat')
  await expect(win.getByTestId('composer-runtime').getByRole('combobox')).toBeVisible()
  assert.equal((await api('threads.list')).length, previous.size)
  await win.locator('main textarea').fill('[plain] first message from the global new conversation draft')
  await win.locator('main textarea').press('Enter')
  const fresh = await poll(async () => (await api('threads.list')).find((item) => !previous.has(item.id)), 'global first send creates a new thread')
  await poll(async () => (await api('threads.state', fresh.id)).messages.some((m) => m.role === 'assistant'), 'global new conversation completes')
  assert.equal(fresh.projectId, null)
  await expectPath(path(fresh))
  await win.goBack()
  await expectPath('/chat')
  await win.goForward()
  await expectPath(path(fresh))

  // Project artifact tab, type/search filtering and selection all survive reload.
  await route(`/projects/${alpha.id}`)
  await win.getByRole('tab', { name: 'Artifacts', exact: true }).click()
  assert.equal(hashUrl().searchParams.get('tab'), 'artifacts')
  const browser = win.getByTestId('artifact-browser')
  await choose(browser.getByRole('combobox'), 'Markdown')
  await browser.getByPlaceholder('搜索产物').fill('no-such-artifact')
  await expect(browser.getByText('没有匹配的产物', { exact: true })).toBeVisible()
  await browser.getByPlaceholder('搜索产物').fill('周报-P1')
  await browser.getByRole('button', { name: '预览 周报-P1.md', exact: true }).click()
  assert.equal(hashUrl().searchParams.get('artifact'), report.id)
  await reload()
  assert.equal(hashUrl().searchParams.get('tab'), 'artifacts')
  assert.equal(hashUrl().searchParams.get('kind'), 'markdown')
  await expect(win.getByPlaceholder('搜索产物')).toHaveValue('周报-P1')
  await expect(win.getByRole('tab', { name: 'Artifacts', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(win.locator('[data-testid=output-preview] h1')).toContainText('竞品周报 P1')
  await win.getByRole('tab', { name: '浏览器', exact: true }).click()
  assert.equal(hashUrl().searchParams.get('artifact'), report.id)
  assert.equal(hashUrl().searchParams.get('panel'), 'browser')
  await expect(win.getByRole('tab', { name: '浏览器', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(win.getByTestId('artifact-panel')).toHaveCount(0)
  await win.getByRole('tab', { name: '产物', exact: true }).click()
  await expect(win.locator('[data-testid=output-preview] h1')).toContainText('竞品周报 P1')
  assert.equal(hashUrl().searchParams.has('panel'), false)

  await capture('project-artifact-wide.png')
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('index.html'))
      ?.setContentSize(1024, 760),
  )
  await expect(win.getByTestId('artifact-panel')).toBeVisible()
  await expect
    .poll(async () => (await win.getByTestId('artifact-panel').boundingBox()).width, {
      message: 'narrow preview uses the content area instead of squeezing another column',
    })
    .toBeGreaterThan(700)
  await expect(win.getByRole('button', { name: '导出 Word', exact: true })).toBeVisible()
  await capture('project-artifact-narrow.png')
  await win.getByRole('button', { name: '收起工作区面板', exact: true }).last().click()
  await expect(win.getByPlaceholder('搜索产物')).toHaveValue('周报-P1')
  await browser.getByRole('button', { name: '预览 周报-P1.md', exact: true }).click()
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((w) => w.webContents.getURL().includes('index.html'))
      ?.setContentSize(1600, 1000),
  )
  await expect(win.locator('[data-testid=output-preview] h1')).toContainText('竞品周报 P1')

  const exported = join(profile, 'exported-report.docx')
  await app.evaluate(({ dialog }, destination) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: destination })
  }, exported)
  await win.getByRole('button', { name: '导出 Word', exact: true }).click()
  await poll(() => existsSync(exported), 'Word export')
  const xml = await (await JSZip.loadAsync(readFileSync(exported))).file('word/document.xml').async('string')
  assert.ok(xml.includes('竞品周报 P1') && xml.includes('<w:tbl>'))
  await win.getByTestId('artifact-panel').getByRole('link', { name: '打开来源对话', exact: true }).click()
  await expectPath(path(threadA))
  await win.goBack()
  await expect(win.locator('[data-testid=output-preview] h1')).toContainText('竞品周报 P1')
  assert.equal(hashUrl().searchParams.get('artifact'), report.id)

  // Global library project scope is in the URL, including the unassigned scope.
  await route('/artifacts')
  await choose(win.getByRole('combobox').first(), beta.name)
  assert.equal(hashUrl().searchParams.get('project'), beta.id)
  await expect(win.getByRole('button', { name: '预览 周报-P2.md', exact: true })).toBeVisible()
  await expect(win.getByRole('button', { name: '预览 周报-P1.md', exact: true })).toHaveCount(0)
  await reload()
  await expect(win.getByRole('button', { name: '预览 周报-P2.md', exact: true })).toBeVisible()

  // Deleting from current project details returns to the index and preserves conversation/files.
  await route(`/projects/${alpha.id}?tab=settings`)
  await win.getByRole('button', { name: '删除项目', exact: true }).click()
  await expect(win.getByRole('dialog')).toContainText('对话和产物会保留')
  await win.getByRole('dialog').getByRole('button', { name: '删除', exact: true }).click()
  await expectPath('/projects')
  assert.equal(await api('projects.get', alpha.id), null)
  assert.equal((await api('threads.list')).find((item) => item.id === threadA.id).projectId, null)
  await win.evaluate((pathname) => {
    window.location.hash = pathname
  }, `/projects/${alpha.id}/chat/${threadA.id}`)
  await expectPath(`/chat/${threadA.id}`)
  await reload()
  await expect(win.getByTestId('outputs-button')).toBeVisible()
  await route('/artifacts?project=none')
  await win.getByRole('button', { name: '预览 周报-P1.md', exact: true }).click()
  await expect(win.locator('[data-testid=output-preview] h1')).toContainText('竞品周报 P1')

  // Another window/API may delete the project while its chat and artifact are open.
  await route(`${path(threadB)}?artifact=${reportB.id}`)
  await expect(win.locator('[data-testid=output-preview] h1')).toContainText('竞品周报 P2')
  await api('projects.delete', beta.id)
  await expectPath(`/chat/${threadB.id}`)
  assert.equal(hashUrl().searchParams.get('artifact'), reportB.id)
  await reload()
  await expect(win.locator('[data-testid=output-preview] h1')).toContainText('竞品周报 P2')
  await win.getByRole('button', { name: '收起工作区面板', exact: true }).last().click()
  await ensureThreadList()
  const priorDeletion = new Set((await api('threads.list')).map((item) => item.id))
  await win.getByRole('button', { name: '新建对话', exact: true }).click()
  await expectPath('/chat')
  await expect(win.getByTestId('composer-runtime').getByRole('combobox')).toBeVisible()
  await expect(win.locator('main textarea')).toBeEnabled()
  assert.equal((await api('threads.list')).length, priorDeletion.size)
  await win.locator('main textarea').fill('[plain] first message after deleting the project')
  await win.locator('main textarea').press('Enter')
  const afterDeletion = await poll(
    async () => (await api('threads.list')).find((item) => !priorDeletion.has(item.id)),
    'first send creates unassigned thread after project deletion',
  )
  await poll(async () => (await api('threads.state', afterDeletion.id)).messages.some((m) => m.role === 'assistant'), 'post-deletion conversation completes')
  assert.equal(afterDeletion.projectId, null)
  await expectPath(path(afterDeletion))
  await route('/chat/missing-thread')
  await expect(win.getByRole('alert')).toContainText('会话不存在')
  assert.deepEqual(rendererErrors, [], 'no renderer runtime or duplicate-key errors')
  console.log('PASS projects/artifacts routes, UI, concurrent ownership, context, export and deletion regression')
} catch (error) {
  await win?.screenshot({ path: join(profile, 'failure.png'), timeout: 2000 }).catch(() => {})
  console.error(`FAIL projects/artifacts (profile: ${profile}, url: ${win?.url()})`, error)
  console.error('Recent navigation:', navigations.slice(-16))
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise((resolve, reject) => mock.server.close((error) => (error ? reject(error) : resolve())))
}
