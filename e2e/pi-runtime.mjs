// Built-in Pi Core smoke test using the existing offline OpenAI-compatible mock.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron, expect } from 'playwright/test'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const mock = startMock(39061)
const userData = mkdtempSync(join(tmpdir(), 'navo-pi-core-'))
let app
const commandBin = join(userData, 'test-bin')
mkdirSync(commandBin)
writeFileSync(join(commandBin, 'navo-command-path-marker'), '#!/bin/sh\nprintf navo-path-marker\n', { mode: 0o755 })
try {
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: userData, AB_MEMORY_IDLE_MS: '600000', AB_EXTRA_PATH: commandBin } })
  const page = await mainWindow(app)
  const api = (method, ...args) => page.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
  await page.evaluate(() => {
    window.__piEvents = []
    window.api.on('chat.event', (event) => window.__piEvents.push(event))
  })
  const provider = await api('providers.save', { type: 'openai-compatible', name: 'Pi fixture', baseURL: mock.url, apiKey: 'fixture' })
  const model = await api('models.save', {
    providerId: provider.id,
    model: 'mock-1',
    displayName: 'Pi fixture model',
    supportsTools: true,
    supportsVision: false,
    enabled: true,
  })
  const runtime = await api('runtimes.save', { id: 'pi', kind: 'pi', name: 'Pi Coding Agent', enabled: true, command: '', args: [] })
  assert.equal(runtime.profile.enabled, true)
  await api('models.setDefault', model.id)
  // New drafts have no explicit model selection even though the composer displays the default.
  for (const runtimeId of ['builtin', 'pi']) {
    const project = await api('projects.save', { name: `Default model ${runtimeId}` })
    const scope = { surface: 'main', projectId: project.id }
    const initial = await api('drafts.get', scope)
    assert.equal(initial.modelId, null)
    const draft = await api('drafts.save', {
      scope,
      text: `[plain] default-model-${runtimeId}`,
      fileIds: [],
      projectFiles: [],
      modelId: null,
      runtimeId,
      expectedVersion: initial.version,
    })
    const receipt = await api('chat.submit', {
      requestId: `default-model-${runtimeId}`,
      runtimeId,
      projectId: project.id,
      text: draft.text,
      draft: { scope, version: draft.version },
    })
    await expect
      .poll(
        async () => (await api('threads.state', receipt.threadId)).messages.some((message) => message.role === 'assistant' && message.content.includes('好的')),
        { timeout: 30_000 },
      )
      .toBe(true)
    await expect.poll(async () => (await api('threads.state', receipt.threadId)).running).toBe(false)
    const savedThread = (await api('threads.list')).find((item) => item.id === receipt.threadId)
    assert.equal(savedThread.modelId, model.id)
    assert.equal(savedThread.runtimeId, runtimeId)
    assert.equal((await api('drafts.get', scope)).text, '')
    assert.ok(mock.requests.some((request) => request.model === 'mock-1' && JSON.stringify(request.messages).includes(`default-model-${runtimeId}`)))
  }
  console.log('PASS builtin/Pi new drafts without modelId capture and run the default model')

  const thread = await api('threads.create', model.id, null, 'pi')
  await api('chat.send', thread.id, '[plain] answer through built-in Pi')
  await page.waitForFunction((id) => window.__piEvents.some((event) => event.type === 'run_end' && event.threadId === id), thread.id, { timeout: 20_000 })
  const state = await api('threads.state', thread.id)
  assert.ok(state.messages.some((message) => message.role === 'assistant' && message.content.includes('好的')))
  assert.ok((await page.evaluate(() => window.__piEvents)).some((event) => event.type === 'token'))

  if (process.platform !== 'win32') {
    const workspace = join(userData, 'workspace')
    writeFileSync(join(workspace, 'existing.txt'), 'pre-existing file')
    const ask = async (scenario) => {
      const { id } = await api('threads.create', model.id, null, 'pi')
      await api('chat.send', id, `[local-command:${scenario}]`)
      await expect.poll(async () => (await api('threads.state', id)).interrupt?.actionRequests[0]?.name, { timeout: 15_000 }).toBe('run_command')
      await expect.poll(async () => (await api('threads.state', id)).running).toBe(false)
      return id
    }
    const complete = async (id) => {
      await expect
        .poll(async () =>
          (await api('threads.state', id)).messages.some((message) => message.role === 'assistant' && message.content === 'Command fixture complete'),
        )
        .toBe(true)
      await expect.poll(async () => (await api('threads.state', id)).running).toBe(false)
      return (await api('threads.state', id)).messages.findLast((message) => message.role === 'tool' && message.toolName === 'run_command')
    }
    const rejected = await ask('binary')
    await api('chat.resume', rejected, [{ type: 'reject' }])
    assert.equal((await complete(rejected)).status, 'error')
    assert.equal(existsSync(join(workspace, 'command.bin')), false)

    const approved = await ask('binary')
    assert.equal(existsSync(join(workspace, 'command.bin')), false)
    await api('chat.resume', approved, [{ type: 'approve' }])
    assert.equal((await complete(approved)).status, 'success')
    assert.deepEqual(readFileSync(join(workspace, 'command.bin')), Buffer.from([0, 255]))
    assert.deepEqual(
      (await api('artifacts.query', { threadId: approved })).items.map((item) => item.name),
      ['command.bin'],
    )

    const failure = await ask('fail')
    await api('chat.resume', failure, [{ type: 'approve' }])
    const failed = await complete(failure)
    assert.equal(failed.status, 'error')
    assert.equal(JSON.parse(failed.content).exitCode, 7)
    assert.equal((await api('tools.audit', failure)).find((record) => record.toolName === 'run_command').status, 'error')

    const pathTest = await ask('path')
    await api('chat.resume', pathTest, [{ type: 'approve' }])
    assert.equal(JSON.parse((await complete(pathTest)).content).stdout, 'navo-path-marker')

    if (process.env.NAVO_PI_TEST_DOCKER === '1') {
      const docker = await ask('docker')
      await api('chat.resume', docker, [{ type: 'approve' }])
      const result = await complete(docker)
      assert.equal(result.status, 'success', result.content)
      assert.ok(readFileSync(join(workspace, 'navo-docker-test.tar')).length > 512)
      assert.deepEqual(
        (await api('artifacts.query', { threadId: docker })).items.map((item) => item.name),
        ['navo-docker-test.tar'],
      )
      console.log('PASS Pi local Docker: saved the pre-existing hello-world image to a TAR artifact')
    }

    const cancelled = await ask('cancel')
    await api('chat.resume', cancelled, [{ type: 'approve' }])
    await expect.poll(() => existsSync(join(workspace, 'command-started'))).toBe(true)
    await api('chat.stop', cancelled)
    await expect.poll(async () => (await api('threads.state', cancelled)).running).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 3200))
    assert.equal(existsSync(join(workspace, 'command-late')), false)
    await expect.poll(async () => (await api('tools.audit', cancelled)).find((record) => record.toolName === 'run_command')?.status).toBe('cancelled')
    console.log('PASS Pi local command: approval, rejection, cancellation, PATH, exit status and binary Artifacts')
  }

  await api('settings.set', { approvalTools: ['browser_navigate'] })
  const approvalThread = await api('threads.create', model.id, null, 'pi')
  await api('chat.send', approvalThread.id, '打开页面并告诉我标题')
  await page.waitForFunction((id) => window.__piEvents.some((event) => event.type === 'interrupt' && event.threadId === id), approvalThread.id, {
    timeout: 20_000,
  })
  const pending = await api('threads.state', approvalThread.id)
  assert.equal(pending.interrupt?.actionRequests[0]?.name, 'browser_navigate')
  await api('chat.resume', approvalThread.id, [{ type: 'approve' }])
  await expect
    .poll(
      async () =>
        (await api('threads.state', approvalThread.id)).messages.some(
          (message) => message.role === 'assistant' && message.content.includes('已写入 /workspace/answer.txt'),
        ),
      { timeout: 30_000 },
    )
    .toBe(true)
  await expect.poll(async () => (await api('threads.state', approvalThread.id)).running).toBe(false)
  const resumed = await api('threads.state', approvalThread.id)
  assert.equal(resumed.interrupt, null)
  console.log('PASS built-in Pi model mapping, Navo tool bridge, approval pause and resume')

  const cancelledThread = await api('threads.create', model.id, null, 'pi')
  await api('chat.send', cancelledThread.id, 'Cancel this navigation at approval')
  await expect
    .poll(async () => (await api('threads.state', cancelledThread.id)).interrupt?.actionRequests[0]?.name, { timeout: 20_000 })
    .toBe('browser_navigate')
  await expect.poll(async () => (await api('threads.state', cancelledThread.id)).running).toBe(false)
  const cancelledApproval = (await api('threads.state', cancelledThread.id)).interrupt
  await api('chat.stop', cancelledThread.id)
  await expect.poll(async () => (await api('threads.state', cancelledThread.id)).interrupt).toBeNull()
  await assert.rejects(api('chat.resume', cancelledThread.id, [{ type: 'approve' }], [], cancelledApproval.id), /no longer pending/i)
  await expect.poll(async () => (await api('threads.state', cancelledThread.id)).running).toBe(false)
  const afterStop = await api('threads.state', cancelledThread.id)
  assert.ok(!afterStop.messages.some((message) => message.role === 'tool' && message.toolName === 'browser_navigate' && message.status === 'success'))
  const continuing = await api('chat.submit', { requestId: 'pi-after-cancel', threadId: cancelledThread.id, text: '[plain] continue after cancelled approval' })
  await expect
    .poll(
      async () => {
        const messages = (await api('threads.state', cancelledThread.id)).messages
        const userIndex = messages.findIndex((message) => message.id === continuing.messageId)
        return userIndex >= 0 && messages.slice(userIndex + 1).some((message) => message.role === 'assistant' && message.content.includes('好的'))
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  await expect.poll(async () => (await api('threads.state', cancelledThread.id)).running).toBe(false)
  assert.equal((await api('threads.state', cancelledThread.id)).interrupt, null)
  await assert.rejects(api('chat.resume', cancelledThread.id, [{ type: 'approve' }], [], cancelledApproval.id), /no longer pending/i)
  console.log('PASS Pi worker cancellation clears approval, rejects stale resume and allows a fresh message')

  // Reproduce a cancelled tool whose outcome was persisted, but whose inFlight guard remains.
  // Recovery must continue the newly saved message without replaying that old file write.
  const unknownThread = await api('threads.create', model.id, null, 'pi')
  await app.evaluate(({ app }, threadId) => {
    const { createRequire } = globalThis.require('node:module')
    const { join } = globalThis.require('node:path')
    const require = createRequire(join(app.getAppPath(), 'package.json'))
    const Database = require('better-sqlite3')
    const database = new Database(join(app.getPath('userData'), 'agent.db'))
    const args = { file_path: '/workspace/unknown-tool-must-not-replay.txt', content: 'Do not replay this write' }
    const content = 'Operation stopped while executing. Its outcome is unknown; do not automatically repeat it.'
    const timestamp = Date.now()
    try {
      database.prepare('INSERT INTO kv(key,value) VALUES(?,?)').run(
        `pi.state:${threadId}`,
        JSON.stringify({
          inFlight: 'unknown-write',
          pending: null,
          messages: [
            { role: 'user', content: 'Old cancelled turn', timestamp },
            {
              role: 'assistant',
              content: [{ type: 'toolCall', id: 'unknown-write', name: 'write_file', arguments: args }],
              api: 'openai-completions',
              provider: 'openai',
              model: 'mock-1',
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
              stopReason: 'toolUse',
              timestamp,
            },
            { role: 'toolResult', toolCallId: 'unknown-write', toolName: 'write_file', content: [{ type: 'text', text: content }], isError: true, timestamp },
          ],
          ui: [
            { id: 'old-user', role: 'user', content: 'Old cancelled turn' },
            { id: 'old-assistant', role: 'assistant', content: '', toolCalls: [{ id: 'unknown-write', name: 'write_file', args }] },
            {
              id: 'old-result',
              role: 'tool',
              toolCallId: 'unknown-write',
              toolName: 'write_file',
              content,
              status: 'error',
              runtimeWarning: 'tool_outcome_unknown',
            },
          ],
        }),
      )
    } finally {
      database.close()
    }
  }, unknownThread.id)
  await page.evaluate((id) => {
    window.location.hash = `/chat/${id}`
  }, unknownThread.id)
  const saved = await api('chat.submit', {
    requestId: 'pi-unknown-recovery',
    threadId: unknownThread.id,
    text: '[plain] recover this saved message',
  })
  await expect.poll(async () => (await api('threads.state', unknownThread.id)).recoverableMessageIds).toContain(saved.messageId)
  await expect.poll(async () => (await api('threads.state', unknownThread.id)).running).toBe(false)
  await expect(page.getByText('A Pi tool outcome is unknown after interruption; it will not be executed again automatically', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: '继续已保存的消息', exact: true }).click()
  await expect
    .poll(
      async () => {
        const state = await api('threads.state', unknownThread.id)
        const index = state.messages.findIndex((message) => message.id === saved.messageId)
        return (
          !state.running && index >= 0 && state.messages.slice(index + 1).some((message) => message.role === 'assistant' && message.content.includes('好的'))
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  const recovered = await api('threads.state', unknownThread.id)
  assert.equal(recovered.messages.filter((message) => message.id === saved.messageId).length, 1)
  assert.deepEqual(recovered.recoverableMessageIds, [])
  assert.equal(existsSync(join(userData, 'workspace', 'unknown-tool-must-not-replay.txt')), false)
  await expect(page.getByRole('button', { name: '继续已保存的消息', exact: true })).toBeHidden()
  const followup = await api('chat.submit', {
    requestId: 'pi-after-unknown-recovery',
    threadId: unknownThread.id,
    text: '[plain] ordinary message after recovery',
  })
  await expect
    .poll(
      async () => {
        const state = await api('threads.state', unknownThread.id)
        const index = state.messages.findIndex((message) => message.id === followup.messageId)
        return (
          !state.running && index >= 0 && state.messages.slice(index + 1).some((message) => message.role === 'assistant' && message.content.includes('好的'))
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  assert.equal(existsSync(join(userData, 'workspace', 'unknown-tool-must-not-replay.txt')), false)
  console.log('PASS Pi unknown-outcome UI recovery continues saved message once, never replays old tool, and accepts the next message')
} catch (error) {
  console.error('FAIL pi-runtime', error)
  process.exitCode = 1
} finally {
  await app?.close().catch(() => undefined)
  mock.server.close()
}
