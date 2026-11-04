// Project workspaces: native picker UI, real file placement, and historical artifact identity.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmdirSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { once } from 'node:events'
import { _electron as electron, expect } from 'playwright/test'
import JSZip from 'jszip'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const profile = mkdtempSync(join(tmpdir(), 'navo-project-directory-'))
const firstDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'navo-workspace-one-')))
const secondDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'navo-workspace-two-')))
const unavailableDirectory = realpathSync(mkdtempSync(join(tmpdir(), 'navo-workspace-gone-')))
const mock = startMock(39044)
let app
let win
const poll = async (read, label, timeout = 60000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const value = await read()
    if (value) return value
    await new Promise((resolve) => setTimeout(resolve, 150))
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
  const route = async (pathname) =>
    win.evaluate((pathname) => {
      window.location.hash = pathname
    }, pathname)
  const chooseDirectory = async (directory) => {
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({ canceled: directory === null, filePaths: directory === null ? [] : [directory] })
    }, directory)
    await win.getByRole('dialog').getByRole('button', { name: '选择文件夹', exact: true }).click()
    await expect(win.getByRole('dialog').getByRole('button', { name: '选择文件夹', exact: true })).toBeEnabled()
  }
  const saveDialog = async () => {
    await win.getByRole('dialog').getByRole('button', { name: '保存', exact: true }).click()
    await expect(win.getByRole('dialog')).toBeHidden()
  }
  const editProject = async (id) => {
    await route(`/projects/${id}?tab=settings`)
    await win.locator('main').getByRole('button', { name: '编辑项目', exact: true }).click()
    await expect(win.getByRole('dialog')).toBeVisible()
  }
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
    window.__directoryEvents = []
    window.api.on('chat.event', (event) => window.__directoryEvents.push(event))
  })
  const run = async (threadId, text, expectedError = false) => {
    const from = await win.evaluate(() => window.__directoryEvents.length)
    await api('chat.send', threadId, text)
    await poll(
      async () =>
        (await win.evaluate((from) => window.__directoryEvents.slice(from), from)).find((event) => event.threadId === threadId && event.type === 'run_end'),
      `run ${text}`,
    )
    const errors = (await win.evaluate((from) => window.__directoryEvents.slice(from), from)).filter(
      (event) => event.threadId === threadId && event.type === 'error',
    )
    if (expectedError) assert.ok(errors.length, 'invalid project workspace emits an error')
    else assert.deepEqual(errors, [], 'run has no errors')
    return errors
  }

  await route('/projects')
  await win.locator('main').getByRole('button', { name: '新建项目', exact: true }).click()
  const dialog = win.getByRole('dialog')
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('Keep this name')
  await dialog.getByRole('textbox', { name: '描述', exact: true }).fill('Directory project description')
  await chooseDirectory(null)
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue('Keep this name')
  await expect(dialog.getByRole('textbox', { name: '描述', exact: true })).toHaveValue('Directory project description')
  await expect(dialog.getByRole('textbox', { name: '工作目录', exact: true })).toHaveValue('')
  await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('')
  await chooseDirectory(firstDirectory)
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(basename(firstDirectory))
  await expect(dialog.getByRole('textbox', { name: '工作目录', exact: true })).toHaveValue(firstDirectory)
  await expect(dialog.getByRole('textbox', { name: '工作目录', exact: true })).toHaveAttribute('readonly', '')
  await chooseDirectory(null)
  await expect(dialog.getByRole('textbox', { name: '工作目录', exact: true })).toHaveValue(firstDirectory)
  await saveDialog()
  const project = (await api('projects.list')).find((item) => item.name === basename(firstDirectory))
  assert.ok(project)
  assert.equal(project.workingDirectory, firstDirectory)
  const thread = await api('threads.create', model.id, project.id)
  await run(thread.id, '[outputs:DIR1] write in the selected directory')
  const original = await api('outputs.list', thread.id)
  assert.equal(original.length, 3)
  assert.ok(original.every((file) => file.path.startsWith(firstDirectory + '/')))
  for (const name of ['周报-DIR1.md', '价格-DIR1.csv', '周报-DIR1.docx']) {
    assert.ok(existsSync(join(firstDirectory, name)), `${name} exists in project workspace`)
    assert.equal(existsSync(join(profile, 'workspace', name)), false, `${name} never leaked into default workspace`)
  }
  const oldReport = original.find((file) => file.name === '周报-DIR1.md')
  const originalBytes = new Map(original.map((file) => [file.id, readFileSync(file.path)]))
  const wordXml = await (await JSZip.loadAsync(readFileSync(join(firstDirectory, '周报-DIR1.docx')))).file('word/document.xml').async('string')
  assert.ok(wordXml.includes('竞品周报 DIR1'), 'agent export_file writes a valid document in the project directory')
  assert.equal((await api('artifacts.preview', oldReport.id)).kind, 'markdown')
  const exported = await api('artifacts.export', oldReport.id, 'docx', join(profile, 'first-export.docx'))
  assert.ok((await (await JSZip.loadAsync(readFileSync(exported))).file('word/document.xml').async('string')).includes('竞品周报 DIR1'))

  // An API edit that omits the directory must preserve it.
  await api('projects.save', { id: project.id, name: project.name, description: 'Description edited without a directory field' })
  assert.equal((await api('projects.get', project.id)).workingDirectory, firstDirectory)
  await editProject(project.id)
  await chooseDirectory(secondDirectory)
  await expect(dialog.getByRole('textbox', { name: '名称', exact: true })).toHaveValue(project.name)
  await saveDialog()
  assert.equal((await api('projects.get', project.id)).workingDirectory, secondDirectory)
  await run(thread.id, '[outputs:DIR1] write the same filenames in the second directory')
  const both = await api('outputs.list', thread.id)
  assert.equal(both.length, 6, 'same thread and virtual filenames keep distinct historical artifacts')
  assert.equal(new Set(both.map((file) => file.id)).size, 6)
  const second = both.filter((file) => file.path.startsWith(secondDirectory + '/'))
  assert.equal(second.length, 3)
  for (const file of original) {
    assert.ok(
      both.some((current) => current.id === file.id && current.path === file.path),
      'original ID and location retained',
    )
    assert.deepEqual(readFileSync(file.path), originalBytes.get(file.id), 'changing directories never moves or overwrites original files')
    assert.ok(existsSync(join(secondDirectory, file.name)))
  }
  const secondReport = second.find((file) => file.name === oldReport.name)
  assert.notEqual(secondReport.id, oldReport.id)
  assert.equal((await api('artifacts.preview', oldReport.id)).kind, 'markdown')
  assert.equal((await api('artifacts.preview', secondReport.id)).kind, 'markdown')

  // Explicit null restores the default; omitted fields above preserve the custom directory.
  await editProject(project.id)
  await dialog.getByRole('button', { name: '使用默认工作区', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: '工作目录', exact: true })).toHaveValue('')
  await saveDialog()
  assert.equal((await api('projects.get', project.id)).workingDirectory, null)
  await run(thread.id, '[outputs:DIRDEFAULT] write after resetting to the default workspace')
  assert.ok(existsSync(join(profile, 'workspace', '周报-DIRDEFAULT.md')))
  assert.equal(existsSync(join(secondDirectory, '周报-DIRDEFAULT.md')), false)
  assert.equal((await api('artifacts.preview', oldReport.id)).kind, 'markdown')

  const destination = await api('projects.save', { name: 'Moved conversation project' })
  assert.equal(destination.workingDirectory, null)
  await api('threads.setProject', thread.id, destination.id)
  assert.ok((await api('artifacts.list', destination.id)).some((file) => file.id === oldReport.id))
  await api('projects.delete', project.id)
  await api('projects.delete', destination.id)
  assert.equal((await api('threads.list')).find((item) => item.id === thread.id).projectId, null)
  for (const report of [oldReport, secondReport]) {
    assert.ok((await api('artifacts.list', null)).some((file) => file.id === report.id))
    assert.equal((await api('artifacts.preview', report.id)).kind, 'markdown')
  }

  // A directory may disappear between saving configuration and starting a run; never silently fall back.
  const broken = await api('projects.save', { name: 'Unavailable directory', workingDirectory: unavailableDirectory })
  rmdirSync(unavailableDirectory) // This owned, newly created fixture is empty.
  await assert.rejects(api('projects.save', { name: 'Invalid directory input', workingDirectory: unavailableDirectory }), /工作目录/)
  const brokenThread = await api('threads.create', model.id, broken.id)
  const requestCount = mock.requests.length
  const errors = await run(brokenThread.id, '[outputs:DIRINVALID] must not fall back', true)
  assert.ok(errors.some((event) => event.error.includes('工作目录')))
  assert.equal(mock.requests.length, requestCount, 'invalid workspace fails before asking the model to write')
  assert.equal((await api('outputs.list', brokenThread.id)).length, 0)
  assert.equal(existsSync(join(profile, 'workspace', '周报-DIRINVALID.md')), false)
  console.log('PASS project directory picker, filesystem placement, same-name history, reset, move/delete and unavailable directory')
} catch (error) {
  console.error(`FAIL project-directory (temporary profile: ${profile})`, error)
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise((resolve, reject) => mock.server.close((error) => (error ? reject(error) : resolve())))
}
