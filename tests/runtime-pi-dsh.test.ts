import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PiRuntimeDriver, validatePiArgs } from '../src/main/agent-runtime/drivers/pi'
import { DshRuntimeDriver, validateDshArgs } from '../src/main/agent-runtime/drivers/dsh'
import { JsonLineProcess } from '../src/main/agent-runtime/process'
import type { ExternalRuntimeContext } from '../src/main/agent-runtime/types'

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})
async function fixture(kind: 'pi' | 'dsh', body: string) {
  const dir = await mkdtemp(join(tmpdir(), 'navo-runtime-'))
  dirs.push(dir)
  const source = join(dir, 'fake.cjs')
  await writeFile(
    source,
    `const fs=require('node:fs'); const rl=require('node:readline').createInterface({input:process.stdin});
const log=${JSON.stringify(join(dir, 'requests.jsonl'))};const send=(x)=>process.stdout.write(JSON.stringify(x)+'\\n');
const ok=(m,result={})=>send(m.method?{jsonrpc:'2.0',id:m.id,result}:{type:'response',id:m.id,command:m.type,success:true,data:result});
rl.on('line',line=>{const m=JSON.parse(line);fs.appendFileSync(log,JSON.stringify(m)+'\\n');${body}});`,
  )
  const controller = new AbortController()
  const context: ExternalRuntimeContext = {
    profile: { id: kind, kind, name: kind, enabled: true, command: process.execPath, args: [source], provider: 'test-provider', model: 'test-model' },
    request: {
      runId: 'run',
      threadId: 'thread',
      input: { kind: 'message', id: 'message', text: 'hello', context: 'attached text', images: [] },
      systemPrompt: 'context',
      paths: { workspace: dir, uploads: dir, skills: dir },
      model: { providerType: 'openai', model: 'test-model', supportsVision: false },
      tools: [],
      interruptOn: [],
      browserSubagent: false,
      mounts: [],
      devMode: false,
      meta: { threadTitle: 'test', modelLabel: 'test', appVersion: 'test' },
    },
    session: null,
    stateDir: join(dir, 'state'),
    signal: controller.signal,
    emit: vi.fn(),
    usage: vi.fn(),
    saveSession: vi.fn(),
  }
  return {
    context,
    controller,
    dir,
    requests: async () =>
      (await readFile(join(dir, 'requests.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
  }
}
const piInit = `if(m.type==='get_state')ok(m,{sessionFile:'/owned/session.jsonl'});if(m.type==='switch_session')ok(m,{cancelled:false});`
const dshInit = `if(m.method==='initialize')ok(m,{serverInfo:{name:'deepseek-harness-sdk-runtime',version:'0.0.1'}});if(m.method==='session/resume')ok(m);`

describe('Pi RPC adapter', () => {
  it('restores exact session, waits past agent_end, reports final usage once and ignores late events', async () => {
    const f = await fixture(
      'pi',
      `${piInit}if(m.type==='prompt'){ok(m,{disposition:'started'});send({type:'message_start',message:{role:'assistant'}});send({type:'message_update',usage:{input:9,output:2},assistantMessageEvent:{type:'text_delta',delta:'hello'}});send({type:'agent_end'});setTimeout(()=>{send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'hello complete'}],usage:{input:9,output:3,cacheRead:2}}});send({type:'agent_settled',aborted:false});send({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'LATE'}})},20);}`,
    )
    f.context.session = { sessionFile: '/owned/session.jsonl' }
    expect(await new PiRuntimeDriver().run(f.context)).toEqual({ finalText: 'hello complete', interrupted: false })
    expect(f.context.saveSession).toHaveBeenCalledWith({ sessionFile: '/owned/session.jsonl' })
    expect(f.context.usage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(f.context.emit).mock.calls)).not.toContain('LATE')
    const requests = await f.requests()
    expect(requests[0]).toMatchObject({ type: 'switch_session', sessionPath: '/owned/session.jsonl' })
    expect(requests.find((r) => r.type === 'prompt').message).toBe('context\n\nattached text\n\nhello')
  })
  it('surfaces model errors instead of reporting success', async () => {
    const f = await fixture(
      'pi',
      `${piInit}if(m.type==='prompt'){ok(m,{disposition:'started'});send({type:'message_end',message:{role:'assistant',content:[],stopReason:'error',errorMessage:'provider unavailable'}});send({type:'agent_settled'});}`,
    )
    expect(await new PiRuntimeDriver().run(f.context)).toMatchObject({ error: 'provider unavailable' })
  })
  it('rejects interactive approval rather than silently confirming it', async () => {
    const f = await fixture(
      'pi',
      `${piInit}if(m.type==='prompt'){ok(m,{disposition:'started'});send({type:'extension_ui_request',id:'ask',method:'confirm'});}`,
    )
    await expect(new PiRuntimeDriver().run(f.context)).rejects.toThrow('does not support approvals')
  })
  it('rejects failed resume and handled prompts', async () => {
    const f = await fixture('pi', `if(m.type==='switch_session')ok(m,{cancelled:true});`)
    f.context.session = { sessionFile: '/missing' }
    await expect(new PiRuntimeDriver().run(f.context)).rejects.toThrow('restoration')
    const g = await fixture('pi', `${piInit}if(m.type==='prompt')ok(m,{disposition:'handled'});`)
    await expect(new PiRuntimeDriver().run(g.context)).rejects.toThrow('without starting')
  })
})

describe('DSH SDK adapter', () => {
  it('restores sessions, filters other session events, and waits for completion after enqueue', async () => {
    const f = await fixture(
      'dsh',
      `${dshInit}if(m.method==='session/prompt')ok(m,{messageId:'queued'});if(m.method==='session/wait'){const event=(sessionId,type,seq,data)=>send({jsonrpc:'2.0',method:'session.event',params:{sessionId,event:{type,seq,time:1,data}}});event('other','assistant/message',1,{message:{content:[{type:'text',text:'wrong'}]}});event(m.params.sessionId,'assistant/message',2,{message:{content:[{type:'text',text:'done'}]},usage:{inputTokens:5,outputTokens:3,cacheReadTokens:2}});event(m.params.sessionId,'assistant/message',2,{message:{content:[]},usage:{inputTokens:5,outputTokens:3}});event(m.params.sessionId,'turn/end',3,{reason:{kind:'completed'}});ok(m);}`,
    )
    f.context.session = { sessionId: 'persisted', dshHome: process.env.DSH_HOME ?? '' }
    expect(await new DshRuntimeDriver().run(f.context)).toEqual({ finalText: 'done', interrupted: false })
    expect(f.context.usage).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(vi.mocked(f.context.emit).mock.calls)).not.toContain('wrong')
    expect((await f.requests()).map((r) => r.method)).toEqual(['initialize', 'session/resume', 'session/prompt', 'session/wait'])
  })
  it('rejects approval and surfaces unsupported approval even when runtime continues', async () => {
    const f = await fixture(
      'dsh',
      `${dshInit}if(m.method==='session/prompt')ok(m,{messageId:'queued'});if(m.method==='session/wait'){send({jsonrpc:'2.0',id:'approval',method:'approval/request',params:{sessionId:m.params.sessionId,toolName:'shell'}});setTimeout(()=>{send({jsonrpc:'2.0',method:'session.event',params:{sessionId:m.params.sessionId,event:{type:'turn/end',seq:3,data:{reason:{kind:'completed'}}}}});ok(m)},25);}`,
    )
    expect(await new DshRuntimeDriver().run(f.context)).toMatchObject({ error: expect.stringContaining('operation was rejected') })
    expect((await f.requests()).find((r) => r.id === 'approval')).toMatchObject({ result: { outcome: 'rejected' } })
  })
  it('does not confuse acceptance or an empty wait result with successful model completion', async () => {
    const f = await fixture('dsh', `${dshInit}if(m.method==='session/prompt')ok(m,{messageId:'queued'});if(m.method==='session/wait')ok(m);`)
    await expect(new DshRuntimeDriver().run(f.context)).rejects.toThrow('without a terminal')
  })
  it('refuses missing routes before spawning and propagates RPC errors', async () => {
    const f = await fixture('dsh', `send({jsonrpc:'2.0',id:m.id,error:{code:-1,message:'missing persisted session'}});`)
    f.context.profile.provider = undefined
    await expect(new DshRuntimeDriver().run(f.context)).rejects.toThrow('explicit DSH')
    f.context.profile.provider = 'deepseek'
    await expect(new DshRuntimeDriver().run(f.context)).rejects.toThrow('missing persisted session')
  })
})

describe('dedicated JSONL subprocess', () => {
  it('rejects malformed protocol and premature clean exits', async () => {
    for (const body of [`process.stdout.write('not-json\\n')`, `process.exit(0)`]) {
      const f = await fixture('pi', body)
      const child = new JsonLineProcess({
        command: process.execPath,
        args: f.context.profile.args,
        cwd: f.dir,
        signal: f.controller.signal,
        onMessage: vi.fn(),
      })
      const result = child.request({ type: 'anything' })
      await expect(result).rejects.toThrow()
      await child.stop()
    }
  })
  it('aborts a stalled process, rejects pending requests and ignores later output', async () => {
    const f = await fixture('pi', `process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),20));setTimeout(()=>send({type:'late'}),100);`)
    const onMessage = vi.fn()
    const child = new JsonLineProcess({ command: process.execPath, args: f.context.profile.args, cwd: f.dir, signal: f.controller.signal, onMessage })
    const pending = child.request({ type: 'hang' })
    f.controller.abort()
    await expect(pending).rejects.toThrow('aborted')
    await child.stop()
    expect(onMessage).not.toHaveBeenCalled()
    expect((await child.closed).signal).toBeTruthy()
  })
})

describe('runtime protocol boundaries', () => {
  it('rejects arguments that can replace the protocol or enable Pi native tools', () => {
    for (const arg of ['--', '--mode=json', '--print', '-p', '--provider=other', '--tools=bash', '--extension=x', '-e', '--session=other', '--session-dir=x']) {
      expect(() => validatePiArgs([arg])).toThrow('cannot override')
    }
    for (const arg of ['--', '--profile=desktop', '--patch', '--patch=external.yml']) {
      expect(() => validateDshArgs([arg])).toThrow('cannot override')
    }
  })
  it('refuses to resume DSH in a different credential and session home', async () => {
    const f = await fixture('dsh', '')
    f.context.session = { sessionId: 'saved', dshHome: '/different-home' }
    await expect(new DshRuntimeDriver().run(f.context)).rejects.toThrow('DSH home changed')
  })
  it.each(['pi', 'dsh'] as const)('cancels a %s run waiting on model completion', async (kind) => {
    const f = await fixture(
      kind,
      kind === 'pi' ? `${piInit}if(m.type==='prompt')ok(m,{disposition:'started'});` : `${dshInit}if(m.method==='session/prompt')ok(m,{messageId:'queued'});`,
    )
    const running = (kind === 'pi' ? new PiRuntimeDriver() : new DshRuntimeDriver()).run(f.context)
    const check = expect(running).rejects.toThrow('aborted')
    await vi.waitFor(() => expect(f.context.saveSession).toHaveBeenCalled())
    f.controller.abort()
    await check
  })
  it('turns DSH model failure into an error result and drops messages after wait completion', async () => {
    const f = await fixture(
      'dsh',
      `${dshInit}if(m.method==='session/prompt')ok(m,{messageId:'queued'});if(m.method==='session/wait'){send({jsonrpc:'2.0',method:'session.event',params:{sessionId:m.params.sessionId,event:{type:'turn/end',seq:1,data:{reason:{kind:'error',error:{message:'provider failed'}}}}}});ok(m);send({jsonrpc:'2.0',method:'session.event',params:{sessionId:m.params.sessionId,event:{type:'assistant/message',seq:2,data:{message:{content:[{type:'text',text:'LATE'}]}}}}});}`,
    )
    expect(await new DshRuntimeDriver().run(f.context)).toMatchObject({ error: 'provider failed', finalText: '' })
    expect(f.context.emit).not.toHaveBeenCalled()
  })
  it('fails oversized protocol output and bounded request timeouts', async () => {
    const f = await fixture('pi', `process.stdout.write('x'.repeat(8*1024*1024+1));`)
    const child = new JsonLineProcess({ command: process.execPath, args: f.context.profile.args, cwd: f.dir, signal: f.controller.signal, onMessage: vi.fn() })
    await expect(child.request({ type: 'large' })).rejects.toThrow('8 MB')
    await child.stop()
    const g = await fixture('pi', '')
    const other = new JsonLineProcess({ command: process.execPath, args: g.context.profile.args, cwd: g.dir, signal: g.controller.signal, onMessage: vi.fn() })
    await expect(other.request({ type: 'hang' }, { timeoutMs: 20 })).rejects.toThrow('timed out')
    await other.stop()
  })
})
