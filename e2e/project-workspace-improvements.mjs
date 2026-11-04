// Isolated native-dialog fixtures and real local files exercise the project workspace UI.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect } from 'playwright/test'
import { mainWindow } from './helpers.mjs'

const profile = mkdtempSync(join(tmpdir(), 'navo-workspace-improvements-'))
const root = realpathSync(mkdtempSync(join(tmpdir(), 'navo-workspace-tree-')))
mkdirSync(join(root, 'src'))
writeFileSync(join(root, 'src', 'main.ts'), 'export const marker = "before external edit"\n')
for (let index = 0; index < 45; index++) writeFileSync(join(root, `note-${String(index).padStart(2, '0')}.md`), `# Note ${index}\n`)
let app
let win
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile, AB_MEMORY_IDLE_MS: '600000' } })
  win = await mainWindow(app)
  await win.emulateMedia({ reducedMotion: 'reduce' })
  await app.evaluate(({ BrowserWindow, dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] })
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.setBackgroundThrottling(false)
      window.setFocusable(false)
      window.setIgnoreMouseEvents(true)
      window.showInactive()
      if (window.webContents.getURL().includes('index.html')) window.setContentSize(1600, 1000)
    }
  })
  const api = (method, ...args) => win.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
  const route = (path) =>
    win.evaluate((path) => {
      window.location.hash = path
    }, path)
  const tree = win.getByTestId('project-files')
  const evidence = join(process.cwd(), '.superpowers/sdd/2026-11-04-workspace-improvements')
  mkdirSync(evidence, { recursive: true })
  const capture = async (name) => {
    const png = await app.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes('index.html'))
          .webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
      )
        .toPNG()
        .toString('base64'),
    )
    writeFileSync(join(evidence, name), Buffer.from(png, 'base64'))
  }
  const project = await api('projects.save', { name: 'Workspace improvements' })
  await route(`/projects/${project.id}`)
  await expect(tree).toBeVisible()

  // Overview is represented exactly once in expanded and collapsed navigation.
  const overview = win.locator('nav a[href="#/projects"]')
  await expect(overview).toHaveCount(1)
  await overview.click()
  await expect(win.locator('main').getByRole('button', { name: '新建项目', exact: true })).toBeVisible()
  await route(`/projects/${project.id}`)
  await win.getByRole('button', { name: '切换侧边栏', exact: true }).click()
  await expect(overview).toHaveCount(1)
  await overview.click()
  await expect(win.locator('main').getByRole('button', { name: '新建项目', exact: true })).toBeVisible()
  await route(`/projects/${project.id}`)
  await win.getByRole('button', { name: '切换侧边栏', exact: true }).click()

  // Resizing is accessible, persistent, and leaves room for the central conversation.
  const separator = win.getByRole('separator', { name: '调整工作区宽度', exact: true })
  await expect(separator).toHaveAttribute('aria-valuenow', '400')
  await separator.focus()
  await win.keyboard.press('ArrowLeft')
  await expect(separator).toHaveAttribute('aria-valuenow', '424')
  await win.keyboard.press('ArrowRight')
  await expect(separator).toHaveAttribute('aria-valuenow', '400')
  const handle = await separator.boundingBox()
  await win.mouse.move(handle.x + handle.width / 2, handle.y + 100)
  await win.mouse.down()
  await win.mouse.move(1050, handle.y + 100, { steps: 8 })
  await win.mouse.up()
  await expect(separator).toHaveAttribute('aria-valuenow', '550')
  await win.getByRole('button', { name: '收起工作区面板', exact: true }).last().click()
  await win.getByRole('button', { name: '打开工作区面板', exact: true }).click()
  await expect(separator).toHaveAttribute('aria-valuenow', '550')
  await win.reload()
  await expect(separator).toHaveAttribute('aria-valuenow', '550')
  const resizedHandle = await separator.boundingBox()
  await win.mouse.move(resizedHandle.x + resizedHandle.width / 2, resizedHandle.y + 100)
  await win.mouse.down()
  await win.mouse.move(0, resizedHandle.y + 100, { steps: 8 })
  await win.mouse.up()
  await expect.poll(async () => (await win.locator('main').boundingBox()).width).toBeGreaterThanOrEqual(440)
  assert.equal(await separator.getAttribute('aria-valuenow'), await separator.getAttribute('aria-valuemax'))
  await separator.dblclick()
  await expect(separator).toHaveAttribute('aria-valuenow', '400')

  // Canceling the native picker leaves the default binding intact.
  await tree.getByRole('button', { name: '选择文件夹', exact: true }).click()
  await expect(tree.getByRole('button', { name: '选择文件夹', exact: true })).toBeEnabled()
  assert.equal((await api('projects.get', project.id)).workingDirectory, null)
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] })
  }, root)
  await tree.getByRole('button', { name: '选择文件夹', exact: true }).click()
  await expect.poll(async () => (await api('projects.get', project.id)).workingDirectory).toBe(root)
  await expect(tree.getByRole('button', { name: '展开文件夹 src', exact: true })).toBeVisible()
  await capture('files-1600.png')
  await tree.getByRole('button', { name: '展开文件夹 src', exact: true }).click()
  await tree.getByRole('button', { name: '查看文件 main.ts', exact: true }).click()
  await expect(win.getByTestId('project-file-preview')).toContainText('before external edit')
  await win.getByRole('button', { name: '返回文件列表', exact: true }).click()
  await expect(tree.getByRole('button', { name: '收起文件夹 src', exact: true })).toBeVisible()
  await tree.getByRole('button', { name: '查看文件 note-40.md', exact: true }).scrollIntoViewIfNeeded()
  const scrollBefore = await tree.locator('[aria-busy]').evaluate((element) => element.scrollTop)
  assert.ok(scrollBefore > 0, 'fixture exercises a scrolled directory')
  await tree.getByRole('button', { name: '查看文件 note-40.md', exact: true }).click()
  await expect(win.getByTestId('project-file-preview')).toContainText('Note 40')
  await win.getByRole('button', { name: '下一个文件', exact: true }).click()
  await expect(win.getByTestId('project-file-preview')).toContainText('Note 41')
  await win.getByRole('button', { name: '上一个文件', exact: true }).click()
  await expect(win.getByTestId('project-file-preview')).toContainText('Note 40')
  await win.getByRole('button', { name: '返回文件列表', exact: true }).click()
  await expect.poll(() => tree.locator('[aria-busy]').evaluate((element) => element.scrollTop)).toBe(scrollBefore)

  // Returning to the app refreshes both the directory and selected file bytes.
  writeFileSync(join(root, 'external.md'), '# Added outside Navo\n')
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(tree.getByRole('button', { name: '查看文件 external.md', exact: true })).toBeAttached()
  await tree.getByRole('button', { name: '查看文件 main.ts', exact: true }).click()
  writeFileSync(join(root, 'src', 'main.ts'), 'export const marker = "after external edit"\n')
  await win.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect(win.getByTestId('project-file-preview')).toContainText('after external edit')

  // The small-window overlay can close, restore focus and reopen the same file.
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().includes('index.html'))
    window.setMinimumSize(0, 0)
    window.setContentSize(800, 600)
  })
  await expect.poll(() => win.evaluate(() => innerWidth)).toBe(800)
  await expect(win.getByTestId('project-file-panel')).toBeVisible()
  await capture('preview-800.png')
  const bounds = await win.getByTestId('project-file-panel').boundingBox()
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 801 && bounds.height <= 601, `overlay remains within the viewport: ${JSON.stringify(bounds)}`)
  await win.getByRole('button', { name: '收起工作区面板', exact: true }).last().click()
  await expect(win.getByTestId('project-file-panel')).toBeHidden()
  const reopen = win.getByRole('button', { name: '打开工作区面板', exact: true })
  await expect(reopen).toBeFocused()
  await reopen.click()
  await expect(win.getByTestId('project-file-preview')).toContainText('after external edit')
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('project-file-panel')).toBeHidden()
  await expect(reopen).toBeFocused()
  // An ordinary project route starts with usable central content at narrow widths.
  await route(`/projects/${project.id}`)
  await expect(win.getByTestId('project-inspector')).toBeHidden()
  await expect(win.getByTestId('project-composer')).toBeVisible()
  await reopen.click()
  await expect(tree).toBeVisible()
  await win.keyboard.press('Escape')
  await expect(win.getByTestId('project-inspector')).toBeHidden()
  await expect(reopen).toBeFocused()
  assert.equal((await api('threads.list')).length, 0)
  assert.equal((await api('artifacts.list')).length, 0)
  console.log('PASS workspace navigation deduplication, directory selection/cancel, tree restoration, focus refresh and narrow overlay focus')
} catch (error) {
  console.error(`FAIL project-workspace-improvements (profile: ${profile})`, error)
  process.exitCode = 1
} finally {
  await app?.close()
}
