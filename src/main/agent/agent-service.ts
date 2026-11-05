import { app, utilityProcess, type UtilityProcess } from 'electron'
import { appFile } from '../core/app-dir'
import type { ChatEvent, Decision, Thread, ThreadState } from '@shared/types'
import { buildAttachmentContext } from '../files/attachments'
import { flows } from '../flows/flows'
import { trace } from '../flows/trace'
import { learning } from '../learning'
import { memory } from '../memory/memory-service'
import { hostOf } from '../memory/recall'
import { files } from '../files/file-service'
import { db, kv } from '../core/db'
import { newId } from '../core/id'
import { emit } from '../core/ipc'
import { log } from '../core/logger'
import { paths } from '../core/paths'
import { getSettings, langfuseConfig } from '../core/settings'
import { sessions } from '../browser/agent-session'
import { resolveModel } from '../models/registry'
import type { ResolvedModel } from '../models/factory'
import { skills } from '../skills/skill-service'
import type { RpcMessage, RunRequest, RunResult, ToolCallRequest, UsageEvent, WorkspaceWrite } from '../agent-host/protocol'
import { usage } from '../usage/usage-service'
import { outputs } from '../outputs/outputs-service'
import { resolveRunWorkspaceRoot } from '../projects/workspace-directory'
import { acceptWorkspaceWrite } from '../outputs/workspace-write'
import { BUILTIN_SEND_TOOLS } from '../connectors/builtin'
import { connectors } from '../connectors/connector-service'
import { Rpc } from '../agent-host/rpc'
import { isSpawnedConversation } from '../mcp-server/tools'
import { collectTools, describeTools, NAVO_DESTRUCTIVE, systemPrompt, type ToolEntry } from './tool-registry'
import { t } from '@shared/i18n'
import { targets } from '../external-browser/instance'
import { computerUse } from '../computer-use'
import { projects } from '../projects/project-service'
import { projectFiles } from '../projects/project-files'
import { drafts } from '../chat/drafts'
import { submissions, submissionPayload } from '../chat/submissions'
import type { ApprovalSummary, ChatSubmitInput, ChatSubmitReceipt, ExecutionPhase } from '@shared/reliability'

interface ThreadRow {
  id: string
  title: string
  model_id: string | null
  created_at: number
  updated_at: number
  project_id: string | null
}

const toThread = (r: ThreadRow): Thread => ({
  id: r.id,
  title: r.title,
  modelId: r.model_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  projectId: r.project_id ?? null,
})
const RESET = '__reset__'

export type { RunResult }
type Listener = (e: ChatEvent) => void

interface ActiveRun {
  workspaceRoot: string
  runId: string
  executionId: string
  tools: Map<string, ToolEntry>
  /** the agent managed memory itself, so automatic learning skips this exchange */
  usedMemoryTools: boolean
}

export interface ExecutionEvent {
  threadId: string
  executionId: string
  phase: ExecutionPhase
  result?: RunResult
}
interface SubmissionLock {
  cancelled: boolean
}
interface RunOptions {
  headless?: boolean
  executionId?: string
  model?: ResolvedModel
}

/**
 * Main-process side of the agent. The deepagents loop runs in a utility process (agent-host) so a
 * long run never blocks the UI; this class owns threads, the host lifecycle, and executes the
 * browser / plugin / MCP tools the host calls back into.
 */
export class AgentService {
  private child: UtilityProcess | null = null
  private rpc: Rpc | null = null
  private runs = new Map<string, ActiveRun>()
  private listeners = new Set<Listener>()
  private locks = new Map<string, SubmissionLock>()
  private executionListeners = new Set<(event: ExecutionEvent) => void>()
  private preparing = new Map<string, { payload: string; promise: Promise<ChatSubmitReceipt> }>()
  private recovery: Promise<void> | null = null

  subscribeExecution(fn: (event: ExecutionEvent) => void): () => void {
    this.executionListeners.add(fn)
    return () => this.executionListeners.delete(fn)
  }

  onExecution(fn: (event: ExecutionEvent) => void): () => void {
    return this.subscribeExecution(fn)
  }

  executionId(threadId: string): string | null {
    return submissions.execution(threadId)?.id ?? null
  }

  private publishExecution(event: ExecutionEvent): void {
    if (!this.getThread(event.threadId)) return
    submissions.setExecution(event.threadId, event.executionId, event.phase)
    emit('approvals.changed')
    for (const listener of this.executionListeners) {
      try {
        listener(event)
      } catch (error) {
        log.warn(`[agent] execution listener: ${String(error)}`)
      }
    }
  }

  /** Reconcile checkpoint interrupts once per application start, never once per inbox opening. */
  private recover(): Promise<void> {
    if (this.recovery) return this.recovery
    submissions.recoverInterrupted()
    this.recovery = this.host()
      .call<{ threadId: string; interrupt: NonNullable<ThreadState['interrupt']> }[]>('approvals.recover', {})
      .then((pending) => {
        const ids = new Set(pending.map((p) => p.threadId))
        for (const old of submissions.approvals())
          if (!ids.has(old.threadId)) {
            submissions.setExecution(old.threadId, old.executionId, 'error')
          }
        for (const item of pending) {
          const old = submissions.execution(item.threadId)
          if (old?.phase === 'cancelled' || !this.getThread(item.threadId)) continue
          const id = old?.id ?? newId()
          submissions.setExecution(item.threadId, id, 'waiting_approval')
          submissions.interrupt(item.threadId, id, item.interrupt)
        }
        emit('approvals.changed')
      })
      .catch((error) => {
        this.recovery = null
        throw error
      })
    return this.recovery
  }

  async approvalSummaries(): Promise<ApprovalSummary[]> {
    await this.recover()
    return submissions.approvals()
  }

  private acquire(threadId: string): SubmissionLock {
    if (this.locks.has(threadId) || this.runs.has(threadId)) throw new Error(t('该会话正在运行中'))
    const lock = { cancelled: false }
    this.locks.set(threadId, lock)
    return lock
  }
  private assertActive(lock: SubmissionLock): void {
    if (lock.cancelled) throw new Error('Submission cancelled')
  }
  private release(threadId: string, lock: SubmissionLock): void {
    if (this.locks.get(threadId) === lock) this.locks.delete(threadId)
  }

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
      {
        'tool.call': (req: ToolCallRequest) => this.callTool(req),
        'workspace.write': (event: WorkspaceWrite) => {
          acceptWorkspaceWrite(event, this.runs, (threadId, path) => outputs.recordWorkspaceWrite(threadId, path, this.runs.get(threadId)!.workspaceRoot))
        },
      },
      (name, payload) => {
        if (name === 'chat.event') this.send(payload as ChatEvent)
        if (name === 'usage') {
          const e = payload as UsageEvent
          usage.record({ modelId: e.modelId, model: e.model, purpose: 'chat', threadId: e.threadId, usage: e.usage })
        }
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
    if (this.locks.size || this.runs.size || !this.child) return
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
    if (e.type === 'interrupt') {
      const executionId = this.runs.get(e.threadId)?.executionId
      if (executionId && !this.locks.get(e.threadId)?.cancelled) submissions.interrupt(e.threadId, executionId, e.interrupt)
    }
    emit('chat.event', e)
    for (const l of this.listeners) {
      try {
        l(e)
      } catch (error) {
        log.warn(`[agent] listener: ${String(error)}`)
      }
    }
  }

  // ---------- threads ----------
  listThreads(): Thread[] {
    return (db().prepare('SELECT * FROM threads WHERE hidden = 0 ORDER BY updated_at DESC').all() as ThreadRow[]).map(toThread)
  }

  getThread(id: string): Thread | null {
    const r = db().prepare('SELECT * FROM threads WHERE id = ?').get(id) as ThreadRow | undefined
    return r ? toThread(r) : null
  }

  createThread(modelId?: string | null, opts: { title?: string; hidden?: boolean; projectId?: string | null } = {}): Thread {
    if (modelId) resolveModel(modelId)
    if (opts.projectId != null && !projects.exists(opts.projectId)) throw new Error(t('项目不存在'))
    const id = newId()
    const now = Date.now()
    db()
      .prepare('INSERT INTO threads(id, title, model_id, created_at, updated_at, hidden, project_id) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(id, opts.title ?? '新对话', modelId ?? null, now, now, opts.hidden ? 1 : 0, opts.projectId ?? null)
    if (!opts.hidden) {
      emit('threads.changed')
      emit('projects.changed')
    }
    return this.getThread(id)!
  }

  renameThread(id: string, title: string): void {
    db()
      .prepare('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?')
      .run(title.trim() || '新对话', Date.now(), id)
    emit('threads.changed')
    emit('projects.changed')
    emit('artifacts.changed')
  }

  setThreadProject(id: string, projectId: string | null): void {
    if (!this.getThread(id)) throw new Error(t('会话不存在'))
    if (projectId != null && !projects.exists(projectId)) throw new Error(t('项目不存在'))
    db().prepare('UPDATE threads SET project_id = ?, updated_at = ? WHERE id = ?').run(projectId, Date.now(), id)
    emit('threads.changed')
    emit('projects.changed')
    emit('artifacts.changed')
  }

  setThreadModel(id: string, modelId: string): void {
    resolveModel(modelId)
    db().prepare('UPDATE threads SET model_id = ? WHERE id = ?').run(modelId, id)
    emit('threads.changed')
    emit('projects.changed')
    emit('artifacts.changed')
  }

  async deleteThread(id: string): Promise<void> {
    outputs.forget(id)
    this.stop(id)
    computerUse.forget(id)
    db().prepare('DELETE FROM threads WHERE id = ?').run(id)
    kv.set(`thread.allow.${id}`, [])
    sessions.forget(id)
    memory.forgetThread(id)
    learning.drop(id)
    kv.set(`thread.memory.${id}`, true)
    kv.set(`thread.workspace.${id}`, null)
    emit('threads.changed')
    emit('projects.changed')
    emit('artifacts.changed')
    await this.host().call('thread.delete', { threadId: id })
  }

  private touch(id: string): void {
    db().prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), id)
  }

  async threadState(id: string): Promise<ThreadState> {
    await this.recover()
    const st = await this.host().call<Omit<ThreadState, 'running'>>('thread.state', { threadId: id })
    const execution = submissions.execution(id)
    const messages = submissions.merge(id, st.messages)
    return {
      ...st,
      messages,
      recoverableMessageIds: this.isRunning(id) ? [] : submissions.recoverable(id),
      interrupt: execution?.phase === 'cancelled' ? null : st.interrupt,
      running: this.isRunning(id),
    }
  }

  /** Tools the user chose to always allow in this conversation (no approval card). */
  allowList(threadId: string): string[] {
    return kv.get<string[]>(`thread.allow.${threadId}`, [])
  }

  // ---------- runs ----------
  isRunning(threadId: string): boolean {
    return this.runs.has(threadId) || this.locks.has(threadId)
  }

  stop(threadId: string): void {
    const lock = this.locks.get(threadId)
    if (lock) lock.cancelled = true
    const execution = submissions.execution(threadId)
    if (execution && (execution.phase === 'running' || execution.phase === 'waiting_approval')) {
      this.publishExecution({ threadId, executionId: execution.id, phase: 'cancelled', result: { finalText: '', interrupted: false, aborted: true } })
      computerUse.endExecution(threadId, execution.id)
    }
    computerUse.stopRun(threadId)
    if (this.runs.has(threadId)) void this.rpc?.call('run.abort', { threadId }).catch(() => undefined)
  }

  stopAll(): void {
    for (const id of new Set([...this.runs.keys(), ...this.locks.keys(), ...submissions.approvals().map((a) => a.threadId)])) this.stop(id)
  }

  async submit(input: ChatSubmitInput): Promise<ChatSubmitReceipt> {
    if (!input.requestId?.trim() || typeof input.text !== 'string') throw new Error('Invalid submission')
    const payload = submissionPayload(input)
    const existing = submissions.find(input.requestId, payload)
    if (existing) return existing
    const preparing = this.preparing.get(input.requestId)
    if (preparing) {
      if (preparing.payload !== payload) throw new Error('Submission ID already used with different content')
      return preparing.promise
    }
    const promise = this.prepareSubmission(input, payload)
    this.preparing.set(input.requestId, { payload, promise })
    try {
      return await promise
    } finally {
      this.preparing.delete(input.requestId)
    }
  }

  private async prepareSubmission(input: ChatSubmitInput, payload: string): Promise<ChatSubmitReceipt> {
    const threadId = input.threadId ?? newId()
    const lock = this.acquire(threadId)
    let accepted = false
    try {
      await this.recover()
      this.assertActive(lock)
      const existing = input.threadId ? this.getThread(threadId) : null
      if (input.threadId && !existing) throw new Error(t('会话不存在'))
      if (submissions.execution(threadId)?.phase === 'waiting_approval') throw new Error('Resolve the pending approval before sending')
      const modelId = input.modelId ?? existing?.modelId ?? null
      const model = resolveModel(modelId)
      const projectId = existing ? existing.projectId : (input.projectId ?? null)
      if (projectId && !projects.exists(projectId)) throw new Error(t('项目不存在'))
      const captured = input.projectFiles?.length ? await projectFiles.captureReferences(input.projectFiles, projectId) : { fileIds: [], sources: {} }
      const fileIds = [...(input.fileIds ?? []), ...captured.fileIds]
      const extra = fileIds.length ? await this.withFiles(modelId, fileIds, input.images ?? [], model.supportsVision) : { images: input.images ?? [] }
      this.assertActive(lock)
      if (input.projectFiles?.length) {
        const root = resolveRunWorkspaceRoot('message', projectId ? (projects.get(projectId)?.workingDirectory ?? null) : null, paths.workspace, null)
        if (input.projectFiles.some((ref) => ref.root !== root)) throw new Error('Project directory changed; select the files again')
      }
      if ('attachments' in extra)
        extra.attachments = extra.attachments.map((a) => ({ ...a, ...(captured.sources[a.id] ? { source: captured.sources[a.id] } : {}) }))
      if (existing && this.getThread(threadId)?.projectId !== existing.projectId) throw new Error('Project changed during submission')
      const receipt: ChatSubmitReceipt = { requestId: input.requestId, threadId, messageId: newId(), executionId: newId() }
      const runInput: RunRequest['input'] = { kind: 'message', id: receipt.messageId, text: input.text, ...extra }
      const message = {
        id: receipt.messageId,
        role: 'user' as const,
        content: input.text,
        images: input.images ?? [],
        ...('attachments' in extra ? { attachments: extra.attachments } : {}),
      }
      const now = Date.now()
      db().transaction(() => {
        if (!existing)
          db()
            .prepare('INSERT INTO threads(id,title,model_id,created_at,updated_at,hidden,project_id) VALUES(?,?,?,?,?,0,?)')
            .run(threadId, input.text.trim().replace(/\s+/g, ' ').slice(0, 40) || '新对话', modelId, now, now, projectId)
        else {
          if (input.modelId) db().prepare('UPDATE threads SET model_id=? WHERE id=?').run(modelId, threadId)
          if (existing.title === '新对话' && (input.text.trim() || fileIds.length)) {
            const title = (input.text.trim() || `文件：${files.get(fileIds[0]).name}`).replace(/\s+/g, ' ').slice(0, 40)
            db().prepare('UPDATE threads SET title=?,updated_at=? WHERE id=?').run(title, now, threadId)
          }
        }
        submissions.accept(receipt, payload, message, runInput)
        submissions.setExecution(threadId, receipt.executionId, 'running')
        if (input.draft) drafts.clear(input.draft.scope, input.draft.version)
      })()
      accepted = true
      this.send({ type: 'message', threadId, message })
      emit('threads.changed')
      emit('projects.changed')
      // IPC can acknowledge durable acceptance before the agent starts producing events.
      setImmediate(() => {
        void this.run(threadId, runInput, { executionId: receipt.executionId, model }, undefined, lock).catch((error) => log.error(String(error)))
      })
      return receipt
    } finally {
      if (!accepted) this.release(threadId, lock)
    }
  }

  async assertRetryableSubmission(threadId: string, messageId: string): Promise<void> {
    await this.threadState(threadId)
    if (this.isRunning(threadId)) throw new Error(t('该会话正在运行中'))
    if (submissions.execution(threadId)?.phase === 'waiting_approval') throw new Error('Resolve the pending approval before retrying')
    if (!submissions.pendingInput(threadId, messageId)) throw new Error('Message is already checkpointed; regenerate it instead')
  }

  /** Explicit retry for a durable message that never reached the checkpoint. No startup replay. */
  async retrySubmission(threadId: string, messageId: string): Promise<RunResult> {
    const lock = this.acquire(threadId)
    try {
      await this.threadState(threadId)
      if (submissions.execution(threadId)?.phase === 'waiting_approval') throw new Error('Resolve the pending approval before retrying')
      const pending = submissions.pendingInput(threadId, messageId)
      if (!pending) throw new Error('Message is already checkpointed; regenerate it instead')
      return await this.run(threadId, pending.input, { executionId: pending.executionId }, undefined, lock)
    } finally {
      this.release(threadId, lock)
    }
  }

  async send_(threadId: string, text: string, images: string[] = [], opts: RunOptions = {}, fileIds: string[] = []): Promise<RunResult> {
    const lock = this.acquire(threadId)
    try {
      await this.recover()
      this.assertActive(lock)
      const thread = this.getThread(threadId)
      if (!thread) throw new Error(t('会话不存在'))
      if (submissions.execution(threadId)?.phase === 'waiting_approval') throw new Error('Resolve the pending approval before sending')
      const model = resolveModel(thread.modelId)
      const extra = fileIds.length ? await this.withFiles(thread.modelId, fileIds, images, model.supportsVision) : { images }
      this.assertActive(lock)
      const firstFile = fileIds.length ? files.get(fileIds[0]).name : ''
      if (thread.title === '新对话' && (text.trim() || firstFile))
        this.renameThread(threadId, (text.trim() || `文件：${firstFile}`).replace(/\s+/g, ' ').slice(0, 40))
      const id = newId()
      const executionId = opts.executionId ?? newId()
      const input: RunRequest['input'] = { kind: 'message', id, text, ...extra }
      const message = { id, role: 'user' as const, content: text, images, ...('attachments' in extra ? { attachments: extra.attachments } : {}) }
      const receipt = { requestId: newId(), threadId, messageId: id, executionId }
      submissions.accept(receipt, JSON.stringify({ text, images, fileIds }), message, input)
      this.send({ type: 'message', threadId, message })
      return await this.run(threadId, input, { ...opts, executionId, model }, undefined, lock)
    } finally {
      this.release(threadId, lock)
    }
  }

  /** Parsed file content (and, for vision models, the images) that goes along with a user message. */
  private async withFiles(modelId: string | null, fileIds: string[], images: string[], supportsVision?: boolean) {
    const records = await files.waitFor(fileIds)
    const built = buildAttachmentContext(
      records,
      (r) => files.markdown(r.id),
      (r) => files.originalPath(r.id),
      supportsVision ?? resolveModel(modelId).supportsVision,
      (r) => files.visuals(r.id),
    )
    return { context: built.context, attachments: built.attachments, images: [...built.images, ...images], attachmentImages: built.images.length }
  }

  /** IPC preflight returns rejected stale approvals before scheduling the longer background run. Resume rechecks under its lock. */
  async assertPendingApproval(threadId: string, interruptId?: string): Promise<void> {
    await this.recover()
    if (this.isRunning(threadId)) throw new Error(t('该会话正在运行中'))
    const execution = submissions.execution(threadId)
    const pending = submissions.approvals().find((item) => item.threadId === threadId)
    if (!execution || execution.phase !== 'waiting_approval' || !pending || (interruptId && pending.interrupt.id !== interruptId)) {
      throw new Error('Approval is no longer pending')
    }
  }

  async resume(threadId: string, decisions: Decision[], alwaysAllow: string[] = [], interruptId?: string): Promise<RunResult> {
    const lock = this.acquire(threadId)
    try {
      await this.recover()
      const execution = submissions.execution(threadId)
      if (!execution || execution.phase !== 'waiting_approval') throw new Error('Approval is no longer pending')
      if (interruptId && !submissions.approvals().some((a) => a.threadId === threadId && a.interrupt.id === interruptId))
        throw new Error('Approval is no longer pending')
      this.assertActive(lock)
      if (alwaysAllow.length) kv.set(`thread.allow.${threadId}`, [...new Set([...this.allowList(threadId), ...alwaysAllow])])
      return await this.run(threadId, { kind: 'resume', decisions }, { executionId: execution.id }, undefined, lock)
    } finally {
      this.release(threadId, lock)
    }
  }

  /** Re-runs from a user message: regenerate (same text) or edit & resend (new text). Earlier branch stays in history. */
  async regenerate(threadId: string, messageId: string, text?: string): Promise<RunResult> {
    const lock = this.acquire(threadId)
    try {
      const state = await this.threadState(threadId)
      this.assertActive(lock)
      const original = state.messages.find((m) => m.id === messageId && m.role === 'user')
      if (!original) throw new Error(t('只能从用户消息重新生成'))
      const fork = await this.host().call<string | null>('thread.forkPoint', { threadId, messageId })
      if (!fork) throw new Error(t('找不到可回溯的历史节点'))
      const content = text ?? original.content
      const id = newId()
      const images = original.images ?? []
      // files attached to the original message go along again (unless deleted since)
      const fileIds = (original.attachments ?? []).map((a) => a.id).filter((f) => files.exists(f))
      const extra = fileIds.length ? await this.withFiles(this.getThread(threadId)!.modelId, fileIds, images) : {}
      this.assertActive(lock)
      if (fork === RESET) await this.host().call('thread.delete', { threadId })
      submissions.supersedePending(threadId)
      this.assertActive(lock)
      this.send({
        type: 'message',
        threadId,
        message: { id, role: 'user', content, images, ...(original.attachments?.length ? { attachments: original.attachments } : {}) },
      })
      return await this.run(threadId, { kind: 'message', id, text: content, images, ...extra }, {}, fork === RESET ? undefined : fork, lock)
    } finally {
      this.release(threadId, lock)
    }
  }

  private async run(
    threadId: string,
    input: RunRequest['input'],
    opts: RunOptions = {},
    fromCheckpointId?: string,
    lock: SubmissionLock = this.acquire(threadId),
  ): Promise<RunResult> {
    const executionId = opts.executionId ?? newId()
    if (lock.cancelled) {
      this.release(threadId, lock)
      const result = { finalText: '', interrupted: false, aborted: true }
      this.publishExecution({ threadId, executionId, phase: 'cancelled', result })
      return result
    }
    const thread = this.getThread(threadId)
    if (!thread) {
      this.release(threadId, lock)
      return { finalText: '', interrupted: false, aborted: true }
    }
    const runId = newId()
    const settings = getSettings()
    const ctx = { threadId, tab: () => sessions.tabFor(threadId), page: () => targets.page(threadId) }
    const runState = { workspaceRoot: paths.workspace, runId, executionId, tools: new Map<string, ToolEntry>(), usedMemoryTools: false }
    this.runs.set(threadId, runState)
    this.publishExecution({ threadId, executionId, phase: 'running' })
    this.send({ type: 'run_start', threadId, runId })
    this.touch(threadId)

    let result: RunResult
    try {
      sessions.begin(threadId, thread.title)
      trace.start(threadId)
      await computerUse.beginRun(threadId, executionId)
      this.assertActive(lock)
      const project = thread.projectId ? projects.get(thread.projectId) : null
      const workspaceRoot = resolveRunWorkspaceRoot(
        input.kind,
        project?.workingDirectory ?? null,
        paths.workspace,
        kv.get<string | null>(`thread.workspace.${threadId}`, null),
      )
      kv.set(`thread.workspace.${threadId}`, workspaceRoot)
      runState.workspaceRoot = workspaceRoot
      const resolved = opts.model ?? resolveModel(thread.modelId)
      const entries = collectTools(ctx, resolved.supportsVision, workspaceRoot)
      runState.tools = new Map(entries.map((e) => [e.tool.name, e]))
      const allowed = new Set(this.allowList(threadId))
      // memory: picked from the conversation (title, the user's previous two messages and this one —
      // "那它用什么打包" alone says nothing) and the site the conversation's tab is on
      const page = this.pageInfo(threadId)
      const earlier = input.kind === 'message' ? (await this.recentUserTexts(threadId, 2)).map((t) => t.slice(0, 500)) : []
      const mem = memory.forRun(threadId, [thread.title, ...earlier, input.kind === 'message' ? input.text : ''].join('\n'), page?.url ?? null)
      if (input.kind === 'message' && mem?.refs.length) input = { ...input, memories: mem.refs }
      const req: RunRequest = {
        runId,
        executionId,
        threadId,
        input,
        fromCheckpointId,
        model: resolved,
        systemPrompt: systemPrompt(page, mem ? mem.prompt : null, project ?? undefined, workspaceRoot),
        memoryPrompt: mem?.prompt || undefined,
        tools: describeTools(entries),
        interruptOn: opts.headless
          ? []
          : [...new Set([...settings.approvalTools, ...NAVO_DESTRUCTIVE, ...BUILTIN_SEND_TOOLS, ...connectors.writeTools()])].filter((t) => !allowed.has(t)),
        browserSubagent: settings.browserSubagent,
        mounts: skills.mounts().map((m) => ({ id: m.id, root: m.root, allowed: [...m.allowed] })),
        paths: { skills: paths.skills, workspace: workspaceRoot, uploads: paths.uploads },
        devMode: settings.devMode,
        langfuse: langfuseConfig(),
        meta: { threadTitle: thread.title, modelLabel: resolved.model, appVersion: app.getVersion() },
      }
      this.assertActive(lock)
      result = await this.host().call<RunResult>('run.start', req)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      log.error(`[agent] run failed: ${error}`)
      this.send({ type: 'error', threadId, error })
      result = { finalText: '', interrupted: false, error }
    } finally {
      const cleaned = await Promise.allSettled([sessions.end(threadId), computerUse.endRun(threadId)])
      for (const cleanup of cleaned) if (cleanup.status === 'rejected') log.warn(`[agent] cleanup failed: ${String(cleanup.reason)}`)
      this.runs.delete(threadId)
      this.touch(threadId)
      emit('threads.changed')
      emit('projects.changed')
      emit('artifacts.changed')
    }
    // Mark accepted user messages that reached a checkpoint before allowing later branches.
    const checkpoint = await this.host()
      .call<Omit<ThreadState, 'running'>>('thread.state', { threadId })
      .catch(() => null)
    if (lock.cancelled) result = { ...result, interrupted: false, aborted: true }
    const phase: ExecutionPhase = result.aborted ? 'cancelled' : result.error ? 'error' : result.interrupted ? 'waiting_approval' : 'success'
    if (checkpoint && this.getThread(threadId)) {
      submissions.merge(threadId, checkpoint.messages)
      if (result.interrupted && checkpoint.interrupt) submissions.interrupt(threadId, executionId, checkpoint.interrupt)
    }
    if (!result.interrupted) computerUse.endExecution(threadId, executionId)
    if (!result.interrupted) kv.set(`thread.workspace.${threadId}`, null)
    try {
      flows.onRunEnd(threadId, input.kind === 'message' ? input.text : '', !result.error && !result.aborted && !result.interrupted)
    } catch (error) {
      log.warn(`[agent] flow finalization: ${String(error)}`)
    }
    this.publishExecution({ threadId, executionId, phase, result })
    this.send({ type: 'run_end', threadId, runId, aborted: result.aborted, traceUrl: result.traceUrl })
    // learn from the finished exchange in the background (the agent's own memory_* calls take precedence)
    if (input.kind === 'message' && !opts.headless && !result.error && !result.aborted && !result.interrupted && !isSpawnedConversation(threadId))
      void this.learnFrom(threadId, input.text, result.finalText, runState.usedMemoryTools)
    this.release(threadId, lock)
    return result
  }

  /** The page the conversation's browser tools are on: its tab in the user's browser, or the built-in one. */
  private pageInfo(threadId: string): { title: string; url: string; mine?: boolean } | null {
    if (targets.get(threadId) === 'mine') {
      try {
        const p = targets.page(threadId)
        return { title: p.title(), url: p.url(), mine: true }
      } catch {
        // A revoked or occupied tab must not prevent the run from explaining the error.
        return null
      }
    }
    const tab = sessions.peek(threadId)
    return tab && !tab.isDestroyed() ? { title: tab.getTitle(), url: tab.getURL() } : null
  }

  /** The user's own recent messages in a conversation (what memory evidence is checked against). */
  async recentUserTexts(threadId: string, n = 8): Promise<string[]> {
    const msgs = (await this.threadState(threadId).catch(() => null))?.messages ?? []
    return msgs
      .filter((m) => m.role === 'user' && !m.ns)
      .slice(-n)
      .map((m) => m.content)
  }

  /** Websites the agent opened since the user's last message (what links in a skill note may point to). */
  async recentHosts(threadId: string): Promise<string[]> {
    const msgs = (await this.threadState(threadId).catch(() => null))?.messages ?? []
    const since = msgs.slice(msgs.map((m) => m.role).lastIndexOf('user') + 1)
    const hosts = since
      .flatMap((m) => m.toolCalls ?? [])
      .map((c) => (typeof c.args?.url === 'string' ? hostOf(c.args.url) : null))
      .filter((h): h is string => !!h)
    return [...new Set(hosts)]
  }

  /** Hands a finished turn to the learning scheduler (which decides: now, or when the conversation goes quiet). */
  private async learnFrom(threadId: string, userText: string, reply: string, journalOnly: boolean): Promise<void> {
    if (!reply.trim() || !this.getThread(threadId)) return
    // what the agent did since the user's message: tool names, the pages it opened, the files it read
    const msgs = (await this.threadState(threadId).catch(() => null))?.messages ?? []
    const since = msgs.slice(msgs.map((m) => m.role).lastIndexOf('user') + 1)
    const calls = since.flatMap((m) => m.toolCalls ?? [])
    learning.submit(threadId, {
      userText,
      reply,
      actions: calls.map((c) => (typeof c.args?.url === 'string' ? `${c.name} ${c.args.url}` : c.name)).slice(0, 30),
      journalOnly,
      at: Date.now(),
      filesRead: calls.filter((c) => c.name === 'read_file' && typeof c.args?.file_path === 'string').map((c) => c.args.file_path as string),
      toolCalls: calls.length,
      toolErrors: since.filter((m) => m.role === 'tool' && m.status === 'error').length,
    })
  }

  /** Executes a tool the agent process asked for, on the conversation's tab. */
  private async callTool(req: ToolCallRequest): Promise<unknown> {
    const run = this.runs.get(req.threadId)
    if (!run || run.runId !== req.runId || this.locks.get(req.threadId)?.cancelled) throw new Error(t('运行已结束'))
    if (req.name === 'memory_save' || req.name === 'memory_update' || req.name === 'memory_delete') run.usedMemoryTools = true
    const entry = run.tools.get(req.name)
    if (!entry) throw new Error(t('工具不存在: {{v0}}', { v0: req.name }))
    const out = await entry.tool.invoke(req.args)
    // MCP tools may return message objects / content blocks; keep them plain for the RPC
    const content = (out as { content?: unknown })?.content ?? out
    return typeof content === 'string' ? content : JSON.parse(JSON.stringify(content))
  }
}

export const agent = new AgentService()
