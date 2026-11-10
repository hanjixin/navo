import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ClaudeRuntimeDriver } from '../src/main/agent-runtime/drivers/claude'
import { validateClaudeArgs } from '../src/main/agent-runtime/drivers/claude'
import { ClaudeMcpBridge } from '../src/main/agent-runtime/drivers/claude-mcp'
import type { ExternalRuntimeContext, RuntimeToolResult } from '../src/main/agent-runtime/types'

vi.mock('../src/main/core/shell-env', () => ({ shellPath: () => process.env.PATH ?? '' }))
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const fixture = String.raw`
const fs = require('node:fs')
const root = process.argv[2], scenario = process.argv[3], args = process.argv.slice(4)
const send = value => process.stdout.write(JSON.stringify(value) + '\n')
const rpc = (id, method, params) => send({type:'control_request',request_id:'control-'+id,request:{subtype:'mcp_message',server_name:'navo',message:{jsonrpc:'2.0',id,method,params}}})
const die = text => { process.stderr.write(text);process.exit(3) }
if (args[args.indexOf('--tools')+1] !== '') die('native tools enabled')
if (JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.navo.type !== 'sdk') die('missing SDK MCP')
if (!args.includes('mcp__navo__memory_search')) die('missing exact allowlist')
if(args[args.indexOf('--system-prompt-snapshot')+1]!=='off'||!args.includes('--disable-slash-commands')||!args.includes('--no-chrome'))die('unexpected native integrations or frozen prompt')
if(scenario==='resume'&&args[args.indexOf('--resume')+1]!=='saved-session')die('session resume not bound')
let initialized=false
const finish = (text='Finished') => {
 send({type:'assistant',message:{id:'answer',model:'actual-model',content:[{type:'text',text}]}})
 send({type:'result',subtype:'success',session_id:'saved-session',result:text,usage:{input_tokens:4,output_tokens:3}})
}
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line)
 fs.appendFileSync(root+'/received.jsonl',line+'\n')
 if(message.type==='control_request'&&message.request.subtype==='initialize'){
  if(scenario==='init-error')return send({type:'control_response',response:{subtype:'error',request_id:message.request_id,error:'unsupported initialize'}})
  initialized=true
  return send({type:'control_response',response:{subtype:'success',request_id:message.request_id,response:{}}})
 }
 if(message.type==='user'){
  if(!initialized)die('prompt before handshake')
  if(scenario==='extra-tools')return send({type:'system',subtype:'init',session_id:'saved-session',tools:['mcp__untrusted__execute']})
  send({type:'system',subtype:'init',session_id:'saved-session',model:'actual-model'})
  if(scenario==='native')return send({type:'assistant',message:{id:'native',content:[{type:'tool_use',id:'native-tool',name:'Bash',input:{command:'pwd'}}]}})
  if(scenario==='markup'){
   send({type:'stream_event',event:{type:'message_start',message:{id:'answer'}}})
   for(const text of ['Before <｜','｜DSML｜｜calls><｜｜DSML｜｜invoke name="Bash"><｜｜DSML｜｜parameter name="command">pwd</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls> After'])
    send({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text}}})
   return finish('Before <｜｜DSML｜｜calls><｜｜DSML｜｜invoke name="Bash"><｜｜DSML｜｜parameter name="command">pwd</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls> After')
  }
  return rpc('initialize','initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'fixture',version:'1'}})
 }
 if(message.type==='control_response'){
  const id=message.response.request_id, response=message.response.response.mcp_response
  if(id==='control-initialize')return rpc('list','tools/list',{})
  if(id==='control-list'){
   if(response.result.tools.length!==1||response.result.tools[0].name!=='memory_search')die('bad tool list')
   send({type:'assistant',message:{id:'calling',content:[{type:'tool_use',id:'native-mcp-call',name:'mcp__navo__memory_search',input:{query:'hello'}}]}})
   rpc('call','tools/call',{name:'memory_search',arguments:{query:'hello'}})
   return rpc('ping','ping',{})
  }
  if(id==='control-ping'){fs.writeFileSync(root+'/ping-acked','yes');return}
  if(id==='control-call')return finish(response.result.isError?'Rejected':'Finished')
 }
})
`

function setup(scenario = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'navo-claude-bridge-'))
  roots.push(root)
  const script = join(root, 'fixture.cjs')
  writeFileSync(script, fixture)
  const controller = new AbortController()
  const context: ExternalRuntimeContext = {
    profile: { id: 'claude', kind: 'claude', name: 'Claude', enabled: true, command: process.execPath, args: [script, root, scenario] },
    request: {
      threadId: 'thread',
      runId: 'run',
      executionId: 'execution',
      input: { kind: 'message', id: 'user', text: 'Hello', images: [] },
      model: { providerType: 'anthropic', model: 'unused', supportsVision: false },
      paths: { workspace: root, uploads: root, skills: root },
      tools: [
        {
          name: 'memory_search',
          description: 'Search memory',
          schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          source: 'navo',
        },
      ],
      systemPrompt: 'Use Navo tools',
      interruptOn: [],
      browserSubagent: false,
      mounts: [],
      devMode: false,
      meta: { appVersion: 'test', threadTitle: 'test', modelLabel: 'test' },
    },
    session: null,
    stateDir: root,
    signal: controller.signal,
    emit: vi.fn(),
    usage: vi.fn(),
    saveSession: vi.fn(),
    tools: { call: vi.fn(async (): Promise<RuntimeToolResult> => ({ content: [{ type: 'text', text: 'Memory result' }] })), cancel: vi.fn() },
  }
  return { root, context, controller }
}

describe('Claude run-scoped SDK MCP bridge', () => {
  it.each(['--system-prompt-snapshot=on', '--disable-slash-commands', '--no-chrome'])('rejects host-managed argument %s', (argument) => {
    expect(() => validateClaudeArgs([argument])).toThrow('managed by Navo')
  })
  it('handshakes, lists only run tools, executes structured calls and reports the actual model', async () => {
    const { context } = setup()
    expect(await new ClaudeRuntimeDriver().run(context)).toEqual({ finalText: 'Finished', interrupted: false })
    expect(context.tools!.call).toHaveBeenCalledExactlyOnceWith({ id: 'run:claude-mcp:call', name: 'memory_search', args: { query: 'hello' } })
    expect(context.tools!.cancel).not.toHaveBeenCalled()
    expect(context.usage).toHaveBeenCalledWith(expect.objectContaining({ model: 'actual-model' }))
    expect(context.saveSession).toHaveBeenCalledWith({ sessionId: 'saved-session' })
    expect(vi.mocked(context.emit).mock.calls.flatMap(([event]) => (event.type === 'message' ? (event.message.toolCalls ?? []) : []))).toEqual([])
  })

  it('keeps reading protocol messages while a Navo approval waits', async () => {
    const { context, root } = setup()
    let approve!: (value: RuntimeToolResult) => void
    context.tools!.call = vi.fn(
      () =>
        new Promise<RuntimeToolResult>((resolve) => {
          approve = resolve
        }),
    )
    const running = new ClaudeRuntimeDriver().run(context)
    await vi.waitFor(() => expect(context.tools!.call).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(readFileSync(join(root, 'ping-acked'), 'utf8')).toBe('yes'))
    approve({ content: [{ type: 'text', text: 'Allowed' }] })
    expect((await running).finalText).toBe('Finished')
  })

  it('returns a rejected Navo tool result to the model without executing a native tool', async () => {
    const { context } = setup()
    context.tools!.call = vi.fn(async (): Promise<RuntimeToolResult> => ({ content: [{ type: 'text', text: 'User rejected' }], isError: true }))
    expect((await new ClaudeRuntimeDriver().run(context)).finalText).toBe('Rejected')
  })

  it('resumes the same native session with a fresh run-scoped MCP bridge', async () => {
    const { context } = setup('resume')
    context.session = { sessionId: 'saved-session' }
    context.request.runId = 'resumed-run'
    expect((await new ClaudeRuntimeDriver().run(context)).finalText).toBe('Finished')
    expect(context.tools!.call).toHaveBeenCalledWith(expect.objectContaining({ id: 'resumed-run:claude-mcp:call' }))
    expect(context.saveSession).toHaveBeenCalledWith({ sessionId: 'saved-session' })
  })

  it('rejects missing tool bridges before starting a tool-enabled run', async () => {
    const { context } = setup()
    delete context.tools
    await expect(new ClaudeRuntimeDriver().run(context)).rejects.toThrow('requires a Navo tool bridge')
  })

  it('aborts a waiting bridge and discards its late result', async () => {
    const { context, controller } = setup()
    let finish!: (value: RuntimeToolResult) => void
    context.tools!.call = vi.fn(
      () =>
        new Promise<RuntimeToolResult>((resolve) => {
          finish = resolve
        }),
    )
    const running = new ClaudeRuntimeDriver().run(context)
    await vi.waitFor(() => expect(context.tools!.call).toHaveBeenCalledOnce())
    controller.abort()
    expect((await running).aborted).toBe(true)
    expect(context.tools!.cancel).toHaveBeenCalledWith('run:claude-mcp:call')
    const count = vi.mocked(context.emit).mock.calls.length
    finish({ content: [{ type: 'text', text: 'Too late' }] })
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(vi.mocked(context.emit).mock.calls).toHaveLength(count)
  })

  it('refuses native tool calls and fails unsupported initialization', async () => {
    await expect(new ClaudeRuntimeDriver().run(setup('native').context)).rejects.toThrow('native tools being disabled')
    await expect(new ClaudeRuntimeDriver().run(setup('init-error').context)).rejects.toThrow('unsupported initialize')
    await expect(new ClaudeRuntimeDriver().run(setup('extra-tools').context)).rejects.toThrow('outside the Navo bridge')
  })

  it('filters split DSML text, surfaces a warning and never dispatches it', async () => {
    const { context } = setup('markup')
    const result = await new ClaudeRuntimeDriver().run(context)
    expect(result.error).toContain('unexecuted tool markup')
    expect(result.finalText).toBe('Before  After')
    expect(context.tools!.call).not.toHaveBeenCalled()
    expect(context.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', message: expect.objectContaining({ runtimeWarning: 'unexecuted_tool_markup' }) }),
    )
    const streamed = vi
      .mocked(context.emit)
      .mock.calls.flatMap(([event]) => (event.type === 'token' ? event.text : []))
      .join('')
    expect(streamed).not.toContain('DSML')
    expect(streamed).not.toContain('pwd')
  })

  it('deduplicates requests, rejects unknown names and honors control cancellation', async () => {
    const { context } = setup()
    const bridge = new ClaudeMcpBridge(context)
    const send = vi.fn()
    const request = (id: string, name: string) => ({
      type: 'control_request',
      request_id: id,
      request: {
        subtype: 'mcp_message',
        server_name: 'navo',
        message: { jsonrpc: '2.0', id: 'same', method: 'tools/call', params: { name, arguments: { query: 'hello' } } },
      },
    })
    await bridge.handle(request('one', 'memory_search'), send)
    await bridge.handle(request('two', 'memory_search'), send)
    expect(context.tools!.call).toHaveBeenCalledOnce()
    await bridge.handle(request('unknown', 'Bash'), send)
    expect(send).toHaveBeenLastCalledWith(
      expect.objectContaining({
        response: expect.objectContaining({ response: { mcp_response: expect.objectContaining({ error: expect.objectContaining({ code: -32602 }) }) } }),
      }),
    )
    let resolve!: (value: RuntimeToolResult) => void
    context.tools!.call = vi.fn(
      () =>
        new Promise<RuntimeToolResult>((done) => {
          resolve = done
        }),
    )
    const pendingBridge = new ClaudeMcpBridge(context)
    const pending = pendingBridge.handle(request('pending', 'memory_search'), send)
    await vi.waitFor(() => expect(context.tools!.call).toHaveBeenCalledOnce())
    pendingBridge.cancel('pending')
    const count = send.mock.calls.length
    resolve({ content: [{ type: 'text', text: 'late' }] })
    await pending
    expect(send.mock.calls).toHaveLength(count)
    expect(context.tools!.cancel).toHaveBeenCalledWith('run:claude-mcp:same')
  })
})
