import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '../src/shared/types'
import type { ExternalRuntimeContext } from '../src/main/agent-runtime/types'
import { CodexRuntimeDriver } from '../src/main/agent-runtime/drivers/codex'

vi.mock('../src/main/core/shell-env', () => ({ shellPath: () => process.env.PATH ?? '' }))

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// No model or credentials: a real child speaks app-server JSONL and calls the private MCP endpoint.
const fixture = String.raw`
const { createInterface } = require('node:readline')
const scenario = process.argv[2]
const flags = process.argv.slice(3)
const send = message => process.stdout.write(JSON.stringify(message) + '\n')
const response = (id,result) => send({id,result})
const die = message => { process.stderr.write(message); process.exit(4) }
const assert = (truth,message) => { if(!truth) die(message) }
for (const flag of ['mcp_servers={}','features.hooks=false','features.plugins=false','features.apps=false','features.browser_use=false','features.computer_use=false','features.memories=false','features.multi_agent=false']) assert(flags.includes(flag),'unsafe flag')
let navo, server, nativeThread='native-thread'
let count=0
const callMcp = async (method,params={},authorization=process.env.NAVO_RUNTIME_MCP_AUTHORIZATION) => {
 const response = await fetch(navo.url,{method:'POST',headers:{authorization,'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++count,method,params})})
 return {status:response.status,body:response.status===200?await response.json():null}
}
const finish = (text='Tool result ready',extra={}) => {
 send({method:'item/agentMessage/delta',params:{threadId:nativeThread,turnId:'turn',itemId:'answer',delta:text}})
 send({method:'item/completed',params:{threadId:nativeThread,turnId:'turn',item:{id:'answer',type:'agentMessage',text}}})
 send({method:'thread/tokenUsage/updated',params:{threadId:nativeThread,tokenUsage:{last:{inputTokens:12,outputTokens:4,cachedInputTokens:3}}}})
 send({method:'turn/completed',params:{threadId:nativeThread,turn:{id:'turn',status:'completed',...extra}}})
 send({method:'item/agentMessage/delta',params:{threadId:nativeThread,itemId:'answer',delta:'LATE'}})
}
createInterface({input:process.stdin}).on('line',async line=>{
 const message=JSON.parse(line)
 if(message.method==='initialize') {
  assert(message.params.capabilities.experimentalApi===false,'unexpected experimental tools')
  response(message.id,{});return
 }
 if(message.method==='initialized')return
 if(message.method==='config/read') {
  assert(message.params.includeLayers===false,'must not request layers')
  response(message.id,{config:{mcp_servers:{foreign:{url:'https://invalid.test',http_headers:{Authorization:'private-config-value'}},navo:{command:'foreign-command'}}}});return
 }
 if(message.method==='thread/start'||message.method==='thread/resume') {
  const params=message.params; const servers=params.config.mcp_servers
  assert(params.sandbox==='read-only'&&params.approvalPolicy==='never','unsafe native permissions')
  assert(servers.foreign.enabled===false&&servers.navo.enabled===false,'foreign MCP not disabled')
  assert(!JSON.stringify(params).includes('private-config-value'),'copied unrelated config secret')
  const own=Object.entries(servers).filter(([,value])=>value.enabled===true)
  assert(own.length===1,'must enable only one MCP server')
  ;[server,navo]=own[0]
  assert(/^navo_[a-f0-9]{32}$/.test(server),'server must be unique')
  assert(navo.url.startsWith('http://127.0.0.1:'),'MCP must be loopback')
  assert(navo.env_http_headers.Authorization==='NAVO_RUNTIME_MCP_AUTHORIZATION','token must use environment reference')
  assert(navo.tool_timeout_sec>=3600,'approval timeout too short')
  assert(navo.default_tools_approval_mode==='prompt','unknown MCP tools must still require native approval')
  assert(JSON.stringify(navo.enabled_tools)===JSON.stringify(['memory_search']),'native MCP allowlist must match this run')
  assert(JSON.stringify(navo.tools)===JSON.stringify({memory_search:{approval_mode:'approve'}}),'Navo bridge needs exact per-tool native admission')
  assert(!JSON.stringify(params).includes(process.env.NAVO_RUNTIME_MCP_AUTHORIZATION),'token leaked in thread configuration')
  assert(!flags.join(' ').includes(process.env.NAVO_RUNTIME_MCP_AUTHORIZATION),'token leaked in argv')
  if(scenario==='resume'){assert(message.method==='thread/resume'&&params.threadId==='saved-thread','wrong resume');nativeThread=params.threadId}
  response(message.id,{thread:{id:nativeThread}});return
 }
 if(message.method==='turn/start') {
  assert(message.params.sandboxPolicy.type==='readOnly'&&message.params.sandboxPolicy.networkAccess===false,'turn widened sandbox')
  response(message.id,{turn:{id:'turn'}})
  if(scenario==='markup') {
   const text='I will try. <｜｜DSML｜｜calls><｜｜DSML｜｜invoke name="Bash"><｜｜DSML｜｜parameter name="command" string="true">echo BAD</｜｜DSML｜｜parameter></｜｜DSML｜｜invoke></｜｜DSML｜｜calls>'
   for (const char of text)send({method:'item/agentMessage/delta',params:{threadId:nativeThread,turnId:'turn',itemId:'answer',delta:char}})
   send({method:'item/completed',params:{threadId:nativeThread,turnId:'turn',item:{id:'answer',type:'agentMessage',text}}})
   send({method:'turn/completed',params:{threadId:nativeThread,turn:{id:'turn',status:'completed'}}});return
  }
  if(scenario==='native-failure'||scenario==='unfinished-native') {
   send({method:'item/started',params:{threadId:nativeThread,turnId:'turn',item:{id:'command',type:'commandExecution',command:'false',cwd:'/test/workspace',status:'inProgress'}}})
   if(scenario==='native-failure')send({method:'item/completed',params:{threadId:nativeThread,turnId:'turn',item:{id:'command',type:'commandExecution',command:'false',cwd:'/test/workspace',status:'completed',exitCode:9,aggregatedOutput:'failed'}}})
   finish('Native command reported');return
  }
  const initialized=await callMcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fake-codex',version:'1'}})
  assert(initialized.status===200,'MCP init failed')
  const listed=await callMcp('tools/list')
  assert(listed.body.result.tools.length===1&&listed.body.result.tools[0].name==='memory_search','MCP tool list mismatch')
  if(scenario==='unauthorized') {
   const denied=await callMcp('tools/call',{name:'memory_search',arguments:{query:'no'}},'Bearer wrong')
   assert(denied.status===401,'unauthenticated MCP accepted');finish('Blocked');return
  }
  send({method:'item/started',params:{threadId:nativeThread,turnId:'turn',item:{id:'mcp-call',type:'mcpToolCall',server,tool:'memory_search',arguments:{query:'hello'}}}})
  const result=await callMcp('tools/call',{name:scenario==='unknown'?'not_enabled':'memory_search',arguments:{query:'hello'}})
  if(scenario==='unknown')assert(result.body.error,'unknown tool accepted')
  else assert(result.body.result.content[0].text==='Found a note','unexpected tool result')
  send({method:'item/completed',params:{threadId:nativeThread,turnId:'turn',item:{id:'mcp-call',type:'mcpToolCall',server,tool:'memory_search',status:'completed',result:result.body.result}}})
  finish()
 }
}).on('error',error=>die(error.message))
process.on('unhandledRejection',error=>die(error.message))
`

function setup(scenario = 'success') {
  const root = mkdtempSync(join(tmpdir(), 'navo-codex-mcp-'))
  roots.push(root)
  const script = join(root, 'codex.cjs')
  writeFileSync(script, fixture)
  const controller = new AbortController()
  const call = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'Found a note' }] }))
  const context: ExternalRuntimeContext = {
    profile: { id: 'codex', kind: 'codex', name: 'Codex', enabled: true, command: process.execPath, args: [script, scenario] },
    request: {
      runId: 'navo-run',
      executionId: 'navo-execution',
      threadId: 'navo-thread',
      input: { kind: 'message', id: 'user', text: 'Find a note', images: [] },
      model: { model: 'codex', providerType: 'openai', supportsVision: false },
      paths: { workspace: root, skills: root, uploads: root },
      systemPrompt: 'Use the Navo tools.',
      tools: [
        {
          name: 'memory_search',
          description: 'Search memory',
          source: 'navo',
          schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        },
      ],
      interruptOn: ['memory_search'],
      browserSubagent: false,
      mounts: [],
      devMode: false,
      meta: { appVersion: 'test', threadTitle: 'Test', modelLabel: 'Codex' },
    },
    session: scenario === 'resume' ? { threadId: 'saved-thread' } : null,
    stateDir: root,
    signal: controller.signal,
    tools: { call, cancel: vi.fn() },
    emit: vi.fn(),
    usage: vi.fn(),
    saveSession: vi.fn(),
  }
  return { context, controller, call, driver: new CodexRuntimeDriver() }
}

describe('Codex Navo MCP bridge', () => {
  it('isolates inherited servers, supplies an environment token and routes structured calls exactly once', async () => {
    const { context, call, driver } = setup()
    expect(await driver.run(context)).toEqual({ finalText: 'Tool result ready', interrupted: false })
    expect(call).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledWith({ id: expect.stringMatching(/^mcp:/), name: 'memory_search', args: { query: 'hello' } })
    expect(context.saveSession).toHaveBeenCalledWith({ threadId: 'native-thread' })
    expect(context.emit).not.toHaveBeenCalledWith(expect.objectContaining({ message: expect.objectContaining({ role: 'tool' }) }))
    expect(context.emit).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'LATE' }))
    expect(context.usage).toHaveBeenCalledWith(expect.objectContaining({ usage: { input: 12, output: 4, cached: 3 } }))
    expect(driver.capabilities).toMatchObject({ navoTools: true, approvals: true, requiresNavoModel: false, workspaceTools: true })
  })

  it('passes a fresh scoped MCP configuration when resuming an existing native session', async () => {
    const { context, driver } = setup('resume')
    expect((await driver.run(context)).finalText).toBe('Tool result ready')
    expect(context.saveSession).toHaveBeenCalledWith({ threadId: 'saved-thread' })
  })

  it.each(['unauthorized', 'unknown'])('rejects %s bridge calls before dispatcher execution', async (scenario) => {
    const { context, call, driver } = setup(scenario)
    await driver.run(context)
    expect(call).not.toHaveBeenCalled()
  })

  it('waits for the dispatcher approval and stops its child and endpoint on cancellation', async () => {
    const { context, controller, call, driver } = setup('waiting')
    let complete!: () => void
    call.mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = () => resolve({ content: [{ type: 'text', text: 'Found a note' }] })
        }),
    )
    const running = driver.run(context)
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce())
    controller.abort()
    expect((await running).aborted).toBe(true)
    const emitted = vi.mocked(context.emit).mock.calls.length
    complete()
    await new Promise<void>((resolve) => setImmediate(resolve))
    expect(vi.mocked(context.emit).mock.calls.length).toBe(emitted)
  })

  it('normalizes DSML as an unexecuted warning and never calls the dispatcher from text', async () => {
    const { context, call, driver } = setup('markup')
    const result = await driver.run(context)
    expect(result.error).toContain('no tool was executed')
    expect(result.finalText).toBe('I will try. ')
    expect(call).not.toHaveBeenCalled()
    expect(context.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message', message: expect.objectContaining({ runtimeWarning: 'unexecuted_tool_markup' }) }),
    )
    expect(JSON.stringify(vi.mocked(context.emit).mock.calls)).not.toContain('DSML')
    expect(JSON.stringify(vi.mocked(context.emit).mock.calls)).not.toContain('echo BAD')
  })

  it.each(['native-failure', 'unfinished-native'])('gives %s commands honest terminal activity and preserves command metadata', async (scenario) => {
    const { context, driver } = setup(scenario)
    await driver.run(context)
    const events: ChatEvent[] = vi.mocked(context.emit).mock.calls.map(([event]) => event)
    const calls = events.flatMap((event) => (event.type === 'message' ? (event.message.toolCalls ?? []) : []))
    expect(calls.at(-1)).toMatchObject({ name: 'codex_run_command', activity: { kind: 'command', status: 'error', command: 'false', cwd: '/test/workspace' } })
    expect(events.some((event) => event.type === 'message' && event.message.role === 'tool' && event.message.status === 'error')).toBe(true)
  })
})
