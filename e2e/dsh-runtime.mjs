import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, expect } from 'playwright/test'
import { mainWindow } from './helpers.mjs'

const profile = mkdtempSync(join(tmpdir(), 'navo-dsh-'))
let app
const launch = async () => {
  app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: profile } })
  const page = await mainWindow(app)
  return (method, ...args) => page.evaluate(([method, args]) => window.api.invoke(method, ...args), [method, args])
}
const finish = async (api, threadId, expected) => {
  await expect
    .poll(async () => (await api('threads.state', threadId)).messages.some((message) => message.role === 'assistant' && message.content === expected))
    .toBe(true)
  await expect.poll(async () => (await api('threads.state', threadId)).running).toBe(false)
}
try {
  let api = await launch()
  const { profile: config, capabilities } = (await api('runtimes.list')).find(({ profile }) => profile.id === 'dsh')
  assert.equal(capabilities.navoTools, false)
  await api('runtimes.save', {
    ...config,
    enabled: true,
    command: process.execPath,
    args: [resolve('e2e/fixtures/runtime-dsh.cjs')],
    model: 'fixture-model',
    provider: 'fixture-provider',
  })
  assert.equal((await api('runtimes.probe', 'dsh')).available, true)
  const { threadId } = await api('chat.submit', { requestId: 'dsh-first', runtimeId: 'dsh', text: 'first-turn' })
  await finish(api, threadId, 'DSH new first-turn')
  await app.close()
  api = await launch()
  await api('chat.submit', { requestId: 'dsh-second', threadId, text: 'second-turn' })
  await finish(api, threadId, 'DSH resumed second-turn')
  console.log('PASS DSH SDK protocol fixture: version probe, model-free Navo chat and native session resume after app restart')
} finally {
  await app?.close()
  rmSync(profile, { recursive: true, force: true })
}
