// Fake vendor protocol processes, real Navo tools and approvals, isolated app profiles.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from 'playwright/test'
import { mainWindow } from './helpers.mjs'

const site = createServer((_req, res) =>
  res.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Navo tool bridge</title><h1>Navo local tool fixture</h1>'),
)
await new Promise((done) => site.listen(0, '127.0.0.1', done))
const siteUrl = `http://127.0.0.1:${site.address().port}/`
const fixture = resolve('e2e/fixtures/runtime-tool-client.cjs')
const engines = process.argv[2] ? [process.argv[2]] : ['claude', 'codex']
assert.ok(engines.every((engine) => ['claude', 'codex'].includes(engine)))

try {
  for (const engine of engines) {
    const profile = mkdtempSync(join(tmpdir(), `navo-tool-bridge-${engine}-`))
    const logPath = join(profile, 'fixture.jsonl')
    writeFileSync(logPath, '')
    let app, page
    const api = (method, ...args) => page.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
    const launch = async () => {
      app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile, AB_MEMORY_IDLE_MS: '600000', NAVO_BRIDGE_TEST_SITE: siteUrl } })
      page = await mainWindow(app)
      await app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.setBackgroundThrottling(false)
          window.setFocusable(false)
          window.setIgnoreMouseEvents(true)
        }
      })
      await page.evaluate(() => {
        window.__bridgeEvents = []
        window.api.on('chat.event', (event) => window.__bridgeEvents.push(event))
      })
    }
    const state = (id) => api('threads.state', id)
    const showThread = async (id) => {
      await page.evaluate((threadId) => {
        window.location.hash = `/chat/${threadId}`
      }, id)
    }
    const pendingUi = () => page.getByRole('button', { name: /写入文件.*等待确认/ })
    const noPendingUi = async () => {
      await expect(pendingUi()).toHaveCount(0)
      await expect(page.getByRole('button', { name: '批准执行', exact: true })).toHaveCount(0)
      await expect(page.getByTestId('tool-activity-group')).not.toContainText('等待确认')
    }
    const file = (marker) => join(profile, 'workspace', `${marker}.txt`)
    const logs = () =>
      readFileSync(logPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    const submit = (marker, scenario = 'write', threadId) =>
      api('chat.submit', { requestId: `${engine}-${marker}`, runtimeId: engine, threadId, text: `TEST:${scenario}:${marker}` })
    const waiting = async (id) => {
      await expect.poll(async () => (await state(id)).interrupt?.actionRequests[0]?.name, { timeout: 30_000 }).toBe('write_file')
      await expect.poll(async () => (await state(id)).running).toBe(false)
      return (await state(id)).interrupt
    }
    const finished = async (id, marker, prefix = 'DONE') => {
      await expect
        .poll(async () => (await state(id)).messages.some((message) => message.role === 'assistant' && message.content === `${prefix}:${engine}:${marker}`), {
          timeout: 30_000,
        })
        .toBe(true)
      await expect.poll(async () => (await state(id)).running).toBe(false)
    }
    try {
      await launch()
      assert.equal((await api('models.list')).length, 0)
      await api('settings.set', { approvalTools: ['write_file'] })
      await api('memory.save', { kind: 'knowledge', title: 'bridge-fixture', content: 'Navo MCP bridge fixture memory' })
      const runtime = (await api('runtimes.list')).find((item) => item.profile.id === engine)
      await api('runtimes.save', { ...runtime.profile, enabled: true, command: process.execPath, args: [fixture, engine, logPath] })

      // Real memory and browser calls precede the persisted file approval.
      const first = await submit('approved', 'full')
      const approval = await waiting(first.threadId)
      assert.equal(existsSync(file('approved')), false)
      const before = await state(first.threadId)
      assert.ok(before.messages.some((message) => message.role === 'tool' && message.toolName === 'memory_search' && message.status !== 'error'))
      assert.ok(
        before.messages.some(
          (message) => message.role === 'tool' && message.toolName === 'browser_navigate' && message.content.includes('Navo local tool fixture'),
        ),
      )
      await api('chat.resume', first.threadId, [{ type: 'approve' }], [], approval.id)
      await finished(first.threadId, 'approved')
      assert.equal(readFileSync(file('approved'), 'utf8'), `Generated through ${engine} Navo MCP bridge`)
      const artifacts = await api('artifacts.query', { threadId: first.threadId, q: 'approved.txt' })
      assert.equal(artifacts.items.length, 1)
      assert.equal(artifacts.items[0].name, 'approved.txt')
      console.log(`PASS ${engine}: real memory/browser/write_file, approval-before-effect, Artifacts, no Navo model`)

      // Long uploads remain outside the inline preview and are read through the real virtual filesystem.
      await api('settings.set', { approvalTools: [] })
      const uploadSource = join(profile, 'long-upload.txt')
      writeFileSync(
        uploadSource,
        `${Array.from({ length: 1200 }, (_, index) => `Line ${index}: ${'offline upload fixture '.repeat(4)}`).join('\n')}\nUPLOAD-TAIL-7F29\n`,
      )
      const [upload] = await api('files.addPaths', [uploadSource])
      await expect.poll(async () => (await api('files.get', upload.id)).status, { timeout: 30_000 }).toBe('ready')
      const originalUpload = await api('files.markdown', upload.id)
      const uploadTurn = await api('chat.submit', {
        requestId: `${engine}-upload-tail`,
        runtimeId: engine,
        text: 'TEST:upload:upload-tail',
        fileIds: [upload.id],
      })
      await finished(uploadTurn.threadId, 'upload-tail')
      const uploadState = await state(uploadTurn.threadId)
      assert.ok(
        uploadState.messages.some((message) => message.role === 'tool' && message.toolName === 'read_file' && message.content.includes('UPLOAD-TAIL-7F29')),
      )
      assert.equal(
        uploadState.messages.filter((message) => message.role === 'tool' && message.toolName === 'write_file' && message.status === 'error').length,
        2,
      )
      assert.equal(await api('files.markdown', upload.id), originalUpload)
      assert.equal(existsSync(join(profile, 'skills', 'bridge-blocked.md')), false)
      assert.equal((await api('artifacts.query', { threadId: uploadTurn.threadId })).items.length, 0)
      await api('settings.set', { approvalTools: ['write_file'] })
      console.log(`PASS ${engine}: paged upload tail read, upload/skills write denial and no accidental artifact`)

      // Each new native process must resume the same vendor session.
      await submit('continued', 'plain', first.threadId)
      await finished(first.threadId, 'continued')
      const firstLog = logs().find((item) => item.event === 'prompt' && item.marker === 'approved')
      const continuedLog = logs().find((item) => item.event === 'prompt' && item.marker === 'continued')
      assert.equal(continuedLog.sessionId, firstLog.sessionId)
      assert.equal(continuedLog.resumed, true)

      const denied = await submit('denied')
      const deniedApproval = await waiting(denied.threadId)
      await api('chat.resume', denied.threadId, [{ type: 'reject', message: 'Do not write' }], [], deniedApproval.id)
      await finished(denied.threadId, 'denied', 'DENIED')
      assert.equal(existsSync(file('denied')), false)

      const cancelled = await submit('cancelled')
      const cancelledApproval = await waiting(cancelled.threadId)
      await showThread(cancelled.threadId)
      await expect(pendingUi()).toBeVisible()
      await api('chat.stop', cancelled.threadId)
      await expect.poll(async () => (await state(cancelled.threadId)).interrupt).toBeNull()
      await assert.rejects(api('chat.resume', cancelled.threadId, [{ type: 'approve' }], [], cancelledApproval.id))
      assert.equal(existsSync(file('cancelled')), false)
      await noPendingUi()
      console.log(`PASS ${engine}: native session resume, rejected tool, cancelled approval cannot execute`)

      const disabled = await submit('disabled')
      const disabledApproval = await waiting(disabled.threadId)
      await showThread(disabled.threadId)
      await expect(pendingUi()).toBeVisible()
      const currentProfile = (await api('runtimes.list')).find((item) => item.profile.id === engine).profile
      await api('runtimes.save', { ...currentProfile, enabled: false })
      await api('chat.resume', disabled.threadId, [{ type: 'approve' }], [], disabledApproval.id)
      await expect
        .poll(async () =>
          page.evaluate(
            (id) => window.__bridgeEvents.some((event) => event.threadId === id && event.type === 'error' && /disabled/i.test(event.error)),
            disabled.threadId,
          ),
        )
        .toBe(true)
      await expect.poll(async () => (await state(disabled.threadId)).interrupt).toBeNull()
      await expect.poll(async () => (await state(disabled.threadId)).running).toBe(false)
      await noPendingUi()
      assert.equal(existsSync(file('disabled')), false)
      await api('runtimes.save', { ...currentProfile, enabled: true })
      await assert.rejects(api('chat.resume', disabled.threadId, [{ type: 'approve' }], [], disabledApproval.id))
      console.log(`PASS ${engine}: disabling before approval stops the pending engine and clears stale approval UI`)

      const disconnected = await submit('disconnected')
      const oldApproval = await waiting(disconnected.threadId)
      await app.close()
      await launch()
      const recovered = await state(disconnected.threadId)
      assert.equal(recovered.interrupt, null)
      assert.ok(recovered.messages.some((message) => message.runtimeWarning === 'runtime_disconnected'))
      await assert.rejects(api('chat.resume', disconnected.threadId, [{ type: 'approve' }], [], oldApproval.id))
      assert.equal(existsSync(file('disconnected')), false)
      await showThread(disconnected.threadId)
      await expect(page.getByRole('alert').filter({ hasText: '运行时连接已中断' })).toBeVisible()
      await noPendingUi()
      const fresh = await submit('after-restart', 'plain')
      await finished(fresh.threadId, 'after-restart')
      console.log(`PASS ${engine}: restart invalidates stale approval without replay and new conversation works`)

      const malformed = await submit('malformed', 'markup')
      await expect
        .poll(async () => (await state(malformed.threadId)).messages.some((message) => message.runtimeWarning === 'unexecuted_tool_markup'), {
          timeout: 30_000,
        })
        .toBe(true)
      await expect.poll(async () => (await state(malformed.threadId)).running).toBe(false)
      const normalized = await state(malformed.threadId)
      assert.ok(normalized.messages.every((message) => !message.toolCalls?.length))
      assert.equal(existsSync(join(profile, 'workspace', 'should-not-exist.txt')), false)
      await page.evaluate((id) => {
        window.location.hash = `/chat/${id}`
      }, malformed.threadId)
      await expect(page.getByRole('alert').filter({ hasText: '模型返回了未识别的工具调用格式' })).toBeVisible()
      await expect(page.locator('main')).not.toContainText('DSML')
      console.log(`PASS ${engine}: malformed DSML stays unexecuted and warning replaces raw markup`)
    } catch (error) {
      console.error(`FAIL ${engine} runtime tool bridge (${profile})`, error)
      throw error
    } finally {
      await app?.close().catch(() => undefined)
    }
  }
} finally {
  site.close()
}
