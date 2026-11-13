import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExternalRuntimeContext } from '../src/main/agent-runtime/types'
import type { RunRequest } from '../src/main/agent-host/protocol'
import { ClaudeRuntimeDriver, validateClaudeArgs } from '../src/main/agent-runtime/drivers/claude'
import { CodexRuntimeDriver, validateCodexArgs } from '../src/main/agent-runtime/drivers/codex'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// Actual subprocesses exercise framing, stdin-only prompts and abnormal process termination.
const fixture = String.raw`
const readline = require('node:readline')
const kind = process.argv[2]
const scenario = process.argv[3]
const args = process.argv.slice(4)
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n')
const die = (message) => { process.stderr.write(message); process.exit(4) }
const has = (flag, value) => args[args.indexOf(flag) + 1] === value
if (kind === 'claude' && (!has('--tools', '') || !has('--permission-mode', 'dontAsk') || !has('--mcp-config', '{"mcpServers":{}}') || !args.includes('--strict-mcp-config'))) die('unsafe Claude arguments')
if (kind === 'claude' && scenario === 'resume' && !has('--resume', 'saved-session')) die('missing resume')
if (kind === 'codex' && (!args.includes('app-server') || !has('--listen', 'stdio://'))) die('missing app-server transport')
if (kind === 'claude' && !has('--settings', '{"disableAllHooks":true}')) die('hooks not disabled')
if (kind === 'codex' && (!args.includes('mcp_servers={}') || !args.includes('features.hooks=false') || !args.includes('features.browser_use=false') || !args.includes('features.computer_use=false'))) die('native integrations not disabled')
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (scenario === 'hang') return
  if (scenario === 'crash') return die('fixture failure')
  if (scenario === 'malformed') return process.stdout.write('not-json\n')
  if (kind === 'claude') {
    if (message.type !== 'user') die('prompt changed or passed as arguments')
    const claudeText = Array.isArray(message.message.content) ? message.message.content.find((block) => block.type === 'text')?.text : message.message.content
    if (claudeText !== '--dangerously-skip-permissions\n\nfile context') die('prompt changed or passed as arguments')
    if (Array.isArray(message.message.content) && !message.message.content.some((block) => block.type === 'image' && block.source?.type === 'base64')) die('Claude image block missing')
    send({ type: 'system', subtype: 'init', session_id: 'claude-session' })
    if (scenario === 'approval') return send({ type: 'control_request', request_id: 'approval', request: { subtype: 'can_use_tool' } })
    if (scenario === 'unexpected-tool') return send({ type: 'assistant', message: { id: 'answer', content: [{ type: 'tool_use', name: 'Bash' }] } })
    send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'answer' } } })
    send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } })
    send({ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'Hello' }] } })
    process.stdout.write([
      { type: 'result', subtype: scenario === 'error-result' ? 'error_during_execution' : 'success', is_error: scenario === 'error-result', errors: ['provider rejected'], result: 'Hello', session_id: 'claude-session', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 3 } },
      { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'LATE' } } },
      { type: 'result', subtype: 'success', result: 'LATE', session_id: 'late-session', usage: { input_tokens: 999 } },
    ].map(JSON.stringify).join('\n') + '\n')
    return
  }
  if (message.method === 'initialize') return send({ id: message.id, result: {} })
  if (message.method === 'initialized') return
  if (message.method === 'config/read') return send({ id: message.id, result: { config: { mcp_servers: {} } } })
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (message.params.sandbox !== 'read-only' || message.params.approvalPolicy !== 'never') die('unsafe thread permissions')
    if (scenario === 'resume' && (message.method !== 'thread/resume' || message.params.threadId !== 'saved-thread')) die('missing native thread resume')
    return send({ id: message.id, result: { thread: { id: 'codex-thread' } } })
  }
  if (message.method === 'turn/start') {
    if (message.params.sandboxPolicy.type !== 'readOnly' || message.params.sandboxPolicy.networkAccess !== false || message.params.approvalPolicy !== 'never') die('unsafe turn permissions')
    if (message.params.input[0].text !== '--dangerously-skip-permissions\n\nfile context') die('prompt changed')
    if (scenario === 'image' && message.params.input[1]?.type !== 'image') die('Codex image block missing')
    send({ id: message.id, result: { turn: { id: 'turn' } } })
    if (scenario === 'approval') return send({ id: 99, method: 'item/commandExecution/requestApproval', params: { threadId: 'codex-thread' } })
    if (scenario === 'unknown-request') return send({ id: 99, method: 'item/tool/requestUserInput', params: { threadId: 'codex-thread' } })
    send({ method: 'item/started', params: { threadId: 'codex-thread', item: { id: 'tool', type: 'commandExecution', command: 'pwd' } } })
    send({ method: 'item/completed', params: { threadId: 'codex-thread', item: { id: 'tool', type: 'commandExecution', status: 'completed', aggregatedOutput: '/workspace' } } })
    send({ method: 'item/agentMessage/delta', params: { threadId: 'different-thread', itemId: 'bad', delta: 'ignore me' } })
    send({ method: 'item/agentMessage/delta', params: { threadId: 'codex-thread', itemId: 'answer', delta: 'Hello' } })
    send({ method: 'item/completed', params: { threadId: 'codex-thread', item: { id: 'answer', type: 'agentMessage', text: 'Hello' } } })
    send({ method: 'thread/tokenUsage/updated', params: { threadId: 'codex-thread', tokenUsage: { last: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 3 } } } })
    process.stdout.write([
      { method: 'turn/completed', params: { threadId: 'codex-thread', turn: { id: 'turn', status: scenario === 'error-result' ? 'failed' : 'completed', error: { message: 'provider rejected' } } } },
      { method: 'item/agentMessage/delta', params: { threadId: 'codex-thread', itemId: 'answer', delta: 'LATE' } },
      { method: 'thread/tokenUsage/updated', params: { threadId: 'codex-thread', tokenUsage: { last: { inputTokens: 999 } } } },
    ].map(JSON.stringify).join('\n') + '\n')
  }
})
`

function setup(kind: 'claude' | 'codex', scenario = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'navo-runtime-vendor-'))
  roots.push(root)
  const script = join(root, 'vendor.cjs')
  writeFileSync(script, fixture)
  const controller = new AbortController()
  const context: ExternalRuntimeContext = {
    profile: { id: 'test', kind, name: kind, enabled: true, command: process.execPath, args: [script, kind, scenario], model: 'test-model' },
    request: {
      runId: 'run',
      threadId: 'thread',
      input: { kind: 'message', id: 'user', text: '--dangerously-skip-permissions', context: 'file context', images: [] },
      paths: { workspace: root, skills: root, uploads: root },
      model: { providerType: 'anthropic', model: 'test-model', supportsVision: false },
      tools: [],
      interruptOn: [],
      browserSubagent: false,
      mounts: [],
      devMode: false,
      systemPrompt: 'Project instructions',
      meta: { appVersion: 'test', threadTitle: 'test', modelLabel: 'test' },
    } as RunRequest,
    session: scenario === 'resume' ? (kind === 'claude' ? { sessionId: 'saved-session' } : { threadId: 'saved-thread' }) : null,
    stateDir: root,
    signal: controller.signal,
    emit: vi.fn(),
    usage: vi.fn(),
    saveSession: vi.fn(),
  }
  return { context, controller, driver: kind === 'claude' ? new ClaudeRuntimeDriver() : new CodexRuntimeDriver() }
}

describe.each(['claude', 'codex'] as const)('%s runtime adapter', (kind) => {
  it('streams one answer, saves only native session IDs, reports usage and uses stdin for the prompt', async () => {
    const { context, driver } = setup(kind)
    expect(await driver.run(context)).toEqual({ finalText: 'Hello', interrupted: false })
    expect(context.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'token', text: 'Hello' }))
    expect(context.emit).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'ignore me' }))
    expect(context.emit).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'LATE' }))
    expect(context.saveSession).not.toHaveBeenCalledWith({ sessionId: 'late-session' })
    expect(context.saveSession).toHaveBeenCalledWith(kind === 'claude' ? { sessionId: 'claude-session' } : { threadId: 'codex-thread' })
    expect(context.usage).toHaveBeenCalledTimes(1)
    expect(context.usage).toHaveBeenCalledWith(expect.objectContaining({ usage: { input: kind === 'claude' ? 13 : 10, output: 5, cached: 3 } }))
    expect(driver.capabilities.approvals).toBe(true)
  })
  it('resumes the stored native session without silently starting over', async () => {
    const { context, driver } = setup(kind, 'resume')
    expect((await driver.run(context)).finalText).toBe('Hello')
  })
  it('fails closed for native approvals', async () => {
    const { context, driver } = setup(kind, 'approval')
    await expect(driver.run(context)).rejects.toThrow(/approval|native interaction/)
  })
  it('reports a provider error result without treating it as success', async () => {
    const { context, driver } = setup(kind, 'error-result')
    expect((await driver.run(context)).error).toBe('provider rejected')
  })
  it.each(['crash', 'malformed'])('rejects %s subprocess failures', async (scenario) => {
    const { context, driver } = setup(kind, scenario)
    await expect(driver.run(context)).rejects.toThrow(/exited before completion|Invalid runtime protocol/)
  })
  it('aborts its owned process without waiting for protocol completion', async () => {
    const { context, controller, driver } = setup(kind, 'hang')
    const pending = driver.run(context)
    setTimeout(() => controller.abort(), 50)
    expect(await pending).toEqual({ finalText: '', interrupted: false, aborted: true })
  })
  it('passes image input to the vendor protocol', async () => {
    const { context, driver } = setup(kind, 'image')
    if (context.request.input.kind === 'message') context.request.input.images = ['data:image/png;base64,aGVsbG8=']
    expect(await driver.run(context)).toEqual({ finalText: 'Hello', interrupted: false })
  })
})

it('Codex native tool output is translated into standard chat tool messages', async () => {
  const { context, driver } = setup('codex')
  await driver.run(context)
  expect(context.emit).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'message', message: expect.objectContaining({ role: 'tool', content: '/workspace', status: 'success' }) }),
  )
})

it('Claude rejects tool calls even if an incompatible CLI emits them', async () => {
  const { context, driver } = setup('claude', 'unexpected-tool')
  await expect(driver.run(context)).rejects.toThrow('tools being disabled')
})

it('Codex rejects unsupported interactive user input without hanging', async () => {
  const { context, driver } = setup('codex', 'unknown-request')
  await expect(driver.run(context)).rejects.toThrow('unsupported native interaction')
})

it.each([
  '--tools=Bash',
  '--allowedTools',
  '--permission-mode=auto',
  '--dangerously-skip-permissions',
  '--settings',
  '--mcp-config',
  '--resume',
  '-rsession',
  '--',
])('rejects conflicting Claude argument %s', (argument) => {
  expect(() => validateClaudeArgs([argument])).toThrow('managed by Navo')
})

it.each(['--config=features.hooks=true', '-cfoo=bar', '--enable', '--sandbox', '--dangerously-bypass-approvals-and-sandbox', '--yolo', '--listen', '--'])(
  'rejects conflicting Codex argument %s',
  (argument) => {
    expect(() => validateCodexArgs([argument])).toThrow('managed by Navo')
  },
)
