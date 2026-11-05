// Browse existing project files without creating conversations, imports or agent artifacts.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { startMock } from './mock-llm.mjs'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect } from 'playwright/test'
import { mainWindow } from './helpers.mjs'

const profile = mkdtempSync(join(tmpdir(), 'navo-project-files-'))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'navo-existing-files-')))
const alternateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'navo-other-files-')))
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'navo-outside-files-')))
mkdirSync(join(root, 'src'))
writeFileSync(join(root, 'README.md'), '# Existing project\n\nOriginal documentation.\n')
writeFileSync(join(root, 'src', 'main.ts'), 'export const projectMarker = "original source"\n')
writeFileSync(join(root, 'data.json'), '{"project":"existing","count":2}\n')
writeFileSync(join(root, 'page.html'), '<!doctype html><html><body><h1>Existing HTML page</h1></body></html>')
writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255]))
writeFileSync(join(root, '.hidden-note'), 'hidden project setting')
writeFileSync(join(alternateRoot, 'README.md'), '# Alternate project\n\nDifferent root content.\n')
writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE WORKSPACE SENTINEL')
symlinkSync(join(outside, 'secret.txt'), join(root, 'linked-file.txt'))
symlinkSync(outside, join(root, 'linked-directory'), process.platform === 'win32' ? 'junction' : 'dir')
const mock = startMock(39054)
let app
let win
try {
  if (!mock.server.listening) await once(mock.server, 'listening')
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile, AB_MEMORY_IDLE_MS: '600000' } })
  win = await mainWindow(app)
  await win.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow, shell }) => {
    globalThis.__projectFileShellCalls = []
    shell.openPath = async (path) => {
      globalThis.__projectFileShellCalls.push({ action: 'open', path })
      return ''
    }
    shell.showItemInFolder = (path) => {
      globalThis.__projectFileShellCalls.push({ action: 'reveal', path })
    }
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
      window.setFocusable(false)
      window.setIgnoreMouseEvents(true)
      window.showInactive()
      if (window.webContents.getURL().includes('index.html')) window.setContentSize(1600, 1000)
    }
  })
  const api = (method, ...args) => win.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
  const route = (pathname) =>
    win.evaluate((pathname) => {
      window.location.hash = pathname
    }, pathname)
  const tree = win.getByTestId('project-files')
  const panel = win.getByTestId('project-file-panel')
  const preview = win.getByTestId('project-file-preview')
  const showProject = async () => {
    if (!(await tree.isVisible())) await win.getByRole('button', { name: '返回文件列表', exact: true }).click()
    await expect(tree).toBeVisible()
  }
  const showFile = async () => {
    await win.getByRole('tab', { name: '文件', exact: true }).click()
    await expect(panel).toBeVisible()
  }
  const refresh = async () => {
    await showProject()
    await tree.getByRole('button', { name: '刷新项目文件', exact: true }).click()
    await expect(tree.getByRole('button', { name: '刷新项目文件', exact: true })).toBeEnabled()
    await showFile()
  }
  const project = await api('projects.save', { name: 'Existing source tree', workingDirectory: root })
  const alternate = await api('projects.save', { name: 'Alternate source tree', workingDirectory: alternateRoot })
  const initialArtifacts = await api('artifacts.list')
  const initialImports = await api('files.list')
  assert.equal((await api('threads.list')).length, 0)
  await route(`/projects/${project.id}`)
  await expect(tree).toBeVisible()
  for (const name of ['README.md', 'data.json', 'page.html', 'binary.bin']) {
    await expect(tree.getByRole('button', { name: `查看文件 ${name}`, exact: true })).toBeVisible()
  }
  await expect(tree.getByRole('button', { name: '查看文件 .hidden-note', exact: true })).toHaveCount(0)
  await expect(tree.getByRole('button', { name: '查看文件 linked-file.txt', exact: true })).toHaveCount(0)
  await expect(tree.getByRole('button', { name: '展开文件夹 linked-directory', exact: true })).toHaveCount(0)
  await tree.getByRole('button', { name: '打开工作目录', exact: true }).click()
  await expect.poll(() => app.evaluate(() => globalThis.__projectFileShellCalls)).toContainEqual({ action: 'open', path: root })

  await tree.getByRole('button', { name: '查看文件 README.md', exact: true }).click()
  await expect(panel).toBeVisible()
  await expect(preview.getByRole('heading', { name: 'Existing project', exact: true })).toBeVisible()
  assert.equal(new URL(win.url().split('#')[1], 'http://local').searchParams.get('file'), 'README.md')
  await showProject()
  await tree.getByRole('button', { name: '展开文件夹 src', exact: true }).click()
  await tree.getByRole('button', { name: '查看文件 main.ts', exact: true }).click()
  await expect(preview).toContainText('export const projectMarker = "original source"')
  assert.equal(new URL(win.url().split('#')[1], 'http://local').searchParams.get('file'), 'src/main.ts')
  await showProject()
  await expect(tree.getByRole('button', { name: '收起文件夹 src', exact: true })).toBeVisible()
  await expect(tree.getByRole('button', { name: '查看文件 main.ts', exact: true })).toBeVisible()
  await showFile()
  const selectedUrl = win.url()
  await win.reload()
  await win.waitForFunction(() => !!window.api && !!document.querySelector('nav'))
  assert.equal(win.url(), selectedUrl)
  await expect(preview).toContainText('original source')

  await panel.getByRole('button', { name: '在文件夹中显示', exact: true }).click()
  await expect.poll(() => app.evaluate(() => globalThis.__projectFileShellCalls)).toContainEqual({ action: 'reveal', path: join(root, 'src', 'main.ts') })
  await showProject()
  await tree.getByRole('checkbox', { name: '显示隐藏文件', exact: true }).check()
  await expect(tree.getByRole('button', { name: '查看文件 .hidden-note', exact: true })).toBeVisible()
  await tree.getByRole('checkbox', { name: '显示隐藏文件', exact: true }).uncheck()
  await expect(tree.getByRole('button', { name: '查看文件 .hidden-note', exact: true })).toHaveCount(0)
  await showFile()

  // A preview refresh reads the actual file, and errors must replace any stale content.
  writeFileSync(join(root, 'src', 'main.ts'), 'export const projectMarker = "externally updated source"\n')
  await panel.getByRole('button', { name: '刷新文件预览', exact: true }).click()
  await expect(preview).toContainText('externally updated source')
  await expect(preview).not.toContainText('"original source"')
  unlinkSync(join(root, 'src', 'main.ts'))
  await refresh()
  await expect(panel.getByRole('alert')).toBeVisible()
  await expect(panel).not.toContainText('externally updated source')
  await assert.rejects(api('projectFiles.preview', project.id, 'src/main.ts'))

  // Matching relative paths in other projects or another binding must not reuse old bytes.
  await route(`/projects/${alternate.id}?file=README.md`)
  await expect(preview.getByRole('heading', { name: 'Alternate project', exact: true })).toBeVisible()
  await expect(preview).not.toContainText('Original documentation')
  await api('projects.save', { id: alternate.id, name: alternate.name, workingDirectory: root })
  await expect(preview.getByRole('heading', { name: 'Existing project', exact: true })).toBeVisible()
  await expect(preview).not.toContainText('Different root content')
  await win.getByRole('button', { name: '返回文件列表', exact: true }).click()
  await expect(tree).toBeVisible()
  assert.equal(new URL(win.url().split('#')[1], 'http://local').searchParams.get('panel'), 'project')

  const json = await api('projectFiles.preview', project.id, 'data.json')
  assert.equal(json.kind, 'json')
  assert.ok(json.text.includes('existing'))
  assert.equal((await api('projectFiles.preview', project.id, 'page.html')).kind, 'html')
  const binary = await api('projectFiles.preview', project.id, 'binary.bin')
  assert.equal(binary.kind, 'other')
  assert.ok(binary.message.includes('二进制'))
  const shellCount = (await app.evaluate(() => globalThis.__projectFileShellCalls)).length
  for (const unsafe of ['../secret.txt', 'src/../../secret.txt', join(outside, 'secret.txt'), '//absolute', 'C:\\outside\\secret.txt', 'bad\0name']) {
    await assert.rejects(api('projectFiles.list', project.id, unsafe), /文件路径/)
    await assert.rejects(api('projectFiles.preview', project.id, unsafe), /文件路径/)
    await assert.rejects(api('projectFiles.reveal', project.id, unsafe), /文件路径/)
  }
  for (const linked of ['linked-file.txt', 'linked-directory', 'linked-directory/secret.txt']) {
    await assert.rejects(api('projectFiles.list', project.id, linked), /符号链接/)
    await assert.rejects(api('projectFiles.preview', project.id, linked), /符号链接/)
    await assert.rejects(api('projectFiles.reveal', project.id, linked), /符号链接/)
  }
  assert.equal((await app.evaluate(() => globalThis.__projectFileShellCalls)).length, shellCount, 'invalid reveal requests never reach the shell')
  assert.ok((await api('projectFiles.list', project.id, '', true)).entries.every((entry) => !entry.name.startsWith('linked-')))

  // Projects without a binding browse the default workspace, still without importing files.
  mkdirSync(join(profile, 'workspace'), { recursive: true })
  writeFileSync(join(profile, 'workspace', 'default-note.md'), '# Default workspace note\n')
  const defaultProject = await api('projects.save', { name: 'Default workspace project' })
  const defaultListing = await api('projectFiles.list', defaultProject.id)
  assert.equal(defaultListing.root, realpathSync(join(profile, 'workspace')))
  assert.ok(defaultListing.entries.some((entry) => entry.name === 'default-note.md'))
  await route(`/projects/${defaultProject.id}`)
  await tree.getByRole('button', { name: '查看文件 default-note.md', exact: true }).click()
  await expect(preview.getByRole('heading', { name: 'Default workspace note', exact: true })).toBeVisible()
  assert.deepEqual(await api('artifacts.list'), initialArtifacts, 'browsing does not register outputs')
  assert.deepEqual(await api('files.list'), initialImports, 'browsing does not import files')
  assert.equal((await api('threads.list')).length, 0, 'existing files require no conversation')
  // Pagination and search work against a real 501-file directory.
  mkdirSync(join(root, 'many'))
  for (let index = 0; index < 501; index++) writeFileSync(join(root, 'many', `entry-${String(index).padStart(3, '0')}.txt`), `entry ${index}`)
  await route(`/projects/${project.id}`)
  await tree.getByRole('button', { name: '刷新项目文件', exact: true }).click()
  await tree.getByRole('button', { name: '展开文件夹 many', exact: true }).click()
  await expect(tree.getByRole('button', { name: '查看文件 entry-000.txt', exact: true })).toBeVisible()
  for (let index = 0; index < 5; index++) await tree.getByRole('button', { name: '加载更多', exact: true }).click()
  await expect(tree.getByRole('button', { name: '查看文件 entry-500.txt', exact: true })).toBeVisible()
  await tree.getByRole('textbox', { name: '搜索文件名或路径', exact: true }).fill('entry-500')
  await expect(tree.getByRole('button', { name: 'many/entry-500.txt', exact: true })).toBeVisible()
  await tree.getByRole('textbox', { name: '搜索文件名或路径', exact: true }).fill('')

  // References are stored without importing bytes, then capture the latest file at send time.
  const provider = await api('providers.save', { type: 'openai-compatible', name: 'File reference mock', baseURL: mock.url, apiKey: 'x' })
  await api('models.save', { providerId: provider.id, model: 'mock-1', displayName: 'Mock', supportsTools: true, supportsVision: false, isDefault: true })
  await tree.getByRole('button', { name: '查看文件 README.md', exact: true }).click()
  await panel.getByRole('button', { name: '添加到对话', exact: true }).click()
  const scope = { surface: 'main', projectId: project.id }
  await expect.poll(async () => (await api('drafts.get', scope)).projectFiles.length).toBe(1)
  assert.deepEqual(await api('files.list'), initialImports, 'adding a reference alone does not import content')
  const evidence = join(process.cwd(), '.superpowers/sdd/2026-11-05-reliability')
  mkdirSync(evidence, { recursive: true })
  await showProject()
  await tree.getByRole('textbox', { name: '搜索文件名或路径', exact: true }).fill('entry-500')
  await expect(tree.getByRole('button', { name: 'many/entry-500.txt', exact: true })).toBeVisible()
  await win.screenshot({ path: join(evidence, 'project-file-reference-search.png') })

  writeFileSync(join(root, 'README.md'), '# Latest send snapshot\n\nUPDATED BEFORE SEND\n')
  await win.locator('main textarea').fill('[plain] Read the referenced file')
  await win.getByTestId('project-composer').getByRole('button', { name: '发送', exact: true }).click()
  await expect.poll(async () => (await api('threads.list')).length, { timeout: 30000 }).toBe(1)
  const sentThread = (await api('threads.list'))[0]
  await expect
    .poll(async () => (await api('threads.state', sentThread.id)).messages.some((message) => message.role === 'user' && message.attachments?.length), {
      timeout: 30000,
    })
    .toBe(true)
  const sentMessage = (await api('threads.state', sentThread.id)).messages.find((message) => message.role === 'user')
  const attachment = sentMessage.attachments[0]
  assert.equal(attachment.source.path, 'README.md')
  assert.ok((await api('files.markdown', attachment.id)).includes('UPDATED BEFORE SEND'))
  writeFileSync(join(root, 'README.md'), '# Replaced after send\n')
  assert.ok((await api('files.markdown', attachment.id)).includes('UPDATED BEFORE SEND'), 'sent snapshot does not change with original file')
  console.log('PASS project files tree, preview, refresh, stale-content clearing, roots, shell stubs and traversal/symlink refusal')
} catch (error) {
  console.error(`FAIL project-files (profile: ${profile})`, error)
  process.exitCode = 1
} finally {
  await app?.close()
  await new Promise((resolve) => mock.server.close(resolve))
}
