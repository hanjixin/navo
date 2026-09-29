import { app, utilityProcess, type UtilityProcess } from 'electron'
import { appFile } from '../core/app-dir'
import type { ChatEvent, Decision, Thread, ThreadState } from '@shared/types'
import { buildAttachmentContext } from '../files/attachments'
import { memory } from '../memory/memory-service'
import { files } from '../files/file-service'
import { db, kv } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { paths } from '../core/paths'
import { getSettings, langfuseConfig } from '../core/settings'
import { sessions } from '../browser/agent-session'
import { resolveModel } from '../models/registry'
import { skills } from '../skills/skill-service'
import type { RpcMessage, RunRequest, RunResult, ToolCallRequest } from '../agent-host/protocol'
import { Rpc } from '../agent-host/rpc'
import { isSpawnedConversation } from '../mcp-server/tools'
import { collectTools, describeTools, NAVO_DESTRUCTIVE, systemPrompt, type ToolEntry } from './tool-registry'

interface ThreadRow {
  id: string
  title: string
  model_id: string | null
  created_at: number
  updated_at: number
}

const toThread = (r: ThreadRow): Thread => ({ id: r.id, title: r.title, modelId: r.model_id, createdAt: r.created_at, updatedAt: r.updated_at })
const RESET = '__reset__'

export type { RunResult }
type Listener = (e: ChatEvent) => void

interface ActiveRun {
  runId: string
  tools: Map<string, ToolEntry>
  /** the agent managed memory itself, so automatic learning skips this exchange */
  usedMemoryTools: boolean
}

/**
 * Main-process side of the agent. The deepagents loop runs in a utility process (agent-host) so a
 * long run never blocks the UI; this class owns threads, the host lifecycle, and executes the
 * browser / plugin / MCP tools the host calls back into.
 */
class AgentService {
  private child: UtilityProcess | null = null
  private rpc: Rpc | null = null
  private runs = new Map<string, ActiveRun>()
  private listeners = new Set<Listener>()

  // ---------- host process ----------
  private host(): Rpc {
    if (this.rpc && this.child) return this.rpc
    const child = utilityProcess.fork(appFile('out/main/agent-host.js'), [], {
      serviceName: 'Navo Agent',
      stdio: 'pipe',
      env: { ...process.env, AB_DB_PATH: paths.db, AB_CHECKPOINTS_PATH: paths.checkpoints },
    })
    child.stdout?.on('data', (d: Buffer) => log.info(`[agent-host] ${d.toString().trim()}`))
    child.stderr?.on('data', (d: Buffer) => log.warn(`[agent-host] ${d.toString().trim()}`))
    const rpc = new Rpc(
      { post: (m) => child.postMessage(m), listen: (fn) => child.on('message', (m: RpcMessage) => fn(m)) },
      { 'tool.call': (req: ToolCallRequest) => this.callTool(req) },
      (name, payload) => {
        if (name === 'chat.event') this.send(payload as ChatEvent)
      },
    )
    child.on('exit', (code) => {
      log.warn(`[agent] host exited with code ${code}`)
      rpc.failAll('Agent 进程意外退出，已自动重启，请重试')
      if (this.child === child) {
        this.child = null
        this.rpc = null
      }
    })
    this.child = child
    this.rpc = rpc
    return rpc
  }

  /** Restarts the host when idle so environment changes (e.g. LangSmith tracing) take effect. */
  refreshHost(): void {
    if (this.runs.size || !this.child) return
    this.child.kill()
    this.child = null
    this.rpc = null
  }

  shutdown(): void {
    this.child?.kill()
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private send(e: ChatEvent): void {
    emit('chat.event', e)
    for (const l of this.listeners) l(e)
  }

  // ---------- threads ----------
  listThreads(): Thread[] {
    return (db().prepare('SELECT * FROM threads WHERE hidden = 0 ORDER BY updated_at DESC').all() as ThreadRow[]).map(toThread)
  }

  getThread(id: string): Thread | null {
    const r = db().prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined
    return r ? toThread(r) : null
  }

  createThread(modelId?: string | null, opts: { title?: string; hidden?: boolean } = {}): Thread {
    const id = newId()
    const now = Date.now()
    db()
      .prepare('INSERT INTO threads(id, title, model_id, created_at, updated_at, hidden) VALUES(?, ?, ?, ?, ?, ?)')
      .run(id, opts.title ?? '新对话', modelId ?? null, now, now, opts.hidden ? 1 : 0)
    if (!opts.hidden) emit('threads.changed')
    return this.getThread(id)!
  }

  renameThread(id: string, title: string): void {
    db()
      .prepare('UPDATE threads SET title = ? WHERE id = ?')
      .run(title.trim() || '新对话', id)
    emit('threads.changed')
  }

  setThreadModel(id: string, modelId: string): void {
    db().prepare('UPDATE threads SET model_id = ? WHERE id = ?').run(modelId, id)
    emit('threads.changed')
  }

  async deleteThread(id: string): Promise<void> {
    this.stop(id)
    db().prepare('DELETE FROM threads WHERE id = ?').run(id)
    kv.set(`thread.allow.${id}`, [])
    sessions.forget(id)
    memory.forgetThread(id)
    kv.set(`thread.memory.${id}`, true)
    await this.host().call('thread.delete', { threadId: id })
    emit('threads.changed')
  }

  private touch(id: string): void {
    db().prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  async threadState(id: string): Promise<ThreadState> {
    const st = await this.host().call<Omit<ThreadState, 'running'>>('thread.state', { threadId: id })
    return { ...st, running: this.runs.has(id) }
  }

  /** Tools the user chose to always allow in this conversation (no approval card). */
  allowList(threadId: string): string[] {
    return kv.get<string[]>(`thread.allow.${threadId}`, [])
  }

  // ---------- runs ----------
  isRunning(threadId: string): boolean {
    return this.runs.has(threadId)
  }

  stop(threadId: string): void {
    if (this.runs.has(threadId)) void this.rpc?.call('run.abort', { threadId }).catch(() => undefined)
  }

  stopAll(): void {
    for (const id of this.runs.keys()) this.stop(id)
  }

  async send_(threadId: string, text: string, images: string[] = [], opts: { headless?: boolean } = {}, fileIds: string[] = []): Promise<RunResult> {
    const thread = this.getThread(threadId)
    if (!thread) throw new Error('会话不存在')
    const firstFile = fileIds.length ? files.get(fileIds[0]).name : ''
    if (thread.title === '新对话' && (text.trim() || firstFile))
      this.renameThread(threadId, (text.trim() || `文件：${firstFile}`).replace(/\s+/g, ' ').slice(0, 40))
    const id = newId()
    if (!fileIds.length) {
      this.send({ type: 'message', threadId, message: { id, role: 'user', content: text, images } })
      return this.run(threadId, { kind: 'message', id, text, images }, opts)
    }
    const pending = fileIds.map((f) => files.get(f))
    this.send({
      type: 'message',
      threadId,
      message: { id, role: 'user', content: text, images, attachments: pending.map((r) => ({ id: r.id, name: r.name, kind: r.kind, chars: r.chars })) },
    })
    return this.run(threadId, { kind: 'message', id, text, ...(await this.withFiles(thread.modelId, fileIds, images)) }, opts)
  }

  /** Parsed file content (and, for vision models, the images) that goes along with a user message. */
  private async withFiles(modelId: string | null, fileIds: string[], images: string[]) {
    const records = await files.waitFor(fileIds)
    const built = buildAttachmentContext(
      records,
      (r) => files.markdown(r.id),
      (r) => files.originalPath(r.id),
      resolveModel(modelId).supportsVision,
      (r) => files.visuals(r.id),
    )
    return { context: built.context, attachments: built.attachments, images: [...built.images, ...images], attachmentImages: built.images.length }
  }

  async resume(threadId: string, decisions: Decision[], alwaysAllow: string[] = []): Promise<RunResult> {
    if (alwaysAllow.length) kv.set(`thread.allow.${threadId}`, [...new Set([...this.allowList(threadId), ...alwaysAllow])])
    return this.run(threadId, { kind: 'resume', decisions })
  }

  /** Re-runs from a user message: regenerate (same text) or edit & resend (new text). Earlier branch stays in history. */
  async regenerate(threadId: string, messageId: string, text?: string): Promise<RunResult> {
    const state = await this.threadState(threadId)
    const original = state.messages.find((m) => m.id === messageId && m.role === 'user')
    if (!original) throw new Error('只能从用户消息重新生成')
    const fork = await this.host().call<string | null>('thread.forkPoint', { threadId, messageId })
    if (!fork) throw new Error('找不到可回溯的历史节点')
    if (fork === RESET) await this.host().call('thread.delete', { threadId })
    const content = text ?? original.content
    const id = newId()
    const images = original.images ?? []
    // files attached to the original message go along again (unless deleted since)
    const fileIds = (original.attachments ?? []).map((a) => a.id).filter((f) => files.exists(f))
    this.send({
      type: 'message',
      threadId,
      message: { id, role: 'user', content, images, ...(original.attachments?.length ? { attachments: original.attachments } : {}) },
    })
    const extra = fileIds.length ? await this.withFiles(this.getThread(threadId)!.modelId, fileIds, images) : {}
    return this.run(threadId, { kind: 'message', id, text: content, images, ...extra }, {}, fork === RESET ? undefined : fork)
  }

  private async run(threadId: string, input: RunRequest['input'], opts: { headless?: boolean } = {}, fromCheckpointId?: string): Promise<RunResult> {
    if (this.runs.has(threadId)) throw new Error('该会话正在运行中')
    const thread = this.getThread(threadId)!
    const runId = newId()
    const settings = getSettings()
    sessions.begin(threadId, thread.title)
    const ctx = { threadId, tab: () => sessions.tabFor(threadId) }
    const entries = collectTools(ctx)
    const runState = { runId, tools: new Map(entries.map((e) => [e.tool.name, e])), usedMemoryTools: false }
    this.runs.set(threadId, runState)
    this.send({ type: 'run_start', threadId, runId })
    this.touch(threadId)

    let result: RunResult
    try {
      const allowed = new Set(this.allowList(threadId))
      const resolved = resolveModel(thread.modelId)
      // memory: picked from the conversation (title, the user's previous two messages and this one —
      // "那它用什么打包" alone says nothing) and the site the conversation's tab is on
      const tab = sessions.peek(threadId)
      const earlier = input.kind === 'message' ? (await this.recentUserTexts(threadId, 2)).map((t) => t.slice(0, 500)) : []
      const mem = memory.forRun(
        threadId,
        [thread.title, ...earlier, input.kind === 'message' ? input.text : ''].join('\n'),
        tab && !tab.isDestroyed() ? tab.getURL() : null,
      )
      if (input.kind === 'message' && mem?.refs.length) input = { ...input, memories: mem.refs }
      const req: RunRequest = {
        runId,
        threadId,
        input,
        fromCheckpointId,
        model: resolved,
        systemPrompt: systemPrompt(tab, mem ? mem.prompt : null),
        memoryPrompt: mem?.prompt || undefined,
        tools: describeTools(entries),
        interruptOn: opts.headless ? [] : [...new Set([...settings.approvalTools, ...NAVO_DESTRUCTIVE])].filter((t) => !allowed.has(t)),
        browserSubagent: settings.browserSubagent,
        mounts: skills.mounts().map((m) => ({ id: m.id, root: m.root, allowed: [...m.allowed] })),
        paths: { skills: paths.skills, workspace: paths.workspace, uploads: paths.uploads },
        devMode: settings.devMode,
        langfuse: langfuseConfig(),
        meta: { threadTitle: thread.title, modelLabel: resolved.model, appVersion: app.getVersion() },
      }
      result = await this.host().call<RunResult>('run.start', req)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.error(`[agent] run failed: ${error}`)
      this.send({ type: 'error', threadId, error })
      result = { finalText: '', interrupted: false, error }
    } finally {
      this.runs.delete(threadId)
      await sessions.end(threadId)
      this.touch(threadId)
      emit('threads.changed')
    }
    this.send({ type: 'run_end', threadId, runId, aborted: result.aborted, traceUrl: result.traceUrl })
    // learn from the finished exchange in the background (the agent's own memory_* calls take precedence)
    if (input.kind === 'message' && !opts.headless && !result.error && !result.aborted && !result.interrupted && !isSpawnedConversation(threadId))
      void this.learnFrom(threadId, input.text, result.finalText, runState.usedMemoryTools)
    return result
  }

  /** The user's own recent messages in a conversation (what memory evidence is checked against). */
  async recentUserTexts(threadId: string, n = 8): Promise<string[]> {
    const msgs = (await this.threadState(threadId).catch(() => null))?.messages ?? []
    return msgs
      .filter((m) => m.role === 'user' && !m.ns)
      .slice(-n)
      .map((m) => m.content)
  }

  private async learnFrom(threadId: string, userText: string, reply: string, journalOnly: boolean): Promise<void> {
    const thread = this.getThread(threadId)
    if (!thread || !reply.trim()) return
    // what the agent did since the user's message: tool names, plus the pages it opened
    const msgs = (await this.threadState(threadId).catch(() => null))?.messages ?? []
    const from = msgs.map((m) => m.role).lastIndexOf('user')
    const actions = msgs
      .slice(from + 1)
      .flatMap((m) => m.toolCalls ?? [])
      .map((c) => (typeof c.args?.url === 'string' ? `${c.name} ${c.args.url}` : c.name))
      .slice(0, 30)
    await memory.learn(threadId, thread.title, thread.modelId, { userText, reply, actions }, { journalOnly })
  }

  /** Executes a tool the agent process asked for, on the conversation's tab. */
  private async callTool(req: ToolCallRequest): Promise<unknown> {
    const run = this.runs.get(req.threadId)
    if (!run || run.runId !== req.runId) throw new Error('运行已结束')
    if (req.name === 'memory_save' || req.name === 'memory_update' || req.name === 'memory_delete') run.usedMemoryTools = true
    const entry = run.tools.get(req.name)
    if (!entry) throw new Error(`工具不存在: ${req.name}`)
    const out = await entry.tool.invoke(req.args)
    // MCP tools may return message objects / content blocks; keep them plain for the RPC
    const content = (out as { content?: unknown })?.content ?? out
    return typeof content === 'string' ? content : JSON.parse(JSON.stringify(content))
  }
}

export const agent = new AgentService()
