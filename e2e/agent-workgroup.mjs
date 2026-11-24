import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _electron as electron } from 'playwright'
import { mainWindow } from './helpers.mjs'
import { startMock } from './mock-llm.mjs'

const mock = startMock(39148)
const userData = mkdtempSync(join(tmpdir(), 'navo-agent-workgroup-'))
const app = await electron.launch({ args: ['.'], env: { ...process.env, AB_USER_DATA: userData } })

try {
  const page = await mainWindow(app)
  const api = (method, ...args) => page.evaluate(([name, values]) => window.api.invoke(name, ...values), [method, args])
  await page.evaluate(() => {
    window.__events = []
    window.api.on('chat.event', (event) => window.__events.push(event))
  })

  const provider = await api('providers.save', { type: 'openai-compatible', name: 'Workgroup mock', baseURL: mock.url, apiKey: 'x' })
  const coordinatorModel = await api('models.save', {
    providerId: provider.id,
    model: 'mock-1',
    displayName: 'Coordinator model',
    supportsTools: true,
    supportsVision: false,
    isDefault: true,
  })
  const memberModel = await api('models.save', {
    providerId: provider.id,
    model: 'mock-2',
    displayName: 'Member model',
    supportsTools: true,
    supportsVision: false,
  })
  const secondMemberModel = await api('models.save', {
    providerId: provider.id,
    model: 'mock-3',
    displayName: 'Second member model',
    supportsTools: true,
    supportsVision: false,
  })
  const member = await api('agents.save', {
    name: 'Research member',
    description: '研究页面并整理可核验的事实。',
    instructions: '先读取页面，再把结论写进项目工作区。',
    runtimeId: 'builtin',
    modelId: memberModel.id,
    infrastructure: { skillIds: [], mcpServerIds: [], connectorIds: [], pluginIds: [] },
  })
  const secondMember = await api('agents.save', {
    name: 'Second member',
    description: '独立完成另一个子任务并返回明确标记。',
    instructions: '[member-two] 返回你的成员标记。',
    runtimeId: 'builtin',
    modelId: secondMemberModel.id,
    infrastructure: { skillIds: [], mcpServerIds: [], connectorIds: [], pluginIds: [] },
  })
  const coordinator = (await api('agents.list')).find((agent) => agent.id === 'navo-assistant')
  assert.ok(coordinator, 'the built-in Navo assistant exists')

  const project = await api('projects.save', { name: 'Workgroup E2E', description: '验证协调员真实调度项目成员。' })
  await api('projects.setAgents', project.id, coordinator.id, [coordinator.id, member.id, secondMember.id])
  const orderedMembers = (await api('projects.get', project.id)).agents.filter((binding) => binding.role === 'member')
  const firstMemberName = orderedMembers[0].agent.name
  const firstMemberModel = orderedMembers[0].agent.modelId === memberModel.id ? 'mock-2' : 'mock-3'
  const thread = await api('threads.create', coordinatorModel.id, project.id, 'builtin')
  await api('chat.send', thread.id, '[workgroup] 让工作组成员完成页面研究并写入文件')

  for (let i = 0; i < 80; i++) {
    const done = await page.evaluate(() => window.__events.some((event) => event.type === 'run_end'))
    if (done) break
    await page.waitForTimeout(250)
  }

  const events = await page.evaluate(() => window.__events)
  const state = await api('threads.state', thread.id)
  assert.equal(events.filter((event) => event.type === 'error').length, 0, JSON.stringify(events.filter((event) => event.type === 'error')))
  assert.ok(
    events.some((event) => event.type === 'message' && event.message?.role === 'assistant' && event.message.toolCalls?.some((call) => call.name === 'task')),
    'coordinator delegates through the task tool',
  )
  assert.ok(
    events.some((event) => event.agentName === firstMemberName),
    'subagent events carry the workgroup member name',
  )
  assert.equal(
    state.messages.flatMap((message) => message.toolCalls ?? []).find((call) => call.name === 'task')?.activity?.label,
    `委派给 ${firstMemberName}`,
    'the persisted task card keeps the workgroup member name',
  )
  assert.ok(state.messages.at(-1)?.role === 'assistant' && state.messages.at(-1).content.includes('工作组已汇总'), 'coordinator returns the combined answer')
  assert.ok(
    mock.requests.some((request) => request.model === firstMemberModel),
    'the member uses its own model',
  )
  assert.ok(existsSync(join(userData, 'workspace', 'answer.txt')), 'the member can write through the shared project workspace')
  assert.equal(readFileSync(join(userData, 'workspace', 'answer.txt'), 'utf8'), 'Hello Agent')

  await page.evaluate(() => (window.__events = []))
  const parallelThread = await api('threads.create', coordinatorModel.id, project.id, 'builtin')
  await api('chat.send', parallelThread.id, '[workgroup-parallel] 同时让两位成员独立处理')
  for (let i = 0; i < 80; i++) {
    const done = await page.evaluate(() => window.__events.some((event) => event.type === 'run_end'))
    if (done) break
    await page.waitForTimeout(250)
  }
  const parallelEvents = await page.evaluate(() => window.__events)
  assert.equal(parallelEvents.filter((event) => event.type === 'error').length, 0)
  const memberTwoName = orderedMembers.find((binding) => binding.agent.id === secondMember.id)?.agent.name
  assert.ok(
    parallelEvents.some(
      (event) => event.type === 'message' && event.message?.agentName === memberTwoName && event.message.content.includes('member-two-result'),
    ),
    'parallel subagent results are attributed to the correct member',
  )
  assert.equal(new Set(parallelEvents.filter((event) => event.agentName).map((event) => event.agentName)).size, 2, 'both members stream independently')
  assert.ok(
    mock.requests.some((request) => request.model === 'mock-3'),
    'each member can use a different model',
  )

  console.log('PASS project workgroup delegates to isolated members, supports parallel work, and merges the result')
} finally {
  await app.close()
  await new Promise((resolve, reject) => mock.server.close((error) => (error ? reject(error) : resolve())))
}
